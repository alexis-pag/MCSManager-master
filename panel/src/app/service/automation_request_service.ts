import { isBanCommand } from "mcsmanager-common";
import { v4 } from "uuid";
import Storage from "../common/storage/sys_storage";
import { FILENAME_BLACKLIST } from "../const";
import { AutomationKind, AutomationRequest } from "../entity/approval";
import { ROLE, User } from "../entity/user";
import aiAccess, { ApprovalError } from "./ai_access_service";
import aiSchedules, { validateAiScheduleInput } from "./ai_schedule_service";
import { getInstanceNameSafely } from "./instance_name_service";
import { logger } from "./log";
import { operationLogger } from "./operation_logger";
import { isHaveInstance } from "./permission_service";
import RemoteRequest from "./remote_command";
import RemoteServiceSubsystem from "./remote_service";
import userSystem from "./user_service";

export const DECIDED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Server-action schedule body as registered on the daemon. `allowBan` is only used to suspend
 * existing schedules (migration): the ban check still applies when the request is approved.
 */
export function schedulePayload(body: any, allowBan = false) {
  const name = String(body?.name ?? "").trim();
  if (!name || name.length > 64 || FILENAME_BLACKLIST.some((ch) => name.includes(ch))) {
    throw new ApprovalError("Invalid task name");
  }
  const actions = Array.isArray(body?.actions) ? body.actions.slice(0, 10) : [];
  if (!actions.length) throw new ApprovalError("Invalid actions");
  const cleanActions = actions.map((action: any) => ({
    type: String(action?.type ?? "").slice(0, 20),
    payload: String(action?.payload ?? "").slice(0, 2000)
  }));
  if (
    !allowBan &&
    cleanActions.some((action: any) => action.type === "command" && isBanCommand(action.payload))
  ) {
    throw new ApprovalError("Ban commands are not allowed", 403);
  }
  return {
    name,
    count: Number(body?.count),
    time: String(body?.time ?? ""),
    type: Number(body?.type),
    actions: cleanActions
  };
}

/**
 * Creates an AI task, replacing the task named `replaces` (edit). The old task is restored
 * when the new one cannot be created.
 */
export async function replaceAiTask(
  ownerUuid: string,
  daemonId: string,
  instanceUuid: string,
  payload: Record<string, any>,
  replaces = ""
) {
  const old = replaces ? aiSchedules.find(daemonId, instanceUuid, replaces) : undefined;
  const snapshot = old ? { ...old } : undefined;
  if (old) await aiSchedules.remove(daemonId, instanceUuid, old.name);
  try {
    return await aiSchedules.create(ownerUuid, daemonId, instanceUuid, { ...payload });
  } catch (error) {
    if (snapshot) {
      await aiSchedules
        .create(snapshot.ownerUserUuid, daemonId, instanceUuid, snapshot)
        .catch((restoreError) =>
          logger.warn(`[APPROVAL] AI task ${snapshot.name} could not be restored: ${restoreError}`)
        );
    }
    throw error;
  }
}

/**
 * Registers a server-action schedule on the daemon, replacing the schedule named `replaces`
 * (edit). The old schedule is restored when the new one is rejected.
 */
export async function replaceSchedule(
  daemonId: string,
  instanceUuid: string,
  payload: ReturnType<typeof schedulePayload>,
  replaces = ""
) {
  const remote = RemoteServiceSubsystem.getInstance(daemonId);
  if (!remote?.available) throw new Error("The daemon is unavailable");
  const call = (event: string, data: Record<string, unknown>) =>
    new RemoteRequest(remote).request(event, { instanceUuid, ...data });
  let old: any = null;
  if (replaces) {
    const tasks = await call("schedule/list", {});
    old = (Array.isArray(tasks) ? tasks : []).find((task: any) => task?.name === replaces);
    if (old) await call("schedule/delete", { name: old.name });
  }
  try {
    return await call("schedule/register", payload);
  } catch (error) {
    if (old) {
      await call("schedule/register", schedulePayload(old, true)).catch((restoreError) =>
        logger.warn(`[APPROVAL] Schedule ${old.name} could not be restored: ${restoreError}`)
      );
    }
    throw error;
  }
}

