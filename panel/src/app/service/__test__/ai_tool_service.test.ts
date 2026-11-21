import { beforeEach, describe, expect, it, vi } from "vitest";
import { ROLE } from "../../entity/user";
import aiToolService, {
  CREATE_TOOL,
  INSTALL_PLUGIN_TOOL,
  SEARCH_PLUGINS_TOOL,
  EDIT_FILE_TOOL,
  LIST_FILES_TOOL,
  READ_FILE_TOOL,
  templateIdOf
} from "../ai_tool_service";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  hasInstance: vi.fn(),
  getRemoteService: vi.fn(),
  remoteRequest: vi.fn(),
  getAppMarketList: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  services: new Map(),
  operationLog: vi.fn(),
  searchProjects: vi.fn(),
  getProjectVersions: vi.fn(),
  checkSafeUrl: vi.fn(async () => true),
  systemConfig: { allowUsePreset: false } as any
}));

vi.mock("../../entity/user", () => ({
  ROLE: { ADMIN: 10, USER: 1, GUEST: 0, BAN: -1 }
}));
vi.mock("../user_service", () => ({ default: { getInstance: mocks.getUser } }));
vi.mock("../permission_service", () => ({ isHaveInstance: mocks.hasInstance }));
vi.mock("../remote_service", () => ({
  default: { services: mocks.services, getInstance: mocks.getRemoteService }
}));
vi.mock("../remote_command", () => ({
  default: class {
    request = mocks.remoteRequest;
  }
}));
vi.mock("../instance_service", () => ({ getAppMarketList: mocks.getAppMarketList }));
vi.mock("../../setting", () => ({ systemConfig: mocks.systemConfig }));
vi.mock("../log", () => ({ logger: { info: mocks.info, warn: mocks.warn } }));
vi.mock("../instance_name_service", () => ({
  getInstanceNameSafely: vi.fn(async () => "Survie")
}));
vi.mock("../operation_logger", () => ({ operationLogger: { log: mocks.operationLog } }));
vi.mock("../mod_manager_service", () => ({
  modManagerService: {
    searchProjects: mocks.searchProjects,
    getProjectVersions: mocks.getProjectVersions
  }
}));
vi.mock("../../utils/url", () => ({ checkSafeUrl: mocks.checkSafeUrl }));

const paper = {
  title: "[PaperMC] Minecraft 1.21",
  description: "Paper server",
  gameType: "Minecraft",
  platform: "ALL",
  targetLink: "https://marketplace.example/paper.zip",
  setupInfo: { startCommand: "java -jar server.jar" }
};
const terraria = {
  title: "Terraria Server",
  description: "Docker based Terraria",
  gameType: "Terraria",
  platform: "Linux",
  setupInfo: { processType: "docker", docker: { image: "terraria:latest" } }
};

