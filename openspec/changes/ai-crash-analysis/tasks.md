# Implementation Tasks

- [x] 1. Daemon: unexpected stop records.
   - synchronous listener on `InstanceSubsystem` `exit`/`failure` reading `eventTask.ignore` (no change to `instance.ts`); console snapshot; bounded in-memory ring (200 records, 1 hour); `instance/unexpected_stops` route.
   - Tests: `cd daemon && npm test` (Instance.ts is a mandatory-gate file: also the in-process instance suite and `cd common && npm run test:integration`)

- [x] 2. Panel: `crash_analysis` kind and "on crash" trigger.
   - Validation (type 4 only for this kind, one per instance), no timer registration for type 4, count semantics on each crash.
   - Tests: `cd panel && npm test`

- [x] 3. Panel: collector loop and analysis run.
   - Poll every 20 s per daemon with `since`, de-duplication, rate limit (10 min, pending run), crash file lookup (`crash-reports/`, `hs_err_pid*.log`), clean-stop filter, panel-written report header and crash file name.
   - Tests: `cd panel && npm test`

- [x] 4. Frontend: kind "Analyse des plantages", fixed "À chaque plantage" trigger, list rendering, i18n keys (en_US, fr_FR, zh_CN).
   - Tests: `cd frontend && npm run type-check && npm run lint && npm test`

- [ ] 5. Full verification.
   - Tests: all module suites (`mcsmanager-test` skill) and `cd common && npm run test:integration` (requires ports 23333/24444 free: stop the dev servers first).
