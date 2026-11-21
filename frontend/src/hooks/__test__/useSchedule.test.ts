import dayjs from "dayjs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lang/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/services/apis/instance", () => ({
  scheduleCreate: vi.fn(),
  scheduleDelete: vi.fn(),
  scheduleList: vi.fn()
}));
vi.mock("@/tools/validator", () => ({ reportErrorMsg: vi.fn() }));
vi.mock("ant-design-vue", () => ({ message: {}, notification: {} }));

import type { ScheduleTaskForm } from "@/types";
import { createResult } from "../useAiSchedule";
import {
  computeTaskTime,
  formatScheduleTime,
  parseBackupAction,
  serializeBackupAction
} from "../useSchedule";

describe("backup action payload", () => {
  it("serializes folders and retention", () => {
    expect(
      serializeBackupAction({
        type: "backup",
        payload: "",
        backupPaths: " world , world_nether,",
        backupKeep: 3
      })
    ).toEqual({ type: "backup", payload: '{"paths":["world","world_nether"],"keep":3}' });
  });

  it("leaves other actions unchanged and drops form-only fields", () => {
    expect(serializeBackupAction({ type: "command", payload: "say hi", backupKeep: 2 })).toEqual({
      type: "command",
      payload: "say hi"
    });
  });

  it("parses stored payloads back for editing", () => {
    expect(
      parseBackupAction({ type: "backup", payload: '{"paths":["world","plugins"],"keep":5}' })
    ).toMatchObject({ backupPaths: "world, plugins", backupKeep: 5 });
    expect(parseBackupAction({ type: "backup", payload: "world" })).toMatchObject({
      backupPaths: "world",
      backupKeep: 7
    });
  });
});

describe("computeTaskTime", () => {
  const form = (patch: Partial<ScheduleTaskForm>) =>
    ({
      category: "ai",
      kind: "console_report",
      prompt: "",
      name: "x",
      count: "",
      type: 1,
      time: "",
      actions: [],
      weekend: [],
      cycle: ["0", "0", "0"],
      objTime: dayjs("2026-11-21T08:30:15"),
      ...patch
    }) as ScheduleTaskForm;

  it("builds interval seconds, weekly and one-shot cron expressions", () => {
    const interval = form({ type: 1, cycle: ["5", "30", "2"] });
    computeTaskTime(interval);
    expect(interval.time).toBe(String(5 + 30 * 60 + 2 * 3600));

    const weekly = form({ type: 2, weekend: [1, 3] });
    computeTaskTime(weekly);
    expect(weekly.time).toBe("15 30 8 * * 1,3");

    const once = form({ type: 3 });
    computeTaskTime(once);
    expect(once.time).toBe("15 30 8 21 11 *");
  });

  it("requires at least one day for weekly triggers", () => {
    expect(() => computeTaskTime(form({ type: 2, weekend: [] }))).toThrow();
  });
});

describe("trigger labels", () => {
  it("formats each trigger type", () => {
    expect(formatScheduleTime(1, "3661")).toBe(
      "TXT_CODE_ec6d29f4 01 TXT_CODE_e3db239d 01 TXT_CODE_3b1bb444 01 TXT_CODE_acabc771"
    );
    expect(formatScheduleTime(2, "0 30 4 * * 1,3")).toBe("TXT_CODE_76750199 1,3 / 04:30:0");
    expect(formatScheduleTime(3, "0 0 8 25 12 *")).toBe("12/25 08:0:0");
    expect(formatScheduleTime(4, "")).toBe("TXT_CODE_ai_task_on_crash");
  });
});

describe("task creation answer", () => {
  it("distinguishes active tasks from requests waiting for an administrator", () => {
    expect(createResult(true)).toBe("created");
    expect(createResult({ uuid: "ai-task" })).toBe("created");
    expect(createResult({ pending: true, request: {} })).toBe("pending");
    expect(createResult(false)).toBe(false);
    expect(createResult(undefined)).toBe(false);
  });
});
