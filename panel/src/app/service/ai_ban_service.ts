import fs from "fs-extra";
import { StorageSubsystem } from "mcsmanager-common";
import path from "path";
import { v4 } from "uuid";
import Storage from "../common/storage/sys_storage";
import { AiBanCase, AiBanEvidenceImage, AiBanVerdict } from "../entity/ai";
import { ROLE, User } from "../entity/user";
import { systemConfig } from "../setting";
import { cleanConsoleLines } from "./ai_schedule_collectors";
import { parseJsonObject } from "./local_ai_service";
import localAi from "./local_ai_service";
import { logger } from "./log";
import { operationLogger } from "./operation_logger";
import { getInstanceNameSafely } from "./instance_name_service";
import { isHaveInstance } from "./permission_service";
import RemoteRequest from "./remote_command";
import RemoteServiceSubsystem from "./remote_service";

export const PLAYER_NAME = /^[A-Za-z0-9_]{3,16}$/;
export const REASON_MIN_CHARS = 15;
export const REASON_MAX_CHARS = 200;
export const DESCRIPTION_MIN_CHARS = 30;
export const DESCRIPTION_MAX_CHARS = 2000;
export const MAX_LOG_LINES = 50;
export const MAX_LOG_LINE_CHARS = 500;
export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const OVERRIDE_NOTE_MIN_CHARS = 15;
export const BAN_CASE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const EVIDENCE_DIR = path.join(StorageSubsystem.DATA_PATH, "AiBanEvidence");
const RUNNING = 3;

export class AiBanError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

// Words that carry no meaning as a ban reason ("test", "parce que", "no reason"...).
const PLACEHOLDER_WORDS = new Set([
  "test",
  "tests",
  "ban",
  "bannir",
  "banni",
  "bannis",
  "banned",
  "aaa",
  "aa",
  "a",
  "x",
  "xx",
  "xxx",
  "rien",
  "reason",
  "raison",
  "motif",
  "because",
  "parce",
  "que",
  "pq",
  "pcq",
  "no",
  "none",
  "null",
  "idk",
  "jsp",
  "lol",
  "mdr",
  "ok",
  "nothing",
  "just",
  "juste",
  "comme",
  "ça",
  "ca",
  "for",
  "pour",
  "le",
  "la",
  "les",
  "un",
  "une",
  "de",
  "the",
  "it",
  "is",
  "c",
  "est",
  "voila",
  "voilà",
  "bye",
  "dehors",
  "out",
  "player",
  "joueur"
]);

/** Rejects empty or meaningless reasons before the AI is called. Returns the cleaned reason. */
export function validateReason(value: unknown): string {
  const reason = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (reason.length < REASON_MIN_CHARS || reason.length > REASON_MAX_CHARS) {
    throw new AiBanError("Reason length");
  }
  const letters = new Set(reason.toLowerCase().replace(/[^\p{L}]/gu, ""));
  const words = reason
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const meaningful = words.filter((word) => !PLACEHOLDER_WORDS.has(word) && word.length > 1);
  if (letters.size < 4 || meaningful.length < 2) throw new AiBanError("Reason not meaningful");
  return reason;
}

/** Recent console lines that mention the player (whole word, case-insensitive). */
export function linesMentioning(logText: unknown, player: string): string[] {
  const needle = new RegExp(`(^|[^A-Za-z0-9_])${player}([^A-Za-z0-9_]|$)`, "i");
  return cleanConsoleLines(logText)
    .filter((line) => needle.test(line))
    .slice(-MAX_LOG_LINES)
    .map((line) => line.trim().slice(0, MAX_LOG_LINE_CHARS));
}

