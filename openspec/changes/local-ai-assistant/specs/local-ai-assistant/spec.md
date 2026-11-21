# Local AI Assistant

## ADDED Requirements

### Requirement: Local engine configuration

The panel SHALL support an administrator-configured OpenAI-compatible local engine.

#### Scenario: Administrator enables a reachable local engine

- **WHEN** an administrator provides an enabled endpoint and model
- **THEN** the panel SHALL discover or select the model
- **AND** SHALL expose connected status

#### Scenario: Engine is unreachable

- **WHEN** model discovery or generation cannot reach the engine
- **THEN** the panel SHALL expose a safe error state
- **AND** SHALL allow reconnection without disabling normal panel operations

### Requirement: Conversation persistence and isolation

The panel SHALL persist conversations and isolate them by authenticated user.

#### Scenario: User creates and resumes a conversation

- **WHEN** an authenticated user creates a conversation
- **THEN** the panel SHALL associate it with the current user
- **AND** SHALL return it only to that owner or an administrator with an explicit permitted audit capability

#### Scenario: Cross-user access attempt

- **WHEN** a user requests another owner's conversation or message
- **THEN** the panel SHALL reject the request
- **AND** SHALL not disclose the other conversation's content

### Requirement: Central FIFO queue

The panel SHALL serialize local AI generations through a centralized server-side queue.

#### Scenario: Multiple users submit requests

- **WHEN** multiple users submit generation requests
- **THEN** the panel SHALL assign unique IDs
- **AND** SHALL process requests in FIFO order unless an authorized higher-priority policy applies
- **AND** SHALL enforce one active generation per engine by default

#### Scenario: Generation fails

- **WHEN** an engine or generation request fails
- **THEN** the queue SHALL mark the request failed
- **AND** SHALL release the engine
- **AND** SHALL process the next request

#### Scenario: Generation is cancelled or times out

- **WHEN** an owner cancels a queued request
- **THEN** the panel SHALL mark it cancelled
- **AND** SHALL exclude it from processing

- **WHEN** a processing request exceeds the configured timeout
- **THEN** the panel SHALL abort it and mark it timeout
- **AND** SHALL release queue capacity

### Requirement: Live queue status

The panel SHALL provide live queue status without exposing other users' private content.

#### Scenario: User monitors queue position

- **WHEN** an authenticated user requests queue status
- **THEN** the panel SHALL return the request state, position, pending count, model, and estimated wait when available
- **AND** SHALL update while streaming or processing

### Requirement: Tool authorization

Tool execution SHALL be a server-side authorization boundary for every call.

#### Scenario: Authorized tool call

- **WHEN** the AI requests an allowlisted tool
- **THEN** the panel SHALL resolve the current user
- **AND** SHALL recheck role and resource assignment
- **AND** SHALL execute only an existing safe panel capability

#### Scenario: Unauthorized tool call

- **WHEN** a user lacks the role or assigned resource required by a tool
- **THEN** the panel SHALL refuse the tool call
- **AND** SHALL log the refusal
- **AND** SHALL not perform a partial action

#### Scenario: Start an instance on explicit request

- **WHEN** a user explicitly asks the assistant to start an existing instance
- **THEN** the assistant SHALL use the start tool
- **AND** the panel SHALL verify the user's current role and instance assignment before forwarding the operation

#### Scenario: Create an instance from a marketplace template

- **WHEN** an administrator directly requests a new server or instance of any game listed in the MCSManager marketplace catalogue
- **THEN** the assistant SHALL select only an exact catalogue template, identified by a panel-computed template ID
- **AND** the panel SHALL require a tool call through a portable OpenAI-compatible `tool_choice` value and, if the engine returns no usable tool call, SHALL request the same arguments as JSON once before reporting a clear error and logging non-secret diagnostics
- **AND** the panel SHALL validate the exact template and online daemon before asking for a separate confirmation that names the instance name, template, and daemon
- **AND** a later explicit confirmation SHALL execute only that exact pending action, expire after 10 minutes, and be cancelled by any other message
- **AND** the panel SHALL verify administrator role (the `allowUsePreset` setting only restricts non-administrators) and pass only the trusted template setup data
- **AND** the panel SHALL report success only when the daemon returns the created instance and task identifiers
- **AND** the daemon SHALL start the instance only after the asynchronous installation succeeds
- **AND** non-administrators SHALL be refused

#### Scenario: Edit files of an instance from its page

- **WHEN** a user selects the AI Assistant button on the page of an instance they are allowed to operate
- **THEN** a chat panel SHALL open on the right side of the instance page, dedicated to that instance
- **AND** the panel SHALL bind the conversation to that instance after verifying the assignment, and SHALL never take the instance from model arguments
- **AND** that conversation SHALL only offer tools acting on that instance (start, stop with confirmation, list/read/edit files), refusing instance creation and access to other instances
- **AND** the assistant SHALL list, read, and propose edits only for files of that instance, with the file manager permission rules re-checked on every call and paths confined to the instance directory
- **AND** the panel SHALL show the exact change as a diff and write it only after a later explicit confirmation of that exact change, refusing if the file changed since the preview
- **AND** every written file SHALL be recorded in the operation log

#### Scenario: Install a plugin from the instance assistant

- **WHEN** a user asks the instance assistant to install or update a plugin (or a mod on Fabric/Forge servers)
- **THEN** the panel SHALL detect the server software and Minecraft version from the instance itself
- **AND** the assistant SHALL search the MCSManager plugin sources and choose a project, while the panel SHALL pick the newest compatible version and take the download URL only from the source API, restricted to official HTTPS hosts
- **AND** the panel SHALL show the plugin, version, file, detected server, and any replaced older copy, and install only after a later explicit confirmation, with the same permissions as the plugin manager
- **AND** the panel SHALL report success only when the file is present in the instance, and SHALL report a failed or still-running download as such

#### Scenario: Sensitive tool call

- **WHEN** the AI proposes a destructive or sensitive action
- **THEN** the panel SHALL require separate authenticated user confirmation
- **AND** SHALL execute it only after confirmation

### Requirement: Audit and monitoring

The panel SHALL record AI lifecycle and tool decisions without storing unnecessary secrets.

#### Scenario: Request lifecycle

- **WHEN** a request is queued, processed, cancelled, failed, or timed out
- **THEN** the panel SHALL record timestamps, request ID, user, model, duration, state, and safe error information

#### Scenario: Tool call lifecycle

- **WHEN** a tool is proposed or executed
- **THEN** the panel SHALL record the tool name, resource, decision, duration, and confirmation state
