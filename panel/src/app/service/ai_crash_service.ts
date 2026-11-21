import { CrashRecord } from "./ai_schedule_collectors";
import aiSchedules from "./ai_schedule_service";
import { logger } from "./log";
import RemoteRequest from "./remote_command";
import RemoteServiceSubsystem from "./remote_service";

export const CRASH_POLL_INTERVAL_MS = 20 * 1000;
// Records keep their daemon timestamp; look back a little to never miss one at a boundary.
const OVERLAP_MS = 5 * 1000;
const MAX_SEEN_IDS = 1000;

/**
 * Collects unexpected stops (crashes, failed starts) from the daemons that host an instance
 * with a crash analysis task, and hands each new record to the AI schedule service once.
 */
export class AiCrashService {
  private timer?: NodeJS.Timeout;
  private polling = false;
  private readonly since = new Map<string, number>();
  private readonly seen = new Set<string>();

  initialize() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), CRASH_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  async poll(now = Date.now()) {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const daemonId of aiSchedules.crashTaskDaemons()) {
        await this.pollDaemon(daemonId, now);
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollDaemon(daemonId: string, now: number) {
    const remote = RemoteServiceSubsystem.getInstance(daemonId);
    if (!remote?.available) return;
    // First contact (or panel restart): only crashes of the last 5 minutes.
    const since = this.since.get(daemonId) ?? now - 5 * 60 * 1000;
    let records: CrashRecord[];
    try {
      const result = await new RemoteRequest(remote).request(
        "instance/unexpected_stops",
        { since: since - OVERLAP_MS },
        10000
      );
      records = Array.isArray(result) ? result : [];
    } catch (error: any) {
      // Daemons without this route (older versions) are simply skipped.
      logger.debug?.(
        `[AI_CRASH] Could not read unexpected stops from ${daemonId}: ${String(
          error?.message || error
        )}`
      );
      return;
    }
    let latest = since;
    for (const record of records) {
      if (!record?.id || typeof record.instanceUuid !== "string" || this.seen.has(record.id)) {
        continue;
      }
      this.remember(record.id);
      latest = Math.max(latest, Number(record.at) || 0);
      try {
        await aiSchedules.onCrash(daemonId, record);
      } catch (error: any) {
        logger.warn(`[AI_CRASH] Crash analysis failed: ${String(error?.message || error)}`);
      }
    }
    this.since.set(daemonId, latest);
  }

  private remember(id: string) {
    this.seen.add(id);
    if (this.seen.size > MAX_SEEN_IDS) {
      const oldest = this.seen.values().next().value;
      if (oldest) this.seen.delete(oldest);
    }
  }
}

export default new AiCrashService();
