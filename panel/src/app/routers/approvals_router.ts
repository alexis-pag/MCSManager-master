import Router from "@koa/router";
import { ROLE } from "../entity/user";
import permission from "../middleware/permission";
import validator from "../middleware/validator";
import aiAccess, { ApprovalError } from "../service/ai_access_service";
import automationRequests from "../service/automation_request_service";
import { getOperationLoggerOperator } from "../service/operation_logger";
import { getUserUuid } from "../service/passport_service";
import { isHaveInstanceByUuid } from "../service/permission_service";
import userSystem from "../service/user_service";

const router = new Router({ prefix: "/approvals" });

function currentUser(ctx: any) {
  const user = userSystem.getInstance(getUserUuid(ctx));
  if (!user) throw new ApprovalError("Forbidden", 403);
  return user;
}

async function handle(ctx: any, handler: () => Promise<unknown> | unknown) {
  try {
    ctx.body = await handler();
  } catch (error: any) {
    if (!(error instanceof ApprovalError)) throw error;
    ctx.status = error.status;
    ctx.body = error.message;
  }
}

const operatorIp = (ctx: any) => String(getOperationLoggerOperator(ctx)?.operator_ip || "");

// ---- Administrators: notification badge and approval center ------------------------------

router.get("/summary", permission({ level: ROLE.ADMIN }), async (ctx) => {
  ctx.body = { aiAccess: aiAccess.countPending(), automations: automationRequests.countPending() };
});

router.get("/", permission({ level: ROLE.ADMIN }), async (ctx) => {
  ctx.body = { aiAccess: aiAccess.listAll(), automations: automationRequests.listPending() };
});

router.post(
  "/ai-access/:userUuid",
  permission({ level: ROLE.ADMIN }),
  validator({ body: { decision: String } }),
  async (ctx) =>
    handle(ctx, () =>
      aiAccess.decide(
        currentUser(ctx),
        ctx.params.userUuid,
        (ctx.request.body as any)?.decision,
        (ctx.request.body as any)?.note,
        operatorIp(ctx)
      )
    )
);

router.post(
  "/automation/:uuid",
  permission({ level: ROLE.ADMIN }),
  validator({ body: { decision: String } }),
  async (ctx) =>
    handle(ctx, () =>
      automationRequests.decide(
        currentUser(ctx),
        ctx.params.uuid,
        (ctx.request.body as any)?.decision,
        (ctx.request.body as any)?.note,
        operatorIp(ctx)
      )
    )
);

// ---- Users of an instance: their pending / refused requests ------------------------------

router.get(
  "/automation",
  permission({ level: ROLE.USER }),
  validator({ query: { daemonId: String, uuid: String } }),
  async (ctx) => {
    const daemonId = String(ctx.query.daemonId);
    const instanceUuid = String(ctx.query.uuid);
    await handle(ctx, () => {
      if (!isHaveInstanceByUuid(getUserUuid(ctx), daemonId, instanceUuid)) {
        throw new ApprovalError("Forbidden", 403);
      }
      return automationRequests.list(currentUser(ctx), daemonId, instanceUuid);
    });
  }
);

router.delete("/automation/:uuid", permission({ level: ROLE.USER }), async (ctx) =>
  handle(ctx, () => automationRequests.cancel(currentUser(ctx), ctx.params.uuid))
);

export default router;
