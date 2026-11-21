import axios, { AxiosResponse } from "axios";
import { v4 } from "uuid";
import Storage from "../common/storage/sys_storage";
import { AiConversation, AiMessage, AiRequestRecord, normalizeInstanceScope } from "../entity/ai";
import { ROLE } from "../entity/user";
import { getUserUuid } from "./passport_service";
import userSystem from "./user_service";
import { systemConfig } from "../setting";
import { logger } from "./log";
import aiToolService, {
  AiToolContext,
  AiToolResult,
  CREATE_TOOL,
  EDIT_FILE_TOOL,
  INSTALL_PLUGIN_TOOL,
  LIST_FILES_TOOL,
  SEARCH_PLUGINS_TOOL,
  LIST_TEMPLATES_TOOL,
  READ_FILE_TOOL
} from "./ai_tool_service";
import { isHaveInstance } from "./permission_service";
import { getInstanceNameSafely } from "./instance_name_service";
import { normalizeConsoleAllowlist } from "./ai_command_parsing";
import {
  ADMIN_COMMAND_TOOL,
  COMMAND_TOOLS,
  INSTANCE_INFO_TOOL,
  READ_CONSOLE_TOOL,
  SETTINGS_TOOL,
  CONSOLE_COMMAND_TOOL,
  consoleAllowlist,
  INSTALL_LOADER_TOOL,
  INSTANCE_COMMAND_TOOL,
  UPDATE_INSTANCE_TOOL
} from "./ai_command_tools";

interface QueueItem {
  record: AiRequestRecord;
  abortController: AbortController;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  prompt: string;
  ownerUuid: string;
  conversationUuid: string;
  /** Set for scheduled AI tasks: trusted data collected by the panel; tools are read-only. */
  scheduled?: {
    context: string;
    suffix: string;
    onFinished?: (state: AiRequestRecord["state"]) => void;
    /** Moderation review: no tools, dedicated system prompt, optional images. */
    moderation?: { system: string; images: string[] };
    transform?: (answer: string) => string;
  };
}

export interface SubmitOptions {
  /** Trusted, panel-collected data for a scheduled run (never stored in the conversation). */
  scheduledContext?: string;
  /** Panel-written text appended verbatim to the scheduled report. */
  scheduledSuffix?: string;
  /** Called once the scheduled request reached a final state. */
  onFinished?: (state: AiRequestRecord["state"]) => void;
  /** Moderation review (ban requests): replaces the instance prompt; no tools are exposed. */
  moderationSystemPrompt?: string;
  /** Data-URI images sent with the moderation request (vision models only). */
  images?: string[];
  /** Rewrites the model answer before it is stored (e.g. JSON verdict -> readable text). */
  transformAnswer?: (answer: string) => string;
}

/** System prompt addition for scheduled, unattended runs. */
export function scheduledRunPrompt(context: string): string {
  return (
    "\n\nThis is an unattended scheduled report: nobody can answer questions or confirm " +
    "actions now. Only read data; never propose to change files, install plugins, or start " +
    "or stop the instance yourself. Write a concise report in Markdown with: a one-line " +
    "status, the problems found (most serious first), and a suggested fix for each. If " +
    "nothing is wrong, say so in one sentence. Write the report in French unless the " +
    "instruction is clearly in another language. Data collected by the panel (trusted):\n" +
    context
  );
}

export class LocalAiConfigurationError extends Error {}

export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (/^10(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) return true;
  const match = /^172\.(\d{1,3})(?:\.\d{1,3}){2}$/.exec(host);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

export function validateEngineUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LocalAiConfigurationError("Invalid AI engine URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LocalAiConfigurationError("AI engine URL must use HTTP or HTTPS");
  }
  const pathSegments = url.pathname.split("/").filter(Boolean);
  const versionSegment = pathSegments.lastIndexOf("v1");
  if (versionSegment >= 0 && versionSegment !== pathSegments.length - 1) {
    throw new LocalAiConfigurationError(
      "AI engine URL must end at /v1; enter the model ID in the separate Model field"
    );
  }
  if (!isLocalHostname(url.hostname)) {
    throw new LocalAiConfigurationError("AI engine URL must target a local address");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new LocalAiConfigurationError("AI engine URL contains unsupported fields");
  }
  return url.toString().replace(/\/$/, "");
}

/**
 * Returns the user's creation request when the latest prompt is a "yes" answering an
 * assistant message that asked for confirmation but no panel-side pending action exists
 * (for example because the model previously answered in text instead of calling the tool).
 */
export function findRecoverableCreationRequest(
  messages: AiConversation["messages"],
  prompt: string
): string | null {
  if (!aiToolService.isExplicitConfirmationMessage(prompt)) return null;
  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (
    !latestAssistant ||
    !/(confirm|confirmation|confirme|confirmer|oui|yes)/i.test(latestAssistant.content)
  ) {
    return null;
  }
  const assistantIndex = messages.lastIndexOf(latestAssistant);
  const request = messages
    .slice(0, assistantIndex)
    .reverse()
    .find(
      (message) =>
        message.role === "user" && aiToolService.isInstanceCreationRequest(message.content)
    );
  return request ? request.content : null;
}

export function isRecoverableCreationConfirmation(
  messages: AiConversation["messages"],
  prompt: string
): boolean {
  return findRecoverableCreationRequest(messages, prompt) !== null;
}

export function isFrenchText(text: string): boolean {
  return /[àâçéèêëîïôûùüÿœ]|(^|[^\p{L}])(le|la|les|un|une|moi|serveur|oui|je|pour|avec|crée|creer|cree|fais|stp|svp)([^\p{L}]|$)/iu.test(
    text
  );
}

