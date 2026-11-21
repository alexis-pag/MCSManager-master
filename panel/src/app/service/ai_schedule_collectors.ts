import YAML from "yaml";
import { CandidateVersion, pickVersion, ServerProfile } from "./ai_plugin_tools";

// Bounds keep a scheduled run within a small local model's context window.
export const CONSOLE_MAX_LINES = 200;
export const CONSOLE_MAX_CHARS = 12000;
export const FILE_CHECK_MAX_TOTAL_CHARS = 16000;
export const FILE_CHECK_MAX_FILE_CHARS = 4000;
export const FILE_CHECK_MAX_READ_CHARS = 64 * 1024;
export const FILE_CHECK_MAX_PLUGIN_CONFIGS = 20;
export const PLUGIN_CHECK_MAX = 30;

/** Known configuration files, checked when they exist (paths relative to the instance). */
export const KNOWN_CONFIG_FILES = [
  "server.properties",
  "eula.txt",
  "bukkit.yml",
  "spigot.yml",
  "config/paper-global.yml",
  "config/paper-world-defaults.yml",
  "paper.yml",
  "ops.json",
  "whitelist.json",
  "banned-players.json"
];

const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Non-empty console lines without terminal escape or control codes. */
export function cleanConsoleLines(text: unknown): string[] {
  if (typeof text !== "string" || !text) return [];
  return text
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_PATTERN, "")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

/** Last lines of a console log without terminal escape codes. */
export function tailConsoleLog(text: unknown): string {
  const lines = cleanConsoleLines(text);
  if (!lines.length) return "";
  let result = lines.slice(-CONSOLE_MAX_LINES).join("\n");
  if (result.length > CONSOLE_MAX_CHARS) result = result.slice(-CONSOLE_MAX_CHARS);
  return result;
}

const SECRET_KEY = /(password|passwd|secret|token|api[-_]?key|private[-_]?key|license[-_]?key)/i;

/** Replaces credential values ("rcon.password=x", "token: x", "\"apiKey\": \"x\"") by <redacted>. */
export function redactSecrets(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const match = /^(\s*"?([A-Za-z0-9_.\-]+)"?\s*[:=]\s*)(.+)$/.exec(line);
      if (!match || !SECRET_KEY.test(match[2])) return line;
      const value = match[3].trim();
      if (!value || value === '""' || value === "''" || /^[{[]$/.test(value)) return line;
      return `${match[1]}<redacted>${value.endsWith(",") ? "," : ""}`;
    })
    .join("\n");
}

/** Syntax check by file type. Returns an error message, or "" when the syntax is valid. */
export function checkConfigSyntax(path: string, text: string): string {
  const lower = path.toLowerCase();
  try {
    if (lower.endsWith(".json")) {
      if (text.trim()) JSON.parse(text);
      return "";
    }
    if (lower.endsWith(".yml") || lower.endsWith(".yaml")) {
      const documents = YAML.parseAllDocuments(text);
      for (const document of documents) {
        if (document.errors.length) return String(document.errors[0].message).slice(0, 300);
      }
      return "";
    }
    if (lower.endsWith(".properties") || lower.endsWith(".txt")) {
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index].trim();
        if (!line || line.startsWith("#") || line.startsWith("!")) continue;
        if (!/^[^=:\s][^=:]*[=:]/.test(line)) {
          return `Line ${index + 1} is not a "key=value" entry: ${line.slice(0, 80)}`;
        }
      }
      return "";
    }
  } catch (error: any) {
    return String(error?.message || error).slice(0, 300);
  }
  return "";
}

export interface CheckedFile {
  path: string;
  syntaxError: string;
  content: string;
  truncated: boolean;
}

/** Validates each file and builds the bounded, redacted context sent to the model. */
export function buildFileCheckContext(files: Array<{ path: string; text: string }>) {
  const checked: CheckedFile[] = [];
  let budget = FILE_CHECK_MAX_TOTAL_CHARS;
  for (const file of files) {
    const text = file.text.slice(0, FILE_CHECK_MAX_READ_CHARS);
    const syntaxError = checkConfigSyntax(file.path, text);
    const redacted = redactSecrets(text);
    const limit = Math.max(0, Math.min(FILE_CHECK_MAX_FILE_CHARS, budget));
    const content = redacted.slice(0, limit);
    budget -= content.length;
    checked.push({
      path: file.path,
      syntaxError,
      content,
      truncated: content.length < redacted.length
    });
  }
  const syntaxErrors = checked.filter((file) => file.syntaxError);
  return {
    checked,
    syntaxErrors,
    context: JSON.stringify({
      files: checked.map((file) => file.path),
      syntaxErrorsDetectedByPanel: syntaxErrors.map((file) => ({
        path: file.path,
        error: file.syntaxError
      })),
      contents: checked
        .filter((file) => file.content)
        .map((file) => ({ path: file.path, truncated: file.truncated, content: file.content }))
    })
  };
}

/** Markdown list of syntax errors found by the panel (appended verbatim to the report). */
export function formatSyntaxErrors(errors: CheckedFile[]): string {
  if (!errors.length) return "";
  return (
    "\n\n**Erreurs de syntaxe détectées par le panel :**\n" +
    errors.map((file) => `- \`${file.path}\` : ${file.syntaxError}`).join("\n")
  );
}

