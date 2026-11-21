# AI Instance Commands

## ADDED Requirements

### Requirement: Console Commands Through the Assistant

The instance assistant SHALL be able to send a console command to the instance bound to the conversation only when the command's first word is in the administrator-editable allowlist, the command is a single line of at most 256 characters, it is not a ban command, and the user confirmed it. Administrator commands SHALL NOT be sent, for any user.

#### Scenario: Allowed command after confirmation

- **WHEN** the user asks who is online and confirms `list`
- **THEN** `list` is sent to the instance and the assistant receives the console lines printed afterwards

#### Scenario: Administrator command refused

- **WHEN** the assistant proposes `op Steve` or `lp user Steve permission set *`
- **THEN** the command is refused before any confirmation is asked and nothing is sent

#### Scenario: Several commands in one submission

- **WHEN** the proposed command contains a line break
- **THEN** it is refused

#### Scenario: No confirmation

- **WHEN** the user does not answer "yes" to the proposed command
- **THEN** nothing is sent

### Requirement: Instance-Folder Commands Through the Assistant

The instance assistant SHALL be able to run a fixed set of file commands (`ls`, `cat`, `head`, `tail`, `wc`, `grep`, `find`, `du`, `mkdir`, `touch`, `cp`, `mv`, `rm`, `zip`, `unzip`) on the instance folder after the user confirms them. They SHALL NOT start any process on the host, and every path SHALL stay inside the instance folder.

#### Scenario: Search in logs

- **WHEN** the user confirms `grep -i "error" logs/latest.log`
- **THEN** the matching lines are returned, bounded in size

#### Scenario: Path outside the instance folder

- **WHEN** the assistant proposes `cat ../../etc/passwd` or a path through a symlink leading outside the folder
- **THEN** the command is refused and nothing is read

#### Scenario: Unknown command or shell syntax

- **WHEN** the assistant proposes `curl`, `sudo`, `chmod`, a pipe or a redirection
- **THEN** the command is refused

#### Scenario: Instance folder is the disk root

- **WHEN** the instance's working directory is the root of the disk
- **THEN** every instance-folder command is refused

### Requirement: Instance Update Through the Assistant

The instance assistant SHALL be able to run the instance's update command, as configured by an administrator, after the user confirms it. The assistant SHALL NOT choose or change the command that is executed.

#### Scenario: Forge installer configured as update command

- **WHEN** the update command is `java -jar forge-26.3-66.0.3-installer.jar --installServer` and the user confirms the update
- **THEN** the panel runs the same update task as the "Update" button and the assistant reports the result from its output

#### Scenario: No update command

- **WHEN** the instance has no update command
- **THEN** the tool is refused and the assistant tells the user an administrator must configure it

### Requirement: Mod Loader Installation Through the Assistant

The instance assistant SHALL be able to install Forge, NeoForge or Fabric on the bound instance after the user confirms it. The panel SHALL download the installer only from the loader's official repository, verify its checksum, and run it with fixed arguments in the instance folder through the update-command execution path. The assistant SHALL only choose the loader and the versions.

#### Scenario: Install Forge

- **WHEN** a user with AI access asks to install Forge 66.0.3 for Minecraft 26.3 and confirms
- **THEN** the official installer is downloaded, verified and run with `--installServer`, and the assistant reports the result and the start command to use

#### Scenario: Uploaded jar

- **WHEN** a regular user asks the assistant to run a jar they uploaded
- **THEN** no tool runs it

#### Scenario: Instance running

- **WHEN** the instance is running
- **THEN** the installation is refused until it is stopped

### Requirement: Shell for Administrators

The instance assistant SHALL offer administrators, and only them, a real shell on the daemon machine starting in the instance folder (PowerShell or cmd on Windows, sh or bash on Linux), run after confirmation, with a time limit, whether the server runs or not.

#### Scenario: Administrator runs a PowerShell command

- **WHEN** an administrator confirms `Get-ChildItem` in PowerShell
- **THEN** it runs in the instance folder and the assistant shows its output

#### Scenario: cmd on Windows

- **WHEN** an administrator confirms `dir` with the cmd shell
- **THEN** it runs through cmd and accented output is readable

#### Scenario: Regular user

- **WHEN** a regular user talks to the assistant
- **THEN** the shell tool is not offered, and a call is refused

### Requirement: Stale Refusals Ignored

In instance-bound conversations, earlier assistant answers claiming that commands cannot be run SHALL NOT be sent back to the model.

#### Scenario: Conversation started before the command tools

- **WHEN** the conversation contains an earlier "I cannot run shell commands" answer
- **THEN** the model receives the history without it and can call the command tools

### Requirement: Assistant Knows Its Command Tools

The instance assistant's instructions SHALL list the command tools available to the current user and SHALL direct it to use them instead of telling the user to open a terminal.

#### Scenario: Installation request

- **WHEN** the user asks how to install Forge on the instance
- **THEN** the assistant proposes the installation through its tool instead of answering that it cannot run commands

### Requirement: Command Access and Audit

The command tools SHALL be available only in conversations bound to an instance, to users who can operate that instance and have AI access, and SHALL NOT be available to scheduled AI tasks. Every executed command SHALL be written to the operation log.

#### Scenario: Access lost before confirmation

- **WHEN** the user loses the instance or AI access between the proposal and the "yes"
- **THEN** the command is not executed

#### Scenario: Audit

- **WHEN** a confirmed command is executed
- **THEN** the operation log records the user, the instance, the kind and the exact command
