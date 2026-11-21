import { createHash } from "crypto";
import { AiInstanceScope } from "../entity/ai";
import { ROLE, User } from "../entity/user";
import { systemConfig } from "../setting";
import aiAccess from "./ai_access_service";
import {
  DEFAULT_CONSOLE_ALLOWLIST,
  InstanceOperation,
  InstanceSettingsPatch,
  normalizeConsoleAllowlist,
  parseInstanceCommand,
  parseSettingsPatch,
  validateAdminCommand,
  validateConsoleCommand
} from "./ai_command_parsing";
import { diffConfig } from "../common/config_diff";
import { isBinaryText, MAX_AI_FILE_READ_CHARS } from "./ai_file_edit";
import { LoaderError, LoaderHttp, defaultLoaderHttp, resolveLoaderInstall } from "./ai_mod_loader";
import { getInstanceNameSafely } from "./instance_name_service";
import { logger } from "./log";
import { operationLogger } from "./operation_logger";
import { isHaveInstance } from "./permission_service";
import RemoteRequest from "./remote_command";
import RemoteServiceSubsystem from "./remote_service";

// Command tools of the instance assistant. Every tool shows the exact command and runs it only
// after the user's "yes". The pending action only stores arguments of the same shape as the
// model's, so everything that is executed (URLs, checksums, update command) is recomputed here.

export const CONSOLE_COMMAND_TOOL = "send_console_command";
export const INSTANCE_COMMAND_TOOL = "run_instance_command";
export const UPDATE_INSTANCE_TOOL = "update_instance";
export const INSTALL_LOADER_TOOL = "install_mod_loader";
export const ADMIN_COMMAND_TOOL = "run_admin_command";
export const SETTINGS_TOOL = "update_instance_settings";
export const RESTART_TOOL = "restart_instance";
export const KILL_TOOL = "kill_instance";
export const READ_CONSOLE_TOOL = "read_console";
export const INSTANCE_INFO_TOOL = "get_instance_info";

/** Actions: shown to the user and run only after "yes" (worded by the panel). */
export const COMMAND_TOOLS = new Set([
  CONSOLE_COMMAND_TOOL,
  INSTANCE_COMMAND_TOOL,
  UPDATE_INSTANCE_TOOL,
  INSTALL_LOADER_TOOL,
  ADMIN_COMMAND_TOOL,
  SETTINGS_TOOL,
  RESTART_TOOL,
  KILL_TOOL
]);

/** Read-only diagnosis tools: results go back to the model, no confirmation. */
export const INSPECT_TOOLS = new Set([READ_CONSOLE_TOOL, INSTANCE_INFO_TOOL]);

const STATUS_LABELS: Record<string, string> = {
  "-1": "busy",
  "0": "stopped",
  "1": "stopping",
  "2": "starting",
  "3": "running"
};
const MAX_CONSOLE_LINES = 200;

const STATUS_STOP = 0;
const STATUS_RUNNING = 3;
const CONSOLE_WAIT_MS = 2000;
const MAX_OUTPUT_CHARS = 4000;
const MAX_OUTPUT_LINES = 40;
const LONG_TIMEOUT_MS = 16 * 60 * 1000;

// Administrators' real shell on the daemon machine.
export type AdminShell = "powershell" | "cmd" | "sh" | "bash";
const SHELL_TIMEOUT_MS = 10 * 60 * 1000;
const SHELL_LABELS: Record<AdminShell, string> = {
  powershell: "PowerShell",
  cmd: "cmd",
  sh: "sh",
  bash: "bash"
};
const SHELL_PROMPTS: Record<AdminShell, string> = {
  powershell: "PS>",
  cmd: "C:\\>",
  sh: "$",
  bash: "$"
};

/** Requested shell if the daemon's OS has it; default PowerShell on Windows, sh elsewhere. */
export function resolveAdminShell(requested: unknown, platform: string): AdminShell | null {
  const shells: AdminShell[] = platform === "win32" ? ["powershell", "cmd"] : ["sh", "bash"];
  if (requested == null || requested === "") return shells[0];
  const shell = String(requested).toLowerCase() as AdminShell;
  return shells.includes(shell) ? shell : null;
}

export type CommandKind = "console" | "file" | "update" | "loader" | "admin" | "restart" | "kill";