/** Keeps only submitted lines that really appear in the console log. */
export function verifyLogLines(submitted: unknown, logText: unknown): string[] {
  if (!Array.isArray(submitted)) return [];
  const known = new Set(
    cleanConsoleLines(logText).map((line) => line.trim().slice(0, MAX_LOG_LINE_CHARS))
  );
  const kept: string[] = [];
  for (const item of submitted.slice(0, MAX_LOG_LINES)) {
    const line = typeof item === "string" ? item.trim().slice(0, MAX_LOG_LINE_CHARS) : "";
    if (line && known.has(line) && !kept.includes(line)) kept.push(line);
  }
  return kept;
}

const IMAGE_TYPES: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  "image/png": {
    ext: "png",
    magic: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  },
  "image/jpeg": {
    ext: "jpg",
    magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
  },
  "image/webp": {
    ext: "webp",
    magic: (b) =>
      b.length > 12 &&
      b.subarray(0, 4).toString("latin1") === "RIFF" &&
      b.subarray(8, 12).toString("latin1") === "WEBP"
  }
};

/** Decodes a `data:image/...;base64,` URI after checking type, size and file signature. */
export function decodeEvidenceImage(value: unknown): { mime: string; ext: string; data: Buffer } {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(value));
  if (!match) throw new AiBanError("Invalid image");
  const data = Buffer.from(match[2], "base64");
  const type = IMAGE_TYPES[match[1]];
  if (!data.length || data.length > MAX_IMAGE_BYTES) throw new AiBanError("Image too large");
  if (!type.magic(data)) throw new AiBanError("Invalid image");
  return { mime: match[1], ext: type.ext, data };
}

const VERDICTS: AiBanVerdict[] = ["justified", "not_justified", "insufficient_evidence"];
const SANCTIONS = ["ban", "temporary_ban", "warning", "none"];

/** Parses the model verdict; anything unexpected is "insufficient_evidence". */
export function parseVerdict(answer: unknown) {
  const value = parseJsonObject(answer);
  const verdict = VERDICTS.find((item) => item === value?.verdict);
  const explanation =
    typeof value?.explanation === "string" ? value.explanation.trim().slice(0, 2000) : "";
  if (!verdict || !explanation) {
    return {
      verdict: "insufficient_evidence" as AiBanVerdict,
      sanction: "none",
      explanation: "",
      parsed: false
    };
  }
  const sanction = SANCTIONS.includes(String(value?.sanction)) ? String(value?.sanction) : "none";
  return { verdict, sanction, explanation, parsed: true };
}

/** Console command built by the panel from validated fields only. */
export function buildBanCommand(player: string, reason: string) {
  if (!PLAYER_NAME.test(player)) throw new AiBanError("Invalid player name");
  return `ban ${player} ${validateReason(reason)}`;
}

export function moderatorPrompt(imageCount: number, vision: boolean) {
  const screenshots = !imageCount
    ? "No screenshot was attached."
    : vision
      ? `${imageCount} screenshot(s) are attached to the request; examine them.`
      : `${imageCount} screenshot(s) were attached but you cannot see them: do not assume what they show.`;
  return (
    "You are an impartial moderator for a Minecraft server. Decide whether banning the player " +
    "is deserved. A ban is justified only if the evidence shows a serious or repeated rule " +
    "violation by this player (cheating, griefing, harassment, hate speech, threats, scams, " +
    "exploits). A personal dispute, a single mild insult, or claims without evidence are not " +
    "enough. `verifiedLogLines` were checked by the panel and really appear in the server " +
    "console. `requesterDescription` is only the requester's own account. " +
    screenshots +
    ' Reply with ONLY one JSON object: {"verdict": "justified" | "not_justified" | ' +
    '"insufficient_evidence", "sanction": "ban" | "temporary_ban" | "warning" | "none", ' +
    '"explanation": "2 to 5 sentences, in the language of the reason"}.'
  );
}

const VERDICT_LABELS: Record<AiBanVerdict, string> = {
  justified: "Ban justifié",
  not_justified: "Ban non justifié",
  insufficient_evidence: "Preuves insuffisantes"
};

