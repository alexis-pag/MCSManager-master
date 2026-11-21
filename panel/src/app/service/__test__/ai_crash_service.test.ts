import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  onCrash: vi.fn(async () => "queued"),
  daemons: ["d1", "d2"]
}));

vi.mock("../log", () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("../ai_schedule_service", () => ({
  default: { crashTaskDaemons: () => mocks.daemons, onCrash: mocks.onCrash }
}));
vi.mock("../remote_service", () => ({
  default: { getInstance: (id: string) => ({ available: true, id }) }
}));
vi.mock("../remote_command", () => ({
  default: class {
    constructor(private remote: any) {}
    request(event: string, data: any) {
      return mocks.request(this.remote.id, event, data);
    }
  }
}));

import { AiCrashService } from "../ai_crash_service";

const record = (id: string, at: number) => ({
  id,
  instanceUuid: "i",
  kind: "exit",
  code: 1,
  error: "",
  at,
  autoRestart: false,
  consoleTail: ""
});

describe("AiCrashService", () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.onCrash.mockClear();
  });

  it("hands each crash to the schedule service once and moves `since` forward", async () => {
    const now = Date.now();
    mocks.request.mockImplementation(async (daemon: string) =>
      daemon === "d1" ? [record("a", now - 1000), record("b", now)] : []
    );
    const service = new AiCrashService();
    await service.poll(now);
    await service.poll(now + 20000);
    expect(mocks.onCrash.mock.calls.map((call: any[]) => [call[0], call[1].id])).toEqual([
      ["d1", "a"],
      ["d1", "b"]
    ]);
    // Second poll asks for records after the newest one seen (with a small overlap).
    const secondCall = mocks.request.mock.calls.filter((call) => call[0] === "d1")[1];
    expect(secondCall[2].since).toBeGreaterThan(now - 10000);
  });

  it("skips daemons that do not support the route", async () => {
    mocks.request.mockImplementation(async (daemon: string) => {
      if (daemon === "d1") throw new Error("Unknown event");
      return [record("c", Date.now())];
    });
    await new AiCrashService().poll();
    expect(mocks.onCrash).toHaveBeenCalledTimes(1);
    expect((mocks.onCrash.mock.calls[0] as any[])[0]).toBe("d2");
  });
});
