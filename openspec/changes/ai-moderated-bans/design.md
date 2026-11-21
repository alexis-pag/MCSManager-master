# Design: AI-Moderated Player Bans

## Context

- Instance commands go through the panel route that forwards `instance/command` to the daemon; the console log is available through `instance/outputlog`.
- The local AI queue (`local_ai_service.ts`) is FIFO and serves chat, scheduled tasks, and now ban reviews. The engine URL is restricted to local addresses, so evidence never leaves the host.
- MCSManager has no player management screen today.

## Decisions

### 1. Ban case entity

`AiBanCase` (StorageSubsystem category `AiBanCase`):

```
uuid, requesterUserUuid, daemonId, instanceUuid,
player, reason, description,
logLines: string[] (<= 50 lines, <= 500 chars each),
images: { id, mime, size }[] (<= 3, <= 2 MB each),
state: "reviewing" | "justified" | "not_justified" | "insufficient_evidence"
     | "applied" | "failed",
verdict: { verdict, sanction, explanation } | null,
requestUuid, createdAt, decidedAt, appliedAt,
appliedByName, overrideNote (set when an administrator overrode the verdict)
```

- Images are stored as files under `data/AiBanEvidence/<caseUuid>/<id>.<ext>` after checking magic bytes match the declared type; served back only to the requester and administrators through an authenticated route, with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.
- Cases and their evidence are deleted 90 days after `createdAt` by the existing AI retention timer.

### 2. Input validation (panel, before any AI call)

- Player: `^[A-Za-z0-9_]{3,16}$` (Java usernames); this also keeps the value safe to place in a console command.
- Reason: trimmed, 15-200 chars, no control characters, rejected if it matches a placeholder list (`test`, `ban`, `aaa`, `parce que`, `no reason`, `because`, `rien`, `...`) or has fewer than 4 distinct letters. Newlines are removed before it reaches the command.
- Evidence: at least one of `logLines` (non-empty), `description` (>= 30 chars), or images.
- Log lines must be lines that actually exist in the instance console log at submit time (the panel re-reads the log and keeps only matching lines), so a requester cannot fabricate "log" evidence; free text goes in `description`, which the AI is told is the requester's own account.

### 3. AI review

- The case is submitted to the shared FIFO queue under the requester's identity, with no tools declared.
- System prompt: act as an impartial moderator; a ban is justified only if the evidence shows a serious or repeated rule violation by this player; the requester's description is a claim, the log lines are verified evidence; screenshots are only described as present unless vision is enabled; answer with one JSON object `{verdict, sanction, explanation}` in the requester's language.
- The reply is parsed with the existing `parseJsonObject`; an unparseable or out-of-enum reply makes the case `insufficient_evidence` with a panel-written explanation, never `justified`.
- With `aiVisionEnabled`, images are sent as OpenAI-compatible `image_url` data-URI parts; otherwise only their count is mentioned.

### 4. Applying the ban

- `POST /api/ai/bans/:uuid/apply` re-checks: requester or admin, instance access, state `justified` (or admin override), instance running. It then sends `ban <player> <reason>` through the existing instance command path and records `applied`. If the instance is stopped, the request is refused with a clear message and the case stays `justified` so it can be applied later.
- Override: admins only, `overrideNote` 15-500 chars, state becomes `applied` with the note recorded; the operation log entry is `instance_player_ban` at warning level with `override_note`.
- Every apply writes an operation log entry `instance_player_ban`.

### 5. API

Under `/api/ai/bans` with `ROLE.USER` and instance access checks:

- `GET ?daemonId&uuid` list cases for the instance (regular users see their own cases; admins see all).
- `GET /log-lines?daemonId&uuid&player` returns up to 50 recent console lines mentioning the player.
- `POST` create a case (JSON; screenshots as base64 data URIs, which fits the existing 10 MB JSON body limit), returns the case in `reviewing` state. The AI review runs through the shared queue in a report conversation `Ban · <player>`, visible in the requester's instance AI history.
- `GET /case/:uuid` case with verdict; `GET /case/:uuid/evidence/:id` image.
- `POST /case/:uuid/apply` (body `overrideNote` for an administrator override).

### 6. UI

- Instance page: "Ban a player" button next to "AI Assistant" for Minecraft Java instances.
- Dialog tab "New request": player, reason, pre-selected log lines with checkboxes, description, image upload, "Submit for review"; then a waiting state (queue position), then the verdict card with the explanation and either "Apply ban" or the refusal (plus the override form for admins).
- Tab "Ban history": cases with player, requester, date, verdict and outcome.

### 7. Blocking ban commands for regular users (approved decision)

Ban commands are `ban`, `ban-ip`, `banip`, `ipban`, `tempban`, `tempbanip` (optionally with a leading `/` or a `minecraft:`/plugin namespace). A shared helper in `common/` (`isBanCommand`, `RestrictedTerminalInput`) is used by the panel and the daemon.

Every path a regular user can send console input through is covered:

- **Panel `/protected_instance/command`**: refused with 403 for non-administrators.
- **Instance schedules**: registering a `command` action that is a ban command is refused for non-administrators.
- **Direct terminal (browser → daemon)**: the panel registers the `stream_channel` passport with `blockBanCommands: true` for non-administrators. The daemon keeps that flag on the stream session and filters `stream/input` (whole lines) and `stream/write` (raw PTY keystrokes).
- **Proxy terminal (browser → panel → daemon)**: the panel-signed stream token carries `restricted: true` for non-administrators, and the terminal bridge filters that browser socket's input before forwarding it to the shared daemon client.

Raw PTY input is filtered by modelling the line being typed: printable characters, backspace, Ctrl+C/Ctrl+U are tracked; keys that would make the line unknown (history up/down, Tab completion, Ctrl+R, cursor movement and other escape sequences) are dropped for restricted sessions, so the modelled line is always what the server receives. When Enter would submit a ban command, the filter sends backspaces to erase the typed line instead of Enter, and the session receives a console notice pointing to "Ban a player". Administrators keep the unfiltered terminal. Regular users lose history and Tab completion in the raw terminal only; the command input bar keeps its own history.

## Risks

- **False negatives/positives from a small local model**: the verdict is advisory to a human click; only `justified` unlocks the button, and unparseable replies never unlock it.
- **Command injection**: player regex and reason sanitization; the command is built by the panel, never by the model.
- **Evidence storage abuse**: size/count limits, type sniffing, 90-day deletion, access restricted to requester and admins.
- **Bypass through the terminal**: documented limitation unless open question 2 chooses blocking.
