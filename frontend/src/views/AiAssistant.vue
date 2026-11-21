<script setup lang="ts">
import axios from "axios";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { t } from "@/lang/i18n";
import AiAccessRequest from "@/components/AiAccessRequest.vue";
import { useAppStateStore } from "@/stores/useAppStateStore";

interface AiMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
}

interface AiInstanceScope {
  daemonId: string;
  instanceUuid: string;
  nickname?: string;
}

interface AiConversation {
  uuid: string;
  kind?: "chat" | "report";
  title: string;
  updatedAt: string;
  messages: AiMessage[];
  instanceScope?: AiInstanceScope;
}

interface AiRequest {
  uuid: string;
  state: "queued" | "processing" | "completed" | "failed" | "cancelled" | "timeout";
  position: number;
  model: string;
  errorCode?: string;
}

interface AiConfig {
  enabled: boolean;
  engineType: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  queueCapacity: number;
  maxConcurrent: number;
  conversationRetentionMinutes: number;
  reportRetentionDays: number;
  visionEnabled: boolean;
  /** Console commands the instance assistant may send (non-administrator commands). */
  consoleCommandAllowlist: string[];
}

const appState = useAppStateStore();
const route = useRoute();
// Opened from an instance page: the conversation is bound to that instance (verified server-side).
const routeScope = computed(() => {
  const daemonId = String(route.query.daemonId || "");
  const instanceUuid = String(route.query.instanceId || "");
  return daemonId && instanceUuid ? { daemonId, instanceUuid } : null;
});
const scopeLabel = computed(() => {
  const scope = activeConversation.value?.instanceScope;
  return scope ? scope.nickname || scope.instanceUuid : "";
});
const isRouteScope = (conversation: AiConversation) =>
  !!routeScope.value &&
  conversation.instanceScope?.daemonId === routeScope.value.daemonId &&
  conversation.instanceScope?.instanceUuid === routeScope.value.instanceUuid;
const isAdmin = computed(() => appState.isAdmin.value);
const conversations = ref<AiConversation[]>([]);
const activeConversation = ref<AiConversation | null>(null);
const prompt = ref("");
const status = ref<any>({ state: "disconnected", enabled: false });
const queue = ref<any>({ pending: 0, processing: false, requests: [], current: null });
const activeRequest = ref<AiRequest | null>(null);
const busy = ref(false);
const error = ref("");
const config = ref<AiConfig | null>(null);
const aiAccess = computed(() => status.value?.access);
const hasAiAccess = computed(() => isAdmin.value || aiAccess.value?.state === "granted");
let timer: number | undefined;
let initialConversationLoaded = false;

