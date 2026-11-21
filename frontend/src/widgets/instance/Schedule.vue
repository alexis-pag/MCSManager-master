<script setup lang="ts">
import BetweenMenus from "@/components/BetweenMenus.vue";
import CardPanel from "@/components/CardPanel.vue";
import { useAppRouters } from "@/hooks/useAppRouters";
import { useAiSchedule } from "@/hooks/useAiSchedule";
import { useLayoutCardTools } from "@/hooks/useCardTools";
import { formatScheduleTime, useSchedule } from "@/hooks/useSchedule";
import { useScreen } from "@/hooks/useScreen";
import { t } from "@/lang/i18n";
import { reportErrorMsg } from "@/tools/validator";
import {
  AiScheduleKindLabel,
  ScheduleActionType,
  ScheduleCreateType,
  ScheduleType
} from "@/types/const";
import type { AiSchedule, AutomationRequest, LayoutCard, Schedule } from "@/types/index";
import NewSchedule from "@/widgets/instance/dialogs/NewSchedule.vue";
import {
  CaretRightOutlined,
  DeleteOutlined,
  EditOutlined,
  FieldTimeOutlined,
  FileTextOutlined,
  RobotOutlined
} from "@ant-design/icons-vue";
import { message } from "ant-design-vue";
import { computed, onMounted, ref } from "vue";
import axios from "axios";
import { useAppStateStore } from "@/stores/useAppStateStore";
import type { AntColumnsType } from "../../types/ant";

const props = defineProps<{
  card: LayoutCard;
}>();
const appState = useAppStateStore();
const automationRequests = ref<AutomationRequest[]>([]);

const { isPhone } = useScreen();
const { getMetaOrRouteValue } = useLayoutCardTools(props.card);
const instanceId = getMetaOrRouteValue("instanceId");
const daemonId = getMetaOrRouteValue("daemonId");
const { toPage } = useAppRouters();
const newScheduleDialog = ref<InstanceType<typeof NewSchedule>>();
const { getScheduleList, schedules, scheduleListLoading, deleteSchedule } = useSchedule(
  String(instanceId),
  String(daemonId)
);
const { aiSchedules, aiScheduleLoading, getAiScheduleList, deleteAiTask, runAiTask } =
  useAiSchedule(String(instanceId), String(daemonId));

// `request`: a task waiting for (or refused by) an administrator, shown next to the active ones.
type Row =
  | (Schedule & { isAi: false; request?: AutomationRequest })
  | (AiSchedule & { isAi: true; request?: AutomationRequest });

const requestRow = (request: AutomationRequest): Row => {
  const { payload } = request;
  if (request.kind === "schedule") {
    return {
      instanceUuid: request.instanceUuid,
      name: request.name,
      count: payload.count,
      time: payload.time,
      type: payload.type,
      actions: payload.actions || [],
      isAi: false,
      request
    };
  }
  return {
    uuid: request.uuid,
    name: request.name,
    kind: payload.kind || "custom_prompt",
    prompt: payload.prompt || "",
    type: payload.type,
    time: payload.time,
    count: payload.count,
    createdAt: request.createdAt,
    lastRunAt: "",
    lastStatus: "",
    lastReportUuid: "",
    disabledReason: "",
    isAi: true,
    request
  };
};

const rows = computed<Row[]>(() => [
  ...automationRequests.value.map(requestRow),
  ...(schedules.value || []).map((item) => ({ ...item, isAi: false as const })),
  ...(aiSchedules.value || []).map((item) => ({ ...item, isAi: true as const }))
]);
const rowKey = (record: Row) => {
  if (record.request) return `request:${record.request.uuid}`;
  return record.isAi ? `ai:${record.uuid}` : record.name;
};

const aiStatusLabel = (task: AiSchedule) => {
  if (task.disabledReason) return t("TXT_CODE_ai_task_status_disabled");
  const status = {
    "": t("TXT_CODE_ai_task_status_never"),
    queued: t("TXT_CODE_ai_task_status_queued"),
    completed: t("TXT_CODE_ai_task_status_completed"),
    failed: t("TXT_CODE_ai_task_status_failed"),
    skipped: t("TXT_CODE_ai_task_status_skipped")
  }[task.lastStatus];
  if (!task.lastRunAt) return status;
  const when = new Date(task.lastRunAt).toLocaleString([], {
    dateStyle: "short",
    timeStyle: "short"
  });
  return `${status} · ${when}`;
};

