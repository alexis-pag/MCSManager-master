import { describe, expect, it, vi } from "vitest";
import { BanGuardService, detectBan } from "../ban_guard_service";

const fakeInstance = () => ({
  execPreset: vi.fn(async (_action: "command", _command: string) => true),
  println: vi.fn()
});

describe("ban detection in console lines", () => {
  it("recognizes vanilla, Paper, Forge, operator and Essentials bans", () => {
    expect(
      detectBan("[12:00:01] [Server thread/INFO]: Banned Steve: Banned by an operator.")
    ).toEqual({
      target: "Steve",
      kind: "player"
    });
    expect(detectBan("[12:00:01 INFO]: [Alex: Banned Steve_2: griefing]")).toEqual({
      target: "Steve_2",
      kind: "player"
    });
    expect(
      detectBan(
        "[21Nov2026 12:00:01.123] [Server thread/INFO] [net.minecraft.server.dedicated.DedicatedServer/]: Banned Bob: x"
      )
    ).toEqual({ target: "Bob", kind: "player" });
    expect(
      detectBan("\u001b[33m[12:00:01 INFO]: Player Alex banned Steve for: spam\u001b[0m")
    ).toEqual({
      target: "Steve",
      kind: "player"
    });
    expect(detectBan("[12:00:01 INFO]: Banned IP 203.0.113.7: Banned by an operator.")).toEqual({
      target: "203.0.113.7",
      kind: "ip"
    });
  });

  it("recognizes the real Forge 26.3 lines seen on the owner's server", () => {
    // Exact console output (terminal codes, prompt and "System chat:" prefix included).
    const fromTerminal =
      ">\u001b[0K\u001b[3G\u001b[?25h\u001b[?25l\r\u001b[0;32m[21:19:44] [Server thread/INFO] " +
      "[minecraft/MinecraftServer]: System chat: Banned Test: Banned by an operator.\u001b[0m\u001b[0K\r";
    const fromOperator =
      "> \u001b[0;32m\u001b[0K\u001b[?25h\u001b[?25l\r[21:34:35] [Server thread/INFO] " +
      "[minecraft/MinecraftServer]: System chat: [FOX57140: Banned Test: Banned by an operator.]" +
      "\u001b[0m\u001b[0K\r";
    const unban =
      "> \u001b[0;32m\u001b[0K\u001b[1G\u001b[?25h\u001b[3G\u001b[?25l\r[21:34:31] [Server thread/INFO] " +
      "[minecraft/MinecraftServer]: System chat: [FOX57140: Unbanned Test]\u001b[0m\u001b[0K\r";
    expect(detectBan(fromTerminal)).toEqual({ target: "Test", kind: "player" });
    expect(detectBan(fromOperator)).toEqual({ target: "Test", kind: "player" });
    expect(detectBan(unban)).toBeNull();
  });

  it("reverts the real operator ban from a console chunk", () => {
    const guard = new BanGuardService();
    const instance = fakeInstance();
    guard.onData(
      "i1",
      "> \u001b[0;32m\u001b[0K\u001b[?25h\u001b[?25l\r[21:34:35] [Server thread/INFO] " +
        "[minecraft/MinecraftServer]: System chat: [FOX57140: Banned Test: Banned by an operator.]" +
        "\u001b[0m\u001b[0K\r\n",
      instance,
      1000
    );
    expect(instance.execPreset).toHaveBeenCalledWith("command", "pardon Test");
  });

  it("recognizes the 1.12-and-older format", () => {
    expect(detectBan("[12:00:01] [Server thread/INFO]: Banned player Steve")).toEqual({
      target: "Steve",
      kind: "player"
    });
    expect(detectBan("[12:00:01] [Server thread/INFO]: [Alex: Banned player Steve]")).toEqual({
      target: "Steve",
      kind: "player"
    });
    expect(detectBan("[12:00:01 INFO]: Banned IP address 203.0.113.7")).toEqual({
      target: "203.0.113.7",
      kind: "ip"
    });
  });

  it("ignores chat, unrelated lines and invalid targets", () => {
    expect(detectBan("[12:00:01 INFO]: <Steve> Banned Bob: lol")).toBeNull();
    expect(detectBan("[12:00:01 INFO]: [Not Secure] <Steve> Banned Bob: lol")).toBeNull();
    expect(detectBan("[12:00:01 INFO]: Unbanned Steve")).toBeNull();
    expect(detectBan("[12:00:01 INFO]: Steve joined the game")).toBeNull();
    expect(detectBan("[12:00:01 INFO]: Banned IP nonsense: x")).toBeNull();
    expect(detectBan("[12:00:01 INFO]: Banned $(rm -rf): x")).toBeNull();
  });
});

