import schedule from "node-schedule";
import { v4 } from "uuid";
import Storage from "../common/storage/sys_storage";
import { FILENAME_BLACKLIST } from "../const";
import { AI_SCHEDULE_KINDS, AiScheduleKind, AiScheduleTask } from "../entity/ai";
import { systemConfig } from "../setting";
import {
  buildFileCheckContext,
  comparePluginVersions,
  FILE_CHECK_MAX_PLUGIN_CONFIGS,
  formatSyntaxErrors,
  KNOWN_CONFIG_FILES,
  CRASH_FILE_MAX_CHARS,
  crashReportFromConsole,
  CrashRecord,
  HS_ERR_MAX_CHARS,
  hsErrFromConsole,
  isCleanStop,
  pickCrashReport,
  PluginUpdateRow,
  redactSecrets,
  tailConsoleLog
} from "./ai_schedule_collectors";
import aiAccess from "./ai_access_service";
import aiToolService from "./ai_tool_service";
import localAi from "./local_ai_service";
import { logger } from "./log";
import { modManagerService } from "./mod_manager_service";
import { isHaveInstance } from "./permission_service";
import RemoteRequest from "./remote_command";
import RemoteServiceSubsystem from "./remote_service";
import userSystem from "./user_service";

export const MAX_AI_TASKS_PER_INSTANCE = 4;
export const MIN_AI_INTERVAL_SECONDS = 3600;
// setInterval cannot exceed ~24.8 days; a week is plenty for an interval trigger.
export const MAX_AI_INTERVAL_SECONDS = 7 * 24 * 3600;
export const MAX_AI_PROMPT_CHARS = 2000;

const TYPE_INTERVAL = 1;
export const TYPE_ON_CRASH = 4;
export const CRASH_RATE_LIMIT_MS = 10 * 60 * 1000;
const CRON_FIELD = /^[0-9*,/-]{1,20}$/;

export class AiScheduleError extends Error {}

export interface AiScheduleInput {
  name?: unknown;
  kind?: unknown;
  prompt?: unknown;
  type?: unknown;
  time?: unknown;
  count?: unknown;
}

/** Validates a creation request; returns the normalized fields or throws AiScheduleError. */
export function validateAiScheduleInput(
  input: AiScheduleInput,
  existing: Array<{ name: string; kind: string }>
) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 40 || FILENAME_BLACKLIST.some((ch) => name.includes(ch))) {
    throw new AiScheduleError("Invalid task name");
  }
  if (existing.some((task) => task.name === name)) {
    throw new AiScheduleError("A task with this name exists");
  }
  if (existing.length >= MAX_AI_TASKS_PER_INSTANCE) {
    throw new AiScheduleError("AI task limit reached");
  }
  const kind = String(input.kind) as AiScheduleKind;
  if (!AI_SCHEDULE_KINDS.includes(kind)) throw new AiScheduleError("Invalid task kind");
  if (kind === "crash_analysis") {
    if (existing.some((task) => task.kind === "crash_analysis")) {
      throw new AiScheduleError("A crash analysis task exists");
    }
    if (Number(input.type) !== TYPE_ON_CRASH) throw new AiScheduleError("Invalid trigger type");
  } else if (Number(input.type) === TYPE_ON_CRASH) {
    throw new AiScheduleError("Invalid trigger type");
  }
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (kind === "custom_prompt" && (!prompt || prompt.length > MAX_AI_PROMPT_CHARS)) {
    throw new AiScheduleError("Invalid instruction");
  }
  const type = Number(input.type);
  if (![1, 2, 3, TYPE_ON_CRASH].includes(type)) throw new AiScheduleError("Invalid trigger type");
  const time = type === TYPE_ON_CRASH ? "" : String(input.time ?? "").trim();
  if (type === TYPE_ON_CRASH) {
    // Fired by crash records collected from the daemon, no time expression.
  } else if (type === TYPE_INTERVAL) {
    const seconds = Number(time);
    if (
      !Number.isInteger(seconds) ||
      seconds < MIN_AI_INTERVAL_SECONDS ||
      seconds > MAX_AI_INTERVAL_SECONDS
    ) {
      throw new AiScheduleError("AI task interval must be between 1 hour and 7 days");
    }
  } else {
    const fields = time.split(" ");
    if (
      fields.length !== 6 ||
      !fields.every((field) => CRON_FIELD.test(field)) ||
      fields[0].includes("*")
    ) {
      throw new AiScheduleError("Invalid trigger time");
    }
  }
  const rawCount = input.count === "" || input.count == null ? -1 : Number(input.count);
  const count = rawCount === 0 ? -1 : rawCount;
  if (!Number.isInteger(count) || (count !== -1 && (count < 1 || count > 100000))) {
    throw new AiScheduleError("Invalid repeat count");
  }
  return { name, kind, prompt: kind === "custom_prompt" ? prompt : "", type, time, count };
}

