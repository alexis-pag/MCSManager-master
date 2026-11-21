import { beforeEach, describe, expect, it, vi } from "vitest";
import { templateIdOf } from "../ai_tool_service";
import { LocalAiService } from "../local_ai_service";

// End-to-end creation flow: user message -> engine (mocked LM Studio) -> tool -> daemon (mocked).
// Nothing here reaches a real engine or daemon.
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  getUser: vi.fn(),
  getRemoteService: vi.fn(),
  remoteRequest: vi.fn(),
  getAppMarketList: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  services: new Map(),
  hasInstance: vi.fn(() => true),
  stored: vi.fn(),
  conversation: {
    uuid: "conv-1",
    ownerUserUuid: "admin-1",
    messages: [] as any[],
    instanceScope: undefined as any
  }
}));

vi.mock("axios", () => ({ default: { post: mocks.post, get: vi.fn() } }));
vi.mock("../../entity/user", () => ({ ROLE: { ADMIN: 10, USER: 1, GUEST: 0, BAN: -1 } }));
vi.mock("../user_service", () => ({ default: { getInstance: mocks.getUser } }));
vi.mock("../passport_service", () => ({ getUserUuid: vi.fn() }));
vi.mock("../permission_service", () => ({ isHaveInstance: mocks.hasInstance }));
vi.mock("../instance_name_service", () => ({ getInstanceNameSafely: vi.fn(async () => "Survie") }));
vi.mock("../operation_logger", () => ({ operationLogger: { log: vi.fn() } }));
vi.mock("../mod_manager_service", () => ({
  modManagerService: {
    searchProjects: vi.fn(async () => ({
      hits: [{ id: "P1sxKqOb", source: "Modrinth", title: "ViaVersion", game_versions: ["26.2"] }]
    })),
    getProjectVersions: vi.fn(async () => [
      {
        id: "v-541",
        version_number: "5.4.1",
        version_type: "release",
        loaders: ["paper"],
        game_versions: ["26.2"],
        files: [
          {
            url: "https://cdn.modrinth.com/data/via/ViaVersion-5.4.1.jar",
            filename: "ViaVersion-5.4.1.jar",
            primary: true
          }
        ]
      }
    ])
  }
}));
vi.mock("../../utils/url", () => ({ checkSafeUrl: vi.fn(async () => true) }));
vi.mock("../remote_service", () => ({
  default: { services: mocks.services, getInstance: mocks.getRemoteService }
}));
vi.mock("../remote_command", () => ({
  default: class {
    request = mocks.remoteRequest;
  }
}));
vi.mock("../instance_service", () => ({ getAppMarketList: mocks.getAppMarketList }));
vi.mock("../log", () => ({ logger: { info: mocks.info, warn: mocks.warn } }));
vi.mock("../../common/storage/sys_storage", () => ({
  default: {
    getStorage: () => ({
      load: vi.fn(async () => mocks.conversation),
      store: mocks.stored,
      list: vi.fn(async () => []),
      delete: vi.fn()
    })
  }
}));
vi.mock("../../setting", () => ({
  systemConfig: {
    aiEnabled: true,
    aiBaseUrl: "http://127.0.0.1:1234/v1",
    aiModel: "openai/gpt-oss-20b",
    aiTemperature: 0.2,
    aiMaxTokens: 2048,
    aiTimeoutMs: 1000,
    aiMaxMessageChars: 50000,
    allowUsePreset: false
  }
}));

const paper = {
  title: "[PaperMC] Minecraft 1.21",
  description: "Paper server",
  gameType: "Minecraft",
  platform: "ALL",
  targetLink: "https://marketplace.example/paper.zip",
  setupInfo: { startCommand: "java -jar server.jar" }
};
const paperId = templateIdOf(paper);

function engineReply(message: Record<string, unknown>, finishReason = "stop") {
  return { data: { choices: [{ message, finish_reason: finishReason }] } };
}

function toolCallReply(args: unknown) {
  return engineReply(
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "create_instance_from_template",
            arguments: typeof args === "string" ? args : JSON.stringify(args)
          }
        }
      ]
    },
    "tool_calls"
  );
}

