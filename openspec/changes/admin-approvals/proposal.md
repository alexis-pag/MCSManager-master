# Administrator Approvals: AI Access and Automations

## Why

The owner wants administrators to stay in control of two things regular users can currently do on their own:

- **Using the local AI**: it runs on the owner's hardware and can act on instances. Regular users should ask for access, and an administrator should grant it.
- **Automations**: a scheduled task runs unattended (restarts, commands, backups, AI reports). Every automation created by a regular user should be reviewed by an administrator before it runs.

Administrators also need to see these requests without checking each page.

## What Changes

- **AI access requests**
  - Regular users have no AI access until an administrator grants it. They see a "Request AI access" form (short reason) instead of the assistant; administrators always have access.
  - Without access, every AI endpoint is refused for that user (conversations, messages, instance assistant, AI tasks, "run now"). Existing conversations are kept but hidden until access is granted. AI tasks owned by a user without access are skipped when they fire.
  - Administrators grant, refuse (with an optional note) or later revoke access.
  - "Ban a player" stays available without AI access: it is a moderation safeguard, not the assistant.
  - Existing regular users start without access and must request it.
- **Automation approvals**
  - A schedule (server actions) or AI task created or edited by a regular user becomes a **pending request**; nothing is registered on the daemon or scheduled in the panel until an administrator approves it. An edit keeps the current task running until the new version is approved.
  - On approval the panel re-validates the request (instance still assigned to the requester, AI access for AI tasks, limits, no ban command) and creates the task. On refusal the requester sees the refusal and the note.
  - Administrators' own automations are active immediately.
  - The requester can cancel a pending request. Pending and refused requests appear in the instance's task list with a status tag.
  - **Migration**: automations that already exist and were created by regular users are suspended and turned into pending requests. For server-action schedules the creator is found in the operation log; when the creator cannot be found, the schedule is suspended as well (an administrator re-approves it once).
- **Administrator notifications**
  - A bell in the header for administrators, with a badge counting pending requests (AI access + automations), refreshed every 30 seconds.
  - A panel listing each request with its details (user, instance, trigger, actions or AI kind and instruction, reason) and "Approve" / "Refuse" buttons.
  - Every decision is written to the operation log.

## Out of Scope

- Notifications outside the panel (email, Discord).
- Notifying the requester outside the place where the request was made (the status is shown in the task list and on the AI page).
- Per-instance or per-feature AI permissions (access is all-or-nothing per user).

## Impact

- Affected modules: panel (access and approval services, migration, routes, AI gates), frontend (bell and request panel, AI access form, pending rows in the task list), languages. Daemon unchanged.
- New persistent categories: `AiAccess` (one record per regular user), `AutomationRequest`.
- New operation log type: `admin_approval`.
- Behaviour change for regular users: AI and new automations require an administrator decision.
