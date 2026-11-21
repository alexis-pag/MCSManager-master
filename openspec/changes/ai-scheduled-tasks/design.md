# Design: AI Scheduled Tasks and World Backups

## Context

- Instance schedules live in the daemon (`daemon/src/service/system_instance_control.ts`), are stored as `TaskConfig`, and are proxied by `panel/src/app/routers/schedule_router.ts`.
- The local AI lives in the panel (`local_ai_service.ts`, `ai_tool_service.ts`): one FIFO queue, per-user conversations, instance-scoped conversations with list/read/edit/plugin tools, and a 2-hour conversation retention.
- The daemon cannot call the panel. The panel already depends on `node-schedule`.

## Decisions

### 1. AI tasks are panel-side entities

`AiScheduleTask` (StorageSubsystem category `AiScheduleTask`):

```
uuid, ownerUserUuid, daemonId, instanceUuid, name,
kind: "console_report" | "file_check" | "plugin_updates" | "custom_prompt",
prompt (custom_prompt only, <= 2000 chars),
type: 1 | 2 | 3, time, count,
createdAt, lastRunAt, lastStatus: "" | "queued" | "completed" | "failed" | "skipped",
lastReportUuid, disabledReason: "" | "access_lost"
```

- Triggers reuse the daemon formats: type 1 = interval in seconds, types 2/3 = cron with a numeric seconds field. Count semantics match the instance-schedules spec (-1/empty = infinite, 1 = once, N = decrement in memory).
- Limits: at most 4 AI tasks per instance; interval at least 3600 s, because every run occupies the single shared model.
- Loaded and registered at panel start by a new `ai_schedule_service.ts`; jobs are cancelled on delete. Deleting an instance does not reach the panel, so a firing on a missing instance marks the task `skipped` and a firing where the owner lost access sets `disabledReason = "access_lost"` and cancels the job.

### 2. A firing is a normal queued AI request with a read-only tool context

On each firing the service:

1. Skips (status `skipped`) if AI is disabled, the owner no longer exists, or the previous run of this task is still queued/processing.
2. Rechecks `isHaveInstance(owner, daemonId, instanceUuid)` on every firing.
3. Creates a report conversation (`kind: "report"`, instance-scoped, title `Rapport · <task name> · <date>`), then submits the prompt through the existing `LocalAiService.submit` queue path with the owner's identity.
4. Passes `toolContext.readOnly = true`. `ai_tool_service` only declares `list_instance_files`, `read_instance_file`, `search_plugins` and the new read-only tools in that mode, and its executor refuses any other tool (defense in depth, not just hidden declarations).

The queue stays FIFO; interactive users are never pre-empted, but a scheduled run waits its turn like any other request.

### 3. Task kinds: deterministic data first, AI wording second

- **console_report**: the panel fetches the console log through the existing `instance/outputlog` daemon route, strips ANSI codes, keeps the last 200 lines / 12 000 chars, and passes it as trusted context. With an empty log the panel writes "Nothing to report" without calling the model.
- **file_check**: the panel reads an allowlist of files that exist in the instance (`server.properties`, `eula.txt`, `bukkit.yml`, `spigot.yml`, `config/paper-global.yml`, `config/paper-world-defaults.yml`, `ops.json`, `whitelist.json`, `banned-players.json`, then up to 20 `plugins/*/config.yml`), each <= 64 KB read, at most 16 000 chars in total sent to the model (4 000 per file). It runs a syntax check (YAML/JSON/properties) itself and redacts values whose key matches `password|secret|token|key` before sending content to the model. The model reviews values (invalid or risky settings) and the report lists the syntax errors found by the panel verbatim.
- **plugin_updates**: the panel lists `.jar` files in `plugins/` (or `mods/` on Fabric/Forge), up to 30, and reuses the plugin search and compatibility logic of `install_plugin` to find the latest compatible version for each. The comparison table is built by the panel; the model only writes the summary. Nothing is downloaded.
- **custom_prompt**: the owner's instruction, read-only tools, max 6 tool rounds (existing limit).

### 4. Report retention

`AiConversation.kind` defaults to `"chat"`. `expiresAt()` uses `aiReportRetentionDays` (default 7, range 1-90) for `kind === "report"` and the existing chat retention otherwise. A follow-up message in a report conversation keeps it a report (7 days from the last message).

### 5. Backup action (daemon)

- `ScheduleActionTypeEnum.Backup = "backup"`, payload JSON `{"paths": ["world"], "keep": 7}`. A plain-string payload is read as a single path with `keep = 7`.
- Validated at registration: 1-5 relative paths, each resolved inside the instance directory with the existing `FileManager` path checks, not inside `backups/`; `keep` integer 1-30.
- Execution: `backups/backup-YYYYMMDD-HHmmss.zip` through the existing `compress()` helper, one backup at a time per instance (a second firing during a running backup is skipped and logged), then delete the oldest `backup-*.zip` beyond `keep`. Works whether the instance runs or not; users add `save-off`/`save-all` command actions before it if they want a consistent copy.

### 6. API and UI

- Panel routes under `/api/ai/schedules?daemonId&uuid`: `GET` (list for the instance), `POST` (create), `DELETE ?name=`, `POST /run?name=` (run now, same checks and skip rules). `ROLE.USER` + `isHaveInstanceByUuid`, same name blacklist as instance schedules, operation log entries reuse `instance_task_create` / `instance_task_delete` with the task name prefixed by `AI: `.
- `Schedule.vue` merges both lists; AI rows show an "AI" tag, the kind, the last run time/status, and a link that opens the last report in the instance AI drawer.
- `NewSchedule.vue`: a segmented control "Server actions / AI task". AI mode shows the kind select and, for `custom_prompt`, a textarea. Backup actions show a folders input and a "keep" number, serialized into the payload.
- Instance AI history shows a "Report" tag and the 7-day expiry for report conversations.

## Risks

- **Model saturation**: mitigated by the 1-hour minimum interval, 4 tasks per instance, and the "previous run still pending" skip.
- **Secrets sent to the model**: the model is local by design (engine URL must be local); credentials are redacted before sending in `file_check`.
- **Disk usage from backups**: bounded by `keep` <= 30 and by the instance directory itself; no cross-instance writes.
- **Stale ownership**: access is rechecked on every firing.
