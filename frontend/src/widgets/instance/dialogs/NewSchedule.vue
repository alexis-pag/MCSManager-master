<script setup lang="ts">
import { createResult, useAiSchedule, type CreateResult } from "@/hooks/useAiSchedule";
import { computeTaskTime, parseBackupAction, useSchedule } from "@/hooks/useSchedule";
import { t } from "@/lang/i18n";
import { reportErrorMsg } from "@/tools/validator";
import type { AiSchedule, Schedule, ScheduleAction, ScheduleTaskForm } from "@/types";
import {
  AiScheduleKindHelp,
  AiScheduleKindLabel,
  ScheduleActionType,
  ScheduleActionTypeEnum,
  ScheduleCreateType,
  ScheduleType
} from "@/types/const";
import { MinusCircleOutlined, PlusCircleOutlined } from "@ant-design/icons-vue";
import { Flex, notification } from "ant-design-vue";
import dayjs from "dayjs";
import _ from "lodash";
import { h, reactive, ref } from "vue";

const props = defineProps<{
  daemonId: string;
  instanceId: string;
}>();
const isLoading = ref(false);
const editMode = ref(false);
const {
  createTaskTypeInterval,
  createTaskTypeCycle,
  createTaskTypeSpecify,
  calculateIntervalFromTime,
  calculateTimeFromCycle,
  parseTaskTime,
  createState
} = useSchedule(props.instanceId, props.daemonId);
const { createAiTask } = useAiSchedule(props.instanceId, props.daemonId);

const parseTime = {
  [ScheduleCreateType.INTERVAL]: (time: string) =>
    (newTask.cycle = calculateIntervalFromTime(time)),
  [ScheduleCreateType.CYCLE]: (time: string) => {
    const { objTime, weekend } = calculateTimeFromCycle(time);
    newTask.objTime = objTime;
    newTask.weekend = weekend;
  },
  [ScheduleCreateType.SPECIFY]: (time: string) => (newTask.objTime = parseTaskTime(time))
};
const emit = defineEmits(["getScheduleList"]);
const open = ref(false);
/** Opens the dialog empty, or to edit a server schedule or (with `ai`) an AI task. */
const openDialog = (task?: Schedule | AiSchedule, ai = false) => {
  const copy: any = _.cloneDeep(task || {});
  newTask = reactive<ScheduleTaskForm>({
    ..._.cloneDeep(defaultTask),
    ...copy,
    category: ai ? "ai" : "server",
    actions:
      task && !ai
        ? ((task as Schedule).actions || []).map(parseBackupAction)
        : [_.clone(defaultAction)],
    count: !task || Number(task?.count) === -1 ? "" : Number(task?.count)
  });

  editMode.value = !!task;
  // The panel replaces the edited task (for regular users, once an administrator approves).
  newTask.replaces = task ? task.name : "";

  // "On crash" AI tasks (type 4) have no time to parse.
  if (editMode.value && newTask.type !== ScheduleCreateType.ON_CRASH) {
    parseTime[newTask.type](newTask.time);
  }

  open.value = true;
};

const weeks = [
  { label: t("TXT_CODE_fcbdcb34"), value: 1 },
  { label: t("TXT_CODE_c73de59d"), value: 2 },
  { label: t("TXT_CODE_85617390"), value: 3 },
  { label: t("TXT_CODE_c9b31f8e"), value: 4 },
  { label: t("TXT_CODE_d4517dcb"), value: 5 },
  { label: t("TXT_CODE_d248b5c8"), value: 6 },
  { label: t("TXT_CODE_a621f370"), value: 7 }
];

const defaultAction: ScheduleAction = {
  type: "command",
  payload: ""
};

const aiKinds = Object.entries(AiScheduleKindLabel).map(([value, label]) => ({ value, label }));

const defaultTask: ScheduleTaskForm = {
  category: "server",
  kind: "console_report",
  prompt: "",
  name: "",
  count: 0,
  type: ScheduleCreateType.INTERVAL,
  time: "",
  actions: [_.clone(defaultAction)],
  weekend: [],
  cycle: ["0", "0", "0"],
  objTime: dayjs()
};