export interface BanRequestInput {
  player?: unknown;
  reason?: unknown;
  description?: unknown;
  logLines?: unknown;
  images?: unknown;
}

export class AiBanService {
  private purgeTimer?: NodeJS.Timeout;

  initialize() {
    if (this.purgeTimer) return;
    const purge = () =>
      this.purgeExpired().catch((error) =>
        logger.warn(`[AI_BAN] Cleanup failed: ${String(error?.message || error)}`)
      );
    void purge();
    this.purgeTimer = setInterval(purge, 6 * 60 * 60 * 1000);
    this.purgeTimer.unref?.();
  }

  private remote(daemonId: string) {
    const remote = RemoteServiceSubsystem.getInstance(daemonId);
    if (!remote?.available) throw new AiBanError("Daemon unavailable", 503);
    return remote;
  }

  private async readLog(daemonId: string, instanceUuid: string): Promise<string> {
    try {
      const text = await new RemoteRequest(this.remote(daemonId)).request(
        "instance/outputlog",
        { instanceUuid },
        15000
      );
      return typeof text === "string" ? text : "";
    } catch (error) {
      if (error instanceof AiBanError) throw error;
      return "";
    }
  }

  private async instanceDetail(daemonId: string, instanceUuid: string) {
    return new RemoteRequest(this.remote(daemonId)).request(
      "instance/detail",
      { instanceUuid },
      10000
    );
  }

  private checkAccess(user: User, daemonId: string, instanceUuid: string) {
    if (!isHaveInstance(user, daemonId, instanceUuid)) throw new AiBanError("Forbidden", 403);
  }

  async logLinesFor(user: User, daemonId: string, instanceUuid: string, player: unknown) {
    this.checkAccess(user, daemonId, instanceUuid);
    const name = String(player ?? "");
    if (!PLAYER_NAME.test(name)) throw new AiBanError("Invalid player name");
    return linesMentioning(await this.readLog(daemonId, instanceUuid), name);
  }

  async create(
    user: User,
    daemonId: string,
    instanceUuid: string,
    input: BanRequestInput
  ): Promise<AiBanCase> {
    this.checkAccess(user, daemonId, instanceUuid);
    if (!systemConfig?.aiEnabled) throw new AiBanError("Local AI is disabled");
    const player = String(input.player ?? "").trim();
    if (!PLAYER_NAME.test(player)) throw new AiBanError("Invalid player name");
    const reason = validateReason(input.reason);
    const description = String(input.description ?? "")
      .replace(/\r\n?/g, "\n")
      .trim();
    if (description.length > DESCRIPTION_MAX_CHARS) throw new AiBanError("Description too long");
    const rawImages = Array.isArray(input.images) ? input.images : [];
    if (rawImages.length > MAX_IMAGES) throw new AiBanError("Too many images");
    const images = rawImages.map(decodeEvidenceImage);

    const pending = (await this.list(user, daemonId, instanceUuid)).some(
      (item) => item.requesterUserUuid === user.uuid && item.state === "reviewing"
    );
    if (pending) throw new AiBanError("Review in progress");

    const detail = await this.instanceDetail(daemonId, instanceUuid);
    if (!String(detail?.config?.type || "").startsWith("minecraft/java")) {
      throw new AiBanError("Only Minecraft Java servers are supported");
    }
    const logLines = verifyLogLines(input.logLines, await this.readLog(daemonId, instanceUuid));
    if (!logLines.length && description.length < DESCRIPTION_MIN_CHARS && !images.length) {
      throw new AiBanError("Evidence required");
    }

    const banCase = new AiBanCase();
    banCase.uuid = v4().replace(/-/g, "");
    banCase.requesterUserUuid = user.uuid;
    banCase.requesterName = user.userName;
    banCase.daemonId = daemonId;
    banCase.instanceUuid = instanceUuid;
    banCase.player = player;
    banCase.reason = reason;
    banCase.description = description;
    banCase.logLines = logLines;
    banCase.createdAt = new Date().toISOString();

    const dir = path.join(EVIDENCE_DIR, banCase.uuid);
    for (const image of images) {
      const entry: AiBanEvidenceImage = {
        id: v4().replace(/-/g, ""),
        mime: image.mime,
        size: image.data.length
      };
      await fs.outputFile(path.join(dir, `${entry.id}.${image.ext}`), image.data);
      banCase.images.push(entry);
    }

    const conversation = await localAi.createConversation(
      user.uuid,
      `Ban · ${player}`,
      { daemonId, instanceUuid },
      "report"
    );
    banCase.reportUuid = conversation.uuid;
    await this.save(banCase);

    const vision = Boolean(systemConfig?.aiVisionEnabled);
    const context = JSON.stringify({
      player,
      reason,
      requesterDescription: description,
      verifiedLogLines: logLines,
      screenshots: images.length
    });
    try {
      await localAi.submit(
        user.uuid,
        conversation.uuid,
        `Demande de ban de « ${player} » — motif : ${reason}`,
        {
          scheduledContext: context,
          moderationSystemPrompt: moderatorPrompt(images.length, vision),
          images: vision
            ? images.map((image) => `data:${image.mime};base64,${image.data.toString("base64")}`)
            : [],
          transformAnswer: (answer) => this.recordVerdict(banCase, answer),
          onFinished: (state) => {
            if (state !== "completed") void this.markFailed(banCase);
          }
        }
      );
    } catch (error: any) {
      await this.markFailed(banCase);
      throw new AiBanError(
        String(error?.message) === "AI queue is full" ? "AI queue is full" : "AI review failed",
        503
      );
    }
    logger.info(`[AI_BAN] Case ${banCase.uuid} submitted for player ${player} by ${user.userName}`);
    return banCase;
  }