describe("Local AI instance creation flow", () => {
  let service: LocalAiService;
  let counter = 0;

  async function say(prompt: string) {
    mocks.conversation.messages.push({ id: `u${counter}`, role: "user", content: prompt });
    const answer: string = await (service as any).generate({
      record: { uuid: `request-${counter++}` },
      abortController: new AbortController(),
      prompt,
      ownerUuid: "admin-1",
      conversationUuid: mocks.conversation.uuid
    });
    mocks.conversation.messages.push({ id: `a${counter}`, role: "assistant", content: answer });
    return answer;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.post.mockReset();
    mocks.post.mockResolvedValue(engineReply({ role: "assistant", content: "D’accord." }));
    mocks.remoteRequest.mockReset();
    service = new LocalAiService();
    // Fresh conversation per test so pending confirmations never leak between tests.
    mocks.conversation.uuid = `conv-${Math.random()}`;
    mocks.conversation.messages = [];
    mocks.conversation.instanceScope = undefined;
    mocks.hasInstance.mockReturnValue(true);
    mocks.getUser.mockReturnValue({ permission: 10, instances: [] });
    mocks.services.clear();
    const remote = { available: true, config: { remarks: "Local node" } };
    mocks.services.set("daemon-1", remote);
    mocks.getRemoteService.mockReturnValue(remote);
    mocks.getAppMarketList.mockResolvedValue({ packages: [paper] });
    mocks.remoteRequest.mockResolvedValue({ instanceUuid: "new-1", taskId: "task-1", status: 1 });
  });

  it("forces a portable tool call, then creates only after an explicit yes", async () => {
    mocks.post.mockResolvedValueOnce(
      toolCallReply({ templateId: paperId, daemonId: "daemon-1", nickname: "Survie" })
    );

    const confirmation = await say("Crée un serveur Minecraft 1.21");

    const body = mocks.post.mock.calls[0][1];
    expect(mocks.post.mock.calls[0][0]).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(body.model).toBe("openai/gpt-oss-20b");
    expect(body.tool_choice).toBe("required");
    expect(body.tools.map((tool: any) => tool.function.name)).toEqual([
      "create_instance_from_template"
    ]);
    expect(body.messages[0].content).toContain(paperId);
    expect(confirmation).toContain("« Survie »");
    expect(confirmation).toContain(paper.title);
    expect(confirmation).toContain("Local node (daemon-1)");
    expect(confirmation).toContain("oui");
    expect(mocks.remoteRequest).not.toHaveBeenCalled();

    const created = await say("oui");

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.remoteRequest).toHaveBeenCalledTimes(1);
    expect(mocks.remoteRequest.mock.calls[0][0]).toBe("instance/asynchronous");
    expect(created).toContain("new-1");
    expect(created).toContain("task-1");
  });

  it("falls back to JSON arguments when the engine returns no tool call", async () => {
    mocks.post
      .mockResolvedValueOnce(
        engineReply({ role: "assistant", content: "J’attends votre confirmation.", tool_calls: [] })
      )
      .mockResolvedValueOnce(
        engineReply({
          role: "assistant",
          content: `\`\`\`json\n{"templateId":"${paperId}","daemonId":"daemon-1","nickname":"Survie"}\n\`\`\``
        })
      );

    const answer = await say("Crée un serveur Minecraft 1.21");

    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[1][1].tools).toBeUndefined();
    expect(answer).toContain("Je peux créer cette instance");
    expect(mocks.remoteRequest).not.toHaveBeenCalled();
  });

  it("shows a clear error and logs diagnostics when no usable call is produced", async () => {
    mocks.post.mockResolvedValue(
      engineReply({ role: "assistant", content: "J’attends votre confirmation." })
    );

    const answer = await say("Crée un serveur Minecraft 1.21");

    expect(answer).toContain("n’a pas produit d’appel d’outil exploitable");
    expect(answer).toContain("aucune instance n’a été créée");
    const logs = mocks.warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logs).toContain("No usable creation arguments");
    expect(logs).toContain("model=openai/gpt-oss-20b");
    expect(logs).not.toContain("marketplace.example");
    expect(mocks.remoteRequest).not.toHaveBeenCalled();
  });

  it("refuses an invented template returned by the model", async () => {
    mocks.post.mockResolvedValueOnce(toolCallReply({ templateId: "ffffffffffff" }));

    const answer = await say("Crée un serveur Minecraft 1.21");

    expect(answer).toContain("ne figure pas dans le catalogue");
    expect(answer).toContain("Aucune instance n’a été créée");
    expect(await say("oui")).not.toContain("new-1");
    expect(mocks.remoteRequest).not.toHaveBeenCalled();
  });

  it("refuses non-administrators without calling the engine", async () => {
    mocks.getUser.mockReturnValue({ permission: 1, instances: [] });

    const answer = await say("Crée un serveur Minecraft 1.21");

    expect(answer).toContain("réservée aux administrateurs");
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.remoteRequest).not.toHaveBeenCalled();
  });

  it("reports that no daemon is online without calling the engine", async () => {
    mocks.services.clear();

    const answer = await say("Crée un serveur Minecraft 1.21");

    expect(answer).toContain("aucun daemon disponible");
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("reports a daemon failure after confirmation without claiming success", async () => {
    mocks.post.mockResolvedValueOnce(toolCallReply({ templateId: paperId }));
    mocks.remoteRequest.mockRejectedValue(new Error("Access denied: quick_install"));

    await say("Crée un serveur Minecraft 1.21");
    const answer = await say("oui");

    expect(answer).toContain("Je n’ai pas créé l’instance");
    expect(answer).toContain("le daemon a refusé");
    expect(answer).not.toContain("new-1");
  });

  it("lets the model ask which game when the request matches no template", async () => {
    mocks.post.mockResolvedValueOnce(
      engineReply({ role: "assistant", content: "Quel jeu veux-tu installer ?" })
    );

    const answer = await say("creer moi une instance");

    expect(mocks.post.mock.calls[0][1].tool_choice).toBe("auto");
    expect(answer).toBe("Quel jeu veux-tu installer ?");
  });
});

