import { describe, expect, it } from "vitest";
import {
  MAX_RECORDS,
  RECORD_TTL_MS,
  TAIL_MAX_CHARS,
  UnexpectedStopService
} from "../unexpected_stop_service";

const instance = (eventTask: Record<string, unknown> = {}, autoRestartCount = 0) => ({
  config: {
    eventTask: { ignore: false, autoRestart: false, autoRestartMaxTimes: -1, ...eventTask }
  },
  autoRestartCount
});

describe("UnexpectedStopService", () => {
  it("ignores requested stops (stop/kill/restart set eventTask.ignore)", () => {
    const service = new UnexpectedStopService();
    service.onExit("a", instance({ ignore: true }), 0);
    expect(service.list(0)).toEqual([]);
  });

  it("records a crash with its exit code and console tail", () => {
    const service = new UnexpectedStopService();
    service.onData("a", "[INFO] Done\n");
    service.onData("a", "java.lang.OutOfMemoryError\n");
    service.onData("b", "other instance\n");
    service.onExit("a", instance(), 1);
    const [record] = service.list(0);
    expect(record).toMatchObject({
      instanceUuid: "a",
      kind: "exit",
      code: 1,
      autoRestart: false,
      consoleTail: "[INFO] Done\njava.lang.OutOfMemoryError\n"
    });
  });

  it("knows whether an automatic restart follows", () => {
    const service = new UnexpectedStopService();
    service.onExit("a", instance({ autoRestart: true, autoRestartMaxTimes: 3 }, 1), 1);
    service.onExit("b", instance({ autoRestart: true, autoRestartMaxTimes: 3 }, 3), 1);
    expect(service.list(0).map((record) => record.autoRestart)).toEqual([true, false]);
  });

  it("records start failures", () => {
    const service = new UnexpectedStopService();
    service.onFailure("a", new Error("java: command not found"));
    expect(service.list(0)[0]).toMatchObject({
      kind: "start_failure",
      error: "java: command not found"
    });
  });

  it("keeps only the newest records, for one hour, and filters by time", () => {
    const service = new UnexpectedStopService();
    for (let i = 0; i < MAX_RECORDS + 10; i++) service.onExit(`i${i}`, instance(), 1);
    const all = service.list(0);
    expect(all).toHaveLength(MAX_RECORDS);
    expect(all[0].instanceUuid).toBe("i10");
    expect(service.list(all[all.length - 1].at)).toEqual([]);
    expect(service.list(0, Date.now() + RECORD_TTL_MS + 1000)).toEqual([]);
  });

  it("bounds the console tail and forgets deleted instances", () => {
    const service = new UnexpectedStopService();
    service.onData("a", "x".repeat(TAIL_MAX_CHARS + 500));
    service.onExit("a", instance(), 1);
    expect(service.list(0)[0].consoleTail).toHaveLength(TAIL_MAX_CHARS);
    service.forget("a");
    expect(service.list(0)).toEqual([]);
  });
});
