import { v4 } from "uuid";

// Bans must go through the panel's "Ban a player" flow. Any ban seen in a console that the panel
// did not authorize just before (in-game operator, terminal, plugin, script...) is reverted with
// `pardon` / `pardon-ip`, and recorded so the panel can write it to the operation log.

export const ALLOW_TTL_MS = 2 * 60 * 1000;
export const MAX_EVENTS = 200;
export const EVENT_TTL_MS = 60 * 60 * 1000;
const DEDUPE_MS = 10 * 1000;
const MAX_PARDONS_PER_MINUTE = 10;
const MAX_PARTIAL_LINE = 4096;

export type BanTargetKind = "player" | "ip";

export interface BanDetection {
  target: string;
  kind: BanTargetKind;
}

export interface BanGuardEvent {
  id: string;
  at: number;
  instanceUuid: string;
  target: string;
  kind: BanTargetKind;
  /** Console line that showed the ban (clipped). */
  line: string;
}

const PLAYER = /^[.*]?[A-Za-z0-9_]{1,20}$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6 = /^[0-9a-f:]{2,39}$/i;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007|§[0-9a-fk-or]/gi;

/**
 * Detects a ban in one console line:
 *   vanilla / Paper / Forge console  "Banned Steve: reason", "Banned IP 1.2.3.4: reason"
 *   operator in game                 "[Alex: Banned Steve: reason]"
 *   EssentialsX                       "Player Alex banned Steve for: reason"
 * Player chat ("<Steve> Banned Bob: lol") is ignored.
 */
export function detectBan(rawLine: string): BanDetection | null {
  // The terminal prompt ("> ") and the log line can share a line, separated by "\r".
  const line =
    rawLine
      .replace(ANSI, "")
      .split("\r")
      .map((part) => part.trim())
      .filter(Boolean)
      .pop() ?? "";
  if (!line) return null;
  const prefixEnd = line.indexOf("]: ");
  // Recent servers log system messages as "System chat: …" (Forge/NeoForge 1.19+).
  const message = (prefixEnd >= 0 ? line.slice(prefixEnd + 3).trim() : line).replace(
    /^System (?:chat|message):\s*/i,
    ""
  );
  if (message.startsWith("<") || /\[(?:CHAT|Not Secure)\]/i.test(message)) return null;

  const vanilla = message.match(
    // "Banned Steve: reason" (1.13+) and "Banned player Steve" (1.12 and older).
    /^\[?(?:[.*]?[A-Za-z0-9_]{1,20}: )?Banned (?:player )?(IP (?:address )?)?([^\s:\]]{1,64})(?::|\]|$)/
  );
  const essentials = message.match(
    /^Player \S+ (?:temporarily )?(?:ip-?)?banned (\S+?)(?:\s|:|\.|$)/i
  );
  const target = vanilla?.[2] ?? essentials?.[1];
  if (!target) return null;
  if (IPV4.test(target) || (vanilla?.[1] && IPV6.test(target))) return { target, kind: "ip" };
  if (vanilla?.[1]) return null; // "Banned IP <not an IP>"
  return PLAYER.test(target) ? { target, kind: "player" } : null;
}

export interface BanListEntry extends BanDetection {
  source: string;
}

const listKey = (ban: BanDetection) => `${ban.kind}:${ban.target.toLowerCase()}`;

/** Entries of banned-players.json / banned-ips.json with a valid target (others ignored). */
export function parseBanList(text: string | null | undefined, kind: BanTargetKind): BanListEntry[] {
  if (!text) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const entries: BanListEntry[] = [];
  for (const item of data.slice(0, 5000)) {
    const target = String((kind === "ip" ? item?.ip : item?.name) ?? "").trim();
    const valid = kind === "ip" ? IPV4.test(target) || IPV6.test(target) : PLAYER.test(target);
    if (!valid) continue;
    entries.push({ target, kind, source: String(item?.source ?? "").slice(0, 40) });
  }
  return entries;
}

export interface GuardedInstance {
  execPreset(action: "command", command: string): Promise<unknown>;
  println(level: string, text: string): void;
}

export class BanGuardService {
  private events: BanGuardEvent[] = [];
  private readonly partial = new Map<string, string>();
  private readonly allowed = new Map<string, number>();
  private readonly recent = new Map<string, number>();
  private readonly pardons = new Map<string, number[]>();
  // Ban list entries accepted per instance (baseline + authorized bans).
  private readonly known = new Map<string, Set<string>>();

  constructor(private readonly notice = (target: string) => `Ban of ${target} reverted`) {}

  private key(instanceUuid: string, target: string) {
    return `${instanceUuid}:${target.toLowerCase()}`;
  }

