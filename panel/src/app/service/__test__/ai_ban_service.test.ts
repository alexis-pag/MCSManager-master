import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  records: new Map<string, any>(),
  remoteRequest: vi.fn(),
  hasInstance: vi.fn(() => true),
  config: { aiEnabled: true, aiVisionEnabled: false } as any,
  log: vi.fn(),
  localAi: {
    createConversation: vi.fn(async () => ({ uuid: "report-1" })),
    submit: vi.fn(async () => ({ uuid: "request-1" }))
  }
}));

vi.mock("../../setting", () => ({ systemConfig: mocks.config }));
vi.mock("../log", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("../permission_service", () => ({ isHaveInstance: mocks.hasInstance }));
vi.mock("../operation_logger", () => ({ operationLogger: { log: mocks.log } }));
vi.mock("../instance_name_service", () => ({ getInstanceNameSafely: async () => "Survie" }));
vi.mock("../local_ai_service", () => {
  return {
    default: mocks.localAi,
    parseJsonObject: (text: unknown) => {
      if (typeof text !== "string") return null;
      try {
        return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      } catch {
        return null;
      }
    }
  };
});
vi.mock("../remote_service", () => ({ default: { getInstance: () => ({ available: true }) } }));
vi.mock("../remote_command", () => ({
  default: class {
    request = mocks.remoteRequest;
  }
}));
vi.mock("fs-extra", () => ({
  default: { outputFile: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) }
}));
vi.mock("../../common/storage/sys_storage", () => ({
  default: {
    getStorage: () => ({
      store: async (category: string, uuid: string, object: any) => {
        mocks.records.set(`${category}:${uuid}`, JSON.parse(JSON.stringify(object)));
      },
      load: async (category: string, classz: any, uuid: string) => {
        const raw = mocks.records.get(`${category}:${uuid}`);
        return raw ? Object.assign(new classz(), raw) : null;
      },
      list: async (category: string) =>
        [...mocks.records.keys()]
          .filter((key) => key.startsWith(`${category}:`))
          .map((key) => key.slice(category.length + 1)),
      delete: async (category: string, uuid: string) => {
        mocks.records.delete(`${category}:${uuid}`);
      }
    })
  }
}));

import {
  AiBanService,
  buildBanCommand,
  decodeEvidenceImage,
  linesMentioning,
  parseVerdict,
  validateReason,
  verifyLogLines
} from "../ai_ban_service";

const LOG = [
  "\x1b[33m[12:00:01 INFO]: <Griefer> lol je casse tout\x1b[0m",
  "[12:00:05 INFO]: Griefer issued server command: /fill ~ ~ ~ ~10 ~10 ~10 tnt",
  "[12:00:09 INFO]: <Bob> arrête Griefer !",
  "[12:01:00 INFO]: Alice joined the game",
  "[12:01:02 INFO]: <GrieferFan> salut"
].join("\r\n");

const admin = { uuid: "admin", userName: "root", permission: 10 } as any;
const alice = { uuid: "alice", userName: "alice", permission: 1 } as any;

describe("validation helpers", () => {
  it("rejects placeholder or too short reasons", () => {
    for (const reason of [
      "test test test test",
      "parce que parce que",
      "no reason no reason",
      "aaaaaaaaaaaaaaaaaa",
      "court",
      "x".repeat(201)
    ]) {
      expect(() => validateReason(reason), reason).toThrow();
    }
    expect(validateReason("  Griefing de la base de Bob\navec de la TNT ")).toBe(
      "Griefing de la base de Bob avec de la TNT"
    );
  });

  it("finds console lines mentioning the player as a whole word", () => {
    expect(linesMentioning(LOG, "Griefer")).toEqual([
      "[12:00:01 INFO]: <Griefer> lol je casse tout",
      "[12:00:05 INFO]: Griefer issued server command: /fill ~ ~ ~ ~10 ~10 ~10 tnt",
      "[12:00:09 INFO]: <Bob> arrête Griefer !"
    ]);
  });

  it("drops submitted lines that are not in the log", () => {
    expect(
      verifyLogLines(
        ["[12:00:01 INFO]: <Griefer> lol je casse tout", "[12:00:02 INFO]: <Griefer> j'ai hacké"],
        LOG
      )
    ).toEqual(["[12:00:01 INFO]: <Griefer> lol je casse tout"]);
  });

  it("accepts real images only", () => {
    const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(16)]);
    expect(decodeEvidenceImage(`data:image/png;base64,${png.toString("base64")}`).ext).toBe("png");
    const html = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");
    expect(() => decodeEvidenceImage(`data:image/png;base64,${html}`)).toThrow("Invalid image");
    expect(() => decodeEvidenceImage(`data:image/svg+xml;base64,${html}`)).toThrow();
    const big = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]).toString("base64");
    expect(() => decodeEvidenceImage(`data:image/png;base64,${big}`)).toThrow("Image too large");
  });

  it("never treats an unclear answer as justified", () => {
    expect(parseVerdict("Je pense que oui.").verdict).toBe("insufficient_evidence");
    expect(parseVerdict('{"verdict":"maybe","explanation":"x"}').verdict).toBe(
      "insufficient_evidence"
    );
    expect(
      parseVerdict('```json\n{"verdict":"justified","sanction":"ban","explanation":"Grief."}\n```')
    ).toMatchObject({ verdict: "justified", sanction: "ban", parsed: true });
  });

  it("builds the command from validated fields only", () => {
    expect(buildBanCommand("Griefer", "Griefing de la base avec TNT")).toBe(
      "ban Griefer Griefing de la base avec TNT"
    );
    expect(() => buildBanCommand("Griefer; stop", "Griefing de la base avec TNT")).toThrow();
  });
});