const requestConfig = {
  params: {} as Record<string, any>,
  headers: { "X-Requested-With": "XMLHttpRequest" }
};
const invalidEngineUrl = computed(() => {
  if (!config.value?.baseUrl) return false;
  try {
    const url = new URL(config.value.baseUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    const v1Index = segments.lastIndexOf("v1");
    return v1Index >= 0 && v1Index !== segments.length - 1;
  } catch {
    return true;
  }
});

async function load() {
  try {
    requestConfig.params.token = appState.state.userInfo?.token;
    const statusResult = await axios.get("./api/ai/status", requestConfig);
    status.value = statusResult.data?.data || status.value;
    if (!hasAiAccess.value) return;
    const [conversationResult, queueResult] = await Promise.all([
      axios.get("./api/ai/conversations", requestConfig),
      axios.get("./api/ai/queue", requestConfig)
    ]);
    conversations.value = conversationResult.data?.data || [];
    queue.value = queueResult.data?.data || queue.value;
    // Opened from a scheduled task: show that report.
    const requested = String(route.query.conversation || "");
    if (
      !activeConversation.value &&
      requested &&
      conversations.value.some((c) => c.uuid === requested)
    ) {
      await openConversation(requested);
    } else if (!activeConversation.value && routeScope.value) {
      const scoped = conversations.value.find(isRouteScope);
      if (scoped) await openConversation(scoped.uuid);
      else await createConversation();
    } else if (!activeConversation.value && conversations.value.length > 0) {
      await openConversation(conversations.value[0].uuid);
    } else if (!initialConversationLoaded && conversations.value.length === 0) {
      initialConversationLoaded = true;
      await createConversation();
    }
    initialConversationLoaded = true;
  } catch (err: any) {
    error.value = err?.response?.data?.data || err?.message || "Unable to load AI";
  }
}

async function refreshQueue() {
  if (!hasAiAccess.value) return;
  try {
    const result = await axios.get("./api/ai/queue", requestConfig);
    queue.value = result.data?.data || queue.value;
  } catch (err: any) {
    error.value = err?.response?.data?.data || err?.message || "Unable to refresh AI queue";
  }
}

async function openConversation(uuid: string) {
  try {
    const result = await axios.get(
      `./api/ai/conversations/${encodeURIComponent(uuid)}`,
      requestConfig
    );
    activeConversation.value = result.data?.data || null;
  } catch (err: any) {
    error.value = err?.response?.data?.data || "Unable to open conversation";
  }
}

async function createConversation(): Promise<boolean> {
  try {
    const body = routeScope.value
      ? {
          title: "New conversation",
          daemonId: routeScope.value.daemonId,
          instanceUuid: routeScope.value.instanceUuid
        }
      : { title: "New conversation" };
    const result = await axios.post("./api/ai/conversations", body, requestConfig);
    const conversation = result.data?.data;
    if (conversation) {
      conversations.value.unshift(conversation);
      await openConversation(conversation.uuid);
      return activeConversation.value?.uuid === conversation.uuid;
    }
    error.value = "The server did not create a conversation.";
  } catch (err: any) {
    error.value = err?.response?.data?.data || "Unable to create conversation";
  }
  return false;
}

async function renameConversation() {
  if (!activeConversation.value) return;
  const title = window.prompt("Conversation name", activeConversation.value.title);
  if (!title) return;
  await axios.put(
    `./api/ai/conversations/${encodeURIComponent(activeConversation.value.uuid)}`,
    { title },
    requestConfig
  );
  await load();
  await openConversation(activeConversation.value.uuid);
}

async function deleteConversation() {
  if (!activeConversation.value) return;
  await axios.delete(
    `./api/ai/conversations/${encodeURIComponent(activeConversation.value.uuid)}`,
    requestConfig
  );
  activeConversation.value = null;
  await load();
}

async function send() {
  if (!prompt.value.trim() || busy.value) return;
  busy.value = true;
  error.value = "";
  const content = prompt.value.trim();
  prompt.value = "";
  try {
    if (!activeConversation.value && !(await createConversation())) {
      busy.value = false;
      return;
    }
    if (!activeConversation.value) {
      throw new Error("Select or create a conversation before sending a message.");
    }
    activeConversation.value.messages.push({
      id: `local-${Date.now()}`,
      role: "user",
      content,
      createdAt: new Date().toISOString()
    });
    const result = await axios.post(
      `./api/ai/conversations/${encodeURIComponent(activeConversation.value.uuid)}/generate`,
      { content },
      requestConfig
    );
    activeRequest.value = result.data?.data || null;
  } catch (err: any) {
    error.value = err?.response?.data?.data || err?.message || "AI generation failed";
  } finally {
    busy.value = false;
  }
}

async function refreshRequest() {
  if (!hasAiAccess.value) return;
  if (!activeRequest.value) return;
  try {
    const result = await axios.get(
      `./api/ai/requests/${encodeURIComponent(activeRequest.value.uuid)}`,
      requestConfig
    );
    activeRequest.value = result.data?.data || activeRequest.value;
    const request = activeRequest.value;
    const requestState = request?.state;
    if (requestState && ["completed", "failed", "cancelled", "timeout"].includes(requestState)) {
      busy.value = false;
      if (requestState === "failed" || requestState === "timeout") {
        error.value =
          request.errorCode === "timeout"
            ? "The AI request timed out. Check that the local model is loaded and try again."
            : "The AI engine could not complete this request. Check the panel logs and LM Studio connection.";
      }
      if (activeConversation.value) await openConversation(activeConversation.value.uuid);
    }
  } catch {
    busy.value = false;
  }
  await refreshQueue();
}

async function cancelRequest() {
  if (!activeRequest.value) return;
  await axios.post(
    `./api/ai/requests/${encodeURIComponent(activeRequest.value.uuid)}/cancel`,
    {},
    requestConfig
  );
  await refreshRequest();
}

// Edited as text (one command per line) so typing is not reformatted.
const allowlistText = ref("");
const syncAllowlistText = () => {
  allowlistText.value = (config.value?.consoleCommandAllowlist || []).join("\n");
};

async function loadAdminConfig() {
  if (!isAdmin.value) return;
  const result = await axios.get("./api/ai/config", requestConfig);
  config.value = result.data?.data || null;
  syncAllowlistText();
}

async function saveAdminConfig() {
  if (!config.value || invalidEngineUrl.value) return;
  try {
    config.value.consoleCommandAllowlist = allowlistText.value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const result = await axios.put("./api/ai/config", config.value, requestConfig);
    config.value = result.data?.data || config.value;
    syncAllowlistText();
    await load();
    error.value = "";
  } catch (err: any) {
    error.value = err?.response?.data?.data || err?.message || "Unable to save AI configuration";
  }
}

function renderMarkdown(content: string) {
  return sanitizeHtml(String(marked.parse(content)), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["h1", "h2", "h3", "img"]),
    allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, code: ["class"] }
  });
}

