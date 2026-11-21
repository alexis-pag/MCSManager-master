import { ChildProcessWithoutNullStreams, spawn, spawnSync } from "child_process";
import iconv from "iconv-lite";
import { killProcess } from "mcsmanager-common";
import os from "os";
import Instance from "../entity/instance/instance";
import { AiCommandError, outputTail, runAiCommand, validateAiCommand } from "./ai_command_runner";
import logger from "./log";

// Real shell (PowerShell / cmd on Windows, sh / bash elsewhere) for ADMINISTRATORS through the
// panel's AI assistant. The panel only sends it for administrators; it starts in the instance
// folder, runs on the daemon host, never changes the instance status, and is time-bounded.

export type AiShell = "powershell" | "cmd" | "sh" | "bash";

export const MAX_SHELL_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_SHELL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CAPTURED_OUTPUT = 64 * 1024;

const running = new Set<string>();

let oemCodePage: string | undefined;

/** Windows OEM code page used by cmd for piped output (e.g. "cp850" on French systems). */
export function windowsOemCodePage(): string {
  if (oemCodePage !== undefined) return oemCodePage;
  oemCodePage = "cp850";
  try {
    const out = spawnSync("cmd.exe", ["/d", "/c", "chcp"], { windowsHide: true, timeout: 5000 });
    const page = String(out.stdout || "").match(/(\d{3,5})/)?.[1];
    if (page && iconv.encodingExists(`cp${page}`)) oemCodePage = `cp${page}`;
  } catch {
    // keep the default
  }
  return oemCodePage;
}

/** UTF-8 when the bytes are valid UTF-8 (PowerShell, sh), else the Windows OEM code page (cmd). */
export function decodeShellOutput(bytes: Buffer, platform = os.platform()): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return platform === "win32"
      ? iconv.decode(bytes, windowsOemCodePage())
      : bytes.toString("latin1");
  }
}

export function availableShells(platform = os.platform()): AiShell[] {
  return platform === "win32" ? ["powershell", "cmd"] : ["sh", "bash"];
}

/** The shell to use: the requested one if available here, else the platform default. */
export function resolveShell(requested: unknown, platform = os.platform()): AiShell {
  const shells = availableShells(platform);
  if (requested == null || requested === "") return shells[0];
  const shell = String(requested).toLowerCase() as AiShell;
  if (!shells.includes(shell)) throw new AiCommandError(`Shell not available: ${shell}`);
  return shell;
}

/** Program and arguments; output is forced to UTF-8 so accents survive. */
export function shellInvocation(shell: AiShell, command: string) {
  if (shell === "powershell") {
    const script =
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
      "$OutputEncoding=[System.Text.Encoding]::UTF8;" +
      command;
    // -EncodedCommand (UTF-16LE base64) avoids every command-line quoting problem.
    return {
      file: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64")
      ],
      verbatim: false
    };
  }
  if (shell === "cmd") {
    // With /s, cmd strips the outer quotes and runs the rest exactly as written.
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", `"${command}"`],
      verbatim: true
    };
  }
  return { file: shell, args: ["-c", command], verbatim: false };
}

export interface AiShellResult {
  success: boolean;
  exitCode: number | null;
  timedOut: boolean;
  error: string;
  output: string;
  shell: AiShell;
  platform: string;
}

/** Docker instances: the command runs inside the instance's Linux container, not on the host. */
export function isDockerInstance(instance: Instance) {
  return instance.config?.processType === "docker";
}

/** `sh -c "<command>"` for the update path, quoting-proof (base64 only has safe characters). */
export function containerShellLine(shell: AiShell, command: string) {
  const encoded = Buffer.from(command, "utf-8").toString("base64");
  return `${shell} -c "echo ${encoded} | base64 -d | ${shell}"`;
}

interface ExecContainer {
  exec(options: Record<string, unknown>): Promise<{
    start(
      options: Record<string, unknown>
    ): Promise<NodeJS.ReadableStream & { destroy?: () => void }>;
    inspect(): Promise<{ ExitCode: number | null }>;
  }>;
  modem: { demuxStream(stream: any, stdout: any, stderr: any): void };
}