describe("AI tool authorization and confirmations", () => {
  const user = { permission: ROLE.USER, instances: [] };
  const admin = { permission: ROLE.ADMIN, instances: [] };
  const remote = { available: true, config: { remarks: "Local node" } };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockReturnValue(user);
    mocks.hasInstance.mockReturnValue(true);
    mocks.getRemoteService.mockReturnValue(remote);
    mocks.remoteRequest.mockResolvedValue({ ok: true });
    mocks.getAppMarketList.mockResolvedValue({ packages: [paper, terraria] });
    mocks.services.clear();
    mocks.services.set("daemon-1", remote);
    mocks.systemConfig.allowUsePreset = false;
  });

  it("recognizes direct creation requests for any game but not how-to or start requests", () => {
    const detect = (text: string) => aiToolService.isInstanceCreationRequest(text);
    expect(detect("Crée un serveur Minecraft en version 26.3")).toBe(true);
    expect(detect("creer moi une instance Terraria")).toBe(true);
    expect(detect("Create a new Palworld server")).toBe(true);
    expect(detect("Comment créer un serveur Minecraft ?")).toBe(false);
    expect(detect("Lance le serveur test")).toBe(false);
    expect(detect("Start my server")).toBe(false);
    expect(detect("Installe un plugin sur mon serveur")).toBe(false);
  });

  it("refuses to start an instance not assigned to the user", async () => {
    mocks.hasInstance.mockReturnValue(false);

    const result = await aiToolService.execute(
      "user-1",
      "conversation-1",
      "Start the server",
      "start_instance",
      { daemonId: "daemon-1", instanceUuid: "instance-1" }
    );

    expect(result.decision).toBe("refused");
    expect(mocks.remoteRequest).not.toHaveBeenCalled();
  });

  it("requires a separate matching confirmation before stopping an instance", async () => {
    const args = { daemonId: "daemon-1", instanceUuid: "instance-1" };
    const request = (message: string, confirmed: boolean) =>
      aiToolService.execute("user-2", "conversation-2", message, "stop_instance", {
        ...args,
        confirmed
      });

    const pending = await request("Stop the server", false);
    expect(pending).toMatchObject({ decision: "approved", data: { confirmationRequired: true } });
    expect(mocks.remoteRequest).not.toHaveBeenCalled();

    aiToolService.prepareMessage("user-2", "conversation-2", "oui je confirme");
    const stopped = await request("oui je confirme", true);
    expect(stopped.decision).toBe("executed");
    expect(mocks.remoteRequest).toHaveBeenCalledWith("instance/stop", {
      instanceUuids: ["instance-1"]
    });
  });

  it("refuses instance creation for non-administrators", async () => {
    const result = await aiToolService.execute(
      "user-3",
      "conversation-3",
      "Create a Minecraft server",
      CREATE_TOOL,
      { templateId: templateIdOf(paper), daemonId: "daemon-1", nickname: "Survival" }
    );

    expect(result).toMatchObject({
      decision: "refused",
      error: "Administrator permission required"
    });
    expect(mocks.getAppMarketList).not.toHaveBeenCalled();
    expect(mocks.remoteRequest).not.toHaveBeenCalled();
  });

  it("lists the catalogue for administrators even when presets are disabled for users", async () => {
    mocks.getUser.mockReturnValue(admin);

    const result = await aiToolService.execute(
      "admin-1",
      "conversation-list",
      "Crée un serveur Terraria",
      "list_instance_templates",
      { search: "Crée un serveur Terraria" }
    );

    expect(result.decision).toBe("executed");
    expect(result.data.matched).toBe(true);
    expect(result.data.templates).toEqual([
      expect.objectContaining({ templateId: templateIdOf(terraria), docker: true })
    ]);
    expect(result.data.availableDaemons).toEqual([{ daemonId: "daemon-1", name: "Local node" }]);
    expect(JSON.stringify(result.data)).not.toContain("marketplace.example");
  });

  it("refuses an unlisted or invented template without creating a pending confirmation", async () => {
    mocks.getUser.mockReturnValue(admin);

    const result = await aiToolService.execute(
      "admin-2",
      "conversation-unlisted",
      "Create a Minecraft server",
      CREATE_TOOL,
      { templateId: "000000000000", daemonId: "daemon-1", nickname: "Survival" }
    );

    expect(result).toMatchObject({ decision: "refused", error: "Template not found" });
    expect(
      await aiToolService.executePendingConfirmation("admin-2", "conversation-unlisted", "oui")
    ).toBeNull();
    expect(mocks.remoteRequest).not.toHaveBeenCalled();
  });

  it("refuses invalid tool arguments", async () => {
    mocks.getUser.mockReturnValue(admin);

    const result = await aiToolService.execute(
      "admin-2",
      "conversation-invalid",
      "Create a Minecraft server",
      CREATE_TOOL,
      "{not json"
    );

    expect(result).toMatchObject({ decision: "refused", error: "Invalid arguments" });
    expect(mocks.remoteRequest).not.toHaveBeenCalled();
  });

  it("refuses when the selected daemon is unavailable", async () => {
    mocks.getUser.mockReturnValue(admin);
    mocks.getRemoteService.mockReturnValue({ available: false, config: {} });

    const result = await aiToolService.execute(
      "admin-3",
      "conversation-offline",
      "Create a Minecraft server",
      CREATE_TOOL,
      { templateId: templateIdOf(paper), daemonId: "daemon-1", nickname: "Survival" }
    );

    expect(result).toMatchObject({ decision: "refused", error: "Daemon unavailable" });
    expect(aiToolService.hasPendingConfirmation("admin-3", "conversation-offline")).toBe(false);
    expect(mocks.remoteRequest).not.toHaveBeenCalled();
  });

  it("asks which daemon to use when several are online and none was given", async () => {
    mocks.getUser.mockReturnValue(admin);
    mocks.services.set("daemon-2", { available: true, config: { remarks: "Second" } });

    const result = await aiToolService.execute(
      "admin-4",
      "conversation-daemons",
      "Create a Minecraft server",
      CREATE_TOOL,
      { templateId: templateIdOf(paper) }
    );

    expect(result).toMatchObject({ decision: "refused", error: "Daemon selection required" });
    expect(result.data.availableDaemons).toHaveLength(2);
  });

  it("creates only the exact confirmed template, name and daemon", async () => {
    mocks.getUser.mockReturnValue(admin);
    mocks.remoteRequest.mockResolvedValue({
      instanceUuid: "new-instance",
      taskId: "install-task",
      status: 1
    });
    const args = { templateId: templateIdOf(paper), daemonId: "daemon-1", nickname: "Survival" };

    const pending = await aiToolService.execute(
      "admin-5",
      "conversation-5",
      "Create a Minecraft server",
      CREATE_TOOL,
      args
    );
    expect(pending).toMatchObject({
      decision: "approved",
      data: {
        confirmationRequired: true,
        nickname: "Survival",
        templateTitle: paper.title,
        daemonId: "daemon-1",
        daemonName: "Local node"
      }
    });
    expect(mocks.remoteRequest).not.toHaveBeenCalled();

    // A confirmation flag from the model without a user "yes" does not create anything.
    const forged = await aiToolService.execute(
      "admin-5",
      "conversation-5",
      "Create a Minecraft server",
      CREATE_TOOL,
      { ...args, confirmed: true }
    );
    expect(forged.decision).toBe("approved");
    expect(mocks.remoteRequest).not.toHaveBeenCalled();

    aiToolService.prepareMessage("admin-5", "conversation-5", "oui je confirme");
    const created = await aiToolService.executePendingConfirmation(
      "admin-5",
      "conversation-5",
      "oui je confirme"
    );

    expect(created).toMatchObject({
      decision: "executed",
      data: { instanceUuid: "new-instance", installationTaskId: "install-task" }
    });
    expect(mocks.remoteRequest).toHaveBeenCalledTimes(1);
    expect(mocks.remoteRequest).toHaveBeenCalledWith(
      "instance/asynchronous",
      {
        instanceUuid: "-",
        taskName: "quick_install",
        role: ROLE.ADMIN,
        parameter: {
          newInstanceName: "Survival",
          targetLink: paper.targetLink,
          setupInfo: paper.setupInfo,
          autoStartAfterInstall: true
        }
      },
      15000
    );
    // The confirmation is consumed: a second "yes" does nothing.
    expect(
      await aiToolService.executePendingConfirmation("admin-5", "conversation-5", "oui")
    ).toBeNull();
  });

  it("drops the pending creation when the user answers anything other than yes", async () => {
    mocks.getUser.mockReturnValue(admin);
    await aiToolService.execute("admin-6", "conversation-6", "Create", CREATE_TOOL, {
      templateId: templateIdOf(paper)
    });
    expect(aiToolService.hasPendingConfirmation("admin-6", "conversation-6")).toBe(true);

    aiToolService.prepareMessage("admin-6", "conversation-6", "non, plutôt Terraria");
    expect(
      await aiToolService.executePendingConfirmation("admin-6", "conversation-6", "oui")
    ).toBeNull();
    expect(mocks.remoteRequest).not.toHaveBeenCalled();
  });

  it("sends an empty link (not 'undefined') for Docker templates without download", async () => {
    mocks.getUser.mockReturnValue(admin);
    mocks.remoteRequest.mockResolvedValue({ instanceUuid: "terraria-1", taskId: "task-1" });
    await aiToolService.execute("admin-7", "conversation-7", "Create", CREATE_TOOL, {
      templateId: templateIdOf(terraria)
    });
    const created = await aiToolService.executePendingConfirmation(
      "admin-7",
      "conversation-7",
      "yes"
    );

    expect(created?.decision).toBe("executed");
    expect(mocks.remoteRequest.mock.calls[0][1].parameter).toMatchObject({
      newInstanceName: terraria.title,
      targetLink: "",
      setupInfo: terraria.setupInfo
    });
  });

  it("reports a daemon error without claiming the instance exists", async () => {
    mocks.getUser.mockReturnValue(admin);
    mocks.remoteRequest.mockRejectedValue(new Error("Access denied"));
    await aiToolService.execute("admin-8", "conversation-8", "Create", CREATE_TOOL, {
      templateId: templateIdOf(paper)
    });

    const result = await aiToolService.executePendingConfirmation(
      "admin-8",
      "conversation-8",
      "oui"
    );

    expect(result).toMatchObject({ decision: "refused", error: "Instance creation failed" });
    expect(result?.data?.instanceUuid).toBeUndefined();
  });

  it("does not report success when the daemon response lacks a task or instance", async () => {
    mocks.getUser.mockReturnValue(admin);
    mocks.remoteRequest.mockResolvedValue(true);
    await aiToolService.execute("admin-9", "conversation-9", "Create", CREATE_TOOL, {
      templateId: templateIdOf(paper)
    });

    const result = await aiToolService.executePendingConfirmation(
      "admin-9",
      "conversation-9",
      "oui"
    );

    expect(result).toMatchObject({
      decision: "refused",
      error: "Daemon returned an invalid response"
    });
  });
});

