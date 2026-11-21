import axios from "axios";

// Resolves the official installer of a Minecraft mod loader for the AI assistant. The model
// only chooses the loader and the versions: URLs, checksums and arguments come from here.

export const MOD_LOADERS = ["forge", "neoforge", "fabric"] as const;
export type ModLoader = (typeof MOD_LOADERS)[number];

const FORGE_MAVEN = "https://maven.minecraftforge.net/net/minecraftforge/forge";
const FORGE_PROMOTIONS =
  "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const NEOFORGE_MAVEN = "https://maven.neoforged.net/releases/net/neoforged/neoforge";
const FABRIC_META = "https://meta.fabricmc.net/v2/versions";
const FABRIC_MAVEN_HOST = "maven.fabricmc.net";

export interface LoaderHttp {
  getText(url: string): Promise<string>;
  getJson(url: string): Promise<any>;
}

export const defaultLoaderHttp: LoaderHttp = {
  async getText(url) {
    const response = await axios.get(url, {
      timeout: 15000,
      responseType: "text",
      maxContentLength: 4 * 1024 * 1024,
      transformResponse: (data) => data
    });
    return String(response.data ?? "");
  },
  async getJson(url) {
    const response = await axios.get(url, { timeout: 15000, maxContentLength: 4 * 1024 * 1024 });
    return response.data;
  }
};

export class LoaderError extends Error {}

export interface LoaderInstall {
  loader: ModLoader;
  minecraftVersion: string;
  loaderVersion: string;
  url: string;
  fileName: string;
  sha256: string;
  /** Arguments after `java -jar <fileName>`. */
  installArgs: string[];
  /** Start command to configure once installed, per daemon platform. */
  startCommand: { windows: string; other: string };
}

const MC_VERSION = /^\d{1,3}(\.\d{1,3}){1,2}$/;
const LOADER_VERSION = /^[0-9][0-9A-Za-z.+-]{0,40}$/;

async function sha256Of(http: LoaderHttp, url: string) {
  const text = (await http.getText(`${url}.sha256`).catch(() => "")).trim();
  const sha = text.split(/\s+/)[0]?.toLowerCase() || "";
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new LoaderError("Checksum unavailable");
  return sha;
}

function argsFiles(group: string, version: string) {
  const base = `java @user_jvm_args.txt @libraries/${group}/${version}`;
  return { windows: `${base}/win_args.txt nogui`, other: `${base}/unix_args.txt nogui` };
}

/** 1.16.5 and older Forge servers start from a jar instead of the args files. */
function isLegacyForge(minecraftVersion: string) {
  const [major, minor] = minecraftVersion.split(".").map(Number);
  return major === 1 && minor < 17;
}

/** NeoForge version prefix: MC 1.21.1 → "21.1.", year-based MC 26.3 → "26.3.0.". */
export function neoForgePrefix(minecraftVersion: string) {
  const parts = minecraftVersion.split(".");
  if (parts[0] === "1") return `${parts[1]}.${parts[2] || "0"}.`;
  return `${parts[0]}.${parts[1]}.${parts[2] || "0"}.`;
}

