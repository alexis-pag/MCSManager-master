# ai-scheduled-tasks (delta)

## MODIFIED Requirements

### Requirement: AI Scheduled Task Model

The panel SHALL store AI scheduled tasks bound to one instance and one owner, with a kind (`console_report`, `file_check`, `plugin_updates`, `custom_prompt`, `crash_analysis`), a trigger type and value, and a recurrence count using the instance-schedule semantics. Trigger types 1 to 3 use the instance-schedule formats; trigger type 4 ("on crash", empty time) is valid only for `crash_analysis`, which accepts no other trigger. The panel SHALL allow at most 4 AI tasks per instance, at most one `crash_analysis` task per instance, and an interval of at least 3600 seconds for interval triggers.

#### Scenario: Valid AI task is registered

- **WHEN** an assigned user creates a `console_report` task with a daily trigger
- **THEN** the task is stored, scheduled, and listed with the instance schedules

#### Scenario: Interval below one hour is rejected

- **WHEN** an AI task is created with an interval of 600 seconds
- **THEN** the creation is rejected and nothing is stored

#### Scenario: Fifth AI task is rejected

- **WHEN** an instance already has 4 AI tasks and a fifth is created
- **THEN** the creation is rejected

#### Scenario: Crash trigger is reserved to crash analysis

- **WHEN** a `console_report` task is created with trigger type 4, or a `crash_analysis` task with a daily trigger
- **THEN** the creation is rejected
