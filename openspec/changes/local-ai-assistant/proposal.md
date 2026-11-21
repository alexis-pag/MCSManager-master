# Local AI Assistant

## Why

MCSManager needs an integrated local AI assistant that can explain and operate the management panel without introducing a separate privilege domain or exposing cross-user data.

The implementation must support OpenAI-compatible local engines, but remain useful when no engine is configured. It must use the existing panel user, session, API-key, instance assignment, route authorization, and StorageSubsystem mechanisms.

## What Changes

- Add persistent, per-user AI conversations and messages.
- Add a server-side FIFO request queue with per-engine serialization, request states, cancellation, timeout, retry-safe recovery, and bounded capacity.
- Add an OpenAI-compatible local-engine client supporting chat completion, model discovery, streaming, and cancellation.
- Add a backend-controlled tool registry for existing panel capabilities.
- Add per-tool argument validation, per-call identity resolution, role checks, instance resource checks, user confirmation requirements for sensitive actions, and audit logging.
- Add AI status, queue, conversation, message, and administrator configuration APIs.
- Add a Vue chat view integrated with the existing layout and navigation.
- Add administrator configuration and connection diagnostics.
- Add unit and integration coverage for authorization, isolation, queue behavior, cancellation, timeout, engine errors, and restart recovery.

## Out of Scope

- Arbitrary shell, database, filesystem, or HTTP tools.
- Bypassing or replacing existing panel permissions.
- Cloud-hosted or paid model providers.
- Multi-engine parallel generation.
- Enabling tool execution in integration-test unsafe mode unless the normal route authorization is independently enforced.

## Impact

- Affected modules: panel, frontend, common only if shared types are needed.
- New persistent categories: AI conversations, AI messages or run records, AI configuration, and bounded queue diagnostics.
- New external dependency: optional HTTP client support using existing Axios.
- No breaking change to existing routes or user roles.
