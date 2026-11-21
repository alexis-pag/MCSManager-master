# AI Crash Analysis

## ADDED Requirements

### Requirement: Unexpected Stop Records

The daemon SHALL record an unexpected stop when an instance exits without a stop, kill or restart request, and when an instance fails to start. Each record SHALL hold the time, the kind (`exit` or `start_failure`), the exit code or error message, whether an automatic restart was triggered, and the last console lines at the moment of the stop. The daemon SHALL keep at most 200 records, each for at most one hour, in memory only, and SHALL return records newer than a given time through `instance/unexpected_stops` to the authenticated panel.

#### Scenario: Requested stop is not recorded

- **WHEN** an instance is stopped through the panel stop command
- **THEN** no unexpected stop record is created

#### Scenario: Crash is recorded with its console

- **WHEN** a running instance exits by itself with exit code 1
- **THEN** a record with kind `exit`, code 1 and the last console lines is returned by `instance/unexpected_stops`

#### Scenario: Records are bounded

- **WHEN** more than 200 unexpected stops happen within one hour
- **THEN** only the 200 newest records are kept

### Requirement: Crash Analysis Trigger

The panel SHALL collect unexpected stop records from every connected daemon at least every 30 seconds and SHALL run the `crash_analysis` AI task of the affected instance once per record, unless the task ran less than 10 minutes earlier or its previous report is still being generated (status `skipped`). An instance SHALL have at most one `crash_analysis` task, and that kind SHALL use the trigger type "on crash" only.

#### Scenario: Crash triggers an analysis

- **WHEN** an instance with a `crash_analysis` task stops unexpectedly with exit code 1
- **THEN** a report conversation is created and one read-only AI request is queued

#### Scenario: Crash loop is rate limited

- **WHEN** the same instance crashes again 2 minutes after an analysis
- **THEN** no new analysis is started and the task status is `skipped`

#### Scenario: Old daemon without the route

- **WHEN** a daemon does not support `instance/unexpected_stops`
- **THEN** the panel keeps working and simply collects nothing from it

### Requirement: Clean Stop Filter and Crash Data

The panel SHALL collect the console snapshot, the crash report and JVM error file announced in the console, or else the crash report whose name date is within 10 minutes of the stop, and the exit code. It SHALL skip the analysis without calling the model when the stop is an exit with code 0, no crash file, and no error line in the console snapshot. The report SHALL start with a panel-written summary (time, exit code, automatic restart) and SHALL name the crash file used.

#### Scenario: In-game stop is ignored

- **WHEN** the server stops by itself with exit code 0, no crash report and no error in the console
- **THEN** no report is created and the task status is `skipped`

#### Scenario: Crash report is used

- **WHEN** `crash-reports/crash-2026-11-21_03.12.44-server.txt` was written one minute before the stop
- **THEN** its content is sent to the model as trusted data and its name appears in the report
