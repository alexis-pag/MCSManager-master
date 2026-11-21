<script setup lang="ts">
import AiAccessRequest from "@/components/AiAccessRequest.vue";
import { conversationLabel, useInstanceAiChat } from "@/hooks/useInstanceAiChat";
import { useScreen } from "@/hooks/useScreen";
import { t } from "@/lang/i18n";
import {
  DeleteOutlined,
  HistoryOutlined,
  MessageOutlined,
  PlusOutlined,
  RobotOutlined,
  SendOutlined
} from "@ant-design/icons-vue";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps<{
  daemonId: string;
  instanceId: string;
  instanceName?: string;
}>();

const open = ref(false);
const prompt = ref("");
const messagesBox = ref<HTMLElement>();
const { isPhone } = useScreen();

const chat = useInstanceAiChat(props.daemonId, props.instanceId);
const {
  conversation,
  history,
  retentionMinutes,
  request,
  loading,
  errorCode,
  errorDetail,
  access,
  needsAccess
} = chat;
const showHistory = ref(false);

// Refreshes the "deleted in ..." labels while the history is visible.
const now = ref(Date.now());
const clock = window.setInterval(() => (now.value = Date.now()), 30000);
onBeforeUnmount(() => window.clearInterval(clock));

/** "1 h 05" / "12 min" */
const formatDuration = (ms: number) => {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
};
const retentionLabel = computed(() => formatDuration(retentionMinutes.value * 60000));
const expiresIn = (expiresAt?: string) =>
  expiresAt ? formatDuration(Date.parse(expiresAt) - now.value) : retentionLabel.value;
const lastActivity = (updatedAt: string) =>
  new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const toggleHistory = async () => {
  showHistory.value = !showHistory.value;
  if (showHistory.value) {
    now.value = Date.now();
    await chat.loadHistory().catch(() => undefined);
  }
};

const openFromHistory = async (uuid: string) => {
  await chat.selectConversation(uuid);
  showHistory.value = false;
  await scrollToBottom();
};

const startConversation = async () => {
  await chat.newConversation();
  showHistory.value = false;
};

const busy = computed(() => chat.isBusy());
const waiting = computed(
  () => !!request.value && ["queued", "processing"].includes(request.value.state)
);
const errorText = computed(() => {
  switch (errorCode.value) {
    case "disabled":
      return t("TXT_CODE_ai_disabled");
    case "timeout":
      return t("TXT_CODE_ai_error_timeout");
    case "engine":
      return t("TXT_CODE_ai_error_engine");
    case "load":
    case "send":
      return t("TXT_CODE_ai_error_request");
    default:
      return "";
  }
});

const renderMarkdown = (content: string) =>
  sanitizeHtml(String(marked.parse(content)), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["h1", "h2", "h3"]),
    allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, code: ["class"] }
  });

const scrollToBottom = async () => {
  await nextTick();
  if (messagesBox.value) messagesBox.value.scrollTop = messagesBox.value.scrollHeight;
};

watch(() => conversation.value?.messages.length, scrollToBottom);

const openDialog = async () => {
  open.value = true;
  await chat.open();
  await scrollToBottom();
};

const close = () => {
  open.value = false;
};

const send = async () => {
  const text = prompt.value;
  if (!text.trim() || busy.value) return;
  prompt.value = "";
  if (!(await chat.send(text))) prompt.value = text;
};

const onKeydown = (event: KeyboardEvent) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
};

defineExpose({ openDialog });
</script>