  /** The panel's "Ban a player" flow is about to ban `target`: let that ban through once. */
  allow(instanceUuid: string, target: unknown, now = Date.now()) {
    const value = String(target ?? "").trim();
    if (!value || value.length > 64) throw new Error("Invalid ban target");
    this.allowed.set(this.key(instanceUuid, value), now + ALLOW_TTL_MS);
    for (const [key, expires] of this.allowed) if (expires < now) this.allowed.delete(key);
    return true;
  }

  /** Console output of an instance (chunks, not lines). */
  onData(
    instanceUuid: string,
    text: unknown,
    instance: GuardedInstance | undefined,
    now = Date.now()
  ) {
    if (typeof text !== "string" || !text || !instance) return;
    const buffered = (this.partial.get(instanceUuid) ?? "") + text;
    const lines = buffered.split(/\r?\n/);
    const rest = lines.pop() ?? "";
    this.partial.set(instanceUuid, rest.length > MAX_PARTIAL_LINE ? "" : rest);
    for (const line of lines) {
      const ban = detectBan(line);
      if (ban) this.handle(instanceUuid, ban, line, instance, now);
    }
  }

  /** Consumes the panel's authorization for this ban; the ban is then remembered as legitimate. */
  private consumeAuthorization(instanceUuid: string, ban: BanDetection, now: number) {
    const key = this.key(instanceUuid, ban.target);
    const allowedUntil = this.allowed.get(key);
    if (!allowedUntil || allowedUntil < now) return false;
    this.allowed.delete(key);
    this.known.get(instanceUuid)?.add(listKey(ban));
    return true;
  }

  /**
   * Ban lists of a running Java server (`banned-players.json`, `banned-ips.json`): catches bans
   * whatever their console message (plugins, other server software). The first read of an
   * instance is the baseline: bans that already exist are left alone.
   */
  checkBanLists(
    instanceUuid: string,
    lists: { players?: string | null; ips?: string | null },
    instance: GuardedInstance | undefined,
    now = Date.now()
  ) {
    if (!instance) return;
    const entries = [...parseBanList(lists.players, "player"), ...parseBanList(lists.ips, "ip")];
    const current = new Set(entries.map(listKey));
    const known = this.known.get(instanceUuid);
    if (!known) {
      this.known.set(instanceUuid, current);
      return;
    }
    for (const entry of entries) {
      const key = listKey(entry);
      if (known.has(key)) continue;
      if (this.consumeAuthorization(instanceUuid, entry, now)) continue;
      const source = entry.source ? ` (source: ${entry.source})` : "";
      const file = entry.kind === "ip" ? "banned-ips.json" : "banned-players.json";
      this.handle(instanceUuid, entry, `${file}: ${entry.target}${source}`, instance, now);
    }
    // Pardoned or removed entries are forgotten, so a later ban of the same target is seen.
    for (const key of [...known]) if (!current.has(key)) known.delete(key);
  }

  private handle(
    instanceUuid: string,
    ban: BanDetection,
    line: string,
    instance: GuardedInstance,
    now: number
  ) {
    const key = this.key(instanceUuid, ban.target);
    if (this.consumeAuthorization(instanceUuid, ban, now)) return;
    // The same ban can be printed twice (console feedback + operator broadcast).
    const last = this.recent.get(key);
    if (last !== undefined && last > now - DEDUPE_MS) return;
    this.recent.set(key, now);
    for (const [recentKey, at] of this.recent)
      if (at < now - DEDUPE_MS) this.recent.delete(recentKey);

    const window = (this.pardons.get(instanceUuid) ?? []).filter((at) => at > now - 60 * 1000);
    if (window.length >= MAX_PARDONS_PER_MINUTE) return; // never flood the console
    window.push(now);
    this.pardons.set(instanceUuid, window);

    const command = ban.kind === "ip" ? `pardon-ip ${ban.target}` : `pardon ${ban.target}`;
    instance.execPreset("command", command).catch(() => undefined);
    instance.println("MCSManager", this.notice(ban.target));
    this.events.push({
      id: v4().replace(/-/g, ""),
      at: now,
      instanceUuid,
      target: ban.target,
      kind: ban.kind,
      line: line.replace(ANSI, "").trim().slice(0, 300)
    });
    this.prune(now);
  }

  /** Events newer than `since` (milliseconds), oldest first. */
  list(since: unknown, now = Date.now()): BanGuardEvent[] {
    this.prune(now);
    const from = Number(since) || 0;
    return this.events.filter((event) => event.at > from);
  }

  forget(instanceUuid: string) {
    this.partial.delete(instanceUuid);
    this.pardons.delete(instanceUuid);
    this.known.delete(instanceUuid);
  }

  private prune(now: number) {
    this.events = this.events.filter((event) => now - event.at <= EVENT_TTL_MS).slice(-MAX_EVENTS);
  }
}
