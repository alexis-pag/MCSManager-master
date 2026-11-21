<script setup lang="ts">
import {
  BAN_DESCRIPTION_MIN,
  BAN_IMAGE_TYPES,
  BAN_MAX_IMAGE_BYTES,
  BAN_MAX_IMAGES,
  BAN_REASON_MIN,
  banFormProblem,
  useAiBan,
  type AiBanCase,
  type BanRequestForm
} from "@/hooks/useAiBan";
import { t } from "@/lang/i18n";
import { useAppStateStore } from "@/stores/useAppStateStore";
import { SearchOutlined, StopOutlined, UploadOutlined } from "@ant-design/icons-vue";
import { message } from "ant-design-vue";
import { computed, reactive, ref, watch } from "vue";

const props = defineProps<{ daemonId: string; instanceId: string }>();

const { isAdmin } = useAppStateStore();
const ban = useAiBan(props.daemonId, props.instanceId);
const { cases, current, logLines, busy, error } = ban;

const open = ref(false);
const tab = ref<"new" | "history">("new");
const overrideNote = ref("");
const evidenceImages = ref<string[]>([]);
const form = reactive<BanRequestForm>({
  player: "",
  reason: "",
  description: "",
  logLines: [],
  images: []
});

const resetForm = () => {
  Object.assign(form, { player: "", reason: "", description: "", logLines: [], images: [] });
  logLines.value = [];
  overrideNote.value = "";
};

const openDialog = async () => {
  open.value = true;
  tab.value = "new";
  current.value = null;
  resetForm();
  await ban.loadCases();
};

const close = () => {
  open.value = false;
  ban.stopPolling();
};

// Panel error codes -> readable messages.
const ERRORS: Record<string, string> = {
  "Reason length": "TXT_CODE_ban_error_reason",
  "Reason not meaningful": "TXT_CODE_ban_error_reason",
  "Evidence required": "TXT_CODE_ban_error_evidence",
  "Invalid player name": "TXT_CODE_ban_error_player",
  "Review in progress": "TXT_CODE_ban_error_pending",
  "Instance is not running": "TXT_CODE_ban_error_not_running",
  "Ban not justified": "TXT_CODE_ban_error_not_justified",
  "Override note required": "TXT_CODE_ban_error_override",
  "Local AI is disabled": "TXT_CODE_ai_disabled",
  "Only Minecraft Java servers are supported": "TXT_CODE_ban_error_java"
};
const errorText = computed(() => {
  const key = Object.keys(ERRORS).find((code) => error.value.includes(code));
  return key ? t(ERRORS[key]) : error.value;
});

const problem = computed(() => banFormProblem(form));
const problemText = computed(
  () =>
    ({
      player: t("TXT_CODE_ban_error_player"),
      reason: t("TXT_CODE_ban_error_reason"),
      evidence: t("TXT_CODE_ban_error_evidence"),
      "": ""
    })[problem.value]
);

const searchLogs = async () => {
  if (banFormProblem({ ...form, reason: "x".repeat(BAN_REASON_MIN) }) === "player") {
    return message.warning(t("TXT_CODE_ban_error_player"));
  }
  const lines = await ban.findLogLines(form.player.trim());
  form.logLines = form.logLines.filter((line) => lines?.includes(line));
  if (lines && !lines.length) message.info(t("TXT_CODE_ban_no_log_lines"));
};

const readImage = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

const beforeUpload = async (file: File) => {
  if (form.images.length >= BAN_MAX_IMAGES) {
    message.warning(t("TXT_CODE_ban_error_images", { max: BAN_MAX_IMAGES }));
  } else if (!BAN_IMAGE_TYPES.includes(file.type) || file.size > BAN_MAX_IMAGE_BYTES) {
    message.warning(t("TXT_CODE_ban_error_image_type"));
  } else {
    form.images.push(await readImage(file));
  }
  return false;
};

const submit = async () => {
  if (problem.value) return message.warning(problemText.value);
  const created = await ban.submit(form);
  if (created) resetForm();
};

const apply = async (note?: string) => {
  const result = await ban.apply(note);
  if (result?.state === "applied") message.success(t("TXT_CODE_ban_applied"));
};

const backToForm = () => {
  ban.stopPolling();
  current.value = null;
};

const openCase = (banCase: AiBanCase) => {
  ban.watchCase(banCase);
  tab.value = "new";
};

// Evidence thumbnails of the displayed case (fetched with the API credentials).
watch(
  () => current.value?.uuid,
  async () => {
    evidenceImages.value.forEach((url) => URL.revokeObjectURL(url));
    evidenceImages.value = [];
    const banCase = current.value;
    if (!banCase?.images?.length) return;
    for (const image of banCase.images) {
      try {
        evidenceImages.value.push(await ban.evidenceUrl(banCase, image.id));
      } catch {
        // image unavailable
      }
    }
  }
);

