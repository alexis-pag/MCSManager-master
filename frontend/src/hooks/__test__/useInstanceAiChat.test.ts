// @vitest-environment jsdom

import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";
import { useInstanceAiChat } from "../useInstanceAiChat";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));

vi.mock("axios", () => ({
  default: { get: mocks.get, post: mocks.post, delete: mocks.delete }
}));
vi.mock("@/stores/useAppStateStore", () => ({
  useAppStateStore: () => ({ state: { userInfo: { token: "token-1" } } })
}));

const scoped = {
  uuid: "conv-instance",
  title: "AI - Survie",
  updatedAt: "",
  messages: [{ id: "m1", role: "assistant", content: "Bonjour", createdAt: "" }],
  instanceScope: { daemonId: "daemon-1", instanceUuid: "instance-1", nickname: "Survie" }
};
const other = {
  ...scoped,
  uuid: "conv-other",
  instanceScope: { daemonId: "daemon-1", instanceUuid: "x" }
};

function setup() {
  let chat!: ReturnType<typeof useInstanceAiChat>;
  const wrapper = mount(
    defineComponent({
      setup() {
        chat = useInstanceAiChat("daemon-1", "instance-1");
        return () => null;
      }
    })
  );
  return { chat, wrapper };
}

const ok = (data: unknown) => Promise.resolve({ data: { data } });

