import { v4 } from "uuid";

export const MAX_RECORDS = 200;
export const RECORD_TTL_MS = 60 * 60 * 1000;
// Rolling console tail kept per instance so an automatic restart cannot push the cause out.
export const TAIL_MAX_CHARS = 20000;

export interface UnexpectedStopRecord {
  id: string;
  instanceUuid: string;
  kind: "exit" | "start_failure";
  code: number | null;
  error: string;
  at: number;
  autoRestart: boolean;
  consoleTail: string;
}

interface InstanceLike {
  config: {
    eventTask?: { ignore?: boolean; autoRestart?: boolean; autoRestartMaxTimes?: number };
  };
  autoRestartCount?: number;
}

/**
 * Bounded, in-memory record of instances that stopped without a stop/kill/restart request
 * (`eventTask.ignore` is still set while the exit event is emitted) or failed to start.
 * The panel collects them to run AI crash analyses.
 */
export class UnexpectedStopService {
  private records: UnexpectedStopRecord[] = [];
  private readonly tails = new Map<string, string>();

  onData(instanceUuid: string, text: unknown) {
    if (typeof text !== "string" || !text) return;
    const tail = (this.tails.get(instanceUuid) ?? "") + text;
    this.tails.set(instanceUuid, tail.length > TAIL_MAX_CHARS ? tail.slice(-TAIL_MAX_CHARS) : tail);
  }

  /** Must run synchronously inside the instance "exit" event (before `ignore` is reset). */
  onExit(instanceUuid: string, instance: InstanceLike | undefined, code: unknown) {
    const eventTask = instance?.config?.eventTask;
    if (!instance || eventTask?.ignore) return;
    const maxRestarts = Number(eventTask?.autoRestartMaxTimes ?? -1);
    const autoRestart =
      Boolean(eventTask?.autoRestart) &&
      (maxRestarts === -1 || Number(instance.autoRestartCount ?? 0) < maxRestarts);
    this.add({
      instanceUuid,
      kind: "exit",
      code: Number.isFinite(Number(code)) ? Number(code) : null,
      error: "",
      autoRestart
    });
  }

  onFailure(instanceUuid: string, error: unknown) {
    const message = String((error as any)?.message ?? error ?? "").slice(0, 500);
    this.add({
      instanceUuid,
      kind: "start_failure",
      code: null,
      error: message,
      autoRestart: false
    });
  }

  forget(instanceUuid: string) {
    this.tails.delete(instanceUuid);
    this.records = this.records.filter((record) => record.instanceUuid !== instanceUuid);
  }

  /** Records newer than `since` (milliseconds), oldest first. */
  list(since: unknown, now = Date.now()): UnexpectedStopRecord[] {
    this.prune(now);
    const from = Number(since) || 0;
    return this.records.filter((record) => record.at > from);
  }

  private add(fields: Omit<UnexpectedStopRecord, "id" | "at" | "consoleTail">, now = Date.now()) {
    this.records.push({
      ...fields,
      id: v4().replace(/-/g, ""),
      at: now,
      consoleTail: this.tails.get(fields.instanceUuid) ?? ""
    });
    this.prune(now);
  }

  private prune(now: number) {
    this.records = this.records
      .filter((record) => now - record.at <= RECORD_TTL_MS)
      .slice(-MAX_RECORDS);
  }
}

export default new UnexpectedStopService();