/** Runs the command in the running container of the instance (`docker exec`). */
export async function dockerExec(
  container: ExecContainer,
  shell: AiShell,
  command: string,
  workingDir: string | undefined,
  timeoutMs: number
) {
  const exec = await container.exec({
    Cmd: [shell, "-c", command],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    ...(workingDir ? { WorkingDir: workingDir } : {})
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  let captured = Buffer.alloc(0);
  const sink = {
    write(chunk: Buffer) {
      captured = Buffer.concat([captured, Buffer.from(chunk)]);
      if (captured.length > MAX_CAPTURED_OUTPUT) captured = captured.subarray(-MAX_CAPTURED_OUTPUT);
      return true;
    }
  };
  container.modem.demuxStream(stream, sink, sink);
  let timedOut = false;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      stream.destroy?.();
      resolve();
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", finish);
  });
  const exitCode = timedOut ? null : (await exec.inspect()).ExitCode;
  return { exitCode, timedOut, output: outputTail(decodeShellOutput(captured, "linux")) };
}

export async function runShellCommand(
  instance: Instance,
  request: { command: unknown; shell?: unknown; timeoutMs?: unknown }
): Promise<AiShellResult> {
  const command = validateAiCommand(request.command);
  const docker = isDockerInstance(instance);
  // Containers are Linux whatever the host is.
  const shell = resolveShell(request.shell, docker ? "linux" : os.platform());
  const timeoutMs = Math.max(
    1000,
    Math.min(MAX_SHELL_TIMEOUT_MS, Number(request.timeoutMs) || DEFAULT_SHELL_TIMEOUT_MS)
  );
  if (running.has(instance.instanceUuid)) {
    throw new AiCommandError("Another shell command is running");
  }
  if (docker) return runInContainer(instance, shell, command, timeoutMs);
  const { file, args, verbatim } = shellInvocation(shell, command);
  running.add(instance.instanceUuid);
  logger.info(`[AI_SHELL] instance=${instance.instanceUuid} shell=${shell} command=${command}`);

  // Raw bytes, decoded once at the end (keeps multi-byte characters split across chunks).
  let captured = Buffer.alloc(0);
  const append = (chunk: Buffer) => {
    captured = Buffer.concat([captured, chunk]);
    if (captured.length > MAX_CAPTURED_OUTPUT) captured = captured.subarray(-MAX_CAPTURED_OUTPUT);
  };
  try {
    return await new Promise<AiShellResult>((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      const done = (result: Omit<AiShellResult, "output" | "shell" | "platform">) =>
        resolve({
          ...result,
          output: outputTail(decodeShellOutput(captured)),
          shell,
          platform: os.platform()
        });
      try {
        child = spawn(file, args, {
          cwd: instance.absoluteCwdPath(),
          stdio: "pipe",
          windowsHide: true,
          windowsVerbatimArguments: verbatim
        });
      } catch (err: any) {
        return done({
          success: false,
          exitCode: null,
          timedOut: false,
          error: String(err?.message || err)
        });
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) killProcess(child.pid, child);
      }, timeoutMs);
      child.stdin.end();
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", (err) => {
        clearTimeout(timer);
        done({ success: false, exitCode: null, timedOut, error: String(err?.message || err) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done({
          success: !timedOut && code === 0,
          exitCode: code,
          timedOut,
          error: timedOut ? "Timed out" : code === 0 ? "" : `Exit code ${code}`
        });
      });
    });
  } finally {
    running.delete(instance.instanceUuid);
  }
}

/**
 * Docker instance: `docker exec` in its running container, or, when stopped, a one-off
 * container of the instance image (same path as the update command, instance folder mounted).
 */
async function runInContainer(
  instance: Instance,
  shell: AiShell,
  command: string,
  timeoutMs: number
): Promise<AiShellResult> {
  running.add(instance.instanceUuid);
  logger.info(
    `[AI_SHELL] instance=${instance.instanceUuid} docker shell=${shell} command=${command}`
  );
  const base = { shell, platform: "linux (docker)" };
  try {
    const container = (instance.process as any)?.container as ExecContainer | undefined;
    if (instance.status() === Instance.STATUS_RUNNING && container) {
      const rawDir = String(instance.config?.docker?.workingDir || "");
      const workingDir = rawDir ? await instance.parseTextParams(rawDir) : undefined;
      const result = await dockerExec(container, shell, command, workingDir, timeoutMs);
      return {
        ...base,
        ...result,
        success: !result.timedOut && result.exitCode === 0,
        error: result.timedOut
          ? "Timed out"
          : result.exitCode === 0
            ? ""
            : `Exit code ${result.exitCode}`
      };
    }
    if (instance.status() !== Instance.STATUS_STOP) {
      throw new AiCommandError("Instance is starting or stopping, try again");
    }
    const result = await runAiCommand(instance, {
      command: containerShellLine(shell, command),
      timeoutMs
    });
    return {
      ...base,
      success: result.success,
      exitCode: null,
      timedOut: result.timedOut,
      error: result.error,
      output: result.output
    };
  } finally {
    running.delete(instance.instanceUuid);
  }
}
