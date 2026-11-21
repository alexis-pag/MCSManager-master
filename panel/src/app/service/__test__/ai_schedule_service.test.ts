import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  records: new Map<string, string>(),
  remoteRequest: vi.fn(),
  hasInstance: vi.fn(() => true),
  hasAiAccess: vi.fn(() => true),
  user: { permission: 1, userName: "alice", instances: [] } as any,
  config: { aiEnabled: true } as any,
  localAi: {
    createConversation: vi.fn(async () => ({ uuid: "report-1" })),
    appendMessage: vi.fn(async () => true),
    submit: vi.fn(async () => ({ uuid: "request-1" })),
    hasActiveRequest: vi.fn(() => false)
  }
}));

vi.mock("../../setting", () => ({ systemConfig: mocks.config }));
vi.mock("../log", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("../user_service", () => ({ default: { getInstance: () => mocks.user } }));
vi.mock("../permission_service", () => ({ isHaveInstance: mocks.hasInstance }));
vi.mock("../local_ai_service", () => ({ default: mocks.localAi }));
vi.mock("../ai_access_service", () => ({ default: { hasAccess: mocks.hasAiAccess } }));
vi.mock("../mod_manager_service", () => ({ modManagerService: {} }));
vi.mock("../ai_tool_service", () => ({ default: {} }));
vi.mock("../remote_service", () => ({
  default: { getInstance: () => ({ available: true }) }
}));
vi.mock("../remote_command", () => ({
  default: class {
    request = mocks.remoteRequest;
  }
}));
vi.mock("../../common/storage/sys_storage", () => ({
  default: {
    getStorage: () => ({
      store: async (category: string, uuid: string, object: unknown) => {
        mocks.records.set(`${category}:${uuid}`, JSON.stringify(object));
      },
      load: async () => null,
      list: async () => [],
      delete: async (category: string, uuid: string) => {
        mocks.records.delete(`${category}:${uuid}`);
      }
    })
  }
}));

import {
  AiScheduleError,
  AiScheduleService,
  formatPluginTable,
  validateAiScheduleInput
} from "../ai_schedule_service";

const daily = {
  name: "Rapport",
  kind: "console_report",
  type: 2,
  time: "0 0 8 * * 1,2,3",
  count: -1
};

describe("validateAiScheduleInput", () => {
  it("accepts a daily console report", () => {
    expect(validateAiScheduleInput(daily, [])).toMatchObject({ name: "Rapport", count: -1 });
  });

  it.each([
    [{ ...daily, name: "a/b" }, "Invalid task name"],
    [{ ...daily, kind: "delete_world" }, "Invalid task kind"],
    [{ ...daily, kind: "custom_prompt", prompt: "" }, "Invalid instruction"],
    [{ ...daily, kind: "custom_prompt", prompt: "x".repeat(2001) }, "Invalid instruction"],
    [{ ...daily, type: 1, time: "600" }, "between 1 hour"],
    [{ ...daily, time: "* * * * * *" }, "Invalid trigger time"],
    [{ ...daily, time: "0 0 8 * * 1; rm" }, "Invalid trigger time"],
    [{ ...daily, count: 1.5 }, "Invalid repeat count"]
  ])("rejects %o", (input, message) => {
    expect(() => validateAiScheduleInput(input, [])).toThrow(message);
  });

  it("enforces unique names and the per-instance limit", () => {
    expect(() =>
      validateAiScheduleInput(daily, [{ name: "Rapport", kind: "console_report" }])
    ).toThrow(AiScheduleError);
    expect(() =>
      validateAiScheduleInput(
        { ...daily, name: "e" },
        ["a", "b", "c", "d"].map((name) => ({ name, kind: "console_report" }))
      )
    ).toThrow("limit");
  });

  it("treats an empty count as infinite", () => {
    expect(validateAiScheduleInput({ ...daily, count: "" }, []).count).toBe(-1);
    expect(validateAiScheduleInput({ ...daily, count: 0 }, []).count).toBe(-1);
  });
});

describe("AiScheduleService", () => {
  let service: AiScheduleService;

  beforeEach(() => {
    mocks.records.clear();
    mocks.remoteRequest.mockReset();
    mocks.hasInstance.mockReturnValue(true);
    mocks.config.aiEnabled = true;
    Object.values(mocks.localAi).forEach((fn: any) => fn.mockClear());
    mocks.localAi.hasActiveRequest.mockReturnValue(false);
    service = new AiScheduleService();
  });

  async function create(input: Record<string, unknown> = {}) {
    await service.create("owner", "daemon", "instance", { ...daily, ...input });
    const task = service.find("daemon", "instance", String(input.name ?? daily.name))!;
    return task;
  }

  it("queues a console report with the log as trusted context", async () => {
    mocks.remoteRequest.mockResolvedValue("\x1b[31m[ERROR] Could not load plugin\x1b[0m");
    const task = await create();
    expect(await service.run(task)).toBe("queued");
    const [owner, conversation, prompt, options] = mocks.localAi.submit.mock.calls[0] as any[];
    expect([owner, conversation]).toEqual(["owner", "report-1"]);
    expect(prompt).toContain("Rapport");
    expect(options.scheduledContext).toContain("[ERROR] Could not load plugin");
    expect(options.scheduledContext).not.toContain("\x1b");
    expect(mocks.localAi.createConversation).toHaveBeenCalledWith(
      "owner",
      expect.stringContaining("Rapport"),
      { daemonId: "daemon", instanceUuid: "instance" },
      "report"
    );
    options.onFinished("completed");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.list("daemon", "instance")[0].lastStatus).toBe("completed");
  });

  it("writes the report itself when the console is empty", async () => {
    mocks.remoteRequest.mockRejectedValue(new Error("no log"));
    const task = await create();
    expect(await service.run(task)).toBe("completed");
    expect(mocks.localAi.submit).not.toHaveBeenCalled();
    expect(mocks.localAi.appendMessage).toHaveBeenLastCalledWith(
      "owner",
      "report-1",
      expect.stringContaining("Rien à signaler")
    );
  });

  it("disables the task when the owner lost access", async () => {
    const task = await create();
    mocks.hasInstance.mockReturnValue(false);
    expect(await service.run(task)).toBe("skipped");
    expect(task.disabledReason).toBe("access_lost");
    expect(mocks.localAi.createConversation).not.toHaveBeenCalled();
  });

  it("skips the run while the owner has no AI access, without disabling the task", async () => {
    mocks.remoteRequest.mockResolvedValue("log");
    const task = await create();
    mocks.hasAiAccess.mockReturnValue(false);
    expect(await service.run(task)).toBe("skipped");
    expect(task.disabledReason).toBe("");
    expect(mocks.localAi.submit).not.toHaveBeenCalled();
    mocks.hasAiAccess.mockReturnValue(true);
    expect(await service.run(task)).toBe("queued");
  });

  it("skips while the previous run is still pending, and when AI is disabled", async () => {
    mocks.remoteRequest.mockResolvedValue("log");
    const task = await create();
    await service.run(task);
    mocks.localAi.hasActiveRequest.mockReturnValue(true);
    expect(await service.run(task)).toBe("skipped");
    mocks.localAi.hasActiveRequest.mockReturnValue(false);
    mocks.config.aiEnabled = false;
    expect(await service.run(task)).toBe("skipped");
    expect(mocks.localAi.submit).toHaveBeenCalledTimes(1);
  });

  it("deletes a one-shot task after it ran", async () => {
    mocks.remoteRequest.mockResolvedValue("log");
    const task = await create({ count: 1 });
    await (service as any).fire(task);
    expect(service.list("daemon", "instance")).toEqual([]);
    expect(mocks.records.has(`AiScheduleTask:${task.uuid}`)).toBe(false);
  });

  it("removes the tasks of deleted instances", async () => {
    await create();
    await service.removeInstances("daemon", ["instance"]);
    expect(service.list("daemon", "instance")).toEqual([]);
  });

  it("builds the plugin table without model input", () => {
    const table = formatPluginTable([
      {
        name: "Via|Version",
        file: "v.jar",
        installed: "5.0",
        latest: "5.1",
        status: "update_available"
      }
    ]);
    expect(table).toContain("| Via Version | 5.0 | 5.1 | Mise à jour disponible |");
  });
});