describe("AI instance file tools", () => {
  const scope = { daemonId: "daemon-1", instanceUuid: "instance-1", nickname: "Survie" };
  const context = { instanceScope: scope };
  const remote = { available: true, config: { remarks: "Local node" } };
  let files: Map<string, string>;
  let conversation = 0;

  // Fake daemon file router: `file/edit` reads without text and writes with text.
  const fakeDaemon = async (event: string, data: any) => {
    if (event === "file/list") {
      return {
        total: 2,
        items: [
          { name: "plugins", type: 0, size: 0 },
          { name: "server.properties", type: 1, size: 40 }
        ]
      };
    }
    if (event === "file/edit") {
      if (typeof data.text === "string") {
        files.set(data.target, data.text);
        return true;
      }
      if (!files.has(data.target)) throw new Error("ENOENT");
      return files.get(data.target) || true;
    }
    throw new Error(`unexpected ${event}`);
  };

  const run = (tool: string, args: unknown, message = "change it", id = `conv-${conversation}`) =>
    aiToolService.execute("user-9", id, message, tool, args, context);

  beforeEach(() => {
    vi.clearAllMocks();
    conversation++;
    files = new Map([["/server.properties", "motd=Hello\nmax-players=20\n"]]);
    mocks.getUser.mockReturnValue({ permission: ROLE.USER, userName: "alice", instances: [] });
    mocks.hasInstance.mockReturnValue(true);
    mocks.getRemoteService.mockReturnValue(remote);
    mocks.remoteRequest.mockReset();
    mocks.remoteRequest.mockImplementation(fakeDaemon);
    mocks.systemConfig.canFileManager = true;
  });

  it("only exposes file tools in a conversation bound to an instance", () => {
    const names = (decls: readonly any[]) => decls.map((decl) => decl.function.name);
    expect(names(aiToolService.getDeclarations())).not.toContain(EDIT_FILE_TOOL);
    expect(names(aiToolService.getDeclarations(context))).toContain(EDIT_FILE_TOOL);
  });

  it("refuses file tools without an instance scope", async () => {
    const result = await aiToolService.execute("user-9", "c", "m", READ_FILE_TOOL, {
      path: "/server.properties"
    });
    expect(result).toMatchObject({ decision: "refused", error: "No instance selected" });
    expect(mocks.remoteRequest).not.toHaveBeenCalled();
  });

  it("refuses an instance the user is not assigned to", async () => {
    mocks.hasInstance.mockReturnValue(false);
    const result = await run(READ_FILE_TOOL, { path: "/server.properties" });
    expect(result).toMatchObject({ decision: "refused", error: "Forbidden resource" });
    expect(mocks.remoteRequest).not.toHaveBeenCalled();
  });

  it("follows the file manager setting for regular users", async () => {
    mocks.systemConfig.canFileManager = false;
    const result = await run(LIST_FILES_TOOL, {});
    expect(result).toMatchObject({ decision: "refused", error: "File management is disabled" });

    mocks.getUser.mockReturnValue({ permission: ROLE.ADMIN, userName: "root", instances: [] });
    expect((await run(LIST_FILES_TOOL, {})).decision).toBe("executed");
  });

  it("rejects path traversal before contacting the daemon", async () => {
    const result = await run(READ_FILE_TOOL, { path: "../../daemon/data/Config/global.json" });
    expect(result).toMatchObject({ decision: "refused", error: "Invalid path" });
    expect(mocks.remoteRequest).not.toHaveBeenCalled();
  });

  it("lists and reads files of the bound instance only", async () => {
    const listed = await run(LIST_FILES_TOOL, { path: "/" });
    expect(listed.data.items).toEqual([
      { name: "plugins", type: "folder", size: 0 },
      { name: "server.properties", type: "file", size: 40 }
    ]);
    const read = await run(READ_FILE_TOOL, { path: "server.properties" });
    expect(read).toMatchObject({
      decision: "executed",
      data: {
        path: "/server.properties",
        content: "motd=Hello\nmax-players=20\n",
        truncated: false
      }
    });
    for (const call of mocks.remoteRequest.mock.calls) {
      expect(call[1].instanceUuid).toBe("instance-1");
    }
  });

  it("shows a preview and writes nothing before an explicit yes", async () => {
    const edit = {
      path: "/server.properties",
      edits: [{ find: "max-players=20", replace: "max-players=50" }]
    };

    const preview = await run(EDIT_FILE_TOOL, edit, "mets 50 joueurs max");
    expect(preview).toMatchObject({
      decision: "approved",
      data: { confirmationRequired: true, path: "/server.properties", nickname: "Survie" }
    });
    expect(preview.data.preview).toContain("- max-players=20");
    expect(preview.data.preview).toContain("+ max-players=50");
    expect(files.get("/server.properties")).toContain("max-players=20");

    // A model-sent confirmed flag without the user's "yes" writes nothing.
    const forged = await run(EDIT_FILE_TOOL, { ...edit, confirmed: true }, "mets 50 joueurs max");
    expect(forged.decision).toBe("approved");
    expect(files.get("/server.properties")).toContain("max-players=20");

    const id = `conv-${conversation}`;
    aiToolService.prepareMessage("user-9", id, "oui");
    const written = await aiToolService.executePendingConfirmation("user-9", id, "oui");
    expect(written).toMatchObject({ tool: EDIT_FILE_TOOL, decision: "executed" });
    expect(files.get("/server.properties")).toBe("motd=Hello\nmax-players=50\n");
    expect(mocks.operationLog).toHaveBeenCalledWith(
      "instance_file_update",
      expect.objectContaining({
        instance_id: "instance-1",
        file: "/server.properties",
        operator_name: "alice"
      })
    );
  });

  it("does not overwrite a file that changed after the preview", async () => {
    await run(EDIT_FILE_TOOL, {
      path: "/server.properties",
      edits: [{ find: "max-players=20", replace: "max-players=50" }]
    });
    files.set("/server.properties", "motd=Edited by hand\nmax-players=20\n");

    const id = `conv-${conversation}`;
    const result = await aiToolService.executePendingConfirmation("user-9", id, "oui");

    expect(result).toMatchObject({ decision: "refused", error: "File changed since preview" });
    expect(files.get("/server.properties")).toBe("motd=Edited by hand\nmax-players=20\n");
  });

  it("refuses edits whose text is missing or ambiguous", async () => {
    expect(
      await run(EDIT_FILE_TOOL, {
        path: "/server.properties",
        edits: [{ find: "pvp=true", replace: "pvp=false" }]
      })
    ).toMatchObject({ decision: "refused", error: "Edit text not found" });
    files.set("/a.txt", "x\nx\n");
    expect(
      await run(EDIT_FILE_TOOL, { path: "/a.txt", edits: [{ find: "x", replace: "y" }] })
    ).toMatchObject({ decision: "refused", error: "Edit text is ambiguous" });
    expect(aiToolService.hasPendingConfirmation("user-9", `conv-${conversation}`)).toBe(false);
  });

  it("creates a new file only after confirmation", async () => {
    const preview = await run(EDIT_FILE_TOOL, { path: "/ops.txt", content: "Steve\n" });
    expect(preview.data).toMatchObject({ newFile: true, confirmationRequired: true });
    expect(files.has("/ops.txt")).toBe(false);

    const result = await aiToolService.executePendingConfirmation(
      "user-9",
      `conv-${conversation}`,
      "yes"
    );
    expect(result?.decision).toBe("executed");
    expect(files.get("/ops.txt")).toBe("Steve\n");
  });

  it("reports a daemon write error without claiming success", async () => {
    await run(EDIT_FILE_TOOL, {
      path: "/server.properties",
      edits: [{ find: "max-players=20", replace: "max-players=50" }]
    });
    mocks.remoteRequest.mockImplementation(async (event: string, data: any) => {
      if (event === "file/edit" && typeof data.text === "string") throw new Error("EACCES");
      return fakeDaemon(event, data);
    });

    const result = await aiToolService.executePendingConfirmation(
      "user-9",
      `conv-${conversation}`,
      "oui"
    );

    expect(result).toMatchObject({ decision: "refused", error: "File could not be written" });
    expect(mocks.operationLog).not.toHaveBeenCalled();
  });
});

