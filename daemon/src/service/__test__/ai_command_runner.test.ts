import { EventEmitter } from "events";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workspace: "",
  actions: [] as any[],
  behaviour: "succeed" as "succeed" | "fail" | "hang",
  downloadContent: "installer",
  downloads: [] as string[]
}));

vi.mock("../log", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../utils/url", () => ({ checkSafeUrl: async () => true }));
vi.mock("../file_router_service", async () => {
  const { default: FileManager } = await import("../system_file");
  return { getFileManager: () => new FileManager(mocks.workspace) };
});
vi.mock("../download_manager", () => ({
  default: {
    downloadFromUrl: async (url: string, target: string) => {
      mocks.downloads.push(url);
      await (await import("fs-extra")).default.writeFile(target, mocks.downloadContent);
    }
  }
}));
vi.mock("../instance_update_action", () => ({
  InstanceUpdateAction: class {
    stopped = false;
    private finish!: () => void;
    private fail!: (error: Error) => void;
    private done = new Promise<void>((resolve, reject) => {
      this.finish = resolve;
      this.fail = reject;
    });
    constructor(public instance: any, public command: string) {
      mocks.actions.push(this);
    }
    async start() {
      this.instance.emit("data", "\u001b[32mInstalling\u001b[0m\r\nThe server installed successfully\n");
      if (mocks.behaviour === "succeed") this.finish();
      if (mocks.behaviour === "fail") this.fail(new Error("Update failed"));
    }
    wait() {
      return this.done;
    }
    async stop() {
      this.stopped = true;
      this.finish();
    }
  }
}));
vi.mock("../../entity/instance/instance", () => ({
  default: class Instance {
    static readonly STATUS_BUSY = -1;
    static readonly STATUS_STOP = 0;
    static readonly STATUS_RUNNING = 3;
  }
}));

import {
  outputTail,
  runAiCommand,
  validateAiCommand,
  validatePrepare
} from "../ai_command_runner";

class FakeInstance extends EventEmitter {
  instanceUuid = "instance-1";
  asynchronousTask: any = undefined;
  locked = false;
  private current = 0;
  status(value?: number) {
    if (value != null) this.current = value;
    return this.current;
  }
  setLock(value: boolean) {
    this.locked = value;
  }
}

const sha256 = (text: string) =>
  require("crypto").createHash("sha256").update(text).digest("hex") as string;
const forge = "https://maven.minecraftforge.net/net/minecraftforge/forge/26.3-66.1.9/forge-26.3-66.1.9-installer.jar";

beforeAll(async () => {
  mocks.workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcsm-ai-command-"));
});
afterAll(async () => {
  await fs.remove(mocks.workspace);
});
beforeEach(() => {
  mocks.actions.length = 0;
  mocks.downloads.length = 0;
  mocks.behaviour = "succeed";
  mocks.downloadContent = "installer";
});

describe("AI command validation", () => {
  it("accepts one printable line and refuses the rest", () => {
    expect(validateAiCommand("  java -jar a.jar --installServer ")).toBe(
      "java -jar a.jar --installServer"
    );
    expect(() => validateAiCommand("")).toThrow();
    expect(() => validateAiCommand("a\nb")).toThrow();
    expect(() => validateAiCommand("x".repeat(1001))).toThrow();
    expect(() => validateAiCommand(42)).toThrow();
  });

  it("only downloads installers from the official repositories over HTTPS", () => {
    const sha = "a".repeat(64);
    expect(validatePrepare({ url: forge, fileName: "forge-installer.jar", sha256: sha })).toEqual({
      url: forge,
      fileName: "forge-installer.jar",
      sha256: sha
    });
    expect(() =>
      validatePrepare({ url: "https://evil.example/x.jar", fileName: "x.jar", sha256: sha })
    ).toThrow("Invalid installer URL");
    expect(() =>
      validatePrepare({ url: forge.replace("https", "http"), fileName: "x.jar", sha256: sha })
    ).toThrow("Invalid installer URL");
    expect(() => validatePrepare({ url: forge, fileName: "../x.jar", sha256: sha })).toThrow(
      "Invalid installer file name"
    );
    expect(() => validatePrepare({ url: forge, fileName: "x.jar", sha256: "abc" })).toThrow(
      "Invalid checksum"
    );
  });

  it("keeps the last output lines without terminal codes", () => {
    expect(outputTail("\u001b[1mA\u001b[0m\r\n\nB\nC", 2)).toBe("B\nC");
  });
});

describe("runAiCommand", () => {
  it("runs the command while the instance is stopped and restores its state", async () => {
    const instance = new FakeInstance();
    const result = await runAiCommand(instance as any, { command: "java -version" });
    expect(result).toMatchObject({ success: true, timedOut: false, error: "" });
    expect(result.output).toBe("Installing\nThe server installed successfully");
    expect(mocks.actions[0].command).toBe("java -version");
    expect(instance.status()).toBe(0);
    expect(instance.locked).toBe(false);
    expect(instance.asynchronousTask).toBeUndefined();
    expect(instance.listenerCount("data")).toBe(0);
  });

  it("refuses a running instance or one with another task", async () => {
    const running = new FakeInstance();
    running.status(3);
    await expect(runAiCommand(running as any, { command: "x" })).rejects.toThrow(
      "Instance must be stopped"
    );
    const busy = new FakeInstance();
    busy.asynchronousTask = {};
    await expect(runAiCommand(busy as any, { command: "x" })).rejects.toThrow(
      "Another task is running"
    );
    expect(mocks.actions).toEqual([]);
  });

  it("reports failures and timeouts", async () => {
    mocks.behaviour = "fail";
    const failed = await runAiCommand(new FakeInstance() as any, { command: "x" });
    expect(failed).toMatchObject({ success: false, error: "Update failed" });

    mocks.behaviour = "hang";
    const hung = await runAiCommand(new FakeInstance() as any, { command: "x", timeoutMs: 1000 });
    expect(hung).toMatchObject({ success: false, timedOut: true });
    expect(mocks.actions[1].stopped).toBe(true);
  });

  it("verifies the downloaded installer before running it", async () => {
    const prepare = { url: forge, fileName: "forge-installer.jar", sha256: sha256("installer") };
    const ok = await runAiCommand(new FakeInstance() as any, {
      command: "java -jar forge-installer.jar --installServer",
      prepare
    });
    expect(ok.success).toBe(true);
    expect(mocks.downloads).toEqual([forge]);

    mocks.downloadContent = "tampered";
    const bad = await runAiCommand(new FakeInstance() as any, {
      command: "java -jar forge-installer.jar --installServer",
      prepare
    });
    expect(bad).toMatchObject({ success: false, error: "Installer checksum mismatch" });
    expect(mocks.actions).toHaveLength(1); // the tampered jar never ran
    expect(await fs.pathExists(path.join(mocks.workspace, "forge-installer.jar"))).toBe(false);
  });
});