export interface CommandToolResult {
  tool: string;
  decision: "refused" | "approved" | "executed";
  data?: any;
  error?: string;
}

/** Stores the pending action, or returns true when it is the confirmed one. */
export type ConfirmFn = (tool: string, args: Record<string, unknown>) => boolean;

export function consoleAllowlist(): string[] {
  const configured = systemConfig?.aiConsoleCommandAllowlist;
  return Array.isArray(configured)
    ? normalizeConsoleAllowlist(configured)
    : [...DEFAULT_CONSOLE_ALLOWLIST];
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

/** Bounded, readable output (terminal codes removed, last lines kept). */
export function boundOutput(text: string, lines = MAX_OUTPUT_LINES) {
  const kept = String(text ?? "")
    .replace(ANSI, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim())
    .slice(-lines)
    .join("\n");
  return kept.length > MAX_OUTPUT_CHARS ? kept.slice(-MAX_OUTPUT_CHARS) : kept;
}

// Server jars by software, most specific first (installers and helper jars excluded).
const SERVER_JAR_PATTERNS = [
  /^(paper|purpur|folia|pufferfish|leaf|spigot|craftbukkit|mohist|arclight|catserver|magma|banner|youer)[-_.].*\.jar$/i,
  /^forge-[\d.]+-[\d.]+(-universal)?\.jar$/i,
  /^minecraft_server.*\.jar$/i,
  /^server\.jar$/i
];

/**
 * Start command from the files at the root of the instance folder (Fabric/Quilt launchers,
 * Bedrock, single server jar of any Java software). "" when it cannot be told.
 */
export function startCommandFromRoot(names: string[], platform: string): string {
  const has = (name: string) => names.some((file) => file.toLowerCase() === name);
  if (has("fabric-server-launch.jar")) return "java -jar fabric-server-launch.jar nogui";
  if (has("quilt-server-launch.jar")) return "java -jar quilt-server-launch.jar nogui";
  if (platform === "win32" && has("bedrock_server.exe")) return "bedrock_server.exe";
  if (platform !== "win32" && has("bedrock_server")) return "./bedrock_server";
  const jars = names.filter(
    (name) =>
      /\.jar$/i.test(name) && !/(installer|shim|sources|javadoc|client|launcher)/i.test(name)
  );
  for (const pattern of SERVER_JAR_PATTERNS) {
    const match = jars.filter((name) => pattern.test(name));
    if (match.length === 1) return `java -jar ${match[0]} nogui`;
  }
  return jars.length === 1 ? `java -jar ${jars[0]} nogui` : "";
}

const hashText = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);
const failure = (error: unknown) => String((error as any)?.message || error).slice(0, 200);

export class AiCommandTools {
  consoleWaitMs = CONSOLE_WAIT_MS;

  constructor(private readonly http: LoaderHttp = defaultLoaderHttp) {}

  async execute(
    user: User,
    tool: string,
    args: Record<string, any>,
    scope: AiInstanceScope | undefined,
    confirm: ConfirmFn
  ): Promise<CommandToolResult> {
    if (!scope) return { tool, decision: "refused", error: "No instance selected" };
    const base = {
      daemonId: scope.daemonId,
      instanceUuid: scope.instanceUuid,
      nickname: scope.nickname
    };
    const access = this.checkAccess(user, tool, scope);
    if (access) return { tool, decision: "refused", error: access, data: base };
    const remote = RemoteServiceSubsystem.getInstance(scope.daemonId);
    if (!remote?.available)
      return { tool, decision: "refused", error: "Daemon unavailable", data: base };
    const request = (event: string, data: Record<string, unknown> = {}, timeout = 15000) =>
      new RemoteRequest(remote).request(
        event,
        { instanceUuid: scope.instanceUuid, ...data },
        timeout
      );

    try {
      switch (tool) {
        case CONSOLE_COMMAND_TOOL:
          return await this.consoleCommand(user, tool, args, base, request, confirm);
        case INSTANCE_COMMAND_TOOL:
          return await this.instanceCommand(user, tool, args, base, request, confirm);
        case UPDATE_INSTANCE_TOOL:
          return await this.updateInstance(user, tool, args, base, request, confirm);
        case INSTALL_LOADER_TOOL:
          return await this.installLoader(user, tool, args, base, request, confirm);
        case ADMIN_COMMAND_TOOL:
          return await this.adminCommand(user, tool, args, base, request, confirm);
        case SETTINGS_TOOL:
          return await this.updateSettings(user, tool, args, base, request, confirm);
        case RESTART_TOOL:
        case KILL_TOOL:
          return await this.processAction(user, tool, args, base, request, confirm);
        case READ_CONSOLE_TOOL:
          return await this.readConsole(user, tool, args, base, request);
        case INSTANCE_INFO_TOOL:
          return await this.instanceInfo(user, tool, base, request);
      }
    } catch (error) {
      logger.warn(`[AI_COMMAND] ${tool} failed instance=${scope.instanceUuid}: ${failure(error)}`);
      return {
        tool,
        decision: "refused",
        error: "Command failed",
        data: { ...base, detail: failure(error) }
      };
    }
    return { tool, decision: "refused", error: "Tool not allowlisted" };
  }