/** Extracts the first JSON object from a model text answer (optionally inside a code fence). */
export function parseJsonObject(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const CREATION_ERRORS: Record<string, [string, string]> = {
  Forbidden: ["accès refusé", "access denied"],
  "Administrator permission required": [
    "la création d’instance est réservée aux administrateurs",
    "creating instances is restricted to administrators"
  ],
  "Template not found": [
    "le modèle demandé ne figure pas dans le catalogue MCSManager",
    "the requested template is not in the MCSManager catalogue"
  ],
  "Templates could not be loaded": [
    "le catalogue des modèles MCSManager n’a pas pu être chargé (vérifiez l’adresse du catalogue dans les paramètres)",
    "the MCSManager template catalogue could not be loaded (check the catalogue address in settings)"
  ],
  "Daemon unavailable": [
    "aucun daemon disponible ne correspond (vérifiez qu’un nœud est en ligne)",
    "no matching daemon is online"
  ],
  "Daemon selection required": [
    "plusieurs daemons sont en ligne, précisez lequel utiliser",
    "several daemons are online, please specify which one to use"
  ],
  "Instance creation failed": [
    "le daemon a refusé ou n’a pas pu lancer la création",
    "the daemon refused or could not start the creation"
  ],
  "Daemon returned an invalid response": [
    "le daemon n’a pas confirmé le lancement de la tâche d’installation",
    "the daemon did not confirm that the installation task started"
  ],
  "Invalid arguments": [
    "les paramètres proposés par le modèle IA sont invalides",
    "the parameters proposed by the AI model are invalid"
  ],
  "Invalid creation arguments": [
    "les paramètres proposés par le modèle IA sont invalides",
    "the parameters proposed by the AI model are invalid"
  ]
};

/** Deterministic, panel-authored text for every creation outcome (never model-authored). */
export function formatCreationResult(result: AiToolResult, french: boolean): string {
  const data = result.data || {};
  const templateLabel = `${data.templateTitle ?? ""}${
    data.gameType ? ` (${data.gameType}${data.platform ? `, ${data.platform}` : ""})` : ""
  }`;
  const daemonLabel =
    data.daemonName && data.daemonName !== data.daemonId
      ? `${data.daemonName} (${data.daemonId})`
      : String(data.daemonId ?? "");

  if (result.decision === "approved" && data.confirmationRequired) {
    const dockerNote = data.docker
      ? french
        ? "\n\nCe modèle utilise Docker : Docker doit être installé sur ce daemon."
        : "\n\nThis template uses Docker: Docker must be installed on this daemon."
      : "";
    return french
      ? `Je peux créer cette instance :\n\n- Nom : « ${data.nickname} »\n- Modèle du catalogue : ${templateLabel}\n- Daemon : ${daemonLabel}${dockerNote}\n\nRéponds « oui » pour confirmer exactement cette création (valable 10 minutes). Tout autre message annule la demande. Rien n’a encore été créé.`
      : `I can create this instance:\n\n- Name: "${data.nickname}"\n- Catalogue template: ${templateLabel}\n- Daemon: ${daemonLabel}${dockerNote}\n\nReply "yes" to confirm exactly this creation (valid for 10 minutes). Any other message cancels it. Nothing has been created yet.`;
  }

  if (result.decision === "executed") {
    return french
      ? `La tâche de création de « ${data.nickname} » a été acceptée par le daemon ${daemonLabel} (instance ${data.instanceUuid}, tâche ${data.installationTaskId}). L’installation est en cours ; le serveur démarrera automatiquement uniquement si l’installation réussit.`
      : `The daemon ${daemonLabel} accepted the creation task for "${data.nickname}" (instance ${data.instanceUuid}, task ${data.installationTaskId}). Installation is in progress; the server will start automatically only if installation succeeds.`;
  }

  const [fr, en] = CREATION_ERRORS[String(result.error)] || [
    "la création n’a pas pu être préparée",
    "the creation could not be prepared"
  ];
  let reason = french ? fr : en;
  if (Array.isArray(data.availableDaemons) && data.availableDaemons.length) {
    reason += ` : ${data.availableDaemons
      .map((daemon: any) => `${daemon.name} (${daemon.daemonId})`)
      .join(", ")}`;
  }
  return french
    ? `Je n’ai pas créé l’instance : ${reason}. Aucune instance n’a été créée.`
    : `I did not create the instance: ${reason}. No instance was created.`;
}

export function noUsableToolCallMessage(french: boolean): string {
  return french
    ? "Le modèle IA n’a pas produit d’appel d’outil exploitable pour préparer la création : aucune instance n’a été créée. Vérifie que le modèle chargé dans le moteur IA prend en charge les appels d’outils (tool use), puis réessaie en précisant le jeu et la version (par exemple « crée un serveur Minecraft Paper 1.21 »)."
    : 'The AI model did not produce a usable tool call to prepare the creation: no instance was created. Check that the model loaded in the AI engine supports tool calls, then retry with the game and version (for example "create a Minecraft Paper 1.21 server").';
}

export function instanceScopePrompt(
  scope?: AiConversation["instanceScope"],
  options: { commands?: boolean; admin?: boolean } = {}
): string {
  if (!scope) return "";
  const base =
    "You are the MCSManager assistant dedicated to one instance: " +
    `"${scope.nickname || scope.instanceUuid}". Answer in the user's language. You can only ` +
    "act on this instance, through the listed tools: start or stop it, list its files, read " +
    `them and propose edits with ${EDIT_FILE_TOOL}. Paths are relative to the instance ` +
    `directory. Use ${LIST_FILES_TOOL} when you do not know where a file is, always ` +
    `${READ_FILE_TOOL} before editing, copy the exact text to replace into \`find\`, and ` +
    "change only what the user asked. To install or update a plugin (or a mod on Fabric/Forge " +
    `servers), call ${SEARCH_PLUGINS_TOOL} with its name, then ${INSTALL_PLUGIN_TOOL} with the ` +
    "projectId and source of the best matching result. The panel detects the server software " +
    "and Minecraft version and picks a compatible version itself: never ask the user for the " +
    "version, a download link or a file. Do not ask for confirmation yourself: the panel shows " +
    "the exact change or action and asks the user. If the user asks about other instances or " +
    "about creating servers, tell them to use the main Local AI page. Never claim an action " +
    "succeeded unless the tool result confirms it, and never invent file contents.";
  if (!options.commands) return base;
  return (
    base +
    "\n\nYou CAN run commands on this instance through tools; never answer that you cannot run " +
    "commands or that the user must open a terminal or SSH when a tool covers the request: " +
    `${CONSOLE_COMMAND_TOOL} sends a non-administrator command to the running server console ` +
    `(allowed: ${consoleAllowlist().join(", ") || "none"}); ${INSTANCE_COMMAND_TOOL} runs ls, ` +
    "cat, head, tail, wc, grep, find, du, mkdir, touch, cp, mv, rm, zip or unzip inside the " +
    `instance folder; ${UPDATE_INSTANCE_TOOL} runs the update command configured by an ` +
    `administrator; ${INSTALL_LOADER_TOOL} installs Forge, NeoForge or Fabric from the official ` +
    "installer (the equivalent of `java -jar forge-<version>-installer.jar --installServer`)" +
    (options.admin
      ? `; ${SETTINGS_TOOL} changes the instance settings (start/stop/update commands, ` +
        "encodings, Java, automatic restart)" +
        `; ${ADMIN_COMMAND_TOOL} gives you a real shell on the daemon machine starting in the ` +
        "instance folder (PowerShell or cmd on Windows, sh or bash on Linux), because the user " +
        "is an administrator: use it whenever a command is needed and no other tool fits"
      : "") +
    ". Each command is shown to the user and runs only after they answer yes." +
    "\n\nThe instance can be any game: Minecraft Java with any server software (Paper, Spigot, " +
    "Purpur, Fabric, Quilt, Forge, NeoForge, vanilla...), Minecraft Bedrock, or another game " +
    `(Steam, etc.). Read its type and daemon OS with ${INSTANCE_INFO_TOOL} and adapt: Minecraft ` +
    "fixes and console commands only apply to Minecraft. For a Docker instance, commands run " +
    "inside its Linux container (sh/bash), whatever the host OS." +
    "\n\nTroubleshooting: be ready to fix any problem yourself. When something is wrong, first " +
    `call ${INSTANCE_INFO_TOOL} and ${READ_CONSOLE_TOOL}, then list and read the relevant files ` +
    "(for Minecraft: logs/latest.log, crash-reports, server.properties, eula.txt, " +
    "user_jvm_args.txt; for other games their logs and configuration files). Then " +
    "propose the fix with the right tool, one action at a time: EULA not accepted -> set " +
    "eula=true in eula.txt; UnsupportedClassVersionError or 'requires Java N' -> another Java " +
    "(javaId); port already in use / FAILED TO BIND -> change server-port in server.properties " +
    "or stop the other process; OutOfMemoryError -> raise -Xmx in user_jvm_args.txt or the start " +
    "command; start command that cannot work on the daemon OS -> fix it; mod or plugin crash -> " +
    "read the crash report and remove, move or update the faulty jar; corrupted config -> fix " +
    "the file; stuck instance -> kill then start. After the user confirmed a fix, offer to start " +
    "or restart the instance and read the console again to check. If a fix needs an " +
    "administrator-only tool and the user is not an administrator, tell them exactly what an " +
    "administrator must change." +
    " Before diagnosing a start failure, read the end of the console and list the instance files: " +
    "for example a start command `sh ./run.sh` cannot work on a Windows daemon, and modern " +
    "Forge/NeoForge servers have no server.jar. When the start command must change, use " +
    `exactly the suggestedStartCommand returned by ${INSTANCE_INFO_TOOL} or ${READ_CONSOLE_TOOL} ` +
    "(computed by the panel from the installed files: Forge, NeoForge, Fabric, Quilt, Paper, " +
    "Spigot, Purpur, vanilla, Bedrock...); when it is empty, read the files and build the " +
    "command from what really exists. Never write placeholders such as <version> in a command: find " +
    "the real value first. Do not recommend run.bat or run.sh, which end with `pause` or need a " +
    "shell and keep the instance stuck after the server stops. Only an administrator can change " +
    `the start command (${SETTINGS_TOOL}); otherwise tell the user the exact command to set.`
  );
}

const FILE_EDIT_ERRORS: Record<string, [string, string]> = {
  "No instance selected": [
    "ouvre l’assistant depuis la page d’une instance pour modifier ses fichiers",
    "open the assistant from an instance page to edit its files"
  ],
  "Forbidden resource": [
    "tu n’as pas accès à cette instance",
    "you do not have access to this instance"
  ],
  "File management is disabled": [
    "la gestion de fichiers est désactivée pour les utilisateurs",
    "file management is disabled for users"
  ],
  "Daemon unavailable": [
    "le daemon de cette instance n’est pas disponible",
    "the instance daemon is unavailable"
  ],
  "Invalid path": ["le chemin de fichier est invalide", "the file path is invalid"],
  "Invalid edit": ["la modification proposée est invalide", "the proposed change is invalid"],
  "Edit text not found": [
    "le texte à remplacer n’a pas été trouvé dans le fichier",
    "the text to replace was not found in the file"
  ],
  "Edit text is ambiguous": [
    "le texte à remplacer apparaît plusieurs fois dans le fichier",
    "the text to replace appears several times in the file"
  ],
  "File too large": ["le fichier est trop volumineux", "the file is too large"],
  "Binary file": ["ce fichier n’est pas un fichier texte", "this is not a text file"],
  "File could not be read": ["le fichier n’a pas pu être lu", "the file could not be read"],
  "No change": ["le fichier contient déjà ce contenu", "the file already has this content"],
  "File changed since preview": [
    "le fichier a été modifié depuis l’aperçu ; redemande la modification",
    "the file changed since the preview; ask again"
  ],
  "File could not be written": [
    "le daemon n’a pas pu écrire le fichier",
    "the daemon could not write the file"
  ]
};

const COMMAND_ERRORS: Record<string, [string, string]> = {
  "No instance selected": [
    "ouvre l’assistant depuis la page d’une instance",
    "open the assistant from an instance page"
  ],
  "Forbidden resource": [
    "tu n’as pas accès à cette instance",
    "you do not have access to this instance"
  ],
  "AI access required": ["ton accès à l’IA n’est pas accordé", "your AI access is not granted"],
  "Administrator permission required": [
    "cette commande est réservée aux administrateurs",
    "this command is reserved for administrators"
  ],
  "File management is disabled": [
    "la gestion de fichiers est désactivée pour les utilisateurs",
    "file management is disabled for users"
  ],
  "Daemon unavailable": [
    "le daemon de cette instance n’est pas disponible",
    "the instance daemon is unavailable"
  ],
  "Invalid command": ["la commande est invalide", "the command is invalid"],
  "Several commands": ["une seule commande à la fois", "only one command at a time"],
  "Namespaced command": [
    "les commandes de plugins (préfixe « plugin: ») ne sont pas autorisées",
    'plugin commands ("plugin:" prefix) are not allowed'
  ],
  "Command not allowed": [
    "cette commande n’est pas dans la liste des commandes autorisées (commandes non admin)",
    "this command is not in the allowed (non-administrator) commands"
  ],
  "Ban command": [
    "les bannissements passent par « Bannir un joueur » sur la page de l’instance",
    'bans go through "Ban a player" on the instance page'
  ],
  "Instance not running": ["le serveur doit être démarré", "the server must be running"],
  "Instance must be stopped": [
    "l’instance doit d’abord être arrêtée",
    "the instance must be stopped first"
  ],
  "Unknown command": [
    "cette commande n’existe pas ici (ce n’est pas un vrai shell)",
    "this command is not available (this is not a real shell)"
  ],
  "Invalid arguments": ["les arguments sont invalides", "the arguments are invalid"],
  "Unsupported option": ["cette option n’est pas prise en charge", "this option is not supported"],
  "Invalid path": [
    "le chemin est invalide ou sort du dossier de l’instance",
    "the path is invalid or leaves the instance folder"
  ],
  "Refused path": ["ce chemin est protégé", "this path is protected"],
  "Instance folder is a disk root": [
    "le dossier de l’instance est la racine d’un disque, les commandes de fichiers y sont refusées",
    "the instance folder is a disk root, file commands are refused there"
  ],
  "No update command": [
    "aucune commande de mise à jour n’est configurée (un administrateur doit la définir)",
    "no update command is configured (an administrator must set one)"
  ],
  "Unknown loader": ["ce loader n’est pas pris en charge", "this loader is not supported"],
  "Invalid Minecraft version": [
    "la version de Minecraft est invalide",
    "the Minecraft version is invalid"
  ],
  "Invalid loader version": ["la version du loader est invalide", "the loader version is invalid"],
  "Version not found": [
    "cette version est introuvable dans le dépôt officiel",
    "this version was not found in the official repository"
  ],
  "Checksum unavailable": [
    "la somme de contrôle officielle est introuvable",
    "the official checksum is unavailable"
  ],
  "Loader metadata unavailable": [
    "le dépôt officiel est injoignable",
    "the official repository is unreachable"
  ],
  "Timed out": [
    "la commande a dépassé le délai et a été arrêtée",
    "the command exceeded its time limit and was stopped"
  ],
  "Unknown Java": [
    "ce Java n’est pas installé sur ce daemon (voir la liste dans les infos de l’instance)",
    "this Java is not installed on this daemon (see the list in the instance info)"
  ],
  "Invalid settings": [
    "les paramètres proposés sont invalides",
    "the proposed settings are invalid"
  ],
  "No change": ["ces paramètres ont déjà ces valeurs", "these settings already have these values"],
  "Not a Minecraft Java instance": [
    "Forge, NeoForge et Fabric ne s’installent que sur une instance Minecraft Java",
    "Forge, NeoForge and Fabric can only be installed on a Minecraft Java instance"
  ],
  "Start command cannot work": [
    "cette commande de démarrage ne peut pas fonctionner sur cette instance",
    "this start command cannot work on this instance"
  ],
  "Placeholder in value": [
    "la valeur contient un texte à remplacer (comme <version>) au lieu de la vraie valeur",
    "the value contains a placeholder (such as <version>) instead of the real value"
  ],
  "Shell not available": [
    "ce shell n’existe pas sur la machine du daemon (PowerShell/cmd sous Windows, sh/bash sous Linux)",
    "this shell is not available on the daemon machine (PowerShell/cmd on Windows, sh/bash on Linux)"
  ],
  "Command failed": ["la commande a échoué", "the command failed"]
};

/** Keeps panel-authored code fences intact around untrusted output. */
const fenceSafe = (text: unknown) => String(text ?? "").replace(/```/g, "ʼʼʼ");

const COMMAND_INTRO: Record<string, [string, string]> = {
  console: [
    "Je vais envoyer cette commande à la console du serveur",
    "I will send this command to the server console"
  ],
  file: [
    "Je vais exécuter cette commande dans le dossier de l’instance",
    "I will run this command in the instance folder"
  ],
  update: [
    "Je vais lancer la commande de mise à jour configurée",
    "I will run the configured update command"
  ],
  settings: [
    "Je vais modifier ces paramètres de l’instance",
    "I will change these instance settings"
  ],
  restart: ["Je vais redémarrer l’instance", "I will restart the instance"],
  kill: [
    "Je vais forcer l’arrêt de l’instance (le serveur est tué sans sauvegarde)",
    "I will force-stop the instance (the server is killed without saving)"
  ],
  admin: [
    "Je vais exécuter cette commande (administrateur) dans le dossier de l’instance",
    "I will run this administrator command in the instance folder"
  ]
};

/** Deterministic, panel-authored text for the command tools. */
export function formatCommandResult(result: AiToolResult, french: boolean): string {
  const data = result.data || {};
  const fence = "```";
  const where = data.nickname
    ? french
      ? ` sur l’instance « ${data.nickname} »`
      : ` on instance "${data.nickname}"`
    : "";
  const command = data.display ? `\n\n${fence}\n${fenceSafe(data.display)}\n${fence}` : "";
  const output = data.output ? `\n\n${fence}\n${fenceSafe(data.output)}\n${fence}` : "";

  if (result.decision === "approved" && data.confirmationRequired) {
    const [fr, en] =
      data.kind === "loader"
        ? [
            `Je vais installer ${data.loader} ${data.loaderVersion} (Minecraft ${data.minecraftVersion}) avec l’installateur officiel, vérifié par somme de contrôle`,
            `I will install ${data.loader} ${data.loaderVersion} (Minecraft ${data.minecraftVersion}) with the official, checksum-verified installer`
          ]
        : data.kind === "admin" && data.shellLabel
          ? [
              `Je vais exécuter cette commande dans ${data.shellLabel} sur la machine du daemon, depuis le dossier de l’instance`,
              `I will run this command in ${data.shellLabel} on the daemon machine, from the instance folder`
            ]
          : COMMAND_INTRO[String(data.kind)] || COMMAND_INTRO.file;
    return french
      ? `${fr}${where} :${command}\n\nRéponds « oui » pour l’exécuter (valable 10 minutes). Tout autre message annule. Rien n’a encore été exécuté.`
      : `${en}${where}:${command}\n\nReply "yes" to run it (valid for 10 minutes). Any other message cancels it. Nothing has run yet.`;
  }

  const start = data.startCommand
    ? french
      ? `\n\nCommande de démarrage à configurer (paramètres de l’instance, réservé aux administrateurs) :\n\n${fence}\n${data.startCommand}\n${fence}`
      : `\n\nStart command to set (instance settings, administrators only):\n\n${fence}\n${data.startCommand}\n${fence}`
    : "";
  if (result.decision === "executed") {
    const empty = data.output ? "" : french ? "\n\n(aucune sortie)" : "\n\n(no output)";
    return french
      ? `C’est fait${where} :${command}${output}${empty}${start}`
      : `Done${where}:${command}${output}${empty}${start}`;
  }

  const [fr, en] = COMMAND_ERRORS[String(result.error)] || [
    "la commande a été refusée",
    "the command was refused"
  ];
  const detail = data.detail ? ` (${fenceSafe(data.detail).slice(0, 200)})` : "";
  const allowed =
    result.error === "Command not allowed" && Array.isArray(data.allowlist)
      ? french
        ? `\n\nCommandes autorisées : ${data.allowlist.join(", ") || "aucune"}.`
        : `\n\nAllowed commands: ${data.allowlist.join(", ") || "none"}.`
      : "";
  return french
    ? `Je n’ai pas exécuté la commande${where} : ${fr}${detail}.${command}${output}${allowed}`
    : `I did not run the command${where}: ${en}${detail}.${command}${output}${allowed}`;
}

/** Deterministic, panel-authored text for file edit outcomes. */
export function formatFileEditResult(result: AiToolResult, french: boolean): string {
  const data = result.data || {};
  const where = data.nickname
    ? french
      ? ` (instance « ${data.nickname} »)`
      : ` (instance "${data.nickname}")`
    : "";
  const file = data.path ? `\`${data.path}\`` : "";
  const fence = "```";
  if (result.decision === "approved" && data.confirmationRequired) {
    return french
      ? `Je propose ${
          data.newFile ? "de créer" : "de modifier"
        } ${file}${where} :\n\n${fence}diff\n${
          data.preview
        }\n${fence}\n\nRéponds « oui » pour appliquer exactement cette modification (valable 10 minutes). Tout autre message l’annule. Rien n’a encore été écrit.`
      : `I propose to ${data.newFile ? "create" : "change"} ${file}${where}:\n\n${fence}diff\n${
          data.preview
        }\n${fence}\n\nReply "yes" to apply exactly this change (valid for 10 minutes). Any other message cancels it. Nothing has been written yet.`;
  }
  if (result.decision === "executed") {
    return french
      ? `C’est fait : ${file} a été ${
          data.newFile ? "créé" : "modifié"
        }${where}. Un redémarrage de l’instance peut être nécessaire pour que le changement soit pris en compte.`
      : `Done: ${file} was ${
          data.newFile ? "created" : "updated"
        }${where}. The instance may need a restart for the change to apply.`;
  }
  const [fr, en] = FILE_EDIT_ERRORS[String(result.error)] || [
    "la modification n’a pas pu être préparée",
    "the change could not be prepared"
  ];
  return french
    ? `Je n’ai pas modifié le fichier${
        file ? ` ${file}` : ""
      } : ${fr}. Aucun fichier n’a été écrit.`
    : `I did not change the file${file ? ` ${file}` : ""}: ${en}. No file was written.`;
}

/** Deterministic, panel-authored text for the stop action. */
export function formatStopResult(result: AiToolResult, french: boolean): string {
  const data = result.data || {};
  const name = data.nickname || data.instanceUuid || "";
  if (result.decision === "approved" && data.confirmationRequired) {
    return french
      ? `Je vais arrêter l’instance « ${name} ». Réponds « oui » pour confirmer (valable 10 minutes). Tout autre message annule.`
      : `I will stop the instance "${name}". Reply "yes" to confirm (valid for 10 minutes). Any other message cancels it.`;
  }
  if (result.decision === "executed") {
    return french
      ? `La demande d’arrêt de l’instance « ${name} » a été envoyée au daemon.`
      : `The stop request for instance "${name}" was sent to the daemon.`;
  }
  return french
    ? `Je n’ai pas arrêté l’instance${
        name ? ` « ${name} »` : ""
      } : la demande a été refusée ou a échoué (${result.error}).`
    : `I did not stop the instance${name ? ` "${name}"` : ""}: the request was refused or failed (${
        result.error
      }).`;
}

/** "installe le plugin ViaVersion", "add the LuckPerms plugin", "mets à jour EssentialsX"... */
/** An assistant answer claiming it cannot run commands ("je ne peux pas exécuter…"). */
export function isCommandRefusal(text: string): boolean {
  return /(je ne peux pas|je n.ai pas la possibilit|je ne suis pas en mesure|i cannot|i can.t|i am unable|i'm unable|unable to)[^.\n]{0,80}(ex[ée]cut|lancer|run|command|shell|terminal)/i.test(
    String(text ?? "")
  );
}

export function isPluginInstallRequest(message: string): boolean {
  return (
    /(^|[^\p{L}])(installe[rz]?|install|ajoute[rz]?|add|mets?|télécharge[rz]?|telecharge[rz]?|download|update|mets? à jour|mettre à jour)([^\p{L}]|$)/iu.test(
      message
    ) &&
    /(^|[^\p{L}])(plugins?|mods?|via-?version|viabackwards|geyser|floodgate|luckperms|essentialsx?|worldedit|worldguard|vault|placeholderapi)([^\p{L}]|$)/iu.test(
      message
    )
  );
}

const PLUGIN_ERRORS: Record<string, [string, string]> = {
  "Plugin search failed": [
    "les sources de plugins MCSManager sont injoignables",
    "the MCSManager plugin sources are unreachable"
  ],
  "Plugin not found": [
    "ce plugin est introuvable dans les sources MCSManager",
    "this plugin was not found in the MCSManager sources"
  ],
  "Unsupported server": [
    "je n’ai pas pu déterminer si ce serveur accepte des plugins ou des mods",
    "I could not tell whether this server runs plugins or mods"
  ],
  "No compatible version": [
    "aucune version de ce plugin n’est compatible avec ce serveur",
    "no version of this plugin is compatible with this server"
  ],
  "Version not compatible": [
    "cette version n’est pas compatible avec ce serveur",
    "this version is not compatible with this server"
  ],
  "Version not found": ["cette version est introuvable", "this version was not found"],
  "Unsafe download": [
    "le lien de téléchargement ne provient pas d’une source autorisée",
    "the download link does not come from an allowed source"
  ],
  "Already installed": ["cette version est déjà installée", "this version is already installed"],
  "Several copies installed": [
    "plusieurs copies de ce plugin sont déjà présentes, supprime les doublons d’abord",
    "several copies of this plugin are already installed, remove the duplicates first"
  ],
  "Install failed": ["le daemon a refusé le téléchargement", "the daemon refused the download"],
  "Download failed": ["le téléchargement a échoué", "the download failed"]
};

function serverLabel(server: any, french: boolean) {
  if (!server) return "";
  const loader = server.loader
    ? server.loader.charAt(0).toUpperCase() + server.loader.slice(1)
    : french
      ? "serveur"
      : "server";
  return server.mcVersion ? `${loader} ${server.mcVersion}` : loader;
}

/** Deterministic, panel-authored text for plugin installation outcomes. */
export function formatPluginInstallResult(result: AiToolResult, french: boolean): string {
  const data = result.data || {};
  const name = `${data.title ?? ""} ${data.version ?? ""}`.trim();
  const server = serverLabel(data.server, french);
  const where = data.nickname
    ? french
      ? ` de l’instance « ${data.nickname} »`
      : ` of instance "${data.nickname}"`
    : "";
  if (result.decision === "approved" && data.confirmationRequired) {
    const replaces = data.replaces
      ? french
        ? `\n- Remplace : \`${data.replaces}\``
        : `\n- Replaces: \`${data.replaces}\``
      : "";
    const unverified = data.verified
      ? ""
      : french
        ? "\n\nLa source ne précise pas les versions compatibles : vérifie la console après le redémarrage."
        : "\n\nThe source does not state compatible versions: check the console after restarting.";
    return french
      ? `Je peux installer **${name}** (${data.source}) dans \`${data.folder}/\`${where} :\n\n- Fichier : \`${data.fileName}\`\n- Serveur détecté : ${server}${replaces}${unverified}\n\nRéponds « oui » pour installer exactement cette version (valable 10 minutes). Tout autre message annule. Rien n’a encore été téléchargé.`
      : `I can install **${name}** (${data.source}) into \`${data.folder}/\`${where}:\n\n- File: \`${data.fileName}\`\n- Detected server: ${server}${replaces}${unverified}\n\nReply "yes" to install exactly this version (valid for 10 minutes). Any other message cancels it. Nothing has been downloaded yet.`;
  }
  if (result.decision === "executed") {
    if (data.completed) {
      return french
        ? `${name} est installé dans \`${data.folder}/${data.fileName}\`. Redémarre l’instance pour charger le plugin.`
        : `${name} is installed in \`${data.folder}/${data.fileName}\`. Restart the instance to load it.`;
    }
    return french
      ? `Le téléchargement de ${name} a été lancé par le daemon mais n’était pas encore terminé. Vérifie dans le gestionnaire de plugins de l’instance avant de redémarrer.`
      : `The daemon started downloading ${name} but it had not finished yet. Check the instance plugin manager before restarting.`;
  }
  const [fr, en] = PLUGIN_ERRORS[String(result.error)] ||
    FILE_EDIT_ERRORS[String(result.error)] || [
      "l’installation n’a pas pu être préparée",
      "the installation could not be prepared"
    ];
  const detected = server
    ? french
      ? ` (serveur détecté : ${server})`
      : ` (detected server: ${server})`
    : "";
  return french
    ? `Je n’ai pas installé ${name || "le plugin"} : ${fr}${detected}. Rien n’a été installé.`
    : `I did not install ${name || "the plugin"}: ${en}${detected}. Nothing was installed.`;
}

export function formatToolOutcome(result: AiToolResult, french: boolean): string {
  if (COMMAND_TOOLS.has(result.tool)) return formatCommandResult(result, french);
  if (result.tool === INSTALL_PLUGIN_TOOL) return formatPluginInstallResult(result, french);
  if (result.tool === EDIT_FILE_TOOL) return formatFileEditResult(result, french);
  if (result.tool === "stop_instance") return formatStopResult(result, french);
  return formatCreationResult(result, french);
}

function isCreateCall(call: any) {
  const name = String(call?.function?.name || "");
  return name === CREATE_TOOL || name === "create_minecraft_server";
}

export class LocalAiService {
  private queue: QueueItem[] = [];
  private processing = false;
  private processingItem: QueueItem | null = null;
  private recoveryComplete = false;
  private purgeTimer?: NodeJS.Timeout;

  async initialize() {
    if (this.recoveryComplete) return;
    this.recoveryComplete = true;
    this.startRetentionTimer();
    for (const uuid of await Storage.getStorage().list("AiRequest")) {
      const record = await Storage.getStorage().load("AiRequest", AiRequestRecord, uuid);
      if (record?.state === "processing") {
        record.state = "failed";
        record.errorCode = "server_restart";
        record.completedAt = new Date().toISOString();
        await Storage.getStorage().store("AiRequest", uuid, record);
      }
    }
    await this.purgeExpired().catch((error) =>
      logger.warn(`[LOCAL_AI] History cleanup failed: ${String(error?.message || error)}`)
    );
  }

  // ---- Conversation history retention -------------------------------------------------

  retentionMs() {
    const minutes = Number(systemConfig?.aiConversationRetentionMinutes) || 120;
    return Math.max(1, minutes) * 60 * 1000;
  }

  reportRetentionMs() {
    const days = Number(systemConfig?.aiReportRetentionDays) || 7;
    return Math.max(1, Math.min(90, days)) * 24 * 60 * 60 * 1000;
  }

  /** A conversation expires a fixed time after its last activity (last message). */
  expiresAt(
    conversation: Pick<AiConversation, "updatedAt" | "createdAt"> & { kind?: string }
  ): string {
    const last = Date.parse(conversation.updatedAt || conversation.createdAt);
    const retention =
      conversation.kind === "report" ? this.reportRetentionMs() : this.retentionMs();
    return new Date((Number.isNaN(last) ? Date.now() : last) + retention).toISOString();
  }

  hasActiveRequest(conversationUuid: string) {
    return (
      this.queue.some((item) => item.record.conversationUuid === conversationUuid) ||
      this.processingItem?.record.conversationUuid === conversationUuid
    );
  }

  private isExpired(conversation: AiConversation, now = Date.now()) {
    return (
      Date.parse(this.expiresAt(conversation)) <= now && !this.hasActiveRequest(conversation.uuid)
    );
  }

  private async removeConversation(conversation: AiConversation) {
    await Storage.getStorage().delete("AiConversation", conversation.uuid);
    aiToolService.forgetConversation(conversation.ownerUserUuid, conversation.uuid);
  }

  /** Deletes expired conversations and finished request records. Returns the count removed. */
  async purgeExpired(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const uuid of await Storage.getStorage().list("AiConversation")) {
      const conversation = await this.loadConversation(uuid);
      if (conversation && this.isExpired(conversation, now)) {
        await this.removeConversation(conversation);
        removed++;
      }
    }
    for (const uuid of await Storage.getStorage().list("AiRequest")) {
      const record: AiRequestRecord | null = await Storage.getStorage().load(
        "AiRequest",
        AiRequestRecord,
        uuid
      );
      if (!record || record.state === "queued" || record.state === "processing") continue;
      const finished = Date.parse(record.completedAt || record.submittedAt);
      if (!Number.isNaN(finished) && finished + this.retentionMs() <= now) {
        await Storage.getStorage().delete("AiRequest", uuid);
      }
    }
    if (removed > 0) logger.info(`[LOCAL_AI] Deleted ${removed} expired AI conversation(s)`);
    return removed;
  }

  private startRetentionTimer() {
    if (this.purgeTimer) return;
    this.purgeTimer = setInterval(
      () => {
        this.purgeExpired().catch((error) =>
          logger.warn(`[LOCAL_AI] History cleanup failed: ${String(error?.message || error)}`)
        );
      },
      5 * 60 * 1000
    );
    this.purgeTimer.unref?.();
  }

  /** API view of a conversation, with its deletion time. */
  withExpiry<T extends AiConversation>(conversation: T): T & { expiresAt: string } {
    return { ...conversation, expiresAt: this.expiresAt(conversation) };
  }

  getConfig() {
    return {
      enabled: Boolean(systemConfig?.aiEnabled),
      engineType: systemConfig?.aiEngineType || "openai",
      baseUrl: systemConfig?.aiBaseUrl || "",
      model: systemConfig?.aiModel || "",
      temperature: systemConfig?.aiTemperature ?? 0.2,
      maxTokens: systemConfig?.aiMaxTokens ?? 2048,
      timeoutMs: systemConfig?.aiTimeoutMs ?? 120000,
      queueCapacity: systemConfig?.aiQueueCapacity ?? 50,
      maxConcurrent: systemConfig?.aiMaxConcurrent ?? 1,
      maxConversationMessages: systemConfig?.aiMaxConversationMessages ?? 200,
      maxMessageChars: systemConfig?.aiMaxMessageChars ?? 50000,
      conversationRetentionMinutes: systemConfig?.aiConversationRetentionMinutes ?? 120,
      reportRetentionDays: systemConfig?.aiReportRetentionDays ?? 7,
      visionEnabled: Boolean(systemConfig?.aiVisionEnabled),
      consoleCommandAllowlist: consoleAllowlist()
    };
  }

  async updateConfig(input: any) {
    if (!systemConfig) throw new Error("System configuration is unavailable");
    const baseUrl =
      typeof input.baseUrl === "string" ? validateEngineUrl(input.baseUrl) : undefined;
    if (input.enabled != null) systemConfig.aiEnabled = Boolean(input.enabled);
    if (typeof input.engineType === "string") systemConfig.aiEngineType = input.engineType;
    if (baseUrl) systemConfig.aiBaseUrl = baseUrl;
    if (typeof input.model === "string") systemConfig.aiModel = input.model.slice(0, 128);
    if (typeof input.temperature === "number") {
      systemConfig.aiTemperature = Math.max(0, Math.min(2, input.temperature));
    }
    if (typeof input.maxTokens === "number") {
      systemConfig.aiMaxTokens = Math.max(64, Math.min(32768, Math.floor(input.maxTokens)));
    }
    if (typeof input.timeoutMs === "number") {
      systemConfig.aiTimeoutMs = Math.max(1000, Math.min(900000, Math.floor(input.timeoutMs)));
    }
    if (typeof input.queueCapacity === "number") {
      systemConfig.aiQueueCapacity = Math.max(1, Math.min(500, Math.floor(input.queueCapacity)));
    }
    if (typeof input.conversationRetentionMinutes === "number") {
      systemConfig.aiConversationRetentionMinutes = Math.max(
        10,
        Math.min(10080, Math.floor(input.conversationRetentionMinutes))
      );
    }
    if (typeof input.visionEnabled === "boolean")
      systemConfig.aiVisionEnabled = input.visionEnabled;
    if (input.consoleCommandAllowlist != null) {
      systemConfig.aiConsoleCommandAllowlist = normalizeConsoleAllowlist(
        input.consoleCommandAllowlist
      );
    }
    if (typeof input.reportRetentionDays === "number") {
      systemConfig.aiReportRetentionDays = Math.max(
        1,
        Math.min(90, Math.floor(input.reportRetentionDays))
      );
    }
    if (typeof input.maxConcurrent === "number") {
      systemConfig.aiMaxConcurrent = Math.max(1, Math.min(1, Math.floor(input.maxConcurrent)));
    }
    await Storage.getStorage().store("SystemConfig", "config", systemConfig);
  }

  async listModels(): Promise<string[]> {
    if (!systemConfig?.aiEnabled) throw new Error("Local AI is disabled");
    const baseUrl = validateEngineUrl(systemConfig.aiBaseUrl);
    const response: AxiosResponse = await axios.get(`${baseUrl}/models`, { timeout: 10000 });
    const data = response.data?.data;
    if (!Array.isArray(data)) return [];
    return data
      .map((item: any) => String(item?.id || ""))
      .filter((value: string) => value.length > 0)
      .slice(0, 128);
  }

  async status() {
    const enabled = Boolean(systemConfig?.aiEnabled);
    return {
      enabled,
      connected: false,
      state: enabled ? "configured" : "disconnected",
      model: systemConfig?.aiModel || "",
      conversationRetentionMinutes: Math.round(this.retentionMs() / 60000),
      reportRetentionDays: Math.round(this.reportRetentionMs() / 86400000)
    };
  }

  async createConversation(
    ownerUuid: string,
    title = "New conversation",
    scope?: { daemonId?: unknown; instanceUuid?: unknown },
    kind: AiConversation["kind"] = "chat"
  ): Promise<AiConversation> {
    const conversation = new AiConversation();
    conversation.kind = kind;
    conversation.instanceScope = undefined;
    if (scope?.daemonId != null || scope?.instanceUuid != null) {
      const daemonId = typeof scope.daemonId === "string" ? scope.daemonId.trim() : "";
      const instanceUuid = typeof scope.instanceUuid === "string" ? scope.instanceUuid.trim() : "";
      const user = userSystem.getInstance(ownerUuid);
      if (
        !daemonId ||
        !instanceUuid ||
        daemonId.length > 128 ||
        instanceUuid.length > 128 ||
        !user ||
        !isHaveInstance(user, daemonId, instanceUuid)
      ) {
        throw new Error("Instance not accessible");
      }
      const nickname = (await getInstanceNameSafely(daemonId, instanceUuid))?.slice(0, 100);
      conversation.instanceScope = { daemonId, instanceUuid, ...(nickname ? { nickname } : {}) };
      if (title === "New conversation" || !title.trim()) {
        title = `AI - ${nickname || instanceUuid}`;
      }
    }
    conversation.uuid = v4().replace(/-/g, "");
    conversation.ownerUserUuid = ownerUuid;
    conversation.title = title.trim().slice(0, 80) || "New conversation";
    conversation.createdAt = new Date().toISOString();
    conversation.updatedAt = conversation.createdAt;
    await Storage.getStorage().store("AiConversation", conversation.uuid, conversation);
    return conversation;
  }

  async listConversations(ownerUuid: string): Promise<AiConversation[]> {
    const result: AiConversation[] = [];
    for (const uuid of await Storage.getStorage().list("AiConversation")) {
      const conversation = await this.loadConversation(uuid);
      if (conversation?.ownerUserUuid !== ownerUuid) continue;
      if (this.isExpired(conversation)) {
        await this.removeConversation(conversation);
        continue;
      }
      result.push(conversation);
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getConversation(ownerUuid: string, uuid: string): Promise<AiConversation | null> {
    const conversation = await this.loadConversation(uuid);
    if (!conversation || conversation.ownerUserUuid !== ownerUuid) return null;
    // Expired conversations are gone even before the periodic cleanup runs.
    if (this.isExpired(conversation)) {
      await this.removeConversation(conversation);
      return null;
    }
    return conversation;
  }

  private async loadConversation(uuid: string): Promise<AiConversation | null> {
    const conversation: AiConversation | null = await Storage.getStorage().load(
      "AiConversation",
      AiConversation,
      uuid
    );
    return conversation ? normalizeInstanceScope(conversation) : null;
  }

  async renameConversation(ownerUuid: string, uuid: string, title: string) {
    const conversation = await this.getConversation(ownerUuid, uuid);
    if (!conversation) return false;
    conversation.title = title.trim().slice(0, 80) || conversation.title;
    conversation.updatedAt = new Date().toISOString();
    await Storage.getStorage().store("AiConversation", uuid, conversation);
    return true;
  }

  async deleteConversation(ownerUuid: string, uuid: string) {
    const conversation = await this.getConversation(ownerUuid, uuid);
    if (!conversation) return false;
    await this.removeConversation(conversation);
    return true;
  }

  getQueue(ownerUuid: string) {
    const queued = this.queue.map((item) => item.record);
    const userRequests = queued.filter((record) => record.userUuid === ownerUuid);
    return {
      pending: queued.filter((record) => record.state === "queued").length,
      processing: this.processing,
      current:
        this.processingItem?.record.userUuid === ownerUuid ? this.processingItem.record : null,
      requests: userRequests
    };
  }

  /** Adds a panel-written message (e.g. a scheduled report with nothing to analyze). */
  async appendMessage(
    ownerUuid: string,
    conversationUuid: string,
    content: string,
    role: "user" | "assistant" = "assistant"
  ) {
    const conversation = await this.getConversation(ownerUuid, conversationUuid);
    if (!conversation) return false;
    const now = new Date().toISOString();
    conversation.messages.push({
      id: v4().replace(/-/g, ""),
      role,
      content: content.slice(0, systemConfig?.aiMaxMessageChars ?? 50000),
      createdAt: now
    });
    conversation.updatedAt = now;
    await Storage.getStorage().store("AiConversation", conversationUuid, conversation);
    return true;
  }

  async submit(
    ownerUuid: string,
    conversationUuid: string,
    content: string,
    options: SubmitOptions = {}
  ) {
    if (!systemConfig?.aiEnabled) throw new Error("Local AI is disabled");
    const conversation = await this.getConversation(ownerUuid, conversationUuid);
    if (!conversation) throw new Error("Conversation not found");
    const maxMessages = systemConfig.aiMaxConversationMessages;
    const maxChars = systemConfig.aiMaxMessageChars;
    if (typeof content !== "string" || content.length === 0 || content.length > maxChars) {
      throw new Error("Invalid message");
    }
    if (conversation.messages.length >= maxMessages) {
      throw new Error("Conversation size limit reached");
    }

    if (this.queue.length >= systemConfig.aiQueueCapacity) {
      throw new Error("AI queue is full");
    }

    const now = new Date().toISOString();
    const record = new AiRequestRecord();
    record.uuid = v4().replace(/-/g, "");
    record.userUuid = ownerUuid;
    record.conversationUuid = conversationUuid;
    record.model = systemConfig.aiModel;
    record.state = "queued";
    record.priority = "normal";
    record.submittedAt = now;
    record.position = this.queue.length + 1;

    await Storage.getStorage().store("AiRequest", record.uuid, record);

    const userMessage: AiMessage = {
      id: v4().replace(/-/g, ""),
      role: "user",
      content,
      createdAt: now
    };
    conversation.messages.push(userMessage);
    conversation.updatedAt = now;
    await Storage.getStorage().store("AiConversation", conversationUuid, conversation);

    this.queue.push({
      record,
      abortController: new AbortController(),
      resolve: () => {},
      reject: () => {},
      prompt: content,
      ownerUuid,
      conversationUuid,
      ...(options.scheduledContext != null
        ? {
            scheduled: {
              context: options.scheduledContext,
              suffix: options.scheduledSuffix || "",
              onFinished: options.onFinished,
              transform: options.transformAnswer,
              ...(options.moderationSystemPrompt
                ? {
                    moderation: {
                      system: options.moderationSystemPrompt,
                      images: options.images || []
                    }
                  }
                : {})
            }
          }
        : {})
    });
    record.position = this.queue.findIndex((item) => item.record.uuid === record.uuid) + 1;
    void this.drain();
    return record;
  }

  async getRequest(ownerUuid: string, uuid: string): Promise<AiRequestRecord | null> {
    const active = this.queue.find((item) => item.record.uuid === uuid)?.record;
    if (active && active.userUuid === ownerUuid) return active;
    const record = await Storage.getStorage().load("AiRequest", AiRequestRecord, uuid);
    if (!record || record.userUuid !== ownerUuid) return null;
    return record;
  }

  async cancel(ownerUuid: string, requestUuid: string): Promise<boolean> {
    const item =
      this.queue.find((entry) => entry.record.uuid === requestUuid) ||
      (this.processingItem?.record.uuid === requestUuid ? this.processingItem : null);
    if (!item || item.ownerUuid !== ownerUuid) return false;
    item.abortController.abort();
    if (item.record.state === "queued") {
      item.record.state = "cancelled";
      item.record.completedAt = new Date().toISOString();
      await Storage.getStorage().store("AiRequest", item.record.uuid, item.record);
      this.queue = this.queue.filter((entry) => entry.record.uuid !== requestUuid);
      item.scheduled?.onFinished?.("cancelled");
      item.reject(new Error("AI request cancelled"));
      return true;
    }
    if (item.record.state === "processing") {
      item.record.state = "cancelled";
      item.record.completedAt = new Date().toISOString();
      await Storage.getStorage().store("AiRequest", item.record.uuid, item.record);
      return true;
    }
    return false;
  }

  private async drain() {
    if (this.processing) return;
    const item = this.queue.shift();
    if (!item) return;
    if (item.record.state === "cancelled") {
      void this.drain();
      return;
    }

    this.processing = true;
    this.processingItem = item;
    item.record.state = "processing";
    item.record.startedAt = new Date().toISOString();
    item.record.position = 0;
    await Storage.getStorage().store("AiRequest", item.record.uuid, item.record);
    try {
      let answer = await this.generate(item);
      if (item.scheduled?.transform) answer = item.scheduled.transform(answer);
      if (item.scheduled?.suffix) {
        answer = `${answer}${item.scheduled.suffix}`.slice(0, systemConfig?.aiMaxMessageChars);
      }
      item.record.state = "completed";
      item.record.completedAt = new Date().toISOString();
      await Storage.getStorage().store("AiRequest", item.record.uuid, item.record);

      const conversation = await this.getConversation(item.ownerUuid, item.record.conversationUuid);
      if (conversation) {
        const message: AiMessage = {
          id: v4().replace(/-/g, ""),
          role: "assistant",
          content: answer,
          createdAt: item.record.completedAt
        };
        conversation.messages.push(message);
        conversation.updatedAt = message.createdAt;
        await Storage.getStorage().store(
          "AiConversation",
          item.record.conversationUuid,
          conversation
        );
      }
      item.resolve(answer);
    } catch (error: any) {
      if (item.abortController.signal.aborted) {
        item.record.completedAt = new Date().toISOString();
        await Storage.getStorage().store("AiRequest", item.record.uuid, item.record);
        item.resolve("");
      } else {
        const timedOut = String(error?.code || "") === "ECONNABORTED";
        item.record.state = timedOut ? "timeout" : "failed";
        item.record.errorCode = timedOut ? "timeout" : "engine_error";
        item.record.completedAt = new Date().toISOString();
        await Storage.getStorage().store("AiRequest", item.record.uuid, item.record);
        if (item.scheduled) {
          // Nobody watches a scheduled run: leave the reason in the report itself.
          await this.appendMessage(
            item.ownerUuid,
            item.record.conversationUuid,
            timedOut
              ? "Le rapport n’a pas pu être généré : le moteur IA a dépassé le délai."
              : "Le rapport n’a pas pu être généré : le moteur IA a renvoyé une erreur."
          ).catch(() => undefined);
        }
        item.reject(error instanceof Error ? error : new Error("AI generation failed"));
      }
    } finally {
      this.processing = false;
      this.processingItem = null;
      try {
        item.scheduled?.onFinished?.(item.record.state);
      } catch (error: any) {
        logger.warn(`[LOCAL_AI] Scheduled callback failed: ${String(error?.message || error)}`);
      }
      await this.persistQueuePositions();
      void this.drain();
    }
  }

  private async persistQueuePositions() {
    for (let index = 0; index < this.queue.length; index++) {
      const record = this.queue[index].record;
      record.position = index + 1;
      await Storage.getStorage().store("AiRequest", record.uuid, record);
    }
  }

  private async callEngine(
    item: QueueItem,
    baseUrl: string,
    model: string,
    messages: any[],
    toolOptions: Record<string, unknown>
  ): Promise<{ message: any; finishReason: string }> {
    if (!systemConfig) throw new Error("System configuration is unavailable");
    if (item.abortController.signal.aborted) throw new Error("AI request cancelled");
    const response = await axios.post(
      `${baseUrl}/chat/completions`,
      {
        model,
        temperature: systemConfig.aiTemperature,
        max_tokens: systemConfig.aiMaxTokens,
        messages,
        ...toolOptions
      },
      {
        timeout: systemConfig.aiTimeoutMs,
        signal: item.abortController.signal
      }
    );
    const choice = response.data?.choices?.[0];
    if (!choice?.message) throw new Error("AI engine returned an invalid response");
    return { message: choice.message, finishReason: String(choice.finish_reason ?? "") };
  }

  private async generate(item: QueueItem): Promise<string> {
    if (!systemConfig) throw new Error("System configuration is unavailable");
    const conversation = await this.getConversation(item.ownerUuid, item.conversationUuid);
    if (!conversation) throw new Error("Conversation not found");
    aiToolService.prepareMessage(item.ownerUuid, item.conversationUuid, item.prompt);

    if (item.scheduled) return this.generateScheduled(item, conversation);

    const scoped = Boolean(conversation.instanceScope);
    const recoveredRequest = scoped
      ? null
      : findRecoverableCreationRequest(conversation.messages, item.prompt);
    const creationRequest =
      !scoped && aiToolService.isInstanceCreationRequest(item.prompt)
        ? item.prompt
        : recoveredRequest;
    const french = isFrenchText(`${creationRequest ?? ""} ${item.prompt}`);

    // A "yes" executes only the exact pending action that the panel presented.
    const confirmedAction = await aiToolService.executePendingConfirmation(
      item.ownerUuid,
      item.conversationUuid,
      item.prompt
    );
    if (confirmedAction) return formatToolOutcome(confirmedAction, french);
    const toolContext: AiToolContext = { instanceScope: conversation.instanceScope };
    // Only selects which tools are offered; every tool re-checks the user's permission.
    const isAdmin = (userSystem.getInstance(item.ownerUuid)?.permission ?? 0) >= ROLE.ADMIN;

    const baseUrl = validateEngineUrl(systemConfig.aiBaseUrl);
    const model = systemConfig.aiModel;
    if (!model) throw new Error("AI model is not configured");

    let creationContext = "";
    let forceCreateTool = false;
    if (creationRequest) {
      const options = await aiToolService.execute(
        item.ownerUuid,
        item.conversationUuid,
        item.prompt,
        LIST_TEMPLATES_TOOL,
        { search: creationRequest }
      );
      // Permission / catalogue problems are reported by the panel, not by the model.
      if (options.decision !== "executed") return formatCreationResult(options, french);
      if (!options.data?.availableDaemons?.length) {
        return formatCreationResult(
          { tool: CREATE_TOOL, decision: "refused", error: "Daemon unavailable" },
          french
        );
      }
      // Force the tool only when the request matches catalogue templates; otherwise let the
      // model ask which game/version the user wants.
      forceCreateTool = Boolean(options.data?.matched);
      creationContext =
        "\n\nTrusted current MCSManager catalogue options (JSON). Use only these templateId and " +
        "daemonId values: " +
        JSON.stringify(options.data);
    }

    const messages: any[] = [
      {
        role: "system",
        content: conversation.instanceScope
          ? instanceScopePrompt(conversation.instanceScope, { commands: true, admin: isAdmin })
          : "You are the local AI assistant inside MCSManager. Answer in the user's language. " +
            "You are connected to the real MCSManager panel through the listed tools. " +
            "When the user asks to inspect, start, or stop an instance, use the relevant tool; " +
            "do not claim you cannot operate MCSManager. First list accessible instances when " +
            "the target is unclear. Never invent IDs or claim an action succeeded unless the " +
            "tool result confirms it. Starting an accessible instance is allowed when requested. " +
            "Stopping an instance requires a separate confirmation. To create a new instance of " +
            "any game, call " +
            CREATE_TOOL +
            " immediately with the best matching templateId from the trusted catalogue options " +
            "(prefer the exact game, server software and version requested, and the user's " +
            "language). Do not ask for confirmation yourself: the panel validates the template " +
            "and daemon and asks the user. If the requested game is unclear or not in the " +
            "catalogue, ask the user which listed game or version they want. Never invent a " +
            "template, daemon ID, download URL, command, permission, or status." +
            creationContext
      },
      ...conversation.messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        // Earlier "I cannot run commands" answers make the model repeat itself instead of
        // calling the command tools it now has (observed with local models).
        .filter(
          (message) =>
            !(scoped && message.role === "assistant" && isCommandRefusal(message.content))
        )
        .slice(-30)
        .map((message) => ({ role: message.role, content: message.content }))
    ];

    if (forceCreateTool) {
      // LM Studio does not document the named-function form of tool_choice, so expose only
      // the creation tool and require a tool call ("required" is the portable form).
      const { message, finishReason } = await this.callEngine(item, baseUrl, model, messages, {
        tools: [aiToolService.getCreateDeclaration()],
        tool_choice: "required"
      });
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const call = toolCalls.find(isCreateCall);
      if (call) {
        const result = await aiToolService.execute(
          item.ownerUuid,
          item.conversationUuid,
          item.prompt,
          CREATE_TOOL,
          call.function?.arguments
        );
        return formatCreationResult(result, french);
      }

      logger.warn(
        `[LOCAL_AI] No create tool call request=${item.record.uuid} model=${model.slice(0, 80)} ` +
          `finish_reason=${finishReason.slice(0, 30)} tool_calls=${toolCalls.length} ` +
          `content_chars=${typeof message.content === "string" ? message.content.length : 0}; ` +
          "retrying with JSON fallback"
      );
      // Fallback for models whose tool-call output the engine could not parse: ask for the
      // same arguments as plain JSON. The panel still validates everything and confirms.
      const fallback = await this.callEngine(
        item,
        baseUrl,
        model,
        [
          ...messages,
          {
            role: "user",
            content:
              'Reply with ONLY one JSON object and no other text: {"templateId": "<templateId from ' +
              'the trusted catalogue options>", "daemonId": "<daemonId>", "nickname": "<instance ' +
              'name>"}. Choose the template that best matches my creation request.'
          }
        ],
        {}
      );
      const args = parseJsonObject(fallback.message.content);
      if (args && typeof args.templateId === "string") {
        logger.info(
          `[LOCAL_AI] JSON fallback produced creation arguments request=${item.record.uuid}`
        );
        const result = await aiToolService.execute(
          item.ownerUuid,
          item.conversationUuid,
          item.prompt,
          CREATE_TOOL,
          args
        );
        return formatCreationResult(result, french);
      }
      logger.warn(
        `[LOCAL_AI] No usable creation arguments request=${item.record.uuid} model=${model.slice(
          0,
          80
        )} ` +
          `finish_reason=${fallback.finishReason.slice(0, 30)} ` +
          `content_chars=${
            typeof fallback.message.content === "string" ? fallback.message.content.length : 0
          }`
      );
      return noUsableToolCallMessage(french);
    }

    const forcePluginSearch =
      Boolean(conversation.instanceScope) && isPluginInstallRequest(item.prompt);
    // Diagnosis may need several reads (info, console, files) before proposing a fix.
    let correctionsLeft = 2;
    for (let round = 0; round < 10; round++) {
      const declarations: readonly any[] = aiToolService.getDeclarations(toolContext, isAdmin);
      const { message } = await this.callEngine(
        item,
        baseUrl,
        model,
        messages,
        forcePluginSearch && round === 0
          ? {
              tools: declarations.filter((decl) => decl.function.name === SEARCH_PLUGINS_TOOL),
              tool_choice: "required"
            }
          : { tools: declarations, tool_choice: "auto", parallel_tool_calls: false }
      );
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
        if (typeof message.content !== "string") {
          throw new Error("AI engine returned an invalid response");
        }
        return message.content.slice(0, systemConfig.aiMaxMessageChars);
      }

      const calls = message.tool_calls.slice(0, 4);
      const actionCall = calls.find(
        (call: any) =>
          isCreateCall(call) ||
          call?.function?.name === EDIT_FILE_TOOL ||
          call?.function?.name === INSTALL_PLUGIN_TOOL ||
          call?.function?.name === "stop_instance" ||
          COMMAND_TOOLS.has(String(call?.function?.name))
      );
      if (actionCall) {
        // Outcomes of creations and file edits (confirmation request with preview, refusal,
        // daemon result) are worded by the panel, never by the model.
        const result = await aiToolService.execute(
          item.ownerUuid,
          item.conversationUuid,
          item.prompt,
          isCreateCall(actionCall) ? CREATE_TOOL : String(actionCall.function?.name),
          actionCall.function?.arguments,
          toolContext
        );
        // A command tool refused before any confirmation (invalid value, unknown Java...): the
        // model gets the error and may correct itself instead of ending its turn.
        if (
          result.decision === "refused" &&
          COMMAND_TOOLS.has(result.tool) &&
          correctionsLeft-- > 0
        ) {
          messages.push({
            role: "assistant",
            content: message.content || null,
            tool_calls: [actionCall]
          });
          messages.push({
            role: "tool",
            tool_call_id: String(actionCall?.id || ""),
            content: JSON.stringify(result)
          });
          continue;
        }
        return formatToolOutcome(result, french);
      }

      messages.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: calls
      });
      for (const call of calls) {
        const result = await aiToolService.execute(
          item.ownerUuid,
          item.conversationUuid,
          item.prompt,
          String(call?.function?.name || ""),
          call?.function?.arguments,
          toolContext
        );
        messages.push({
          role: "tool",
          tool_call_id: String(call?.id || ""),
          content: JSON.stringify(result)
        });
      }
    }

    return "I could not complete the requested operation within the tool-call limit. Please try a more specific request.";
  }

  /** Unattended scheduled run: read-only tools, panel-collected context, no confirmations. */
  private async generateScheduled(item: QueueItem, conversation: AiConversation) {
    if (!systemConfig) throw new Error("System configuration is unavailable");
    const baseUrl = validateEngineUrl(systemConfig.aiBaseUrl);
    const model = systemConfig.aiModel;
    if (!model) throw new Error("AI model is not configured");
    const moderation = item.scheduled?.moderation;
    if (moderation) {
      const content = moderation.images.length
        ? [
            { type: "text", text: item.prompt },
            ...moderation.images.map((url) => ({ type: "image_url", image_url: { url } }))
          ]
        : item.prompt;
      const { message } = await this.callEngine(
        item,
        baseUrl,
        model,
        [
          { role: "system", content: `${moderation.system}\n\n${item.scheduled?.context || ""}` },
          { role: "user", content }
        ],
        {}
      );
      if (typeof message.content !== "string") {
        throw new Error("AI engine returned an invalid response");
      }
      return message.content.slice(0, systemConfig.aiMaxMessageChars);
    }
    const toolContext: AiToolContext = {
      instanceScope: conversation.instanceScope,
      readOnly: true
    };
    const messages: any[] = [
      {
        role: "system",
        content:
          instanceScopePrompt(conversation.instanceScope) +
          scheduledRunPrompt(item.scheduled?.context || "")
      },
      { role: "user", content: item.prompt }
    ];
    for (let round = 0; round < 6; round++) {
      const { message } = await this.callEngine(item, baseUrl, model, messages, {
        tools: aiToolService.getDeclarations(toolContext),
        tool_choice: "auto",
        parallel_tool_calls: false
      });
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
        if (typeof message.content !== "string") {
          throw new Error("AI engine returned an invalid response");
        }
        return message.content.slice(0, systemConfig.aiMaxMessageChars);
      }
      const calls = message.tool_calls.slice(0, 4);
      messages.push({ role: "assistant", content: message.content || null, tool_calls: calls });
      for (const call of calls) {
        // The executor refuses anything outside READ_ONLY_TOOLS in this context.
        const result = await aiToolService.execute(
          item.ownerUuid,
          item.conversationUuid,
          item.prompt,
          String(call?.function?.name || ""),
          call?.function?.arguments,
          toolContext
        );
        messages.push({
          role: "tool",
          tool_call_id: String(call?.id || ""),
          content: JSON.stringify(result)
        });
      }
    }
    return "Le rapport n’a pas pu être terminé dans la limite d’appels d’outils.";
  }

  requireAdminFromContext(ctx: any): boolean {
    const uuid = getUserUuid(ctx);
    const user = userSystem.getInstance(uuid);
    return Boolean(user && user.permission >= ROLE.ADMIN);
  }
}

export default new LocalAiService();