  /** Stores the verdict and returns the readable text shown in the AI history. */
  private recordVerdict(banCase: AiBanCase, answer: string): string {
    const result = parseVerdict(answer);
    banCase.state = result.verdict;
    banCase.verdict = result.verdict;
    banCase.sanction = result.sanction;
    banCase.explanation =
      result.explanation ||
      "La réponse de l’IA n’a pas pu être interprétée : la demande est considérée comme insuffisamment prouvée.";
    banCase.decidedAt = new Date().toISOString();
    void this.save(banCase);
    return `**${VERDICT_LABELS[result.verdict]}** (sanction suggérée : ${result.sanction})\n\n${
      banCase.explanation
    }`;
  }

  private async markFailed(banCase: AiBanCase) {
    if (banCase.state !== "reviewing") return;
    banCase.state = "failed";
    banCase.explanation = "L’IA n’a pas pu examiner la demande.";
    banCase.decidedAt = new Date().toISOString();
    await this.save(banCase);
  }

  private async save(banCase: AiBanCase) {
    await Storage.getStorage().store("AiBanCase", banCase.uuid, banCase);
  }

  private async load(uuid: string): Promise<AiBanCase | null> {
    if (!/^[a-f0-9]{32}$/.test(uuid)) return null;
    return Storage.getStorage().load("AiBanCase", AiBanCase, uuid);
  }

  private canSee(user: User, banCase: AiBanCase) {
    return (
      isHaveInstance(user, banCase.daemonId, banCase.instanceUuid) &&
      (user.permission >= ROLE.ADMIN || banCase.requesterUserUuid === user.uuid)
    );
  }

