import { createHash } from "crypto";
import { ROLE, User } from "../entity/user";
import { logger } from "./log";
import RemoteRequest from "./remote_command";
import RemoteServiceSubsystem from "./remote_service";
import { isHaveInstance } from "./permission_service";
import userSystem from "./user_service";
import { getAppMarketList } from "./instance_service";
import { getInstanceNameSafely } from "./instance_name_service";
import { operationLogger } from "./operation_logger";
import { systemConfig } from "../setting";
import { AiInstanceScope } from "../entity/ai";
import { modManagerService } from "./mod_manager_service";
import { checkSafeUrl } from "../utils/url";
import {
  CandidateVersion,
  detectServerProfile,
  findInstalledCopies,
  installKind,
  isAllowedDownloadUrl,
  pickVersion,
  projectNameFromFile,
  safeJarFileName,
  ServerProfile,
  SUPPORTED_SOURCES
} from "./ai_plugin_tools";
import {
  applyEdits,
  buildDiffPreview,
  contentHash,
  isBinaryText,
  MAX_AI_FILE_READ_CHARS,
  MAX_AI_FILE_WRITE_CHARS,
  normalizeInstancePath,
  parseEdits
} from "./ai_file_edit";
import aiCommandTools, {
  ADMIN_COMMAND_TOOL,
  COMMAND_TOOLS,
  INSPECT_TOOLS,
  INSTANCE_INFO_TOOL,
  KILL_TOOL,
  READ_CONSOLE_TOOL,
  RESTART_TOOL,
  SETTINGS_TOOL,
  CONSOLE_COMMAND_TOOL,
  consoleAllowlist,
  INSTALL_LOADER_TOOL,
  INSTANCE_COMMAND_TOOL,
  UPDATE_INSTANCE_TOOL
} from "./ai_command_tools";

export type AiToolDecision = "refused" | "approved" | "executed";

export interface AiToolResult {
  tool: string;
  decision: AiToolDecision;
  data?: any;
  error?: string;
}

export const CREATE_TOOL = "create_instance_from_template";
export const LIST_TEMPLATES_TOOL = "list_instance_templates";
export const LIST_FILES_TOOL = "list_instance_files";
export const READ_FILE_TOOL = "read_instance_file";
export const EDIT_FILE_TOOL = "edit_instance_file";
export const SEARCH_PLUGINS_TOOL = "search_plugins";
export const INSTALL_PLUGIN_TOOL = "install_plugin";

/** Server-side context of a tool call. Never derived from model arguments. */
export interface AiToolContext {
  instanceScope?: AiInstanceScope;
  /** Scheduled runs: only tools that read data exist; anything else is refused. */
  readOnly?: boolean;
}

/** Tools that never change an instance, its files, or the panel. */
export const READ_ONLY_TOOLS = new Set([LIST_FILES_TOOL, READ_FILE_TOOL, SEARCH_PLUGINS_TOOL]);

// A confirmation only authorizes the exact pending action, and only for a short time.
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_CONFIRMATIONS = 1000;
const MAX_LISTED_TEMPLATES = 20;

const createDeclaration = {
  type: "function",
  function: {
    name: CREATE_TOOL,
    description:
      "Prepare creation of a new instance (Minecraft, Terraria, Palworld, Rust, ARK, Factorio or any other game) " +
      "from one template of the MCSManager marketplace catalogue. Administrator only. Call this tool on a direct " +
      "creation request without asking first: it validates the template and daemon and then asks the user to " +
      "confirm. Nothing is created before that confirmation.",
    parameters: {
      type: "object",
      properties: {
        templateId: {
          type: "string",
          description: "Exact templateId copied from the trusted catalogue options."
        },
        daemonId: {
          type: "string",
          description:
            "Exact daemonId from availableDaemons. May be omitted when only one daemon is online."
        },
        nickname: {
          type: "string",
          description: "Name of the new instance. Defaults to the template title."
        }
      },
      required: ["templateId"]
    }
  }
} as const;

const fileDeclarations = [
  {
    type: "function",
    function: {
      name: LIST_FILES_TOOL,
      description:
        "List files and folders of the instance this conversation is about. Paths are relative to the instance directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: 'Folder to list, for example "/" or "/plugins".' }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: READ_FILE_TOOL,
      description:
        "Read a text file of the instance this conversation is about. Always read a file before editing it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: 'File path, for example "/server.properties".' },
          offset: { type: "number", description: "Character offset for long files." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: EDIT_FILE_TOOL,
      description:
        "Propose a change to a text file of the instance this conversation is about. Prefer `edits` with exact " +
        "text copied from the file (each `find` must appear exactly once). Use `content` only to create a new " +
        "file or replace a small file entirely. Nothing is written before the user confirms the shown preview.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: { find: { type: "string" }, replace: { type: "string" } },
              required: ["find", "replace"]
            }
          },
          content: {
            type: "string",
            description: "Full new file content (new or small files only)."
          }
        },
        required: ["path"]
      }
    }
  }
] as const;

const declarations = [
  {
    type: "function",
    function: {
      name: "start_instance",
      description: "Start an existing instance the current user is allowed to operate.",
      parameters: {
        type: "object",
        properties: { daemonId: { type: "string" }, instanceUuid: { type: "string" } },
        required: ["daemonId", "instanceUuid"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "stop_instance",
      description: "Stop an existing allowed instance. Ask the user to confirm before calling.",
      parameters: {
        type: "object",
        properties: {
          daemonId: { type: "string" },
          instanceUuid: { type: "string" },
          confirmed: {
            type: "boolean",
            description: "True only after the user confirmed in a later message."
          }
        },
        required: ["daemonId", "instanceUuid"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_accessible_instances",
      description: "List only the instances assigned to the current user.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: LIST_TEMPLATES_TOOL,
      description:
        "List instance templates (all games) of the MCSManager marketplace catalogue and online daemons. " +
        "Administrator only. Optionally filter with a search text such as a game name or version.",
      parameters: {
        type: "object",
        properties: { search: { type: "string" } }
      }
    }
  },
  createDeclaration
] as const;

function validString(value: unknown, maxLength = 128): string | null {
  if (typeof value !== "string") return null;
  const valueTrimmed = value.trim();
  if (!valueTrimmed || valueTrimmed.length > maxLength) return null;
  if (/[\u0000-\u001f\u007f]/.test(valueTrimmed)) return null;
  return valueTrimmed;
}

export function templateIdOf(template: { title?: unknown; description?: unknown }): string {
  return createHash("sha256")
    .update(`${String(template.title ?? "")}\n${String(template.description ?? "")}`)
    .digest("hex")
    .slice(0, 12);
}

function searchTerms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.:_-]*/gu) || [])
    .filter((term) => term.length >= 3 || /\d/.test(term))
    .slice(0, 30);
}

