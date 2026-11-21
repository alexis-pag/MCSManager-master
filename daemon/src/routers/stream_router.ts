import { isBanCommand, RestrictedTerminalInput } from "mcsmanager-common";
import { IGNORE } from "../const";
import RouterContext from "../entity/ctx";
import { $t } from "../i18n";
import {
  LOGIN_FROM_STREAM,
  missionPassport,
  streamLoginSuccessful
} from "../service/mission_passport";
import * as protocol from "../service/protocol";
import { routerApp } from "../service/router_app";
import InstanceSubsystem from "../service/system_instance";

// Regular users must ban players through the AI-moderated flow of the panel.
function notifyBanBlocked(ctx: RouterContext, instanceUuid: string) {
  protocol.msg(new RouterContext(null, ctx.socket), "instance/stdout", {
    instanceUuid,
    text: `
[MCSManager] ${$t("TXT_CODE_ban_command_blocked")}
`
  });
}

function checkStreamLogin(ctx: RouterContext) {
  return (
    ctx.session.stream &&
    ctx.session?.stream?.check === true &&
    ctx.session.type === LOGIN_FROM_STREAM
  );
}

// Authorization authentication middleware
routerApp.use(async (routePath, ctx, data, next) => {
  // release data flow authentication route
  if (routePath === "stream/auth") return next();
  // Check other routes for data flow
  if (routePath.startsWith("stream")) {
    if (checkStreamLogin(ctx)) return await next();

    return protocol.error(ctx, "error", IGNORE, {
      disablePrint: true
    });
  }
  return await next();
});

// Publicly accessible dataflow authentication route
routerApp.on("stream/auth", (ctx, data) => {
  try {
    const password = data.password;
    const mission = missionPassport.getMission(password, "stream_channel");
    if (!mission) throw new Error($t("TXT_CODE_stream_router.taskNotExist"));
    const instance = InstanceSubsystem.getInstance(mission.parameter.instanceUuid);
    if (!instance) throw new Error($t("TXT_CODE_stream_router.instanceNotExist"));
    // Auth success!
    streamLoginSuccessful(ctx, instance.instanceUuid);
    // Set by the panel for non-administrators: ban commands are filtered from this session.
    if (mission.parameter?.blockBanCommands === true) {
      ctx.session.stream.blockBan = true;
      ctx.session.stream.inputFilter = new RestrictedTerminalInput();
    }
    // Start forwarding output stream data to this Socket
    InstanceSubsystem.forward(instance.instanceUuid, ctx.socket);
    // Cancel forwarding events when registration is disconnected
    ctx.socket.on("disconnect", () => {
      InstanceSubsystem.stopForward(instance.instanceUuid, ctx.socket);
    });
    protocol.response(ctx, true);
  } catch (error: any) {
    protocol.responseError(ctx, error, {
      disablePrint: true
    });
  }
});

// Get instance details
routerApp.on("stream/detail", async (ctx) => {
  try {
    const instanceUuid = ctx.session?.stream?.instanceUuid;
    const instance = InstanceSubsystem.getInstance(instanceUuid);
    if (!instance) throw new Error($t("TXT_CODE_3bfb9e04"));
    protocol.response(ctx, {
      instanceUuid: instance.instanceUuid,
      started: instance.startCount,
      autoRestarted: instance.autoRestartCount,
      status: instance.status(),
      config: instance.config,
      info: instance.info,
      watcher: instance.watchers.size
    });
  } catch (error: any) {
    protocol.responseError(ctx, error);
  }
});

// Execute commands, line-based interactive input and output streams for ordinary processes
routerApp.on("stream/input", async (ctx, data) => {
  try {
    const command = data.command;
    const instanceUuid = ctx.session?.stream?.instanceUuid;
    const instance = InstanceSubsystem.getInstance(instanceUuid);
    if (ctx.session?.stream?.blockBan && isBanCommand(command)) {
      return notifyBanBlocked(ctx, instanceUuid);
    }
    await instance?.execPreset("command", command);
  } catch (error: any) {
    // Ignore potential high frequency exceptions here
  }
});

// Process terminal input, suitable for direct connection input and output streams of simulated terminals.
routerApp.on("stream/write", async (ctx, data) => {
  try {
    let buf = data.input;
    const instanceUuid = ctx.session?.stream?.instanceUuid;
    const instance = InstanceSubsystem.getInstance(instanceUuid);
    const filter: RestrictedTerminalInput | undefined = ctx.session?.stream?.inputFilter;
    if (filter) {
      const result = filter.process(buf);
      buf = result.forward;
      if (result.blocked) notifyBanBlocked(ctx, instanceUuid);
      if (!buf) return;
    }
    // run without command execution
    if (instance?.process) instance.process.write(buf);
  } catch (error: any) {
    // Ignore potential high frequency exceptions here
  }
});

// Handle terminal resize
// interface IResizeOptions {
//   h: number;
//   w: number;
// }
routerApp.on("stream/resize", async (ctx, data) => {
  try {
    const instanceUuid = ctx.session?.stream?.instanceUuid;
    const instance = InstanceSubsystem.getInstance(instanceUuid);
    instance?.watchers.set(ctx.socket.id, {
      terminalSize: {
        w: Number(data.w) || 0,
        h: Number(data.h) || 0
      }
    });
    if (instance) await instance.execPreset("resize");
  } catch (error: any) {
    // Ignore potential high frequency exceptions here
  }
});