describe("crash analysis", () => {
  const crashTask = { name: "Plantages", kind: "crash_analysis", type: 4, time: "", count: -1 };
  const record = (patch: Record<string, unknown> = {}) => ({
    id: `r${Math.random()}`,
    instanceUuid: "instance",
    kind: "exit" as const,
    code: 1,
    error: "",
    at: Date.now(),
    autoRestart: true,
    consoleTail:
      "[03:12:44 ERROR]: Encountered an unexpected exception\n" +
      "This crash report has been saved to: .\\crash-reports\\crash-2026-11-21_03.12.44-server.txt\n",
    ...patch
  });
  let service: AiScheduleService;

  beforeEach(() => {
    mocks.records.clear();
    mocks.remoteRequest.mockReset();
    mocks.hasInstance.mockReturnValue(true);
    mocks.config.aiEnabled = true;
    Object.values(mocks.localAi).forEach((fn: any) => fn.mockClear());
    mocks.localAi.hasActiveRequest.mockReturnValue(false);
    service = new AiScheduleService();
  });

  it("reserves the on-crash trigger to crash analysis, one per instance", () => {
    expect(validateAiScheduleInput(crashTask, [])).toMatchObject({ type: 4, time: "" });
    expect(() => validateAiScheduleInput({ ...crashTask, type: 2 }, [])).toThrow("trigger");
    expect(() => validateAiScheduleInput({ ...daily, type: 4 }, [])).toThrow("trigger");
    expect(() =>
      validateAiScheduleInput({ ...crashTask, name: "Autre" }, [
        { name: "Plantages", kind: "crash_analysis" }
      ])
    ).toThrow("crash analysis");
  });

  it("analyzes a crash with the crash report announced in the console", async () => {
    mocks.remoteRequest.mockImplementation(async (event: string, data: any) =>
      event === "file/edit" && data.target === "/crash-reports/crash-2026-11-21_03.12.44-server.txt"
        ? "---- Minecraft Crash Report ----\nDescription: Ticking entity\nrcon.password=x"
        : Promise.reject(new Error("ENOENT"))
    );
    await service.create("owner", "daemon", "instance", crashTask);
    expect(service.crashTaskDaemons()).toEqual(["daemon"]);
    expect(await service.onCrash("daemon", record())).toBe("queued");
    const [, , prompt, options] = mocks.localAi.submit.mock.calls[0] as any[];
    expect(prompt).toContain("code de sortie 1");
    expect(prompt).toContain("redémarrage automatique : oui");
    const context = JSON.parse(options.scheduledContext);
    expect(context.crashReport.file).toBe("crash-2026-11-21_03.12.44-server.txt");
    expect(context.crashReport.content).toContain("Ticking entity");
    expect(context.crashReport.content).not.toContain("password=x");
    expect(options.scheduledSuffix).toContain("crash-reports/crash-2026-11-21_03.12.44-server.txt");
    expect(mocks.localAi.createConversation.mock.calls[0][1]).toMatch(/^Plantage · /);
  });

  it("ignores a clean stop and does not rate limit the next real crash", async () => {
    mocks.remoteRequest.mockRejectedValue(new Error("ENOENT"));
    await service.create("owner", "daemon", "instance", crashTask);
    const clean = record({
      code: 0,
      consoleTail: "[INFO] Stopping server\n[INFO] Saving worlds\n"
    });
    expect(await service.onCrash("daemon", clean)).toBe("skipped");
    expect(mocks.localAi.createConversation).not.toHaveBeenCalled();
    expect(await service.onCrash("daemon", record())).toBe("queued");
  });

  it("rate limits crash loops", async () => {
    mocks.remoteRequest.mockRejectedValue(new Error("ENOENT"));
    await service.create("owner", "daemon", "instance", crashTask);
    expect(await service.onCrash("daemon", record())).toBe("queued");
    expect(await service.onCrash("daemon", record())).toBe("skipped");
    expect(mocks.localAi.submit).toHaveBeenCalledTimes(1);
  });

  it("does nothing for instances without a crash analysis task", async () => {
    await service.create("owner", "daemon", "instance", daily);
    expect(service.crashTaskDaemons()).toEqual([]);
    expect(await service.onCrash("daemon", record())).toBeNull();
  });

  it("reports start failures", async () => {
    mocks.remoteRequest.mockRejectedValue(new Error("ENOENT"));
    await service.create("owner", "daemon", "instance", crashTask);
    await service.onCrash(
      "daemon",
      record({ kind: "start_failure", code: null, error: "java: not found", consoleTail: "" })
    );
    expect((mocks.localAi.submit.mock.calls[0] as any[])[2]).toContain("Échec du démarrage à");
  });
});
