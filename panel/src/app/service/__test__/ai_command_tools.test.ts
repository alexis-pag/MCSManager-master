import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasInstance: vi.fn(() => true),
  hasAiAccess: vi.fn(() => true),
  calls: [] as Array<{ event: string; data: any }>,
  daemon: {} as Record<string, (data: any) => any>,
  operationLog: vi.fn(),
  config: { canFileManager: true, aiConsoleCommandAllowlist: undefined as any } as any
}));

vi.mock("../log", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("../../setting", () => ({ systemConfig: mocks.config }));
vi.mock("../permission_service", () => ({ isHaveInstance: mocks.hasInstance }));
vi.mock("../ai_access_service", () => ({ default: { hasAccess: mocks.hasAiAccess } }));
vi.mock("../instance_name_service", () => ({ getInstanceNameSafely: async () => "Survie" }));
vi.mock("../operation_logger", () => ({ operationLogger: { log: mocks.operationLog } }));
vi.mock("../remote_service", () => ({
  default: { getInstance: () => ({ available: true }) }
}));
vi.mock("../remote_command", () => ({
  default: class {
    async request(event: string, data: any) {
      mocks.calls.push({ event, data });
      const handler = mocks.daemon[event];
      if (!handler) throw new Error(`Unexpected daemon event ${event}`);
      return handler(data);
    }
  }
}));

import {
  DEFAULT_CONSOLE_ALLOWLIST,
  normalizeConsoleAllowlist,
  parseInstanceCommand,
  validateAdminCommand,
  validateConsoleCommand
} from "../ai_command_parsing";
import {
  ADMIN_COMMAND_TOOL,
  AiCommandTools,
  boundOutput,
  CONSOLE_COMMAND_TOOL,
  INSTALL_LOADER_TOOL,
  INSTANCE_COMMAND_TOOL,
  INSTANCE_INFO_TOOL,
  KILL_TOOL,
  READ_CONSOLE_TOOL,
  RESTART_TOOL,
  SETTINGS_TOOL,
  startCommandFromRoot,
  UPDATE_INSTANCE_TOOL
} from "../ai_command_tools";
import { parseSettingsPatch } from "../ai_command_parsing";
import { LoaderHttp, neoForgePrefix, resolveLoaderInstall } from "../ai_mod_loader";

const SHA = "a".repeat(64);
const FORGE = "https://maven.minecraftforge.net/net/minecraftforge/forge";
const http: LoaderHttp = {
  async getJson(url) {
    if (url.endsWith("promotions_slim.json")) {
      return { promos: { "26.3-recommended": "66.1.9", "1.12.2-recommended": "14.23.5.2859" } };
    }
    if (url.endsWith("/installer")) {
      return [
        {
          url: "https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.1.2/fabric-installer-1.1.2.jar",
          version: "1.1.2",
          stable: true
        }
      ];
    }
    if (url.endsWith("/loader/1.21.1")) {
      return [{ loader: { version: "0.20.1", stable: true } }];
    }
    if (url.includes("/loader/")) return [];
    throw new Error(`Unexpected ${url}`);
  },
  async getText(url) {
    if (url.endsWith(".sha256")) return url.includes("missing-sha") ? "" : `${SHA}  file.jar\n`;
    if (url.includes("minecraftforge")) {
      return "<versions><version>26.3-66.1.9</version><version>1.12.2-14.23.5.2859</version></versions>";
    }
    if (url.includes("neoforged")) {
      return "<versions><version>21.1.77</version><version>21.1.80-beta</version><version>26.3.0.115</version></versions>";
    }
    throw new Error(`Unexpected ${url}`);
  }
};

describe("console command validation", () => {
  const allow = (command: string) => validateConsoleCommand(command, DEFAULT_CONSOLE_ALLOWLIST);

  it("accepts non-administrator commands, with or without slash", () => {
    expect(allow("list")).toEqual({ command: "list" });
    expect(allow("/say Hello everyone")).toEqual({ command: "say Hello everyone" });
    expect(allow("minecraft:list")).toEqual({ command: "list" });
    expect(allow("time query daytime")).toEqual({ command: "time query daytime" });
  });

  it("refuses administrator commands, plugin namespaces and several commands", () => {
    for (const command of [
      "op Steve",
      "stop",
      "gamemode creative Steve",
      "time set day",
      "lp user x"
    ]) {
      expect(allow(command)).toEqual({ error: "Command not allowed" });
    }
    expect(allow("luckperms:lp user Steve permission set *")).toEqual({
      error: "Namespaced command"
    });
    expect(allow("list\nop Steve")).toEqual({ error: "Several commands" });
    expect(allow("")).toEqual({ error: "Invalid command" });
    expect(allow("say " + "x".repeat(300))).toEqual({ error: "Invalid command" });
  });

  it("refuses ban commands even when an administrator allowlisted them", () => {
    expect(validateConsoleCommand("ban Steve", ["ban"])).toEqual({ error: "Ban command" });
  });

  it("normalizes the administrator's allowlist", () => {
    expect(normalizeConsoleAllowlist("/Say\nlist, list\ntime query\nbad entry here\n$$")).toEqual([
      "say",
      "list",
      "time query"
    ]);
  });
});

describe("instance-folder command parsing", () => {
  it("parses commands given as name + args or as one line", () => {
    const grep = parseInstanceCommand("grep", ["-in", "error", "logs/latest.log"]);
    expect(grep).toMatchObject({
      name: "grep",
      readOnly: true,
      display: "grep -in error logs/latest.log",
      operation: {
        kind: "search",
        mode: "grep",
        target: "/logs/latest.log",
        pattern: "error",
        ignoreCase: true,
        recursive: false
      }
    });
    expect(parseInstanceCommand('grep -r "Could not" plugins', undefined)).toMatchObject({
      display: 'grep -r "Could not" plugins',
      operation: { pattern: "Could not", target: "/plugins", recursive: true }
    });
    expect(parseInstanceCommand("tail", ["-n", "50", "logs/latest.log"])).toMatchObject({
      operation: { kind: "read", mode: "tail", lines: 50 }
    });
    expect(parseInstanceCommand("unzip", ["mods/pack.zip"])).toMatchObject({
      operation: { kind: "unzip", archive: "/mods/pack.zip", dest: "/mods" }
    });
  });

  it("refuses shell syntax, unknown commands and paths outside the folder", () => {
    expect(parseInstanceCommand("curl", ["https://x"])).toEqual({ error: "Unknown command" });
    expect(parseInstanceCommand("sudo", ["rm", "x"])).toEqual({ error: "Unknown command" });
    expect(parseInstanceCommand("cat", ["../../etc/passwd"])).toEqual({ error: "Invalid path" });
    expect(parseInstanceCommand("ls | grep x", undefined)).toEqual({ error: "Invalid arguments" });
    expect(parseInstanceCommand("rm", ["-rf", "/"])).toEqual({ error: "Refused path" });
    expect(parseInstanceCommand("rm", ["-x", "a"])).toEqual({ error: "Unsupported option" });
    expect(parseInstanceCommand("chmod", ["777", "a"])).toEqual({ error: "Unknown command" });
  });

  it("validates administrator commands as one printable line", () => {
    expect(validateAdminCommand(" java -jar a.jar --installServer ")).toBe(
      "java -jar a.jar --installServer"
    );
    expect(validateAdminCommand("a\nb")).toBeNull();
    expect(validateAdminCommand("")).toBeNull();
  });
});

describe("mod loader resolution", () => {
  it("resolves the recommended Forge installer with its official checksum", async () => {
    const install = await resolveLoaderInstall({ loader: "forge", minecraftVersion: "26.3" }, http);
    expect(install).toMatchObject({
      loaderVersion: "66.1.9",
      url: `${FORGE}/26.3-66.1.9/forge-26.3-66.1.9-installer.jar`,
      fileName: "forge-26.3-66.1.9-installer.jar",
      sha256: SHA,
      installArgs: ["--installServer"],
      startCommand: {
        windows:
          "java @user_jvm_args.txt @libraries/net/minecraftforge/forge/26.3-66.1.9/win_args.txt nogui"
      }
    });
    const legacy = await resolveLoaderInstall(
      { loader: "forge", minecraftVersion: "1.12.2" },
      http
    );
    expect(legacy.startCommand.windows).toBe("java -jar forge-1.12.2-14.23.5.2859.jar nogui");
  });

  it("maps NeoForge versions to Minecraft versions and prefers stable builds", async () => {
    expect(neoForgePrefix("1.21.1")).toBe("21.1.");
    expect(neoForgePrefix("26.3")).toBe("26.3.0.");
    const install = await resolveLoaderInstall(
      { loader: "neoforge", minecraftVersion: "1.21.1" },
      http
    );
    expect(install.loaderVersion).toBe("21.1.77");
    await expect(
      resolveLoaderInstall(
        { loader: "neoforge", minecraftVersion: "1.21.1", loaderVersion: "26.3.0.115" },
        http
      )
    ).rejects.toThrow("Version not found");
  });

  it("resolves Fabric with fixed server arguments", async () => {
    const install = await resolveLoaderInstall(
      { loader: "fabric", minecraftVersion: "1.21.1" },
      http
    );
    expect(install.installArgs).toEqual([
      "server",
      "-mcversion",
      "1.21.1",
      "-loader",
      "0.20.1",
      "-downloadMinecraft"
    ]);
    await expect(
      resolveLoaderInstall({ loader: "fabric", minecraftVersion: "9.9" }, http)
    ).rejects.toThrow("Version not found");
  });

  it("refuses unknown loaders, invalid versions and missing checksums", async () => {
    await expect(
      resolveLoaderInstall({ loader: "quilt", minecraftVersion: "1.21" }, http)
    ).rejects.toThrow("Unknown loader");
    await expect(
      resolveLoaderInstall({ loader: "forge", minecraftVersion: "1.21; rm -rf /" }, http)
    ).rejects.toThrow("Invalid Minecraft version");
    await expect(
      resolveLoaderInstall(
        { loader: "forge", minecraftVersion: "26.3", loaderVersion: "66.1.9 --x" },
        http
      )
    ).rejects.toThrow("Invalid loader version");
  });
});

describe("AI command tools", () => {
  const regular = { uuid: "u1", userName: "alice", permission: 1 } as any;
  const admin = { uuid: "a1", userName: "root", permission: 10 } as any;
  const scope = { daemonId: "d1", instanceUuid: "i1", nickname: "Survie" };
  let tools: AiCommandTools;
  let pending: string | null;
  let status: number;
  let consoleLog: string;

  // Same contract as AiToolService.checkConfirmation: the first call stores, an identical call
  // flagged `confirmed` executes.
  const confirm = (tool: string, args: Record<string, unknown>) => {
    const { confirmed, ...rest } = args;
    const key = JSON.stringify([tool, rest]);
    if (confirmed === true && pending === key) {
      pending = null;
      return true;
    }
    pending = key;
    return false;
  };
  const run = (user: any, tool: string, args: Record<string, unknown>) =>
    tools.execute(user, tool, args, scope, confirm);
  const sent = (event: string) => mocks.calls.filter((call) => call.event === event);

  beforeEach(() => {
    tools = new AiCommandTools(http);
    tools.consoleWaitMs = 0;
    pending = null;
    status = 3;
    consoleLog = "[10:00] Done\n";
    mocks.calls.length = 0;
    mocks.hasInstance.mockReturnValue(true);
    mocks.hasAiAccess.mockReturnValue(true);
    mocks.operationLog.mockClear();
    mocks.config.canFileManager = true;
    mocks.config.aiConsoleCommandAllowlist = undefined;
    mocks.daemon = {
      "instance/detail": () => ({
        status,
        config: { updateCommand: "java -jar forge-installer.jar --installServer", java: { id: "" } }
      }),
      "instance/outputlog": () => consoleLog,
      "instance/command": (data) => {
        consoleLog += `> ${data.command}\nThere are 2 of a max of 20 players online\n`;
        return true;
      },
      "file/search": (data) =>
        data.mode === "workspace"
          ? { diskRoot: false }
          : data.mode === "stat"
            ? { type: "folder" }
            : {},
      "file/edit": () => "line1\nline2\nline3\n",
      "file/delete": () => true,
      "instance/ai_command": () => ({
        success: true,
        timedOut: false,
        error: "",
        output: "The server installed successfully",
        platform: "win32"
      })
    };
  });

  it("sends an allowed console command only after confirmation and returns its output", async () => {
    const preview = await run(regular, CONSOLE_COMMAND_TOOL, { command: "/list" });
    expect(preview).toMatchObject({
      decision: "approved",
      data: { confirmationRequired: true, display: "list", kind: "console" }
    });
    expect(sent("instance/command")).toEqual([]);

    const done = await run(regular, CONSOLE_COMMAND_TOOL, { command: "list", confirmed: true });
    expect(done.decision).toBe("executed");
    expect(sent("instance/command")[0].data).toMatchObject({ instanceUuid: "i1", command: "list" });
    expect(done.data.output).toBe("> list\nThere are 2 of a max of 20 players online");
    expect(mocks.operationLog).toHaveBeenCalledWith(
      "ai_instance_command",
      expect.objectContaining({ kind: "console", command: "list", operator_name: "alice" }),
      "info"
    );
  });

  it("refuses administrator console commands before asking, for administrators too", async () => {
    const result = await run(admin, CONSOLE_COMMAND_TOOL, { command: "op Steve" });
    expect(result).toMatchObject({ decision: "refused", error: "Command not allowed" });
    expect(pending).toBeNull();
    status = 0;
    expect(await run(regular, CONSOLE_COMMAND_TOOL, { command: "list" })).toMatchObject({
      error: "Instance not running"
    });
  });

  it("runs file commands in the instance folder after confirmation", async () => {
    await run(regular, INSTANCE_COMMAND_TOOL, { command: "tail", args: ["-n", "2", "server.log"] });
    const done = await run(regular, INSTANCE_COMMAND_TOOL, {
      command: "tail",
      args: ["-n", "2", "server.log"],
      confirmed: true
    });
    expect(done).toMatchObject({ decision: "executed", data: { output: "line2\nline3" } });
    expect(sent("file/edit")[0].data).toMatchObject({ target: "/server.log" });
  });

  it("requires -r to delete a folder and refuses disk-root instances", async () => {
    await run(regular, INSTANCE_COMMAND_TOOL, { command: "rm", args: ["plugins"] });
    const refused = await run(regular, INSTANCE_COMMAND_TOOL, {
      command: "rm",
      args: ["plugins"],
      confirmed: true
    });
    expect(refused).toMatchObject({
      decision: "refused",
      data: { detail: expect.stringContaining("use -r") }
    });
    expect(sent("file/delete")).toEqual([]);

    mocks.daemon["file/search"] = () => ({ diskRoot: true });
    expect(await run(regular, INSTANCE_COMMAND_TOOL, { command: "ls", args: [] })).toMatchObject({
      error: "Instance folder is a disk root"
    });
  });

  it("re-checks access when the user confirms", async () => {
    await run(regular, INSTANCE_COMMAND_TOOL, { command: "cat", args: ["a.txt"] });
    mocks.hasInstance.mockReturnValue(false);
    const result = await run(regular, INSTANCE_COMMAND_TOOL, {
      command: "cat",
      args: ["a.txt"],
      confirmed: true
    });
    expect(result).toMatchObject({ decision: "refused", error: "Forbidden resource" });
    mocks.hasInstance.mockReturnValue(true);
    mocks.hasAiAccess.mockReturnValue(false);
    expect(await run(regular, INSTANCE_COMMAND_TOOL, { command: "ls", args: [] })).toMatchObject({
      error: "AI access required"
    });
    expect(sent("file/edit")).toEqual([]);
  });

  it("gives administrators, and only them, a real shell (PowerShell by default on Windows)", async () => {
    mocks.daemon["info/overview"] = () => ({ system: { platform: "win32" } });
    mocks.daemon["instance/ai_shell"] = (data) => ({
      success: true,
      timedOut: false,
      error: "",
      output: `ran ${data.shell}`
    });
    expect(await run(regular, ADMIN_COMMAND_TOOL, { command: "Get-ChildItem" })).toMatchObject({
      decision: "refused",
      error: "Administrator permission required"
    });
    expect(sent("info/overview")).toEqual([]);

    // Works while the server runs (status 3).
    const preview = await run(admin, ADMIN_COMMAND_TOOL, { command: "Get-ChildItem" });
    expect(preview).toMatchObject({
      decision: "approved",
      data: { shell: "powershell", display: "PS> Get-ChildItem", confirmationRequired: true }
    });
    const done = await run(admin, ADMIN_COMMAND_TOOL, {
      command: "Get-ChildItem",
      shell: "powershell",
      confirmed: true
    });
    expect(done).toMatchObject({ decision: "executed", data: { output: "ran powershell" } });
    expect(sent("instance/ai_shell")[0].data).toMatchObject({
      command: "Get-ChildItem",
      shell: "powershell"
    });

    await run(admin, ADMIN_COMMAND_TOOL, { command: "dir", shell: "cmd" });
    await run(admin, ADMIN_COMMAND_TOOL, { command: "dir", shell: "cmd", confirmed: true });
    expect(sent("instance/ai_shell")[1].data).toMatchObject({ command: "dir", shell: "cmd" });

    expect(await run(admin, ADMIN_COMMAND_TOOL, { command: "ls", shell: "bash" })).toMatchObject({
      decision: "refused",
      error: "Shell not available"
    });
  });

  it("installs a loader from the resolved official installer, never from model input", async () => {
    status = 0;
    const args = { loader: "forge", minecraftVersion: "26.3", url: "https://evil.example/x.jar" };
    const preview = await run(regular, INSTALL_LOADER_TOOL, args);
    expect(preview).toMatchObject({
      decision: "approved",
      data: {
        display: "java -jar forge-26.3-66.1.9-installer.jar --installServer",
        loaderVersion: "66.1.9"
      }
    });
    const done = await run(regular, INSTALL_LOADER_TOOL, {
      loader: "forge",
      minecraftVersion: "26.3",
      loaderVersion: "66.1.9",
      confirmed: true
    });
    expect(done.decision).toBe("executed");
    expect(sent("instance/ai_command")[0].data).toMatchObject({
      command: "java -jar forge-26.3-66.1.9-installer.jar --installServer",
      prepare: {
        url: `${FORGE}/26.3-66.1.9/forge-26.3-66.1.9-installer.jar`,
        fileName: "forge-26.3-66.1.9-installer.jar",
        sha256: SHA
      }
    });
    expect(done.data.startCommand).toContain("win_args.txt nogui");
  });

  it("runs the update command that was shown, and only that one", async () => {
    status = 0;
    await run(regular, UPDATE_INSTANCE_TOOL, {});
    mocks.daemon["instance/detail"] = () => ({
      status: 0,
      config: { updateCommand: "something else", java: { id: "" } }
    });
    const changed = await run(regular, UPDATE_INSTANCE_TOOL, { confirmed: true });
    expect(changed).toMatchObject({ decision: "approved", data: { display: "something else" } });
    expect(sent("instance/ai_command")).toEqual([]);
  });

  it("reads the console without confirmation", async () => {
    consoleLog = "line a\n\u001b[31m[ERROR] Failed to bind to port\u001b[0m\n";
    const result = await run(regular, READ_CONSOLE_TOOL, { lines: 5 });
    expect(result).toMatchObject({
      decision: "executed",
      data: { status: "running", console: "line a\n[ERROR] Failed to bind to port" }
    });
    expect(pending).toBeNull();
  });

  it("shows commands and Java runtimes to administrators only", async () => {
    mocks.daemon["info/overview"] = () => ({ system: { platform: "win32" } });
    mocks.daemon["java_manager/list"] = () => [{ info: { fullname: "temurin-25" } }];
    const forUser = await run(regular, INSTANCE_INFO_TOOL, {});
    expect(forUser.data).toMatchObject({ status: "running", daemonPlatform: "win32" });
    expect(forUser.data.startCommand).toBeUndefined();
    const forAdmin = await run(admin, INSTANCE_INFO_TOOL, {});
    expect(forAdmin.data).toMatchObject({
      updateCommand: "java -jar forge-installer.jar --installServer",
      availableJavas: ["temurin-25"]
    });
  });

  it("changes instance settings for administrators after showing old and new values", async () => {
    let config: any = { startCommand: "sh ./run.sh", stopCommand: "stop", java: { id: "" } };
    mocks.daemon["instance/detail"] = () => ({ status: 0, config });
    mocks.daemon["instance/update"] = (data) => {
      config = { ...config, ...data.config };
      return true;
    };
    const fix =
      "java @user_jvm_args.txt @libraries/net/minecraftforge/forge/26.3-66.0.3/win_args.txt nogui";

    expect(await run(regular, SETTINGS_TOOL, { startCommand: fix })).toMatchObject({
      decision: "refused",
      error: "Administrator permission required"
    });
    const preview = await run(admin, SETTINGS_TOOL, { startCommand: fix, stopCommand: "stop" });
    expect(preview).toMatchObject({ decision: "approved", data: { kind: "settings" } });
    expect(preview.data.display).toBe(`startCommand: sh ./run.sh  →  ${fix}`);
    expect(sent("instance/update")).toEqual([]);

    const done = await run(admin, SETTINGS_TOOL, {
      startCommand: fix,
      stopCommand: "stop",
      confirmed: true
    });
    expect(done.decision).toBe("executed");
    expect(sent("instance/update")[0].data.config).toEqual({
      startCommand: fix,
      stopCommand: "stop"
    });
    expect(mocks.operationLog).toHaveBeenCalledWith(
      "instance_config_change",
      expect.objectContaining({ operator_name: "root", operator_ip: "local-ai" }),
      "warning"
    );
    expect(await run(admin, SETTINGS_TOOL, { startCommand: fix })).toMatchObject({
      error: "No change"
    });
  });

  it("suggests the start command from the installed files and refuses ones that cannot work", async () => {
    const suggestion =
      "java @user_jvm_args.txt @libraries/net/minecraftforge/forge/26.3-66.0.3/win_args.txt nogui";
    mocks.daemon["info/overview"] = () => ({ system: { platform: "win32" } });
    mocks.daemon["instance/detail"] = () => ({
      status: 0,
      config: { startCommand: "sh ./run.sh" }
    });
    mocks.daemon["file/search"] = (data) => {
      if (data.mode === "find") {
        return {
          results: [
            { path: "libraries/net/minecraftforge/forge/26.3-66.0.3/win_args.txt" },
            { path: "libraries/other/win_args.txt" }
          ]
        };
      }
      if (data.mode === "stat") return { type: data.target === "server.jar" ? "missing" : "file" };
      return { diskRoot: false };
    };

    const consoleResult = await run(admin, READ_CONSOLE_TOOL, {});
    expect(consoleResult.data).toMatchObject({
      startCommand: "sh ./run.sh",
      suggestedStartCommand: suggestion,
      daemonPlatform: "win32"
    });
    expect((await run(regular, READ_CONSOLE_TOOL, {})).data.startCommand).toBeUndefined();

    for (const startCommand of [
      "cmd /c run.bat",
      "sh ./run.sh",
      "java -Xmx2G -jar server.jar nogui"
    ]) {
      const refused = await run(admin, SETTINGS_TOOL, { startCommand });
      expect(refused).toMatchObject({
        decision: "refused",
        error: "Start command cannot work",
        data: { suggestedStartCommand: suggestion }
      });
    }
    expect(await run(admin, SETTINGS_TOOL, { startCommand: suggestion })).toMatchObject({
      decision: "approved"
    });
    expect(parseSettingsPatch({ startCommand: "java @libraries/<version>/win_args.txt" })).toEqual({
      error: "Placeholder in value"
    });
  });

  it("suggests a start command for every server type it can recognize", () => {
    expect(startCommandFromRoot(["paper-1.21.1-130.jar", "eula.txt"], "win32")).toBe(
      "java -jar paper-1.21.1-130.jar nogui"
    );
    expect(startCommandFromRoot(["purpur-1.21.jar", "server.jar"], "linux")).toBe(
      "java -jar purpur-1.21.jar nogui"
    );
    expect(startCommandFromRoot(["fabric-server-launch.jar", "server.jar"], "win32")).toBe(
      "java -jar fabric-server-launch.jar nogui"
    );
    expect(startCommandFromRoot(["quilt-server-launch.jar"], "linux")).toBe(
      "java -jar quilt-server-launch.jar nogui"
    );
    expect(
      startCommandFromRoot(
        ["forge-1.12.2-14.23.5.2859.jar", "forge-1.12.2-14.23.5.2859-installer.jar"],
        "win32"
      )
    ).toBe("java -jar forge-1.12.2-14.23.5.2859.jar nogui");
    expect(startCommandFromRoot(["bedrock_server.exe"], "win32")).toBe("bedrock_server.exe");
    expect(startCommandFromRoot(["bedrock_server"], "linux")).toBe("./bedrock_server");
    expect(startCommandFromRoot(["minecraft_server.1.20.1.jar"], "linux")).toBe(
      "java -jar minecraft_server.1.20.1.jar nogui"
    );
    // Steam game or unknown: no guess.
    expect(startCommandFromRoot(["PalServer.exe", "a.jar", "b.jar"], "win32")).toBe("");
  });

  it("refuses to install a Minecraft loader on another kind of instance", async () => {
    mocks.daemon["instance/detail"] = () => ({
      status: 0,
      config: { type: "minecraft/bedrock", java: { id: "" } }
    });
    expect(
      await run(regular, INSTALL_LOADER_TOOL, { loader: "forge", minecraftVersion: "26.3" })
    ).toMatchObject({ decision: "refused", error: "Not a Minecraft Java instance" });
  });

  it("runs the administrator shell inside the container of a Docker instance", async () => {
    mocks.daemon["info/overview"] = () => ({ system: { platform: "win32" } });
    mocks.daemon["instance/detail"] = () => ({
      status: 3,
      config: { processType: "docker", type: "minecraft/java/paper" }
    });
    mocks.daemon["instance/ai_shell"] = () => ({ success: true, output: "ok" });
    const preview = await run(admin, ADMIN_COMMAND_TOOL, { command: "ls" });
    expect(preview).toMatchObject({
      decision: "approved",
      data: { shell: "sh", docker: true, display: "$ ls" }
    });
    expect(await run(admin, ADMIN_COMMAND_TOOL, { command: "dir", shell: "cmd" })).toMatchObject({
      error: "Shell not available"
    });
  });

  it("only accepts installed Java runtimes and valid settings", async () => {
    mocks.daemon["java_manager/list"] = () => [{ info: { fullname: "temurin-25" } }];
    expect(await run(admin, SETTINGS_TOOL, { javaId: "evil" })).toMatchObject({
      error: "Unknown Java"
    });
    expect(parseSettingsPatch({ startCommand: "a\nb" })).toEqual({ error: "Invalid settings" });
    expect(parseSettingsPatch({ startCommand: "" })).toEqual({ error: "Invalid settings" });
    expect(parseSettingsPatch({ crlf: 3 })).toEqual({ error: "Invalid settings" });
    expect(parseSettingsPatch({ cwd: "/" })).toEqual({ error: "No change" });
    expect(parseSettingsPatch({ autoRestart: true, ie: "GBK" })).toEqual({
      patch: { ie: "gbk", autoRestart: true }
    });
  });

  it("restarts or force-stops the instance after confirmation", async () => {
    mocks.daemon["instance/restart"] = () => true;
    mocks.daemon["instance/kill"] = () => true;
    expect((await run(regular, KILL_TOOL, {})).decision).toBe("approved");
    expect(sent("instance/kill")).toEqual([]);
    expect((await run(regular, KILL_TOOL, { confirmed: true })).decision).toBe("executed");
    expect(sent("instance/kill")[0].data).toMatchObject({ instanceUuids: ["i1"] });
    await run(regular, RESTART_TOOL, {});
    await run(regular, RESTART_TOOL, { confirmed: true });
    expect(sent("instance/restart")).toHaveLength(1);
  });

  it("bounds command output", () => {
    const long = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n");
    expect(boundOutput(long).split("\n")).toHaveLength(40);
    expect(boundOutput("\u001b[31mred\u001b[0m")).toBe("red");
  });
});
