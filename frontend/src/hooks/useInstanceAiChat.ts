import axios from "axios";
import { computed, onBeforeUnmount, ref } from "vue";
import type { AiAccessView } from "@/types";
import { useAppStateStore } from "@/stores/useAppStateStore";

export interface InstanceAiMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
}

export interface InstanceAiConversation {
  uuid: string;
  /** "report": produced by a scheduled AI task, kept several days. */
  kind?: "chat" | "report";
  title: string;
  updatedAt: string;
  /** Set by the panel: the conversation is deleted at this time (2 h after the last message). */
  expiresAt?: string;
  messages: InstanceAiMessage[];
  instanceScope?: { daemonId: string; instanceUuid: string; nickname?: string };
}

export interface InstanceAiRequest {
  uuid: string;
  state: "queued" | "processing" | "completed" | "failed" | "cancelled" | "timeout";
  position: number;
  errorCode?: string;
}

/** Short, user-visible reason of a failed API call (server message or HTTP status). */
export function describeAiError(error: any): string {
  const data = error?.response?.data;
  const message = typeof data?.data === "string" ? data.data : typeof data === "string" ? data : "";
  const status = error?.response?.status ? `HTTP ${error.response.status}` : "";
  return [status, message || (status ? "" : String(error?.message || ""))]
    .filter(Boolean)
    .join(" - ")
    .slice(0, 300);
}

