<script setup lang="ts">
import { t } from "@/lang/i18n";
import { useAppStateStore } from "@/stores/useAppStateStore";
import type { AiAccessView } from "@/types";
import { message } from "ant-design-vue";
import axios from "axios";
import { computed, ref } from "vue";

const REASON_MIN = 10;
const REASON_MAX = 300;
const RETRY_MS = 24 * 60 * 60 * 1000;

const props = defineProps<{ access?: AiAccessView | null }>();
const emit = defineEmits<{ requested: [] }>();

const { state: appState } = useAppStateStore();
const reason = ref("");
const submitting = ref(false);
const error = ref("");

const state = computed(() => props.access?.state || "none");
/** A refused or revoked user can ask again 24 hours after the decision. */
const retryAt = computed(() => {
  if (!["refused", "revoked"].includes(state.value)) return 0;
  const decided = Date.parse(props.access?.decidedAt || "");
  return Number.isNaN(decided) ? 0 : decided + RETRY_MS;
});
const canRequest = computed(
  () => state.value !== "pending" && state.value !== "granted" && Date.now() >= retryAt.value
);
const reasonValid = computed(() => {
  const length = reason.value.trim().length;
  return length >= REASON_MIN && length <= REASON_MAX;
});

async function submit() {
  if (!reasonValid.value) {
    error.value = t("TXT_CODE_ai_access_reason_length");
    return;
  }
  submitting.value = true;
  error.value = "";
  try {
    await axios.post(
      "./api/ai/access",
      { reason: reason.value.trim() },
      {
        params: { token: appState.userInfo?.token },
        headers: { "X-Requested-With": "XMLHttpRequest" }
      }
    );
    reason.value = "";
    message.success(t("TXT_CODE_ai_access_sent"));
    emit("requested");
  } catch (err: any) {
    error.value = String(err?.response?.data?.data || err?.message || "");
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="ai-access-request">
    <p class="intro">{{ t("TXT_CODE_ai_access_intro") }}</p>
    <a-alert
      v-if="state === 'pending'"
      type="info"
      show-icon
      :message="t('TXT_CODE_ai_access_pending')"
      :description="t('TXT_CODE_ai_access_pending_desc')"
    />
    <a-alert
      v-else-if="state === 'refused' || state === 'revoked'"
      type="warning"
      show-icon
      :message="state === 'refused' ? t('TXT_CODE_ai_access_refused') : t('TXT_CODE_ai_access_revoked')"
    >
      <template #description>
        <div>{{ access?.note || t("TXT_CODE_ai_access_no_note") }}</div>
        <div v-if="!canRequest">
          {{ t("TXT_CODE_ai_access_retry_at", { date: new Date(retryAt).toLocaleString() }) }}
        </div>
      </template>
    </a-alert>
    <form v-if="canRequest" class="form" @submit.prevent="submit">
      <label for="ai-access-reason">{{ t("TXT_CODE_ai_access_reason_label") }}</label>
      <a-textarea
        id="ai-access-reason"
        v-model:value="reason"
        :rows="4"
        :maxlength="REASON_MAX"
        show-count
        :placeholder="t('TXT_CODE_ai_access_reason_placeholder')"
      />
      <a-button type="primary" html-type="submit" :loading="submitting" :disabled="!reasonValid">
        {{ t("TXT_CODE_ai_access_submit") }}
      </a-button>
    </form>
    <a-alert v-if="error" type="error" show-icon :message="error" />
  </div>
</template>

<style scoped>
.ai-access-request {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.intro {
  margin: 0;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}
.form :deep(.ant-input-textarea) {
  width: 100%;
}
</style>
