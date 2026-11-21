import { StorageSubsystem } from "mcsmanager-common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import aiToolService, { EDIT_FILE_TOOL } from "../ai_tool_service";
import { LocalAiService } from "../local_ai_service";

// Conversations must be fully isolated: the model only ever sees the current conversation,
// a confirmation only applies inside the conversation that asked for it, and an instance
// binding survives storage round trips. The storage below reproduces the real reload logic
// (JSON serialization + StorageSubsystem.defineAttr) instead of returning shared objects.
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  remoteRequest: vi.fn(),
  records: new Map<string, string>()
}));
const realStorage = new StorageSubsystem() as any;

vi.mock("axios", () => ({ default: { post: mocks.post, get: vi.fn() } }));
vi.mock("../../entity/user", () => ({ ROLE: { ADMIN: 10, USER: 1, GUEST: 0, BAN: -1 } }));
vi.mock("../user_service", () => ({
  default: { getInstance: () => ({ permission: 10, userName: "root", instances: [] }) }
}));
vi.mock("../passport_service", () => ({ getUserUuid: vi.fn() }));
vi.mock("../permission_service", () => ({ isHaveInstance: () => true }));
vi.mock("../remote_service", () => ({
  default: {
    services: new Map(),
    getInstance: () => ({ available: true, config: {} })
  }
}));
vi.mock("../remote_command", () => ({
  default: class {
    request = mocks.remoteRequest;
  }
}));
vi.mock("../instance_service", () => ({ getAppMarketList: vi.fn(async () => ({ packages: [] })) }));
vi.mock("../instance_name_service", () => ({ getInstanceNameSafely: vi.fn(async () => "Survie") }));
vi.mock("../operation_logger", () => ({ operationLogger: { log: vi.fn() } }));
vi.mock("../log", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("../../common/storage/sys_storage", () => ({
  default: {
    getStorage: () => ({
      store: async (category: string, uuid: string, object: unknown) => {
        mocks.records.set(`${category}:${uuid}`, JSON.stringify(object));
      },
      load: async (category: string, classz: any, uuid: string) => {
        const raw = mocks.records.get(`${category}:${uuid}`);
        return raw ? realStorage.defineAttr(new classz(), JSON.parse(raw)) : null;
      },
      list: async (category: string) =>
        [...mocks.records.keys()]
          .filter((key) => key.startsWith(`${category}:`))
          .map((key) => key.slice(category.length + 1)),
      delete: async (category: string, uuid: string) => {
        mocks.records.delete(`${category}:${uuid}`);
      }
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
    aiMaxConversationMessages: 200,
    aiQueueCapacity: 50
  }
}));

const reply = (message: Record<string, unknown>) => ({
  data: { choices: [{ message, finish_reason: "stop" }] }
});

describe("AI conversation isolation", () => {
  let service: LocalAiService;
  let counter = 0;

  async function say(conversationUuid: string, prompt: string) {
    const conversation = await service.getConversation("owner-1", conversationUuid);
    conversation!.messages.push({
      id: `u${counter}`,
      role: "user",
      content: prompt,
      createdAt: ""
    });
    await realStore(conversation);
    const answer: string = await (service as any).generate({
      record: { uuid: `request-${counter++}` },
      abortController: new AbortController(),
      prompt,
      ownerUuid: "owner-1",
      conversationUuid
    });
    const updated = await service.getConversation("owner-1", conversationUuid);
    updated!.messages.push({
      id: `a${counter}`,
      role: "assistant",
      content: answer,
      createdAt: ""
    });
    await realStore(updated);
    return answer;
  }
  const realStore = async (conversation: any) =>
    mocks.records.set(`AiConversation:${conversation.uuid}`, JSON.stringify(conversation));

  beforeEach(() => {
    mocks.records.clear();
    mocks.post.mockReset();
    mocks.remoteRequest.mockReset();
    service = new LocalAiService();
  });

  it("keeps the instance binding after the conversation is reloaded and saved again", async () => {
    const scoped = await service.createConversation("owner-1", "New conversation", {
      daemonId: "daemon-1",
      instanceUuid: "instance-1"
    });
    const general = await service.createConversation("owner-1", "General");

    const reloaded = await service.getConversation("owner-1", scoped.uuid);
    reloaded!.messages.push({ id: "m", role: "user", content: "hello", createdAt: "" });
    await realStore(reloaded);

    expect((await service.getConversation("owner-1", scoped.uuid))?.instanceScope).toEqual({
      daemonId: "daemon-1",
      instanceUuid: "instance-1",
      nickname: "Survie"
    });
    expect((await service.getConversation("owner-1", general.uuid))?.instanceScope).toBeUndefined();
    const listed = await service.listConversations("owner-1");
    expect(listed.filter((item) => item.instanceScope)).toHaveLength(1);
  });

  it("only sends the current conversation's history to the model", async () => {
    const first = await service.createConversation("owner-1", "First");
    const second = await service.createConversation("owner-1", "Second");
    mocks.post.mockResolvedValue(reply({ role: "assistant", content: "Noté." }));

    await say(first.uuid, "Mon mot secret est ANANAS.");
    await say(second.uuid, "Quel est mon mot secret ?");

    const sent = JSON.stringify(mocks.post.mock.calls[1][1].messages);
    expect(sent).toContain("Quel est mon mot secret ?");
    expect(sent).not.toContain("ANANAS");
  });

  it("never applies a confirmation from another conversation", async () => {
    files = new Map([["/server.properties", "max-players=20\n"]]);
    mocks.remoteRequest.mockImplementation(fakeFiles);
    const first = await service.createConversation("owner-1", "New conversation", {
      daemonId: "daemon-1",
      instanceUuid: "instance-1"
    });
    const second = await service.createConversation("owner-1", "New conversation", {
      daemonId: "daemon-1",
      instanceUuid: "instance-1"
    });
    mocks.post.mockResolvedValueOnce(
      reply({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: EDIT_FILE_TOOL,
              arguments: JSON.stringify({
                path: "/server.properties",
                edits: [{ find: "max-players=20", replace: "max-players=50" }]
              })
            }
          }
        ]
      })
    );
    mocks.post.mockResolvedValue(reply({ role: "assistant", content: "Oui de quoi ?" }));

    expect(await say(first.uuid, "Passe à 50 joueurs")).toContain("Je propose de modifier");
    expect(aiToolService.hasPendingConfirmation("owner-1", first.uuid)).toBe(true);

    await say(second.uuid, "oui");

    expect(files.get("/server.properties")).toBe("max-players=20\n");
    expect(aiToolService.hasPendingConfirmation("owner-1", first.uuid)).toBe(true);
  });
});

