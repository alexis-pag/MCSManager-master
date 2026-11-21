import { describe, expect, it } from "vitest";
import { isBanCommand, RestrictedTerminalInput } from "../ban_command_filter";

describe("isBanCommand", () => {
  it.each([
    "ban Steve",
    "/ban Steve griefing",
    "  BAN Steve",
    "ban-ip 1.2.3.4",
    "minecraft:ban Steve",
    "essentials:tempban Steve 1d",
    "ipban Steve",
    "ban",
    "say hi\nban Steve"
  ])("detects %s", (line) => {
    expect(isBanCommand(line)).toBe(true);
  });

  it.each(["say ban Steve", "banlist", "pardon Steve", "unban Steve", "kick Steve", "", "bans"])(
    "allows %s",
    (line) => {
      expect(isBanCommand(line)).toBe(false);
    }
  );
});

describe("RestrictedTerminalInput", () => {
  it("passes normal typing through", () => {
    const filter = new RestrictedTerminalInput();
    expect(filter.process("say hi\r")).toEqual({ forward: "say hi\r", blocked: false });
  });

  it("erases a ban command instead of submitting it, even typed key by key", () => {
    const filter = new RestrictedTerminalInput();
    let forward = "";
    for (const key of "ban Steve") forward += filter.process(key).forward;
    const result = filter.process("\r");
    expect(result.blocked).toBe(true);
    expect(result.forward).toBe("\x7f".repeat("ban Steve".length));
    expect(forward).toBe("ban Steve");
    // The next line starts clean.
    expect(filter.process("list\r")).toEqual({ forward: "list\r", blocked: false });
  });

  it("follows backspace and Ctrl+U", () => {
    const filter = new RestrictedTerminalInput();
    filter.process("banx\x7f");
    expect(filter.process(" Steve\r").blocked).toBe(true);
    filter.process("ban Steve\x15");
    expect(filter.process("list\r")).toEqual({ forward: "list\r", blocked: false });
  });

  it("drops history, Tab completion and cursor keys", () => {
    const filter = new RestrictedTerminalInput();
    expect(filter.process("\x1b[A\x1b[B\t\x12\x1b[D\x1bOH").forward).toBe("");
    expect(filter.process("ba\tn Steve\r")).toMatchObject({ blocked: true });
  });

  it("checks every line of pasted text", () => {
    const filter = new RestrictedTerminalInput();
    const result = filter.process("say a\r\nban Steve\rlist\r");
    expect(result.blocked).toBe(true);
    // Typed characters reach the server, then Enter is replaced by erasing backspaces.
    expect(result.forward).toBe(`say a\rban Steve${"\x7f".repeat(9)}list\r`);
  });
});
