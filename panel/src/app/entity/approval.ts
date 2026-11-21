export type AiAccessState = "none" | "pending" | "granted" | "refused" | "revoked";

/** AI access of one regular user (administrators always have access). */
export class AiAccess {
  userUuid = "";
  userName = "";
  state: AiAccessState = "none";
  reason = "";
  requestedAt = "";
  decidedAt = "";
  decidedBy = "";
  note = "";
}

export type AutomationKind = "schedule" | "ai_task";
export type AutomationRequestState = "pending" | "approved" | "refused" | "cancelled";

/** An automation created or edited by a regular user, waiting for an administrator. */
export class AutomationRequest {
  uuid = "";
  kind: AutomationKind = "schedule";
  /** Empty for migrated schedules whose creator could not be found. */
  requesterUuid = "";
  requesterName = "";
  daemonId = "";
  instanceUuid = "";
  instanceName = "";
  name = "";
  /** Exact body registered on approval (schedule or AI task fields). */
  payload: Record<string, any> = {};
  /** Name of the task this request replaces (edit), or "". */
  replaces = "";
  origin: "new" | "edit" | "migration" = "new";
  state: AutomationRequestState = "pending";
  createdAt = "";
  decidedAt = "";
  decidedBy = "";
  note = "";
  /** Last approval error shown to administrators. */
  error = "";
}
