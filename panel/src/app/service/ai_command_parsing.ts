import { isBanCommand } from "mcsmanager-common";
import { normalizeInstancePath } from "./ai_file_edit";

// Pure parsing/validation of the commands the AI assistant may run (no I/O, unit-testable).

// ---- Console commands ---------------------------------------------------------------------

/**
 * Minecraft commands available to players without operator rights, plus harmless ones.
 * An entry may have two words: "time query" allows `time query daytime`, not `time set`.
 */
export const DEFAULT_CONSOLE_ALLOWLIST = [
  "help",
  "list",
  "me",
  "msg",
  "tell",
  "w",
  "teammsg",
  "tm",
  "trigger",
  "random",
  "say",
  "seed",
  "time query"
];

export const MAX_CONSOLE_COMMAND_CHARS = 256;
const MAX_ALLOWLIST_ENTRIES = 50;
const ALLOWLIST_ENTRY = /^[a-z0-9_-]{1,32}( [a-z0-9_-]{1,32})?$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Administrator input (array or text, one entry per line/comma) to a clean allowlist. */
export function normalizeConsoleAllowlist(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(/[\n,]/);
  const entries: string[] = [];
  for (const item of raw) {
    const entry = String(item ?? "")
      .trim()
      .replace(/^\//, "")
      .replace(/\s+/g, " ")
      .toLowerCase();
    if (!entry || !ALLOWLIST_ENTRY.test(entry) || entries.includes(entry)) continue;
    entries.push(entry);
    if (entries.length >= MAX_ALLOWLIST_ENTRIES) break;
  }
  return entries;
}

export type ConsoleCommandError =
  | "Invalid command"
  | "Several commands"
  | "Namespaced command"
  | "Command not allowed"
  | "Ban command";

/** Returns the command to send (without leading "/"), or why it is refused. */
export function validateConsoleCommand(
  value: unknown,
  allowlist: string[]
): { command: string } | { error: ConsoleCommandError } {
  if (typeof value !== "string") return { error: "Invalid command" };
  if (/[\r\n]/.test(value)) return { error: "Several commands" };
  const trimmed = value.trim().replace(/^\/+/, "");
  if (!trimmed || trimmed.length > MAX_CONSOLE_COMMAND_CHARS || CONTROL.test(trimmed)) {
    return { error: "Invalid command" };
  }
  const tokens = trimmed.split(/\s+/);
  let name = tokens[0].toLowerCase();
  if (name.includes(":")) {
    const [namespace, rest] = name.split(":", 2);
    // Plugin namespaces (luckperms:, essentials:...) are administrator territory.
    if (namespace !== "minecraft" || !rest) return { error: "Namespaced command" };
    name = rest;
  }
  const command = [name, ...tokens.slice(1)].join(" ");
  const second = (tokens[1] || "").toLowerCase();
  const allowed = allowlist.some((entry) => {
    const [first, sub] = entry.split(" ");
    return first === name && (!sub || sub === second);
  });
  if (!allowed) return { error: "Command not allowed" };
  if (isBanCommand(command)) return { error: "Ban command" };
  return { command };
}

// ---- Instance-folder commands ---------------------------------------------------------------

export const INSTANCE_COMMANDS = [
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "find",
  "du",
  "mkdir",
  "touch",
  "cp",
  "mv",
  "rm",
  "zip",
  "unzip"
] as const;
export type InstanceCommandName = (typeof INSTANCE_COMMANDS)[number];

const MAX_ARGS = 12;
const MAX_ARG_CHARS = 512;
const MAX_PATTERN_CHARS = 200;
const MAX_HEAD_LINES = 200;

export type InstanceOperation =
  | { kind: "list"; path: string; all: boolean; long: boolean }
  | { kind: "read"; mode: "cat" | "head" | "tail" | "wc"; path: string; lines: number }
  | {
      kind: "search";
      mode: "grep" | "find" | "du";
      target: string;
      pattern: string;
      ignoreCase: boolean;
      recursive: boolean;
    }
  | { kind: "mkdir"; path: string }
  | { kind: "touch"; path: string }
  | { kind: "copy"; from: string; to: string; recursive: boolean }
  | { kind: "move"; from: string; to: string }
  | { kind: "delete"; paths: string[]; recursive: boolean }
  | { kind: "zip"; archive: string; paths: string[] }
  | { kind: "unzip"; archive: string; dest: string };

export interface ParsedInstanceCommand {
  name: InstanceCommandName;
  /** Normalized arguments: `{ command: name, args }` re-parses to the same operation. */
  args: string[];
  /** Normalized command line shown to the user. */
  display: string;
  readOnly: boolean;
  operation: InstanceOperation;
}

export type InstanceCommandError =
  "Unknown command" | "Invalid arguments" | "Unsupported option" | "Invalid path" | "Refused path";

/** Splits a command line with double quotes, for models that send everything in `command`. */
export function splitCommandLine(line: string): string[] | null {
  const tokens: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) {
    tokens.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2]);
  }
  return tokens;
}