<template>
  <a-drawer
    :open="open"
    placement="right"
    :width="isPhone ? '100%' : 460"
    :mask="false"
    :body-style="{ padding: 0, display: 'flex', flexDirection: 'column' }"
    class="instance-ai-drawer"
    @close="close"
  >
    <template #title>
      <span class="drawer-title">
        <RobotOutlined />
        {{ t("TXT_CODE_ai_instance_assistant") }}
        <span v-if="instanceName" class="instance-name">· {{ instanceName }}</span>
      </span>
    </template>
    <template #extra>
      <a-space v-if="!needsAccess" :size="4">
        <a-tooltip :title="t('TXT_CODE_ai_history')">
          <a-button
            size="small"
            :type="showHistory ? 'primary' : 'default'"
            :disabled="loading"
            @click="toggleHistory"
          >
            <HistoryOutlined />
          </a-button>
        </a-tooltip>
        <a-tooltip :title="t('TXT_CODE_ai_new_conversation')">
          <a-button size="small" :disabled="busy || loading" @click="startConversation">
            <PlusOutlined />
          </a-button>
        </a-tooltip>
      </a-space>
    </template>

    <div v-if="needsAccess" class="access">
      <AiAccessRequest :access="access" @requested="chat.open()" />
    </div>

    <div v-else-if="showHistory" class="history">
      <p class="hint">{{ t("TXT_CODE_ai_history_retention", { duration: retentionLabel }) }}</p>
      <p v-if="!history.length" class="hint">{{ t("TXT_CODE_ai_history_empty") }}</p>
      <div
        v-for="item in history"
        :key="item.uuid"
        :class="['history-item', { active: item.uuid === conversation?.uuid }]"
      >
        <button
          type="button"
          class="history-open"
          :disabled="busy && item.uuid !== conversation?.uuid"
          @click="openFromHistory(item.uuid)"
        >
          <MessageOutlined />
          <span class="history-text">
            <span class="history-label">
              <a-tag v-if="item.kind === 'report'" color="purple" class="report-tag">
                {{ t("TXT_CODE_ai_report_tag") }}
              </a-tag>
              {{
                item.kind === "report"
                  ? item.title
                  : conversationLabel(item) || t("TXT_CODE_ai_new_conversation")
              }}
            </span>
            <span class="history-meta">
              {{ lastActivity(item.updatedAt) }} ·
              {{ t("TXT_CODE_ai_history_expires", { duration: expiresIn(item.expiresAt) }) }}
            </span>
          </span>
        </button>
        <a-popconfirm
          :title="t('TXT_CODE_ai_history_delete_confirm')"
          @confirm="chat.deleteConversation(item.uuid)"
        >
          <a-button
            type="text"
            size="small"
            danger
            :disabled="busy && item.uuid === conversation?.uuid"
            :aria-label="t('TXT_CODE_ai_history_delete')"
          >
            <DeleteOutlined />
          </a-button>
        </a-popconfirm>
      </div>
    </div>

    <div v-else ref="messagesBox" class="messages">
      <a-spin v-if="loading" class="loading" />
      <p v-else-if="!conversation?.messages.length && !errorText" class="hint">
        {{ t("TXT_CODE_ai_instance_hint") }}
      </p>
      <article
        v-for="message in conversation?.messages || []"
        :key="message.id"
        :class="['message', message.role]"
      >
        <!-- eslint-disable-next-line vue/no-v-html -- sanitized with sanitize-html -->
        <div v-if="message.role === 'assistant'" v-html="renderMarkdown(message.content)" />
        <div v-else class="plain">{{ message.content }}</div>
      </article>
      <div v-if="waiting" class="message assistant pending">
        <a-spin size="small" />
        <span v-if="request?.state === 'queued' && request.position > 0">
          {{ t("TXT_CODE_ai_queue_position", { position: request.position }) }}
        </span>
        <span v-else>{{ t("TXT_CODE_ai_thinking") }}</span>
        <a-button type="link" size="small" danger @click="chat.cancel">
          {{ t("TXT_CODE_ai_cancel") }}
        </a-button>
      </div>
      <a-alert
        v-if="errorText"
        type="error"
        :message="errorText"
        :description="errorDetail || undefined"
        show-icon
        class="error"
      />
    </div>

    <form v-if="!showHistory && !needsAccess" class="composer" @submit.prevent="send">
      <a-textarea
        v-model:value="prompt"
        :auto-size="{ minRows: 2, maxRows: 6 }"
        :disabled="loading || errorCode === 'disabled'"
        :placeholder="t('TXT_CODE_ai_instance_placeholder')"
        @keydown="onKeydown"
      />
      <a-button
        type="primary"
        html-type="submit"
        :loading="busy"
        :disabled="!prompt.trim() || loading || errorCode === 'disabled'"
      >
        <template #icon><SendOutlined /></template>
      </a-button>
    </form>
  </a-drawer>
</template>

<style lang="scss" scoped>
.drawer-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.instance-name {
  color: var(--color-gray-7);
  font-weight: normal;
}
.access {
  padding: 16px;
}

.history {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}
.history-item {
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: 8px;
  margin-bottom: 4px;
  &.active {
    background: var(--color-gray-4);
  }
  &:hover {
    background: var(--color-gray-3);
  }
}
.history-open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
  color: inherit;
  &:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
}
.history-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.history-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.report-tag {
  margin-right: 4px;
}
.history-meta {
  font-size: 12px;
  color: var(--color-gray-7);
}
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}
.loading {
  display: block;
  margin: 24px auto;
}
.hint {
  color: var(--color-gray-7);
  font-size: 13px;
}
.message {
  max-width: 90%;
  margin: 8px 0;
  padding: 8px 12px;
  border-radius: 8px;
  overflow-wrap: anywhere;
  :deep(pre) {
    white-space: pre-wrap;
    font-size: 12px;
  }
  :deep(p:last-child) {
    margin-bottom: 0;
  }
}
.message.user {
  margin-left: auto;
  background: #1677ff;
  color: #fff;
}
.message.assistant {
  background: var(--color-gray-4);
}
.plain {
  white-space: pre-wrap;
}
.pending {
  display: flex;
  align-items: center;
  gap: 8px;
}
.error {
  margin-top: 8px;
}
.composer {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: end;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--color-gray-5);
}
</style>
