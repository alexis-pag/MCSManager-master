import Router from "@koa/router";
import { isBanCommand } from "mcsmanager-common";
import { FILENAME_BLACKLIST } from "../const";
import { ROLE } from "../entity/user";
import { $t } from "../i18n";
import permission from "../middleware/permission";
import validator from "../middleware/validator";
import { getInstanceNameSafely } from "../service/instance_name_service";
import { getOperationLoggerOperator, operationLogger } from "../service/operation_logger";
import { getUserUuid } from "../service/passport_service";
import { isHaveInstanceByUuid, isTopPermissionByUuid } from "../service/permission_service";
import RemoteRequest from "../service/remote_command";
import RemoteServiceSubsystem from "../service/remote_service";
import { ApprovalError } from "../service/ai_access_service";
import automationRequests, {
  replaceSchedule,
  schedulePayload
} from "../service/automation_request_service";
import userSystem from "../service/user_service";
const router = new Router({ prefix: "/protected_schedule" });

// Routing permission verification middleware
router.use(async (ctx, next) => {
  const instanceUuid = String(ctx.query.uuid);
  const daemonId = String(ctx.query.daemonId);
  const userUuid = getUserUuid(ctx);
  if (isHaveInstanceByUuid(userUuid, daemonId, instanceUuid)) {
    await next();
  } else {
    ctx.status = 403;
    ctx.body = $t("TXT_CODE_permission.forbiddenInstance");
  }
});

// [Low-level Permission]
// Get the list of scheduled tasks
router.get(
  "/",
  permission({ level: ROLE.USER }),
  validator({ query: { daemonId: String, uuid: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const instanceUuid = String(ctx.query.uuid);
      const list = await new RemoteRequest(RemoteServiceSubsystem.getInstance(daemonId)).request(
        "schedule/list",
        {
          instanceUuid
        }
      );
      ctx.body = list;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Low-level Permission]
// create a scheduled task
router.post(
  "/",
  permission({ level: ROLE.USER }),
  validator({
    query: { daemonId: String, uuid: String },
    body: { name: String, count: Number, time: String, actions: Array, type: Number }
  }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const instanceUuid = String(ctx.query.uuid);
      const task = ctx.request.body;

      // Scheduled task name needs file name format check
      const name = String(task.name);
      FILENAME_BLACKLIST.forEach((ch) => {
        if (name.includes(ch)) throw new Error($t("TXT_CODE_router.schedule.invalidName"));
      });

      // Regular users must ban players through the AI-moderated flow.
      const actions = Array.isArray(task.actions) ? task.actions : [];
      if (
        !isTopPermissionByUuid(getUserUuid(ctx)) &&
        actions.some((action: any) => action?.type === "command" && isBanCommand(action?.payload))
      ) {
        ctx.status = 403;
        ctx.body = $t("TXT_CODE_ban_command_blocked");
        return;
      }

      // Automations of regular users wait for an administrator's approval.
      const user = userSystem.getInstance(getUserUuid(ctx));
      if (user && user.permission < ROLE.ADMIN) {
        try {
          const request = await automationRequests.submit(
            user,
            "schedule",
            daemonId,
            instanceUuid,
            task,
            typeof task.replaces === "string" ? task.replaces : ""
          );
          ctx.body = { pending: true, request };
        } catch (error: any) {
          if (!(error instanceof ApprovalError)) throw error;
          ctx.status = error.status;
          ctx.body = error.message;
        }
        return;
      }

      // Administrators: registered immediately; an edit replaces the previous schedule.
      ctx.body = await replaceSchedule(
        daemonId,
        instanceUuid,
        schedulePayload(task, true),
        typeof task.replaces === "string" ? task.replaces : ""
      );
      operationLogger.log("instance_task_create", {
        ...getOperationLoggerOperator(ctx),
        instance_id: instanceUuid,
        daemon_id: daemonId,
        instance_name: await getInstanceNameSafely(daemonId, instanceUuid),
        task_name: name
      });
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Low-level Permission]
// delete scheduled task
router.delete(
  "/",
  permission({ level: ROLE.USER }),
  validator({ query: { daemonId: String, uuid: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const instanceUuid = String(ctx.query.uuid);
      const name = String(ctx.query.task_name);

      operationLogger.log("instance_task_delete", {
        ...getOperationLoggerOperator(ctx),
        instance_id: instanceUuid,
        daemon_id: daemonId,
        instance_name: await getInstanceNameSafely(daemonId, instanceUuid),
        task_name: name
      });

      ctx.body = await new RemoteRequest(RemoteServiceSubsystem.getInstance(daemonId)).request(
        "schedule/delete",
        {
          instanceUuid,
          name
        }
      );
    } catch (err) {
      ctx.body = err;
    }
  }
);

export default router;