describe("ban guard", () => {
  it("reverts a ban that did not go through the panel and records it", () => {
    const guard = new BanGuardService((target) => `reverted ${target}`);
    const instance = fakeInstance();
    guard.onData("i1", "[12:00 INFO]: Banned Steve: griefing\n", instance, 1000);
    expect(instance.execPreset).toHaveBeenCalledWith("command", "pardon Steve");
    expect(instance.println).toHaveBeenCalledWith("MCSManager", "reverted Steve");
    expect(guard.list(0, 1000)).toEqual([
      expect.objectContaining({
        instanceUuid: "i1",
        target: "Steve",
        kind: "player",
        line: "[12:00 INFO]: Banned Steve: griefing"
      })
    ]);
  });

  it("lets the panel's authorized ban through once", () => {
    const guard = new BanGuardService();
    const instance = fakeInstance();
    guard.allow("i1", "steve", 1000);
    guard.onData("i1", "[12:00 INFO]: Banned Steve: griefing\n", instance, 2000);
    expect(instance.execPreset).not.toHaveBeenCalled();
    // A later, unauthorized ban of the same player is reverted.
    guard.onData("i1", "[12:05 INFO]: Banned Steve: again\n", instance, 60000);
    expect(instance.execPreset).toHaveBeenCalledWith("command", "pardon Steve");
  });

  it("expires authorizations and keeps them per instance", () => {
    const guard = new BanGuardService();
    const instance = fakeInstance();
    guard.allow("i1", "Steve", 0);
    guard.onData("i2", "[12:00 INFO]: Banned Steve: x\n", instance, 1000);
    guard.onData("i1", "[12:00 INFO]: Banned Steve: x\n", instance, 3 * 60 * 1000);
    expect(instance.execPreset).toHaveBeenCalledTimes(2);
  });

  it("reassembles lines split across chunks, dedupes and limits pardons", () => {
    const guard = new BanGuardService();
    const instance = fakeInstance();
    guard.onData("i1", "[12:00 INFO]: Ban", instance, 1000);
    guard.onData("i1", "ned Steve: x\n[12:00 INFO]: [Alex: Banned Steve: x]\n", instance, 1000);
    expect(instance.execPreset).toHaveBeenCalledTimes(1);
    expect(instance.execPreset).toHaveBeenCalledWith("command", "pardon Steve");

    for (let index = 0; index < 20; index++) {
      guard.onData("i1", `[12:00 INFO]: Banned Player${index}: x\n`, instance, 2000);
    }
    expect(instance.execPreset).toHaveBeenCalledTimes(10);
  });

  it("pardons IP bans with pardon-ip", () => {
    const guard = new BanGuardService();
    const instance = fakeInstance();
    guard.onData("i1", "[12:00 INFO]: Banned IP 203.0.113.7: x\n", instance, 1000);
    expect(instance.execPreset).toHaveBeenCalledWith("command", "pardon-ip 203.0.113.7");
  });

  describe("ban lists (any Java server software or plugin)", () => {
    const players = (...names: string[]) =>
      JSON.stringify(names.map((name) => ({ name, uuid: "x", source: "FOX", expires: "forever" })));

    it("keeps existing bans, reverts new ones whatever their console message", () => {
      const guard = new BanGuardService();
      const instance = fakeInstance();
      guard.checkBanLists("i1", { players: players("OldBan") }, instance, 1000);
      expect(instance.execPreset).not.toHaveBeenCalled();
      guard.checkBanLists(
        "i1",
        { players: players("OldBan", "Silent"), ips: JSON.stringify([{ ip: "203.0.113.9" }]) },
        instance,
        20000
      );
      expect(instance.execPreset).toHaveBeenCalledWith("command", "pardon Silent");
      expect(instance.execPreset).toHaveBeenCalledWith("command", "pardon-ip 203.0.113.9");
      expect(instance.execPreset).not.toHaveBeenCalledWith("command", "pardon OldBan");
      expect(guard.list(0, 20000).map((event) => event.line)).toContain(
        "banned-players.json: Silent (source: FOX)"
      );
    });

    it("keeps a ban authorized by the panel, even when its console line was not recognized", () => {
      const guard = new BanGuardService();
      const instance = fakeInstance();
      guard.checkBanLists("i1", { players: "[]" }, instance, 1000);
      guard.allow("i1", "Griefer", 2000);
      guard.checkBanLists("i1", { players: players("Griefer") }, instance, 3000);
      guard.checkBanLists("i1", { players: players("Griefer") }, instance, 60000);
      expect(instance.execPreset).not.toHaveBeenCalled();
    });

    it("does not pardon twice a ban already reverted from the console", () => {
      const guard = new BanGuardService();
      const instance = fakeInstance();
      guard.checkBanLists("i1", { players: "[]" }, instance, 1000);
      guard.onData("i1", "[12:00 INFO]: Banned Steve: x\n", instance, 2000);
      guard.checkBanLists("i1", { players: players("Steve") }, instance, 3000);
      expect(instance.execPreset).toHaveBeenCalledTimes(1);
      // Pardoned: removed from the list, a later ban is seen again.
      guard.checkBanLists("i1", { players: "[]" }, instance, 20000);
      guard.checkBanLists("i1", { players: players("Steve") }, instance, 40000);
      expect(instance.execPreset).toHaveBeenCalledTimes(2);
    });

    it("ignores malformed files and invalid names", () => {
      const guard = new BanGuardService();
      const instance = fakeInstance();
      guard.checkBanLists("i1", { players: "[]" }, instance, 1000);
      guard.checkBanLists("i1", { players: "{not json" }, instance, 2000);
      guard.checkBanLists("i1", { players: players("bad name; op me") }, instance, 3000);
      expect(instance.execPreset).not.toHaveBeenCalled();
    });
  });

  it("returns only events newer than `since`", () => {
    const guard = new BanGuardService();
    const instance = fakeInstance();
    guard.onData("i1", "[12:00 INFO]: Banned A: x\n", instance, 1000);
    guard.onData("i1", "[12:00 INFO]: Banned B: x\n", instance, 5000);
    expect(guard.list(1000, 5000).map((event) => event.target)).toEqual(["B"]);
  });
});