describe("Instance-dedicated assistant tools", () => {
  const context = {
    instanceScope: { daemonId: "daemon-1", instanceUuid: "instance-1", nickname: "Survie" }
  };
  let conversation = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    conversation++;
    mocks.getUser.mockReturnValue({ permission: ROLE.ADMIN, userName: "root", instances: [] });
    mocks.hasInstance.mockReturnValue(true);
    mocks.getRemoteService.mockReturnValue({ available: true, config: {} });
    mocks.remoteRequest.mockReset();
    mocks.remoteRequest.mockResolvedValue({ ok: true });
  });

  it("exposes only this instance's tools", () => {
    const names = aiToolService.getDeclarations(context).map((decl: any) => decl.function.name);
    const userTools = [
      "edit_instance_file",
      "install_plugin",
      "list_instance_files",
      "read_instance_file",
      "search_plugins",
      "start_instance",
      "stop_instance",
      "send_console_command",
      "run_instance_command",
      "update_instance",
      "install_mod_loader",
      "read_console",
      "get_instance_info",
      "restart_instance",
      "kill_instance"
    ];
    expect(names.sort()).toEqual([...userTools].sort());
    // Administrators also get the free command; scheduled (read-only) runs get no command tool.
    const adminNames = aiToolService
      .getDeclarations(context, true)
      .map((decl: any) => decl.function.name);
    expect(adminNames.sort()).toEqual(
      [...userTools, "run_admin_command", "update_instance_settings"].sort()
    );
    const scheduled = aiToolService
      .getDeclarations({ ...context, readOnly: true }, true)
      .map((decl: any) => decl.function.name);
    expect(scheduled.sort()).toEqual(
      ["list_instance_files", "read_instance_file", "search_plugins"].sort()
    );
  });

  it("refuses tools about other instances or server creation", async () => {
    for (const tool of [CREATE_TOOL, "list_accessible_instances", "list_instance_templates"]) {
      const result = await aiToolService.execute(
        "admin-x",
        `scoped-${conversation}`,
        "m",
        tool,
        {},
        context
      );
      expect(result).toMatchObject({
        decision: "refused",
        error: "Not available in instance assistant"
      });
    }
    expect(mocks.remoteRequest).not.toHaveBeenCalled();
    expect(mocks.getAppMarketList).not.toHaveBeenCalled();
  });

  it("always targets the bound instance, whatever IDs the model sends", async () => {
    const result = await aiToolService.execute(
      "admin-x",
      `scoped-${conversation}`,
      "démarre",
      "start_instance",
      { daemonId: "daemon-9", instanceUuid: "someone-else" },
      context
    );
    expect(result.decision).toBe("executed");
    expect(mocks.getRemoteService).toHaveBeenCalledWith("daemon-1");
    expect(mocks.remoteRequest).toHaveBeenCalledWith("instance/open", {
      instanceUuids: ["instance-1"]
    });
  });

  it("stops the bound instance only after the user's explicit yes", async () => {
    const id = `scoped-${conversation}`;
    const pending = await aiToolService.execute(
      "admin-x",
      id,
      "arrête-la",
      "stop_instance",
      {},
      context
    );
    expect(pending).toMatchObject({
      decision: "approved",
      data: { confirmationRequired: true, nickname: "Survie" }
    });
    expect(mocks.remoteRequest).not.toHaveBeenCalled();

    const stopped = await aiToolService.executePendingConfirmation("admin-x", id, "oui");
    expect(stopped).toMatchObject({ tool: "stop_instance", decision: "executed" });
    expect(mocks.remoteRequest).toHaveBeenCalledWith("instance/stop", {
      instanceUuids: ["instance-1"]
    });
  });
});