let files = new Map<string, string>();
async function fakeFiles(event: string, data: any) {
  if (event !== "file/edit") throw new Error(`unexpected ${event}`);
  if (typeof data.text === "string") {
    files.set(data.target, data.text);
    return true;
  }
  if (!files.has(data.target)) throw new Error("ENOENT");
  return files.get(data.target);
}

describe("AI conversation history retention (2 hours after the last message)", () => {
  let service: LocalAiService;
  const HOUR = 60 * 60 * 1000;

  async function conversationAged(ms: number, title = "Old") {
    const conversation = await service.createConversation("owner-1", title);
    const stamp = new Date(Date.now() - ms).toISOString();
    mocks.records.set(
      `AiConversation:${conversation.uuid}`,
      JSON.stringify({ ...conversation, createdAt: stamp, updatedAt: stamp })
    );
    return conversation.uuid;
  }

  beforeEach(() => {
    mocks.records.clear();
    service = new LocalAiService();
  });

  it("reports the deletion time two hours after the last message", async () => {
    const uuid = await conversationAged(30 * 60 * 1000);
    const conversation = await service.getConversation("owner-1", uuid);
    const view = service.withExpiry(conversation!);
    expect(Date.parse(view.expiresAt) - Date.parse(conversation!.updatedAt)).toBe(2 * HOUR);
  });

  it("hides and deletes conversations older than two hours, keeps recent ones", async () => {
    const old = await conversationAged(2 * HOUR + 1000, "Old");
    const recent = await conversationAged(HOUR + 59 * 60 * 1000, "Recent");

    expect(await service.getConversation("owner-1", old)).toBeNull();
    expect(mocks.records.has(`AiConversation:${old}`)).toBe(false);
    expect((await service.listConversations("owner-1")).map((item) => item.uuid)).toEqual([recent]);
  });

  it("purges expired conversations, their pending action and old request records", async () => {
    const old = await conversationAged(3 * HOUR);
    const recent = await conversationAged(10 * 60 * 1000);
    mocks.records.set(
      "AiRequest:r-old",
      JSON.stringify({
        uuid: "r-old",
        state: "completed",
        completedAt: new Date(Date.now() - 3 * HOUR).toISOString()
      })
    );
    mocks.records.set(
      "AiRequest:r-new",
      JSON.stringify({ uuid: "r-new", state: "completed", completedAt: new Date().toISOString() })
    );
    const forget = vi.spyOn(aiToolService, "forgetConversation");

    expect(await service.purgeExpired()).toBe(1);

    expect(mocks.records.has(`AiConversation:${old}`)).toBe(false);
    expect(mocks.records.has(`AiConversation:${recent}`)).toBe(true);
    expect(mocks.records.has("AiRequest:r-old")).toBe(false);
    expect(mocks.records.has("AiRequest:r-new")).toBe(true);
    expect(forget).toHaveBeenCalledWith("owner-1", old);
  });

  it("never deletes a conversation while its request is waiting or running", async () => {
    const old = await conversationAged(3 * HOUR);
    (service as any).queue.push({ record: { conversationUuid: old, state: "queued" } });

    expect(await service.purgeExpired()).toBe(0);
    expect(mocks.records.has(`AiConversation:${old}`)).toBe(true);
  });

  it("restarts the two-hour delay at every message", async () => {
    const uuid = await conversationAged(HOUR + 50 * 60 * 1000);
    const conversation = await service.getConversation("owner-1", uuid);
    conversation!.updatedAt = new Date().toISOString();
    await realStore(conversation);

    expect(await service.purgeExpired(Date.now() + HOUR)).toBe(0);
    expect(await service.purgeExpired(Date.now() + 2 * HOUR + 1000)).toBe(1);
  });
});