const quote = (value: string) => (/[\s"'\\]/.test(value) || !value ? JSON.stringify(value) : value);

/**
 * Parses `{ command, args }` into one operation of the fixed command set. This is not a shell:
 * pipes, redirections, variables, globs (except `find -name`) and `..` do not exist.
 */
export function parseInstanceCommand(
  commandInput: unknown,
  argsInput: unknown
): ParsedInstanceCommand | { error: InstanceCommandError } {
  let tokens: string[];
  if (Array.isArray(argsInput)) {
    tokens = [String(commandInput ?? ""), ...argsInput.map((arg) => String(arg ?? ""))];
  } else if (argsInput == null && typeof commandInput === "string") {
    tokens = splitCommandLine(commandInput.trim()) || [];
  } else {
    return { error: "Invalid arguments" };
  }
  tokens = tokens.map((token) => token.trim()).filter((token) => token.length);
  const name = String(tokens.shift() || "").toLowerCase() as InstanceCommandName;
  if (!INSTANCE_COMMANDS.includes(name)) return { error: "Unknown command" };
  if (tokens.length > MAX_ARGS) return { error: "Invalid arguments" };
  if (tokens.some((token) => token.length > MAX_ARG_CHARS || CONTROL.test(token))) {
    return { error: "Invalid arguments" };
  }

  // Options with a value, per command.
  const valued: Partial<Record<InstanceCommandName, string[]>> = {
    head: ["n"],
    tail: ["n"],
    find: ["name"],
    unzip: ["d"]
  };
  const allowed: Record<InstanceCommandName, string[]> = {
    ls: ["a", "l"],
    cat: [],
    head: ["n"],
    tail: ["n"],
    wc: ["l"],
    grep: ["i", "r", "n"],
    find: ["name"],
    du: ["s", "h"],
    mkdir: ["p"],
    touch: [],
    cp: ["r"],
    mv: [],
    rm: ["r", "f"],
    zip: ["r"],
    unzip: ["d"]
  };
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  const operands: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    // A pattern starting with "-" goes after "--", as in a shell.
    if (!token.startsWith("-") || token === "-") {
      operands.push(token);
      continue;
    }
    if (token === "--") {
      operands.push(...tokens.slice(index + 1));
      break;
    }
    const option = token.replace(/^-+/, "");
    if ((valued[name] || []).includes(option)) {
      const value = tokens[++index];
      if (value === undefined) return { error: "Invalid arguments" };
      values[option] = value;
      continue;
    }
    // Combined short flags (-rf, -in).
    const letters = token.startsWith("--") ? [option] : option.split("");
    if (
      !letters.every(
        (letter) => allowed[name].includes(letter) && !(valued[name] || []).includes(letter)
      )
    ) {
      return { error: "Unsupported option" };
    }
    letters.forEach((letter) => flags.add(letter));
  }

  const path = (value: string | undefined, fallback?: string) => {
    if (value === undefined) return fallback ?? null;
    return normalizeInstancePath(value);
  };
  const display = [name, ...tokens].map(quote).join(" ");
  const result = (operation: InstanceOperation, readOnly: boolean): ParsedInstanceCommand => ({
    name,
    args: tokens,
    display,
    readOnly,
    operation
  });
  const count = (raw: string | undefined) => {
    if (raw === undefined) return 10;
    const lines = Number(raw);
    return Number.isInteger(lines) && lines > 0 ? Math.min(lines, MAX_HEAD_LINES) : null;
  };

  switch (name) {
    case "ls": {
      if (operands.length > 1) return { error: "Invalid arguments" };
      const target = path(operands[0], "/");
      if (!target) return { error: "Invalid path" };
      return result(
        { kind: "list", path: target, all: flags.has("a"), long: flags.has("l") },
        true
      );
    }
    case "cat":
    case "head":
    case "tail":
    case "wc": {
      if (operands.length !== 1) return { error: "Invalid arguments" };
      const target = path(operands[0]);
      const lines = count(values.n);
      if (!target) return { error: "Invalid path" };
      if (lines === null) return { error: "Invalid arguments" };
      return result({ kind: "read", mode: name, path: target, lines }, true);
    }
    case "grep": {
      if (operands.length < 1 || operands.length > 2) return { error: "Invalid arguments" };
      const pattern = operands[0];
      if (!pattern || pattern.length > MAX_PATTERN_CHARS) return { error: "Invalid arguments" };
      const target = path(operands[1], "/");
      if (!target) return { error: "Invalid path" };
      return result(
        {
          kind: "search",
          mode: "grep",
          target,
          pattern,
          ignoreCase: flags.has("i"),
          recursive: flags.has("r")
        },
        true
      );
    }
    case "find": {
      if (operands.length > 1 || !values.name) return { error: "Invalid arguments" };
      if (values.name.length > MAX_PATTERN_CHARS) return { error: "Invalid arguments" };
      const target = path(operands[0], "/");
      if (!target) return { error: "Invalid path" };
      return result(
        {
          kind: "search",
          mode: "find",
          target,
          pattern: values.name,
          ignoreCase: true,
          recursive: true
        },
        true
      );
    }
    case "du": {
      if (operands.length > 1) return { error: "Invalid arguments" };
      const target = path(operands[0], "/");
      if (!target) return { error: "Invalid path" };
      return result(
        { kind: "search", mode: "du", target, pattern: "", ignoreCase: false, recursive: true },
        true
      );
    }
    case "mkdir":
    case "touch": {
      if (operands.length !== 1) return { error: "Invalid arguments" };
      const target = path(operands[0]);
      if (!target) return { error: "Invalid path" };
      if (target === "/") return { error: "Refused path" };
      return result({ kind: name, path: target }, false);
    }
    case "cp":
    case "mv": {
      if (operands.length !== 2) return { error: "Invalid arguments" };
      const from = path(operands[0]);
      const to = path(operands[1]);
      if (!from || !to) return { error: "Invalid path" };
      if (from === "/" || to === "/") return { error: "Refused path" };
      return name === "cp"
        ? result({ kind: "copy", from, to, recursive: flags.has("r") }, false)
        : result({ kind: "move", from, to }, false);
    }
    case "rm": {
      if (operands.length < 1 || operands.length > 10) return { error: "Invalid arguments" };
      const targets = operands.map((operand) => path(operand));
      if (targets.some((target) => !target)) return { error: "Invalid path" };
      // Never the instance folder itself.
      if (targets.some((target) => target === "/" || target === "/.")) {
        return { error: "Refused path" };
      }
      return result(
        { kind: "delete", paths: targets as string[], recursive: flags.has("r") },
        false
      );
    }
    case "zip": {
      if (operands.length < 2 || operands.length > 11) return { error: "Invalid arguments" };
      const archive = path(operands[0]);
      const sources = operands.slice(1).map((operand) => path(operand));
      if (!archive || sources.some((source) => !source)) return { error: "Invalid path" };
      if (!archive.toLowerCase().endsWith(".zip")) return { error: "Invalid arguments" };
      return result({ kind: "zip", archive, paths: sources as string[] }, false);
    }
    case "unzip": {
      if (operands.length < 1 || operands.length > 2) return { error: "Invalid arguments" };
      const archive = path(operands[0]);
      const parent = archive ? archive.slice(0, archive.lastIndexOf("/")) || "/" : null;
      const dest = path(values.d ?? operands[1], parent ?? "/");
      if (!archive || !dest) return { error: "Invalid path" };
      return result({ kind: "unzip", archive, dest }, false);
    }
  }
  return { error: "Unknown command" };
}

// ---- Administrator free command ------------------------------------------------------------

export const MAX_ADMIN_COMMAND_CHARS = 1000;

export function validateAdminCommand(value: unknown): string | null {
  const command = typeof value === "string" ? value.trim() : "";
  if (!command || command.length > MAX_ADMIN_COMMAND_CHARS || CONTROL.test(command)) return null;
  return command;
}

// ---- Instance settings (administrators) ----------------------------------------------------

/** Settings the assistant may change for an administrator (never type, process mode or paths). */
export interface InstanceSettingsPatch {
  startCommand?: string;
  stopCommand?: string;
  updateCommand?: string;
  ie?: string;
  oe?: string;
  crlf?: number;
  stopTimeout?: number;
  autoRestart?: boolean;
  javaId?: string;
}

export const SETTINGS_FIELDS: Array<keyof InstanceSettingsPatch> = [
  "startCommand",
  "stopCommand",
  "updateCommand",
  "ie",
  "oe",
  "crlf",
  "stopTimeout",
  "autoRestart",
  "javaId"
];

const ENCODING = /^[a-z0-9_-]{2,20}$/i;

/** Validates and normalizes the requested changes (fixed key order for confirmations). */
export function parseSettingsPatch(
  input: Record<string, unknown>
):
  | { patch: InstanceSettingsPatch }
  | { error: "Invalid settings" | "Placeholder in value" | "No change" } {
  const patch: InstanceSettingsPatch = {};
  for (const field of SETTINGS_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    switch (field) {
      case "startCommand":
      case "stopCommand":
      case "updateCommand": {
        if (typeof value !== "string") return { error: "Invalid settings" };
        const text = value.trim();
        if (text.length > MAX_ADMIN_COMMAND_CHARS || CONTROL.test(text)) {
          return { error: "Invalid settings" };
        }
        if (field === "startCommand" && !text) return { error: "Invalid settings" };
        // Models sometimes copy "<version>" from examples instead of the real value.
        if (/<[A-Za-z_][\w .-]{0,40}>/.test(text)) return { error: "Placeholder in value" };
        patch[field] = text;
        break;
      }
      case "ie":
      case "oe":
        if (typeof value !== "string" || !ENCODING.test(value))
          return { error: "Invalid settings" };
        patch[field] = value.toLowerCase();
        break;
      case "crlf":
        if (value !== 1 && value !== 2) return { error: "Invalid settings" };
        patch.crlf = value;
        break;
      case "stopTimeout": {
        const seconds = Number(value);
        if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) {
          return { error: "Invalid settings" };
        }
        patch.stopTimeout = seconds;
        break;
      }
      case "autoRestart":
        if (typeof value !== "boolean") return { error: "Invalid settings" };
        patch.autoRestart = value;
        break;
      case "javaId":
        if (typeof value !== "string" || value.length > 200 || CONTROL.test(value)) {
          return { error: "Invalid settings" };
        }
        patch.javaId = value.trim();
        break;
    }
  }
  return Object.keys(patch).length ? { patch } : { error: "No change" };
}