  /** Checked when the command is proposed and again when it is executed. */
  private checkAccess(user: User, tool: string, scope: AiInstanceScope): string {
    if (!isHaveInstance(user, scope.daemonId, scope.instanceUuid)) return "Forbidden resource";
    if (!aiAccess.hasAccess(user)) return "AI access required";
    if ((tool === ADMIN_COMMAND_TOOL || tool === SETTINGS_TOOL) && user.permission < ROLE.ADMIN) {
      return "Administrator permission required";
    }
    if (
      tool === INSTANCE_COMMAND_TOOL &&
      systemConfig?.canFileManager === false &&
      user.permission < ROLE.ADMIN
    ) {
      return "File management is disabled";
    }
    return "";
  }

  private async detail(request: RequestFn) {
    const detail = await request("instance/detail");
    return {
      status: Number(detail?.status),
      updateCommand: String(detail?.config?.updateCommand || "").trim(),
      javaId: String(detail?.config?.java?.id || ""),
      type: String(detail?.config?.type || "")
    };
  }

  private async log(user: User, base: Base, kind: CommandKind, command: string, success: boolean) {
    operationLogger.log(
      "ai_instance_command",
      {
        operator_ip: "local-ai",
        operator_name: user.userName,
        instance_id: base.instanceUuid,
        daemon_id: base.daemonId,
        instance_name: await getInstanceNameSafely(base.daemonId, base.instanceUuid),
        kind,
        command: command.slice(0, 500),
        success
      },
      success ? "info" : "warning"
    );
    logger.info(
      `[AI_COMMAND] ${kind} user=${user.userName} instance=${base.instanceUuid} success=${success}: ${command.slice(0, 200)}`
    );
  }

  // ---- Console --------------------------------------------------------------------------

  private async consoleCommand(
    user: User,
    tool: string,
    args: Record<string, any>,
    base: Base,
    request: RequestFn,
    confirm: ConfirmFn
  ): Promise<CommandToolResult> {
    const allowlist = consoleAllowlist();
    const checked = validateConsoleCommand(args.command, allowlist);
    if ("error" in checked) {
      return { tool, decision: "refused", error: checked.error, data: { ...base, allowlist } };
    }
    const data = { ...base, kind: "console", display: checked.command };
    if ((await this.detail(request)).status !== STATUS_RUNNING) {
      return { tool, decision: "refused", error: "Instance not running", data };
    }
    if (!confirm(tool, { command: checked.command, confirmed: args.confirmed })) {
      return { tool, decision: "approved", data: { ...data, confirmationRequired: true } };
    }

    const before = String((await request("instance/outputlog").catch(() => "")) || "");
    await request("instance/command", { command: checked.command });
    await new Promise((resolve) => setTimeout(resolve, this.consoleWaitMs));
    const after = String((await request("instance/outputlog").catch(() => "")) || "");
    // Only what was printed after the command (the log may have been rotated meanwhile).
    const added = after.startsWith(before)
      ? after.slice(before.length)
      : after.slice(-MAX_OUTPUT_CHARS);
    await this.log(user, base, "console", checked.command, true);
    return {
      tool,
      decision: "executed",
      data: { ...data, output: boundOutput(added), success: true }
    };
  }

  // ---- Instance folder --------------------------------------------------------------------

