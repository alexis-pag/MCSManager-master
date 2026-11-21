<script setup lang="ts">
import { formatScheduleTime } from "@/hooks/useSchedule";
import { t } from "@/lang/i18n";
import { useAppStateStore } from "@/stores/useAppStateStore";
import { reportErrorMsg } from "@/tools/validator";
import type { AiAccessView, AutomationRequest } from "@/types";
import {
  AiScheduleKindLabel,
  ScheduleActionType,
  ScheduleCreateType,
  ScheduleType
} from "@/types/const";
import { BellOutlined } from "@ant-design/icons-vue";
import { message } from "ant-design-vue";
import axios from "axios";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

interface AiAccessRecord extends AiAccessView {
  userUuid: string;
  userName: string;
  reason: string;
}

type Decision = "approve" | "refuse" | "grant" | "revoke";

interface PendingDecision {
  target: "automation" | "ai-access";
  id: string;
  decision: Decision;
  subject: string;
}

const REFRESH_MS = 30000;

const appState = useAppStateStore();
const open = ref(false);
const activeTab = ref("automations");
const summary = ref({ aiAccess: 0, automations: 0 });
const automations = ref<AutomationRequest[]>([]);
const accessRecords = ref<AiAccessRecord[]>([]);
const loading = ref(false);
const decision = ref<PendingDecision | null>(null);
const note = ref("");
const deciding = ref(false);
let timer: number | undefined;

const total = computed(() => summary.value.aiAccess + summary.value.automations);
const pendingAccess = computed(() => accessRecords.value.filter((r) => r.state === "pending"));
const grantedAccess = computed(() => accessRecords.value.filter((r) => r.state === "granted"));

const requestConfig = () => ({
  params: { token: appState.state.userInfo?.token },
  headers: { "X-Requested-With": "XMLHttpRequest" }
});

/** Badge count, refreshed every 30 seconds. */
async function loadSummary() {
  if (!appState.isAdmin.value) return;
  try {
    const result = await axios.get("./api/approvals/summary", requestConfig());
    summary.value = result.data?.data || summary.value;
  } catch (err) {
    // Keep the previous badge when a refresh fails (panel restarting, network).
    console.error(err);
  }
}

/** Request details, loaded when the drawer is opened and after each decision. */
async function loadRequests() {
  loading.value = true;
  try {
    const result = await axios.get("./api/approvals", requestConfig());
    automations.value = result.data?.data?.automations || [];
    accessRecords.value = result.data?.data?.aiAccess || [];
  } catch (err: any) {
    reportErrorMsg(err?.response?.data?.data || err?.message);
  } finally {
    loading.value = false;
  }
}

async function openCenter() {
  open.value = true;
  await Promise.all([loadRequests(), loadSummary()]);
}

const decisionLabel: Record<Decision, string> = {
  approve: t("TXT_CODE_approval_approve"),
  refuse: t("TXT_CODE_approval_refuse"),
  grant: t("TXT_CODE_approval_grant"),
  revoke: t("TXT_CODE_approval_revoke")
};

function askDecision(pending: PendingDecision) {
  note.value = "";
  decision.value = pending;
}

async function confirmDecision() {
  const pending = decision.value;
  if (!pending) return;
  deciding.value = true;
  try {
    await axios.post(
      `./api/approvals/${pending.target}/${encodeURIComponent(pending.id)}`,
      { decision: pending.decision, note: note.value.trim() },
      requestConfig()
    );
    message.success(t("TXT_CODE_approval_done"));
    decision.value = null;
  } catch (err: any) {
    // A failed approval keeps the request pending; its error is shown on the card.
    reportErrorMsg(err?.response?.data?.data || err?.message);
  } finally {
    deciding.value = false;
    await Promise.all([loadRequests(), loadSummary()]);
  }
}

const triggerLabel = (request: AutomationRequest) => {
  const { type, time } = request.payload;
  if (type === ScheduleCreateType.ON_CRASH) return formatScheduleTime(type, time);
  const typeLabel = ScheduleType[type as keyof typeof ScheduleType] || "";
  return `${typeLabel} · ${formatScheduleTime(type, time)}`;
};

