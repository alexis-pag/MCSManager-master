# AI Scheduled Tasks and World Backups

## Why

Instance schedules can only start, stop, restart, kill, wait and send commands. Server owners also want routine checks done for them: a daily look at the console for errors, a check that configuration files are not broken, a list of plugins that have a newer compatible version, and their own recurring question to the local AI. They also want automatic world backups without external tooling.

Schedules run in the daemon, but the local AI runs in the panel, and the daemon has no channel to call the panel. AI tasks therefore need a panel-side scheduler that shows up in the same "Scheduled tasks" screen.

## What Changes

- Add panel-side **AI scheduled tasks** bound to one instance, with the same three trigger types as instance schedules (interval, daily cycle, specified time) and the same recurrence count semantics.
- Four AI task kinds, all **read-only** (no file write, no plugin install, no start/stop):
  - `console_report`: summarize errors, warnings and crashes from the instance console log, with suggested fixes.
  - `file_check`: validate the instance's known configuration files (syntax checked by the panel, values reviewed by the AI) and report problems.
  - `plugin_updates`: list installed plugins/mods that have a newer version compatible with the detected server.
  - `custom_prompt`: run the owner's own instruction with the read-only instance tools.
- Each run produces a **report conversation** in the instance AI history, tagged as a report and kept 7 days (configurable) instead of the 2-hour chat retention, so the owner can read it and ask follow-up questions.
- Add a `backup` action to instance schedules (daemon): zip chosen folders (default `world`) into `backups/` inside the instance directory and keep only the N most recent archives.
- Frontend: the "New scheduled task" dialog gets a task category switch ("Server actions" / "AI task"), the backup action gets folder and retention fields, and the task list shows AI tasks with an "AI" tag and their last run status.

## Out of Scope

- AI tasks that change anything (edits, installs, start/stop, commands). Actions still require a person to confirm in the chat.
- Notifications outside the panel (email, Discord, webhooks).
- Backups stored outside the instance directory or on remote storage.
- Restoring a backup from the schedule screen (users unzip with the existing file manager).

## Impact

- Affected modules: panel (new AI schedule service, routes, report retention, read-only tool mode), daemon (backup action), frontend (schedule dialog/list, AI history tag), languages (new keys).
- New persistent categories: `AiScheduleTask` (panel). `AiConversation` gains a `kind` field (`chat` default, `report`).
- New config fields: `aiReportRetentionDays` (default 7).
- No breaking change: existing schedules, actions and conversations keep their behavior.