  private async instanceCommand(
    user: User,
    tool: string,
    args: Record<string, any>,
    base: Base,
    request: RequestFn,
    confirm: ConfirmFn
  ): Promise<CommandToolResult> {
    const parsed = parseInstanceCommand(args.command, args.args);
    if ("error" in parsed) return { tool, decision: "refused", error: parsed.error, data: base };
    const data = { ...base, kind: "file", display: parsed.display, readOnly: parsed.readOnly };
    const workspace = await request("file/search", { mode: "workspace" });
    if (workspace?.diskRoot !== false) {
      return { tool, decision: "refused", error: "Instance folder is a disk root", data };
    }
    if (!confirm(tool, { command: parsed.name, args: parsed.args, confirmed: args.confirmed })) {
      return { tool, decision: "approved", data: { ...data, confirmationRequired: true } };
    }

    let output = "";
    let success = true;
    try {
      output = await this.runOperation(parsed.operation, request);
    } catch (error) {
      success = false;
      output = failure(error);
    }
    await this.log(user, base, "file", parsed.display, success);
    return success
      ? { tool, decision: "executed", data: { ...data, output, success } }
      : { tool, decision: "refused", error: "Command failed", data: { ...data, detail: output } };
  }

  private async pathType(request: RequestFn, target: string): Promise<string> {
    const stat = await request("file/search", { mode: "stat", target });
    return String(stat?.type || "missing");
  }

  /** Maps an operation to the daemon file routes; returns the text shown to the user. */
  async runOperation(operation: InstanceOperation, request: RequestFn): Promise<string> {
    switch (operation.kind) {
      case "list": {
        const listing = await request("file/list", {
          target: operation.path,
          page: 0,
          pageSize: 100,
          fileName: ""
        });
        const items = (Array.isArray(listing?.items) ? listing.items : [])
          .filter((item: any) => operation.all || !String(item?.name ?? "").startsWith("."))
          .map((item: any) => {
            const name = `${String(item?.name ?? "")}${item?.type === 0 ? "/" : ""}`;
            return operation.long && item?.type !== 0
              ? `${name}  ${Number(item?.size ?? 0)} B`
              : name;
          });
        const total = Number(listing?.total ?? items.length);
        return items.join("\n") + (total > 100 ? `\n… (${total - 100} more)` : "") || "(empty)";
      }
      case "read": {
        const text = await request("file/edit", { target: operation.path });
        const content = text === true ? "" : typeof text === "string" ? text : null;
        if (content === null) throw new Error("Not a text file");
        if (isBinaryText(content)) throw new Error("Binary file");
        // A final newline does not start another line (as with head, tail and wc -l).
        const lines = content ? content.replace(/\r?\n$/, "").split(/\r?\n/) : [];
        if (operation.mode === "wc") {
          const words = content.split(/\s+/).filter(Boolean).length;
          return `${lines.length} lines, ${words} words, ${content.length} chars`;
        }
        if (operation.mode === "head") return lines.slice(0, operation.lines).join("\n");
        if (operation.mode === "tail") return lines.slice(-operation.lines).join("\n");
        return content.length > MAX_AI_FILE_READ_CHARS
          ? `${content.slice(0, MAX_AI_FILE_READ_CHARS)}\n… (truncated)`
          : content;
      }
      case "search": {
        const result = await request("file/search", {
          mode: operation.mode,
          target: operation.target,
          pattern: operation.pattern,
          ignoreCase: operation.ignoreCase,
          recursive: operation.recursive
        });
        const more = result?.truncated ? "\n… (limit reached)" : "";
        if (operation.mode === "du") {
          return `${Number(result?.bytes ?? 0)} B in ${Number(result?.files ?? 0)} files (${result?.path})${more}`;
        }
        if (operation.mode === "find") {
          const rows = (result?.results || []).map((item: any) => String(item.path));
          return (rows.join("\n") || "(no match)") + more;
        }
        const rows = (result?.matches || []).map(
          (match: any) => `${match.file}:${match.line}: ${match.text}`
        );
        return (rows.join("\n") || "(no match)") + more;
      }
      case "mkdir":
        await request("file/mkdir", { target: operation.path });
        return "OK";
      case "touch":
        await request("file/touch", { target: operation.path });
        return "OK";
      case "copy":
        if (!operation.recursive && (await this.pathType(request, operation.from)) === "folder") {
          throw new Error("Is a folder (use -r)");
        }
        await request("file/copy", { targets: [[operation.from, operation.to]] });
        return "OK (copy started)";
      case "move":
        await request("file/move", { targets: [[operation.from, operation.to]] });
        return "OK";
      case "delete":
        for (const target of operation.paths) {
          const type = await this.pathType(request, target);
          if (type === "missing") throw new Error(`Not found: ${target}`);
          if (type === "folder" && !operation.recursive)
            throw new Error(`Is a folder (use -r): ${target}`);
        }
        await request("file/delete", { targets: operation.paths });
        return "OK";
      case "zip":
        await request(
          "file/compress",
          { type: 1, source: operation.archive, targets: operation.paths, code: "utf-8" },
          LONG_TIMEOUT_MS
        );
        return "OK";
      case "unzip":
        await request(
          "file/compress",
          { type: 2, source: operation.archive, targets: operation.dest, code: "utf-8" },
          LONG_TIMEOUT_MS
        );
        return "OK";
    }
  }