describe("Local AI instance-scoped file editing", () => {
  let service: LocalAiService;
  let files: Map<string, string>;
  let counter = 0;

  function call(name: string, args: unknown) {
    return engineReply(
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call-${name}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) }
          }
        ]
      },
      "tool_calls"
    );
  }

  async function say(prompt: string) {
    mocks.conversation.messages.push({ id: `su${counter}`, role: "user", content: prompt });
    const answer: string = await (service as any).generate({
      record: { uuid: `scoped-${counter++}` },
      abortController: new AbortController(),
      prompt,
      ownerUuid: "admin-1",
      conversationUuid: mocks.conversation.uuid
    });
    mocks.conversation.messages.push({ id: `sa${counter}`, role: "assistant", content: answer });
    return answer;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    service = new LocalAiService();
    mocks.conversation.uuid = `scoped-${Math.random()}`;
    mocks.conversation.messages = [];
    mocks.conversation.instanceScope = {
      daemonId: "daemon-1",
      instanceUuid: "instance-1",
      nickname: "Survie"
    };
    mocks.getUser.mockReturnValue({ permission: 1, userName: "alice", instances: [] });
    mocks.hasInstance.mockReturnValue(true);
    const remote = { available: true, config: { remarks: "Local node" } };
    mocks.getRemoteService.mockReturnValue(remote);
    files = new Map([["/server.properties", "motd=Hello\nmax-players=20\n"]]);
    mocks.remoteRequest.mockReset();
    mocks.remoteRequest.mockImplementation(async (event: string, data: any) => {
      if (event !== "file/edit") throw new Error(`unexpected ${event}`);
      if (typeof data.text === "string") {
        files.set(data.target, data.text);
        return true;
      }
      return files.get(data.target) ?? Promise.reject(new Error("ENOENT"));
    });
    mocks.post.mockReset();
  });

  it("reads, previews and writes an instance file only after yes", async () => {
    mocks.post
      .mockResolvedValueOnce(call("read_instance_file", { path: "/server.properties" }))
      .mockResolvedValueOnce(
        call("edit_instance_file", {
          path: "/server.properties",
          edits: [{ find: "max-players=20", replace: "max-players=50" }]
        })
      );

    const preview = await say("Passe le nombre de joueurs max à 50");

    const firstBody = mocks.post.mock.calls[0][1];
    expect(firstBody.tools.map((tool: any) => tool.function.name)).toContain("edit_instance_file");
    expect(firstBody.messages[0].content).toContain("Survie");
    expect(preview).toContain("Je propose de modifier `/server.properties`");
    expect(preview).toContain("- max-players=20");
    expect(preview).toContain("+ max-players=50");
    expect(files.get("/server.properties")).toContain("max-players=20");

    const done = await say("oui");

    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(done).toContain("C’est fait");
    expect(files.get("/server.properties")).toBe("motd=Hello\nmax-players=50\n");
  });

  it("cancels the proposed edit when the user answers something else", async () => {
    mocks.post
      .mockResolvedValueOnce(
        call("edit_instance_file", {
          path: "/server.properties",
          edits: [{ find: "max-players=20", replace: "max-players=50" }]
        })
      )
      .mockResolvedValue(engineReply({ role: "assistant", content: "D’accord, j’annule." }));

    await say("Passe le nombre de joueurs max à 50");
    await say("non finalement");
    await say("oui");

    expect(files.get("/server.properties")).toContain("max-players=20");
  });

  it("refuses to bind a conversation to an instance the user cannot access", async () => {
    mocks.hasInstance.mockReturnValue(false);
    await expect(
      service.createConversation("user-1", "", { daemonId: "daemon-1", instanceUuid: "other" })
    ).rejects.toThrow("Instance not accessible");
    expect(mocks.stored).not.toHaveBeenCalled();

    mocks.hasInstance.mockReturnValue(true);
    const conversation = await service.createConversation("user-1", "", {
      daemonId: "daemon-1",
      instanceUuid: "instance-1"
    });
    expect(conversation.instanceScope).toEqual({
      daemonId: "daemon-1",
      instanceUuid: "instance-1",
      nickname: "Survie"
    });
    expect(conversation.title).toBe("AI - Survie");
  });
});