let newTask = reactive<ScheduleTaskForm>(_.cloneDeep(defaultTask));

const create = {
  [ScheduleCreateType.INTERVAL]: (newTask: ScheduleTaskForm) => createTaskTypeInterval(newTask),
  [ScheduleCreateType.CYCLE]: (newTask: ScheduleTaskForm) => createTaskTypeCycle(newTask),
  [ScheduleCreateType.SPECIFY]: (newTask: ScheduleTaskForm) => createTaskTypeSpecify(newTask)
};

const getInputPlaceholder = (action: ScheduleAction) => {
  if (action.type === ScheduleActionTypeEnum.Delay) {
    return t("TXT_CODE_bb760145");
  }
  if (action.type === ScheduleActionTypeEnum.Command) {
    return t("TXT_CODE_8ff89011");
  }
  return;
};
/** Crash analysis tasks run on every unexpected stop instead of at a time. */
const isOnCrash = () => newTask.category === "ai" && newTask.kind === "crash_analysis";

const submitAiTask = async () => {
  if (isOnCrash()) {
    newTask.type = ScheduleCreateType.ON_CRASH;
    newTask.time = "";
  } else {
    if (newTask.type === ScheduleCreateType.ON_CRASH) newTask.type = ScheduleCreateType.CYCLE;
    computeTaskTime(newTask);
  }
  done(await createAiTask(newTask));
};

/** Closes the dialog after a successful submission (active task or pending request). */
const done = (result: CreateResult) => {
  if (!result) return;
  emit("getScheduleList");
  if (result === "pending") {
    notification.info({ message: t("TXT_CODE_approval_request_sent") });
  } else {
    notification.success({
      message: editMode.value ? t("TXT_CODE_d3de39b4") : t("TXT_CODE_d28c05df")
    });
  }
  newTask = reactive(_.cloneDeep(defaultTask));
  open.value = false;
};

const submit = async () => {
  try {
    isLoading.value = true;
    if (newTask.category === "ai") return await submitAiTask();
    // Server schedules never use the AI-only "on crash" trigger.
    await create[newTask.type as Exclude<ScheduleCreateType, ScheduleCreateType.ON_CRASH>](newTask);
    done(createResult(createState.value));
  } catch (err: any) {
    return reportErrorMsg(err.message);
  } finally {
    isLoading.value = false;
  }
};

const onActionTypeChange = (action: ScheduleAction) => {
  action.payload = "";
  if (action.type === ScheduleActionTypeEnum.Backup) {
    action.backupPaths = "world";
    action.backupKeep = 7;
  }
};

const addEmptyAction = () => {
  newTask.actions[newTask.actions.length] = _.clone(defaultAction);
};

const delAction = (index: number) => {
  if (newTask.actions.length === 1) {
    return reportErrorMsg(t("TXT_CODE_a749763b"));
  }
  newTask.actions.splice(index, 1);
};

defineExpose({
  openDialog
});
</script>

