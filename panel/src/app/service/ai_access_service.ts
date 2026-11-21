import Storage from "../common/storage/sys_storage";
import { AiAccess, AiAccessState } from "../entity/approval";
import { ROLE, User } from "../entity/user";
import { logger } from "./log";
import { operationLogger } from "./operation_logger";
import userSystem from "./user_service";

export const ACCESS_REASON_MIN = 10;
export const ACCESS_REASON_MAX = 300;
export const ACCESS_RETRY_MS = 24 * 60 * 60 * 1000;

// Routes usable without AI access: status, the access request itself and moderated bans
// ("Ban a player" is a moderation safeguard, not the assistant).
const ACCESS_FREE_AI_PATH = /^\/api\/ai\/(status|access|bans)(\/|$)/;

export function isAccessFreeAiPath(path: string) {
  return ACCESS_FREE_AI_PATH.test(path);
}

export class ApprovalError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

/** Regular users need an administrator's grant to use the local AI. */
export class AiAccessService {
  // Synchronous access checks (AI routes, scheduled runs) read this cache.
  private readonly cache = new Map<string, AiAccess>();
  private loaded = false;

  async initialize() {
    if (this.loaded) return;
    this.loaded = true;
    for (const uuid of await Storage.getStorage().list("AiAccess")) {
      const record: AiAccess | null = await Storage.getStorage().load("AiAccess", AiAccess, uuid);
      if (record?.userUuid) this.cache.set(record.userUuid, record);
    }
  }

  hasAccess(user: User | null | undefined): boolean {
    if (!user) return false;
    if (user.permission >= ROLE.ADMIN) return true;
    return this.cache.get(user.uuid)?.state === "granted";
  }

  hasAccessByUuid(userUuid: string) {
    return this.hasAccess(userSystem.getInstance(userUuid));
  }

  /** What the user sees: their state and the administrator's note. */
  view(user: User) {
    if (user.permission >= ROLE.ADMIN) return { state: "granted" as AiAccessState, note: "" };
    const record = this.cache.get(user.uuid);
    return {
      state: record?.state || ("none" as AiAccessState),
      note: record?.note || "",
      requestedAt: record?.requestedAt || "",
      decidedAt: record?.decidedAt || ""
    };
  }

  async request(user: User, reasonInput: unknown, now = Date.now()) {
    if (user.permission >= ROLE.ADMIN)
      throw new ApprovalError("Administrators already have access");
    const reason = String(reasonInput ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (reason.length < ACCESS_REASON_MIN || reason.length > ACCESS_REASON_MAX) {
      throw new ApprovalError("Reason length");
    }
    const current = this.cache.get(user.uuid);
    if (current?.state === "granted") throw new ApprovalError("Access already granted");
    if (current?.state === "pending") throw new ApprovalError("Request already pending");
    if (
      (current?.state === "refused" || current?.state === "revoked") &&
      now - Date.parse(current.decidedAt) < ACCESS_RETRY_MS
    ) {
      throw new ApprovalError("Retry later");
    }
    const record = Object.assign(new AiAccess(), {
      userUuid: user.uuid,
      userName: user.userName,
      state: "pending",
      reason,
      requestedAt: new Date(now).toISOString(),
      decidedAt: "",
      decidedBy: "",
      note: ""
    });
    await this.save(record);
    logger.info(`[AI_ACCESS] ${user.userName} requested AI access`);
    return this.view(user);
  }

  /** Records of users that still exist (deleted users are not shown to administrators). */
  private records() {
    return [...this.cache.values()].filter((record) => userSystem.getInstance(record.userUuid));
  }

  listPending() {
    return this.records()
      .filter((record) => record.state === "pending")
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  /** All regular users' records (pending, granted, refused...), for the admin center. */
  listAll() {
    return this.records().sort((a, b) =>
      (b.decidedAt || b.requestedAt).localeCompare(a.decidedAt || a.requestedAt)
    );
  }

  countPending() {
    return this.listPending().length;
  }

  async decide(
    admin: User,
    userUuid: string,
    decision: unknown,
    noteInput: unknown,
    operatorIp = ""
  ) {
    if (admin.permission < ROLE.ADMIN) throw new ApprovalError("Forbidden", 403);
    const target = userSystem.getInstance(userUuid);
    if (!target) throw new ApprovalError("User not found", 404);
    if (target.permission >= ROLE.ADMIN)
      throw new ApprovalError("Administrators already have access");
    const current = this.cache.get(userUuid);
    const note = String(noteInput ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    let state: AiAccessState;
    if (decision === "grant") state = "granted";
    else if (decision === "refuse" && current?.state === "pending") state = "refused";
    else if (decision === "revoke" && current?.state === "granted") state = "revoked";
    else throw new ApprovalError("Invalid decision");
    const record = Object.assign(new AiAccess(), current || {}, {
      userUuid,
      userName: target.userName,
      state,
      decidedAt: new Date().toISOString(),
      decidedBy: admin.userName,
      note
    });
    await this.save(record);
    operationLogger.log(
      "admin_approval",
      {
        operator_ip: operatorIp,
        operator_name: admin.userName,
        target_user_name: target.userName,
        subject: "ai_access",
        decision: String(decision),
        ...(note ? { note } : {})
      },
      decision === "grant" ? "info" : "warning"
    );
    logger.info(`[AI_ACCESS] ${admin.userName} ${decision} AI access of ${target.userName}`);
    return record;
  }

  private async save(record: AiAccess) {
    this.cache.set(record.userUuid, record);
    await Storage.getStorage().store("AiAccess", record.userUuid, record);
  }
}

export default new AiAccessService();
