import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../log", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../download_manager", () => ({ default: {} }));
vi.mock("../file_router_service", () => ({ getFileManager: vi.fn() }));
vi.mock("../instance_update_action", () => ({ InstanceUpdateAction: class {} }));
vi.mock("../../entity/instance/instance", () => ({
  default: class Instance {
    static readonly STATUS_STOP = 0;
    static readonly STATUS_RUNNING = 3;
  }
}));
const runAiCommand = vi.hoisted(() => vi.fn());
vi.mock("../ai_command_runner", async (importActual) => ({
  ...(await importActual<any>()),
  runAiCommand
}));

import { EventEmitter } from "events";
import {
  availableShells,
  containerShellLine,
  decodeShellOutput,
  dockerExec,
  resolveShell,
  runShellCommand,
  shellInvocation
} from "../ai_shell_runner";

// Real processes: proves the shells start in the instance folder, keep accents, report
// failures and are killed on timeout.
const windows = os.platform() === "win32";
let workspace = "";
const instance = () => ({ instanceUuid: "i1", absoluteCwdPath: () => workspace }) as any;

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcsm-ai-shell-"));
  await fs.writeFile(path.join(workspace, "marker.txt"), "x");
});
afterAll(async () => {
  await fs.remove(workspace);
});

describe("AI shell selection", () => {
  it("offers PowerShell and cmd on Windows, sh and bash elsewhere", () => {
    expect(availableShells("win32")).toEqual(["powershell", "cmd"]);
    expect(availableShells("linux")).toEqual(["sh", "bash"]);
    expect(resolveShell(undefined, "win32")).toBe("powershell");
    expect(resolveShell("CMD", "win32")).toBe("cmd");
    expect(() => resolveShell("cmd", "linux")).toThrow("Shell not available");
    expect(() => resolveShell("python", "win32")).toThrow("Shell not available");
  });

  it("decodes UTF-8 output, and cmd's OEM code page output", () => {
    expect(decodeShellOutput(Buffer.from("Créé", "utf-8"), "win32")).toBe("Créé");
    // "trouvé" as written by cmd on a French Windows (code page 850).
    expect(decodeShellOutput(Buffer.from("74726f757682", "hex"), "win32")).toMatch(/^trouv/);
    expect(decodeShellOutput(Buffer.from("74726f757682", "hex"), "linux")).toMatch(/^trouv/);
  });

  it("passes PowerShell scripts encoded, so quotes need no escaping", () => {
    const { args } = shellInvocation("powershell", 'Write-Output "a b"');
    const script = Buffer.from(args[args.length - 1], "base64").toString("utf16le");
    expect(script.endsWith('Write-Output "a b"')).toBe(true);
  });
});

describe.runIf(windows)("AI shell on Windows", () => {
  it("runs PowerShell in the instance folder with UTF-8 output", async () => {
    const result = await runShellCommand(instance(), {
      command: 'Get-ChildItem -Name; Write-Output "Créé à l’instant"'
    });
    expect(result).toMatchObject({ success: true, exitCode: 0, shell: "powershell" });
    expect(result.output).toContain("marker.txt");
    expect(result.output).toContain("Créé à l’instant");
  }, 60000);

  it("runs cmd with its own syntax", async () => {
    const result = await runShellCommand(instance(), {
      shell: "cmd",
      command: 'if exist marker.txt (echo "trouvé é") else (echo absent)'
    });
    expect(result).toMatchObject({ success: true, shell: "cmd" });
    expect(result.output).toContain("trouvé é");
  }, 60000);

  it("reports a failing command and kills one that exceeds the timeout", async () => {
    const failed = await runShellCommand(instance(), { shell: "cmd", command: "exit /b 3" });
    expect(failed).toMatchObject({ success: false, exitCode: 3, error: "Exit code 3" });
    const slow = await runShellCommand(instance(), {
      command: "Start-Sleep -Seconds 30",
      timeoutMs: 1500
    });
    expect(slow).toMatchObject({ success: false, timedOut: true });
  }, 60000);
});

describe.runIf(!windows)("AI shell on Linux", () => {
  it("runs sh in the instance folder", async () => {
    const result = await runShellCommand(instance(), { command: 'ls; echo "été"; exit 2' });
    expect(result).toMatchObject({ success: false, exitCode: 2, shell: "sh" });
    expect(result.output).toContain("marker.txt");
    expect(result.output).toContain("été");
  });
});

describe("AI shell limits", () => {
  it("refuses multi-line commands", async () => {
    await expect(runShellCommand(instance(), { command: "echo a\necho b" })).rejects.toThrow(
      "Invalid command"
    );
  });
});

describe("AI shell in Docker instances", () => {
  const dockerInstance = (status: number, container?: any) =>
    ({
      instanceUuid: "docker-1",
      config: { processType: "docker", docker: { workingDir: "/workspace" } },
      process: container ? { container } : undefined,
      status: () => status,
      parseTextParams: async (text: string) => text
    }) as any;

  const fakeContainer = (output: string, exitCode: number) => {
    const calls: any[] = [];
    return {
      calls,
      async exec(options: any) {
        calls.push(options);
        return {
          async start() {
            const stream = new EventEmitter() as any;
            setTimeout(() => {
              stream.emit("payload", Buffer.from(output));
              stream.emit("end");
            }, 5);
            return stream;
          },
          async inspect() {
            return { ExitCode: exitCode };
          }
        };
      },
      modem: {
        demuxStream(stream: any, stdout: any) {
          stream.on("payload", (chunk: Buffer) => stdout.write(chunk));
        }
      }
    };
  };

  it("encodes the command so any quotes survive the update path", () => {
    const line = containerShellLine("sh", `echo "a 'b'" | grep a`);
    const encoded = line.match(/echo (\S+) \|/)?.[1] as string;
    expect(Buffer.from(encoded, "base64").toString("utf-8")).toBe(`echo "a 'b'" | grep a`);
    expect(line.startsWith('sh -c "echo ')).toBe(true);
  });

  it("runs in the running container with docker exec (sh by default, even on Windows)", async () => {
    const container = fakeContainer("été\n", 0);
    const result = await runShellCommand(dockerInstance(3, container), { command: "ls -la" });
    expect(result).toMatchObject({ success: true, exitCode: 0, shell: "sh", output: "été" });
    expect(container.calls[0]).toMatchObject({
      Cmd: ["sh", "-c", "ls -la"],
      WorkingDir: "/workspace"
    });
    await expect(
      runShellCommand(dockerInstance(3, container), { command: "dir", shell: "cmd" })
    ).rejects.toThrow("Shell not available");
  });

  it("reports a failing command in the container", async () => {
    const result = await dockerExec(
      fakeContainer("boom\n", 2) as any,
      "bash",
      "false",
      undefined,
      5000
    );
    expect(result).toMatchObject({ exitCode: 2, timedOut: false, output: "boom" });
  });

  it("uses the instance image through the update path when the instance is stopped", async () => {
    runAiCommand.mockResolvedValueOnce({
      success: true,
      timedOut: false,
      error: "",
      output: "done",
      platform: "linux"
    });
    const result = await runShellCommand(dockerInstance(0), { command: "java -version" });
    expect(result).toMatchObject({ success: true, output: "done", shell: "sh" });
    expect(runAiCommand.mock.calls[0][1].command).toBe(containerShellLine("sh", "java -version"));
  });
});
