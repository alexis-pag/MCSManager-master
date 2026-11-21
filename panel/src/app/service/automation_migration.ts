import Storage from "../common/storage/sys_storage";
import { ROLE } from "../entity/user";
import { systemConfig } from "../setting";
import aiSchedules from "./ai_schedule_service";
import automationRequests from "./automation_request_service";
import { logger } from "./log";
import { operationLogger } from "./operation_logger";
import RemoteRequest from "./remote_command";
import RemoteServiceSubsystem from "./remote_service";
import userSystem from "./user_service";

const DAEMON_CHECK_INTERVAL_MS = 60 * 1000;

async function saveConfig() {
  if (systemConfig) await Storage.getStorage().store("SystemConfig", "config", systemConfig);
}

/** `${instanceUuid}:${taskName}` -> name of the newest operator that created it. */
export async function scheduleCreators(): Promise<Map<string, string>> {
  const creators = new Map<string, string>();
  for (let page = 1; page <= 1000; page++) {
    const result = await operationLogger.search({
      type: "instance_task_create",
      page,
      pageSize: 100
    });
    for (const item of result.data as any[]) {
      const key = `${item.instance_id}:${item.task_name}`;
      // Results are newest first: keep the first (latest) creator.
      if (!creators.has(key)) creators.set(key, String(item.operator_name || ""));
    }
    if (page >= result.maxPage) break;
  }
  return creators;
}

/**
 * Existing automations created by regular users are suspended and turned into requests that
 * an administrator must approve. AI tasks are migrated once; server-action schedules once per
 * daemon, the first time it is available.
 */
export class AutomationMigration {
  private timer?: NodeJS.Timeout;
  private running = false;

  async initialize() {
    await this.migrateAiTasks();
    void this.migrateDaemons();
    this.timer = setInterval(() => void this.migrateDaemons(), DAEMON_CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  async migrateAiTasks() {
    if (!systemConfig || systemConfig.automationApprovalMigrated) return;
    let moved = 0;
    for (const task of aiSchedules.allTasks()) {
      const owner = userSystem.getInstance(task.ownerUserUuid);
      if (owner && owner.permission >= ROLE.ADMIN) continue;
      // Tasks whose owner no longer exists are suspended too (an administrator decides).
      try {
        await automationRequests.submit(
          owner ? { uuid: owner.uuid, userName: owner.userName } : null,
          "ai_task",
          task.daemonId,
          task.instanceUuid,
          {
            name: task.name,
            kind: task.kind,
            prompt: task.prompt,
            type: task.type,
            time: task.time,
            count: task.count
          },
          "",
          "migration"
        );
      } catch (error: any) {
        // Not stored: the task cannot run for a regular user without AI access anyway.
        logger.warn(
          `[APPROVAL] AI task ${task.name} could not be migrated: ${String(error?.message || error)}`
        );
        continue;
      }
      await aiSchedules.remove(task.daemonId, task.instanceUuid, task.name);
      moved++;
    }
    systemConfig.automationApprovalMigrated = true;
    await saveConfig();
    if (moved) logger.info(`[APPROVAL] ${moved} AI task(s) now wait for an administrator`);
  }

  async migrateDaemons() {
    if (!systemConfig || this.running) return;
    this.running = true;
    try {
      const done = new Set(systemConfig.automationApprovalMigratedDaemons || []);
      const pending = [...RemoteServiceSubsystem.services.entries()].filter(
        ([daemonId, service]) => service?.available && !done.has(daemonId)
      );
      if (!pending.length) return;
      const creators = await scheduleCreators();
      for (const [daemonId, service] of pending) {
        try {
          await this.migrateDaemon(daemonId, service, creators);
          done.add(daemonId);
          systemConfig.automationApprovalMigratedDaemons = [...done];
          await saveConfig();
        } catch (error: any) {
          logger.warn(
            `[APPROVAL] Schedules of daemon ${daemonId} could not be migrated yet: ${String(
              error?.message || error
            )}`
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async migrateDaemon(daemonId: string, service: any, creators: Map<string, string>) {
    const request = (event: string, data: Record<string, unknown>) =>
      new RemoteRequest(service).request(event, data, 15000);
    const instances = await request("instance/overview", {});
    let moved = 0;
    for (const instance of Array.isArray(instances) ? instances : []) {
      const instanceUuid = String(instance?.instanceUuid || "");
      if (!instanceUuid) continue;
      const tasks = await request("schedule/list", { instanceUuid });
      for (const task of Array.isArray(tasks) ? tasks : []) {
        const creatorName = creators.get(`${instanceUuid}:${task?.name}`) || "";
        const creator = creatorName ? userSystem.getUserByUserName(creatorName) : undefined;
        if (creator && creator.permission >= ROLE.ADMIN) continue;
        // Created by a regular user, or creator unknown (log disabled, user deleted): the
        // schedule is suspended until an administrator approves it.
        try {
          // The request is stored before the schedule is removed from the daemon.
          await automationRequests.submit(
            creator ? { uuid: creator.uuid, userName: creator.userName } : null,
            "schedule",
            daemonId,
            instanceUuid,
            task,
            "",
            "migration",
            creatorName
          );
        } catch (error: any) {
          logger.warn(
            `[APPROVAL] Schedule ${task?.name} kept active (not migrated): ${String(
              error?.message || error
            )}`
          );
          continue;
        }
        await request("schedule/delete", { instanceUuid, name: task.name });
        moved++;
      }
    }
    if (moved) {
      logger.info(`[APPROVAL] ${moved} schedule(s) of daemon ${daemonId} now wait for approval`);
    }
  }
}

export default new AutomationMigration();
