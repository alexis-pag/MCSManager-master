# Implementation Tasks

- [x] 1. AI access: `AiAccess` storage, request/grant/refuse/revoke service, gate on AI routes (except status, access, bans), owner access check in AI task runs, `access` field in `/ai/status`.
   - Tests: `cd panel && npm test`

- [x] 2. Automation requests: `AutomationRequest` storage and service, pending path for regular users in `/protected_schedule` and `/ai/schedules` (create and edit with `replaces`), cancel, approve (re-validation + registration), refuse, 30-day cleanup.
   - Tests: `cd panel && npm test`

- [x] 3. Migration of existing automations: AI tasks of non-admin owners; per-daemon schedules with creator lookup in the operation log; markers in the system config.
   - Tests: `cd panel && npm test`

- [x] 4. Approval center API (`/api/approvals*`, admin only) and `admin_approval` operation log type (panel + frontend renderer).
   - Tests: `cd panel && npm test`

- [x] 5. Frontend: header bell with badge and approvals drawer (admins), AI access form/states on the AI page and instance drawer, pending/refused rows with cancel in the task list, i18n keys (en_US, fr_FR, zh_CN).
   - Tests: `cd frontend && npm run type-check && npm run lint && npm test`

- [ ] 6. Full verification.
   - Tests: all module suites and `cd common && npm run test:integration` (ports 23333/24444 must be free).
   - Unit suites done (panel, frontend, common pass; daemon only fails the known Windows-only `mod_update_download.test.ts`). Integration suite pending: the dev servers hold ports 23333/24444.