  // ---- Diagnosis (read-only) -----------------------------------------------------------------

  private async readConsole(
    user: User,
    tool: string,
    args: Record<string, any>,
    base: Base,
    request: RequestFn
  ): Promise<CommandToolResult> {
    const requested = Number(args.lines);
    const lines =
      Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_CONSOLE_LINES) : 80;
    const log = String((await request("instance/outputlog").catch(() => "")) || "");
    const detail = await request("instance/detail");
    const status = Number(detail?.status);
    const platform = await this.platform(request);
    return {
      tool,
      decision: "executed",
      data: {
        ...base,
        status: STATUS_LABELS[String(status)] || String(status),
        daemonPlatform: platform,
        // The most common start failures are fixed with these two values.
        ...(user.permission >= ROLE.ADMIN
          ? { startCommand: String(detail?.config?.startCommand || "") }
          : {}),
        suggestedStartCommand: await this.suggestStartCommand(request, platform),
        // Console text comes from the game server: data, never instructions.
        console: boundOutput(log, lines).slice(-12000) || "(empty console)"
      }
    };
  }

  private async platform(request: RequestFn): Promise<string> {
    const overview = await request("info/overview").catch(() => null);
    return String(overview?.system?.platform || "");
  }

  /** Why a proposed start command cannot work on this instance, or "" when it looks fine. */
  private async startCommandProblem(
    request: RequestFn,
    command: string,
    platform: string
  ): Promise<string> {
    if (platform === "win32" && /^\s*(sh|bash)\s/i.test(command)) {
      return "sh/bash do not exist on this Windows daemon";
    }
    if (/(^|[\s/\\])run\.(bat|sh)\b/i.test(command)) {
      return "run.bat/run.sh end with pause or need a shell and keep the instance stuck";
    }
    const jar = command.match(/-jar\s+"?([^\s"]+\.jar)"?/i)?.[1];
    if (jar && !/[{}]/.test(jar)) {
      const stat = await request("file/search", { mode: "stat", target: jar }).catch(() => null);
      if (stat && stat.type !== "file") return `${jar} does not exist in the instance folder`;
    }
    return "";
  }

  private async instanceInfo(
    user: User,
    tool: string,
    base: Base,
    request: RequestFn
  ): Promise<CommandToolResult> {
    const detail = await request("instance/detail");
    const config = detail?.config || {};
    const overview = await request("info/overview").catch(() => null);
    const info: Record<string, unknown> = {
      ...base,
      status: STATUS_LABELS[String(detail?.status)] || String(detail?.status),
      type: String(config.type || ""),
      processType: String(config.processType || ""),
      daemonPlatform: String(overview?.system?.platform || ""),
      autoRestart: Boolean(config.eventTask?.autoRestart),
      minecraftVersion: String(detail?.info?.version || "")
    };
    if (user.permission >= ROLE.ADMIN) {
      const javas = await request("java_manager/list").catch(() => []);
      Object.assign(info, {
        startCommand: String(config.startCommand || ""),
        stopCommand: String(config.stopCommand || ""),
        updateCommand: String(config.updateCommand || ""),
        ie: String(config.ie || ""),
        oe: String(config.oe || ""),
        crlf: Number(config.crlf || 0),
        stopTimeout: Number(config.stopTimeout || 0),
        javaId: String(config.java?.id || ""),
        dockerImage: String(config.docker?.image || ""),
        availableJavas: (Array.isArray(javas) ? javas : [])
          .map((java: any) => String(java?.info?.fullname || ""))
          .filter(Boolean)
          .slice(0, 30)
      });
    }
    info.suggestedStartCommand = await this.suggestStartCommand(
      request,
      String(info.daemonPlatform)
    );
    return { tool, decision: "executed", data: info };
  }

  /**
   * Start command derived from the installed files (modern Forge/NeoForge args files, Fabric
   * launcher), so the model never has to guess a version folder. "" when unknown.
   */
  async suggestStartCommand(request: RequestFn, platform: string): Promise<string> {
    const argsFile = platform === "win32" ? "win_args.txt" : "unix_args.txt";
    try {
      const found = await request("file/search", {
        mode: "find",
        target: "/libraries",
        pattern: argsFile
      });
      const paths = (Array.isArray(found?.results) ? found.results : [])
        .map((item: any) => String(item?.path || ""))
        .filter((path: string) => /^libraries\/net\/(minecraftforge|neoforged)\//.test(path))
        .sort((a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }));
      if (paths.length) return `java @user_jvm_args.txt @${paths[paths.length - 1]} nogui`;
    } catch {
      // no libraries folder
    }
    try {
      const listing = await request("file/list", {
        target: "/",
        page: 0,
        pageSize: 100,
        fileName: ""
      });
      const names = (Array.isArray(listing?.items) ? listing.items : [])
        .filter((item: any) => item?.type !== 0)
        .map((item: any) => String(item?.name || ""));
      return startCommandFromRoot(names, platform);
    } catch {
      return "";
    }
  }

  // ---- Instance settings, restart, kill -----------------------------------------------------

  private async updateSettings(
    user: User,
    tool: string,
    args: Record<string, any>,
    base: Base,
    request: RequestFn,
    confirm: ConfirmFn
  ): Promise<CommandToolResult> {
    const parsed = parseSettingsPatch(args);
    if ("error" in parsed) return { tool, decision: "refused", error: parsed.error, data: base };
    const patch = parsed.patch;
    if (patch.javaId) {
      const javas = await request("java_manager/list");
      const known = (Array.isArray(javas) ? javas : []).some(
        (java: any) => java?.info?.fullname === patch.javaId
      );
      if (!known) return { tool, decision: "refused", error: "Unknown Java", data: base };
    }
    if (patch.startCommand) {
      const platform = await this.platform(request);
      const problem = await this.startCommandProblem(request, patch.startCommand, platform);
      if (problem) {
        // Returned to the model with the panel's suggestion so it can correct itself.
        return {
          tool,
          decision: "refused",
          error: "Start command cannot work",
          data: {
            ...base,
            detail: problem,
            suggestedStartCommand: await this.suggestStartCommand(request, platform)
          }
        };
      }
    }
    const before = (await request("instance/detail"))?.config || {};
    const current = settingsOf(before);
    const changes = (Object.keys(patch) as Array<keyof InstanceSettingsPatch>)
      .filter((field) => current[field] !== patch[field])
      .map((field) => ({ field, before: current[field], after: patch[field] }));
    if (!changes.length) return { tool, decision: "refused", error: "No change", data: base };
    const display = changes
      .map((change) => `${change.field}: ${show(change.before)}  →  ${show(change.after)}`)
      .join("\n");
    const data = { ...base, kind: "settings", display };
    if (!confirm(tool, { ...patch, confirmed: args.confirmed })) {
      return { tool, decision: "approved", data: { ...data, confirmationRequired: true } };
    }
    const { javaId, autoRestart, ...plain } = patch;
    await request("instance/update", {
      config: {
        ...plain,
        ...(javaId !== undefined ? { java: { id: javaId } } : {}),
        ...(autoRestart !== undefined ? { eventTask: { autoRestart } } : {})
      }
    });
    const after = (await request("instance/detail"))?.config || {};
    const diff = diffConfig(before, after);
    if (diff) {
      operationLogger.log(
        "instance_config_change",
        {
          operator_ip: "local-ai",
          operator_name: user.userName,
          daemon_id: base.daemonId,
          instance_id: base.instanceUuid,
          instance_name: String(after?.nickname || before?.nickname || ""),
          config_before: diff.before,
          config_after: diff.after
        },
        "warning"
      );
    }
    logger.info(`[AI_COMMAND] settings user=${user.userName} instance=${base.instanceUuid}`);
    return { tool, decision: "executed", data: { ...data, success: true } };
  }

  private async processAction(
    user: User,
    tool: string,
    args: Record<string, any>,
    base: Base,
    request: RequestFn,
    confirm: ConfirmFn
  ): Promise<CommandToolResult> {
    const kind = tool === RESTART_TOOL ? "restart" : "kill";
    const data = { ...base, kind, display: kind === "restart" ? "restart" : "kill" };
    if (!confirm(tool, { confirmed: args.confirmed })) {
      return { tool, decision: "approved", data: { ...data, confirmationRequired: true } };
    }
    await request(kind === "restart" ? "instance/restart" : "instance/kill", {
      instanceUuids: [base.instanceUuid]
    });
    await this.log(user, base, kind, kind, true);
    return { tool, decision: "executed", data: { ...data, success: true } };
  }

  // ---- Update, installer, administrator command -------------------------------------------

  private async runOnDaemon(
    request: RequestFn,
    command: string,
    prepare?: { url: string; fileName: string; sha256: string }
  ) {
    const result = await request("instance/ai_command", { command, prepare }, LONG_TIMEOUT_MS);
    return {
      success: Boolean(result?.success),
      timedOut: Boolean(result?.timedOut),
      error: String(result?.error || ""),
      output: boundOutput(String(result?.output || "")),
      platform: String(result?.platform || "")
    };
  }

  private async updateInstance(
    user: User,
    tool: string,
    args: Record<string, any>,
    base: Base,
    request: RequestFn,
    confirm: ConfirmFn
  ): Promise<CommandToolResult> {
    const detail = await this.detail(request);
    const data = { ...base, kind: "update", display: detail.updateCommand };
    if (!detail.updateCommand)
      return { tool, decision: "refused", error: "No update command", data };
    if (detail.status !== STATUS_STOP)
      return { tool, decision: "refused", error: "Instance must be stopped", data };
    // The hash ties the "yes" to the update command that was shown.
    if (
      !confirm(tool, { commandHash: hashText(detail.updateCommand), confirmed: args.confirmed })
    ) {
      return { tool, decision: "approved", data: { ...data, confirmationRequired: true } };
    }
    const result = await this.runOnDaemon(request, detail.updateCommand);
    await this.log(user, base, "update", detail.updateCommand, result.success);
    return this.processResult(tool, data, result);
  }

  private async installLoader(
    user: User,
    tool: string,
    args: Record<string, any>,
    base: Base,
    request: RequestFn,
    confirm: ConfirmFn
  ): Promise<CommandToolResult> {
    let install;
    try {
      install = await resolveLoaderInstall(
        {
          loader: args.loader,
          minecraftVersion: args.minecraftVersion,
          loaderVersion: args.loaderVersion
        },
        this.http
      );
    } catch (error) {
      const reason = error instanceof LoaderError ? error.message : "Loader metadata unavailable";
      if (!(error instanceof LoaderError)) {
        logger.warn(`[AI_COMMAND] Loader metadata failed: ${failure(error)}`);
      }
      return { tool, decision: "refused", error: reason, data: { ...base, kind: "loader" } };
    }
    const detail = await this.detail(request);
    // Forge/NeoForge/Fabric are Minecraft Java servers: refused for Bedrock, Steam games...
    if (detail.type && !detail.type.startsWith("minecraft/java") && detail.type !== "universal") {
      return {
        tool,
        decision: "refused",
        error: "Not a Minecraft Java instance",
        data: { ...base, kind: "loader", type: detail.type }
      };
    }
    const java = detail.javaId ? '"{mcsm_java}"' : "java";
    const command = [java, "-jar", install.fileName, ...install.installArgs].join(" ");
    const data = {
      ...base,
      kind: "loader",
      display: command,
      loader: install.loader,
      minecraftVersion: install.minecraftVersion,
      loaderVersion: install.loaderVersion,
      source: install.url
    };
    if (detail.status !== STATUS_STOP)
      return { tool, decision: "refused", error: "Instance must be stopped", data };
    const pending = {
      loader: install.loader,
      minecraftVersion: install.minecraftVersion,
      loaderVersion: install.loaderVersion,
      confirmed: args.confirmed
    };
    if (!confirm(tool, pending)) {
      return { tool, decision: "approved", data: { ...data, confirmationRequired: true } };
    }
    const result = await this.runOnDaemon(request, command, {
      url: install.url,
      fileName: install.fileName,
      sha256: install.sha256
    });
    await this.log(user, base, "loader", command, result.success);
    const startCommand =
      result.platform === "win32" ? install.startCommand.windows : install.startCommand.other;
    return this.processResult(tool, { ...data, startCommand }, result);
  }

  private async adminCommand(
    user: User,
    tool: string,
    args: Record<string, any>,
    base: Base,
    request: RequestFn,
    confirm: ConfirmFn
  ): Promise<CommandToolResult> {
    const command = validateAdminCommand(args.command);
    if (!command) return { tool, decision: "refused", error: "Invalid command", data: base };
    // The daemon's OS decides which shells exist (PowerShell/cmd on Windows, sh/bash elsewhere).
    // Docker instances run the command inside their Linux container (sh/bash), whatever the
    // host; other instances use the daemon machine's shells.
    const docker = (await request("instance/detail"))?.config?.processType === "docker";
    const platform = docker ? "linux" : await this.platform(request);
    const shell = resolveAdminShell(args.shell, platform);
    if (!shell) {
      return {
        tool,
        decision: "refused",
        error: "Shell not available",
        data: { ...base, platform, docker }
      };
    }
    const data = {
      ...base,
      kind: "admin",
      shell,
      docker,
      shellLabel: docker ? `${SHELL_LABELS[shell]} (Docker)` : SHELL_LABELS[shell],
      display: `${SHELL_PROMPTS[shell]} ${command}`
    };
    if (!confirm(tool, { command, shell, confirmed: args.confirmed })) {
      return { tool, decision: "approved", data: { ...data, confirmationRequired: true } };
    }
    const result = await request(
      "instance/ai_shell",
      { command, shell, timeoutMs: SHELL_TIMEOUT_MS },
      SHELL_TIMEOUT_MS + 60000
    );
    const outcome = {
      success: Boolean(result?.success),
      timedOut: Boolean(result?.timedOut),
      error: String(result?.error || ""),
      output: boundOutput(String(result?.output || ""))
    };
    await this.log(user, base, "admin", `${SHELL_LABELS[shell]}: ${command}`, outcome.success);
    return this.processResult(tool, data, outcome);
  }

  private processResult(
    tool: string,
    data: Record<string, unknown>,
    result: { success: boolean; timedOut: boolean; error: string; output: string }
  ): CommandToolResult {
    const full = {
      ...data,
      output: result.output,
      success: result.success,
      timedOut: result.timedOut
    };
    return result.success
      ? { tool, decision: "executed", data: full }
      : {
          tool,
          decision: "refused",
          error: result.timedOut ? "Timed out" : "Command failed",
          data: { ...full, detail: result.error }
        };
  }
}

/** Current values of the editable settings, in the patch's vocabulary. */
function settingsOf(config: any): InstanceSettingsPatch {
  return {
    startCommand: String(config?.startCommand ?? ""),
    stopCommand: String(config?.stopCommand ?? ""),
    updateCommand: String(config?.updateCommand ?? ""),
    ie: String(config?.ie ?? ""),
    oe: String(config?.oe ?? ""),
    crlf: Number(config?.crlf ?? 0),
    stopTimeout: Number(config?.stopTimeout ?? 0),
    autoRestart: Boolean(config?.eventTask?.autoRestart),
    javaId: String(config?.java?.id ?? "")
  };
}

const show = (value: unknown) => (value === "" || value === undefined ? "(empty)" : String(value));

type Base = { daemonId: string; instanceUuid: string; nickname?: string };
type RequestFn = (event: string, data?: Record<string, unknown>, timeout?: number) => Promise<any>;

export default new AiCommandTools();
