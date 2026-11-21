# Implementation Tasks

- [x] 1. Console command validation (pure helper: single line, length, namespace, allowlist, ban filter) and `aiConsoleCommandAllowlist` system setting with the default list and admin update through `/ai/config`.
   - Tests: `cd panel && npm test`

- [x] 2. `send_console_command` tool: declaration in instance-bound conversations, pending confirmation, execution through `instance/command` (running instance only), console output returned to the model, operation log `ai_instance_command`.
   - Tests: `cd panel && npm test`

- [x] 3. Daemon `file/search` route (read-only `grep` / `find` / `du` with workspace checks, no symlink following, entry/size/time limits).
   - Tests: `cd daemon && npm test`

- [x] 4. Instance-folder command parser (allowed commands and flags, path normalization, `rm` root guard, disk-root instances refused) and `run_instance_command` tool mapped to the daemon file routes, with confirmation and operation log.
   - Tests: `cd panel && npm test`

- [x] 4b. `update_instance` tool: preview of the configured update command, execution through the existing update task, output returned to the model, operation log.
   - Tests: `cd panel && npm test`

- [x] 4c. Daemon: generalize `InstanceUpdateAction` to run a given command (update, installer, admin command) with timeout and bounded output; route for the panel.
   - Tests: `cd daemon && npm test`

- [x] 4d. `install_mod_loader` tool: official metadata and URLs (Forge, NeoForge, Fabric), download with checksum verification, fixed arguments, instance stopped, result with the recommended start command.
   - Tests: `cd panel && npm test`

- [x] 4e. `run_admin_command` tool (administrators only, checked at preview and execution) and assistant instructions listing the command tools per role.
   - Tests: `cd panel && npm test`

- [x] 5. Frontend: allowlist field in the Local AI settings, `ai_instance_command` operation log renderer, i18n keys (en_US, fr_FR, zh_CN).
   - Tests: `cd frontend && npm run type-check && npm run lint && npm test`

- [x] 5b. Administrators' real shell: daemon `instance/ai_shell` (PowerShell/cmd on Windows, sh/bash elsewhere, UTF-8/OEM decoding, timeout) and `run_admin_command { command, shell }`; stale "I cannot run commands" answers removed from the model history.
   - Tests: `cd daemon && npm test`, `cd panel && npm test`

- [x] 5c. Troubleshooting tools: read_console, get_instance_info (suggested start command), update_instance_settings (administrators, start-command guards), restart_instance, kill_instance; refused proposals returned to the model; troubleshooting guide in the instance prompt.
   - Tests: `cd panel && npm test`

- [ ] 6. Full verification.
   - Tests: all module suites and `cd common && npm run test:integration` (ports 23333/24444 must be free).
   - Unit suites done (panel 238, frontend 127, daemon only fails the known Windows-only `mod_update_download.test.ts`). Integration suite pending: the dev servers hold ports 23333/24444.
