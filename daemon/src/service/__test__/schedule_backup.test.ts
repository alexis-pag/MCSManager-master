import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../log", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const zip = vi.fn();
vi.mock("../system_file", async () => {
  const actual = await vi.importActual<any>("../system_file");
  class TestFileManager extends actual.default {
    async zip(sourceZip: string, files: string[]) {
      zip(sourceZip, files);
      await fs.writeFile(this.toAbsolutePath(sourceZip), "zip");
      return true;
    }
  }
  return { default: TestFileManager };
});

import {
  backupFileName,
  parseBackupPayload,
  pruneBackups,
  runScheduledBackup
} from "../schedule_backup";

describe("parseBackupPayload", () => {
  it("reads JSON payloads", () => {
    expect(parseBackupPayload('{"paths":["world","world_nether"],"keep":3}')).toEqual({
      paths: ["world", "world_nether"],
      keep: 3
    });
  });

  it("reads a plain folder name and an empty payload", () => {
    expect(parseBackupPayload("plugins")).toEqual({ paths: ["plugins"], keep: 7 });
    expect(parseBackupPayload("")).toEqual({ paths: ["world"], keep: 7 });
  });

  it.each([
    '{"paths":["../other"],"keep":3}',
    '{"paths":["world/region"],"keep":3}',
    '{"paths":["C:\\\\Windows"],"keep":3}',
    '{"paths":["backups"],"keep":3}',
    '{"paths":[".."],"keep":3}',
    '{"paths":[],"keep":3}',
    '{"paths":["a","b","c","d","e","f"],"keep":3}',
    '{"paths":["world"],"keep":0}',
    '{"paths":["world"],"keep":31}',
    '{"paths":["world"],"keep":2.5}',
    "{not json"
  ])("rejects %s", (payload) => {
    expect(() => parseBackupPayload(payload)).toThrow();
  });
});

describe("backups", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsm-backup-"));
    zip.mockClear();
  });
  afterEach(async () => {
    await fs.remove(dir);
  });

  it("names archives with a sortable timestamp", () => {
    expect(backupFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe("backup-20260102-030405.zip");
  });

  it("keeps only the newest archives and ignores other files", async () => {
    const backups = path.join(dir, "backups");
    await fs.ensureDir(backups);
    for (const name of [
      "backup-20260101-000000.zip",
      "backup-20260103-000000.zip",
      "backup-20260102-000000.zip",
      "manual.zip"
    ]) {
      await fs.writeFile(path.join(backups, name), "");
    }
    expect(await pruneBackups(backups, 2)).toEqual(["backup-20260101-000000.zip"]);
    expect((await fs.readdir(backups)).sort()).toEqual([
      "backup-20260102-000000.zip",
      "backup-20260103-000000.zip",
      "manual.zip"
    ]);
  });

  it("zips existing folders into backups/ and prunes", async () => {
    await fs.ensureDir(path.join(dir, "world"));
    await fs.ensureDir(path.join(dir, "backups"));
    await fs.writeFile(path.join(dir, "backups", "backup-20200101-000000.zip"), "");
    const now = new Date(2026, 10, 21, 12, 0, 0);
    const done = await runScheduledBackup(
      "uuid",
      dir,
      { paths: ["world", "world_nether"], keep: 1 },
      undefined,
      now
    );
    expect(done).toBe(true);
    expect(zip).toHaveBeenCalledWith("backup-20261121-120000.zip", ["world"]);
    expect(await fs.readdir(path.join(dir, "backups"))).toEqual(["backup-20261121-120000.zip"]);
    expect(await fs.pathExists(path.join(dir, "backup-20261121-120000.zip"))).toBe(false);
  });

  it("fails when no folder exists", async () => {
    await expect(runScheduledBackup("uuid", dir, { paths: ["world"], keep: 1 })).rejects.toThrow();
    expect(zip).not.toHaveBeenCalled();
  });

  it("skips an overlapping backup of the same instance", async () => {
    await fs.ensureDir(path.join(dir, "world"));
    const first = runScheduledBackup("same", dir, { paths: ["world"], keep: 5 });
    const second = await runScheduledBackup("same", dir, { paths: ["world"], keep: 5 });
    expect(second).toBe(false);
    expect(await first).toBe(true);
  });
});
