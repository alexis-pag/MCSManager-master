import { createHash } from "crypto";

// Pure helpers for AI-proposed instance file edits (no I/O, unit-testable).

export const MAX_AI_FILE_READ_CHARS = 12000;
export const MAX_AI_FILE_WRITE_CHARS = 128 * 1024;
export const MAX_AI_EDITS = 20;
export const MAX_AI_EDIT_CHARS = 20000;

export interface AiFileEdit {
  find: string;
  replace: string;
}

export type AiFileEditError =
  | "Invalid edit"
  | "Edit text not found"
  | "Edit text is ambiguous"
  | "File too large";

export function contentHash(text: string | null): string {
  return createHash("sha256")
    .update(text === null ? "\u0000<missing>" : text)
    .digest("hex");
}

export function isBinaryText(text: string): boolean {
  return text.includes("\u0000");
}

/**
 * Validates a path relative to the instance working directory. The daemon enforces the
 * real boundary; this only rejects obviously unsafe input early.
 */
export function normalizeInstancePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim().replace(/\\/g, "/");
  if (!path || path.length > 512) return null;
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  if (path.split("/").some((segment) => segment === "..")) return null;
  return path.startsWith("/") ? path : `/${path}`;
}

export function parseEdits(value: unknown): AiFileEdit[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_AI_EDITS) return null;
  const edits: AiFileEdit[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { find, replace } = entry as Record<string, unknown>;
    if (typeof find !== "string" || typeof replace !== "string") return null;
    if (!find || find.length > MAX_AI_EDIT_CHARS || replace.length > MAX_AI_EDIT_CHARS) {
      return null;
    }
    edits.push({ find, replace });
  }
  return edits;
}

/** Applies exact find/replace edits; every `find` must occur exactly once. */
export function applyEdits(
  original: string,
  edits: AiFileEdit[]
): { content: string } | { error: AiFileEditError } {
  let content = original;
  for (const edit of edits) {
    const first = content.indexOf(edit.find);
    if (first < 0) return { error: "Edit text not found" };
    if (content.indexOf(edit.find, first + 1) >= 0) return { error: "Edit text is ambiguous" };
    content = content.slice(0, first) + edit.replace + content.slice(first + edit.find.length);
  }
  if (content.length > MAX_AI_FILE_WRITE_CHARS) return { error: "File too large" };
  return { content };
}

function clip(lines: string[], max: number): string[] {
  return lines.length > max ? [...lines.slice(0, max), `… (${lines.length - max} more)`] : lines;
}

/** Compact line diff: common prefix/suffix removed, changed block shown with -/+ markers. */
export function buildDiffPreview(before: string, after: string, maxLines = 30): string {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const removed = a.slice(start, endA + 1).map((line) => `- ${line}`);
  const added = b.slice(start, endB + 1).map((line) => `+ ${line}`);
  if (!removed.length && !added.length) return "(no change)";
  return [`@@ line ${start + 1}`, ...clip(removed, maxLines), ...clip(added, maxLines)].join("\n");
}
