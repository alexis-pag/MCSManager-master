# Design: Administrator Approvals

## Context

- `User` has no AI or approval fields; adding fields to `User` would touch user management and storage templates, so access lives in its own category.
- Server-action schedules live in the daemon and do not record their creator. The panel operation log records `instance_task_create` with `operator_name`, `instance_id` and `task_name` (when the log is enabled).
- AI tasks live in the panel with `ownerUserUuid`.
- There is no notification UI in the frontend.

## Decisions

### 1. AI access

`AiAccess` (key = user uuid): `{ userUuid, userName, state: "pending" | "granted" | "refused" | "revoked", reason, requestedAt, decidedAt, decidedBy, note }`.

- `hasAiAccess(user)`: administrators → true; otherwise `state === "granted"`.
- A single check in `ai_router` for every route except `/status`, `/access*` and `/bans*`: regular users without access get 403 `AI access required`. `/status` returns `access: "granted" | "pending" | "refused" | "revoked" | "none"`.
- `AiScheduleService.run()` also checks access of the owner (`disabledReason` is not set: the task resumes when access is granted again; the run is `skipped`).
- Reason: 10-300 characters. A refused or revoked user can request again after 24 hours.

### 2. Automation requests

`AutomationRequest`: `{ uuid, kind: "schedule" | "ai_task", requesterUuid, requesterName, daemonId, instanceUuid, name, payload, replaces, origin: "new" | "edit" | "migration", state: "pending" | "approved" | "refused" | "cancelled", createdAt, decidedAt, decidedBy, note, error }`.

- `payload` is the exact body that will be registered (schedule: `{ name, count, time, type, actions }`; AI task: `{ name, kind, prompt, type, time, count }`), validated at request time with the same rules as direct creation (name blacklist, ban commands, AI task validation, backup payload format is validated by the daemon at approval).
- Panel routes `/protected_schedule` (POST) and `/ai/schedules` (POST): for administrators unchanged; for regular users they store a request and answer `{ pending: true }`.
- Edits: the frontend sends `replaces: <name>` instead of deleting first. On approval the panel deletes the old task then creates the new one; if creation fails the request is `refused` with the error and the old task is already gone only when deletion succeeded and creation failed (reported to the admin as an error).
- Approval re-checks: requester still exists and is assigned to the instance, AI access for `ai_task`, limits; then registers through the existing daemon/panel code paths. Failure → state stays `pending` and the error is shown to the admin.
- Requests are listed per instance for users of that instance (own requests for regular users, all for admins). Decided requests are deleted after 30 days.

### 3. Migration (once per daemon / once for AI tasks)

- **AI tasks**: at panel start, AI tasks whose owner is not an administrator and that were not approved are removed from the scheduler and converted to `AutomationRequest` (`origin: "migration"`). Marker: `systemConfig.automationApprovalMigrated`.
- **Server-action schedules**: when a daemon is available and not yet in `systemConfig.automationApprovalMigratedDaemons`, the panel lists the schedules of every instance, looks up the creator of each in the operation log (`instance_task_create`, same instance and task name, newest entry). Schedules created by an administrator stay. Others are converted to requests (requester = found user, or "unknown") and deleted from the daemon only after the request is stored. The daemon id is then recorded.
- Approving a migrated request with an unknown requester registers it without an owner check.

### 4. Notifications

- `GET /api/approvals/summary` (admin): `{ aiAccess: n, automations: n }`.
- `GET /api/approvals` (admin): pending AI access requests and automation requests with details, newest first, max 200.
- `POST /api/approvals/ai-access/:userUuid` `{ decision: "grant" | "refuse" | "revoke", note }`, `POST /api/approvals/automation/:uuid` `{ decision: "approve" | "refuse", note }`.
- Header bell (admins only) polls the summary every 30 s; clicking opens a drawer with two tabs (Automations, AI access) and Approve/Refuse buttons.
- Every decision → operation log `admin_approval` `{ target_user_name, subject: "ai_access" | "schedule" | "ai_task", decision, instance_name?, task_name?, note? }`.

### 5. User-facing states

- AI page and instance AI drawer: request form, "pending" message, or refusal note.
- Task list: pending/refused requests shown with a tag; the requester can cancel a pending one.

## Risks

- **Migration deleting schedules**: a schedule is deleted from the daemon only after its request is stored; an admin approval re-registers the exact payload.
- **Single admin away**: automations wait; this is the requested behaviour.
- **Operation log disabled**: creators are unknown and those schedules are suspended; one approval each restores them.
