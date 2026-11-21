import { getInstanceNameSafely } from "./instance_name_service";
import { logger } from "./log";
import { operationLogger } from "./operation_logger";
import RemoteRequest from "./remote_command";
import RemoteServiceSubsystem from "./remote_service";

export const BAN_GUARD_POLL_INTERVAL_MS = 20 * 1000;
// Events keep their daemon timestamp; look back a little to never miss one at a boundary.
const OVERLAP_MS = 5 * 1000;
const MAX_SEEN_IDS = 1000;

interface BanGuardEvent {
  id: string;
  at: number;
  instanceUuid: string;
  target: string;
  kind: "player" | "ip";
  line: string;
}

/**
 * Daemons revert every ban that did not go through "Ban a player". This service collects those
 * automatic unbans and writes each one to the operation log.
 */
export class BanGuardService {
  private timer?: NodeJS.Timeout;
  private polling = false;
  private readonly since = new Map<string, number>();
  private readonly seen = new Set<string>();

  initialize() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), BAN_GUARD_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  async poll(now = Date.now()) {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const [daemonId, remote] of RemoteServiceSubsystem.services.entries()) {
        if (remote?.available) await this.pollDaemon(daemonId, remote, now);
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollDaemon(daemonId: string, remote: any, now: number) {
    const since = this.since.get(daemonId) ?? now - 5 * 60 * 1000;
    let events: BanGuardEvent[];
    try {
      const result = await new RemoteRequest(remote).request(
        "ban_guard/events",
        { since: since - OVERLAP_MS },
        10000
      );
      events = Array.isArray(result) ? result : [];
    } catch (error: any) {
      // Daemons without this route (older versions) are skipped.
      logger.debug?.(
        `[BAN_GUARD] Could not read events from ${daemonId}: ${String(error?.message || error)}`
      );
      return;
    }
    let latest = since;
    for (const event of events) {
      if (!event?.id || typeof event.instanceUuid !== "string" || this.seen.has(event.id)) continue;
      this.remember(event.id);
      latest = Math.max(latest, Number(event.at) || 0);
      const target = String(event.target || "").slice(0, 64);
      operationLogger.log(
        "instance_player_unban_auto",
        {
          operator_ip: "daemon",
          operator_name: "MCSManager",
          instance_id: event.instanceUuid,
          daemon_id: daemonId,
          instance_name: await getInstanceNameSafely(daemonId, event.instanceUuid),
          player: target,
          target_kind: event.kind === "ip" ? "ip" : "player",
          console_line: String(event.line || "").slice(0, 300)
        },
        "warning"
      );
      logger.warn(
        `[BAN_GUARD] Ban of ${target} on instance ${event.instanceUuid} was not made through ` +
          `"Ban a player": reverted`
      );
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

export default new BanGuardService();