onMounted(() => {
  void load();
  void loadAdminConfig();
  timer = window.setInterval(() => {
    void refreshRequest();
    void refreshQueue();
  }, 3000);
});

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer);
});
</script>

<template>
  <main class="ai-page">
    <section v-if="!hasAiAccess" class="ai-access-request">
      <a-card :title="t('TXT_CODE_ai_access_title')" style="max-width: 640px; margin: 48px auto">
        <AiAccessRequest :access="aiAccess" @requested="load" />
      </a-card>
    </section>
    <template v-else>
      <section class="ai-sidebar">
        <div class="ai-sidebar-header">
          <strong>Local AI</strong>
          <a-button type="primary" size="small" @click="createConversation">New</a-button>
        </div>
        <button
          v-for="conversation in conversations"
          :key="conversation.uuid"
          class="conversation"
          :class="{ active: activeConversation?.uuid === conversation.uuid }"
          @click="openConversation(conversation.uuid)"
        >
          <span v-if="conversation.kind === 'report'" class="scope-tag report-tag">
            {{ t("TXT_CODE_ai_report_tag") }}
          </span>
          <span v-else-if="conversation.instanceScope" class="scope-tag">Instance</span>
          {{ conversation.title }}
        </button>
        <p class="empty-conversations">
          Conversations are deleted automatically
          {{ status.conversationRetentionMinutes || 120 }} min after their last message.
          {{ t("TXT_CODE_ai_report_retention", { days: status.reportRetentionDays || 7 }) }}
        </p>
        <p v-if="conversations.length === 0" class="empty-conversations">
          No conversations yet. Select <strong>New</strong> to start one.
        </p>
      </section>

      <section class="ai-chat">
        <header class="ai-header">
          <div>
            <strong>{{ status.model || "Local model" }}</strong>
            <span :class="['status', status.state]">{{ status.state }}</span>
            <span v-if="activeConversation?.instanceScope" class="scope-banner">
              Instance: {{ scopeLabel }} · the assistant can read files and propose edits you confirm
            </span>
          </div>
          <div v-if="activeConversation" class="chat-actions">
            <a-button size="small" @click="renameConversation">Rename</a-button>
            <a-button size="small" danger @click="deleteConversation">Delete</a-button>
          </div>
        </header>

        <div class="queue-status">
          <span>Waiting requests (all users): {{ queue.pending }}</span>
          <span v-if="queue.processing && !queue.current">Model busy</span>
          <span v-else-if="queue.current">Your request is processing</span>
          <span v-if="activeRequest">State: {{ activeRequest.state }}</span>
          <span v-if="activeRequest?.position">Position: {{ activeRequest.position }}</span>
          <a-button
            v-if="activeRequest && ['queued', 'processing'].includes(activeRequest.state)"
            size="small"
            danger
            @click="cancelRequest"
          >
            Cancel
          </a-button>
        </div>

        <div class="messages">
          <div v-if="error" class="error">{{ error }}</div>
          <article
            v-for="message in activeConversation?.messages || []"
            :key="message.id"
            :class="['message', message.role]"
          >
            <div v-if="message.role === 'assistant'" v-html="renderMarkdown(message.content)" />
            <div v-else>{{ message.content }}</div>
          </article>
        </div>

        <form class="composer" @submit.prevent="send">
          <a-textarea
            v-model:value="prompt"
            :rows="3"
            :disabled="busy"
            placeholder="Ask the local AI..."
          />
          <a-button type="primary" html-type="submit" :loading="busy" :disabled="!prompt.trim()">
            Send
          </a-button>
        </form>
      </section>

      <section v-if="isAdmin && config" class="ai-admin">
        <strong>AI configuration</strong>
        <label><span>Enabled</span><a-switch v-model:checked="config.enabled" /></label>
        <label>
          <span>Engine URL</span>
          <a-input v-model:value="config.baseUrl" placeholder="http://127.0.0.1:1234/v1" />
        </label>
        <small>LM Studio: use the API address ending in /v1. Do not append the model name. The model is
          contacted only when you send a message.</small>
        <small v-if="invalidEngineUrl" class="error">
          Remove the model path from this URL. Put it in the Model field below.
        </small>
        <label>
          <span>Model ID</span>
          <a-input v-model:value="config.model" placeholder="openai/gpt-oss-20b" />
        </label>
        <label><span>Temperature</span><a-input-number v-model:value="config.temperature" :min="0" :max="2" /></label>
        <label><span>Max tokens</span><a-input-number v-model:value="config.maxTokens" :min="64" :max="32768" /></label>
        <label><span>Timeout ms</span><a-input-number v-model:value="config.timeoutMs" :min="1000" :max="900000" /></label>
        <label><span>Queue capacity</span><a-input-number v-model:value="config.queueCapacity" :min="1" :max="500" /></label>
        <label>
          <span>History (min)</span>
          <a-input-number
            v-model:value="config.conversationRetentionMinutes"
            :min="10"
            :max="10080"
          />
        </label>
        <label>
          <span>{{ t("TXT_CODE_ai_report_retention_days") }}</span>
          <a-input-number v-model:value="config.reportRetentionDays" :min="1" :max="90" />
        </label>
        <label>
          <span>{{ t("TXT_CODE_ai_vision_enabled") }}</span>
          <a-switch v-model:checked="config.visionEnabled" />
        </label>
        <label class="ai-allowlist">
          <span>{{ t("TXT_CODE_ai_console_allowlist") }}</span>
          <a-textarea v-model:value="allowlistText" :rows="5" />
          <small>{{ t("TXT_CODE_ai_console_allowlist_help") }}</small>
        </label>
        <a-button type="primary" :disabled="invalidEngineUrl" @click="saveAdminConfig">Save</a-button>
      </section>
    </template>
  </main>