const IGNORED_SEARCH_TERMS = new Set([
  "crée",
  "créer",
  "creer",
  "cree",
  "create",
  "server",
  "serveur",
  "instance",
  "une",
  "moi",
  "pour",
  "avec",
  "the",
  "new",
  "nouveau",
  "nouvelle",
  "version",
  "installe",
  "installer",
  "install",
  "fais",
  "faire",
  "make",
  "build",
  "please",
  "stp",
  "svp"
]);

interface PendingConfirmation {
  tool: string;
  args: Record<string, unknown>;
  context: AiToolContext;
  createdAt: number;
}

// Tools whose pending action is executed by the panel itself on an explicit "yes".
const PANEL_CONFIRMED_TOOLS = new Set([
  CREATE_TOOL,
  EDIT_FILE_TOOL,
  INSTALL_PLUGIN_TOOL,
  "stop_instance",
  ...COMMAND_TOOLS
]);

// A conversation bound to an instance is dedicated to it: only these tools exist there, and
// start/stop always target the bound instance (IDs are never taken from the model).
const SCOPED_TOOLS = new Set([
  SEARCH_PLUGINS_TOOL,
  INSTALL_PLUGIN_TOOL,
  "start_instance",
  "stop_instance",
  LIST_FILES_TOOL,
  READ_FILE_TOOL,
  EDIT_FILE_TOOL,
  ...COMMAND_TOOLS,
  ...INSPECT_TOOLS
]);
const pluginDeclarations = [
  {
    type: "function",
    function: {
      name: SEARCH_PLUGINS_TOOL,
      description:
        "Search plugins (or mods on Fabric/Forge servers) in the MCSManager plugin sources. The panel " +
        "detects this server's software and Minecraft version itself and reports compatibility.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: 'Plugin name, e.g. "ViaVersion".' } },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: INSTALL_PLUGIN_TOOL,
      description:
        "Install a plugin or mod found with search_plugins. The panel picks the newest version " +
        "compatible with this server, shows it to the user and installs it only after confirmation.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "projectId from search_plugins." },
          source: { type: "string", description: 'source from search_plugins, e.g. "Modrinth".' },
          versionId: {
            type: "string",
            description: "Only when the user asked for a specific version."
          }
        },
        required: ["projectId", "source"]
      }
    }
  }
] as const;

const scopedInstanceDeclarations = [
  {
    type: "function",
    function: {
      name: "start_instance",
      description: "Start this instance.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "stop_instance",
      description: "Stop this instance. The panel asks the user to confirm first.",
      parameters: { type: "object", properties: {} }
    }
  }
] as const;

/** Command tools of the instance assistant (the console allowlist is read at call time). */
function commandDeclarations(isAdmin: boolean) {
  const allowlist = consoleAllowlist();
  const list: any[] = [
    {
      type: "function",
      function: {
        name: READ_CONSOLE_TOOL,
        description:
          "Read the last lines of this instance's console (start errors, crashes, stack traces). " +
          "Call it first whenever something is wrong. Read-only, no confirmation.",
        parameters: {
          type: "object",
          properties: { lines: { type: "number", description: "1-200, default 80." } }
        }
      }
    },
    {
      type: "function",
      function: {
        name: INSTANCE_INFO_TOOL,
        description:
          "Get this instance's status, type, daemon OS and (for administrators) its start, stop " +
          "and update commands, encodings, Java and the Java runtimes available. Read-only.",
        parameters: { type: "object", properties: {} }
      }
    },
    {
      type: "function",
      function: {
        name: RESTART_TOOL,
        description: "Restart this instance. The panel asks the user first.",
        parameters: { type: "object", properties: {} }
      }
    },
    {
      type: "function",
      function: {
        name: KILL_TOOL,
        description:
          "Force-stop this instance when it is stuck and a normal stop does not work. The panel " +
          "asks the user first.",
        parameters: { type: "object", properties: {} }
      }
    },
    {
      type: "function",
      function: {
        name: CONSOLE_COMMAND_TOOL,
        description:
          "Send one command to this instance's server console while it is running, for example " +
          "`list` or `say Hello`. Only these non-administrator commands are accepted: " +
          (allowlist.length ? allowlist.join(", ") : "none") +
          ". Never propose administrator commands (op, ban, stop, gamemode, give, plugin admin " +
          "commands...). The panel shows the command, asks the user, then shows the console output.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "One command, without line breaks." }
          },
          required: ["command"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: INSTANCE_COMMAND_TOOL,
        description:
          "Run one file command in this instance's folder. It is not a shell: no pipes, " +
          "redirections, variables, sudo, or paths outside the instance folder. Commands: " +
          "ls [-a] [-l] [path]; cat path; head|tail [-n N] path; wc [-l] path; " +
          "grep [-i] [-r] text [path] (plain text, -r for folders); find [path] -name glob; " +
          "du [path]; mkdir path; touch path; cp [-r] src dest; mv src dest; " +
          "rm [-r] [-f] path...; zip archive.zip path...; unzip archive.zip [dest]. " +
          "Paths are relative to the instance folder. The panel asks the user before running it.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: 'Command name, e.g. "grep".' },
            args: {
              type: "array",
              items: { type: "string" },
              description: 'Options and operands, e.g. ["-i", "error", "logs/latest.log"].'
            }
          },
          required: ["command", "args"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: UPDATE_INSTANCE_TOOL,
        description:
          "Run this instance's update command exactly as configured by an administrator (for " +
          "example a Forge installer). The instance must be stopped. The panel asks the user first.",
        parameters: { type: "object", properties: {} }
      }
    },
    {
      type: "function",
      function: {
        name: INSTALL_LOADER_TOOL,
        description:
          "Install the Forge, NeoForge or Fabric server on this instance. The panel downloads the " +
          "official installer, verifies its checksum and runs it in the instance folder (like " +
          "`java -jar forge-<version>-installer.jar --installServer`), then gives the start " +
          "command to use. Use it instead of telling the user to open a terminal. The instance " +
          "must be stopped. The panel asks the user first.",
        parameters: {
          type: "object",
          properties: {
            loader: { type: "string", enum: ["forge", "neoforge", "fabric"] },
            minecraftVersion: { type: "string", description: 'e.g. "1.21.1" or "26.3".' },
            loaderVersion: {
              type: "string",
              description: "Only when the user asked for a specific loader version."
            }
          },
          required: ["loader", "minecraftVersion"]
        }
      }
    }
  ];
  if (isAdmin) {
    list.push({
      type: "function",
      function: {
        name: SETTINGS_TOOL,
        description:
          "Administrator only: change this instance's settings, for example a start command that " +
          "cannot work (`sh ./run.sh` on Windows), the stop command, the update command, the " +
          "console encodings (ie/oe), line endings (crlf 1 = LF, 2 = CRLF), the stop timeout, " +
          "automatic restart, or the Java runtime (javaId from get_instance_info). Give only the " +
          "fields to change. The panel shows old and new values and asks the user first.",
        parameters: {
          type: "object",
          properties: {
            startCommand: { type: "string" },
            stopCommand: { type: "string" },
            updateCommand: { type: "string" },
            ie: { type: "string" },
            oe: { type: "string" },
            crlf: { type: "number", enum: [1, 2] },
            stopTimeout: { type: "number" },
            autoRestart: { type: "boolean" },
            javaId: { type: "string" }
          }
        }
      }
    });
    list.push({
      type: "function",
      function: {
        name: ADMIN_COMMAND_TOOL,
        description:
          "Administrator only: run a command in a real shell on the daemon machine, starting in " +
          "this instance's folder: PowerShell (default) or cmd on Windows, sh or bash on Linux; " +
          "for a Docker instance, sh or bash inside its container. " +
          "Pipes, redirections and shell syntax work. Works whether the server runs or not. Use " +
          "it for anything the other tools do not cover, for example `java -jar " +
          "forge-26.3-66.1.9-installer.jar --installServer`, `Get-ChildItem`, `dir` or " +
          "`Get-Content logs\\latest.log -Tail 50`. One line, no interactive programs. The panel " +
          "shows the command and asks the user first.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "One line in the chosen shell's syntax." },
            shell: {
              type: "string",
              enum: ["powershell", "cmd", "sh", "bash"],
              description: "Omit for the default (PowerShell on Windows, sh on Linux)."
            }
          },
          required: ["command"]
        }
      }
    });
  }
  return list;
}

