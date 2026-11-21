import fs from "fs-extra";
import path from "path";
import logger from "./log";
import FileManager from "./system_file";

export const BACKUP_DIR = "backups";
export const BACKUP_DEFAULT_KEEP = 7;
export const BACKUP_MAX_KEEP = 30;
export const BACKUP_MAX_PATHS = 5;
const BACKUP_FILE_PATTERN = /^backup-\d{8}-\d{6}\.zip$/;
// Top-level entries only: the zip tool runs in the archive directory and receives base names.
const ENTRY_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,63}$/;

export interface BackupPayload {
  paths: string[];
  keep: number;
}

/**
 * Parses and validates a backup action payload: JSON `{"paths": [...], "keep": n}`, or a plain
 * folder name (keep defaults to 7). Throws on any invalid value.
 */
export function parseBackupPayload(payload: unknown): BackupPayload {
  const raw = typeof payload === "string" ? payload.trim() : "";
  let paths: unknown = [];
  let keep: unknown = BACKUP_DEFAULT_KEEP;
  if (raw.startsWith("{")) {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Invalid backup payload");
    }
    paths = parsed?.paths;
    if (parsed?.keep != null && parsed.keep !== "") keep = Number(parsed.keep);
  } else {
    paths = raw ? [raw] : ["world"];
  }

  if (!Array.isArray(paths) || paths.length < 1 || paths.length > BACKUP_MAX_PATHS) {
    throw new Error(`A backup must contain 1 to ${BACKUP_MAX_PATHS} folders`);
  }
  const names = paths.map((item) => (typeof item === "string" ? item.trim() : ""));
  for (const name of names) {
    if (
      !ENTRY_NAME_PATTERN.test(name) ||
      name === "." ||
      name === ".." ||
      name.toLowerCase() === BACKUP_DIR
    ) {
      throw new Error(`Invalid backup folder: ${name.slice(0, 64)}`);
    }
  }
  if (typeof keep !== "number" || !Number.isInteger(keep) || keep < 1 || keep > BACKUP_MAX_KEEP) {
    throw new Error(`Backup retention must be an integer from 1 to ${BACKUP_MAX_KEEP}`);
  }
  return { paths: Array.from(new Set(names)), keep };
}

export function backupFileName(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `backup-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.zip`
  );
}

/** Deletes the oldest backup archives beyond `keep`. Returns the deleted file names. */
export async function pruneBackups(backupDir: string, keep: number): Promise<string[]> {
  if (!(await fs.pathExists(backupDir))) return [];
  const files = (await fs.readdir(backupDir)).filter((name) => BACKUP_FILE_PATTERN.test(name));
  // Names embed the timestamp, so lexical order is chronological.
  files.sort();
  const removed = files.slice(0, Math.max(0, files.length - keep));
  for (const name of removed) {
    await fs.remove(path.join(backupDir, name));
  }
  return removed;
}

const runningBackups = new Set<string>();

/**
 * Zips the given top-level folders of the instance into backups/backup-<date>.zip and keeps
 * only the newest `keep` archives. Returns false when a backup of this instance is already
 * running (the firing is skipped).
 */
export async function runScheduledBackup(
  instanceUuid: string,
  cwd: string,
  payload: BackupPayload,
  fileCode?: string,
  now = new Date()
): Promise<boolean> {
  if (runningBackups.has(instanceUuid)) {
    logger.warn(`[Schedule] Backup skipped for instance ${instanceUuid}: previous backup running`);
    return false;
  }
  runningBackups.add(instanceUuid);
  const fileManager = new FileManager(cwd, fileCode);
  const archiveName = backupFileName(now);
  try {
    const existing = payload.paths.filter((name) => fileManager.check(name));
    if (existing.length === 0) throw new Error("None of the backup folders exist");
    // The zip tool writes next to the source entries; move the archive afterwards.
    await fileManager.zip(archiveName, existing);
    const backupDir = fileManager.toAbsolutePath(BACKUP_DIR);
    await fs.ensureDir(backupDir);
    const source = fileManager.toAbsolutePath(archiveName);
    if (!(await fs.pathExists(source))) throw new Error("Backup archive was not created");
    await fs.move(source, path.join(backupDir, archiveName), { overwrite: true });
    const removed = await pruneBackups(backupDir, payload.keep);
    logger.info(
      `[Schedule] Backup ${archiveName} created for instance ${instanceUuid}` +
        (removed.length ? `, removed ${removed.length} old backup(s)` : "")
    );
    return true;
  } catch (error: any) {
    await fs.remove(path.join(fileManager.topPath, archiveName)).catch(() => undefined);
    logger.error(
      `[Schedule] Backup failed for instance ${instanceUuid}: ${String(error?.message || error)}`
    );
    throw error;
  } finally {
    runningBackups.delete(instanceUuid);
  }
}
