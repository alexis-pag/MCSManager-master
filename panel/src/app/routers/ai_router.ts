import Router from "@koa/router";
import { ROLE } from "../entity/user";
import permission from "../middleware/permission";
import validator from "../middleware/validator";
import fs from "fs-extra";
import { $t } from "../i18n";
import aiAccess, { ApprovalError, isAccessFreeAiPath } from "../service/ai_access_service";
import aiBans, { AiBanError } from "../service/ai_ban_service";
import automationRequests, { replaceAiTask } from "../service/automation_request_service";
import aiSchedules, { AiScheduleError } from "../service/ai_schedule_service";
import { getInstanceNameSafely } from "../service/instance_name_service";
import ai from "../service/local_ai_service";
import { getOperationLoggerOperator, operationLogger } from "../service/operation_logger";
import { getUserUuid } from "../service/passport_service";
import { isHaveInstanceByUuid } from "../service/permission_service";
import userSystem from "../service/user_service";

const router = new Router({ prefix: "/ai" });

// Regular users need an administrator's grant to use the AI.
router.use(async (ctx, next) => {
  const user = userSystem.getInstance(getUserUuid(ctx));
  if (!user || user.permission >= ROLE.ADMIN || isAccessFreeAiPath(ctx.path)) return next();
  if (!aiAccess.hasAccess(user)) {
    ctx.status = 403;
    ctx.body = "AI access required";
    return;
  }
  return next();
});

router.get("/status", permission({ level: ROLE.USER }), async (ctx) => {
  const user = userSystem.getInstance(getUserUuid(ctx));
  ctx.body = { ...(await ai.status()), access: user ? aiAccess.view(user) : null };
});

router.get("/access", permission({ level: ROLE.USER }), async (ctx) => {
  const user = userSystem.getInstance(getUserUuid(ctx));
  ctx.body = user ? aiAccess.view(user) : null;
});

router.post(
  "/access",
  permission({ level: ROLE.USER }),
  validator({ body: { reason: String } }),
  async (ctx) => {
    const user = userSystem.getInstance(getUserUuid(ctx));
    if (!user) return;
    try {
      ctx.body = await aiAccess.request(user, (ctx.request.body as any)?.reason);
    } catch (error: any) {
      if (!(error instanceof ApprovalError)) throw error;
      ctx.status = error.status;
      ctx.body = error.message;
    }
  }
);

router.get("/models", permission({ level: ROLE.ADMIN }), async (ctx) => {
  ctx.body = { models: await ai.listModels() };
});

router.get("/config", permission({ level: ROLE.ADMIN }), async (ctx) => {
  ctx.body = ai.getConfig();
});

router.put(
  "/config",
  permission({ level: ROLE.ADMIN }),
  validator({ body: Object }),
  async (ctx) => {
    await ai.updateConfig(ctx.request.body || {});
    ctx.body = ai.getConfig();
  }
);

router.get("/conversations", permission({ level: ROLE.USER }), async (ctx) => {
  ctx.body = (await ai.listConversations(getUserUuid(ctx))).map((item) => ai.withExpiry(item));
});

router.post(
  "/conversations",
  permission({ level: ROLE.USER }),
  validator({ body: { title: String } }),
  async (ctx) => {
    const body = (ctx.request.body as any) || {};
    // Optional instance binding: verified against the user's instance permissions.
    const scope =
      body.daemonId != null || body.instanceUuid != null
        ? { daemonId: body.daemonId, instanceUuid: body.instanceUuid }
        : undefined;
    try {
      ctx.body = ai.withExpiry(
        await ai.createConversation(getUserUuid(ctx), String(body.title || ""), scope)
      );
    } catch (error: any) {
      if (error?.message !== "Instance not accessible") throw error;
      ctx.status = 403;
      ctx.body = "Instance not accessible";
    }
  }
);

router.get("/conversations/:uuid", permission({ level: ROLE.USER }), async (ctx) => {
  const conversation = await ai.getConversation(getUserUuid(ctx), ctx.params.uuid);
  if (!conversation) {
    ctx.status = 404;
    ctx.body = "Conversation not found";
    return;
  }
  ctx.body = ai.withExpiry(conversation);
});