/**
 * Automations of regular users wait for an administrator. Approval re-validates the request
 * and registers it through the normal daemon / AI schedule paths.
 */
export class AutomationRequestService {
  private readonly requests = new Map<string, AutomationRequest>();
  private loaded = false;
  private cleanupTimer?: NodeJS.Timeout;

  async initialize() {
    if (this.loaded) return;
    this.loaded = true;
    for (const uuid of await Storage.getStorage().list("AutomationRequest")) {
      const request: AutomationRequest | null = await Storage.getStorage().load(
        "AutomationRequest",
        AutomationRequest,
        uuid
      );
      if (request?.uuid) this.requests.set(request.uuid, request);
    }
    await this.cleanup();
    this.cleanupTimer = setInterval(() => void this.cleanup(), 6 * 60 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  private async save(request: AutomationRequest) {
    this.requests.set(request.uuid, request);
    await Storage.getStorage().store("AutomationRequest", request.uuid, request);
  }

  private pendingFor(daemonId: string, instanceUuid: string, kind: AutomationKind) {
    return [...this.requests.values()].filter(
      (request) =>
        request.state === "pending" &&
        request.kind === kind &&
        request.daemonId === daemonId &&
        request.instanceUuid === instanceUuid
    );
  }

  /** Stores a request (new task, edit or migration). Returns the stored request. */
  async submit(
    requester: { uuid: string; userName: string } | null,
    kind: AutomationKind,
    daemonId: string,
    instanceUuid: string,
    body: any,
    replaces = "",
    origin: AutomationRequest["origin"] = replaces ? "edit" : "new",
    requesterName = ""
  ) {
    let payload: Record<string, any>;
    if (kind === "schedule") {
      payload = schedulePayload(body, origin === "migration");
    } else {
      // The edited task (or, during migration, the task being suspended) is not a duplicate.
      const superseded = origin === "migration" ? String(body?.name ?? "").trim() : replaces;
      const existing = [
        ...aiSchedules.list(daemonId, instanceUuid).filter((task) => task.name !== superseded),
        ...this.pendingFor(daemonId, instanceUuid, "ai_task").map((request) => ({
          name: String(request.payload.name),
          kind: String(request.payload.kind)
        }))
      ];
      try {
        payload = validateAiScheduleInput(body, existing);
      } catch (error: any) {
        throw new ApprovalError(String(error?.message || error));
      }
    }
    if (
      this.pendingFor(daemonId, instanceUuid, kind).some((request) => request.name === payload.name)
    ) {
      throw new ApprovalError("A request with this name is already pending");
    }
    const request = Object.assign(new AutomationRequest(), {
      uuid: v4().replace(/-/g, ""),
      kind,
      requesterUuid: requester?.uuid || "",
      requesterName: requester?.userName || requesterName,
      daemonId,
      instanceUuid,
      instanceName: (await getInstanceNameSafely(daemonId, instanceUuid)) || "",
      name: payload.name,
      payload,
      replaces: String(replaces || ""),
      origin,
      state: "pending",
      createdAt: new Date().toISOString()
    });
    await this.save(request);
    logger.info(
      `[APPROVAL] ${request.requesterName || "unknown"} requested ${kind} "${request.name}" ` +
        `on ${instanceUuid} (${origin})`
    );
    return request;
  }

  /** Requests of an instance: all for administrators, own ones for regular users. */
  list(user: User, daemonId: string, instanceUuid: string) {
    return [...this.requests.values()]
      .filter(
        (request) =>
          request.daemonId === daemonId &&
          request.instanceUuid === instanceUuid &&
          (request.state === "pending" || request.state === "refused") &&
          (user.permission >= ROLE.ADMIN || request.requesterUuid === user.uuid)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listPending() {
    return [...this.requests.values()]
      .filter((request) => request.state === "pending")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 200);
  }

  countPending() {
    return this.listPending().length;
  }

  async cancel(user: User, uuid: string) {
    const request = this.requests.get(uuid);
    if (!request || (request.requesterUuid !== user.uuid && user.permission < ROLE.ADMIN)) {
      throw new ApprovalError("Not found", 404);
    }
    if (request.state === "refused") {
      // A refused request is simply dismissed by its requester.
      this.requests.delete(uuid);
      await Storage.getStorage().delete("AutomationRequest", uuid);
      return true;
    }
    if (request.state !== "pending") throw new ApprovalError("Request already decided");
    request.state = "cancelled";
    request.decidedAt = new Date().toISOString();
    await this.save(request);
    return true;
  }

  async decide(admin: User, uuid: string, decision: unknown, noteInput: unknown, ip = "") {
    if (admin.permission < ROLE.ADMIN) throw new ApprovalError("Forbidden", 403);
    const request = this.requests.get(uuid);
    if (!request) throw new ApprovalError("Not found", 404);
    if (request.state !== "pending") throw new ApprovalError("Request already decided");
    const note = String(noteInput ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    if (decision === "approve") {
      try {
        await this.register(request);
        request.error = "";
      } catch (error: any) {
        request.error = String(error?.message || error).slice(0, 300);
        await this.save(request);
        throw new ApprovalError(request.error);
      }
      request.state = "approved";
    } else if (decision === "refuse") {
      request.state = "refused";
    } else {
      throw new ApprovalError("Invalid decision");
    }
    request.decidedAt = new Date().toISOString();
    request.decidedBy = admin.userName;
    request.note = note;
    await this.save(request);
    if (decision === "approve" && request.kind === "schedule") {
      // The approving administrator is recorded as the creator of the schedule.
      operationLogger.log("instance_task_create", {
        operator_ip: ip,
        operator_name: admin.userName,
        instance_id: request.instanceUuid,
        daemon_id: request.daemonId,
        instance_name: request.instanceName,
        task_name: request.name
      });
    }
    operationLogger.log(
      "admin_approval",
      {
        operator_ip: ip,
        operator_name: admin.userName,
        target_user_name: request.requesterName || "?",
        subject: request.kind,
        decision: String(decision),
        instance_id: request.instanceUuid,
        daemon_id: request.daemonId,
        instance_name: request.instanceName,
        task_name: request.name,
        ...(note ? { note } : {})
      },
      decision === "approve" ? "info" : "warning"
    );
    return request;
  }

  /** Re-validates the request, then registers it (replacing the edited task if any). */
  private async register(request: AutomationRequest) {
    const requester = request.requesterUuid ? userSystem.getInstance(request.requesterUuid) : null;
    if (request.requesterUuid) {
      if (!requester) throw new Error("The requester no longer exists");
      if (!isHaveInstance(requester, request.daemonId, request.instanceUuid)) {
        throw new Error("The requester no longer has access to this instance");
      }
    }

    if (request.kind === "ai_task") {
      if (!requester) throw new Error("The requester no longer exists");
      if (!aiAccess.hasAccess(requester)) throw new Error("The requester has no AI access");
      await replaceAiTask(
        requester.uuid,
        request.daemonId,
        request.instanceUuid,
        request.payload,
        request.replaces
      );
      return;
    }
    await replaceSchedule(
      request.daemonId,
      request.instanceUuid,
      schedulePayload(request.payload),
      request.replaces
    );
  }

  async cleanup(now = Date.now()) {
    for (const request of [...this.requests.values()]) {
      if (request.state === "pending") continue;
      const decided = Date.parse(request.decidedAt || request.createdAt);
      if (!Number.isNaN(decided) && now - decided > DECIDED_RETENTION_MS) {
        this.requests.delete(request.uuid);
        await Storage.getStorage().delete("AutomationRequest", request.uuid);
      }
    }
  }
}

export default new AutomationRequestService();
