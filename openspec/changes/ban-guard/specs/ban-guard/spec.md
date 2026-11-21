# Ban Guard

## ADDED Requirements

### Requirement: Unauthorized Bans Are Reverted

When an instance console shows a player or IP ban that was not applied through the panel's "Ban a player" flow, the daemon SHALL revert it with `pardon` or `pardon-ip`, print a notice in the console, and the panel SHALL record it in the operation log.

#### Scenario: Operator bans in game

- **WHEN** an operator runs `/ban Steve` in game
- **THEN** Steve is pardoned automatically and the operation log shows the reverted ban

#### Scenario: Ban through the panel flow

- **WHEN** an administrator applies a justified ban from "Ban a player"
- **THEN** the ban stays in place

#### Scenario: Player chat

- **WHEN** a player writes "Banned Bob: lol" in the chat
- **THEN** nothing is pardoned

### Requirement: Crash Records Reach the Panel

The daemon SHALL answer the panel's `instance/unexpected_stops` listing, which has no instance identifier.

#### Scenario: Crash analysis

- **WHEN** an instance with a crash analysis task crashes
- **THEN** the panel receives the crash record
