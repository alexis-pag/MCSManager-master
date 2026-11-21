# AI-Moderated Player Bans

## Why

On shared servers, players get banned for vague or unfounded reasons ("test", "parce que", no evidence). The owner wants every ban issued from the panel to carry a real reason and evidence, and to be reviewed by the local AI, which judges whether the ban is deserved before it is applied.

## What Changes

- Add a "Ban a player" action on the instance page (Minecraft Java instances) that opens a ban request form:
  - player name, validated;
  - a reason, at least 15 characters, with obviously empty reasons ("test", "ban", "aaa", "parce que", "no reason", repeated characters) rejected by the panel before the AI is called;
  - evidence, at least one item required: console/chat log lines selected from the instance log (the panel pre-selects lines mentioning the player), a written description of the facts, and optional screenshots (up to 3 images, 2 MB each, PNG/JPEG/WebP).
- The panel sends the case to the local AI with no tools and requires a structured verdict: `justified`, `not_justified` or `insufficient_evidence`, a suggested sanction (`ban`, `temporary_ban`, `warning`, `none`) and an explanation.
- Only a `justified` verdict lets the requester apply the ban, with an explicit "Apply ban" click. The panel then sends `ban <player> <reason>` to the running instance.
- An administrator can override a negative verdict only by writing an override note; the override is recorded in the operation log. Regular users cannot override.
- Every ban case (request, evidence, verdict, outcome, who applied or overrode) is stored and listed in a "Ban history" tab of the dialog for 90 days.

## Out of Scope

- Bans typed in game by server operators (outside the panel).
- Unbanning, temporary bans with automatic expiry, IP bans, Bedrock servers and proxy networks (BungeeCord/Velocity) in this first version.
- Screenshot analysis by the model unless the administrator enables the "vision model" setting; without it the AI is told how many images exist but judges from text evidence, and the images stay attached for human review.

## Decisions (approved by the owner, 2026-11-21)

1. **Administrator override**: allowed, with a mandatory note and an operation log entry.
2. **Terminal bans**: `ban` / `ban-ip` commands sent by regular users through the panel terminal and command routes are refused, so the moderated form is the only way for them to ban. Administrators are unaffected.

## Impact

- Affected modules: panel (ban case service, routes, AI verdict prompt, evidence storage), frontend (ban dialog, history tab), languages. Daemon: refuses `ban`/`ban-ip` terminal input from regular users (see design).
- New persistent categories: `AiBanCase` (panel), evidence images stored under the panel data directory, bounded by size and 90-day retention.
- New config field: `aiVisionEnabled` (default false).