router.put(
  "/conversations/:uuid",
  permission({ level: ROLE.USER }),
  validator({ body: { title: String } }),
  async (ctx) => {
    const changed = await ai.renameConversation(
      getUserUuid(ctx),
      ctx.params.uuid,
      String((ctx.request.body as any)?.title || "")
    );
    ctx.status = changed ? 200 : 404;
  }
);

router.delete("/conversations/:uuid", permission({ level: ROLE.USER }), async (ctx) => {
  const changed = await ai.deleteConversation(getUserUuid(ctx), ctx.params.uuid);
  ctx.status = changed ? 200 : 404;
});

router.post(
  "/conversations/:uuid/generate",
  permission({ level: ROLE.USER }),
  validator({ body: { content: String } }),
  async (ctx) => {
    ctx.body = await ai.submit(
      getUserUuid(ctx),
      ctx.params.uuid,
      String((ctx.request.body as any)?.content || "")
    );
  }
);

// ---- Scheduled AI tasks (read-only reports bound to one instance) ----------------------

/** Resolves ?daemonId&uuid and checks that the caller can use the instance. */
function scheduleTarget(ctx: any) {
  const daemonId = String(ctx.query.daemonId || "");
  const instanceUuid = String(ctx.query.uuid || "");
  if (
    !daemonId ||
    !instanceUuid ||
    !isHaveInstanceByUuid(getUserUuid(ctx), daemonId, instanceUuid)
  ) {
    ctx.status = 403;
    ctx.body = $t("TXT_CODE_permission.forbiddenInstance");
    return null;
  }
  return { daemonId, instanceUuid };
}

router.get(
  "/schedules",
  permission({ level: ROLE.USER }),
  validator({ query: { daemonId: String, uuid: String } }),
  async (ctx) => {
    const target = scheduleTarget(ctx);
    if (!target) return;
    ctx.body = aiSchedules.list(target.daemonId, target.instanceUuid);
  }
);

router.post(
  "/schedules",
  permission({ level: ROLE.USER }),
  validator({
    query: { daemonId: String, uuid: String },
    body: { name: String, kind: String, type: Number, time: String }
  }),
  async (ctx) => {
    const target = scheduleTarget(ctx);
    if (!target) return;
    if (!ai.getConfig().enabled) {
      ctx.status = 400;
      ctx.body = "Local AI is disabled";
      return;
    }
    const body = (ctx.request.body as any) || {};
    const user = userSystem.getInstance(getUserUuid(ctx));
    // Automations of regular users wait for an administrator's approval.
    if (user && user.permission < ROLE.ADMIN) {
      try {
        const request = await automationRequests.submit(
          user,
          "ai_task",
          target.daemonId,
          target.instanceUuid,
          body,
          typeof body.replaces === "string" ? body.replaces : ""
        );
        ctx.body = { pending: true, request };
      } catch (error: any) {
        if (!(error instanceof ApprovalError)) throw error;
        ctx.status = error.status;
        ctx.body = error.message;
      }
      return;
    }
    try {
      // Administrators: active immediately; an edit replaces the previous task.
      const task = await replaceAiTask(
        getUserUuid(ctx),
        target.daemonId,
        target.instanceUuid,
        body,
        typeof body.replaces === "string" ? body.replaces : ""
      );
      operationLogger.log("instance_task_create", {
        ...getOperationLoggerOperator(ctx),
        instance_id: target.instanceUuid,
        daemon_id: target.daemonId,
        instance_name: await getInstanceNameSafely(target.daemonId, target.instanceUuid),
        task_name: `AI: ${task.name}`
      });
      ctx.body = task;
    } catch (error: any) {
      if (!(error instanceof AiScheduleError)) throw error;
      ctx.status = 400;
      ctx.body = error.message;
    }
  }
);

router.delete(
  "/schedules",
  permission({ level: ROLE.USER }),
  validator({ query: { daemonId: String, uuid: String, name: String } }),
  async (ctx) => {
    const target = scheduleTarget(ctx);
    if (!target) return;
    const name = String(ctx.query.name);
    const removed = await aiSchedules.remove(target.daemonId, target.instanceUuid, name);
    if (removed) {
      operationLogger.log("instance_task_delete", {
        ...getOperationLoggerOperator(ctx),
        instance_id: target.instanceUuid,
        daemon_id: target.daemonId,
        instance_name: await getInstanceNameSafely(target.daemonId, target.instanceUuid),
        task_name: `AI: ${name}`
      });
    }
    ctx.status = removed ? 200 : 404;
    ctx.body = removed;
  }
);

