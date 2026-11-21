import * as protocol from "../service/protocol";
import { routerApp } from "../service/router_app";
import InstanceSubsystem from "../service/system_instance";
import unexpectedStops from "../service/unexpected_stop_service";

// Record instances that stop without being asked to (crashes) or fail to start.
// The "exit" listener runs synchronously while `eventTask.ignore` still tells requested stops apart.
InstanceSubsystem.on("data", (instanceUuid: string, text: string) => {
  unexpectedStops.onData(instanceUuid, text);
});
InstanceSubsystem.on("exit", (obj: { instanceUuid: string }, code: unknown) => {
  unexpectedStops.onExit(obj.instanceUuid, InstanceSubsystem.getInstance(obj.instanceUuid), code);
});
InstanceSubsystem.on("failure", (obj: { instanceUuid: string }, error: unknown) => {
  unexpectedStops.onFailure(obj.instanceUuid, error);
});

// Panel-only (top-level auth): unexpected stops newer than `since` (ms timestamp).
routerApp.on("instance/unexpected_stops", (ctx, data) => {
  protocol.response(ctx, unexpectedStops.list(data?.since));
});