const actionsLabel = (request: AutomationRequest) =>
  (request.payload.actions || [])
    .map((action) => {
      const label = ScheduleActionType[action.type as keyof typeof ScheduleActionType] || action.type;
      return action.payload ? `${label}: ${action.payload}` : label;
    })
    .join(" → ");

const originLabel = (request: AutomationRequest) => {
  if (request.origin === "migration") return t("TXT_CODE_approval_origin_migration");
  if (request.replaces) return t("TXT_CODE_approval_origin_edit", { name: request.replaces });
  return t("TXT_CODE_approval_origin_new");
};

const formatDate = (value?: string) => (value ? new Date(value).toLocaleString() : "");

onMounted(() => {
  void loadSummary();
  timer = window.setInterval(() => void loadSummary(), REFRESH_MS);
});
onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer);
});
</script>

<template>
  <template v-if="appState.isAdmin.value">
    <a-tooltip placement="bottom" :title="t('TXT_CODE_approval_bell')">
      <button
        type="button"
        class="approval-bell"
        :aria-label="`${t('TXT_CODE_approval_bell')} (${total})`"
        @click="openCenter"
      >
        <a-badge :count="total" :overflow-count="99" size="small">
          <BellOutlined class="bell-icon" />
        </a-badge>
      </button>
    </a-tooltip>

    <a-drawer v-model:open="open" :width="640" :title="t('TXT_CODE_approval_title')">
      <a-spin :spinning="loading">
        <a-tabs v-model:active-key="activeTab">
          <a-tab-pane
            key="automations"
            :tab="t('TXT_CODE_approval_tab_automations', { count: automations.length })"
          >
            <a-empty v-if="!automations.length" :description="t('TXT_CODE_approval_empty')" />
            <a-card
              v-for="item in automations"
              :key="item.uuid"
              size="small"
              class="approval-card"
            >
              <template #title>
                <a-tag v-if="item.kind === 'ai_task'" color="purple">
                  {{ t("TXT_CODE_approval_ai_task") }}
                </a-tag>
                {{ item.name }}
              </template>
              <template #extra>
                <span class="muted">{{ originLabel(item) }}</span>
              </template>
              <a-descriptions :column="1" size="small">
                <a-descriptions-item :label="t('TXT_CODE_approval_requester')">
                  {{ item.requesterName || t("TXT_CODE_approval_unknown_requester") }}
                </a-descriptions-item>
                <a-descriptions-item :label="t('TXT_CODE_approval_instance')">
                  {{ item.instanceName || item.instanceUuid }}
                </a-descriptions-item>
                <a-descriptions-item :label="t('TXT_CODE_approval_trigger')">
                  {{ triggerLabel(item) }}
                </a-descriptions-item>
                <a-descriptions-item
                  v-if="item.kind === 'schedule'"
                  :label="t('TXT_CODE_approval_actions')"
                >
                  <span class="pre">{{ actionsLabel(item) }}</span>
                </a-descriptions-item>
                <template v-else>
                  <a-descriptions-item :label="t('TXT_CODE_approval_ai_task')">
                    {{ item.payload.kind ? AiScheduleKindLabel[item.payload.kind] : "" }}
                  </a-descriptions-item>
                  <a-descriptions-item
                    v-if="item.payload.prompt"
                    :label="t('TXT_CODE_approval_ai_instruction')"
                  >
                    <span class="pre">{{ item.payload.prompt }}</span>
                  </a-descriptions-item>
                </template>
                <a-descriptions-item :label="t('TXT_CODE_approval_requested_at')">
                  {{ formatDate(item.createdAt) }}
                </a-descriptions-item>
              </a-descriptions>
              <a-alert
                v-if="item.error"
                type="error"
                show-icon
                class="card-error"
                :message="t('TXT_CODE_approval_last_error', { error: item.error })"
              />
              <a-space>
                <a-button
                  type="primary"
                  @click="
                    askDecision({
                      target: 'automation',
                      id: item.uuid,
                      decision: 'approve',
                      subject: item.name
                    })
                  "
                >
                  {{ t("TXT_CODE_approval_approve") }}
                </a-button>
                <a-button
                  danger
                  @click="
                    askDecision({
                      target: 'automation',
                      id: item.uuid,
                      decision: 'refuse',
                      subject: item.name
                    })
                  "
                >
                  {{ t("TXT_CODE_approval_refuse") }}
                </a-button>
              </a-space>
            </a-card>
          </a-tab-pane>

          <a-tab-pane
            key="ai-access"
            :tab="t('TXT_CODE_approval_tab_ai_access', { count: pendingAccess.length })"
          >
            <a-empty v-if="!pendingAccess.length" :description="t('TXT_CODE_approval_empty')" />
            <a-card
              v-for="item in pendingAccess"
              :key="item.userUuid"
              size="small"
              class="approval-card"
              :title="item.userName"
            >
              <a-descriptions :column="1" size="small">
                <a-descriptions-item :label="t('TXT_CODE_approval_reason')">
                  <span class="pre">{{ item.reason }}</span>
                </a-descriptions-item>
                <a-descriptions-item :label="t('TXT_CODE_approval_requested_at')">
                  {{ formatDate(item.requestedAt) }}
                </a-descriptions-item>
              </a-descriptions>
              <a-space>
                <a-button
                  type="primary"
                  @click="
                    askDecision({
                      target: 'ai-access',
                      id: item.userUuid,
                      decision: 'grant',
                      subject: item.userName
                    })
                  "
                >
                  {{ t("TXT_CODE_approval_grant") }}
                </a-button>
                <a-button
                  danger
                  @click="
                    askDecision({
                      target: 'ai-access',
                      id: item.userUuid,
                      decision: 'refuse',
                      subject: item.userName
                    })
                  "
                >
                  {{ t("TXT_CODE_approval_refuse") }}
                </a-button>
              </a-space>
            </a-card>

            <a-divider orientation="left">{{ t("TXT_CODE_approval_granted_users") }}</a-divider>
            <p v-if="!grantedAccess.length" class="muted">
              {{ t("TXT_CODE_approval_none_granted") }}
            </p>
            <div v-for="item in grantedAccess" :key="item.userUuid" class="granted-row">
              <span>{{ item.userName }}</span>
              <a-button
                size="small"
                danger
                @click="
                  askDecision({
                    target: 'ai-access',
                    id: item.userUuid,
                    decision: 'revoke',
                    subject: item.userName
                  })
                "
              >
                {{ t("TXT_CODE_approval_revoke") }}
              </a-button>
            </div>
          </a-tab-pane>
        </a-tabs>
      </a-spin>
    </a-drawer>

    <a-modal
      :open="!!decision"
      :title="decision ? `${decisionLabel[decision.decision]} · ${decision.subject}` : ''"
      :ok-text="decision ? decisionLabel[decision.decision] : ''"
      :ok-button-props="{ danger: decision?.decision === 'refuse' || decision?.decision === 'revoke' }"
      :confirm-loading="deciding"
      @ok="confirmDecision"
      @cancel="decision = null"
    >
      <label for="approval-note">{{ t("TXT_CODE_approval_note") }}</label>
      <a-textarea id="approval-note" v-model:value="note" :rows="3" :maxlength="300" show-count />
    </a-modal>
  </template>
</template>

<style scoped>
.approval-bell {
  min-width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  background: none;
  border: none;
  color: inherit;
  padding: 0 8px;
}
.bell-icon {
  font-size: 18px;
  color: inherit;
}
.approval-card {
  margin-bottom: 12px;
}
.card-error {
  margin-bottom: 12px;
}
.muted {
  opacity: 0.65;
}
.pre {
  white-space: pre-wrap;
  word-break: break-word;
}
.granted-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 0;
}
</style>
