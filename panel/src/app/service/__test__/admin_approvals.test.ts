import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const users = new Map<string, any>();
  return {
    users,
    records: new Map<string, any>(),
    remoteCalls: [] as Array<{ event: string; data: any }>,
    daemonTasks: new Map<string, any[]>(),
    registerError: null as Error | null,
    hasInstance: vi.fn(() => true),
    operationLog: vi.fn(),
    logSearch: vi.fn(async () => ({ data: [] as any[], maxPage: 1 })),
    aiTasks: [] as any[],
    config: {
      automationApprovalMigrated: false,
      automationApprovalMigratedDaemons: [] as string[]
    } as any,
    remoteServices: new Map<string, any>([["daemon", { available: true }]])
  };
});

vi.mock("../log", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("../../setting", () => ({ systemConfig: mocks.config }));
vi.mock("../user_service", () => ({
  default: {
    getInstance: (uuid: string) => mocks.users.get(uuid) || null,
    getUserByUserName: (name: string) =>
      [...mocks.users.values()].find((user) => user.userName === name) || null
  }
}));
vi.mock("../permission_service", () => ({ isHaveInstance: mocks.hasInstance }));
vi.mock("../instance_name_service", () => ({ getInstanceNameSafely: async () => "Survie" }));
vi.mock("../operation_logger", () => ({
  operationLogger: { log: mocks.operationLog, search: mocks.logSearch }
}));
vi.mock("../remote_service", () => ({
  default: {
    getInstance: (id: string) => mocks.remoteServices.get(id),
    services: mocks.remoteServices
  }
}));
vi.mock("../remote_command", () => ({
  default: class {
    async request(event: string, data: any) {
      mocks.remoteCalls.push({ event, data });
      const tasks = mocks.daemonTasks.get(data?.instanceUuid) || [];
      if (event === "instance/overview") {
        return [...mocks.daemonTasks.keys()].map((instanceUuid) => ({ instanceUuid }));
      }
      if (event === "schedule/list") return tasks;
      if (event === "schedule/delete") {
        mocks.daemonTasks.set(
          data.instanceUuid,
          tasks.filter((task) => task.name !== data.name)
        );
        return true;
      }
      if (event === "schedule/register") {
        if (mocks.registerError) {
          // One-shot rejection: the following restore succeeds.
          const error = mocks.registerError;
          mocks.registerError = null;
          throw error;
        }
        const { instanceUuid, ...task } = data;
        mocks.daemonTasks.set(instanceUuid, [...tasks, task]);
        return true;
      }
      return null;
    }
  }
}));
vi.mock("../ai_schedule_service", () => {
  const find = (daemonId: string, instanceUuid: string, name: string) =>
    mocks.aiTasks.find(
      (task) =>
        task.daemonId === daemonId && task.instanceUuid === instanceUuid && task.name === name
    );
  const validate = (input: any, existing: Array<{ name: string }>) => {
    const name = String(input?.name ?? "").trim();
    if (!name) throw new Error("Invalid task name");
    if (existing.some((task) => task.name === name)) {
      throw new Error("A task with this name exists");
    }
    return {
      name,
      kind: String(input.kind),
      prompt: String(input.prompt ?? ""),
      type: Number(input.type),
      time: String(input.time ?? ""),
      count: Number(input.count ?? -1)
    };
  };
  const list = (daemonId: string, instanceUuid: string) =>
    mocks.aiTasks.filter(
      (task) => task.daemonId === daemonId && task.instanceUuid === instanceUuid
    );
  return {
    validateAiScheduleInput: validate,
    default: {
      list,
      find,
      allTasks: () => [...mocks.aiTasks],
      create: async (owner: string, daemonId: string, instanceUuid: string, input: any) => {
        const task = {
          ...validate(input, list(daemonId, instanceUuid)),
          ownerUserUuid: owner,
          daemonId,
          instanceUuid
        };
        mocks.aiTasks.push(task);
        return task;
      },
      remove: async (daemonId: string, instanceUuid: string, name: string) => {
        const task = find(daemonId, instanceUuid, name);
        if (task) mocks.aiTasks.splice(mocks.aiTasks.indexOf(task), 1);
        return !!task;
      }
    }
  };
});
vi.mock("../../common/storage/sys_storage", () => ({
  default: {
    getStorage: () => ({
      store: async (category: string, uuid: string, object: unknown) => {
        mocks.records.set(`${category}:${uuid}`, JSON.parse(JSON.stringify(object)));
      },
      load: async () => null,
      list: async () => [],
      delete: async (category: string, uuid: string) => {
        mocks.records.delete(`${category}:${uuid}`);
      }
    })
  }
}));

import aiAccess, {
  ACCESS_RETRY_MS,
  AiAccessService,
  isAccessFreeAiPath
} from "../ai_access_service";
import { AutomationMigration } from "../automation_migration";
import automationRequests, { AutomationRequestService } from "../automation_request_service";

const admin = { uuid: "admin", userName: "root", permission: 10 } as any;
const alice = { uuid: "alice", userName: "alice", permission: 1 } as any;
const bob = { uuid: "bob", userName: "bob", permission: 1 } as any;
const restart = {
  name: "Restart",
  count: -1,
  time: "0 0 4 * * *",
  type: 2,
  actions: [{ type: "restart", payload: "" }]
};
const reason = "I need help with my server configs";

function resetState() {
  mocks.users.clear();
  [admin, alice, bob].forEach((user) => mocks.users.set(user.uuid, user));
  mocks.records.clear();
  mocks.remoteCalls.length = 0;
  mocks.daemonTasks.clear();
  mocks.registerError = null;
  mocks.aiTasks.length = 0;
  mocks.hasInstance.mockReturnValue(true);
  mocks.operationLog.mockClear();
  mocks.logSearch.mockResolvedValue({ data: [], maxPage: 1 });
  mocks.config.automationApprovalMigrated = false;
  mocks.config.automationApprovalMigratedDaemons = [];
  // The services are singletons wired to each other: clear their in-memory state.
  (aiAccess as any).cache.clear();
  (automationRequests as any).requests.clear();
}

describe("AI access", () => {
  beforeEach(resetState);

  it("grants administrators and refuses regular users without a grant", () => {
    expect(aiAccess.hasAccess(admin)).toBe(true);
    expect(aiAccess.hasAccess(alice)).toBe(false);
    expect(aiAccess.view(alice).state).toBe("none");
  });

  it("validates the reason and refuses duplicate requests", async () => {
    await expect(aiAccess.request(alice, "short")).rejects.toThrow("Reason length");
    await expect(aiAccess.request(alice, "x".repeat(301))).rejects.toThrow("Reason length");
    await expect(aiAccess.request(admin, reason)).rejects.toThrow();
    expect((await aiAccess.request(alice, reason)).state).toBe("pending");
    await expect(aiAccess.request(alice, reason)).rejects.toThrow("Request already pending");
    expect(aiAccess.countPending()).toBe(1);
  });

  it("grants, logs the decision, then revokes", async () => {
    await aiAccess.request(alice, reason);
    await aiAccess.decide(admin, "alice", "grant", "ok", "1.2.3.4");
    expect(aiAccess.hasAccess(alice)).toBe(true);
    expect(aiAccess.countPending()).toBe(0);
    expect(mocks.operationLog).toHaveBeenCalledWith(
      "admin_approval",
      expect.objectContaining({
        operator_name: "root",
        target_user_name: "alice",
        subject: "ai_access",
        decision: "grant",
        note: "ok"
      }),
      "info"
    );
    await aiAccess.decide(admin, "alice", "revoke", "abuse");
    expect(aiAccess.hasAccess(alice)).toBe(false);
    expect(aiAccess.view(alice)).toMatchObject({ state: "revoked", note: "abuse" });
  });

  it("lets a refused or revoked user ask again only after 24 hours", async () => {
    await aiAccess.request(alice, reason);
    await aiAccess.decide(admin, "alice", "refuse", "not now");
    const refusedAt = Date.parse(aiAccess.view(alice).decidedAt!);
    await expect(aiAccess.request(alice, reason, refusedAt + 1000)).rejects.toThrow("Retry later");
    await aiAccess.request(alice, reason, refusedAt + ACCESS_RETRY_MS + 1);
    await aiAccess.decide(admin, "alice", "grant", "");
    await aiAccess.decide(admin, "alice", "revoke", "");
    const revokedAt = Date.parse(aiAccess.view(alice).decidedAt!);
    await expect(aiAccess.request(alice, reason, revokedAt + 1000)).rejects.toThrow("Retry later");
  });

  it("rejects decisions from regular users and invalid transitions", async () => {
    await aiAccess.request(alice, reason);
    await expect(aiAccess.decide(bob, "alice", "grant", "")).rejects.toThrow("Forbidden");
    await expect(aiAccess.decide(admin, "alice", "revoke", "")).rejects.toThrow("Invalid decision");
    await expect(aiAccess.decide(admin, "admin", "grant", "")).rejects.toThrow();
  });

  it("hides requests of deleted users", async () => {
    await aiAccess.request(alice, reason);
    mocks.users.delete("alice");
    expect(aiAccess.countPending()).toBe(0);
    expect(aiAccess.listAll()).toEqual([]);
  });

  it("leaves only status, the access request and ban requests open without AI access", () => {
    for (const path of [
      "/api/ai/status",
      "/api/ai/access",
      "/api/ai/bans",
      "/api/ai/bans/case/x"
    ]) {
      expect(isAccessFreeAiPath(path)).toBe(true);
    }
    for (const path of [
      "/api/ai/conversations",
      "/api/ai/conversations/x/generate",
      "/api/ai/schedules",
      "/api/ai/schedules/run",
      "/api/ai/queue",
      "/api/ai/statuses",
      "/api/ai/accessories"
    ]) {
      expect(isAccessFreeAiPath(path)).toBe(false);
    }
  });

  it("loads stored records on startup", async () => {
    const service = new AiAccessService();
    await service.initialize();
    expect(service.hasAccess(alice)).toBe(false);
  });
});

describe("automation requests", () => {
  beforeEach(resetState);

  const submitSchedule = (body: any = restart, replaces = "") =>
    automationRequests.submit(alice, "schedule", "daemon", "inst", body, replaces);

  it("stores a pending request and registers nothing on the daemon", async () => {
    const request = await submitSchedule();
    expect(request).toMatchObject({ state: "pending", origin: "new", requesterName: "alice" });
    expect(mocks.records.get(`AutomationRequest:${request.uuid}`)?.state).toBe("pending");
    expect(mocks.remoteCalls.filter((call) => call.event === "schedule/register")).toEqual([]);
    expect(automationRequests.countPending()).toBe(1);
  });

  it("refuses ban commands and duplicate pending names", async () => {
    await expect(
      submitSchedule({ ...restart, actions: [{ type: "command", payload: "/ban Steve" }] })
    ).rejects.toMatchObject({ status: 403 });
    await submitSchedule();
    await expect(submitSchedule()).rejects.toThrow("already pending");
  });

  it("registers exactly the requested schedule on approval and logs it", async () => {
    const request = await submitSchedule();
    await automationRequests.decide(admin, request.uuid, "approve", "", "1.2.3.4");
    expect(mocks.daemonTasks.get("inst")).toEqual([
      {
        name: "Restart",
        count: -1,
        time: "0 0 4 * * *",
        type: 2,
        actions: [{ type: "restart", payload: "" }]
      }
    ]);
    expect(automationRequests.countPending()).toBe(0);
    expect(mocks.operationLog).toHaveBeenCalledWith(
      "admin_approval",
      expect.objectContaining({ subject: "schedule", decision: "approve", task_name: "Restart" }),
      "info"
    );
    await expect(automationRequests.decide(admin, request.uuid, "refuse", "")).rejects.toThrow(
      "already decided"
    );
  });

  it("fails the approval when the requester lost the instance", async () => {
    const request = await submitSchedule();
    mocks.hasInstance.mockReturnValue(false);
    await expect(automationRequests.decide(admin, request.uuid, "approve", "")).rejects.toThrow(
      "no longer has access"
    );
    expect(mocks.daemonTasks.get("inst")).toBeUndefined();
    expect(automationRequests.listPending()[0]).toMatchObject({
      state: "pending",
      error: expect.stringContaining("no longer has access")
    });
  });

  it("keeps the edited schedule active until the new version is approved", async () => {
    mocks.daemonTasks.set("inst", [{ ...restart }]);
    const request = await submitSchedule(
      { ...restart, name: "Restart2", time: "0 0 5 * * *" },
      "Restart"
    );
    expect(request.origin).toBe("edit");
    expect(mocks.daemonTasks.get("inst")!.map((task) => task.name)).toEqual(["Restart"]);
    await automationRequests.decide(admin, request.uuid, "approve", "");
    expect(mocks.daemonTasks.get("inst")!.map((task) => task.name)).toEqual(["Restart2"]);
  });

  it("restores the edited schedule when the daemon rejects the new one", async () => {
    mocks.daemonTasks.set("inst", [{ ...restart }]);
    const request = await submitSchedule({ ...restart, time: "0 0 5 * * *" }, "Restart");
    mocks.registerError = new Error("limit");
    await expect(automationRequests.decide(admin, request.uuid, "approve", "")).rejects.toThrow(
      "limit"
    );
    expect(mocks.daemonTasks.get("inst")).toEqual([
      expect.objectContaining({ name: "Restart", time: "0 0 4 * * *" })
    ]);
    expect(automationRequests.listPending()[0].error).toBe("limit");
  });

  it("refuses with a note visible to the requester, who can dismiss it", async () => {
    const request = await submitSchedule();
    await automationRequests.decide(admin, request.uuid, "refuse", "too often");
    expect(automationRequests.list(alice, "daemon", "inst")).toEqual([
      expect.objectContaining({ state: "refused", note: "too often" })
    ]);
    expect(automationRequests.list(bob, "daemon", "inst")).toEqual([]);
    expect(automationRequests.list(admin, "daemon", "inst")).toHaveLength(1);
    await automationRequests.cancel(alice, request.uuid);
    expect(automationRequests.list(alice, "daemon", "inst")).toEqual([]);
  });

  it("lets only the requester (or an administrator) cancel a pending request", async () => {
    const request = await submitSchedule();
    await expect(automationRequests.cancel(bob, request.uuid)).rejects.toMatchObject({
      status: 404
    });
    await automationRequests.cancel(alice, request.uuid);
    expect(automationRequests.countPending()).toBe(0);
    await expect(automationRequests.decide(admin, request.uuid, "approve", "")).rejects.toThrow(
      "already decided"
    );
  });

  it("requires AI access of the requester to approve an AI task", async () => {
    const request = await automationRequests.submit(alice, "ai_task", "daemon", "inst", {
      name: "Report",
      kind: "console_report",
      type: 2,
      time: "0 0 8 * * *",
      count: -1
    });
    await expect(automationRequests.decide(admin, request.uuid, "approve", "")).rejects.toThrow(
      "no AI access"
    );
    await aiAccess.request(alice, reason);
    await aiAccess.decide(admin, "alice", "grant", "");
    await automationRequests.decide(admin, request.uuid, "approve", "");
    expect(mocks.aiTasks).toEqual([
      expect.objectContaining({ name: "Report", ownerUserUuid: "alice" })
    ]);
  });

  it("refuses approvals and decisions from regular users", async () => {
    const request = await submitSchedule();
    await expect(automationRequests.decide(bob, request.uuid, "approve", "")).rejects.toThrow(
      "Forbidden"
    );
  });

  it("deletes decided requests after 30 days but keeps pending ones", async () => {
    const pending = await submitSchedule();
    const refused = await submitSchedule({ ...restart, name: "Other" });
    await automationRequests.decide(admin, refused.uuid, "refuse", "");
    await automationRequests.cleanup(Date.now() + 31 * 24 * 60 * 60 * 1000);
    expect(mocks.records.has(`AutomationRequest:${refused.uuid}`)).toBe(false);
    expect(mocks.records.has(`AutomationRequest:${pending.uuid}`)).toBe(true);
  });

  it("starts empty from storage", async () => {
    const service = new AutomationRequestService();
    await service.initialize();
    expect(service.countPending()).toBe(0);
  });
});

describe("migration of existing automations", () => {
  beforeEach(resetState);

  it("suspends AI tasks of regular users and unknown owners, keeps administrators' ones", async () => {
    const base = { daemonId: "daemon", instanceUuid: "inst", kind: "console_report", prompt: "" };
    mocks.aiTasks.push(
      { ...base, name: "Mine", ownerUserUuid: "admin", type: 2, time: "0 0 8 * * *", count: -1 },
      { ...base, name: "Hers", ownerUserUuid: "alice", type: 2, time: "0 0 9 * * *", count: -1 },
      { ...base, name: "Ghost", ownerUserUuid: "gone", type: 2, time: "0 0 7 * * *", count: -1 }
    );
    await new AutomationMigration().migrateAiTasks();
    expect(mocks.aiTasks.map((task) => task.name)).toEqual(["Mine"]);
    const requests = automationRequests.listPending();
    expect(
      requests.map((request) => [request.name, request.requesterName, request.origin])
    ).toEqual(
      expect.arrayContaining([
        ["Hers", "alice", "migration"],
        ["Ghost", "", "migration"]
      ])
    );
    expect(mocks.config.automationApprovalMigrated).toBe(true);
  });

  it("suspends schedules of regular users and unknown creators, keeps administrators' ones", async () => {
    mocks.daemonTasks.set("inst", [
      { ...restart, name: "ByAdmin" },
      { ...restart, name: "ByAlice", actions: [{ type: "command", payload: "ban Steve" }] },
      { ...restart, name: "Unknown" }
    ]);
    mocks.logSearch.mockResolvedValue({
      data: [
        { instance_id: "inst", task_name: "ByAdmin", operator_name: "root" },
        { instance_id: "inst", task_name: "ByAlice", operator_name: "alice" }
      ],
      maxPage: 1
    });
    await new AutomationMigration().migrateDaemons();
    expect(mocks.daemonTasks.get("inst")!.map((task) => task.name)).toEqual(["ByAdmin"]);
    const requests = automationRequests.listPending();
    expect(requests.map((request) => [request.name, request.requesterName])).toEqual(
      expect.arrayContaining([
        ["ByAlice", "alice"],
        ["Unknown", ""]
      ])
    );
    expect(mocks.config.automationApprovalMigratedDaemons).toEqual(["daemon"]);

    // An approved migrated request with an unknown creator is registered again; the ban
    // command of the suspended schedule is still refused at approval.
    const unknown = requests.find((request) => request.name === "Unknown")!;
    await automationRequests.decide(admin, unknown.uuid, "approve", "");
    const banned = requests.find((request) => request.name === "ByAlice")!;
    await expect(automationRequests.decide(admin, banned.uuid, "approve", "")).rejects.toThrow(
      "Ban commands"
    );
    expect(mocks.daemonTasks.get("inst")!.map((task) => task.name)).toEqual(["ByAdmin", "Unknown"]);
  });

  it("removes a schedule from the daemon only after its request is stored", async () => {
    mocks.daemonTasks.set("inst", [{ ...restart, name: "Bad/Name" }]);
    await new AutomationMigration().migrateDaemons();
    // The request could not be stored (invalid name): the schedule stays on the daemon.
    expect(mocks.daemonTasks.get("inst")!.map((task) => task.name)).toEqual(["Bad/Name"]);
    expect(mocks.remoteCalls.some((call) => call.event === "schedule/delete")).toBe(false);
  });

  it("migrates each daemon once", async () => {
    mocks.config.automationApprovalMigratedDaemons = ["daemon"];
    mocks.daemonTasks.set("inst", [{ ...restart }]);
    await new AutomationMigration().migrateDaemons();
    expect(mocks.remoteCalls).toEqual([]);
  });
});