export async function resolveLoaderInstall(
  input: { loader: unknown; minecraftVersion: unknown; loaderVersion?: unknown },
  http: LoaderHttp = defaultLoaderHttp
): Promise<LoaderInstall> {
  const loader = String(input.loader || "").toLowerCase() as ModLoader;
  if (!MOD_LOADERS.includes(loader)) throw new LoaderError("Unknown loader");
  const minecraftVersion = String(input.minecraftVersion || "").trim();
  if (!MC_VERSION.test(minecraftVersion)) throw new LoaderError("Invalid Minecraft version");
  let loaderVersion =
    input.loaderVersion == null || input.loaderVersion === ""
      ? ""
      : String(input.loaderVersion).trim();
  if (loaderVersion && !LOADER_VERSION.test(loaderVersion)) {
    throw new LoaderError("Invalid loader version");
  }

  if (loader === "forge") {
    if (!loaderVersion) {
      const promos = (await http.getJson(FORGE_PROMOTIONS))?.promos || {};
      loaderVersion = String(
        promos[`${minecraftVersion}-recommended`] || promos[`${minecraftVersion}-latest`] || ""
      );
      if (!LOADER_VERSION.test(loaderVersion)) throw new LoaderError("Version not found");
    }
    const full = `${minecraftVersion}-${loaderVersion}`;
    const metadata = await http.getText(`${FORGE_MAVEN}/maven-metadata.xml`);
    if (!metadata.includes(`<version>${full}</version>`)) {
      throw new LoaderError("Version not found");
    }
    const fileName = `forge-${full}-installer.jar`;
    const url = `${FORGE_MAVEN}/${full}/${fileName}`;
    return {
      loader,
      minecraftVersion,
      loaderVersion,
      url,
      fileName,
      sha256: await sha256Of(http, url),
      installArgs: ["--installServer"],
      startCommand: isLegacyForge(minecraftVersion)
        ? {
            windows: `java -jar forge-${full}.jar nogui`,
            other: `java -jar forge-${full}.jar nogui`
          }
        : argsFiles("net/minecraftforge/forge", full)
    };
  }

  if (loader === "neoforge") {
    const metadata = await http.getText(`${NEOFORGE_MAVEN}/maven-metadata.xml`);
    const versions: string[] = [];
    const versionTag = /<version>([^<]+)<\/version>/g;
    let match: RegExpExecArray | null;
    while ((match = versionTag.exec(metadata))) versions.push(match[1]);
    const prefix = neoForgePrefix(minecraftVersion);
    const candidates = versions.filter((version) => version.startsWith(prefix));
    if (!loaderVersion) {
      const stable = candidates.filter((version) => !/beta|alpha/i.test(version));
      loaderVersion = (stable.length ? stable : candidates).slice(-1)[0] || "";
    }
    if (!loaderVersion || !candidates.includes(loaderVersion)) {
      throw new LoaderError("Version not found");
    }
    const fileName = `neoforge-${loaderVersion}-installer.jar`;
    const url = `${NEOFORGE_MAVEN}/${loaderVersion}/${fileName}`;
    return {
      loader,
      minecraftVersion,
      loaderVersion,
      url,
      fileName,
      sha256: await sha256Of(http, url),
      installArgs: ["--installServer"],
      startCommand: argsFiles("net/neoforged/neoforge", loaderVersion)
    };
  }

  // fabric
  const installers = await http.getJson(`${FABRIC_META}/installer`);
  const installer = (Array.isArray(installers) ? installers : []).find(
    (item: any) => item?.stable && typeof item.url === "string" && typeof item.version === "string"
  );
  let installerUrl: URL;
  try {
    installerUrl = new URL(String(installer?.url || ""));
  } catch {
    throw new LoaderError("Version not found");
  }
  if (installerUrl.protocol !== "https:" || installerUrl.hostname !== FABRIC_MAVEN_HOST) {
    throw new LoaderError("Version not found");
  }
  const installerVersion = String(installer.version);
  if (!LOADER_VERSION.test(installerVersion)) throw new LoaderError("Version not found");
  const loaders = await http.getJson(`${FABRIC_META}/loader/${minecraftVersion}`);
  const loaderVersions = (Array.isArray(loaders) ? loaders : [])
    .map((item: any) => ({
      version: String(item?.loader?.version || ""),
      stable: Boolean(item?.loader?.stable)
    }))
    .filter((item) => LOADER_VERSION.test(item.version));
  if (!loaderVersion) {
    loaderVersion =
      (loaderVersions.find((item) => item.stable) || loaderVersions[0])?.version || "";
  }
  if (!loaderVersion || !loaderVersions.some((item) => item.version === loaderVersion)) {
    throw new LoaderError("Version not found");
  }
  const fileName = `fabric-installer-${installerVersion}.jar`;
  const url = installerUrl.toString();
  return {
    loader,
    minecraftVersion,
    loaderVersion,
    url,
    fileName,
    sha256: await sha256Of(http, url),
    installArgs: [
      "server",
      "-mcversion",
      minecraftVersion,
      "-loader",
      loaderVersion,
      "-downloadMinecraft"
    ],
    startCommand: {
      windows: "java -jar fabric-server-launch.jar nogui",
      other: "java -jar fabric-server-launch.jar nogui"
    }
  };
}
