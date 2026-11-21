import { describe, expect, it, vi } from "vitest";
import {
  buildFileCheckContext,
  checkConfigSyntax,
  comparePluginVersions,
  CONSOLE_MAX_LINES,
  crashReportFromConsole,
  hsErrFromConsole,
  isCleanStop,
  pickCrashReport,
  formatSyntaxErrors,
  redactSecrets,
  tailConsoleLog
} from "../ai_schedule_collectors";

describe("tailConsoleLog", () => {
  it("strips terminal escape codes and keeps the last lines", () => {
    const lines = Array.from({ length: CONSOLE_MAX_LINES + 50 }, (_, i) => `line ${i}`);
    const text = `\x1b[31mERROR\x1b[0m start\r\n${lines.join("\n")}`;
    const result = tailConsoleLog(text);
    expect(result).not.toContain("\x1b");
    expect(result.split("\n")).toHaveLength(CONSOLE_MAX_LINES);
    expect(result.endsWith(`line ${CONSOLE_MAX_LINES + 49}`)).toBe(true);
  });

  it("returns an empty string for missing logs", () => {
    expect(tailConsoleLog(undefined)).toBe("");
    expect(tailConsoleLog("\n \n")).toBe("");
  });
});

describe("redactSecrets", () => {
  it("hides credential values in properties, YAML and JSON", () => {
    const text = [
      "rcon.password=hunter2",
      "  api-key: abc",
      '  "token": "xyz",',
      "pvp=true",
      "password:",
      "server-port=25565"
    ].join("\n");
    expect(redactSecrets(text).split("\n")).toEqual([
      "rcon.password=<redacted>",
      "  api-key: <redacted>",
      '  "token": <redacted>,',
      "pvp=true",
      "password:",
      "server-port=25565"
    ]);
  });
});

describe("checkConfigSyntax", () => {
  it("accepts valid files", () => {
    expect(checkConfigSyntax("bukkit.yml", "settings:\n  allow-end: true\n")).toBe("");
    expect(checkConfigSyntax("ops.json", '[{"name":"Steve"}]')).toBe("");
    expect(checkConfigSyntax("server.properties", "#comment\npvp=true\nmotd=A Server\n")).toBe("");
  });

  it("reports broken files", () => {
    expect(checkConfigSyntax("bukkit.yml", "settings:\n  allow-end: [true\n")).not.toBe("");
    expect(checkConfigSyntax("ops.json", '[{"name":}]')).not.toBe("");
    expect(checkConfigSyntax("server.properties", "pvp=true\nthis line is wrong\n")).toContain(
      "Line 2"
    );
  });
});