const VERDICT_COLORS: Record<string, string> = {
  justified: "red",
  not_justified: "green",
  insufficient_evidence: "orange",
  applied: "purple",
  failed: "default",
  reviewing: "blue"
};
const stateLabel = (state: string) => t(`TXT_CODE_ban_state_${state}`);
const canApply = computed(() => current.value?.state === "justified");
const canOverride = computed(
  () =>
    isAdmin.value &&
    !!current.value &&
    ["not_justified", "insufficient_evidence", "failed"].includes(current.value.state)
);
const formatDate = (value: string) =>
  value ? new Date(value).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "";

defineExpose({ openDialog });
</script>

<template>
  <a-modal
    :open="open"
    :title="t('TXT_CODE_ban_title')"
    :footer="null"
    width="760px"
    :mask-closable="false"
    destroy-on-close
    @cancel="close"
  >
    <a-tabs v-model:active-key="tab">
      <a-tab-pane key="new" :tab="current ? t('TXT_CODE_ban_tab_case') : t('TXT_CODE_ban_tab_new')">
        <!-- Case being reviewed or opened from the history -->
        <div v-if="current" class="case">
          <a-descriptions size="small" :column="1" bordered>
            <a-descriptions-item :label="t('TXT_CODE_ban_player')">
              {{ current.player }}
            </a-descriptions-item>
            <a-descriptions-item :label="t('TXT_CODE_ban_reason')">
              {{ current.reason }}
            </a-descriptions-item>
            <a-descriptions-item :label="t('TXT_CODE_ban_requester')">
              {{ current.requesterName }} · {{ formatDate(current.createdAt) }}
            </a-descriptions-item>
          </a-descriptions>

          <div v-if="current.state === 'reviewing'" class="reviewing">
            <a-spin size="small" /> {{ t("TXT_CODE_ban_reviewing") }}
          </div>
          <a-alert
            v-else
            class="mt-12"
            :type="
              current.state === 'justified' || current.state === 'applied' ? 'warning' : 'info'
            "
            show-icon
          >
            <template #message>
              <a-tag :color="VERDICT_COLORS[current.state]">{{ stateLabel(current.state) }}</a-tag>
              <span v-if="current.sanction && current.sanction !== 'none'">
                {{ t("TXT_CODE_ban_sanction") }} : {{ current.sanction }}
              </span>
            </template>
            <template #description>
              <p class="pre">{{ current.explanation }}</p>
              <p v-if="current.state === 'applied'" class="mb-0">
                {{ t("TXT_CODE_ban_applied_by", { name: current.appliedByName }) }}
                {{ formatDate(current.appliedAt) }}
                <span v-if="current.overrideNote">
                  — {{ t("TXT_CODE_ban_override_note") }} : {{ current.overrideNote }}
                </span>
              </p>
            </template>
          </a-alert>

          <div v-if="current.logLines.length" class="mt-12">
            <a-typography-text strong>{{ t("TXT_CODE_ban_log_evidence") }}</a-typography-text>
            <pre class="log">{{ current.logLines.join("\n") }}</pre>
          </div>
          <p v-if="current.description" class="pre mt-12">{{ current.description }}</p>
          <a-image-preview-group v-if="evidenceImages.length">
            <a-space class="mt-12">
              <a-image v-for="url in evidenceImages" :key="url" :src="url" :width="120" />
            </a-space>
          </a-image-preview-group>

          <div class="actions">
            <a-popconfirm
              v-if="canApply"
              :title="t('TXT_CODE_ban_apply_confirm', { player: current.player })"
              @confirm="apply()"
            >
              <a-button type="primary" danger :loading="busy">
                <StopOutlined /> {{ t("TXT_CODE_ban_apply") }}
              </a-button>
            </a-popconfirm>
            <a-button @click="backToForm">{{ t("TXT_CODE_ban_new_request") }}</a-button>
          </div>

          <div v-if="canOverride" class="override">
            <a-typography-text strong>{{ t("TXT_CODE_ban_override_title") }}</a-typography-text>
            <a-textarea
              v-model:value="overrideNote"
              :maxlength="500"
              show-count
              :placeholder="t('TXT_CODE_ban_override_placeholder')"
            />
            <a-popconfirm
              :title="t('TXT_CODE_ban_apply_confirm', { player: current.player })"
              :disabled="overrideNote.trim().length < 15"
              @confirm="apply(overrideNote.trim())"
            >
              <a-button danger :disabled="overrideNote.trim().length < 15" :loading="busy">
                {{ t("TXT_CODE_ban_override") }}
              </a-button>
            </a-popconfirm>
          </div>
        </div>

        <!-- New request -->
        <a-form v-else layout="vertical">
          <a-alert type="info" show-icon class="mb-12" :message="t('TXT_CODE_ban_intro')" />
          <a-form-item :label="t('TXT_CODE_ban_player')" required>
            <a-input-search
              v-model:value="form.player"
              :maxlength="16"
              :placeholder="t('TXT_CODE_ban_player_placeholder')"
              @search="searchLogs"
            >
              <template #enterButton>
                <a-button><SearchOutlined /> {{ t("TXT_CODE_ban_search_logs") }}</a-button>
              </template>
            </a-input-search>
          </a-form-item>
          <a-form-item :label="t('TXT_CODE_ban_reason')" required>
            <a-textarea
              v-model:value="form.reason"
              :maxlength="200"
              show-count
              :auto-size="{ minRows: 2, maxRows: 4 }"
              :placeholder="t('TXT_CODE_ban_reason_placeholder', { min: BAN_REASON_MIN })"
            />
          </a-form-item>
          <a-form-item
            :label="t('TXT_CODE_ban_evidence')"
            required
            :help="t('TXT_CODE_ban_evidence_help')"
          >
            <a-checkbox-group v-if="logLines.length" v-model:value="form.logLines" class="lines">
              <a-checkbox v-for="line in logLines" :key="line" :value="line" class="line">
                <code>{{ line }}</code>
              </a-checkbox>
            </a-checkbox-group>
            <a-textarea
              v-model:value="form.description"
              class="mt-8"
              :maxlength="2000"
              show-count
              :auto-size="{ minRows: 3, maxRows: 6 }"
              :placeholder="t('TXT_CODE_ban_description_placeholder', { min: BAN_DESCRIPTION_MIN })"
            />
            <a-space class="mt-8" wrap>
              <a-upload
                :show-upload-list="false"
                accept="image/png,image/jpeg,image/webp"
                :before-upload="beforeUpload"
              >
                <a-button :disabled="form.images.length >= BAN_MAX_IMAGES">
                  <UploadOutlined />
                  {{
                    t("TXT_CODE_ban_add_screenshot", {
                      count: form.images.length,
                      max: BAN_MAX_IMAGES
                    })
                  }}
                </a-button>
              </a-upload>
              <a-tag
                v-for="(image, index) in form.images"
                :key="index"
                closable
                @close="form.images.splice(index, 1)"
              >
                {{ t("TXT_CODE_ban_screenshot", { index: index + 1 }) }}
              </a-tag>
            </a-space>
          </a-form-item>
          <a-button type="primary" :loading="busy" :disabled="!!problem" @click="submit">
            {{ t("TXT_CODE_ban_submit") }}
          </a-button>
          <a-typography-text v-if="problem" type="secondary" class="ml-8">
            {{ problemText }}
          </a-typography-text>
        </a-form>

        <a-alert v-if="error" class="mt-12" type="error" show-icon :message="errorText" />
      </a-tab-pane>

      <a-tab-pane key="history" :tab="t('TXT_CODE_ban_tab_history')">
        <a-empty v-if="!cases.length" />
        <a-list v-else size="small" :data-source="cases">
          <template #renderItem="{ item }">
            <a-list-item>
              <a-list-item-meta>
                <template #title>
                  <a @click="openCase(item)">{{ item.player }}</a>
                  <a-tag class="ml-8" :color="VERDICT_COLORS[item.state]">
                    {{ stateLabel(item.state) }}
                  </a-tag>
                </template>
                <template #description>
                  {{ item.reason }} — {{ item.requesterName }}, {{ formatDate(item.createdAt) }}
                </template>
              </a-list-item-meta>
            </a-list-item>
          </template>
        </a-list>
      </a-tab-pane>
    </a-tabs>
  </a-modal>
</template>

<style lang="scss" scoped>
.reviewing {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
.pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.log {
  max-height: 180px;
  overflow: auto;
  font-size: 12px;
  white-space: pre-wrap;
  background: var(--color-gray-3);
  padding: 8px;
  border-radius: 6px;
}
.lines {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 200px;
  overflow: auto;
  .line {
    margin-left: 0;
    code {
      font-size: 12px;
      overflow-wrap: anywhere;
    }
  }
}
.actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}
.override {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--color-gray-5);
}
.mt-12 {
  margin-top: 12px;
}
.mb-12 {
  margin-bottom: 12px;
}
.ml-8 {
  margin-left: 8px;
}
</style>