// Runs a task now (same checks and read-only mode as a scheduled firing).
router.post(
  "/schedules/run",
  permission({ level: ROLE.USER }),
  validator({ query: { daemonId: String, uuid: String, name: String } }),
  async (ctx) => {
    const target = scheduleTarget(ctx);
    if (!target) return;
    const task = aiSchedules.find(target.daemonId, target.instanceUuid, String(ctx.query.name));
    if (!task) {
      ctx.status = 404;
      ctx.body = "Task not found";
      return;
    }
    const status = await aiSchedules.run(task);
    ctx.body = { status, reportUuid: task.lastReportUuid };
  }
);

// ---- AI-moderated player bans ------------------------------------------------------------

function currentUser(ctx: any) {
  const user = userSystem.getInstance(getUserUuid(ctx));
  if (!user) throw new AiBanError("Forbidden", 403);
  return user;
}

/** Runs a ban route and maps validation errors to their HTTP status. */
async function banRoute(ctx: any, handler: () => Promise<unknown>) {
  try {
    ctx.body = await handler();
  } catch (error: any) {
    if (!(error instanceof AiBanError)) throw error;
    ctx.status = error.status;
    ctx.body = error.message;
  }
}

router.get(
  "/bans",
  permission({ level: ROLE.USER }),
  validator({ query: { daemonId: String, uuid: String } }),
  async (ctx) =>
    banRoute(ctx, () =>
      aiBans.list(currentUser(ctx), String(ctx.query.daemonId), String(ctx.query.uuid))
    )
);

router.get(
  "/bans/log-lines",
  permission({ level: ROLE.USER }),
  validator({ query: { daemonId: String, uuid: String, player: String } }),
  async (ctx) =>
    banRoute(ctx, () =>
      aiBans.logLinesFor(
        currentUser(ctx),
        String(ctx.query.daemonId),
        String(ctx.query.uuid),
        ctx.query.player
      )
    )
);

router.post(
  "/bans",
  permission({ level: ROLE.USER }),
  validator({
    query: { daemonId: String, uuid: String },
    body: { player: String, reason: String }
  }),
  async (ctx) =>
    banRoute(ctx, () =>
      aiBans.create(
        currentUser(ctx),
        String(ctx.query.daemonId),
        String(ctx.query.uuid),
        (ctx.request.body as any) || {}
      )
    )
);

router.get("/bans/case/:uuid", permission({ level: ROLE.USER }), async (ctx) =>
  banRoute(ctx, () => aiBans.get(currentUser(ctx), ctx.params.uuid))
);

router.get("/bans/case/:uuid/evidence/:id", permission({ level: ROLE.USER }), async (ctx) => {
  try {
    const { mime, file } = await aiBans.evidence(currentUser(ctx), ctx.params.uuid, ctx.params.id);
    ctx.set("Content-Type", mime);
    ctx.set("X-Content-Type-Options", "nosniff");
    ctx.set("Content-Disposition", "attachment");
    ctx.set("Cache-Control", "private, no-store");
    ctx.body = fs.createReadStream(file);
  } catch (error: any) {
    if (!(error instanceof AiBanError)) throw error;
    ctx.status = error.status;
    ctx.body = error.message;
  }
});

router.post("/bans/case/:uuid/apply", permission({ level: ROLE.USER }), async (ctx) =>
  banRoute(ctx, () =>
    aiBans.apply(currentUser(ctx), ctx.params.uuid, (ctx.request.body as any)?.overrideNote)
  )
);

router.get("/queue", permission({ level: ROLE.USER }), async (ctx) => {
  ctx.body = ai.getQueue(getUserUuid(ctx));
});

router.get("/requests/:uuid", permission({ level: ROLE.USER }), async (ctx) => {
  const request = await ai.getRequest(getUserUuid(ctx), ctx.params.uuid);
  if (!request) {
    ctx.status = 404;
    ctx.body = "AI request not found";
    return;
  }
  ctx.body = request;
});

router.post("/requests/:uuid/cancel", permission({ level: ROLE.USER }), async (ctx) => {
  ctx.body = { cancelled: await ai.cancel(getUserUuid(ctx), ctx.params.uuid) };
});

export default router;