const realStore = async (conversation: any) =>
  mocks.records.set(`AiConversation:${conversation.uuid}`, JSON.stringify(conversation));

describe("Scheduled AI reports", () => {
  let service: LocalAiService;
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    mocks.records.clear();
    mocks.post.mockReset();
    mocks.remoteRequest.mockReset();
    service = new LocalAiService();
  });

  async function reportAged(ms: number) {
    const report = await service.createConversation(
      "owner-1",
      "Rapport",
      { daemonId: "daemon-1", instanceUuid: "instance-1" },
      "report"
    );
    const stamp = new Date(Date.now() - ms).toISOString();
    mocks.records.set(
      `AiConversation:${report.uuid}`,
      JSON.stringify({ ...report, createdAt: stamp, updatedAt: stamp })
    );
    return report.uuid;
  }

  it("keeps reports 7 days instead of 2 hours", async () => {
    const recent = await reportAged(3 * 60 * 60 * 1000);
    const old = await reportAged(7 * DAY + 1000);
    expect(await service.purgeExpired()).toBe(1);
    expect(mocks.records.has(`AiConversation:${recent}`)).toBe(true);
    expect(mocks.records.has(`AiConversation:${old}`)).toBe(false);
    const view = service.withExpiry((await service.getConversation("owner-1", recent))!);
    expect(Date.parse(view.expiresAt) - Date.parse(view.updatedAt)).toBe(7 * DAY);
    expect(view.kind).toBe("report");
  });

  it("only exposes read-only tools and refuses edits during a scheduled run", async () => {
    const report = await reportAged(0);
    mocks.post
      .mockResolvedValueOnce(
        reply({
          content: null,
          tool_calls: [
            {
              id: "call-1",
              function: {
                name: EDIT_FILE_TOOL,
                arguments: JSON.stringify({ path: "server.properties", content: "pvp=false" })
              }
            }
          ]
        })
      )
      .mockResolvedValueOnce(reply({ content: "Tout va bien." }));

    const answer: string = await (service as any).generate({
      record: { uuid: "scheduled-1" },
      abortController: new AbortController(),
      prompt: "Vérifie les fichiers",
      ownerUuid: "owner-1",
      conversationUuid: report,
      scheduled: { context: "{}", suffix: "" }
    });

    expect(answer).toBe("Tout va bien.");
    const tools = mocks.post.mock.calls[0][1].tools.map((tool: any) => tool.function.name);
    expect(tools.sort()).toEqual(["list_instance_files", "read_instance_file", "search_plugins"]);
    const toolMessage = mocks.post.mock.calls[1][1].messages.find((m: any) => m.role === "tool");
    expect(JSON.parse(toolMessage.content)).toMatchObject({
      decision: "refused",
      error: "Not available in scheduled tasks"
    });
    expect(mocks.remoteRequest).not.toHaveBeenCalledWith(
      "file/edit",
      expect.objectContaining({ text: expect.anything() }),
      expect.anything()
    );
    expect(aiToolService.hasPendingConfirmation("owner-1", report)).toBe(false);
  });

  it("puts the trusted context in the system prompt and appends the panel suffix", async () => {
    const report = await reportAged(0);
    mocks.post.mockResolvedValueOnce(reply({ content: "Résumé" }));
    const finished = vi.fn();
    await service.submit("owner-1", report, "Rapport console", {
      scheduledContext: "Console log (last lines):\nERROR boom",
      scheduledSuffix: "\n\n| table |",
      onFinished: finished
    });
    for (let i = 0; i < 100 && !finished.mock.calls.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(finished).toHaveBeenCalledWith("completed");
    const system = mocks.post.mock.calls[0][1].messages[0].content;
    expect(system).toContain("ERROR boom");
    const stored = await service.getConversation("owner-1", report);
    expect(stored!.messages.map((m) => m.content)).toEqual([
      "Rapport console",
      "Résumé\n\n| table |"
    ]);
  });
});
