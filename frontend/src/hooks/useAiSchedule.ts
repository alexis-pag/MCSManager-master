import { t } from "@/lang/i18n";
import {
  aiScheduleCreate,
  aiScheduleDelete,
  aiScheduleList,
  aiScheduleRun
} from "@/services/apis/instance";
import { reportErrorMsg } from "@/tools/validator";
import type { ScheduleTaskForm } from "@/types";
import { message } from "ant-design-vue";

export type CreateResult = "created" | "pending" | false;

/** Maps a creation answer: `{ pending: true }` means the task waits for an administrator. */
export const createResult = (answer: unknown): CreateResult => {
  if (!answer) return false;
  return typeof answer === "object" && (answer as { pending?: boolean }).pending === true
    ? "pending"
    : "created";
};

/** Scheduled AI tasks of one instance (panel-side, read-only reports). */
export function useAiSchedule(instanceId: string, daemonId: string) {
  const params = () => ({ daemonId: daemonId ?? "", uuid: instanceId ?? "" });

  const { state: aiSchedules, execute: list, isLoading: aiScheduleLoading } = aiScheduleList();
  const getAiScheduleList = async () => {
    try {
      await list({ params: params() });
    } catch (err: any) {
      // The list is optional: an error here must not hide the server schedules.
      console.error(err);
    }
  };

  /**
   * Creates the task from the shared form; `time` must already be computed. Returns "pending"
   * when the task waits for an administrator (regular users), "created" otherwise.
   */
  const createAiTask = async (form: ScheduleTaskForm): Promise<CreateResult> => {
    const { execute, state } = aiScheduleCreate();
    await execute({
      params: params(),
      data: {
        name: form.name,
        kind: form.kind,
        prompt: form.kind === "custom_prompt" ? form.prompt : "",
        type: Number(form.type),
        time: form.time,
        count: form.count === "" || !form.count ? -1 : form.count,
        replaces: form.replaces || ""
      }
    });
    return createResult(state.value);
  };

  const deleteAiTask = async (name: string, showMsg = true) => {
    const { execute, state } = aiScheduleDelete();
    try {
      await execute({ params: { ...params(), name } });
      if (state.value) {
        if (showMsg) message.success(t("TXT_CODE_28190dbc"));
        await getAiScheduleList();
      }
    } catch (err: any) {
      reportErrorMsg(err.message);
    }
  };

  const runAiTask = async (name: string) => {
    const { execute, state } = aiScheduleRun();
    try {
      await execute({ params: { ...params(), name } });
      const status = state.value?.status;
      if (status === "queued" || status === "completed") {
        message.success(t("TXT_CODE_ai_task_run_started"));
      } else {
        message.warning(t("TXT_CODE_ai_task_run_skipped"));
      }
      await getAiScheduleList();
      return state.value;
    } catch (err: any) {
      reportErrorMsg(err.message);
    }
  };

  return {
    aiSchedules,
    aiScheduleLoading,
    getAiScheduleList,
    createAiTask,
    deleteAiTask,
    runAiTask
  };
}
