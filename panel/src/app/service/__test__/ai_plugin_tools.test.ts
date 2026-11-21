import { describe, expect, it } from "vitest";
import {
  detectServerProfile,
  findInstalledCopies,
  isAllowedDownloadUrl,
  pickVersion,
  projectNameFromFile,
  safeJarFileName
} from "../ai_plugin_tools";

const version = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  version_number: id,
  version_type: "release",
  loaders: ["paper", "spigot"],
  game_versions: ["1.21.1", "26.2"],
  files: [
    { url: `https://cdn.modrinth.com/${id}.jar`, filename: `ViaVersion-${id}.jar`, primary: true }
  ],
  ...extra
});

describe("AI plugin helpers: server detection", () => {
  it("reads Paper's version_history.json", () => {
    expect(
      detectServerProfile({
        versionHistory: JSON.stringify({ currentVersion: "git-Paper-12 (MC: 26.2)" }),
        type: "minecraft/java"
      })
    ).toMatchObject({ loader: "paper", mcVersion: "26.2", kind: "plugin" });
  });

  it("falls back to the server log, instance type, status and file names", () => {
    expect(
      detectServerProfile({
        latestLog:
          "[Server thread/INFO]: Starting minecraft server version 1.21.1\n" +
          "[Server thread/INFO]: This server is running Purpur version 1.21.1-2300",
        type: "universal"
      })
    ).toMatchObject({ loader: "purpur", mcVersion: "1.21.1", kind: "plugin" });
    expect(
      detectServerProfile({ type: "minecraft/java/fabric", pingVersion: "1.20.4" })
    ).toMatchObject({ loader: "fabric", mcVersion: "1.20.4", kind: "mod" });
    expect(detectServerProfile({ rootNames: ["paper-1.21.4-15.jar", "plugins"] })).toMatchObject({
      loader: "paper",
      mcVersion: "1.21.4"
    });
    expect(detectServerProfile({ rootNames: ["start.sh"] })).toMatchObject({ kind: "unknown" });
  });
});

describe("AI plugin helpers: version choice", () => {
  const paper = { loader: "paper", mcVersion: "26.2", kind: "plugin" as const, evidence: [] };

  it("picks the newest compatible release", () => {
    const versions = [
      version("6.0-beta", { version_type: "beta" }),
      version("5.9", { game_versions: ["1.21.1"] }),
      version("5.8")
    ];
    const picked = pickVersion(versions, paper);
    expect("error" in picked ? picked.error : picked.version.id).toBe("5.8");
  });

  it("refuses incompatible loaders or game versions", () => {
    expect(pickVersion([version("1", { loaders: ["fabric"] })], paper)).toEqual({
      error: "No compatible version"
    });
    expect(pickVersion([version("1", { game_versions: ["1.8.8"] })], paper, "1")).toEqual({
      error: "Version not compatible"
    });
    expect(pickVersion([version("1")], paper, "404")).toEqual({ error: "Version not found" });
  });

  it("marks sources without compatibility data as unverified", () => {
    const picked = pickVersion([version("1", { loaders: [], game_versions: [] })], paper);
    expect("error" in picked ? null : picked.verified).toBe(false);
  });
});

describe("AI plugin helpers: safety", () => {
  it("keeps a single safe jar file name", () => {
    expect(safeJarFileName("ViaVersion-5.4.1.jar")).toBe("ViaVersion-5.4.1.jar");
    expect(safeJarFileName("../../server.jar")).toBe("server.jar");
    expect(safeJarFileName("..\\..\\evil.jar")).toBe("evil.jar");
    expect(safeJarFileName("plugin.zip")).toBeNull();
    expect(safeJarFileName("Plugin Name (1).jar")).toBe("Plugin_Name__1_.jar");
  });

  it("only allows official HTTPS download hosts", () => {
    expect(isAllowedDownloadUrl("https://cdn.modrinth.com/data/x/ViaVersion.jar")).toBe(true);
    expect(isAllowedDownloadUrl("https://cdn.spiget.org/v2/resources/1/download")).toBe(true);
    expect(isAllowedDownloadUrl("http://cdn.modrinth.com/x.jar")).toBe(false);
    expect(isAllowedDownloadUrl("https://evil.example/x.jar")).toBe(false);
    expect(isAllowedDownloadUrl("not a url")).toBe(false);
  });

  it("finds an older copy of the same plugin but not similar plugins", () => {
    const installed = [
      { name: "ViaVersion", file: "ViaVersion-5.3.0.jar", folder: "plugins" },
      { name: "ViaBackwards", file: "ViaBackwards-5.3.0.jar", folder: "plugins" },
      { name: "spark", file: "spark.jar", folder: "plugins" }
    ];
    expect(findInstalledCopies(installed, "ViaVersion").map((item) => item.file)).toEqual([
      "ViaVersion-5.3.0.jar"
    ]);
    expect(projectNameFromFile("ViaVersion-5.4.1.jar")).toBe("ViaVersion");
    expect(projectNameFromFile("LuckPerms-Bukkit-5.4.137.jar")).toBe("LuckPerms-Bukkit");
  });
});
