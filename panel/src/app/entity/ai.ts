export type AiRequestState =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export interface AiMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
  toolName?: string;
  toolDecision?: "approved" | "refused" | "executed";
}

/** Instance a conversation is bound to; set by the panel only, never by the model. */
export interface AiInstanceScope {
  daemonId: string;
  instanceUuid: string;
  nickname?: string;
}

export type AiConversationKind = "chat" | "report";

export class AiConversation {
  uuid = "";
  /** "report": produced by a scheduled AI task, kept longer than chats. */
  kind: AiConversationKind = "chat";
  ownerUserUuid = "";
  title = "";
  createdAt = "";
  updatedAt = "";
  archivedAt = "";
  messages: AiMessage[] = [];
  // Storage only restores keys that exist on a fresh instance (see StorageSubsystem.defineAttr),
  // so the scope needs a template. Empty IDs mean "not bound"; see normalizeInstanceScope().
  instanceScope?: AiInstanceScope = { daemonId: "", instanceUuid: "", nickname: "" };
}

/** Turns the storage template back into "no scope" and drops empty optional fields. */
export function normalizeInstanceScope<T extends AiConversation>(conversation: T): T {
  const scope = conversation.instanceScope;
  if (!scope?.daemonId || !scope?.instanceUuid) {
    conversation.instanceScope = undefined;
  } else if (!scope.nickname) {
    conversation.instanceScope = { daemonId: scope.daemonId, instanceUuid: scope.instanceUuid };
  }
  return conversation;
}

export class AiRequestRecord {
  uuid = "";
  userUuid = "";
  conversationUuid = "";
  model = "";
  state: AiRequestState = "queued";
  priority = "normal";
  submittedAt = "";
  startedAt = "";
  completedAt = "";
  position = 0;
  estimatedWaitMs = 0;
  errorCode = "";
}

export type AiScheduleKind =
  | "console_report"
  | "file_check"
  | "plugin_updates"
  | "custom_prompt"
  | "crash_analysis";
export const AI_SCHEDULE_KINDS: readonly AiScheduleKind[] = [
  "console_report",
  "file_check",
  "plugin_updates",
  "custom_prompt",
  "crash_analysis"
];

/** Scheduled AI task bound to one instance; runs read-only under its owner's identity. */
export class AiScheduleTask {
  uuid = "";
  ownerUserUuid = "";
  daemonId = "";
  instanceUuid = "";
  name = "";
  kind: AiScheduleKind = "console_report";
  prompt = "";
  /** 1 = interval (seconds), 2 = weekly cycle (cron), 3 = specified time (cron), 4 = on crash. */
  type = 2;
  time = "";
  count = -1;
  createdAt = "";
  lastRunAt = "";
  /** "" | "queued" | "skipped" | "failed" ("completed" is derived from the request record). */
  lastStatus = "";
  lastReportUuid = "";
  lastRequestUuid = "";
  disabledReason = "";
}

export type AiBanVerdict = "justified" | "not_justified" | "insufficient_evidence";
export type AiBanState = "reviewing" | AiBanVerdict | "applied" | "failed";

export interface AiBanEvidenceImage {
  id: string;
  mime: string;
  size: number;
}

/** A ban request reviewed by the local AI before it can be applied. */
export class AiBanCase {
  uuid = "";
  requesterUserUuid = "";
  requesterName = "";
  daemonId = "";
  instanceUuid = "";
  player = "";
  reason = "";
  description = "";
  /** Console lines verified against the instance log when the case was created. */
  logLines: string[] = [];
  images: AiBanEvidenceImage[] = [];
  state: AiBanState = "reviewing";
  verdict = "";
  sanction = "";
  explanation = "";
  reportUuid = "";
  createdAt = "";
  decidedAt = "";
  appliedAt = "";
  appliedByName = "";
  overrideNote = "";
}
