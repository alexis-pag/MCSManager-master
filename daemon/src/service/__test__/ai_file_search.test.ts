import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  globToRegExp,
  isDiskRootWorkspace,
  searchFiles,
  SEARCH_LIMITS
} from "../ai_file_search";
import FileManager from "../system_file";

// Real temp workspace: proves the AI searches stay inside the instance folder.
let root = "";
let workspace = "";
let outside = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mcsm-ai-search-"));
  workspace = path.join(root, "instance");
  outside = path.join(root, "secret");
  await fs.ensureDir(path.join(workspace, "logs"));
  await fs.ensureDir(path.join(workspace, "plugins", "Essentials"));
  await fs.ensureDir(outside);
  await fs.writeFile(
    path.join(workspace, "logs", "latest.log"),
    "[INFO] Starting\n[ERROR] Could not load plugin\n[WARN] error in config\n"
  );
  await fs.writeFile(path.join(workspace, "server.properties"), "max-players=20\n");
  await fs.writeFile(path.join(workspace, "plugins", "Essentials", "config.yml"), "x: 1\n");
  await fs.writeFile(path.join(workspace, "plugins", "Essentials.jar"), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(outside, "token.txt"), "ERROR secret token\n");
  // A link leading outside the instance folder must never be followed.
  await fs.symlink(outside, path.join(workspace, "escape"), "junction").catch(() => undefined);
});

afterAll(async () => {
  await fs.remove(root);
});

const manager = () => new FileManager(workspace);

describe("AI file search", () => {
  it("greps plain text in one file, optionally ignoring case", async () => {
    const result: any = await searchFiles(manager(), {
      mode: "grep",
      target: "logs/latest.log",
      pattern: "error",
      ignoreCase: true
    });
    expect(result.matches).toEqual([
      { file: "logs/latest.log", line: 2, text: "[ERROR] Could not load plugin" },
      { file: "logs/latest.log", line: 3, text: "[WARN] error in config" }
    ]);
    const exact: any = await searchFiles(manager(), {
      mode: "grep",
      target: "logs/latest.log",
      pattern: "error"
    });
    expect(exact.matches).toHaveLength(1);
  });

  it("treats the pattern as text, not as a regular expression", async () => {
    const result: any = await searchFiles(manager(), {
      mode: "grep",
      target: "logs/latest.log",
      pattern: "(a+)+$"
    });
    expect(result.matches).toEqual([]);
  });

  it("requires -r for folders and never reads through a link leading outside", async () => {
    await expect(
      searchFiles(manager(), { mode: "grep", target: ".", pattern: "ERROR" })
    ).rejects.toThrow("Is a folder");
    const result: any = await searchFiles(manager(), {
      mode: "grep",
      target: ".",
      pattern: "ERROR",
      recursive: true
    });
    expect(result.matches.map((match: any) => match.file)).toEqual(["logs/latest.log"]);
  });

  it("refuses paths outside the instance folder", async () => {
    await expect(
      searchFiles(manager(), { mode: "grep", target: "../secret/token.txt", pattern: "ERROR" })
    ).rejects.toThrow();
    await expect(
      searchFiles(manager(), { mode: "du", target: path.join(outside, "token.txt") })
    ).rejects.toThrow();
  });

  it("finds files by name and sizes folders", async () => {
    const found: any = await searchFiles(manager(), { mode: "find", target: ".", pattern: "*.yml" });
    expect(found.results.map((item: any) => item.path)).toEqual(["plugins/Essentials/config.yml"]);
    const size: any = await searchFiles(manager(), { mode: "du", target: "plugins" });
    expect(size).toMatchObject({ path: "plugins", files: 2, bytes: 3 + 5, truncated: false });
  });

  it("skips binary files and refuses empty or oversized patterns", async () => {
    const result: any = await searchFiles(manager(), {
      mode: "grep",
      target: "plugins/Essentials.jar",
      pattern: "\u0001"
    });
    expect(result.matches).toEqual([]);
    await expect(
      searchFiles(manager(), { mode: "grep", target: ".", pattern: "" })
    ).rejects.toThrow("Invalid pattern");
    await expect(
      searchFiles(manager(), {
        mode: "find",
        target: ".",
        pattern: "x".repeat(SEARCH_LIMITS.maxPatternChars + 1)
      })
    ).rejects.toThrow("Invalid pattern");
  });

  it("reports and refuses an instance folder that is a disk root", async () => {
    const diskRoot = new FileManager(path.parse(workspace).root);
    expect(isDiskRootWorkspace(diskRoot)).toBe(true);
    expect(await searchFiles(diskRoot, { mode: "workspace" })).toEqual({ diskRoot: true });
    await expect(searchFiles(diskRoot, { mode: "du", target: "." })).rejects.toThrow("disk root");
    expect(await searchFiles(manager(), { mode: "workspace" })).toEqual({ diskRoot: false });
  });

  it("tells files, folders and missing paths apart", async () => {
    expect(await searchFiles(manager(), { mode: "stat", target: "logs" })).toEqual({ type: "folder" });
    expect(await searchFiles(manager(), { mode: "stat", target: "server.properties" })).toEqual({
      type: "file"
    });
    expect(await searchFiles(manager(), { mode: "stat", target: "nope" })).toEqual({
      type: "missing"
    });
  });

  it("converts find globs safely", () => {
    expect(globToRegExp("*.jar").test("Essentials.jar")).toBe(true);
    expect(globToRegExp("*.jar").test("jar")).toBe(false);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
    expect(globToRegExp("log?.txt").test("log1.txt")).toBe(true);
  });
});
