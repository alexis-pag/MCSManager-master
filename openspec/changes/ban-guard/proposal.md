# Ban Guard: Revert Bans Made Outside "Ban a player"

## Why

Bans must go through the panel's AI-moderated "Ban a player" flow (reason, evidence, AI review, audit). Today a player can still be banned outside it: by an operator in game, from the terminal by an administrator, by a plugin or a script. The owner wants every such ban to be undone automatically.

## What Changes

- The daemon watches the console of every instance. When a line shows a ban (vanilla/Paper/Forge feedback `Banned Steve: …`, operator broadcast `[Alex: Banned Steve: …]`, EssentialsX `Player Alex banned Steve for: …`, IP bans `Banned IP 1.2.3.4: …`) that the panel did not authorize, it immediately sends `pardon <player>` (or `pardon-ip <ip>`) and prints a notice in the console.
- The "Ban a player" flow authorizes its own ban on the daemon just before sending it (single use, 2 minutes); that ban stays.
- The panel collects the reverted bans from the daemons every 20 s and writes each one to the operation log (`instance_player_unban_auto`).
- Applies to everybody, administrators included: administrators ban through "Ban a player" too (they can override the AI verdict there).
- Bug fix found on the way: the daemon gate refused `instance/unexpected_stops` (no instanceUuid), so AI crash analyses never received crash records.

## Out of Scope

- Plugins that keep bans in their own database instead of the Java ban lists (LiteBans, AdvancedBan) and print no recognizable line.
- Bans that existed before this change.

## Impact

- Daemon: console watcher service, `ban_guard/allow` and `ban_guard/events` routes, gate exemption for `instance/unexpected_stops`.
- Panel: authorization in the ban flow, poller writing the operation log, new log type.
- Frontend: operation log renderer. Languages: daemon notice and log texts.
