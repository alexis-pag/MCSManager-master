import { createHash } from "crypto";
import fs from "fs-extra";
import os from "os";
import Instance from "../entity/instance/instance";
import { checkSafeUrl } from "../utils/url";
import downloadManager from "./download_manager";
import { getFileManager } from "./file_router_service";
import { InstanceUpdateAction } from "./instance_update_action";
import logger from "./log";

// Commands run for the panel's AI assistant: a mod loader installer (official jar downloaded
// and checksum-verified here) or an administrator's command. The panel decides which one is
// allowed; this module enforces the execution boundaries.

export const MAX_AI_COMMAND_CHARS = 1000;
export const MAX_AI_COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_CAPTURED_OUTPUT = 64 * 1024;
const OUTPUT_LINES = 60;

/** Official mod loader repositories the installer may be downloaded from. */
export const INSTALLER_HOSTS = new Set([
  "maven.minecraftforge.net",
  "maven.neoforged.net",
  "maven.fabricmc.net"
]);

export interface AiCommandPrepare {
  url: string;
  fileName: string;
  sha256: string;
}

export interface AiCommandRequest {
  command: unknown;
  timeoutMs?: unknown;
  prepare?: unknown;
}

export interface AiCommandResult {
  success: boolean;
  timedOut: boolean;
  error: string;
  output: string;
  platform: string;
}

export class AiCommandError extends Error {}

/** One printable line, bounded. */
export function validateAiCommand(value: unknown): string {
  const command = typeof value === "string" ? value.trim() : "";
  if (!command || command.length > MAX_AI_COMMAND_CHARS) {
    throw new AiCommandError("Invalid command");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(command)) throw new AiCommandError("Invalid command");
  return command;
}

export function validatePrepare(value: unknown): AiCommandPrepare | undefined {
  if (value == null) return undefined;
  const input = value as Record<string, unknown>;
  const url = typeof input.url === "string" ? input.url : "";
  const fileName = typeof input.fileName === "string" ? input.fileName : "";
  const sha256 = typeof input.sha256 === "string" ? input.sha256.trim().toLowerCase() : "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AiCommandError("Invalid installer URL");
  }
  if (parsed.protocol !== "https:" || !INSTALLER_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new AiCommandError("Invalid installer URL");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,120}\.jar$/.test(fileName)) {
    throw new AiCommandError("Invalid installer file name");
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new AiCommandError("Invalid checksum");
  return { url: parsed.toString(), fileName, sha256 };
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return hash.digest("hex");
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

/** Last lines of the captured output, without terminal escape codes. */
export function outputTail(text: string, lines = OUTPUT_LINES): string {
  return text
    .replace(ANSI, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim())
    .slice(-lines)
    .join("\n");
}

/** Downloads the official installer into the instance folder and checks its SHA-256. */
async function prepareInstaller(instance: Instance, prepare: AiCommandPrepare) {
  if (!(await checkSafeUrl(prepare.url))) throw new AiCommandError("Invalid installer URL");
  const fileManager = getFileManager(instance.instanceUuid);
  if (!fileManager.checkPath(prepare.fileName)) throw new AiCommandError("Invalid path");
  const target = fileManager.toAbsolutePath(prepare.fileName);
  await fs.remove(target);
  await downloadManager.downloadFromUrl(prepare.url, target);
  if (!(await fs.pathExists(target))) throw new AiCommandError("Installer download failed");
  const actual = await sha256File(target);
  if (actual !== prepare.sha256) {
    await fs.remove(target).catch(() => undefined);
    throw new AiCommandError("Installer checksum mismatch");
  }
}

/**
 * Runs one command in the instance folder through the update-command execution path, while
 * the instance is stopped. Resolves with the outcome and the end of the output.
 */
export async function runAiCommand(
  instance: Instance,
  request: AiCommandRequest
): Promise<AiCommandResult> {
  const command = validateAiCommand(request.command);
  const prepare = validatePrepare(request.prepare);
  const requestedTimeout = Number(request.timeoutMs) || MAX_AI_COMMAND_TIMEOUT_MS;
  const timeoutMs = Math.max(1000, Math.min(MAX_AI_COMMAND_TIMEOUT_MS, requestedTimeout));
  if (instance.status() !== Instance.STATUS_STOP) {
    throw new AiCommandError("Instance must be stopped");
  }
  if (instance.asynchronousTask) throw new AiCommandError("Another task is running");

  let output = "";
  const onData = (text: unknown) => {
    output += String(text ?? "");
    if (output.length > MAX_CAPTURED_OUTPUT) output = output.slice(-MAX_CAPTURED_OUTPUT);
  };
  // Created only once the installer (if any) is verified.
  let action: InstanceUpdateAction | undefined;
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  let error = "";

  instance.setLock(true);
  instance.status(Instance.STATUS_BUSY);
  instance.asynchronousTask = {
    exec: async () => undefined,
    stop: async () => {
      await action?.stop();
    }
  };
  instance.on("data", onData);
  try {
    if (prepare) await prepareInstaller(instance, prepare);
    logger.info(`[AI_COMMAND] instance=${instance.instanceUuid} command=${command}`);
    action = new InstanceUpdateAction(instance, command);
    await action.start();
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const started = action;
    const outcome = await Promise.race([started.wait().then(() => "done" as const), timeout]);
    if (outcome === "timeout") {
      timedOut = true;
      error = "Timed out";
      await started.stop();
    }
  } catch (err: any) {
    error = String(err?.message || err).slice(0, 300) || "Command failed";
  } finally {
    if (timer) clearTimeout(timer);
    instance.removeListener("data", onData);
    instance.asynchronousTask = undefined;
    instance.setLock(false);
    instance.status(Instance.STATUS_STOP);
  }
  return {
    success: !error,
    timedOut,
    error,
    output: outputTail(output),
    platform: os.platform()
  };
}