const loadAll = async () => {
  await Promise.all([getScheduleList(), getAiScheduleList(), loadRequests()]);
};

const requestConfig = (params: Record<string, unknown> = {}) => ({
  params: { ...params, token: appState.state.userInfo?.token },
  headers: { "X-Requested-With": "XMLHttpRequest" }
});

/** Pending and refused automation requests of this instance (own ones for regular users). */
const loadRequests = async () => {
  try {
    const result = await axios.get(
      "./api/approvals/automation",
      requestConfig({ daemonId, uuid: instanceId })
    );
    automationRequests.value = result.data?.data || [];
  } catch (err) {
    // The list is optional: an error here must not hide the active tasks.
    console.error(err);
    automationRequests.value = [];
  }
};

/** Cancels a pending request, or dismisses a refused one. */
const cancelRequest = async (request: AutomationRequest) => {
  try {
    await axios.delete(
      `./api/approvals/automation/${encodeURIComponent(request.uuid)}`,
      requestConfig()
    );
    await loadRequests();
  } catch (err: any) {
    reportErrorMsg(err?.response?.data?.data || err?.message);
  }
};

const runNow = async (task: AiSchedule) => {
  await runAiTask(task.name);
};

const openReport = (task: AiSchedule) => {
  toPage({
    path: "/ai",
    query: { daemonId, instanceId, conversation: task.lastReportUuid }
  });
};

const editRow = (record: Row) => {
  newScheduleDialog.value?.openDialog(record, record.isAi);
};

const deleteRow = (record: Row) =>
  record.isAi ? deleteAiTask(record.name) : deleteSchedule(record.name);


const columns: AntColumnsType[] = [
  {
    align: "center",
    title: t("TXT_CODE_2d542e4c"),
    dataIndex: "name",
    key: "name"
  },
  {
    align: "center",
    title: t("TXT_CODE_1544562"),
    dataIndex: "payload",
    key: "payload",
    customRender: (e: { text: string; record: Row }) =>
      e.record.isAi ? AiScheduleKindLabel[e.record.kind] : e.text
  },
  {
    align: "center",
    title: t("TXT_CODE_485e2d41"),
    dataIndex: "count",
    key: "count",
    minWidth: 80,
    customRender: (e: { text: number }) => (e.text > 0 ? e.text : t("TXT_CODE_a92df201"))
  },
  {
    align: "center",
    title: t("TXT_CODE_82fbc5ad"),
    dataIndex: "action",
    key: "action",
    minWidth: 180,
    customRender: (e: {
      text: "delay" | "command" | "stop" | "start" | "restart" | "kill" | "backup";
      record: Row;
    }) => {
      if (e.record.request) return "";
      return e.record.isAi ? aiStatusLabel(e.record) : ScheduleActionType[e.text];
    }
  },
  {
    align: "center",
    title: t("TXT_CODE_67d68dd1"),
    dataIndex: "type",
    key: "type",
    minWidth: 180,
    customRender: (e: { text: 1 | 2 | 3 | 4 }) =>
      e.text === ScheduleCreateType.ON_CRASH ? t("TXT_CODE_ai_task_on_crash") : ScheduleType[e.text]
  },
  {
    align: "center",
    title: t("TXT_CODE_3554dac0"),
    dataIndex: "time",
    key: "time",
    minWidth: 240,
    customRender: (e: { text: string; record: Row }) => formatScheduleTime(e.record.type, e.text)
  },
  {
    align: "center",
    title: t("TXT_CODE_fe731dfc"),
    key: "actions",
    minWidth: 180
  }
];

const refresh = async () => {
  await loadAll();
  message.success(t("TXT_CODE_fbde647e"));
};

const toConsole = () => {
  toPage({
    path: "/instances/terminal",
    query: {
      daemonId,
      instanceId
    }
  });
};

onMounted(async () => {
  loadAll();
});
</script>

