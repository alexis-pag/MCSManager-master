import { t } from "@/lang/i18n";
import { scheduleCreate, scheduleDelete, scheduleList } from "@/services/apis/instance";
import { padZero } from "@/tools/common";
import { reportErrorMsg } from "@/tools/validator";
import type { ScheduleAction, ScheduleTaskForm } from "@/types";
import { ScheduleActionTypeEnum, ScheduleCreateType } from "@/types/const";
import { message, notification } from "ant-design-vue";
import dayjs from "dayjs";

/** Backup action form fields -> daemon payload `{"paths": [...], "keep": n}`. */
export function serializeBackupAction(action: ScheduleAction): ScheduleAction {
  if (action.type !== ScheduleActionTypeEnum.Backup) {
    return { type: action.type, payload: action.payload };
  }
  const paths = String(action.backupPaths ?? "world")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    type: action.type,
    payload: JSON.stringify({ paths, keep: Number(action.backupKeep) || 7 })
  };
}

/** Daemon payload -> backup action form fields (for editing). */
export function parseBackupAction(action: ScheduleAction): ScheduleAction {
  if (action.type !== ScheduleActionTypeEnum.Backup) return action;
  try {
    const value = JSON.parse(action.payload || "{}");
    return {
      ...action,
      backupPaths: Array.isArray(value.paths) ? value.paths.join(", ") : "world",
      backupKeep: Number(value.keep) || 7
    };
  } catch {
    return { ...action, backupPaths: action.payload || "world", backupKeep: 7 };
  }
}

/** Sets `task.time` from the form fields of its trigger type. */
export function computeTaskTime(newTask: ScheduleTaskForm) {
  if (newTask.type === ScheduleCreateType.INTERVAL) {
    const arr = newTask.cycle;
    const rs = Number(arr[0]) + Number(arr[1]) * 60 + Number(arr[2]) * 60 * 60;
    newTask.time = rs.toString();
    return;
  }
  if (!newTask.objTime) throw new Error(t("TXT_CODE_349edc57"));
  const time = newTask.objTime;
  const h = time.hour();
  const m = time.minute();
  const s = time.second();
  if (newTask.type === ScheduleCreateType.CYCLE) {
    const weekend = newTask.weekend;
    if (weekend.length === 0) throw new Error(t("TXT_CODE_2fe0cc84"));
    newTask.time = `${s} ${m} ${h} * * ${weekend.join(",")}`;
    return;
  }
  newTask.time = `${s} ${m} ${h} ${time.date()} ${time.month() + 1} *`;
}

/** Human-readable trigger time of a schedule or AI task ("every 01 h 00 min 00 s", ...). */
export function formatScheduleTime(type: number, time: string): string {
  if (type === ScheduleCreateType.ON_CRASH) return t("TXT_CODE_ai_task_on_crash");
  if (type === ScheduleCreateType.INTERVAL) {
    const seconds = Number(time);
    const h = padZero(Math.floor(seconds / 3600).toString());
    const m = padZero(Math.floor((seconds % 3600) / 60).toString());
    const s = padZero((seconds % 60).toString());
    return `${t("TXT_CODE_ec6d29f4")} ${h} ${t("TXT_CODE_e3db239d")} ${m} ${t(
      "TXT_CODE_3b1bb444"
    )} ${s} ${t("TXT_CODE_acabc771")}`;
  }
  if (type === ScheduleCreateType.CYCLE) {
    const [s, m, h, , , w] = String(time).split(" ");
    return `${t("TXT_CODE_76750199")} ${w} / ${padZero(h)}:${padZero(m)}:${padZero(s)}`;
  }
  if (type === ScheduleCreateType.SPECIFY) {
    const [s, m, h, dd, mm] = String(time).split(" ");
    return `${mm}/${dd} ${padZero(h)}:${padZero(m)}:${padZero(s)}`;
  }
  return "Unknown Time";
}

