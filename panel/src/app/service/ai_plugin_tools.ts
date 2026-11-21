// Pure helpers for AI plugin/mod installation (no I/O, unit-testable).

export const PLUGIN_LOADERS = [
  "paper",
  "spigot",
  "bukkit",
  "purpur",
  "folia",
  "velocity",
  "bungeecord",
  "waterfall"
];
export const MOD_LOADERS = ["fabric", "forge", "neoforge", "quilt"];

// Loaders whose builds a given server can run (a Paper server runs Spigot/Bukkit plugins...).
const COMPATIBLE_LOADERS: Record<string, string[]> = {
  paper: ["paper", "spigot", "bukkit"],
  purpur: ["purpur", "paper", "spigot", "bukkit"],
  folia: ["folia"],
  spigot: ["spigot", "bukkit"],
  bukkit: ["bukkit"],
  velocity: ["velocity"],
  bungeecord: ["bungeecord", "waterfall"],
  waterfall: ["waterfall", "bungeecord"],
  fabric: ["fabric"],
  quilt: ["quilt", "fabric"],
  forge: ["forge"],
  neoforge: ["neoforge"]
};

// MCSManager instance types that are Paper forks.
const TYPE_ALIASES: Record<string, string> = { leaves: "paper", pufferfish: "paper" };

// Only official download hosts used by the MCSManager mod manager sources.
const ALLOWED_DOWNLOAD_HOSTS = new Set(["cdn.modrinth.com", "api.spiget.org", "cdn.spiget.org"]);

export const SUPPORTED_SOURCES = ["Modrinth", "SpigotMC"] as const;

export interface ServerProfile {
  loader?: string;
  mcVersion?: string;
  kind: "plugin" | "mod" | "unknown";
  evidence: string[];
}

export interface ProfileInput {
  type?: string;
  pingVersion?: string;
  versionHistory?: string | null;
  latestLog?: string | null;
  rootNames?: string[];
}

const MC_VERSION = /(\d+\.\d+(?:\.\d+)?)/;

function knownLoader(value?: string): string | undefined {
  if (!value) return undefined;
  const loader = TYPE_ALIASES[value.toLowerCase()] || value.toLowerCase();
  return COMPATIBLE_LOADERS[loader] ? loader : undefined;
}

/** Detects server software and Minecraft version from what the instance exposes. */
export function detectServerProfile(input: ProfileInput): ServerProfile {
  const evidence: string[] = [];
  let loader: string | undefined;
  let mcVersion: string | undefined;

  // Paper/Purpur/Folia: version_history.json {"currentVersion":"git-Paper-196 (MC: 1.21.1)"}
  if (input.versionHistory) {
    try {
      const current = String(JSON.parse(input.versionHistory)?.currentVersion || "");
      const match = /git-([A-Za-z]+)-\S+ \(MC: ([0-9][0-9.]*[0-9])\)/.exec(current);
      if (match) {
        loader = knownLoader(match[1]);
        mcVersion = match[2];
        evidence.push("version_history.json");
      }
    } catch {
      // ignore malformed file
    }
  }

  if (input.latestLog && (!loader || !mcVersion)) {
    const log = input.latestLog.slice(0, 20000);
    const version = /Starting minecraft server version ([0-9][0-9.]*[0-9])/i.exec(log);
    const running = /This server is running ([A-Za-z]+) version/i.exec(log);
    if (version && !mcVersion) mcVersion = version[1];
    if (running && !loader) loader = knownLoader(running[1]);
    if (version || running) evidence.push("logs/latest.log");
  }

  const typeMatch = /^minecraft\/java\/([a-z]+)/i.exec(input.type || "");
  if (!loader && typeMatch && knownLoader(typeMatch[1])) {
    loader = knownLoader(typeMatch[1]);
    evidence.push("instance type");
  }

  if (!mcVersion && input.pingVersion) {
    const match = MC_VERSION.exec(input.pingVersion);
    if (match) {
      mcVersion = match[1];
      evidence.push("server status");
    }
  }

  const names = (input.rootNames || []).map((name) => name.toLowerCase());
  for (const name of names) {
    const jar =
      /^(paper|purpur|folia|spigot|craftbukkit|fabric-server[a-z-]*|forge|neoforge)[-_]?(?:mc\.?)?(\d+\.\d+(?:\.\d+)?)[^/]*\.jar$/.exec(
        name
      );
    if (!jar) continue;
    if (!loader)
      loader = knownLoader(
        jar[1].replace(/^craftbukkit$/, "bukkit").replace(/^fabric-server.*/, "fabric")
      );
    if (!mcVersion) mcVersion = jar[2];
    evidence.push(name);
    break;
  }
  if (!loader) {
    if (names.includes("purpur.yml")) loader = "purpur";
    else if (names.includes("paper.yml")) loader = "paper";
    else if (names.includes("spigot.yml")) loader = "spigot";
    else if (names.includes("velocity.toml")) loader = "velocity";
    else if (names.includes(".fabric")) loader = "fabric";
    if (loader) evidence.push("server files");
  }

  let kind: ServerProfile["kind"] = "unknown";
  if (loader && PLUGIN_LOADERS.includes(loader)) kind = "plugin";
  else if (loader && MOD_LOADERS.includes(loader)) kind = "mod";
  else if (names.includes("plugins")) kind = "plugin";
  else if (names.includes("mods")) kind = "mod";

  return { loader, mcVersion, kind, evidence };
}

