# Implementation Tasks

- [x] 1. Add `AiBanCase` storage, input validation (player, reason, evidence), verified log-line filtering, evidence image storage with type sniffing, 90-day purge.
   - Tests: `cd panel && npm test`

- [x] 2. Add the AI review: queue submission without tools, moderator prompt, verdict parsing with the `insufficient_evidence` fallback, optional vision parts behind `aiVisionEnabled`.
   - Tests: `cd panel && npm test`

- [x] 3. Add apply and override: state checks, running-instance check, panel-built command through the existing instance command path, operation log entries.
   - Tests: `cd panel && npm test`

- [x] 4. Add `/api/ai/bans` routes with permission and ownership checks, image count/size/type limits, authenticated evidence download.
   - Tests: `cd panel && npm test`

- [x] 5. Frontend: "Ban a player" button, request form with log-line picker and image upload, verdict card, override form for admins, ban history tab, i18n keys (en_US, fr_FR, zh_CN).
   - Tests: `cd frontend && npm run type-check && npm run lint && npm test`

- [x] 5b. Block ban commands for regular users on every console path.
   - Shared `isBanCommand` / `RestrictedTerminalInput` in `common`; daemon stream session flag from the `stream_channel` passport; panel `/command` route, schedule registration, and proxy terminal bridge (restricted stream token).
   - Tests: `cd common && npm test`, `cd daemon && npm test`, `cd panel && npm test`

- [ ] 6. Full verification.
   - Tests: all module suites (`mcsmanager-test` skill) and `npm run test:integration`.