describe("useInstanceAiChat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.get.mockReset();
    mocks.post.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reopens the conversation dedicated to this instance", async () => {
    mocks.get.mockImplementation((url: string) => {
      if (url.endsWith("/status")) return ok({ enabled: true });
      if (url.endsWith("/conversations")) return ok([other, scoped]);
      return ok(scoped);
    });
    const { chat } = setup();

    await chat.open();

    expect(chat.conversation.value?.uuid).toBe("conv-instance");
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("shows the access request instead of loading conversations without AI access", async () => {
    mocks.get.mockImplementation((url: string) =>
      url.endsWith("/status")
        ? ok({ enabled: true, access: { state: "pending", note: "" } })
        : ok([scoped])
    );
    const { chat } = setup();

    await chat.open();

    expect(chat.needsAccess.value).toBe(true);
    expect(chat.conversation.value).toBeNull();
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("opens the chat once access is granted", async () => {
    mocks.get.mockImplementation((url: string) => {
      if (url.endsWith("/status")) return ok({ enabled: true, access: { state: "granted" } });
      if (url.endsWith("/conversations")) return ok([scoped]);
      return ok(scoped);
    });
    const { chat } = setup();

    await chat.open();

    expect(chat.needsAccess.value).toBe(false);
    expect(chat.conversation.value?.uuid).toBe("conv-instance");
  });

  it("creates a conversation bound to the instance when none exists", async () => {
    mocks.get.mockImplementation((url: string) =>
      url.endsWith("/status") ? ok({ enabled: true }) : ok([other])
    );
    mocks.post.mockReturnValue(ok(scoped));
    const { chat } = setup();

    await chat.open();

    expect(mocks.post).toHaveBeenCalledWith(
      "./api/ai/conversations",
      { title: "New conversation", daemonId: "daemon-1", instanceUuid: "instance-1" },
      expect.objectContaining({ params: { token: "token-1" } })
    );
    expect(chat.conversation.value?.uuid).toBe("conv-instance");
  });

  it("reports a disabled assistant without creating anything", async () => {
    mocks.get.mockReturnValue(ok({ enabled: false }));
    const { chat } = setup();

    await chat.open();

    expect(chat.errorCode.value).toBe("disabled");
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("sends a message, polls the request and reloads the answer", async () => {
    const answered = {
      ...scoped,
      messages: [
        ...scoped.messages,
        { id: "m3", role: "assistant", content: "Fait", createdAt: "" }
      ]
    };
    let requestState = "processing";
    mocks.get.mockImplementation((url: string) => {
      if (url.endsWith("/status")) return ok({ enabled: true });
      if (url.endsWith("/conversations")) return ok([scoped]);
      if (url.includes("/requests/"))
        return ok({ uuid: "req-1", state: requestState, position: 0 });
      return ok(requestState === "completed" ? answered : structuredClone(scoped));
    });
    mocks.post.mockReturnValue(ok({ uuid: "req-1", state: "queued", position: 1 }));
    const { chat, wrapper } = setup();
    await chat.open();

    expect(await chat.send("  passe à 50 joueurs  ")).toBe(true);
    expect(mocks.post).toHaveBeenCalledWith(
      "./api/ai/conversations/conv-instance/generate",
      { content: "passe à 50 joueurs" },
      expect.anything()
    );
    expect(chat.isBusy()).toBe(true);

    requestState = "completed";
    await vi.advanceTimersByTimeAsync(2000);
    await flushPromises();

    expect(chat.isBusy()).toBe(false);
    expect(chat.conversation.value?.messages.at(-1)?.content).toBe("Fait");
    wrapper.unmount();
  });

  it("shows the server reason when the conversation cannot be created", async () => {
    mocks.get.mockImplementation((url: string) =>
      url.endsWith("/status") ? ok({ enabled: true }) : ok([])
    );
    mocks.post.mockRejectedValue({
      response: {
        status: 400,
        data: { status: 400, data: 'Validator failed: "title" is required!' }
      }
    });
    const { chat } = setup();

    await chat.open();

    expect(chat.errorCode.value).toBe("load");
    expect(chat.errorDetail.value).toBe('HTTP 400 - Validator failed: "title" is required!');
  });
});

describe("useInstanceAiChat history", () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 1000).toISOString();
  const conv = (uuid: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({
    ...scoped,
    uuid,
    updatedAt,
    expiresAt: future,
    messages: [{ id: `${uuid}-1`, role: "user", content: `question ${uuid}`, createdAt: "" }],
    ...extra
  });
  const newer = conv("newer", "2026-11-21T10:00:00.000Z");
  const older = conv("older", "2026-11-21T09:00:00.000Z");
  const expired = conv("expired", "2026-11-21T08:00:00.000Z", { expiresAt: past });

  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
    mocks.delete.mockReset();
    mocks.get.mockImplementation((url: string) => {
      if (url.endsWith("/status")) return ok({ enabled: true, conversationRetentionMinutes: 120 });
      if (url.endsWith("/conversations")) return ok(structuredClone([older, other, expired, newer]));
      const uuid = url.split("/").pop();
      const found = [newer, older].find((item) => item.uuid === uuid);
      return found
        ? ok(structuredClone(found))
        : Promise.reject({ response: { status: 404, data: { data: "Conversation not found" } } });
    });
  });

  it("lists this instance's live conversations, newest first", async () => {
    const { chat } = setup();
    await chat.open();

    expect(chat.history.value.map((item) => item.uuid)).toEqual(["newer", "older"]);
    expect(chat.conversation.value?.uuid).toBe("newer");
    expect(chat.retentionMinutes.value).toBe(120);
  });

  it("reopens an older conversation from the history", async () => {
    const { chat } = setup();
    await chat.open();

    await chat.selectConversation("older");

    expect(chat.conversation.value?.messages[0].content).toBe("question older");
  });

  it("deletes the current conversation and falls back to the next one", async () => {
    mocks.delete.mockReturnValue(ok(true));
    const { chat } = setup();
    await chat.open();

    await chat.deleteConversation("newer");

    expect(mocks.delete).toHaveBeenCalledWith("./api/ai/conversations/newer", expect.anything());
    expect(chat.history.value.map((item) => item.uuid)).toEqual(["older"]);
    expect(chat.conversation.value?.uuid).toBe("older");
  });

  it("continues in a new conversation when the current one has expired", async () => {
    const fresh = conv("fresh", new Date().toISOString(), { messages: [] });
    mocks.post.mockImplementation((url: string) =>
      url.endsWith("/conversations") ? ok(fresh) : ok({ uuid: "req", state: "queued", position: 1 })
    );
    const { chat, wrapper } = setup();
    await chat.open();
    chat.conversation.value!.expiresAt = past;

    expect(await chat.send("salut")).toBe(true);

    expect(mocks.post).toHaveBeenCalledWith(
      "./api/ai/conversations/fresh/generate",
      { content: "salut" },
      expect.anything()
    );
    expect(chat.history.value.map((item) => item.uuid)).not.toContain("newer");
    wrapper.unmount();
  });

  it("retries once in a new conversation if the panel already deleted it", async () => {
    const fresh = conv("fresh", new Date().toISOString(), { messages: [] });
    mocks.post.mockImplementation((url: string) => {
      if (url.endsWith("/conversations")) return ok(fresh);
      if (url.includes("/newer/")) {
        return Promise.reject({
          response: { status: 500, data: { data: "Conversation not found" } }
        });
      }
      return ok({ uuid: "req", state: "queued", position: 1 });
    });
    const { chat, wrapper } = setup();
    await chat.open();

    expect(await chat.send("salut")).toBe(true);
    expect(chat.conversation.value?.uuid).toBe("fresh");
    expect(chat.errorCode.value).toBe("");
    wrapper.unmount();
  });
});
