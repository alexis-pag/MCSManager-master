# AI Instance Commands: Console, Instance Folder, Mod Loader Installer

## Why

The owner wants the instance assistant to run commands for the user instead of only explaining them:

- **Server console commands** (e.g. `list`, `help`), but never administrator commands (`op`, `ban`, `stop`, `whitelist`, `gamemode`, plugin admin commands…).
- **Shell-like commands** (`ls`, `cat`, `grep`, `cp`, `unzip`…) limited to the instance folder, without any administrator privilege.
- **Commands like `java -jar forge-…-installer.jar --installServer`**: the assistant must know it can install a mod loader itself instead of telling the user to open a terminal. For administrators, any command in the instance folder.

Every command must be shown to the user and run only after the user confirms it.

## What Changes

- **Console commands** (new tool `send_console_command`)
  - Allowed only when the first word of the command is in an **allowlist**. Default allowlist: the Minecraft commands available to players without operator rights (`help`, `list`, `me`, `msg`, `tell`, `w`, `teammsg`, `tm`, `trigger`, `random`) plus harmless ones (`say`, `seed`, `time query`). An entry may have two words, so `time query` is allowed while `time set` is not. Administrators can edit the allowlist in the Local AI settings (for example to add the commands of another game).
  - Refused regardless of the allowlist: ban commands (existing filter), several commands in one submission (line breaks, control characters), more than 256 characters, namespaced commands other than `minecraft:` (`luckperms:…`, `essentials:…`).
  - Sent only to the instance bound to the conversation, only while it is running. The panel returns the console lines printed in the next seconds so the assistant can read the answer.
  - The allowlist applies to everybody, administrators included: the assistant never sends administrator commands.
- **Instance-folder commands** (new tool `run_instance_command`)
  - A fixed set of commands implemented by the panel and the daemon's file manager, **not** a system shell: no process is started on the host, no pipes, redirections, variables, globs or `sudo`.
  - Read: `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `find`, `du`. Change: `mkdir`, `touch`, `cp`, `mv`, `rm`, `zip`, `unzip`.
  - Every path is checked by the daemon's existing workspace boundary (relative paths, no `..`, symlinks resolved). Instances whose folder is the root of the disk are refused. `rm` cannot delete the instance folder itself.
  - Output and work are bounded (output size, number of files walked, file size for `grep`, time).
- **Instance update** (new tool `update_instance`)
  - Runs the instance's update command, exactly as the "Update" button does (regular users may already trigger it). The command itself is set by an administrator in the instance settings, never by the assistant. Typical use: run a Forge/NeoForge installer (`java -jar forge-…-installer.jar --installServer`) configured as the update command.
  - The assistant gets the end of the update output to report success or failure.
- **Mod loader installer** (new tool `install_mod_loader`, users with AI access)
  - Installs Forge, NeoForge or Fabric: the assistant only gives the loader and the versions. The panel downloads the official installer itself (official HTTPS repositories, checksum verified) and runs it with fixed arguments (`java -jar …-installer.jar --installServer` for Forge/NeoForge), in the instance folder, with the instance's Java, the same way as the update command (Docker included). A jar uploaded by a user is never executed.
  - Returns the result and the start command to use on this daemon (e.g. `java @user_jvm_args.txt @libraries/…/win_args.txt nogui` on Windows); an administrator applies it in the instance settings.
- **Shell for administrators** (new tool `run_admin_command`)
  - Administrators only: a real shell on the daemon machine starting in the instance folder — PowerShell (default) or cmd on Windows, sh or bash on Linux. Works while the server runs. Shown in full and run after "yes"; 10-minute limit; output forced/decoded to UTF-8 (cmd output decoded from the Windows OEM code page). Administrators can already configure any start/update command, so no privilege is added.
- **Assistant instructions**: the system prompt tells the assistant which command tools it has, to use them instead of answering "I cannot run commands", and to read the console and the instance files before diagnosing a start failure.
- **Confirmation**: all tools always show the exact command and run it only after the user answers "yes" (existing server-side confirmation mechanism). Nothing runs on a model's say-so alone.
- **Scope and access**: available only in conversations bound to an instance (instance assistant), to users who can operate that instance and have AI access. Not available to scheduled AI tasks (read-only).
- **Audit**: every executed command is written to the operation log (`ai_instance_command`).

## Out of Scope

- A shell or arbitrary `java -jar` for regular users (a user can upload any jar, so this would give them the host).
- `docker exec` inside a running instance container.
- Changing the start command from the assistant (stays in the instance settings, administrators only).
- Commands outside the instance folder, process management (`kill`, `ps`), network tools (`curl`, `wget`), package managers, permission changes (`chmod`, `chown`).
- Per-user or per-instance allowlists (one panel-wide console allowlist).

## Impact

- Affected modules: panel (five AI tools, command parsing and validation, loader metadata/download, console allowlist setting, system prompt, operation log type), daemon (read-only route for `grep`/`find`/`du`; `InstanceUpdateAction` generalized to run a given command), frontend (allowlist field in the Local AI settings, operation log renderer), languages.
- Security: regular users get no new way to choose what is executed on the host: the file commands spawn no process, the installer is an official checksum-verified jar with fixed arguments. Free commands are limited to administrators, who already have that power.