describe("Instance-dedicated conversation", () => {
  it("does not run the server creation flow and only offers instance tools", async () => {
    vi.clearAllMocks();
    mocks.post.mockReset();
    mocks.post.mockResolvedValue(
      engineReply({ role: "assistant", content: "Utilise la page Local AI pour créer un serveur." })
    );
    mocks.getUser.mockReturnValue({ permission: 10, userName: "root", instances: [] });
    mocks.conversation.uuid = `dedicated-${Math.random()}`;
    mocks.conversation.instanceScope = {
      daemonId: "daemon-1",
      instanceUuid: "instance-1",
      nickname: "Survie"
    };
    mocks.conversation.messages = [
      { id: "u1", role: "user", content: "Crée un serveur Minecraft 1.21", createdAt: "" }
    ];

    await (new LocalAiService() as any).generate({
      record: { uuid: "dedicated-request" },
      abortController: new AbortController(),
      prompt: "Crée un serveur Minecraft 1.21",
      ownerUuid: "admin-1",
      conversationUuid: mocks.conversation.uuid
    });

    const body = mocks.post.mock.calls[0][1];
    expect(body.tool_choice).toBe("auto");
    expect(body.tools.map((tool: any) => tool.function.name)).not.toContain(
      "create_instance_from_template"
    );
    expect(body.messages[0].content).toContain("dedicated to one instance");
    expect(mocks.getAppMarketList).not.toHaveBeenCalled();
  });
});

describe("Instance assistant plugin installation", () => {
  it("searches first, then shows a panel-authored install preview", async () => {
    vi.clearAllMocks();
    mocks.post.mockReset();
    mocks.remoteRequest.mockReset();
    mocks.remoteRequest.mockImplementation(async (event: string, data: any) => {
      if (event === "instance/detail")
        return { config: { type: "minecraft/java/paper" }, info: {} };
      if (event === "file/list") return { items: [{ name: "plugins", type: 0 }] };
      if (event === "file/edit" && data.target === "/version_history.json") {
        return JSON.stringify({ currentVersion: "git-Paper-12 (MC: 26.2)" });
      }
      if (event === "instance/mods/list") return { mods: [], downloadTasks: [] };
      throw new Error("ENOENT");
    });
    mocks.getUser.mockReturnValue({ permission: 1, userName: "alice", instances: [] });
    mocks.getRemoteService.mockReturnValue({ available: true, config: {} });
    mocks.conversation.uuid = `plugin-${Math.random()}`;
    mocks.conversation.instanceScope = {
      daemonId: "daemon-1",
      instanceUuid: "instance-1",
      nickname: "Survie"
    };
    mocks.conversation.messages = [
      { id: "u1", role: "user", content: "installe le plugin via version", createdAt: "" }
    ];
    const toolCall = (name: string, args: unknown) => ({
      data: {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `c-${name}`,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) }
                }
              ]
            }
          }
        ]
      }
    });
    mocks.post
      .mockResolvedValueOnce(toolCall("search_plugins", { query: "via version" }))
      .mockResolvedValueOnce(
        toolCall("install_plugin", { projectId: "P1sxKqOb", source: "Modrinth" })
      );

    const answer: string = await (new LocalAiService() as any).generate({
      record: { uuid: "plugin-request" },
      abortController: new AbortController(),
      prompt: "installe le plugin via version",
      ownerUuid: "admin-1",
      conversationUuid: mocks.conversation.uuid
    });

    const first = mocks.post.mock.calls[0][1];
    expect(first.tool_choice).toBe("required");
    expect(first.tools.map((tool: any) => tool.function.name)).toEqual(["search_plugins"]);
    expect(first.messages[0].content).toContain("never ask the user for the version");
    expect(mocks.post.mock.calls[1][1].tool_choice).toBe("auto");
    expect(answer).toContain("Je peux installer **ViaVersion 5.4.1** (Modrinth)");
    expect(answer).toContain("Paper 26.2");
    expect(mocks.remoteRequest).not.toHaveBeenCalledWith(
      "instance/mods/install",
      expect.anything(),
      expect.anything()
    );
  });
});