<template>
  <div style="height: 100%" class="container">
    <a-row :gutter="[24, 24]" style="height: 100%">
      <a-col :span="24">
        <BetweenMenus>
          <template v-if="!isPhone" #left>
            <a-typography-title class="mb-0" :level="4">
              <FieldTimeOutlined />
              {{ card.title }}
            </a-typography-title>
          </template>
          <template #right>
            <a-button @click="toConsole">
              {{ t("TXT_CODE_c14b2ea3") }}
            </a-button>
            <a-button @click="refresh">
              {{ t("TXT_CODE_b76d94e0") }}
            </a-button>
            <a-button type="primary" @click="newScheduleDialog?.openDialog()">
              {{ t("TXT_CODE_1644b775") }}
            </a-button>
          </template>
        </BetweenMenus>
      </a-col>
      <a-col :span="24">
        <CardPanel style="height: 100%">
          <template #body>
            <a-spin :spinning="scheduleListLoading || aiScheduleLoading">
              <a-table
                :data-source="rows"
                :row-key="rowKey"
                :columns="columns"
                :scroll="{ x: 'max-content' }"
                :pagination="{
                  pageSize: 15
                }"
              >
                <template #bodyCell="{ column, record }">
                  <template v-if="column.key === 'name'">
                    <a-tag v-if="record.isAi" color="purple">
                      <RobotOutlined /> {{ t("TXT_CODE_ai_task_tag") }}
                    </a-tag>
                    <a-tag
                      v-if="record.request"
                      :color="record.request.state === 'pending' ? 'orange' : 'red'"
                    >
                      {{
                        record.request.state === "pending"
                          ? t("TXT_CODE_approval_state_pending")
                          : t("TXT_CODE_approval_state_refused")
                      }}
                    </a-tag>
                    {{ record.name }}
                  </template>
                  <template v-if="column.key === 'action' && record.request">
                    <span v-if="record.request.state === 'refused'">
                      {{ record.request.note || t("TXT_CODE_ai_access_no_note") }}
                    </span>
                    <span v-else-if="record.request.replaces">
                      {{ t("TXT_CODE_approval_origin_edit", { name: record.request.replaces }) }}
                    </span>
                  </template>
                  <template v-if="column.key === 'actions' && record.request">
                    <a-popconfirm
                      v-if="record.request.state === 'pending'"
                      :title="t('TXT_CODE_approval_cancel_confirm')"
                      @confirm="cancelRequest(record.request)"
                    >
                      <a-button danger size="large">
                        {{ t("TXT_CODE_approval_cancel_request") }}
                      </a-button>
                    </a-popconfirm>
                    <a-button v-else size="large" @click="cancelRequest(record.request)">
                      {{ t("TXT_CODE_approval_dismiss") }}
                    </a-button>
                  </template>
                  <template v-else-if="column.key === 'actions'">
                    <template v-if="record.isAi">
                      <a-button
                        class="mr-8"
                        size="large"
                        :disabled="!!record.disabledReason"
                        @click="runNow(record as AiSchedule)"
                      >
                        {{ t("TXT_CODE_ai_task_run_now") }}
                        <CaretRightOutlined />
                      </a-button>
                      <a-button
                        v-if="record.lastReportUuid"
                        class="mr-8"
                        size="large"
                        @click="openReport(record as AiSchedule)"
                      >
                        {{ t("TXT_CODE_ai_task_open_report") }}
                        <FileTextOutlined />
                      </a-button>
                    </template>
                    <a-button class="mr-8" size="large" @click="editRow(record as Row)">
                      {{ t("TXT_CODE_ad207008") }}
                      <EditOutlined />
                    </a-button>
                    <a-popconfirm
                      :title="t('TXT_CODE_6ff0668f')"
                      @confirm="deleteRow(record as Row)"
                    >
                      <a-button danger size="large">
                        {{ t("TXT_CODE_ecbd7449") }}
                        <DeleteOutlined />
                      </a-button>
                    </a-popconfirm>
                  </template>
                </template>
              </a-table>
            </a-spin>
          </template>
        </CardPanel>
      </a-col>
    </a-row>
  </div>

  <NewSchedule
    ref="newScheduleDialog"
    :daemon-id="daemonId ?? ''"
    :instance-id="instanceId ?? ''"
    @get-schedule-list="loadAll()"
  />
</template>

<style lang="scss" scoped>
.search-input {
  transition: all 0.4s;
  text-align: center;
  width: 50%;

  &:hover {
    width: 100%;
  }

  @media (max-width: 992px) {
    width: 100% !important;
  }
}
</style>