/** Label of a conversation in the history: its first question, else its title. */
export function conversationLabel(conversation: InstanceAiConversation): string {
  const first = conversation.messages?.find((message) => message.role === "user")?.content;
  return (first || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

const FINISHED_STATES = ["completed", "failed", "cancelled", "timeout"];
const POLL_INTERVAL_MS = 2000;
const isExpired = (conversation: InstanceAiConversation | null, now = Date.now()) =>
  !!conversation?.expiresAt && Date.parse(conversation.expiresAt) <= now;
const isNotFound = (error: unknown) =>
  /Conversation not found|HTTP 404/.test(describeAiError(error));

/**
 * Chat dedicated to one instance. The panel binds the conversation to the instance after
 * checking the user's access; the instance is never chosen by the model. Conversations are
 * kept as a short history and deleted by the panel 2 hours after their last message.
 */
export function useInstanceAiChat(daemonId: string, instanceUuid: string) {
  const { state } = useAppStateStore();
  const conversation = ref<InstanceAiConversation | null>(null);
  const history = ref<InstanceAiConversation[]>([]);
  const retentionMinutes = ref(120);
  const request = ref<InstanceAiRequest | null>(null);
  const enabled = ref(true);
  // Regular users need an administrator's grant (administrators are reported as "granted").
  const access = ref<AiAccessView | null>(null);
  const needsAccess = computed(() => !!access.value && access.value.state !== "granted");
  const loading = ref(false);
  const sending = ref(false);
  const errorCode = ref<"" | "load" | "send" | "timeout" | "engine" | "disabled">("");
  const errorDetail = ref("");
  const fail = (code: "load" | "send", error: unknown) => {
    errorCode.value = code;
    errorDetail.value = describeAiError(error);
  };
  const clearError = () => {
    errorCode.value = "";
    errorDetail.value = "";
  };
  let timer: number | undefined;

  const config = () => ({
    params: { token: state.userInfo?.token },
    headers: { "X-Requested-With": "XMLHttpRequest" }
  });
  const api = (path: string) => `./api/ai${path}`;

  const isBusy = () =>
    sending.value || (!!request.value && !FINISHED_STATES.includes(request.value.state));

  function remember(item: InstanceAiConversation) {
    history.value = [item, ...history.value.filter((entry) => entry.uuid !== item.uuid)].sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  function forget(uuid: string) {
    history.value = history.value.filter((entry) => entry.uuid !== uuid);
  }

  async function reloadConversation() {
    if (!conversation.value) return;
    const result = await axios.get(
      api(`/conversations/${encodeURIComponent(conversation.value.uuid)}`),
      config()
    );
    conversation.value = result.data?.data || conversation.value;
    if (conversation.value) remember(conversation.value);
  }

  async function createConversation() {
    const result = await axios.post(
      api("/conversations"),
      // The panel validator rejects empty strings; "New conversation" is replaced by
      // "AI - <instance name>" server-side.
      { title: "New conversation", daemonId, instanceUuid },
      config()
    );
    conversation.value = result.data?.data || null;
    if (conversation.value) remember(conversation.value);
  }

  /** Conversations of this instance still kept by the panel, newest first. */
  async function loadHistory() {
    const list = await axios.get(api("/conversations"), config());
    const conversations: InstanceAiConversation[] = list.data?.data || [];
    history.value = conversations
      .filter(
        (item) =>
          item.instanceScope?.daemonId === daemonId &&
          item.instanceScope?.instanceUuid === instanceUuid &&
          !isExpired(item)
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Opens the latest conversation of this instance, or creates one. */
  async function open() {
    if (loading.value) return;
    loading.value = true;
    clearError();
    try {
      const status = await axios.get(api("/status"), config());
      enabled.value = Boolean(status.data?.data?.enabled);
      retentionMinutes.value = Number(status.data?.data?.conversationRetentionMinutes) || 120;
      access.value = status.data?.data?.access || null;
      if (needsAccess.value) return;
      if (!enabled.value) {
        errorCode.value = "disabled";
        return;
      }
      await loadHistory();
      const current = conversation.value
        ? history.value.find((item) => item.uuid === conversation.value?.uuid)
        : undefined;
      // Scheduled reports stay in the history but the chat opens on a normal conversation.
      const target = current || history.value.find((item) => item.kind !== "report");
      if (target) {
        conversation.value = target;
        await reloadConversation();
      } else {
        await createConversation();
      }
    } catch (error) {
      if (isNotFound(error)) {
        await createConversation().catch((createError) => fail("load", createError));
      } else {
        fail("load", error);
      }
    } finally {
      loading.value = false;
    }
  }

  function resetRequest() {
    stopPolling();
    request.value = null;
  }

  async function newConversation() {
    if (isBusy()) return;
    clearError();
    // A new conversation starts from a clean state: nothing is carried over from the last one.
    resetRequest();
    try {
      await createConversation();
    } catch (error) {
      fail("load", error);
    }
  }

  async function selectConversation(uuid: string) {
    if (isBusy() || conversation.value?.uuid === uuid) return;
    const target = history.value.find((item) => item.uuid === uuid);
    if (!target) return;
    clearError();
    resetRequest();
    conversation.value = target;
    try {
      await reloadConversation();
    } catch (error) {
      if (isNotFound(error)) {
        // Deleted by the panel in the meantime (expired).
        forget(uuid);
        conversation.value = history.value[0] || null;
        if (conversation.value) await reloadConversation().catch(() => undefined);
        else await createConversation().catch((createError) => fail("load", createError));
      } else {
        fail("load", error);
      }
    }
  }

  async function deleteConversation(uuid: string) {
    if (isBusy() && conversation.value?.uuid === uuid) return;
    clearError();
    try {
      await axios.delete(api(`/conversations/${encodeURIComponent(uuid)}`), config());
    } catch (error) {
      if (!isNotFound(error)) {
        fail("load", error);
        return;
      }
    }
    forget(uuid);
    if (conversation.value?.uuid === uuid) {
      resetRequest();
      conversation.value = history.value[0] || null;
      try {
        if (conversation.value) await reloadConversation();
        else await createConversation();
      } catch (error) {
        fail("load", error);
      }
    }
  }

  function stopPolling() {
    if (timer) window.clearInterval(timer);
    timer = undefined;
  }

  async function poll() {
    if (!request.value) return stopPolling();
    try {
      const result = await axios.get(
        api(`/requests/${encodeURIComponent(request.value.uuid)}`),
        config()
      );
      request.value = result.data?.data || request.value;
      if (request.value && FINISHED_STATES.includes(request.value.state)) {
        stopPolling();
        if (request.value.state === "timeout" || request.value.errorCode === "timeout") {
          errorCode.value = "timeout";
        } else if (request.value.state === "failed") {
          errorCode.value = "engine";
        }
        await reloadConversation();
      }
    } catch (error) {
      stopPolling();
      fail("load", error);
    }
  }

  async function submit(text: string) {
    const result = await axios.post(
      api(`/conversations/${encodeURIComponent(conversation.value!.uuid)}/generate`),
      { content: text },
      config()
    );
    request.value = result.data?.data || null;
    stopPolling();
    timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
  }

  async function send(content: string) {
    const text = content.trim();
    if (!text || isBusy()) return false;
    sending.value = true;
    clearError();
    try {
      // An expired conversation no longer exists on the panel: continue in a new one.
      if (!conversation.value || isExpired(conversation.value)) {
        if (conversation.value) forget(conversation.value.uuid);
        await createConversation();
      }
      if (!conversation.value) return false;
      const pushLocal = () =>
        conversation.value?.messages.push({
          id: `local-${Date.now()}`,
          role: "user",
          content: text,
          createdAt: new Date().toISOString()
        });
      pushLocal();
      try {
        await submit(text);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        // Deleted between two checks: retry once in a fresh conversation.
        forget(conversation.value.uuid);
        await createConversation();
        pushLocal();
        await submit(text);
      }
      return true;
    } catch (error) {
      fail("send", error);
      await reloadConversation().catch(() => undefined);
      return false;
    } finally {
      sending.value = false;
    }
  }

  async function cancel() {
    if (!request.value) return;
    try {
      await axios.post(
        api(`/requests/${encodeURIComponent(request.value.uuid)}/cancel`),
        {},
        config()
      );
    } finally {
      await poll();
    }
  }

  onBeforeUnmount(stopPolling);

  return {
    conversation,
    history,
    retentionMinutes,
    request,
    enabled,
    access,
    needsAccess,
    loading,
    sending,
    errorCode,
    errorDetail,
    isBusy,
    open,
    loadHistory,
    send,
    cancel,
    newConversation,
    selectConversation,
    deleteConversation,
    stopPolling
  };
}
