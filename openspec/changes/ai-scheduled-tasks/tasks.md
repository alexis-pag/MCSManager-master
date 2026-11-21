# Implementation Tasks

- [x] 1. Add the `backup` schedule action in the daemon.
   - Payload parsing/validation at registration, zip via `compress()`, per-instance lock, pruning beyond `keep`.
   - Tests: `cd daemon && npm test`

- [x] 2. Add report conversations and report retention in the panel.
   - `AiConversation.kind` (`chat` default, storage template), `aiReportRetentionDays` config (1-90, default 7), `expiresAt()` per kind, config API field.
   - Tests: `cd panel && npm test`

- [x] 3. Add the read-only tool context in `ai_tool_service`.
   - Declarations filtered and executor refusal for write/action tools when `readOnly` is set.
   - Tests: `cd panel && npm test`

- [x] 4. Add `AiScheduleTask` storage and `ai_schedule_service` scheduling.
   - Load at boot, interval/cron registration, count semantics, limits (4 per instance, >= 3600 s), access recheck, skip rules, `lastStatus`/`lastReportUuid` updates.
   - Tests: `cd panel && npm test`

- [x] 5. Implement the four task kinds' data collection.
   - Console log fetch + ANSI strip + truncation; config allowlist, syntax checks, credential redaction; plugin/mod comparison reusing the plugin search logic; custom prompt.
   - Tests: `cd panel && npm test`

- [x] 6. Add `/api/ai/schedules` routes with permission checks, name validation and operation log entries.
   - Tests: `cd panel && npm test`

- [x] 7. Frontend: schedule dialog AI mode, backup action fields, merged task list with AI tag and last report link, report tag in the instance AI history, i18n keys (en_US, fr_FR, zh_CN).
   - Tests: `cd frontend && npm run type-check && npm run lint && npm test`

- [ ] 8. Full verification.
   - Tests: all module suites (`mcsmanager-test` skill) and `npm run test:integration`.
