# AI Scheduled Tasks

## ADDED Requirements

### Requirement: AI Scheduled Task Model

The panel SHALL store AI scheduled tasks bound to one instance and one owner, with a kind (`console_report`, `file_check`, `plugin_updates`, `custom_prompt`), a trigger type and value using the instance-schedule formats, and a recurrence count using the instance-schedule semantics. The panel SHALL allow at most 4 AI tasks per instance and an interval of at least 3600 seconds.

#### Scenario: Valid AI task is registered

- **WHEN** an assigned user creates a `console_report` task with a daily trigger
- **THEN** the task is stored, scheduled, and listed with the instance schedules

#### Scenario: Interval below one hour is rejected

- **WHEN** an AI task is created with an interval of 600 seconds
- **THEN** the creation is rejected and nothing is stored

#### Scenario: Fifth AI task is rejected

- **WHEN** an instance already has 4 AI tasks and a fifth is created
- **THEN** the creation is rejected

### Requirement: AI Scheduled Task Access Control

The panel SHALL allow listing, creating and deleting AI tasks only to administrators and users assigned to the instance, and SHALL recheck the owner's access to the instance at every firing.

#### Scenario: Non-assigned user is refused

- **WHEN** a regular user creates an AI task for an instance they are not assigned
- **THEN** the request is rejected with 403

#### Scenario: Owner loses access

- **WHEN** an AI task fires after its owner was unassigned from the instance
- **THEN** no AI request is submitted
- **AND** the task is disabled with reason `access_lost`

### Requirement: AI Scheduled Tasks Are Read-Only

A firing SHALL run with a read-only tool context. The panel MUST NOT declare or execute tools that write files, install plugins, start, stop, or send commands to an instance during a scheduled run, even if the model requests them.

#### Scenario: Model requests an edit during a scheduled run

- **WHEN** the model calls `edit_instance_file` during a scheduled run
- **THEN** the tool executor refuses the call
- **AND** no file is written and no confirmation is registered

### Requirement: AI Scheduled Task Firing

When an AI task fires, the panel SHALL skip the run (status `skipped`) if the local AI is disabled or the previous run of the same task is still queued or processing; otherwise it SHALL create a report conversation scoped to the instance and submit the run through the shared FIFO AI queue under the owner's identity.

#### Scenario: Previous run still pending

- **WHEN** a task fires while its previous run is still queued
- **THEN** no new request is submitted and the task status is `skipped`

#### Scenario: Normal firing

- **WHEN** a task fires with the AI enabled and access confirmed
- **THEN** a report conversation is created and one request is queued for it

### Requirement: AI Task Kinds

The panel SHALL prepare each kind from data it collects itself: `console_report` from the last 200 lines of the instance console log; `file_check` from an allowlist of existing configuration files, with syntax errors detected by the panel and credential values redacted before reaching the model; `plugin_updates` from the installed plugin or mod files compared against the latest compatible versions found by the panel; `custom_prompt` from the owner's instruction of at most 2000 characters.

#### Scenario: Empty console log

- **WHEN** a `console_report` task fires and the console log is empty or missing
- **THEN** the report says there is nothing to report and the model is not called

#### Scenario: Broken YAML file

- **WHEN** a `file_check` task fires and `bukkit.yml` does not parse
- **THEN** the report lists the parse error for `bukkit.yml` as detected by the panel

#### Scenario: Credentials are redacted

- **WHEN** `server.properties` contains `rcon.password=secret`
- **THEN** the content sent to the model shows the value redacted

#### Scenario: Plugin with a newer compatible version

- **WHEN** a `plugin_updates` task finds an installed plugin older than the latest compatible version
- **THEN** the report lists the plugin, the installed file, and the newer version
- **AND** nothing is downloaded

### Requirement: Report Retention

Report conversations SHALL be marked as reports, shown in the instance AI history with a report tag, and deleted `aiReportRetentionDays` (default 7, range 1-90) after their last message. Chat conversations SHALL keep their existing retention.

#### Scenario: Report outlives chat retention

- **WHEN** a report conversation is 3 hours old and retention is 7 days
- **THEN** it is still listed and readable

#### Scenario: Report expires

- **WHEN** a report conversation's last message is older than the report retention
- **THEN** the panel deletes it