<template>
  <a-modal
    v-model:open="open"
    centered
    width="660px"
    :mask-closable="false"
    :title="editMode ? t('TXT_CODE_1548649e') : t('TXT_CODE_3502273d')"
    :confirm-loading="isLoading"
    :destroy-on-close="true"
    :ok-text="t('TXT_CODE_abfe9512')"
    @ok="submit"
  >
    <a-form-item>
      <a-typography-title :level="5">{{ t("TXT_CODE_b290a4b0") }}</a-typography-title>
      <a-typography-paragraph>
        <a-typography-text type="secondary">
          {{ t("TXT_CODE_b72d638d") }}
        </a-typography-text>
      </a-typography-paragraph>
      <a-input v-model:value="newTask.name" :disabled="editMode" />
    </a-form-item>

    <a-form-item>
      <a-typography-title :level="5">{{ t("TXT_CODE_ai_task_category") }}</a-typography-title>
      <a-radio-group v-model:value="newTask.category" :disabled="editMode" button-style="solid">
        <a-radio-button value="server">{{ t("TXT_CODE_ai_task_category_server") }}</a-radio-button>
        <a-radio-button value="ai">{{ t("TXT_CODE_ai_task_category_ai") }}</a-radio-button>
      </a-radio-group>
    </a-form-item>

    <template v-if="newTask.category === 'ai'">
      <a-form-item>
        <a-typography-title :level="5">{{ t("TXT_CODE_ai_task_kind") }}</a-typography-title>
        <a-select v-model:value="newTask.kind" :options="aiKinds" />
        <a-typography-paragraph class="mt-8 mb-0">
          <a-typography-text type="secondary">
            {{ AiScheduleKindHelp[newTask.kind] }} {{ t("TXT_CODE_ai_task_read_only") }}
          </a-typography-text>
        </a-typography-paragraph>
      </a-form-item>
      <a-form-item v-if="newTask.kind === 'custom_prompt'">
        <a-typography-title :level="5">{{ t("TXT_CODE_ai_task_prompt") }}</a-typography-title>
        <a-textarea
          v-model:value="newTask.prompt"
          :maxlength="2000"
          show-count
          :auto-size="{ minRows: 3, maxRows: 8 }"
          :placeholder="t('TXT_CODE_ai_task_prompt_placeholder')"
        />
      </a-form-item>
    </template>

    <template v-if="isOnCrash()">
      <a-form-item>
        <a-typography-title :level="5">{{ t("TXT_CODE_a62c99d1") }}</a-typography-title>
        <a-tag color="red">{{ t("TXT_CODE_ai_task_on_crash") }}</a-tag>
        <a-typography-paragraph class="mt-8 mb-0">
          <a-typography-text type="secondary">
            {{ t("TXT_CODE_ai_task_on_crash_help") }}
          </a-typography-text>
        </a-typography-paragraph>
      </a-form-item>
      <a-form-item>
        <a-typography-title :level="5">{{ t("TXT_CODE_d9cfab1b") }}</a-typography-title>
        <a-input-number
          v-model:value="newTask.count"
          size="large"
          class="w-100"
          :placeholder="t('TXT_CODE_a59981f4')"
        />
      </a-form-item>
    </template>

    <template v-else>
      <a-form-item>
        <a-typography-title :level="5">{{ t("TXT_CODE_a62c99d1") }}</a-typography-title>
        <a-select
          v-model:value="newTask.type"
          :placeholder="t('TXT_CODE_3bb646e4')"
          :dropdown-match-select-width="false"
        >
          <a-select-option v-for="(type, i) in ScheduleType" :key="i" :value="Number(i)">
            {{ type }}
          </a-select-option>
        </a-select>
      </a-form-item>

      <template v-if="newTask.type === ScheduleCreateType.INTERVAL">
        <a-form-item>
          <a-typography-paragraph>
            <a-typography-title :level="5">{{ t("TXT_CODE_3554dac0") }}</a-typography-title>
            <a-typography-text>
              {{ t("TXT_CODE_f17889f4") }}
            </a-typography-text>
            <a-typography-text v-if="newTask.category === 'ai'" type="warning">
              {{ t("TXT_CODE_ai_task_min_interval") }}
            </a-typography-text>
          </a-typography-paragraph>
          <a-row :gutter="[24, 24]">
            <a-col :xs="24" :md="8" :offset="0">
              <a-input
                v-model:value="newTask.cycle[2]"
                :placeholder="t('TXT_CODE_ba8ebc7')"
                :addon-after="t('TXT_CODE_4e2c7f64')"
              />
            </a-col>
            <a-col :xs="24" :md="8" :offset="0">
              <a-input
                v-model:value="newTask.cycle[1]"
                :placeholder="t('TXT_CODE_ba8ebc7')"
                :addon-after="t('TXT_CODE_a7e9ff0f')"
              />
            </a-col>
            <a-col :xs="24" :md="8" :offset="0">
              <a-input
                v-model:value="newTask.cycle[0]"
                :placeholder="t('TXT_CODE_ba8ebc7')"
                :addon-after="t('TXT_CODE_acabc771')"
              />
            </a-col>
          </a-row>
        </a-form-item>
        <a-form-item>
          <a-typography-title :level="5">{{ t("TXT_CODE_d9cfab1b") }}</a-typography-title>
          <a-input-number
            v-model:value="newTask.count"
            size="large"
            class="w-100"
            :placeholder="t('TXT_CODE_a59981f4')"
          />
        </a-form-item>
      </template>

      <template v-if="newTask.type === ScheduleCreateType.CYCLE">
        <a-form-item>
          <a-typography-title :level="5">{{ t("TXT_CODE_3554dac0") }}</a-typography-title>
          <a-time-picker
            v-model:value="newTask.objTime"
            size="large"
            :placeholder="$t('TXT_CODE_38591f72')"
            class="w-100"
          />
        </a-form-item>
        <a-form-item>
          <a-checkbox-group v-model:value="newTask.weekend" :options="weeks" />
        </a-form-item>

        <a-form-item>
          <a-typography-title :level="5">{{ t("TXT_CODE_d9cfab1b") }}</a-typography-title>
          <a-input-number
            v-model:value="newTask.count"
            size="large"
            class="w-100"
            :placeholder="t('TXT_CODE_a59981f4')"
          />
        </a-form-item>
      </template>

      <a-form-item v-if="newTask.type === ScheduleCreateType.SPECIFY">
        <a-typography-title :level="5">{{ t("TXT_CODE_f3fe5c8e") }}</a-typography-title>
        <a-date-picker v-model:value="newTask.objTime" show-time size="large" class="w-100" />
      </a-form-item>
    </template>

    <a-form-item v-if="newTask.category === 'server'">
      <div class="flex justify-between items-center mb-20">
        <div>
          <a-typography-title :level="5" :style="{ marginBottom: 0 }">
            {{ t("TXT_CODE_61811ac") }}
          </a-typography-title>
          <a-typography-paragraph>
            <a-typography-text type="secondary">
              {{ t("TXT_CODE_81297804") }}
            </a-typography-text>
          </a-typography-paragraph>
        </div>
        <a-button :icon="h(PlusCircleOutlined)" @click="addEmptyAction()">
          {{ t("TXT_CODE_dfc17a0c") }}
        </a-button>
      </div>
      <template v-for="(action, index) in newTask.actions" :key="index">
        <a-form-item>
          <a-row :gutter="[12, 24]">
            <a-col :xs="24" :md="6" :offset="0">
              <a-select
                v-model:value="action.type"
                :placeholder="t('TXT_CODE_3bb646e4')"
                :dropdown-match-select-width="false"
                @change="onActionTypeChange(action)"
              >
                <a-select-option v-for="(type, i) in ScheduleActionType" :key="i" :value="i">
                  {{ type }}
                </a-select-option>
              </a-select>
            </a-col>
            <a-col :xs="24" :md="16" :offset="0">
              <Flex v-if="action.type === ScheduleActionTypeEnum.Backup" gap="8">
                <a-input
                  v-model:value="action.backupPaths"
                  :addon-before="t('TXT_CODE_schedule_backup_folders')"
                  placeholder="world, world_nether, world_the_end"
                />
                <a-input-number
                  v-model:value="action.backupKeep"
                  :min="1"
                  :max="30"
                  :addon-before="t('TXT_CODE_schedule_backup_keep')"
                />
              </Flex>
              <Flex v-else>
                <a-input
                  v-model:value="action.payload"
                  :placeholder="getInputPlaceholder(action)"
                  :disabled="!getInputPlaceholder(action)"
                />
              </Flex>
            </a-col>
            <a-col :xs="24" :md="2" :offset="0">
              <div>
                <a-button
                  :icon="h(MinusCircleOutlined)"
                  danger
                  @click="delAction(index)"
                ></a-button>
              </div>
            </a-col>
          </a-row>
        </a-form-item>
      </template>
    </a-form-item>
  </a-modal>
</template>