describe("buildFileCheckContext", () => {
  it("lists syntax errors and never sends secrets", () => {
    const { context, syntaxErrors } = buildFileCheckContext([
      { path: "server.properties", text: "rcon.password=secret\npvp=true" },
      { path: "bukkit.yml", text: "a: [1" }
    ]);
    expect(context).not.toContain("secret");
    expect(syntaxErrors.map((file) => file.path)).toEqual(["bukkit.yml"]);
    expect(formatSyntaxErrors(syntaxErrors)).toContain("`bukkit.yml`");
  });

  it("bounds the total size sent to the model", () => {
    const big = "a=b\n".repeat(20000);
    const { checked } = buildFileCheckContext(
      Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.properties`, text: big }))
    );
    const total = checked.reduce((sum, file) => sum + file.content.length, 0);
    expect(total).toBeLessThanOrEqual(16000);
    expect(checked.every((file) => file.truncated)).toBe(true);
  });
});

describe("comparePluginVersions", () => {
  const profile = { loader: "paper", mcVersion: "1.21.1", kind: "plugin" as const, evidence: [] };
  const version = (id: string, date: string, gameVersions = ["1.21.1"]) => ({
    id,
    version_number: id,
    version_type: "release",
    loaders: ["paper"],
    game_versions: gameVersions,
    date_published: date,
    files: [{ url: "https://cdn.modrinth.com/x.jar", filename: `${id}.jar`, primary: true }]
  });

  it("classifies installed jars", async () => {
    const byHashes = vi.fn(async () => ({
      h1: {
        project: { title: "ViaVersion" },
        version: {
          id: "5.0",
          version_number: "5.0",
          project_id: "via",
          date_published: "2025-01-01"
        }
      },
      h2: {
        project: { title: "LuckPerms" },
        version: {
          id: "5.4",
          version_number: "5.4",
          project_id: "lp",
          date_published: "2025-06-01"
        }
      },
      h3: {
        project: { title: "Old" },
        version: {
          id: "1.0",
          version_number: "1.0",
          project_id: "old",
          date_published: "2020-01-01"
        }
      }
    }));
    const versions = vi.fn(async (projectId: string) => {
      if (projectId === "via") return [version("5.1", "2025-03-01"), version("5.0", "2025-01-01")];
      if (projectId === "lp") return [version("5.4", "2025-06-01")];
      return [version("1.1", "2021-01-01", ["1.8.8"])];
    });
    const rows = await comparePluginVersions(
      [
        { file: "ViaVersion-5.0.jar", hash: "h1" },
        { file: "LuckPerms-5.4.jar", hash: "h2" },
        { file: "Old-1.0.jar", hash: "h3" },
        { file: "Custom.jar", hash: "unknown", name: "Custom", version: "2.0" },
        { file: "notes.txt", hash: "h4" }
      ],
      profile,
      { byHashes, versions }
    );
    expect(rows.map((row) => [row.name, row.status, row.latest])).toEqual([
      ["ViaVersion", "update_available", "5.1"],
      ["LuckPerms", "up_to_date", "5.4"],
      ["Old", "no_compatible_version", ""],
      ["Custom", "not_found", ""]
    ]);
  });

  it("does not flag an installed version newer than the latest compatible one", async () => {
    const rows = await comparePluginVersions([{ file: "Beta.jar", hash: "h" }], profile, {
      byHashes: async () => ({
        h: {
          project: { title: "Beta" },
          version: { id: "2.0-beta", project_id: "b", date_published: "2025-09-01" }
        }
      }),
      versions: async () => [version("1.9", "2025-05-01")]
    });
    expect(rows[0].status).toBe("up_to_date");
  });
});

describe("crash helpers", () => {
  it("finds the crash files announced in the console", () => {
    const tail =
      "This crash report has been saved to: /srv/mc/crash-reports/crash-2026-11-21_03.12.44-server.txt\n" +
      "# An error report file with more information is saved as:\n# /srv/mc/hs_err_pid4242.log\n";
    expect(crashReportFromConsole(tail)).toBe("crash-2026-11-21_03.12.44-server.txt");
    expect(
      crashReportFromConsole("saved to: .\\crash-reports\\crash-2026-01-02_00.00.00-server.txt")
    ).toBe("crash-2026-01-02_00.00.00-server.txt");
    expect(hsErrFromConsole(tail)).toBe("hs_err_pid4242.log");
    expect(crashReportFromConsole("crash-reports/../../etc/passwd")).toBe("");
  });

  it("picks the crash report written around the stop", () => {
    const at = new Date(2026, 10, 21, 3, 15, 0).getTime();
    expect(
      pickCrashReport(
        [
          "crash-2026-11-20_22.00.00-server.txt",
          "crash-2026-11-21_03.12.44-server.txt",
          "crash-2026-11-21_03.14.01-server.txt",
          "notes.txt"
        ],
        at
      )
    ).toBe("crash-2026-11-21_03.14.01-server.txt");
    expect(pickCrashReport(["crash-2026-11-20_22.00.00-server.txt"], at)).toBe("");
  });

  it("tells clean stops from crashes", () => {
    const base = {
      id: "1",
      instanceUuid: "a",
      kind: "exit" as const,
      code: 0,
      error: "",
      at: 0,
      autoRestart: false,
      consoleTail: "[INFO] Stopping the server\n[INFO] Saving chunks\n"
    };
    expect(isCleanStop(base, false)).toBe(true);
    expect(isCleanStop({ ...base, code: 1 }, false)).toBe(false);
    expect(isCleanStop(base, true)).toBe(false);
    expect(isCleanStop({ ...base, consoleTail: "java.lang.OutOfMemoryError" }, false)).toBe(false);
    expect(isCleanStop({ ...base, kind: "start_failure" }, false)).toBe(false);
  });
});