export interface InstalledAddon {
  name?: string;
  version?: string;
  file?: string;
  folder?: string;
  hash?: string;
  enabled?: boolean;
}

export interface PluginUpdateRow {
  name: string;
  file: string;
  installed: string;
  latest: string;
  status: "update_available" | "up_to_date" | "not_found" | "no_compatible_version";
}

/**
 * Compares installed jars (identified on Modrinth by their SHA-1) with the newest version
 * compatible with the detected server. Jars unknown to Modrinth are reported as not found.
 */
export async function comparePluginVersions(
  addons: InstalledAddon[],
  profile: ServerProfile,
  lookups: {
    byHashes: (hashes: string[]) => Promise<Record<string, any>>;
    versions: (projectId: string) => Promise<CandidateVersion[] | null>;
  }
): Promise<PluginUpdateRow[]> {
  const jars = addons
    .filter((addon) => /\.jar$/i.test(String(addon.file || "")))
    .slice(0, PLUGIN_CHECK_MAX);
  const hashes = jars.map((addon) => String(addon.hash || "")).filter((hash) => hash);
  let known: Record<string, any> = {};
  try {
    known = hashes.length ? (await lookups.byHashes(hashes)) || {} : {};
  } catch {
    known = {};
  }
  const rows: PluginUpdateRow[] = [];
  for (const addon of jars) {
    const info = addon.hash ? known[addon.hash] : undefined;
    const name = String(info?.project?.title || addon.name || addon.file).slice(0, 80);
    const base = {
      name,
      file: String(addon.file).slice(0, 128),
      installed: String(info?.version?.version_number || addon.version || "").slice(0, 40)
    };
    if (!info?.version?.project_id) {
      rows.push({ ...base, latest: "", status: "not_found" });
      continue;
    }
    let versions: CandidateVersion[] | null = null;
    try {
      versions = await lookups.versions(String(info.version.project_id));
    } catch {
      versions = null;
    }
    const picked = Array.isArray(versions) ? pickVersion(versions, profile) : null;
    if (!picked || "error" in picked) {
      rows.push({ ...base, latest: "", status: "no_compatible_version" });
      continue;
    }
    const latest = String(picked.version.version_number || picked.version.id).slice(0, 40);
    const installedDate = Date.parse(String(info.version.date_published || ""));
    const latestDate = Date.parse(String((picked.version as any).date_published || ""));
    const newer =
      String(picked.version.id) !== String(info.version.id) &&
      (Number.isNaN(installedDate) || Number.isNaN(latestDate) || latestDate > installedDate);
    rows.push({ ...base, latest, status: newer ? "update_available" : "up_to_date" });
  }
  return rows;
}

// ---- Crash analysis ------------------------------------------------------------------------

export const CRASH_FILE_MAX_CHARS = 20000;
export const HS_ERR_MAX_CHARS = 10000;
export const CRASH_FILE_WINDOW_MS = 10 * 60 * 1000;
const CRASH_ERROR_LINE = /(ERROR|FATAL|Exception|Crash|crashed|OutOfMemory|Watchdog)/;

export interface CrashRecord {
  id: string;
  instanceUuid: string;
  kind: "exit" | "start_failure";
  code: number | null;
  error: string;
  at: number;
  autoRestart: boolean;
  consoleTail: string;
}

/** "crash-reports/crash-2026-11-21_03.12.44-server.txt" announced in the console. */
export function crashReportFromConsole(tail: string): string {
  return lastMatch(tail, /crash-reports[\\/](crash-[\w.-]+\.txt)/g);
}

/** JVM fatal error file announced in the console ("# ... saved as: /x/hs_err_pid123.log"). */
export function hsErrFromConsole(tail: string): string {
  return lastMatch(tail, /(hs_err_pid\d{1,10}\.log)/g);
}

/** First capture group of the last match of a global pattern, or "". */
function lastMatch(text: string, pattern: RegExp): string {
  let found = "";
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) found = match[1];
  return found;
}

/** Local time encoded in a Minecraft crash report name, or NaN. */
export function crashReportTime(name: string): number {
  const match = /^crash-(\d{4})-(\d{2})-(\d{2})_(\d{2})\.(\d{2})\.(\d{2})/.exec(name);
  if (!match) return NaN;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

/** Newest crash report written within the window around the stop, by its name. */
export function pickCrashReport(names: string[], at: number): string {
  return (
    names
      .filter((name) => {
        const time = crashReportTime(name);
        return !Number.isNaN(time) && Math.abs(at - time) <= CRASH_FILE_WINDOW_MS;
      })
      .sort()
      .pop() || ""
  );
}

/** An exit code 0 with no crash file and no error in the console is a normal stop. */
export function isCleanStop(record: CrashRecord, crashFileFound: boolean): boolean {
  return (
    record.kind === "exit" &&
    record.code === 0 &&
    !crashFileFound &&
    !cleanConsoleLines(record.consoleTail).some((line) => CRASH_ERROR_LINE.test(line))
  );
}