export function useSchedule(instanceId: string, daemonId: string) {
  const createTaskTypeInterval = async (newTask: ScheduleTaskForm) => {
    computeTaskTime(newTask);
    await createTask(newTask);
  };

  const createTaskTypeCycle = async (newTask: ScheduleTaskForm) => {
    computeTaskTime(newTask);
    await createTask(newTask);
  };

  const createTaskTypeSpecify = async (newTask: ScheduleTaskForm) => {
    computeTaskTime(newTask);
    await createTask(newTask);
  };

  const calculateIntervalFromTime = (time: string): string[] => {
    const totalSeconds = Number(time);
    const ph = Math.floor(totalSeconds / 3600);
    const pm = Math.floor((totalSeconds % 3600) / 60);
    const ps = totalSeconds % 60;
    return [ps.toString(), pm.toString(), ph.toString()];
  };

  const calculateTimeFromCycle = (time: string) => {
    const regex = /(\d+) (\d+) (\d+) \* \* (.+)/;
    const match = time.match(regex);
    let objTime = dayjs(),
      weekend: number[] = [];
    if (match) {
      const s = match[1];
      const m = match[2];
      const h = match[3];
      const w = match[4].split(",").map(Number);

      const now = new Date();
      now.setSeconds(Number(s));
      now.setMinutes(Number(m));
      now.setHours(Number(h));
      objTime = dayjs(now);
      weekend = w;
    } else {
      notification.error({ message: t("TXT_CODE_afabf3ca") });
    }

    return {
      objTime,
      weekend
    };
  };

  const parseTaskTime = (time: string) => {
    const regex = /(\d+) (\d+) (\d+) (\d+) (\d+) \*/; // 匹配 time 格式
    const match = time.match(regex);
    let objTime = dayjs();
    if (match) {
      const s = Number(match[1]);
      const m = Number(match[2]);
      const h = Number(match[3]);
      const dd = Number(match[4]);
      const mm = Number(match[5]) - 1;

      const now = new Date();
      now.setSeconds(s);
      now.setMinutes(m);
      now.setHours(h);
      now.setDate(dd);
      now.setMonth(mm);
      objTime = dayjs(now);
    } else {
      notification.error({ message: t("TXT_CODE_afabf3ca") });
    }

    return objTime;
  };

  const { state: createState, execute: create } = scheduleCreate();
  const createTask = async (newTask: ScheduleTaskForm) => {
    try {
      if (!newTask.count) newTask.count = -1;
      await create({
        params: {
          daemonId: daemonId,
          uuid: instanceId
        },
        data: {
          name: newTask.name,
          count: newTask.count,
          time: newTask.time,
          type: newTask.type,
          actions: newTask.actions.map(serializeBackupAction),
          replaces: newTask.replaces || ""
        }
      });
    } catch (err: any) {
      console.error(err);
      reportErrorMsg(err.message);
    }
  };

  const { state: schedules, execute: list, isLoading: scheduleListLoading } = scheduleList();
  const getScheduleList = async () => {
    try {
      await list({
        params: {
          daemonId: daemonId ?? "",
          uuid: instanceId ?? ""
        }
      });
    } catch (err: any) {
      console.error(err);
      reportErrorMsg(err.message);
    }
  };

  const deleteSchedule = async (name: string, showMsg: boolean = true) => {
    const { execute, state } = scheduleDelete();
    try {
      await execute({
        params: {
          daemonId: daemonId ?? "",
          uuid: instanceId ?? "",
          task_name: name
        }
      });
      if (state.value) {
        showMsg && message.success(t("TXT_CODE_28190dbc"));
        getScheduleList();
      }
    } catch (err: any) {
      console.error(err);
      reportErrorMsg(err.message);
    }
  };

  return {
    createTaskTypeInterval,
    createTaskTypeCycle,
    createTaskTypeSpecify,

    calculateIntervalFromTime,
    calculateTimeFromCycle,
    parseTaskTime,

    createTask,
    createState,

    getScheduleList,
    scheduleListLoading,
    schedules,

    deleteSchedule
  };
}
