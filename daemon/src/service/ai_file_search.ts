import fs from "fs-extra";
import path from "path";
import type FileManager from "./system_file";

// Read-only searches over an instance folder for the AI assistant (`grep`, `find`, `du`).
// Paths go through the file manager's workspace checks; symlinks are never followed, and
// every walk is bounded so a large folder cannot stall the daemon.

export const SEARCH_LIMITS = {
  maxEntries: 5000,
  maxDepth: 12,
  maxGrepFileBytes: 2 * 1024 * 1024,
  maxResults: 200,
  maxLineChars: 300,
  maxPatternChars: 200,
  timeMs: 5000
};

export type FileSearchMode = "workspace" | "stat" | "grep" | "find" | "du";

export interface FileSearchRequest {
  mode?: unknown;
  target?: unknown;
  pattern?: unknown;
  ignoreCase?: unknown;
  recursive?: unknown;
}

export class FileSearchError extends Error {}

/** True when the instance folder is the root of a disk: the AI file commands refuse it. */
export function isDiskRootWorkspace(fileManager: FileManager): boolean {
  if (fileManager.isRootTopRath()) return true;
  const resolved = path.resolve(fileManager.topPath);
  return path.parse(resolved).root === resolved;
}

/** `find -name` glob (`*`, `?`) to an anchored, case-insensitive regex. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

interface WalkEntry {
  absolute: string;
  relative: string;
  isDirectory: boolean;
  size: number;
}

/** Breadth-first walk without following symlinks. */
async function walk(
  root: string,
  topPath: string,
  recursive: boolean,
  visit: (entry: WalkEntry) => Promise<boolean | void>
): Promise<boolean> {
  const deadline = Date.now() + SEARCH_LIMITS.timeMs;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let seen = 0;
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (++seen > SEARCH_LIMITS.maxEntries || Date.now() > deadline) return true;
      if (dirent.isSymbolicLink()) continue;
      const absolute = path.join(dir, dirent.name);
      const isDirectory = dirent.isDirectory();
      let size = 0;
      if (!isDirectory) {
        try {
          size = (await fs.lstat(absolute)).size;
        } catch {
          continue;
        }
      }
      const relative = path.relative(topPath, absolute).split(path.sep).join("/");
      if ((await visit({ absolute, relative, isDirectory, size })) === true) return true;
      if (isDirectory && recursive && depth + 1 < SEARCH_LIMITS.maxDepth) {
        queue.push({ dir: absolute, depth: depth + 1 });
      }
    }
  }
  return false;
}

function clipLine(line: string) {
  return line.length > SEARCH_LIMITS.maxLineChars
    ? `${line.slice(0, SEARCH_LIMITS.maxLineChars)}…`
    : line;
}

async function grepFile(
  file: WalkEntry,
  needle: string,
  ignoreCase: boolean,
  matches: Array<{ file: string; line: number; text: string }>
): Promise<boolean> {
  if (file.size > SEARCH_LIMITS.maxGrepFileBytes) return false;
  let text: string;
  try {
    text = await fs.readFile(file.absolute, "utf-8");
  } catch {
    return false;
  }
  if (text.includes("\u0000")) return false; // binary
  const wanted = ignoreCase ? needle.toLowerCase() : needle;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = ignoreCase ? lines[index].toLowerCase() : lines[index];
    if (!line.includes(wanted)) continue;
    matches.push({ file: file.relative, line: index + 1, text: clipLine(lines[index]) });
    if (matches.length >= SEARCH_LIMITS.maxResults) return true;
  }
  return false;
}

/** Runs one read-only search. `target` is relative to the instance folder. */
export async function searchFiles(fileManager: FileManager, request: FileSearchRequest) {
  const mode = String(request.mode || "") as FileSearchMode;
  const diskRoot = isDiskRootWorkspace(fileManager);
  if (mode === "workspace") return { diskRoot };
  if (!["stat", "grep", "find", "du"].includes(mode)) throw new FileSearchError("Invalid mode");
  if (diskRoot) throw new FileSearchError("Instance folder is a disk root");

  const target = typeof request.target === "string" && request.target ? request.target : ".";
  if (!fileManager.checkPath(target)) throw new FileSearchError("Invalid path");
  const absolute = fileManager.toAbsolutePath(target);
  const stat = await fs.lstat(absolute).catch(() => null);
  if (mode === "stat") {
    if (!stat) return { type: "missing" };
    return { type: stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "folder" : "file" };
  }
  if (!stat || stat.isSymbolicLink()) throw new FileSearchError("Path not found");
  const topPath = path.resolve(fileManager.topPath);
  const relative = path.relative(topPath, absolute).split(path.sep).join("/");
  const rootEntry: WalkEntry = {
    absolute,
    relative,
    isDirectory: stat.isDirectory(),
    size: stat.size
  };

  if (mode === "du") {
    let bytes = stat.isDirectory() ? 0 : stat.size;
    let files = stat.isDirectory() ? 0 : 1;
    const truncated = stat.isDirectory()
      ? await walk(absolute, topPath, true, async (entry) => {
          if (!entry.isDirectory) {
            bytes += entry.size;
            files++;
          }
        })
      : false;
    return { path: relative || ".", bytes, files, truncated };
  }

  const pattern = typeof request.pattern === "string" ? request.pattern : "";
  if (!pattern || pattern.length > SEARCH_LIMITS.maxPatternChars || pattern.includes("\u0000")) {
    throw new FileSearchError("Invalid pattern");
  }

  if (mode === "find") {
    const matcher = globToRegExp(pattern);
    const results: Array<{ path: string; type: "folder" | "file"; size: number }> = [];
    if (!stat.isDirectory()) throw new FileSearchError("Not a folder");
    const truncated = await walk(absolute, topPath, true, async (entry) => {
      if (!matcher.test(path.basename(entry.absolute))) return;
      results.push({
        path: entry.relative,
        type: entry.isDirectory ? "folder" : "file",
        size: entry.size
      });
      return results.length >= SEARCH_LIMITS.maxResults;
    });
    return { results, truncated };
  }

  // grep: plain text (no regular expressions, so a pattern cannot stall the daemon)
  const ignoreCase = request.ignoreCase === true;
  const matches: Array<{ file: string; line: number; text: string }> = [];
  let truncated = false;
  if (stat.isDirectory()) {
    if (request.recursive !== true) throw new FileSearchError("Is a folder");
    truncated = await walk(absolute, topPath, true, async (entry) =>
      entry.isDirectory ? false : grepFile(entry, pattern, ignoreCase, matches)
    );
  } else {
    truncated = await grepFile(rootEntry, pattern, ignoreCase, matches);
  }
  return { matches, truncated };
}