class AiToolService {
  private readonly pendingConfirmations = new Map<string, PendingConfirmation>();
  // Wait for the daemon's background download (overridable in tests).
  installPollAttempts = 20;
  installPollIntervalMs = 1000;

  /** `isAdmin` adds the administrator-only tools; it never grants anything by itself. */
  getDeclarations(context: AiToolContext = {}, isAdmin = false) {
    const all: readonly any[] = context.instanceScope
      ? [
          ...scopedInstanceDeclarations,
          ...fileDeclarations,
          ...pluginDeclarations,
          ...(context.readOnly ? [] : commandDeclarations(isAdmin))
        ]
      : declarations;
    return context.readOnly
      ? all.filter((declaration) => READ_ONLY_TOOLS.has(declaration.function.name))
      : all;
  }

  getCreateDeclaration() {
    return createDeclaration;
  }

  /**
   * Direct request to create a new instance/server (any game). Start/launch verbs are
   * deliberately excluded: "lance le serveur" means start an existing instance.
   */
  isInstanceCreationRequest(message: string) {
    return (
      /(minecraft|serveur|server|instance)/i.test(message) &&
      /(^|[^\p{L}])(crée|créé|créer|creer|cree|création|creation|fais|faire|fasse|construire|construis|installer|installe|nouveau|nouvelle|create|build|install|set ?up|make|new)([^\p{L}]|$)/iu.test(
        message
      ) &&
      !/(^|[^\p{L}])(comment|how to|how do|guide|instructions|explain|explique|pourquoi|why)([^\p{L}]|$)/iu.test(
        message
      ) &&
      // Installing content into an existing server is not an instance creation.
      !/(^|[^\p{L}])(plugins?|mods?|modpacks?|datapacks?|resource ?packs?|java|jdk|docker)([^\p{L}]|$)/iu.test(
        message
      )
    );
  }

  isExplicitConfirmationMessage(message: string) {
    return this.isConfirmationMessage(message);
  }

  hasPendingConfirmation(ownerUuid: string, conversationUuid: string) {
    return Boolean(this.getPending(`${ownerUuid}:${conversationUuid}`));
  }

  async executePendingConfirmation(
    ownerUuid: string,
    conversationUuid: string,
    message: string
  ): Promise<AiToolResult | null> {
    if (!this.isConfirmationMessage(message)) return null;
    const pending = this.getPending(`${ownerUuid}:${conversationUuid}`);
    if (!pending || !PANEL_CONFIRMED_TOOLS.has(pending.tool)) return null;
    return this.execute(
      ownerUuid,
      conversationUuid,
      message,
      pending.tool,
      { ...pending.args, confirmed: true },
      pending.context
    );
  }

  /** Drops any pending action of a deleted conversation. */
  forgetConversation(ownerUuid: string, conversationUuid: string) {
    this.pendingConfirmations.delete(`${ownerUuid}:${conversationUuid}`);
  }

  prepareMessage(ownerUuid: string, conversationUuid: string, message: string) {
    const key = `${ownerUuid}:${conversationUuid}`;
    if (this.pendingConfirmations.has(key) && !this.isConfirmationMessage(message)) {
      this.pendingConfirmations.delete(key);
    }
  }

  private getPending(key: string): PendingConfirmation | undefined {
    const pending = this.pendingConfirmations.get(key);
    if (pending && Date.now() - pending.createdAt > CONFIRMATION_TTL_MS) {
      this.pendingConfirmations.delete(key);
      return undefined;
    }
    return pending;
  }

  private resolveUser(ownerUuid: string): User | null {
    return userSystem.getInstance(ownerUuid) || null;
  }

  async execute(
    ownerUuid: string,
    conversationUuid: string,
    latestUserMessage: string,
    tool: string,
    argumentsJson: unknown,
    context: AiToolContext = {}
  ): Promise<AiToolResult> {
    const user = this.resolveUser(ownerUuid);
    if (!user || user.permission < ROLE.USER) {
      logger.warn(`[AI_TOOL] Refused tool=${tool} user=${ownerUuid}`);
      return { tool, decision: "refused", error: "Forbidden" };
    }
    if (context.readOnly && !READ_ONLY_TOOLS.has(tool)) {
      logger.warn(
        `[AI_TOOL] Refused tool=${String(tool).slice(0, 64)} user=${ownerUuid}: read-only run`
      );
      return { tool, decision: "refused", error: "Not available in scheduled tasks" };
    }

    let args: any;
    try {
      args =
        typeof argumentsJson === "string"
          ? JSON.parse(argumentsJson || "{}")
          : (argumentsJson ?? {});
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("Invalid arguments");
      }
    } catch {
      logger.warn(
        `[AI_TOOL] Refused tool=${tool} user=${ownerUuid}: arguments are not a JSON object`
      );
      return { tool, decision: "refused", error: "Invalid arguments" };
    }

    const scope = context.instanceScope;
    if (scope) {
      if (!SCOPED_TOOLS.has(tool)) {
        logger.warn(
          `[AI_TOOL] Refused tool=${String(tool).slice(
            0,
            64
          )} user=${ownerUuid}: not available in instance assistant`
        );
        return { tool, decision: "refused", error: "Not available in instance assistant" };
      }
      if (tool === "start_instance" || tool === "stop_instance") {
        args = {
          daemonId: scope.daemonId,
          instanceUuid: scope.instanceUuid,
          confirmed: args.confirmed
        };
      }
    }

