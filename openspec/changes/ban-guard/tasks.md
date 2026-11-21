# Implementation Tasks

- [x] 1. Daemon console watcher (detection, authorization, pardon, events) and `ban_guard/*` routes; gate exemption for `instance/unexpected_stops`.
   - Tests: `cd daemon && npm test`
- [x] 2. Panel: authorization in "Ban a player", poller writing `instance_player_unban_auto`.
   - Tests: `cd panel && npm test`
- [x] 3. Frontend log renderer and i18n (en_US, fr_FR, zh_CN).
   - Tests: `cd frontend && npm run type-check && npm test`
- [ ] 4. Full verification with `cd common && npm run test:integration` (ports 23333/24444 must be free).