</template>

<style scoped lang="scss">
.ai-page {
  display: grid;
  grid-template-columns: 220px minmax(320px, 1fr) 260px;
  min-height: calc(100vh - 100px);
  gap: 12px;
  padding: 12px;
}
.ai-sidebar,
.ai-chat,
.ai-admin {
  border: 1px solid var(--color-gray-5);
  border-radius: 8px;
  background: var(--color-gray-1);
}
.ai-sidebar,
.ai-admin {
  padding: 12px;
}
.ai-sidebar-header,
.ai-header,
.queue-status,
.chat-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.conversation {
  display: block;
  width: 100%;
  border: 0;
  background: transparent;
  padding: 8px;
  text-align: left;
  cursor: pointer;
}
.conversation.active {
  background: var(--color-gray-4);
  border-radius: 6px;
}
.scope-tag {
  font-size: 11px;
  padding: 0 4px;
  margin-right: 4px;
  border-radius: 4px;
  background: var(--color-gray-5);
}
.report-tag {
  background: #722ed1;
  color: #fff;
}
.scope-banner {
  margin-left: 8px;
  font-size: 12px;
  color: var(--color-gray-8);
}
.empty-conversations {
  padding: 8px;
  color: var(--color-gray-7);
  font-size: 12px;
}
.ai-chat {
  display: grid;
  grid-template-rows: auto auto 1fr auto;
  min-height: 600px;
}
.ai-header,
.queue-status {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-gray-5);
}
.status.connected {
  color: #52c41a;
}
.status.error {
  color: #f5222d;
}
.messages {
  overflow: auto;
  padding: 12px;
}
.message {
  max-width: 82%;
  margin: 8px 0;
  padding: 10px 12px;
  border-radius: 8px;
}
.message.user {
  margin-left: auto;
  background: #1677ff;
  color: white;
}
.message.assistant {
  background: var(--color-gray-4);
}
.composer {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--color-gray-5);
}
.error {
  color: #f5222d;
}
.ai-admin {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ai-admin label {
  display: grid;
  grid-template-columns: 100px 1fr;
  align-items: center;
}
@media (max-width: 1100px) {
  .ai-page {
    grid-template-columns: 180px 1fr;
  }
  .ai-admin {
    display: none;
  }
}
@media (max-width: 700px) {
  .ai-page {
    grid-template-columns: 1fr;
  }
  .ai-sidebar {
    max-height: 160px;
    overflow: auto;
  }
}
</style>