    if (COMMAND_TOOLS.has(tool) || INSPECT_TOOLS.has(tool)) {
      return await aiCommandTools.execute(
        user,
        tool,
        args,
        context.instanceScope,
        (name, pending) =>
          this.checkConfirmation(
            ownerUuid,
            conversationUuid,
            latestUserMessage,
            name,
            pending,
            context
          )
      );
    }

    if (tool === "list_accessible_instances") {
      return await this.listInstances(user, ownerUuid);
    }

    if (tool === LIST_TEMPLATES_TOOL || tool === "list_minecraft_templates") {
      return await this.listTemplates(user, typeof args.search === "string" ? args.search : "");
    }

    if (tool === CREATE_TOOL || tool === "create_minecraft_server") {
      return await this.createFromTemplate(
        user,
        ownerUuid,
        conversationUuid,
        latestUserMessage,
        args
      );
    }

    if (tool === SEARCH_PLUGINS_TOOL || tool === INSTALL_PLUGIN_TOOL) {
      return await this.pluginTool(
        user,
        ownerUuid,
        conversationUuid,
        latestUserMessage,
        tool,
        args,
        context
      );
    }

    if (tool === LIST_FILES_TOOL || tool === READ_FILE_TOOL || tool === EDIT_FILE_TOOL) {
      return await this.fileTool(
        user,
        ownerUuid,
        conversationUuid,
        latestUserMessage,
        tool,
        args,
        context
      );
    }

    if (tool !== "start_instance" && tool !== "stop_instance") {
      logger.warn(`[AI_TOOL] Refused unknown tool=${String(tool).slice(0, 64)} user=${ownerUuid}`);
      return { tool, decision: "refused", error: "Tool not allowlisted" };
    }

    const daemonId = validString(args.daemonId);
    const instanceUuid = validString(args.instanceUuid);
    if (!daemonId || !instanceUuid) {
      return { tool, decision: "refused", error: "Invalid arguments" };
    }

    if (!isHaveInstance(user, daemonId, instanceUuid)) {
      logger.warn(
        `[AI_TOOL] Refused tool=${tool} user=${ownerUuid} daemon=${daemonId} instance=${instanceUuid}`
      );
      return { tool, decision: "refused", error: "Forbidden resource" };
    }

    if (tool === "stop_instance") {
      const confirmation = this.checkConfirmation(
        ownerUuid,
        conversationUuid,
        latestUserMessage,
        tool,
        { daemonId, instanceUuid, confirmed: args.confirmed },
        context
      );
      if (!confirmation) {
        return {
          tool,
          decision: "approved",
          data: { confirmationRequired: true, daemonId, instanceUuid, nickname: scope?.nickname }
        };
      }
    }

    const remote = RemoteServiceSubsystem.getInstance(daemonId);
    if (!remote) return { tool, decision: "refused", error: "Daemon unavailable" };

