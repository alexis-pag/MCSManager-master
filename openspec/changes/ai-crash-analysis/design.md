# Design: AI Crash Analysis

## Context

- `Instance.stopped(code)` emits `exit`; stop/kill/restart commands call `ignoreEventTaskOnce()` first, so `eventTask.ignore === true` at that moment means "requested stop". `Instance.failure(error)` emits `failure` when a start fails.
- The daemon only pushes instance events to terminal stream sockets, not to the panel connection.
- AI tasks, read-only scheduled runs and report conversations exist (`ai-scheduled-tasks`).

## Decisions

### 1. Daemon: bounded record of unexpected stops (no change to `instance.ts`)

`daemon/src/service/unexpected_stop_service.ts` listens to `InstanceSubsystem` `exit`/`failure` events:

- `exit` with `eventTask.ignore === false` → record `{ id, instanceUuid, kind: "exit", code, at, autoRestart, consoleTail }`.
- `failure` → record `{ ..., kind: "start_failure", error: message.slice(0, 500) }`.
- `consoleTail`: last 300 lines / 20 000 chars of the instance output buffer at that moment (an automatic restart would otherwise push them out).
- In-memory ring: at most 200 records, each dropped after 1 hour. Nothing is persisted: a daemon restart loses pending records, which is acceptable.

`Instance.stopped()` emits `exit` synchronously before it resets `eventTask.ignore`, and `InstanceSubsystem` re-emits it synchronously, so a listener on `InstanceSubsystem` reads the flag at the right moment. `instance.ts` is therefore not modified. The console snapshot comes from a rolling 20 000-char tail per instance fed by the `data` event and dropped when the instance is deleted.

New route `instance/unexpected_stops` `{ since: number }` returns records with `at > since` (top-level panel session only, through the existing auth middleware).

### 2. Panel: collector loop

`ai_crash_service.ts` polls every available daemon every 20 s with `since = last seen at` (per daemon, in memory; on panel start `since = now - 5 min`). Errors (old daemon without the route, timeout) are logged at debug level and ignored. Records are de-duplicated by `id`.

For each record, the panel finds `crash_analysis` AI tasks of that `(daemonId, instanceUuid)` and runs them.

### 3. Task kind and trigger

- `kind: "crash_analysis"` requires `type: 4` ("on crash", `time` empty); `type: 4` is only valid for this kind. Count semantics: -1 (default) = every crash; N = the next N crashes.
- Limits unchanged (4 AI tasks per instance). At most one `crash_analysis` task per instance.
- Rate limit: a crash arriving less than 10 minutes after the task's last run, or while its previous report is still being generated, sets status `skipped` and is not analyzed.

### 4. Data and clean-stop filter

Collected by the panel, all read-only:

- the record's `consoleTail` (ANSI stripped by the existing helper);
- the crash report announced in the console snapshot ("crash report has been saved to: …/crash-reports/<name>.txt"); otherwise the newest `crash-reports/crash-<date>_<time>-server.txt` whose name date is within 10 minutes of the record (the daemon file list only exposes access times, so the name is used), at most 20 000 chars;
- the JVM error file announced in the console (`hs_err_pid<n>.log`), at most 10 000 chars;
- credential-like values in these files are redacted with the existing helper;
- exit code, kind, automatic restart.

A stop is **clean** when `kind === "exit"`, `code === 0`, no crash file was found, and the console tail has no line matching `/(ERROR|FATAL|Exception|Crash|crashed|OutOfMemory|Watchdog)/`. Clean stops end with status `skipped` and no report.

### 5. Report

Conversation `Plantage · <date>` of kind `report`. The user message is panel-written: "Analyse du plantage de <time> (code de sortie X, redémarrage automatique : oui/non)". The model gets the scheduled read-only prompt plus: "explain the most likely cause from the crash report first, then the console; name the plugin or mod involved when the stack trace shows it; propose concrete fixes". The panel appends the crash file name it used (verbatim) to the report.

### 6. UI

- Schedule dialog: kind "Analyse des plantages"; when selected, the trigger select is replaced by a fixed "À chaque plantage" label and the time fields are hidden.
- Task list: trigger column shows "À chaque plantage"; last status and "Rapport" link as for other AI tasks.

## Risks

- **Crash loops**: bounded by the 10-minute rate limit and the "previous run pending" skip; the daemon ring is bounded (200 records, 1 hour).
- **False positives** (in-game `/stop`): filtered by the clean-stop rule; a false positive only costs one read-only report.
- **Polling cost**: one small request per daemon every 20 s, answered from memory.
- **"Run now"** on a crash task analyzes the latest unexpected stop of the last hour, or reports that there is none.
- **Missed crashes** during a panel or daemon restart: accepted; the next scheduled console report still covers them.
