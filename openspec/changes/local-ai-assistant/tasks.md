# Implementation Tasks

- [x] 1. Add panel AI domain models and StorageSubsystem persistence.
   - Include conversation, message, request, audit, and configuration records.
   - Add strict size and lifecycle validation.
   - Tests: `cd panel && npm test`

- [x] 2. Implement the OpenAI-compatible engine adapter and connection diagnostics.
   - Support models, chat completion, streaming, cancellation, timeout, and normalized errors.
   - Tests: `cd panel && npm test`

- [x] 3. Implement the centralized FIFO queue service.
   - Support states, capacity, FIFO, cancellation, timeout, model serialization, stale recovery, and guaranteed release.
   - Tests: `cd panel && npm test`

- [x] 4. Implement conversation and queue API routes.
   - Require existing permission middleware and owner identity checks.
   - Tests: `cd panel && npm test`

- [x] 5. Implement the server-side tool registry and authorization executor.
   - Recheck identity, role, instance assignment, and resource access on every call.
   - Reuse existing panel services and RemoteRequest paths.
   - Tests: `cd panel && npm test`

- [x] 6. Add confirmation and audit handling for sensitive tool calls.
   - Prevent execution before confirmed approval.
   - Tests: `cd panel && npm test`

- [x] 6a. Connect model context to authorized MCSManager tools.
   - Provide conversation history and system guidance; force tool use for direct Minecraft creation requests.
   - Recover an explicit confirmation after the assistant previously asked for one without registering a pending action.
   - Start assigned instances on request and create Minecraft servers only from administrator-authorized marketplace templates.
   - Auto-start new Minecraft instances after successful asynchronous installation.
- [x] 6b. Make AI instance creation reliable for every catalogue game.
   - Use template IDs, portable `tool_choice: "required"`, a JSON fallback, and panel-authored confirmation/refusal texts.
   - Allow administrators regardless of `allowUsePreset`; verify the daemon task response before reporting success.
   - Tests: `cd panel && npm test` and `cd daemon && npm test -- src/service/async_task_service/__test__/quick_install.test.ts`
   - Tests: `cd panel && npm test` and `cd daemon && npm test -- src/service/async_task_service/__test__/quick_install.test.ts`

- [x] 6c. Add an instance-scoped assistant that can edit instance files.
   - "AI Assistant" button on the instance page opens a right-side chat drawer dedicated to that instance.
   - Dedicated conversations only expose that instance's tools (start, confirmed stop, files).
   - Tools: list/read/edit instance files; edits shown as a diff and written only after an explicit yes.
   - Tests: `cd panel && npm test`, `cd frontend && npm run type-check && npm test`

- [x] 6d. Let the instance assistant install plugins through the MCSManager plugin sources.
   - Server detection, compatible version choice, allowlisted official downloads, confirmation, completion check.
   - Tests: `cd panel && npm test`

- [x] 7. Add frontend AI route, chat UI, history, queue status, and cancellation.
   - Integrate existing layout, i18n, Markdown, and code rendering conventions.
   - Tests: `cd frontend && npm run type-check && npm run lint && npm test`

- [x] 8. Add administrator AI configuration and monitoring UI.
   - Restrict navigation and API operations to authorized administrators.
   - Tests: `cd frontend && npm run type-check && npm run lint && npm test`

- [ ] 9. Add cross-module security and restart tests.
   - Cover simultaneous users, FIFO, isolation, unauthorized tools, cancellation, timeout, engine failure, and restart recovery.
   - Tests: `cd common && npm run test:integration:build`

- [ ] 10. Run the full required verification and document remaining limitations.
    - Tests: all four module suites plus common integration suite.
