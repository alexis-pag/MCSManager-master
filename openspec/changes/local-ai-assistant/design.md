# Design

## Architecture

The panel is the security boundary and orchestration owner. The frontend sends authenticated requests to panel routes. The panel owns persistence, queue scheduling, engine communication, tool authorization, and audit records.

The daemon is not given direct AI access. Instance and file operations remain routed through existing panel services and `RemoteRequest` APIs.

## Conversation Model

Persist each conversation under an owning user UUID:

- `id`
- `ownerUserUuid`
- `title`
- `createdAt`
- `updatedAt`
- `archivedAt`
- `messages`

Messages contain role, content, tool metadata, timestamps, and safe error information. Message content size and conversation size are bounded. Cross-user reads, writes, rename, archive, and delete operations require exact owner and session/API identity matching.

## Queue Model

One `LocalAiQueueService` singleton is initialized when the panel starts. It maintains one in-memory FIFO queue per engine/model configuration. The default policy is one processing item per engine. Priority is a validated numeric policy rather than a bypass; all priorities require a role allowlist and normal authorization remains mandatory.

A request record has:

- `id`
- `userUuid`
- `conversationId`
- `model`
- `state: queued | processing | completed | failed | cancelled | timeout`
- `priority`
- `submittedAt`
- `startedAt`
- `completedAt`
- `position`
- `estimatedWaitMs`
- `errorCode`

Queued items may be cancelled by their owner or an authorized administrator. Processing cancellation requests abort the HTTP generation using an `AbortController` when streaming is supported. Queue capacity and per-user active/pending limits are enforced server-side.

Generation has an overall timeout and stale record recovery after process restart. Since in-memory execution cannot survive an ungraceful restart, persisted queued records are reset or failed during startup according to the stored lifecycle policy. Conversation and completed audit data use StorageSubsystem, with file/Redis behavior inherited from the existing system.

## Engine Adapter

Use an internal interface:

```ts
interface LocalAiEngine {
  getStatus(): Promise<EngineStatus>;
  listModels(): Promise<string[]>;
  chat(request, callbacks): Promise<ChatResult>;
  abort(requestId): void;
}
```

The first implementation supports OpenAI-compatible `/v1/models` and `/v1/chat/completions`. Ollama may be supported through its OpenAI-compatible endpoint. LM Studio may use the same adapter. Provider-specific behavior is isolated behind the interface.

Only allow loopback/private engine addresses as configurable? The administrator selects the address. SSRF protection must reject public or non-local destinations if the policy requires local-only; implementation should default to local-host/loopback and document permitted private networking exceptions.

## Tool Calling

Tools are named server-side capabilities, never arbitrary route names. The model receives JSON declarations and only after a server-side allowlist check.

Initial tool set:

- `list_accessible_instances`
- `get_instance_status`
- `start_instance`
- `stop_instance`
- `restart_instance`
- `send_instance_command` (confirmation-sensitive)
- `list_instance_files` (existing file scope)
- `read_instance_config` (existing config scope)
- `update_instance_config` (confirmation-sensitive)

The tool executor:

1. Resolves the current user from the session/API key, never from model-supplied identity.
2. Reloads the user and role from `UserSubsystem` for every call.
3. Validates tool name and strict JSON schema.
4. Applies the tool's role requirement.
5. Verifies instance/daemon ownership or assignment and the existing route gate semantics.
6. Requires explicit confirmed tool-call approval for destructive/sensitive tools.
7. Calls existing panel services or existing daemon RemoteRequest paths.
8. Logs the request ID, user, tool, resource, decision, and duration without secrets.

The existing instance route middleware remains in effect. The AI tool executor must not synthesize fake sessions or bypass it.

## Frontend

Add one main AI route and page component. The existing `useSocketIo` or HTTP polling pattern will be reused where appropriate. Queue status and conversation updates refresh independently from the full layout.

Rendered assistant content uses Markdown with sanitized HTML and syntax highlighting. Code copy uses existing UI conventions. No raw HTML or conversation content from another owner is rendered in response to unauthorized requests.

## Restart and Failure Recovery

At startup:

- Load configuration and persistent conversations.
- Mark stale `processing` records `failed` or `timeout` according to policy.
- Mark stale `queued` records `queued` if persistence is enabled, but only within the configured restart window and capacity.
- Schedule no duplicate processing; queue services recover via one startup pass.
- Guarantee queue release in `finally` for all engine and tool errors.

## Configuration

Administrator-only settings:

- enabled
- engine type/address
- model
- temperature
- maximum tokens
- timeout
- queue capacity
- queue enabled
- maximum concurrent generations
- priority allowlist
- polling and retry policy

Defaults preserve a safe starting point: disabled, loopback endpoint, one concurrent generation, normal priority, strict tool confirmation.

## Security

- No privilege escalation: tool execution returns only resources assigned or administratively owned.
- No arbitrary file, database, terminal, or shell tool.
- No secret-bearing engine responses in logs.
- Every tool call repeats authorization checks.
- Engine endpoint, model, and request fields are validated.
- Conversation and queue responses are owner-scoped.
- Sensitive operations require approval in a separate authenticated request.