  /** Cases of the instance: all for administrators, own cases for regular users. */
  async list(user: User, daemonId: string, instanceUuid: string) {
    this.checkAccess(user, daemonId, instanceUuid);
    const result: AiBanCase[] = [];
    for (const uuid of await Storage.getStorage().list("AiBanCase")) {
      const banCase = await this.load(uuid);
      if (
        banCase &&
        banCase.daemonId === daemonId &&
        banCase.instanceUuid === instanceUuid &&
        this.canSee(user, banCase)
      ) {
        result.push(banCase);
      }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
  }

  async get(user: User, uuid: string) {
    const banCase = await this.load(uuid);
    if (!banCase || !this.canSee(user, banCase)) throw new AiBanError("Not found", 404);
    return banCase;
  }

  async evidence(user: User, uuid: string, imageId: string) {
    const banCase = await this.get(user, uuid);
    const image = banCase.images.find((item) => item.id === imageId);
    if (!image) throw new AiBanError("Not found", 404);
    const ext = Object.entries(IMAGE_TYPES).find(([mime]) => mime === image.mime)?.[1].ext;
    return { mime: image.mime, file: path.join(EVIDENCE_DIR, banCase.uuid, `${image.id}.${ext}`) };
  }

  /** Sends the ban command. Regular users need a "justified" verdict; admins may override. */
  async apply(user: User, uuid: string, overrideNote?: unknown) {
    const banCase = await this.get(user, uuid);
    if (banCase.state === "applied") throw new AiBanError("Already applied");
    if (banCase.state === "reviewing") throw new AiBanError("Review in progress");
    let note = "";
    if (banCase.state !== "justified") {
      if (user.permission < ROLE.ADMIN) throw new AiBanError("Ban not justified", 403);
      note = String(overrideNote ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (note.length < OVERRIDE_NOTE_MIN_CHARS || note.length > 500) {
        throw new AiBanError("Override note required");
      }
    }
    const detail = await this.instanceDetail(banCase.daemonId, banCase.instanceUuid);
    if (Number(detail?.status) !== RUNNING) throw new AiBanError("Instance is not running");
    const command = buildBanCommand(banCase.player, banCase.reason);
    // The daemon reverts every ban it was not told about: authorize this one first.
    await new RemoteRequest(this.remote(banCase.daemonId))
      .request(
        "ban_guard/allow",
        { instanceUuid: banCase.instanceUuid, target: banCase.player },
        10000
      )
      .catch((error: any) =>
        logger.warn(`[AI_BAN] Ban guard authorization failed: ${String(error?.message || error)}`)
      );
    await new RemoteRequest(this.remote(banCase.daemonId)).request(
      "instance/command",
      { instanceUuid: banCase.instanceUuid, command },
      10000
    );
    banCase.state = "applied";
    banCase.appliedAt = new Date().toISOString();
    banCase.appliedByName = user.userName;
    banCase.overrideNote = note;
    await this.save(banCase);
    operationLogger.log(
      "instance_player_ban",
      {
        operator_ip: "panel",
        operator_name: user.userName,
        instance_id: banCase.instanceUuid,
        daemon_id: banCase.daemonId,
        instance_name: await getInstanceNameSafely(banCase.daemonId, banCase.instanceUuid),
        player: banCase.player,
        reason: banCase.reason,
        verdict: banCase.verdict || banCase.state,
        ...(note ? { override_note: note } : {})
      },
      note ? "warning" : "info"
    );
    logger.info(
      `[AI_BAN] Player ${banCase.player} banned on ${banCase.instanceUuid} by ${user.userName}` +
        (note ? " (override)" : "")
    );
    return banCase;
  }

  async purgeExpired(now = Date.now()) {
    let removed = 0;
    for (const uuid of await Storage.getStorage().list("AiBanCase")) {
      const banCase = await this.load(uuid);
      if (!banCase) continue;
      const created = Date.parse(banCase.createdAt);
      if (!Number.isNaN(created) && created + BAN_CASE_RETENTION_MS <= now) {
        await Storage.getStorage().delete("AiBanCase", uuid);
        await fs.remove(path.join(EVIDENCE_DIR, uuid));
        removed++;
      }
    }
    if (removed) logger.info(`[AI_BAN] Deleted ${removed} expired ban case(s)`);
    return removed;
  }
}

export default new AiBanService();
