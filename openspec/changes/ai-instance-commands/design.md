# Design: AI Instance Commands

## Context

- `AiToolService` (`panel/src/app/service/ai_tool_service.ts`) declares the AI tools. Conversations bound to an instance only expose `SCOPED_TOOLS`, and the target instance comes from the server-side context, never from the model.
- Actions that change something are stored as a pending confirmation (per conversation, 10 min TTL) and executed by the panel itself when the user's next message is an explicit "yes" (`PANEL_CONFIRMED_TOOLS`).
- The daemon file manager (`daemon/src/service/system_file.ts`) already enforces the instance workspace boundary, including symlinks, for `file/list`, `file/edit`, `file/mkdir`, `file/touch`, `file/copy`, `file/move`, `file/delete`, `file/compress`. It skips the checks when the instance folder is the disk root (`isRootTopRath`).
- `isBanCommand` (`common/src/ban_command_filter.ts`) already detects ban commands; regular users cannot ban without the AI-moderated flow.
- The daemon route `instance/command` writes a command to the instance's console.

## Decisions

### 1. Console commands — `send_console_command { command }`

Validation (panel, before the pending confirmation is even created):

1. String, 1-256 characters, no control characters or line breaks (one command only).
2. Leading `/` removed; first word lowercased. A `namespace:` prefix is accepted only for `minecraft:` and is stripped; any other namespace is refused.
3. The command must start with an entry of `systemConfig.aiConsoleCommandAllowlist` (default `["help","list","me","msg","tell","w","teammsg","tm","trigger","random","say","seed","time query"]`, editable by administrators, max 50 entries of one or two words `[a-z0-9_-]{1,32}`). A two-word entry matches only when both first words match.
4. `isBanCommand` → refused.
5. Instance bound to the conversation, user still has it (`isHaveInstance`), instance running.

Execution after "yes": `instance/command`, wait ~2 s, return the console lines added since the command (via the output log, max 40 lines / 4000 characters, marked as untrusted text for the model).

An allowlist (not a blocklist) is used because "administrator command" cannot be listed exhaustively: plugins add their own (`/lp`, `/ess`, `/co`…), and the console runs every command with full operator rights.

### 2. Instance-folder commands — `run_instance_command { command, args }`

Structured input (no command-line string to parse): `command` is one of the allowed names, `args` an array of strings (max 10, each ≤ 512 characters). Allowed flags per command; anything else is refused:

| Command | Flags | Implementation |
| --- | --- | --- |
| `ls [path]` | `-a`, `-l` | `file/list` |
| `cat path` | — | `file/edit` read, ≤ 12000 chars |
| `head`/`tail path` | `-n N` (≤ 200) | `file/edit` read |
| `wc path` | `-l` | `file/edit` read |
| `grep pattern [path]` | `-i`, `-r`, `-n` | new daemon `file/search` |
| `find [path]` | `-name pattern` | new daemon `file/search` |
| `du [path]` | `-s` | new daemon `file/search` |
| `mkdir path` | `-p` | `file/mkdir` |
| `touch path` | — | `file/touch` |
| `cp src dest` | `-r` | `file/copy` |
| `mv src dest` | — | `file/move` |
| `rm path…` | `-r`, `-f` | `file/delete` |
| `zip dest.zip paths…` | — | `file/compress` (type compress) |
| `unzip file.zip [dest]` | — | `file/compress` (type decompress) |

- Paths: relative to the instance folder, `normalizeInstancePath` in the panel (no `..`, no control characters), then the daemon boundary check. `rm` refuses `/`, `.` and the empty path.
- `grep` patterns are plain text only (no regular expressions), so a pattern cannot stall the daemon.
- New daemon route `file/search` (read-only; also `workspace` to detect a disk-root folder and `stat` so `rm`/`cp` require `-r` for folders): walks the instance folder with the file manager's checks, symlinks not followed, limits: 5000 entries, depth 12, files ≤ 2 MB for `grep`, 200 results, 5 s.
- Instances whose working directory is the disk root are refused for every instance-folder command.
- No process is spawned: this is not a shell, so pipes, redirections, globs (except `find -name`), variables, `sudo`, `&&` do not exist.

### 3. Instance update — `update_instance {}`

- No arguments: the target is the bound instance, the command is the instance's `updateCommand` configured by an administrator. Refused when no update command is configured or the instance is running/busy.
- Executed through the same daemon task as the "Update" button (`/protected_instance/asynchronous`, `task_name=update`, already allowed to regular users), so no new execution path exists.
- The preview shows the configured update command (read-only) so the user knows what will run; the assistant receives the last 40 lines of the update output.
- Useful when an administrator already configured an installer as the update command.

### 4. Mod loader installer — `install_mod_loader { loader, minecraftVersion, loaderVersion? }` (users with AI access)

The assistant only chooses the loader and the versions; the panel decides what is downloaded and executed.

- `loader`: `forge`, `neoforge` or `fabric`. Versions validated against the official metadata (Forge/NeoForge `maven-metadata.xml`, `meta.fabricmc.net`); `loaderVersion` defaults to the recommended/latest version for that Minecraft version.
- The daemon route `instance/ai_command` downloads, verifies the SHA-256 and runs the installer in one call (no window between verification and execution steps driven by the panel). Download only from the official HTTPS repositories (`maven.minecraftforge.net`, `maven.neoforged.net`, `maven.fabricmc.net`), into the instance folder, with the repository's checksum file verified before execution. A jar uploaded by a user is never executed by this tool.
- Fixed arguments, never taken from the model:
  - Forge / NeoForge: `java -jar <installer>.jar --installServer`
  - Fabric: `java -jar <installer>.jar server -mcversion <mc> -loader <version> -downloadMinecraft`
