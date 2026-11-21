# Administrator Approvals

## ADDED Requirements

### Requirement: AI Access Grant

Regular users SHALL NOT use the local AI (conversations, messages, instance assistant, AI tasks) until an administrator grants them access. Administrators SHALL always have access. A regular user SHALL be able to request access with a reason, and an administrator SHALL be able to grant, refuse or revoke it. The AI-moderated ban request SHALL remain available without AI access.

#### Scenario: User without access is refused

- **WHEN** a regular user without granted access sends a message to the AI
- **THEN** the request is rejected with "AI access required"

#### Scenario: Access granted

- **WHEN** an administrator grants access to a pending request
- **THEN** the user can use the AI and the decision is written to the operation log

#### Scenario: Access revoked

- **WHEN** an administrator revokes a user's access
- **THEN** the user's AI requests are rejected and the user's AI tasks are skipped when they fire

#### Scenario: Ban request without AI access

- **WHEN** a regular user without AI access submits a ban request
- **THEN** the request is accepted and reviewed as usual

### Requirement: Automation Approval

A schedule or AI task created or edited by a regular user SHALL be stored as a pending request and SHALL NOT run until an administrator approves it. On approval the panel SHALL re-validate the request and create the task through the normal path; on refusal the task SHALL NOT be created. An edit SHALL keep the current task active until its replacement is approved. Automations created by administrators SHALL be active immediately.

#### Scenario: Regular user creates a schedule

- **WHEN** a regular user creates a daily restart schedule
- **THEN** nothing is registered on the daemon and a pending request is visible to administrators

#### Scenario: Administrator approves

- **WHEN** an administrator approves the request
- **THEN** the schedule is registered on the daemon exactly as requested

#### Scenario: Requester lost the instance meanwhile

- **WHEN** an administrator approves a request whose requester is no longer assigned to the instance
- **THEN** the approval fails with an explanation and nothing is created

#### Scenario: Administrator creates a schedule

- **WHEN** an administrator creates a schedule
- **THEN** it is registered immediately without a request

### Requirement: Existing Automations Migration

Automations that existed before this change and were not created by an administrator SHALL be suspended and converted into pending requests. For server-action schedules the creator SHALL be taken from the operation log; when it cannot be found the schedule SHALL be suspended as well. A schedule SHALL be removed from the daemon only after its request is stored.

#### Scenario: Schedule created by a regular user

- **WHEN** the operation log shows that a regular user created an existing schedule
- **THEN** the schedule is removed from the daemon and appears as a pending request from that user

#### Scenario: Schedule created by an administrator

- **WHEN** the operation log shows that an administrator created an existing schedule
- **THEN** the schedule keeps running

### Requirement: Administrator Notifications

Administrators SHALL see in the panel header the number of pending AI access and automation requests, refreshed at least every 30 seconds, and SHALL be able to open each request with its details and approve or refuse it with an optional note. Every decision SHALL be recorded in the operation log.

#### Scenario: New request appears

- **WHEN** a regular user submits an AI access request
- **THEN** within 30 seconds the administrators' header badge counts it

#### Scenario: Regular users do not see the approval center

- **WHEN** a regular user calls the approvals API
- **THEN** the request is rejected
