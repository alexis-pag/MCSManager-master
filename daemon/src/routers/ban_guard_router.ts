import fs from "fs-extra";
import path from "path";
import Instance from "../entity/instance/instance";
import { $t } from "../i18n";
import { BanGuardService } from "../service/ban_guard_service";
import * as protocol from "../service/protocol";
import { routerApp } from "../service/router_app";
import InstanceSubsystem from "../service/system_instance";

// Bans that do not go through the panel's "Ban a player" flow are reverted automatically,
// on every instance: from the console messages, and from the Java ban lists (any server
// software or plugin that uses them).
export const banGuard = new BanGuardService((target) =>
  $t("TXT_CODE_ban_guard_reverted", { target })
);

const BAN_LIST_INTERVAL_MS = 15 * 1000;
const MAX_BAN_LIST_BYTES = 2 * 1024 * 1024;

InstanceSubsystem.on("data", (instanceUuid: string, text: string) => {
  banGuard.onData(instanceUuid, text, InstanceSubsystem.getInstance(instanceUuid));
});

async function readBanList(file: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_BAN_LIST_BYTES) return null;
    return await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
}

let checking = false;
export async function checkAllBanLists() {
  if (checking) return;
  checking = true;
  try {
    for (const instance of InstanceSubsystem.getInstances()) {
      if (instance.status() !== Instance.STATUS_RUNNING) continue;
      const type = String(instance.config?.type || "");
      // Java servers (any software); "universal" instances only when they have ban lists.
      if (!type.startsWith("minecraft/java") && type !== Instance.TYPE_UNIVERSAL) continue;
      const cwd = instance.absoluteCwdPath();
      const players = await readBanList(path.join(cwd, "banned-players.json"));
      const ips = await readBanList(path.join(cwd, "banned-ips.json"));
      if (type === Instance.TYPE_UNIVERSAL && players === null && ips === null) continue;
      banGuard.checkBanLists(instance.instanceUuid, { players, ips }, instance);
    }
  } finally {
    checking = false;
  }
}

setInterval(() => void checkAllBanLists(), BAN_LIST_INTERVAL_MS).unref?.();

// Panel-only (top-level auth): the "Ban a player" flow is about to apply this ban.
routerApp.on("ban_guard/allow", (ctx, data) => {
  try {
    if (!InstanceSubsystem.exists(data?.instanceUuid)) throw new Error("Instance not found");
    protocol.response(ctx, banGuard.allow(String(data.instanceUuid), data.target));
  } catch (error: any) {
    protocol.responseError(ctx, error, { disablePrint: true });
  }
});

// Panel-only (top-level auth): reverted bans newer than `since` (ms timestamp).
routerApp.on("ban_guard/events", (ctx, data) => {
  protocol.response(ctx, banGuard.list(data?.since));
});