export interface CandidateFile {
  url: string;
  filename: string;
  primary?: boolean;
}

export interface CandidateVersion {
  id: string;
  name?: string;
  version_number?: string;
  version_type?: string;
  loaders?: string[];
  game_versions?: string[];
  files?: CandidateFile[];
}

export type PickError = "Version not found" | "Version not compatible" | "No compatible version";

function jarFiles(version: CandidateVersion) {
  return (version.files || []).filter(
    (file) => typeof file?.url === "string" && /\.jar$/i.test(String(file?.filename || ""))
  );
}

export function isLoaderCompatible(version: CandidateVersion, profile: ServerProfile) {
  if (!profile.loader || !version.loaders?.length) return true;
  const accepted = COMPATIBLE_LOADERS[profile.loader] || [profile.loader];
  return version.loaders.some((loader) => accepted.includes(String(loader).toLowerCase()));
}

export function isGameVersionCompatible(version: CandidateVersion, profile: ServerProfile) {
  if (!profile.mcVersion || !version.game_versions?.length) return true;
  return version.game_versions.includes(profile.mcVersion);
}

/** Picks the requested version, or the newest compatible release (API order is newest first). */
export function pickVersion(
  versions: CandidateVersion[],
  profile: ServerProfile,
  versionId?: string
):
  | { version: CandidateVersion; file: CandidateFile; fallbackUrl?: string; verified: boolean }
  | { error: PickError } {
  const candidates = versions.filter((version) => version && jarFiles(version).length > 0);
  const compatible = (version: CandidateVersion) =>
    isLoaderCompatible(version, profile) && isGameVersionCompatible(version, profile);
  let version: CandidateVersion | undefined;
  if (versionId) {
    version = candidates.find((item) => String(item.id) === versionId);
    if (!version) return { error: "Version not found" };
    if (!compatible(version)) return { error: "Version not compatible" };
  } else {
    const matching = candidates.filter(compatible);
    version =
      matching.find((item) => !item.version_type || item.version_type === "release") || matching[0];
    if (!version) return { error: "No compatible version" };
  }
  const files = jarFiles(version);
  const file = files.find((item) => item.primary) || files[0];
  const fallback = files.find((item) => item.url !== file.url);
  const verified = Boolean(
    (!profile.loader || version.loaders?.length) &&
      (!profile.mcVersion || version.game_versions?.length)
  );
  return { version, file, fallbackUrl: fallback?.url, verified };
}

export function installKind(version: CandidateVersion, profile: ServerProfile): "plugin" | "mod" {
  const loaders = (version.loaders || []).map((loader) => String(loader).toLowerCase());
  if (loaders.some((loader) => PLUGIN_LOADERS.includes(loader))) return "plugin";
  if (loaders.some((loader) => MOD_LOADERS.includes(loader))) return "mod";
  return profile.kind === "mod" ? "mod" : "plugin";
}

/** Reduces a remote file name to a safe single .jar file name. */
export function safeJarFileName(value: unknown): string | null {
  const base = String(value ?? "")
    .split(/[\\/]/)
    .pop()!
    .replace(/[^A-Za-z0-9._+-]/g, "_")
    .replace(/^\.+/, "");
  if (!/\.jar$/i.test(base) || base.length > 128 || base.length < 5) return null;
  return base;
}

export function isAllowedDownloadUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && ALLOWED_DOWNLOAD_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function normalizeName(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Existing jars that are very likely the same plugin (candidate for replacement). */
export function findInstalledCopies(
  installed: Array<{ name?: string; file?: string; folder?: string }>,
  title: string
) {
  const wanted = normalizeName(title);
  if (wanted.length < 3) return [];
  return installed.filter((item) => {
    const file = normalizeName(String(item.file || "").replace(/\.jar(\.disabled)?$/i, ""));
    return (
      normalizeName(item.name) === wanted ||
      file === wanted ||
      (/^\d/.test(file.slice(wanted.length)) && file.startsWith(wanted))
    );
  });
}

/** "ViaVersion-5.4.1.jar" -> "ViaVersion" (used for display and to find an older copy). */
export function projectNameFromFile(fileName: string): string {
  return fileName
    .replace(/\.jar$/i, "")
    .replace(/[-_ +]?v?\d[\s\S]*$/i, "")
    .slice(0, 80);
}