- Executed by a generalized daemon `InstanceUpdateAction` (same spawn without shell, same working directory, same Docker image rules as the update command), with the instance's Java when one is configured. Instance must be stopped. Timeout 15 min.
- Result: last 40 output lines, success flag, and the recommended start command for the daemon's OS (`java @user_jvm_args.txt @libraries/…/win_args.txt nogui` on Windows, `unix_args.txt` otherwise; `java -jar fabric-server-launch.jar nogui` for Fabric). The assistant shows it; only an administrator can apply it in the instance settings.

### 5. Shell — `run_admin_command { command, shell? }` (administrators only)

- Available only when the conversation's user is an administrator (checked at preview and again at execution); never declared to regular users.
- `shell`: `powershell` (default) or `cmd` on Windows daemons, `sh` (default) or `bash` elsewhere; the panel reads the daemon OS from `info/overview` and refuses an unavailable shell.
- New daemon route `instance/ai_shell`: spawns the shell on the daemon host with the instance folder as working directory (PowerShell through `-EncodedCommand`, cmd through `/d /s /c` verbatim), one command per instance at a time, 10-minute timeout (process tree killed), output tail returned. The instance status is not changed, so it works while the server runs.
- Output: PowerShell forced to UTF-8; otherwise decoded as UTF-8 when valid, else from the Windows OEM code page (cmd).
- Administrators can already configure any start/update command, so this adds no privilege. The risk is a model misled by file or log content proposing a harmful command: mitigated by showing the exact command and shell, requiring "yes", and logging it.

### 5b. Assistant instructions

The instance assistant's system prompt lists the command tools available to the current user (administrators also see `run_admin_command`) with short examples, and states:

- never answer "I cannot run commands" when a tool covers the request; propose the tool call instead;
- to install or repair Forge/NeoForge/Fabric, use `install_mod_loader` (or `run_admin_command` for administrators) rather than asking the user to open a terminal;
- before diagnosing a start failure, read the console output and list the instance files (e.g. a `sh ./run.sh` start command on a Windows daemon, a missing `server.jar` on modern Forge which starts through `run.bat`/`run.sh`).

### 6. Confirmation

The five tools are added to `SCOPED_TOOLS` and `PANEL_CONFIRMED_TOOLS`. Read commands also require confirmation (requested behaviour). The pending action stores the validated, normalized command; the "yes" executes exactly that. The preview shown to the user is the normalized command line (e.g. `grep -i -n "error" logs/latest.log`).

### 7. Access

- Instance-bound conversations only (the AI page's global conversations do not get these tools).
- Requires AI access (admin-approvals change) and `isHaveInstance` at preview and again at execution.
- Not in `READ_ONLY_TOOLS`: scheduled AI tasks never get them.

### 8. Audit

Operation log type `ai_instance_command` `{ instance_id, daemon_id, instance_name, kind: "console" | "file" | "update" | "loader" | "admin", command }` written after execution (success or failure).

## Risks

- **Allowlist too strict for non-Minecraft games**: the administrator adds the game's commands in the settings.
- **Large folders**: `grep`/`find`/`du` are bounded; results say when they were truncated.
- **Model tricking the user**: the user always sees the exact normalized command before it runs, and the allowlist/boundary checks apply even after confirmation.

## Implementation Notes

- The pending confirmation stores only arguments of the model's input shape (`command`, `args`, `loader`/versions, a hash of the update command); URLs, checksums and the executed command are recomputed server-side when the user says "yes", so a model cannot smuggle its own URL or command into a confirmation.

## Troubleshooting Tools (added)

- `read_console { lines? }` and `get_instance_info {}`: read-only, no confirmation, results returned to the model. `read_console` also returns the daemon OS, the start command (administrators) and `suggestedStartCommand`; `get_instance_info` returns status, type, daemon OS and, for administrators, commands, encodings, Java and the installed Java runtimes.
- `suggestedStartCommand` is computed by the panel from the installed files: newest `libraries/net/{minecraftforge,neoforged}/**/{win,unix}_args.txt` → `java @user_jvm_args.txt @<file> nogui`; `fabric-server-launch.jar` → `java -jar fabric-server-launch.jar nogui`; otherwise empty.
- `update_instance_settings` (administrators): start/stop/update commands, ie/oe, crlf, stop timeout, automatic restart, Java (`javaId` must be an installed runtime). Old → new values shown, "yes" required, `instance_config_change` logged with the diff. A start command is refused (with the suggestion) when it uses sh/bash on a Windows daemon, run.bat/run.sh, or a jar missing from the instance folder; values containing placeholders such as `<version>` are refused.
- `restart_instance` / `kill_instance`: everyone who can operate the instance, after "yes".
- A command tool refused before confirmation is returned to the model (at most twice per request) so it can correct its arguments; the tool-call loop allows 10 rounds for diagnosis.
- Validated with the owner's local model (gpt-oss-20b) on the real "sh ./run.sh on Windows" failure: 3/3 runs proposed the exact Forge start command after reading the console.

## Any Instance Type (added)

- Administrator shell on a **Docker** instance runs inside its Linux container: `docker exec` in the running container (instance working directory), or, when stopped, a one-off container of the instance image through the update-command path (`sh -c "echo <base64> | base64 -d | sh"`). Only sh/bash are offered for Docker instances.
- `suggestedStartCommand` covers Forge/NeoForge (args files), Fabric, Quilt, Paper, Purpur, Folia, Spigot, Mohist, Arclight, legacy Forge, vanilla and Bedrock (`bedrock_server.exe` / `./bedrock_server`); empty for other games.
- `install_mod_loader` is refused for non-Java instance types (Bedrock, Steam games…).
- The instance prompt tells the model the instance can be any game and to adapt to its type and to Docker.