describe("AI plugin installation tools", () => {
  const context = {
    instanceScope: { daemonId: "daemon-1", instanceUuid: "instance-1", nickname: "Survie" }
  };
  const viaVersions = [
    {
      id: "v-beta",
      version_number: "5.5.0-SNAPSHOT",
      version_type: "beta",
      loaders: ["paper"],
      game_versions: ["26.2"],
      files: [
        {
          url: "https://cdn.modrinth.com/beta.jar",
          filename: "ViaVersion-5.5.0-SNAPSHOT.jar",
          primary: true
        }
      ]
    },
    {
      id: "v-541",
      version_number: "5.4.1",
      version_type: "release",
      loaders: ["paper", "spigot", "velocity"],
      game_versions: ["1.21.1", "26.2"],
      files: [
        {
          url: "https://cdn.modrinth.com/data/via/ViaVersion-5.4.1.jar",
          filename: "ViaVersion-5.4.1.jar",
          primary: true
        }
      ]
    }
  ];
  let installed: any[];
  let downloadTasks: any[];
  let conversation = 0;

  // Fake daemon: a Paper 26.2 server with bStats and spark in plugins/.
  const daemon = async (event: string, data: any) => {
    switch (event) {
      case "instance/detail":
        return { config: { type: "minecraft/java" }, info: { version: "" } };
      case "file/list":
        return {
          items: [
            { name: "plugins", type: 0 },
            { name: "paper-26.2-12.jar", type: 1 }
          ]
        };
      case "file/edit":
        if (data.target === "/version_history.json") {
          return JSON.stringify({ currentVersion: "git-Paper-12 (MC: 26.2)" });
        }
        throw new Error("ENOENT");
      case "instance/mods/list":
        return { mods: installed, downloadTasks };
      case "instance/mods/install":
        installed = [...installed, { name: "ViaVersion", file: data.fileName, folder: "plugins" }];
        downloadTasks = [{ path: `/plugins/${data.fileName}`, status: 1 }];
        return true;
      default:
        throw new Error(`unexpected ${event}`);
    }
  };
  const id = () => `plugins-${conversation}`;
  const run = (tool: string, args: unknown, message = "installe via version") =>
    aiToolService.execute("admin-p", id(), message, tool, args, context);

  beforeEach(() => {
    vi.clearAllMocks();
    conversation++;
    installed = [{ name: "spark", file: "spark.jar", folder: "plugins" }];
    downloadTasks = [];
    mocks.getUser.mockReturnValue({ permission: ROLE.USER, userName: "alice", instances: [] });
    mocks.hasInstance.mockReturnValue(true);
    mocks.getRemoteService.mockReturnValue({ available: true, config: {} });
    mocks.remoteRequest.mockReset();
    mocks.remoteRequest.mockImplementation(daemon);
    mocks.systemConfig.canFileManager = true;
    mocks.searchProjects.mockResolvedValue({
      hits: [
        {
          id: "P1sxKqOb",
          source: "Modrinth",
          title: "ViaVersion",
          description: "Allows newer clients to join",
          version_number: "5.4.1",
          game_versions: ["26.2"]
        }
      ]
    });
    mocks.getProjectVersions.mockResolvedValue(viaVersions);
    mocks.checkSafeUrl.mockResolvedValue(true);
    aiToolService.installPollAttempts = 3;
    aiToolService.installPollIntervalMs = 0;
  });

  it("searches with the server detected from the instance", async () => {
    const result = await run(SEARCH_PLUGINS_TOOL, { query: "via-version" });

    expect(result.decision).toBe("executed");
    expect(result.data.server).toEqual({ loader: "paper", mcVersion: "26.2", kind: "plugin" });
    expect(result.data.results[0]).toMatchObject({
      projectId: "P1sxKqOb",
      source: "Modrinth",
      title: "ViaVersion",
      supportsServerVersion: true
    });
    expect(mocks.searchProjects).toHaveBeenCalledWith("via-version", 0, 8, {
      source: "modrinth",
      type: "plugin"
    });
  });

  it("previews the compatible release and installs it only after yes", async () => {
    const preview = await run(INSTALL_PLUGIN_TOOL, {
      projectId: "P1sxKqOb",
      source: "Modrinth",
      // Model-supplied URLs are never used.
      url: "https://evil.example/backdoor.jar"
    });

    expect(preview).toMatchObject({
      decision: "approved",
      data: {
        confirmationRequired: true,
        title: "ViaVersion",
        version: "5.4.1",
        fileName: "ViaVersion-5.4.1.jar",
        folder: "plugins",
        server: { loader: "paper", mcVersion: "26.2" }
      }
    });
    expect(mocks.remoteRequest).not.toHaveBeenCalledWith(
      "instance/mods/install",
      expect.anything(),
      expect.anything()
    );

    const done = await aiToolService.executePendingConfirmation("admin-p", id(), "oui");

    expect(done).toMatchObject({
      tool: INSTALL_PLUGIN_TOOL,
      decision: "executed",
      data: { completed: true }
    });
    expect(mocks.remoteRequest).toHaveBeenCalledWith(
      "instance/mods/install",
      {
        instanceUuid: "instance-1",
        url: "https://cdn.modrinth.com/data/via/ViaVersion-5.4.1.jar",
        fileName: "ViaVersion-5.4.1.jar",
        type: "plugin",
        fallbackUrl: undefined,
        oldFileName: undefined
      },
      15000
    );
    expect(mocks.operationLog).toHaveBeenCalledWith(
      "instance_file_upload",
      expect.objectContaining({ instance_id: "instance-1", file: "plugins/ViaVersion-5.4.1.jar" })
    );
  });

  it("replaces an older copy instead of installing a duplicate", async () => {
    installed.push({ name: "ViaVersion", file: "ViaVersion-5.3.0.jar", folder: "plugins" });

    const preview = await run(INSTALL_PLUGIN_TOOL, { projectId: "P1sxKqOb", source: "Modrinth" });
    expect(preview.data.replaces).toBe("plugins/ViaVersion-5.3.0.jar");

    await aiToolService.executePendingConfirmation("admin-p", id(), "oui");
    expect(mocks.remoteRequest).toHaveBeenCalledWith(
      "instance/mods/install",
      expect.objectContaining({ oldFileName: "plugins/ViaVersion-5.3.0.jar" }),
      15000
    );
  });

  it("refuses when no version supports the server", async () => {
    mocks.getProjectVersions.mockResolvedValue([{ ...viaVersions[1], game_versions: ["1.8.8"] }]);
    const result = await run(INSTALL_PLUGIN_TOOL, { projectId: "P1sxKqOb", source: "Modrinth" });
    expect(result).toMatchObject({ decision: "refused", error: "No compatible version" });
    expect(aiToolService.hasPendingConfirmation("admin-p", id())).toBe(false);
  });

  it("refuses downloads from hosts outside the allowlist", async () => {
    mocks.getProjectVersions.mockResolvedValue([
      {
        ...viaVersions[1],
        files: [
          { url: "https://evil.example/ViaVersion.jar", filename: "ViaVersion.jar", primary: true }
        ]
      }
    ]);
    const result = await run(INSTALL_PLUGIN_TOOL, { projectId: "P1sxKqOb", source: "Modrinth" });
    expect(result).toMatchObject({ decision: "refused", error: "Unsafe download" });
  });

  it("reports a failed download without claiming success", async () => {
    mocks.remoteRequest.mockImplementation(async (event: string, data: any) => {
      if (event === "instance/mods/install") {
        downloadTasks = [{ path: `/plugins/${data.fileName}`, status: 2, error: "HTTP 403" }];
        return true;
      }
      return daemon(event, data);
    });
    await run(INSTALL_PLUGIN_TOOL, { projectId: "P1sxKqOb", source: "Modrinth" });

    const result = await aiToolService.executePendingConfirmation("admin-p", id(), "oui");
    expect(result).toMatchObject({ decision: "refused", error: "Download failed" });
  });

  it("does not claim completion while the download is still running", async () => {
    mocks.remoteRequest.mockImplementation(async (event: string, data: any) => {
      if (event === "instance/mods/install") {
        downloadTasks = [{ path: `/plugins/${data.fileName}`, status: 0 }];
        return true;
      }
      return daemon(event, data);
    });
    await run(INSTALL_PLUGIN_TOOL, { projectId: "P1sxKqOb", source: "Modrinth" });

    const result = await aiToolService.executePendingConfirmation("admin-p", id(), "oui");
    expect(result).toMatchObject({ decision: "executed", data: { completed: false } });
  });

  it("follows the instance and file manager permissions", async () => {
    mocks.hasInstance.mockReturnValue(false);
    expect(await run(SEARCH_PLUGINS_TOOL, { query: "ViaVersion" })).toMatchObject({
      decision: "refused",
      error: "Forbidden resource"
    });
    mocks.hasInstance.mockReturnValue(true);
    mocks.systemConfig.canFileManager = false;
    expect(
      await run(INSTALL_PLUGIN_TOOL, { projectId: "P1sxKqOb", source: "Modrinth" })
    ).toMatchObject({
      decision: "refused",
      error: "File management is disabled"
    });
    expect(
      await aiToolService.execute("admin-p", id(), "m", SEARCH_PLUGINS_TOOL, { query: "x" })
    ).toMatchObject({ decision: "refused" });
  });
});
