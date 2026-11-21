# AI-Moderated Player Bans

## ADDED Requirements

### Requirement: Ban Request Validation

The panel SHALL accept a ban request only from administrators or users assigned to the instance, with a valid Java player name, a reason of 15 to 200 characters that is not a placeholder, and at least one piece of evidence (verified console log lines, a description of at least 30 characters, or one of at most 3 images). Console log lines SHALL be kept only if they exist in the instance console log at submission time.

#### Scenario: Placeholder reason is rejected

- **WHEN** a user submits a ban request with the reason "test test test test"
- **THEN** the request is rejected before any AI call

#### Scenario: Missing evidence is rejected

- **WHEN** a user submits a ban request with a valid reason and no evidence
- **THEN** the request is rejected

#### Scenario: Fabricated log line is dropped

- **WHEN** a request includes a "log line" that does not appear in the instance console log
- **THEN** that line is not stored as verified evidence

### Requirement: AI Ban Verdict

The panel SHALL submit each valid ban request to the local AI queue without tools and SHALL store a verdict of `justified`, `not_justified` or `insufficient_evidence` with a suggested sanction and an explanation. A reply that cannot be parsed into this structure SHALL be stored as `insufficient_evidence`.

#### Scenario: Evidence supports the ban

- **WHEN** the AI returns `justified` for a case
- **THEN** the case shows the verdict, sanction and explanation and can be applied

#### Scenario: Unparseable reply

- **WHEN** the AI reply is not a valid verdict object
- **THEN** the case is `insufficient_evidence` and cannot be applied without an override

### Requirement: Applying a Ban

The panel SHALL send `ban <player> <reason>` to the instance only after an explicit apply request, only for a `justified` case or an administrator override, and only while the instance is running. The command SHALL be built by the panel from validated fields. Each application SHALL be recorded in the operation log.

#### Scenario: Justified ban is applied

- **WHEN** the requester applies a `justified` case on a running instance
- **THEN** the ban command is sent and the case becomes `applied`

#### Scenario: Not justified ban is blocked

- **WHEN** a regular user applies a `not_justified` case
- **THEN** the request is rejected and no command is sent

#### Scenario: Administrator override

- **WHEN** an administrator overrides a `not_justified` case with an override note
- **THEN** the ban command is sent, the case records the note, and an override entry is written to the operation log

### Requirement: Ban Case History and Evidence Access

The panel SHALL list ban cases per instance (own cases for regular users, all cases for administrators), SHALL serve evidence images only to the requester and administrators, and SHALL delete cases and their evidence 90 days after creation.

#### Scenario: Other user cannot read evidence

- **WHEN** a regular user requests an evidence image of another user's case
- **THEN** the request is rejected with 403

#### Scenario: Old case is purged

- **WHEN** a case is older than 90 days
- **THEN** the case and its evidence files are deleted