const KIND_LABELS: Record<AiScheduleKind, string> = {
  console_report: "rapport de la console",
  file_check: "vérification des fichiers",
  plugin_updates: "mises à jour des plugins",
  custom_prompt: "consigne libre",
  crash_analysis: "analyse des plantages"
};

interface CollectedRun {
  /** Instruction shown in the report conversation and sent to the model. */
  prompt: string;
  context: string;
  suffix: string;
  /** When set, the panel writes the report itself and the model is not called. */
  directReport?: string;
  /** Nothing to report (e.g. a clean stop): no conversation is created. */
  skip?: boolean;
  title?: string;
}

interface ScheduledJob {
  cancel(): void;
}

export type AiScheduleView = Omit<AiScheduleTask, "lastRequestUuid">;

export class AiScheduleService {
  private readonly tasks = new Map<string, AiScheduleTask>();
  private readonly jobs = new Map<string, ScheduledJob>();
  // Remaining executions are kept in memory only (same semantics as instance schedules).
  private readonly remaining = new Map<string, number>();
  // Time of the last crash analysis that produced a report (rate limit of crash loops).
  private readonly lastCrashAnalysis = new Map<string, number>();
  private initialized = false;

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    for (const uuid of await Storage.getStorage().list("AiScheduleTask")) {
      const task: AiScheduleTask | null = await Storage.getStorage().load(
        "AiScheduleTask",
        AiScheduleTask,
        uuid
      );
      if (!task?.uuid) continue;
      // A run interrupted by a panel restart never reaches its completion callback.
      if (task.lastStatus === "queued") task.lastStatus = "failed";
      this.tasks.set(task.uuid, task);
      try {
        this.register(task);
      } catch (error: any) {
        logger.warn(
          `[AI_SCHEDULE] Task ${task.name} could not be scheduled: ${String(
            error?.message || error
          )}`
        );
      }
    }
  }

  list(daemonId: string, instanceUuid: string): AiScheduleView[] {
    return [...this.tasks.values()]
      .filter((task) => task.daemonId === daemonId && task.instanceUuid === instanceUuid)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(({ lastRequestUuid, ...view }) => view);
  }

  /** Every AI task (used by the approval migration). */
  allTasks(): AiScheduleTask[] {
    return [...this.tasks.values()];
  }

  find(daemonId: string, instanceUuid: string, name: string) {
    return [...this.tasks.values()].find(
      (task) =>
        task.daemonId === daemonId && task.instanceUuid === instanceUuid && task.name === name
    );
  }

  async create(
    ownerUuid: string,
    daemonId: string,
    instanceUuid: string,
    input: AiScheduleInput
  ): Promise<AiScheduleView> {
    const fields = validateAiScheduleInput(input, this.list(daemonId, instanceUuid));
    const task = new AiScheduleTask();
    Object.assign(task, fields);
    task.uuid = v4().replace(/-/g, "");
    task.ownerUserUuid = ownerUuid;
    task.daemonId = daemonId;
    task.instanceUuid = instanceUuid;
    task.createdAt = new Date().toISOString();
    this.register(task);
    this.tasks.set(task.uuid, task);
    await this.save(task);
    logger.info(`[AI_SCHEDULE] Created task ${task.name} (${task.kind}) instance=${instanceUuid}`);
    const { lastRequestUuid, ...view } = task;
    return view;
  }

  async remove(daemonId: string, instanceUuid: string, name: string) {
    const task = this.find(daemonId, instanceUuid, name);
    if (!task) return false;
    await this.removeTask(task);
    return true;
  }

  /** Called when instances are deleted from the panel. */
  async removeInstances(daemonId: string, instanceUuids: string[]) {
    for (const task of [...this.tasks.values()]) {
      if (task.daemonId === daemonId && instanceUuids.includes(task.instanceUuid)) {
        await this.removeTask(task);
      }
    }
  }

  private async removeTask(task: AiScheduleTask) {
    this.jobs.get(task.uuid)?.cancel();
    this.jobs.delete(task.uuid);
    this.remaining.delete(task.uuid);
    this.lastCrashAnalysis.delete(task.uuid);
    this.tasks.delete(task.uuid);
    await Storage.getStorage().delete("AiScheduleTask", task.uuid);
  }

  private async save(task: AiScheduleTask) {
    await Storage.getStorage().store("AiScheduleTask", task.uuid, task);
  }

  private register(task: AiScheduleTask) {
    this.jobs.get(task.uuid)?.cancel();
    if (task.disabledReason) return;
    this.remaining.set(task.uuid, task.count);
    // "On crash" tasks are fired by onCrash(), not by a timer.
    if (task.type === TYPE_ON_CRASH) return;
    const fire = () => {
      void this.fire(task).catch((error) =>
        logger.warn(`[AI_SCHEDULE] Task ${task.name} failed: ${String(error?.message || error)}`)
      );
    };
    if (task.type === TYPE_INTERVAL) {
      const timer = setInterval(fire, Number(task.time) * 1000);
      timer.unref?.();
      this.jobs.set(task.uuid, { cancel: () => clearInterval(timer) });
      return;
    }
    const job = schedule.scheduleJob(task.time, fire);
    if (!job) throw new AiScheduleError("Invalid trigger time");
    this.jobs.set(task.uuid, { cancel: () => job.cancel() });
  }

  /** Daemons hosting at least one active crash analysis task (the only ones polled). */
  crashTaskDaemons(): string[] {
    return [
      ...new Set(
        [...this.tasks.values()]
          .filter((task) => task.kind === "crash_analysis" && !task.disabledReason)
          .map((task) => task.daemonId)
      )
    ];
  }

  /** Unexpected stop reported by a daemon: runs the instance's crash analysis task. */
  async onCrash(daemonId: string, record: CrashRecord) {
    const task = [...this.tasks.values()].find(
      (item) =>
        item.daemonId === daemonId &&
        item.instanceUuid === record.instanceUuid &&
        item.kind === "crash_analysis" &&
        !item.disabledReason
    );
    if (!task) return null;
    const last = this.lastCrashAnalysis.get(task.uuid);
    if (last && Date.now() - last < CRASH_RATE_LIMIT_MS) {
      logger.info(`[AI_SCHEDULE] Crash analysis ${task.name} rate limited`);
      return this.finish(task, "skipped");
    }
    return this.fire(task, record);
  }

  private async fire(task: AiScheduleTask, crash?: CrashRecord) {
    if (!this.tasks.has(task.uuid)) return;
    const status = await this.run(task, crash);
    // A clean stop is not an analysis: it does not consume the repeat count.
    if (crash && task.lastStatus === "skipped" && status === "skipped") return status;
    const left = this.remaining.get(task.uuid) ?? -1;
    if (left === -1) return status;
    if (left <= 1) {
      await this.removeTask(task);
    } else {
      this.remaining.set(task.uuid, left - 1);
    }
    return status;
  }

  private async finish(task: AiScheduleTask, status: string) {
    task.lastStatus = status;
    await this.save(task);
    return status;
  }

  /** Runs a task now. Returns the resulting status. */
  async run(task: AiScheduleTask, crash?: CrashRecord): Promise<string> {
    task.lastRunAt = new Date().toISOString();
    if (task.disabledReason) return this.finish(task, "skipped");
    if (!systemConfig?.aiEnabled) return this.finish(task, "skipped");
    const user = userSystem.getInstance(task.ownerUserUuid);
    if (!user || !isHaveInstance(user, task.daemonId, task.instanceUuid)) {
      task.disabledReason = "access_lost";
      this.jobs.get(task.uuid)?.cancel();
      this.jobs.delete(task.uuid);
      logger.warn(`[AI_SCHEDULE] Task ${task.name} disabled: owner lost access to the instance`);
      return this.finish(task, "skipped");
    }
    // Regular users need an administrator's AI access grant (the task resumes once granted).
    if (!aiAccess.hasAccess(user)) return this.finish(task, "skipped");
    if (task.lastReportUuid && localAi.hasActiveRequest(task.lastReportUuid)) {
      return this.finish(task, "skipped");
    }
    const remote = RemoteServiceSubsystem.getInstance(task.daemonId);
    if (!remote?.available) return this.finish(task, "skipped");

    let collected: CollectedRun;
    try {
      collected = await this.collect(task, remote, crash);
    } catch (error: any) {
      logger.warn(
        `[AI_SCHEDULE] Data collection failed for ${task.name}: ${String(error?.message || error)}`
      );
      return this.finish(task, "failed");
    }
    if (collected.skip) return this.finish(task, "skipped");

    const date = new Date().toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
    const conversation = await localAi.createConversation(
      task.ownerUserUuid,
      collected.title || `Rapport · ${task.name} · ${date}`,
      { daemonId: task.daemonId, instanceUuid: task.instanceUuid },
      "report"
    );
    task.lastReportUuid = conversation.uuid;
    task.lastRequestUuid = "";
    if (task.kind === "crash_analysis") this.lastCrashAnalysis.set(task.uuid, Date.now());

    if (collected.directReport != null) {
      await localAi.appendMessage(task.ownerUserUuid, conversation.uuid, collected.prompt, "user");
      await localAi.appendMessage(
        task.ownerUserUuid,
        conversation.uuid,
        `${collected.directReport}${collected.suffix}`
      );
      return this.finish(task, "completed");
    }

    await this.finish(task, "queued");
    try {
      const record = await localAi.submit(task.ownerUserUuid, conversation.uuid, collected.prompt, {
        scheduledContext: collected.context,
        scheduledSuffix: collected.suffix,
        onFinished: (state) => {
          const status = state === "completed" ? "completed" : "failed";
          if (this.tasks.get(task.uuid) === task) void this.finish(task, status);
        }
      });
      task.lastRequestUuid = record.uuid;
      await this.save(task);
      return task.lastStatus;
    } catch (error: any) {
      const reason = String(error?.message || error);
      await localAi.appendMessage(
        task.ownerUserUuid,
        conversation.uuid,
        reason === "AI queue is full"
          ? "Le rapport n’a pas été lancé : la file d’attente de l’IA est pleine."
          : "Le rapport n’a pas pu être lancé."
      );
      logger.warn(`[AI_SCHEDULE] Task ${task.name} could not be queued: ${reason}`);
      return this.finish(task, reason === "AI queue is full" ? "skipped" : "failed");
    }
  }

  /** Collects the trusted data a run needs, by kind. */
  private async collect(
    task: AiScheduleTask,
    remote: any,
    crash?: CrashRecord
  ): Promise<CollectedRun> {
    const request = (event: string, data: Record<string, unknown>, timeout = 15000) =>
      new RemoteRequest(remote).request(
        event,
        { instanceUuid: task.instanceUuid, ...data },
        timeout
      );
    const header = `Tâche planifiée « ${task.name} » : ${KIND_LABELS[task.kind]}.`;

    if (task.kind === "crash_analysis") {
      return this.collectCrash(task, request, crash);
    }

    if (task.kind === "console_report") {
      let log = "";
      try {
        log = tailConsoleLog(await request("instance/outputlog", {}));
      } catch {
        log = "";
      }
      const prompt =
        `${header} Analyse les dernières lignes de la console : erreurs, avertissements, ` +
        "plantages et lenteurs, avec une correction proposée pour chacun.";
      if (!log) {
        return {
          prompt,
          context: "",
          suffix: "",
          directReport: "Rien à signaler : la console de l’instance est vide."
        };
      }
      return { prompt, context: `Console log (last lines):\n${log}`, suffix: "" };
    }

    if (task.kind === "file_check") {
      const readText = async (path: string): Promise<string | null> => {
        try {
          const text = await request("file/edit", { target: path });
          if (text === true) return "";
          return typeof text === "string" ? text : null;
        } catch {
          return null;
        }
      };
      const files: Array<{ path: string; text: string }> = [];
      for (const path of KNOWN_CONFIG_FILES) {
        const text = await readText(`/${path}`);
        if (text !== null) files.push({ path, text });
      }
      try {
        const listing = await request("file/list", {
          target: "/plugins",
          page: 0,
          pageSize: 100,
          fileName: ""
        });
        const folders = (Array.isArray(listing?.items) ? listing.items : [])
          .filter((item: any) => item?.type === 0 && /^[\w .+-]{1,64}$/.test(String(item?.name)))
          .slice(0, FILE_CHECK_MAX_PLUGIN_CONFIGS);
        for (const folder of folders) {
          const path = `plugins/${folder.name}/config.yml`;
          const text = await readText(`/${path}`);
          if (text !== null) files.push({ path, text });
        }
      } catch {
        // no plugins folder
      }
      const prompt =
        `${header} Vérifie les fichiers de configuration : valeurs invalides, réglages ` +
        "risqués ou incohérents, et propose une correction pour chaque problème.";
      if (!files.length) {
        return {
          prompt,
          context: "",
          suffix: "",
          directReport: "Aucun fichier de configuration connu n’a été trouvé dans l’instance."
        };
      }
      const { context, syntaxErrors } = buildFileCheckContext(files);
      return { prompt, context, suffix: formatSyntaxErrors(syntaxErrors) };
    }

    if (task.kind === "plugin_updates") {
      const profile = await aiToolService.detectProfile(remote, task.instanceUuid);
      const addons = await aiToolService.installedAddons(remote, task.instanceUuid, "");
      const prompt =
        `${header} Résume quels plugins ou mods ont une version plus récente compatible ` +
        "avec ce serveur. N’installe rien.";
      if (!addons.length) {
        return {
          prompt,
          context: "",
          suffix: "",
          directReport: "Aucun plugin ni mod installé dans cette instance."
        };
      }
      const rows = await comparePluginVersions(addons, profile, {
        byHashes: (hashes) => modManagerService.getInfosByHashes(hashes),
        versions: (projectId) => modManagerService.getProjectVersions(projectId, "Modrinth")
      });
      const server = { loader: profile.loader, mcVersion: profile.mcVersion };
      return {
        prompt,
        context: JSON.stringify({ server, plugins: rows }),
        suffix: formatPluginTable(rows)
      };
    }

    return {
      prompt: `${header}\n\n${task.prompt}`,
      context: "No data was collected in advance; use the read-only tools if needed.",
      suffix: ""
    };
  }

  /** Crash data: console snapshot taken at the stop, crash report and JVM error file. */
  private async collectCrash(
    task: AiScheduleTask,
    request: (event: string, data: Record<string, unknown>, timeout?: number) => Promise<any>,
    crash?: CrashRecord
  ): Promise<CollectedRun> {
    if (!crash) {
      // "Run now": analyze the latest unexpected stop of the last hour, if any.
      try {
        const records = await request(
          "instance/unexpected_stops",
          { since: Date.now() - 60 * 60 * 1000 },
          10000
        );
        crash = (Array.isArray(records) ? records : [])
          .filter((record: CrashRecord) => record?.instanceUuid === task.instanceUuid)
          .pop();
      } catch {
        crash = undefined;
      }
    }
    if (!crash) {
      return {
        prompt: `Tâche « ${task.name} » : analyse des plantages.`,
        context: "",
        suffix: "",
        directReport: "Aucun arrêt inattendu de l’instance dans la dernière heure."
      };
    }

    const readText = async (path: string): Promise<string | null> => {
      try {
        const text = await request("file/edit", { target: path });
        return typeof text === "string" ? text : null;
      } catch {
        return null;
      }
    };
    const tail = String(crash.consoleTail || "");
    let crashFile = crashReportFromConsole(tail);
    if (!crashFile) {
      const day = new Date(crash.at);
      const prefix = `crash-${day.getFullYear()}-${String(day.getMonth() + 1).padStart(
        2,
        "0"
      )}-${String(day.getDate()).padStart(2, "0")}`;
      try {
        const listing = await request("file/list", {
          target: "/crash-reports",
          page: 0,
          pageSize: 100,
          fileName: prefix
        });
        const names = (Array.isArray(listing?.items) ? listing.items : [])
          .filter((item: any) => item?.type === 1)
          .map((item: any) => String(item.name));
        crashFile = pickCrashReport(names, crash.at);
      } catch {
        crashFile = "";
      }
    }
    const crashText = crashFile ? await readText(`/crash-reports/${crashFile}`) : null;
    const hsErr = hsErrFromConsole(tail);
    const hsErrText = hsErr ? await readText(`/${hsErr}`) : null;
    if (isCleanStop(crash, crashText !== null)) {
      return { prompt: "", context: "", suffix: "", skip: true };
    }

    const when = new Date(crash.at).toLocaleString("fr-FR", {
      dateStyle: "short",
      timeStyle: "medium"
    });
    const summary =
      crash.kind === "start_failure"
        ? `Échec du démarrage à ${when} : ${crash.error || "erreur inconnue"}`
        : `Arrêt inattendu à ${when} (code de sortie ${crash.code ?? "inconnu"}, ` +
          `redémarrage automatique : ${crash.autoRestart ? "oui" : "non"})`;
    const files = [
      crashText !== null ? `crash-reports/${crashFile}` : "",
      hsErrText !== null ? hsErr : ""
    ].filter(Boolean);
    return {
      title: `Plantage · ${when}`,
      prompt:
        `${summary}.\n\nExplique la cause la plus probable en t’appuyant d’abord sur le ` +
        "rapport de plantage, puis sur la console ; nomme le plugin ou le mod en cause quand " +
        "la trace le montre ; propose des corrections concrètes.",
      context: JSON.stringify({
        stop: {
          kind: crash.kind,
          exitCode: crash.code,
          automaticRestart: crash.autoRestart,
          error: crash.error
        },
        consoleAtStop: tailConsoleLog(tail),
        crashReport:
          crashText !== null
            ? { file: crashFile, content: redactSecrets(crashText.slice(0, CRASH_FILE_MAX_CHARS)) }
            : null,
        jvmErrorFile:
          hsErrText !== null
            ? { file: hsErr, content: redactSecrets(hsErrText.slice(0, HS_ERR_MAX_CHARS)) }
            : null
      }),
      suffix: files.length
        ? `\n\n_Fichiers analysés : ${files.map((file) => `\`${file}\``).join(", ")}_`
        : "\n\n_Aucun fichier de plantage trouvé : analyse faite à partir de la console._"
    };
  }
}

const STATUS_LABELS: Record<PluginUpdateRow["status"], string> = {
  update_available: "Mise à jour disponible",
  up_to_date: "À jour",
  not_found: "Introuvable sur Modrinth",
  no_compatible_version: "Aucune version compatible"
};

/** Panel-built table appended to the plugin report (never written by the model). */
export function formatPluginTable(rows: PluginUpdateRow[]): string {
  if (!rows.length) return "";
  const cell = (value: string) => value.replace(/[|\n]/g, " ") || "—";
  return (
    "\n\n| Plugin | Installé | Dernière compatible | État |\n|---|---|---|---|\n" +
    rows
      .map(
        (row) =>
          `| ${cell(row.name)} | ${cell(row.installed)} | ${cell(row.latest)} | ${
            STATUS_LABELS[row.status]
          } |`
      )
      .join("\n")
  );
}

export default new AiScheduleService();
