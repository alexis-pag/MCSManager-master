# AI Crash Analysis

## Why

When a server crashes, the owner finds out late and has to dig through the console and `crash-reports/` alone. Scheduled console reports (change `ai-scheduled-tasks`) run at fixed times, so a crash at 3 a.m. is analyzed hours later, if at all, and the console may already have been overwritten by an automatic restart.

## What Changes

- The daemon records **unexpected stops**: an instance that stops without a stop/kill/restart request (the existing `eventTask.ignore` flag tells them apart), and an instance that fails to start. Each record keeps the time, the exit code, whether an automatic restart was triggered, and a snapshot of the last console lines taken at the moment of the stop.
- The panel collects these records from every connected daemon every 20 seconds.
- A new AI task kind **`crash_analysis`** with the trigger **"on crash"** (no time fields) in "Scheduled tasks → AI task". When its instance stops unexpectedly, the panel:
  1. collects trusted data: the console snapshot, the newest `crash-reports/*.txt` and JVM `hs_err_pid*.log` written around the crash, the exit code;
  2. skips the analysis when the stop looks clean (exit code 0, no crash file, no error in the last lines), e.g. a `/stop` typed in game;
  3. otherwise creates a report conversation "Plantage · <date>" (same read-only mode, same 7-day retention as other AI reports) whose first lines are written by the panel: time, exit code, automatic restart yes/no.
- Crash loops are bounded: at most one analysis per task every 10 minutes, and never while the previous one is still running.
- The task list shows the last crash analysis status and a link to the report, like other AI tasks.

## Out of Scope

- Notifications outside the panel (Discord, email): separate change.
- Automatic fixes. The analysis stays read-only; fixes go through the instance assistant with confirmation.
- Crashes of the daemon or panel processes themselves.

## Impact

- Affected modules: daemon (unexpected-stop records + one new read-only route), panel (collector loop, new task kind and trigger), frontend (kind and trigger in the schedule dialog), languages.
- New daemon route: `instance/unexpected_stops` (top-level panel auth only, like every daemon route). Older daemons without it are skipped silently.
- `AiScheduleTask.type` gains the value `4` (on crash) for `crash_analysis` only. No change to existing tasks.
- Depends on `ai-scheduled-tasks` (AI tasks, report conversations, read-only runs).