describe("AiBanService", () => {
  let service: AiBanService;
  let status = 3;

  beforeEach(() => {
    mocks.records.clear();
    mocks.log.mockReset();
    mocks.localAi.submit.mockClear();
    mocks.hasInstance.mockReturnValue(true);
    status = 3;
    mocks.remoteRequest.mockReset();
    mocks.remoteRequest.mockImplementation(async (event: string) => {
      if (event === "instance/detail") return { status, config: { type: "minecraft/java/paper" } };
      if (event === "instance/outputlog") return LOG;
      if (event === "instance/command") return true;
      return null;
    });
    service = new AiBanService();
  });

  const request = {
    player: "Griefer",
    reason: "Griefing de la base de Bob avec de la TNT",
    description: "",
    logLines: ["[12:00:05 INFO]: Griefer issued server command: /fill ~ ~ ~ ~10 ~10 ~10 tnt"]
  };

  async function reviewed(verdict: string) {
    const banCase = await service.create(alice, "daemon", "instance", request);
    const options = (mocks.localAi.submit.mock.calls.at(-1) as any[])[3];
    const text = options.transformAnswer(
      JSON.stringify({ verdict, sanction: "ban", explanation: "Explication." })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { banCase, text, options };
  }

  it("submits verified evidence to a moderation review without tools", async () => {
    const { options, text } = await reviewed("justified");
    expect(options.moderationSystemPrompt).toContain("impartial moderator");
    expect(JSON.parse(options.scheduledContext)).toMatchObject({
      player: "Griefer",
      verifiedLogLines: request.logLines
    });
    expect(text).toContain("Ban justifié");
  });

  it("requires evidence", async () => {
    await expect(
      service.create(alice, "daemon", "instance", { ...request, logLines: ["fake line"] })
    ).rejects.toThrow("Evidence required");
  });

  it("refuses non-Java servers and inaccessible instances", async () => {
    mocks.remoteRequest.mockImplementation(async (event: string) =>
      event === "instance/detail" ? { status: 3, config: { type: "minecraft/bedrock" } } : LOG
    );
    await expect(service.create(alice, "daemon", "instance", request)).rejects.toThrow("Java");
    mocks.hasInstance.mockReturnValue(false);
    await expect(service.create(alice, "daemon", "instance", request)).rejects.toThrow("Forbidden");
  });

  it("only one review at a time per requester", async () => {
    await service.create(alice, "daemon", "instance", request);
    await expect(service.create(alice, "daemon", "instance", request)).rejects.toThrow(
      "Review in progress"
    );
  });

  it("applies a justified ban with a panel-built command", async () => {
    const { banCase } = await reviewed("justified");
    const applied = await service.apply(alice, banCase.uuid);
    expect(applied.state).toBe("applied");
    expect(mocks.remoteRequest).toHaveBeenCalledWith(
      "instance/command",
      {
        instanceUuid: "instance",
        command: "ban Griefer Griefing de la base de Bob avec de la TNT"
      },
      10000
    );
    // The daemon's ban guard is told first, so it does not revert this authorized ban.
    const events = mocks.remoteRequest.mock.calls.map((call: any[]) => call[0]);
    expect(events.indexOf("ban_guard/allow")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("ban_guard/allow")).toBeLessThan(events.lastIndexOf("instance/command"));
    expect(mocks.remoteRequest).toHaveBeenCalledWith(
      "ban_guard/allow",
      { instanceUuid: "instance", target: "Griefer" },
      10000
    );
    expect(mocks.log).toHaveBeenCalledWith(
      "instance_player_ban",
      expect.objectContaining({ player: "Griefer", verdict: "justified" }),
      "info"
    );
  });

  it("blocks a regular user when the AI says no, lets an admin override with a note", async () => {
    const { banCase } = await reviewed("not_justified");
    await expect(service.apply(alice, banCase.uuid)).rejects.toThrow("Ban not justified");
    await expect(service.apply(admin, banCase.uuid, "trop court")).rejects.toThrow(
      "Override note required"
    );
    const applied = await service.apply(
      admin,
      banCase.uuid,
      "Vu en direct par deux modérateurs, récidive."
    );
    expect(applied.overrideNote).toContain("récidive");
    expect(mocks.log).toHaveBeenCalledWith(
      "instance_player_ban",
      expect.objectContaining({ override_note: expect.stringContaining("récidive") }),
      "warning"
    );
  });

  it("refuses to apply while the server is stopped", async () => {
    const { banCase } = await reviewed("justified");
    status = 0;
    await expect(service.apply(alice, banCase.uuid)).rejects.toThrow("not running");
  });

  it("hides other users' cases from regular users", async () => {
    const { banCase } = await reviewed("justified");
    const bob = { uuid: "bob", userName: "bob", permission: 1 } as any;
    await expect(service.get(bob, banCase.uuid)).rejects.toThrow("Not found");
    expect(await service.list(bob, "daemon", "instance")).toEqual([]);
    expect((await service.list(admin, "daemon", "instance")).length).toBe(1);
  });

  it("deletes cases after 90 days", async () => {
    const { banCase } = await reviewed("justified");
    expect(await service.purgeExpired(Date.now() + 91 * 24 * 3600 * 1000)).toBe(1);
    expect(mocks.records.has(`AiBanCase:${banCase.uuid}`)).toBe(false);
  });
});