    try {
      const method = tool === "start_instance" ? "instance/open" : "instance/stop";
      const result = await new RemoteRequest(remote).request(method, {
        instanceUuids: [instanceUuid]
      });
      logger.info(
        `[AI_TOOL] Executed tool=${tool} user=${ownerUuid} daemon=${daemonId} instance=${instanceUuid}`
      );
      return {
        tool,
        decision: "executed",
        data: { result, daemonId, instanceUuid, nickname: scope?.nickname }
      };
    } catch (error: any) {
      logger.warn(
        `[AI_TOOL] Failed tool=${tool} user=${ownerUuid}: ${String(error?.message || error)}`
      );
      return {
        tool,
        decision: "refused",
        error: "Tool execution failed",
        data: { daemonId, instanceUuid, nickname: scope?.nickname }
      };
    }
  }

  private availableDaemons() {
    return Array.from(RemoteServiceSubsystem.services.entries())
      .filter(([, service]) => service?.available)
      .map(([daemonId, service]) => ({
        daemonId,
        name: String(service.config?.remarks || daemonId).slice(0, 100)
      }));
  }

  private async loadCatalogue(): Promise<any[]> {
    const catalogue = await getAppMarketList();
    return Array.isArray(catalogue?.packages) ? catalogue.packages : [];
  }

  /**
   * Compact, trusted catalogue view for the model. Only the fields needed to choose are
   * exposed; download links and setup commands stay server-side.
   */
  async listTemplates(user: User, search = ""): Promise<AiToolResult> {
    const tool = LIST_TEMPLATES_TOOL;
    if (user.permission < ROLE.ADMIN) {
      return { tool, decision: "refused", error: "Administrator permission required" };
    }
    try {
      const templates = (await this.loadCatalogue()).filter(
        (entry) => entry && typeof entry.title === "string" && entry.setupInfo
      );
      const terms = searchTerms(search).filter((term) => !IGNORED_SEARCH_TERMS.has(term));
      // Prefer templates in the request's script (the catalogue mixes en_us and zh_cn entries).
      const wantsChinese = /[一-鿿]/.test(search);
      const languageRank = (entry: any) =>
        String(entry.language ?? "").startsWith("zh") === wantsChinese ? 0 : 1;
      let selected = [...templates].sort((a, b) => languageRank(a) - languageRank(b));
      let matched = false;
      if (terms.length) {
        const scored = templates
          .map((entry) => {
            const haystack = `${entry.gameType} ${entry.title} ${
              entry.category ?? ""
            }`.toLowerCase();
            return { entry, score: terms.filter((term) => haystack.includes(term)).length };
          })
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score || languageRank(a.entry) - languageRank(b.entry));
        if (scored.length) {
          selected = scored.map(({ entry }) => entry);
          matched = true;
        }
      }
      return {
        tool,
        decision: "executed",
        data: {
          availableDaemons: this.availableDaemons(),
          matched,
          gameTypes: [...new Set(templates.map((entry) => String(entry.gameType || "")))]
            .filter(Boolean)
            .slice(0, 60),
          totalTemplates: templates.length,
          templates: selected.slice(0, MAX_LISTED_TEMPLATES).map((entry) => ({
            templateId: templateIdOf(entry),
            title: String(entry.title).slice(0, 120),
            gameType: String(entry.gameType ?? "").slice(0, 60),
            platform: String(entry.platform ?? "").slice(0, 20),
            docker: entry.setupInfo?.processType === "docker",
            description: String(entry.description ?? "").slice(0, 80)
          }))
        }
      };
    } catch (error: any) {
      logger.warn(`[AI_TOOL] Templates could not be loaded: ${String(error?.message || error)}`);
      return { tool, decision: "refused", error: "Templates could not be loaded" };
    }
  }

  private checkConfirmation(
    ownerUuid: string,
    conversationUuid: string,
    latestUserMessage: string,
    tool: string,
    args: Record<string, unknown>,
    context: AiToolContext = {}
  ): boolean {
    const key = `${ownerUuid}:${conversationUuid}`;
    const pending = this.getPending(key);
    const confirmedText = this.isConfirmationMessage(latestUserMessage);
    const argsWithoutConfirmation = { ...args };
    delete argsWithoutConfirmation.confirmed;
    if (
      args.confirmed === true &&
      confirmedText &&
      pending?.tool === tool &&
      JSON.stringify(pending.args) === JSON.stringify(argsWithoutConfirmation) &&
      JSON.stringify(pending.context) === JSON.stringify(context)
    ) {
      this.pendingConfirmations.delete(key);
      return true;
    }
    if (this.pendingConfirmations.size >= MAX_PENDING_CONFIRMATIONS) {
      const oldest = this.pendingConfirmations.keys().next().value;
      if (oldest) this.pendingConfirmations.delete(oldest);
    }
    this.pendingConfirmations.delete(key);
    this.pendingConfirmations.set(key, {
      tool,
      args: argsWithoutConfirmation,
      context,
      createdAt: Date.now()
    });
    return false;
  }

  private isConfirmationMessage(message: string) {
    return /^(oui|oui je confirme|oui vas-y|je confirme|confirme|confirmé|yes|yes i confirm|confirm|confirmed|go ahead|proceed)[.! ]*$/i.test(
      message.trim()
    );
  }

  private findTemplate(templates: any[], args: Record<string, unknown>) {
    const templateId = validString(args.templateId, 64);
    if (templateId) {
      return templates.find((entry) => templateIdOf(entry) === templateId.toLowerCase());
    }
    // Legacy arguments: exact title (and description when given) must identify one template.
    const title = validString(args.templateTitle, 200);
    if (!title) return undefined;
    const description = validString(args.templateDescription, 2000);
    const matches = templates.filter(
      (entry) => entry.title === title && (!description || entry.description === description)
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  private async createFromTemplate(
    user: User,
    ownerUuid: string,
    conversationUuid: string,
    latestUserMessage: string,
    args: Record<string, unknown>
  ): Promise<AiToolResult> {
    const tool = CREATE_TOOL;
    if (user.permission < ROLE.ADMIN) {
      logger.warn(`[AI_TOOL] Refused tool=${tool} user=${ownerUuid}: administrator required`);
      return { tool, decision: "refused", error: "Administrator permission required" };
    }
    // Note: "allowUsePreset" only restricts non-administrators in MCSManager
    // (see instance_admin_router "/quick_install_list"); administrators are always allowed.

    let templates: any[];
    try {
      templates = await this.loadCatalogue();
    } catch (error: any) {
      logger.warn(`[AI_TOOL] Templates could not be loaded: ${String(error?.message || error)}`);
      return { tool, decision: "refused", error: "Templates could not be loaded" };
    }
    const template = this.findTemplate(templates, args);
    if (!template || typeof template.title !== "string" || !template.setupInfo) {
      logger.warn(`[AI_TOOL] Refused tool=${tool} user=${ownerUuid}: template not in catalogue`);
      return { tool, decision: "refused", error: "Template not found" };
    }
    const templateId = templateIdOf(template);

    const daemons = this.availableDaemons();
    let daemonId = validString(args.daemonId);
    if (!daemonId) {
      if (daemons.length === 1) {
        daemonId = daemons[0].daemonId;
      } else if (daemons.length === 0) {
        return { tool, decision: "refused", error: "Daemon unavailable" };
      } else {
        return {
          tool,
          decision: "refused",
          error: "Daemon selection required",
          data: { availableDaemons: daemons }
        };
      }
    }
    const remote = RemoteServiceSubsystem.getInstance(daemonId);
    if (!remote?.available) {
      logger.warn(
        `[AI_TOOL] Refused tool=${tool} user=${ownerUuid} daemon=${daemonId}: unavailable`
      );
      return {
        tool,
        decision: "refused",
        error: "Daemon unavailable",
        data: { availableDaemons: daemons }
      };
    }
    const daemonName = String(remote.config?.remarks || daemonId).slice(0, 100);

    const nickname =
      validString(args.nickname, 64) ||
      validString(
        String(template.title)
          .replace(/[\u0000-\u001f\u007f]/g, "")
          .slice(0, 64),
        64
      );
    if (!nickname) {
      return { tool, decision: "refused", error: "Invalid creation arguments" };
    }

    const confirmationArgs = { templateId, daemonId, nickname };
    const summary = {
      templateId,
      templateTitle: String(template.title).slice(0, 120),
      gameType: String(template.gameType ?? "").slice(0, 60),
      platform: String(template.platform ?? "").slice(0, 20),
      docker: template.setupInfo?.processType === "docker",
      daemonId,
      daemonName,
      nickname
    };
    if (
      !this.checkConfirmation(ownerUuid, conversationUuid, latestUserMessage, tool, {
        ...confirmationArgs,
        confirmed: args.confirmed
      })
    ) {
      logger.info(
        `[AI_TOOL] Confirmation requested tool=${tool} user=${ownerUuid} daemon=${daemonId} template=${templateId}`
      );
      return { tool, decision: "approved", data: { confirmationRequired: true, ...summary } };
    }

    let task: any;
    try {
      task = await new RemoteRequest(remote).request(
        "instance/asynchronous",
        {
          instanceUuid: "-",
          taskName: "quick_install",
          role: ROLE.ADMIN,
          parameter: {
            newInstanceName: nickname,
            // The daemon stringifies this value: never send undefined (it would become "undefined").
            targetLink: typeof template.targetLink === "string" ? template.targetLink : "",
            setupInfo: template.setupInfo,
            autoStartAfterInstall: true
          }
        },
        15000
      );
    } catch (error: any) {
      logger.warn(
        `[AI_TOOL] Creation failed user=${ownerUuid} daemon=${daemonId} template=${templateId}: ${String(
          error?.message || error
        ).slice(0, 300)}`
      );
      return { tool, decision: "refused", error: "Instance creation failed", data: summary };
    }

    if (
      !task ||
      typeof task.instanceUuid !== "string" ||
      !task.instanceUuid ||
      typeof task.taskId !== "string" ||
      !task.taskId
    ) {
      logger.warn(
        `[AI_TOOL] Creation not confirmed by daemon user=${ownerUuid} daemon=${daemonId} template=${templateId}: unexpected response`
      );
      return {
        tool,
        decision: "refused",
        error: "Daemon returned an invalid response",
        data: summary
      };
    }

    logger.info(
      `[AI_TOOL] Created instance user=${ownerUuid} daemon=${daemonId} instance=${task.instanceUuid} template=${templateId} task=${task.taskId}`
    );
    return {
      tool,
      decision: "executed",
      data: {
        ...summary,
        instanceUuid: task.instanceUuid,
        installationTaskId: task.taskId,
        status: task.status,
        startsAfterInstallation: true
      }
    };
  }

  /**
   * File tools are bound to the conversation's instance (server-side scope). Access is
   * re-checked on every call with the same rules as the file manager routes; the daemon
   * additionally confines every path to the instance working directory.
   */
  private async fileTool(
    user: User,
    ownerUuid: string,
    conversationUuid: string,
    latestUserMessage: string,
    tool: string,
    args: Record<string, unknown>,
    context: AiToolContext
  ): Promise<AiToolResult> {
    const scope = context.instanceScope;
    if (!scope) {
      return { tool, decision: "refused", error: "No instance selected" };
    }
    const { daemonId, instanceUuid } = scope;
    if (!isHaveInstance(user, daemonId, instanceUuid)) {
      logger.warn(
        `[AI_TOOL] Refused tool=${tool} user=${ownerUuid} daemon=${daemonId} instance=${instanceUuid}`
      );
      return { tool, decision: "refused", error: "Forbidden resource" };
    }
    if (systemConfig?.canFileManager === false && user.permission < ROLE.ADMIN) {
      return { tool, decision: "refused", error: "File management is disabled" };
    }
    const remote = RemoteServiceSubsystem.getInstance(daemonId);
    if (!remote?.available) {
      return { tool, decision: "refused", error: "Daemon unavailable" };
    }
    const request = (event: string, data: Record<string, unknown>, timeout = 15000) =>
      new RemoteRequest(remote).request(event, { instanceUuid, ...data }, timeout);
    const readText = async (path: string): Promise<string> => {
      const text = await request("file/edit", { target: path });
      // The daemon answers `true` instead of an empty string for an empty file.
      if (text === true) return "";
      if (typeof text !== "string") throw new Error("Not a text file");
      return text;
    };
    const failure = (error: unknown) => String((error as any)?.message || error).slice(0, 200);

    if (tool === LIST_FILES_TOOL) {
      const path = args.path == null || args.path === "" ? "/" : normalizeInstancePath(args.path);
      if (!path) return { tool, decision: "refused", error: "Invalid path" };
      try {
        const result = await request("file/list", {
          target: path,
          page: 0,
          pageSize: 100,
          fileName: ""
        });
        const items = Array.isArray(result?.items) ? result.items : [];
        logger.info(`[AI_TOOL] Executed tool=${tool} user=${ownerUuid} instance=${instanceUuid}`);
        return {
          tool,
          decision: "executed",
          data: {
            path,
            total: Number(result?.total ?? items.length),
            items: items.slice(0, 100).map((item: any) => ({
              name: String(item?.name ?? "").slice(0, 200),
              type: item?.type === 0 ? "folder" : "file",
              size: Number(item?.size ?? 0)
            }))
          }
        };
      } catch (error) {
        logger.warn(`[AI_TOOL] ${tool} failed instance=${instanceUuid}: ${failure(error)}`);
        return { tool, decision: "refused", error: "File operation failed" };
      }
    }

    const path = normalizeInstancePath(args.path);
    if (!path) return { tool, decision: "refused", error: "Invalid path" };

    if (tool === READ_FILE_TOOL) {
      try {
        const text = await readText(path);
        if (isBinaryText(text)) return { tool, decision: "refused", error: "Binary file" };
        const offset = Math.max(0, Math.min(text.length, Math.floor(Number(args.offset) || 0)));
        const chunk = text.slice(offset, offset + MAX_AI_FILE_READ_CHARS);
        logger.info(
          `[AI_TOOL] Executed tool=${tool} user=${ownerUuid} instance=${instanceUuid} file=${path}`
        );
        return {
          tool,
          decision: "executed",
          data: {
            path,
            offset,
            totalChars: text.length,
            truncated: offset + chunk.length < text.length,
            content: chunk
          }
        };
      } catch (error) {
        logger.warn(
          `[AI_TOOL] ${tool} failed instance=${instanceUuid} file=${path}: ${failure(error)}`
        );
        return { tool, decision: "refused", error: "File could not be read", data: { path } };
      }
    }

    // EDIT_FILE_TOOL: build the exact new content, show a preview, write only after "yes".
    const edits = args.edits == null ? null : parseEdits(args.edits);
    const fullContent = typeof args.content === "string" ? args.content : null;
    if ((args.edits != null && !edits) || (!edits && fullContent === null)) {
      return { tool, decision: "refused", error: "Invalid edit", data: { path } };
    }
    if (
      fullContent !== null &&
      (fullContent.length > MAX_AI_FILE_WRITE_CHARS || isBinaryText(fullContent))
    ) {
      return { tool, decision: "refused", error: "File too large", data: { path } };
    }

    let original: string | null;
    try {
      original = await readText(path);
    } catch {
      original = null; // missing or unreadable: only a full-content creation is allowed
    }
    if (original !== null && isBinaryText(original)) {
      return { tool, decision: "refused", error: "Binary file", data: { path } };
    }
    // Confirming a preview of a file that has changed since: never re-plan silently.
    if (
      args.confirmed === true &&
      typeof args.originalHash === "string" &&
      args.originalHash !== contentHash(original)
    ) {
      this.pendingConfirmations.delete(`${ownerUuid}:${conversationUuid}`);
      logger.warn(
        `[AI_TOOL] Edit aborted, file changed since preview instance=${instanceUuid} file=${path}`
      );
      return { tool, decision: "refused", error: "File changed since preview", data: { path } };
    }
    let next: string;
    if (edits) {
      if (original === null) {
        return { tool, decision: "refused", error: "File could not be read", data: { path } };
      }
      const applied = applyEdits(original, edits);
      if ("error" in applied) {
        return { tool, decision: "refused", error: applied.error, data: { path } };
      }
      next = applied.content;
    } else {
      next = fullContent as string;
    }
    if (original === next) {
      return { tool, decision: "refused", error: "No change", data: { path } };
    }

    const pendingArgs = {
      path,
      originalHash: contentHash(original),
      ...(edits ? { edits } : { content: next })
    };
    const summary = {
      path,
      instanceUuid,
      daemonId,
      nickname: scope.nickname,
      newFile: original === null,
      preview: buildDiffPreview(original ?? "", next)
    };
    if (
      !this.checkConfirmation(
        ownerUuid,
        conversationUuid,
        latestUserMessage,
        tool,
        { ...pendingArgs, confirmed: args.confirmed },
        context
      )
    ) {
      logger.info(
        `[AI_TOOL] Confirmation requested tool=${tool} user=${ownerUuid} instance=${instanceUuid} file=${path}`
      );
      return { tool, decision: "approved", data: { confirmationRequired: true, ...summary } };
    }

    // Confirmed: the file must still be exactly what the user saw in the preview.
    let current: string | null;
    try {
      current = await readText(path);
    } catch {
      current = null;
    }
    if (contentHash(current) !== pendingArgs.originalHash) {
      logger.warn(
        `[AI_TOOL] Edit aborted, file changed since preview instance=${instanceUuid} file=${path}`
      );
      return { tool, decision: "refused", error: "File changed since preview", data: summary };
    }
    try {
      const result = await request("file/edit", { target: path, text: next }, 100000);
      if (result !== true && typeof result !== "string") {
        throw new Error("Unexpected daemon response");
      }
    } catch (error) {
      logger.warn(`[AI_TOOL] Edit failed instance=${instanceUuid} file=${path}: ${failure(error)}`);
      return { tool, decision: "refused", error: "File could not be written", data: summary };
    }
    operationLogger.log("instance_file_update", {
      operator_ip: "local-ai",
      operator_name: user.userName,
      instance_id: instanceUuid,
      daemon_id: daemonId,
      instance_name: await getInstanceNameSafely(daemonId, instanceUuid),
      file: path
    });
    logger.info(`[AI_TOOL] Edited file user=${ownerUuid} instance=${instanceUuid} file=${path}`);
    return { tool, decision: "executed", data: summary };
  }

  /** Shared access check for tools bound to the conversation's instance. */
  private instanceAccess(
    user: User,
    ownerUuid: string,
    tool: string,
    context: AiToolContext
  ): { error: AiToolResult } | { scope: AiInstanceScope; remote: any } {
    const scope = context.instanceScope;
    if (!scope) return { error: { tool, decision: "refused", error: "No instance selected" } };
    if (!isHaveInstance(user, scope.daemonId, scope.instanceUuid)) {
      logger.warn(
        `[AI_TOOL] Refused tool=${tool} user=${ownerUuid} daemon=${scope.daemonId} instance=${scope.instanceUuid}`
      );
      return { error: { tool, decision: "refused", error: "Forbidden resource" } };
    }
    if (systemConfig?.canFileManager === false && user.permission < ROLE.ADMIN) {
      return { error: { tool, decision: "refused", error: "File management is disabled" } };
    }
    const remote = RemoteServiceSubsystem.getInstance(scope.daemonId);
    if (!remote?.available) {
      return { error: { tool, decision: "refused", error: "Daemon unavailable" } };
    }
    return { scope, remote };
  }

  /** Reads what the instance exposes to detect its server software and Minecraft version. */
  async detectProfile(remote: any, instanceUuid: string): Promise<ServerProfile> {
    const request = (event: string, data: Record<string, unknown>) =>
      new RemoteRequest(remote).request(event, { instanceUuid, ...data }, 10000);
    const readOptional = async (target: string): Promise<string | null> => {
      try {
        const text = await request("file/edit", { target });
        return typeof text === "string" ? text : null;
      } catch {
        return null;
      }
    };
    let type = "";
    let pingVersion = "";
    try {
      const detail = await request("instance/detail", {});
      type = String(detail?.config?.type || "");
      pingVersion = String(detail?.info?.version || "");
    } catch {
      // detection continues with files only
    }
    let rootNames: string[] = [];
    try {
      const listing = await request("file/list", {
        target: "/",
        page: 0,
        pageSize: 100,
        fileName: ""
      });
      rootNames = (Array.isArray(listing?.items) ? listing.items : []).map((item: any) =>
        String(item?.name ?? "")
      );
    } catch {
      // ignore
    }
    const versionHistory = await readOptional("/version_history.json");
    const latestLog =
      versionHistory && /MC: /.test(versionHistory) ? null : await readOptional("/logs/latest.log");
    return detectServerProfile({ type, pingVersion, versionHistory, latestLog, rootNames });
  }

  async installedAddons(remote: any, instanceUuid: string, search: string) {
    try {
      const result = await new RemoteRequest(remote).request(
        "instance/mods/list",
        { instanceUuid, page: 1, pageSize: 50, folder: "", search },
        10000
      );
      return Array.isArray(result?.mods) ? result.mods : [];
    } catch {
      return [];
    }
  }

  /**
   * Plugin/mod tools reuse the MCSManager mod manager sources. The model only chooses a
   * project; the panel detects the server, picks a compatible version, takes the download URL
   * from the official API (allowlisted hosts) and installs only after an explicit "yes".
   */
  private async pluginTool(
    user: User,
    ownerUuid: string,
    conversationUuid: string,
    latestUserMessage: string,
    tool: string,
    args: Record<string, unknown>,
    context: AiToolContext
  ): Promise<AiToolResult> {
    const access = this.instanceAccess(user, ownerUuid, tool, context);
    if ("error" in access) return access.error;
    const { scope, remote } = access;
    const { instanceUuid, daemonId } = scope;
    const profile = await this.detectProfile(remote, instanceUuid);
    const server = { loader: profile.loader, mcVersion: profile.mcVersion, kind: profile.kind };

    if (tool === SEARCH_PLUGINS_TOOL) {
      const query = validString(args.query, 80);
      if (!query) return { tool, decision: "refused", error: "Invalid arguments" };
      const type = profile.kind === "mod" ? "mod" : "plugin";
      const queries = [...new Set([query, query.replace(/[-_\s]+/g, "")])];
      let hits: any[] = [];
      try {
        for (const text of queries) {
          hits = (await modManagerService.searchProjects(text, 0, 8, { source: "modrinth", type }))
            ?.hits;
          if (hits?.length) break;
        }
        if (!hits?.length && type === "plugin") {
          hits = (await modManagerService.searchProjects(query, 0, 8, { source: "spigotmc", type }))
            ?.hits;
        }
      } catch (error: any) {
        logger.warn(
          `[AI_TOOL] Plugin search failed: ${String(error?.message || error).slice(0, 200)}`
        );
        return { tool, decision: "refused", error: "Plugin search failed", data: { server } };
      }
      logger.info(`[AI_TOOL] Executed tool=${tool} user=${ownerUuid} instance=${instanceUuid}`);
      return {
        tool,
        decision: "executed",
        data: {
          server,
          results: (hits || []).slice(0, 8).map((hit: any) => ({
            projectId: String(hit?.id ?? ""),
            source: String(hit?.source ?? ""),
            title: String(hit?.title ?? "").slice(0, 80),
            description: String(hit?.description ?? "").slice(0, 120),
            downloads: Number(hit?.downloads ?? 0),
            latestVersion: String(hit?.version_number ?? "").slice(0, 40),
            supportsServerVersion:
              profile.mcVersion && Array.isArray(hit?.game_versions) && hit.game_versions.length
                ? hit.game_versions.includes(profile.mcVersion)
                : null
          }))
        }
      };
    }

    // INSTALL_PLUGIN_TOOL
    const projectId = validString(args.projectId, 64);
    const source =
      SUPPORTED_SOURCES.find(
        (item) => item.toLowerCase() === String(args.source || "Modrinth").toLowerCase()
      ) || null;
    const versionId = args.versionId == null ? undefined : validString(args.versionId, 64);
    if (!projectId || !/^[A-Za-z0-9_-]+$/.test(projectId) || !source || versionId === null) {
      return { tool, decision: "refused", error: "Invalid arguments", data: { server } };
    }
    if (profile.kind === "unknown") {
      return { tool, decision: "refused", error: "Unsupported server", data: { server } };
    }

    let versions: CandidateVersion[] | null = null;
    try {
      versions = await modManagerService.getProjectVersions(projectId, source);
    } catch {
      versions = null;
    }
    if (!Array.isArray(versions) || versions.length === 0) {
      return { tool, decision: "refused", error: "Plugin not found", data: { server } };
    }
    const picked = pickVersion(versions, profile, versionId);
    if ("error" in picked) {
      return { tool, decision: "refused", error: picked.error, data: { server } };
    }
    const fileName = safeJarFileName(picked.file.filename);
    // Name derived from the official file name (API data, never model input).
    const title = projectNameFromFile(fileName || "") || projectId;
    const url = picked.file.url;
    const fallbackUrl =
      picked.fallbackUrl && isAllowedDownloadUrl(picked.fallbackUrl)
        ? picked.fallbackUrl
        : undefined;
    if (!fileName || !isAllowedDownloadUrl(url) || !(await checkSafeUrl(url))) {
      logger.warn(`[AI_TOOL] Refused unsafe plugin download project=${projectId} source=${source}`);
      return { tool, decision: "refused", error: "Unsafe download", data: { server, title } };
    }
    const kind = installKind(picked.version, profile);
    if (profile.kind !== kind) {
      return {
        tool,
        decision: "refused",
        error: "Version not compatible",
        data: { server, title }
      };
    }

    const copies = findInstalledCopies(await this.installedAddons(remote, instanceUuid, ""), title);
    if (copies.length > 1) {
      return {
        tool,
        decision: "refused",
        error: "Several copies installed",
        data: { server, title, installed: copies.map((item: any) => item.file) }
      };
    }
    const existing = copies[0];
    if (existing && existing.file === fileName) {
      return {
        tool,
        decision: "refused",
        error: "Already installed",
        data: { server, title, fileName }
      };
    }
    const oldFileName = existing
      ? `${existing.folder ? `${existing.folder}/` : ""}${existing.file}`
      : undefined;

    const pendingArgs = {
      projectId,
      source,
      versionId: String(picked.version.id),
      fileName,
      url,
      ...(fallbackUrl ? { fallbackUrl } : {}),
      ...(oldFileName ? { oldFileName } : {})
    };
    const summary = {
      instanceUuid,
      daemonId,
      nickname: scope.nickname,
      server,
      title,
      source,
      version: String(
        picked.version.version_number || picked.version.name || picked.version.id
      ).slice(0, 60),
      fileName,
      folder: kind === "mod" ? "mods" : "plugins",
      replaces: oldFileName,
      verified: picked.verified
    };
    if (
      !this.checkConfirmation(
        ownerUuid,
        conversationUuid,
        latestUserMessage,
        tool,
        { ...pendingArgs, confirmed: args.confirmed },
        context
      )
    ) {
      logger.info(
        `[AI_TOOL] Confirmation requested tool=${tool} user=${ownerUuid} instance=${instanceUuid} project=${projectId}`
      );
      return { tool, decision: "approved", data: { confirmationRequired: true, ...summary } };
    }

    try {
      await new RemoteRequest(remote).request(
        "instance/mods/install",
        {
          instanceUuid,
          url,
          fileName,
          type: kind,
          fallbackUrl,
          oldFileName
        },
        15000
      );
    } catch (error: any) {
      logger.warn(
        `[AI_TOOL] Plugin install failed instance=${instanceUuid} project=${projectId}: ${String(
          error?.message || error
        ).slice(0, 200)}`
      );
      return { tool, decision: "refused", error: "Install failed", data: summary };
    }
    operationLogger.log("instance_file_upload", {
      operator_ip: "local-ai",
      operator_name: user.userName,
      instance_id: instanceUuid,
      daemon_id: daemonId,
      instance_name: await getInstanceNameSafely(daemonId, instanceUuid),
      file: `${summary.folder}/${fileName}`
    });

    // The daemon downloads in the background: wait briefly for a real outcome.
    for (let attempt = 0; attempt < this.installPollAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, this.installPollIntervalMs));
      try {
        const state = await new RemoteRequest(remote).request(
          "instance/mods/list",
          { instanceUuid, page: 1, pageSize: 50, folder: "", search: "" },
          10000
        );
        const task = (Array.isArray(state?.downloadTasks) ? state.downloadTasks : []).find(
          (item: any) => typeof item?.path === "string" && item.path.endsWith(`/${fileName}`)
        );
        if (task?.status === 2) {
          logger.warn(`[AI_TOOL] Plugin download error instance=${instanceUuid} file=${fileName}`);
          return { tool, decision: "refused", error: "Download failed", data: summary };
        }
        const present = (Array.isArray(state?.mods) ? state.mods : []).some(
          (item: any) => item?.file === fileName
        );
        if (present && (!task || task.status === 1)) {
          logger.info(
            `[AI_TOOL] Installed plugin user=${ownerUuid} instance=${instanceUuid} file=${fileName}`
          );
          return { tool, decision: "executed", data: { ...summary, completed: true } };
        }
      } catch {
        // keep waiting
      }
    }
    return { tool, decision: "executed", data: { ...summary, completed: false } };
  }

  private async listInstances(user: User, ownerUuid: string): Promise<AiToolResult> {
    const daemonIds =
      user.permission >= ROLE.ADMIN
        ? Array.from(RemoteServiceSubsystem.services.keys())
        : [...new Set(user.instances.map((instance) => instance.daemonId))];
    const assigned = new Set(
      user.instances.map((instance) => `${instance.daemonId}:${instance.instanceUuid}`)
    );
    const rows: Array<Record<string, unknown>> = [];
    for (const daemonId of daemonIds.slice(0, 100)) {
      const service = RemoteServiceSubsystem.getInstance(daemonId);
      if (!service?.available) continue;
      try {
        const overview = await new RemoteRequest(service).request("instance/overview", {}, 10000);
        for (const instance of Array.isArray(overview) ? overview : []) {
          if (
            user.permission < ROLE.ADMIN &&
            !assigned.has(`${daemonId}:${String(instance.instanceUuid)}`)
          ) {
            continue;
          }
          rows.push({
            daemonId,
            instanceUuid: String(instance.instanceUuid),
            nickname: String(instance.config?.nickname || "").slice(0, 100),
            type: String(instance.config?.type || ""),
            status: instance.status
          });
        }
      } catch (error: any) {
        logger.warn(
          `[AI_TOOL] Instance listing failed for daemon=${daemonId}: ${String(
            error?.message || error
          )}`
        );
      }
    }
    logger.info(`[AI_TOOL] Executed tool=list_accessible_instances user=${ownerUuid}`);
    return { tool: "list_accessible_instances", decision: "executed", data: rows };
  }
}

export default new AiToolService();
