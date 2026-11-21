# instance-schedules (delta)

## ADDED Requirements

### Requirement: Backup Action

The daemon SHALL accept a `backup` schedule action whose payload is a JSON object `{"paths": string[], "keep": number}` (a plain string payload is read as one path with `keep` 7). At registration the daemon SHALL reject the task unless there are 1 to 5 paths, each resolving inside the instance directory and outside `backups/`, and `keep` is an integer from 1 to 30. When the action runs, the daemon SHALL write `backups/backup-YYYYMMDD-HHmmss.zip` inside the instance directory, then delete the oldest `backup-*.zip` files beyond `keep`. Only one backup per instance SHALL run at a time.

#### Scenario: Nightly world backup

- **WHEN** a backup action with paths `["world"]` and keep 7 runs
- **THEN** a new zip of `world` is created in `backups/`
- **AND** at most 7 `backup-*.zip` files remain

#### Scenario: Path outside the instance is rejected

- **WHEN** a backup action is registered with the path `../other-instance`
- **THEN** the registration is rejected

#### Scenario: Overlapping backup is skipped

- **WHEN** a backup action fires while a backup of the same instance is still running
- **THEN** the second backup is skipped and logged

## MODIFIED Requirements

### Requirement: Schedule Task Model

The daemon SHALL represent a schedule task as a named record bound to one instance, carrying a numeric trigger type (1 = interval, 2 = daily cycle, 3 = specified time), a trigger value, a recurrence count, and an ordered list of actions, where each action has a type (delay, start, stop, restart, command, kill, backup) and a payload. The two non-interval trigger types carry cron-style expressions. Legacy single-action schedule records SHALL be migrated to the action-list form at boot.

#### Scenario: Interval trigger stores seconds

- **WHEN** an interval schedule is registered with a time value
- **THEN** the stored trigger type is interval and the trigger value is the interval in seconds

#### Scenario: Cron triggers store an expression

- **WHEN** a daily-cycle or specified-time schedule is registered
- **THEN** the stored trigger value is the cron expression, whose seconds field MUST NOT be the wildcard form
