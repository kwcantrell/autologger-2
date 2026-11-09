# Batch autogenerate: fill a studio's missing transcripts, events, topics and wiki in one background job

Tier: 2
Tier reason:
- a migration (two new catalog tables with row-level security, a user-side guard trigger and a
  partial unique index) under `supabase/migrations/**`;
- new frozen HTTP surface (five routes under `/api/teams/:teamId/autogenerate-jobs`) and a
  modified run-feature rule, in `server/src/routers/**` and `packages/contract/**`;
- authorization (owner/admin gate, a server-side job that acts as its initiator without a stored
  credential, a per-session access re-check) and paid spend on the initiator's own providers;
- concurrency (a leased, resumable job queue shared by every server process; the per-session AI
  slot and run leases taken by a background worker; one live job per studio) and an automated
  write to wiki pages (auto-accept) that today only a person makes.

ADR 0033 (task 1.1).

## Why

Every generation feature runs one session at a time from the session workspace: Transcript,
Generate events, Generate topics, Update wiki. A studio that imports a back catalogue (the legacy
import, and next the YouTube playlist import, change `youtube-playlist-import`) has hundreds of
sessions with no transcript, events, topics or wiki, and filling them means opening each session
and pressing up to four buttons in the right order, waiting for each. The wiki in particular is
only useful when it is built session by session in episode order.

## Owner decisions (owner, 2026-11-09; fixed)

1. **Scope.** Pick a studio (team), then one or more of its shows (default all); every session of
   those shows is a candidate. A job may instead name an explicit list of session ids (for the
   playlist import's "autogenerate after import").
2. **Fill gaps only.** Each selected step runs on a session only where its output is missing;
   existing transcripts, topics and events are never overwritten. The wiki update always runs for
   each processed session.
3. **Steps and order.** The user ticks transcripts, events, topics and/or wiki. Per session the
   order is transcript → events → topics → wiki; sessions run oldest to newest by episode date.
4. **Execution.** A server-side background job, durable in Postgres (job rows and per-session,
   per-step item rows). One session at a time. It resumes by itself after a restart (the
   interrupted step re-runs as gap-fill) and respects the per-session single-flight and run leases.
5. **Failures.** A failed step skips that session's remaining steps; the job continues with the
   next session. The final report lists failures per session and step with safe details.
6. **Permission and credentials.** Only studio owners and admins see the section and start jobs.
   The job runs on the initiator's own provider credentials, with no secret stored in the job. A
   per-session access re-check as the initiator runs before every session. The UI shows an
   estimate (sessions × steps) and asks for a confirm before starting.
7. **Controls.** Cancel stops after the current step (an in-flight provider call is not killed).
   One running job per studio (`409` on a second). Every owner and admin of the studio sees the
   job's progress and can cancel it.
8. **Wiki output.** A per-job toggle: by default suggestions are auto-accepted into pages; the
   alternative leaves them pending. Auto-accept goes through the same accept path and validation
   as a person's accept, authored by the initiator and marked as batch.

## What changes

- **Job tables.** Migration `20261025000000_autogenerate_jobs.sql` adds
  `catalog.autogenerate_jobs` (team, initiator id, scope, steps, wiki mode, status, lease, cancel
  request, stop reason, times) and `catalog.autogenerate_items` (one row per session and selected
  step, with its processing ordinal, status, classified outcome, run id and wiki counts). At most
  one `queued` or `running` job per team. Owners and admins of the team may read both tables; a
  user may insert only a job they initiate for a team they manage, and may only request a cancel.
  The worker writes as the reviewed system task `autogenerate-worker`.
- **Routes** (all owner/admin of the team; the team family's masked `404` and `403`):
  `POST /api/teams/:teamId/autogenerate-jobs/preview` (the estimate),
  `POST /api/teams/:teamId/autogenerate-jobs` (start, requires the estimate's session count),
  `GET /api/teams/:teamId/autogenerate-jobs` (newest 20),
  `GET /api/teams/:teamId/autogenerate-jobs/:jobId` (job plus per-session items),
  `POST /api/teams/:teamId/autogenerate-jobs/:jobId/cancel`.
- **Worker.** Every API process runs a worker loop that claims due jobs under a lease (one job
  per process at a time), processes one session at a time in the job's order, re-checks the
  initiator before each session, runs each step through the same code as its manual route (now
  extracted into context-free runners that both the route and the worker call), and resumes a job
  whose lease lapsed.
- **Acting as the initiator.** The job stores only the initiator's user id. Before each session
  the worker loads the account (disabled or missing stops the job), re-checks the team role and
  the approved-user rule, then binds the catalog and the session hub to that user, so every read
  and write runs under the initiator's row-level security, and resolves the initiator's provider
  credentials at each step, as the manual routes do.
- **Wiki auto-accept.** After a successful wiki step in `accept` mode, each suggestion that run
  stored is accepted through the existing accept transaction, as the initiator, against its base
  revision; the revision note is `accepted suggestion <id> (batch <job id>)` (or `created from
  suggestion <id> (batch <job id>)` for a new page). Any refusal
  (stale, title clash, merged, deleted, link check) leaves it pending and is counted.
- **Settings.** A "Batch autogenerate" section in the Team group, shown only to owners and admins
  of at least one team: team picker, show checklist, step checkboxes, wiki mode, live estimate, a
  themed confirm naming the run count and the auto-accept trust warning, progress, Cancel, the
  final report and recent jobs.
- **Docs.** README endpoint table and a "Batch autogenerate" section; `docs/security.md` residual
  (unreviewed AI text into wiki pages; spend on the initiator's credentials); ADR 0033.

## Capabilities

### New Capabilities
- `batch-autogenerate`: the job model, scope and order, gap definitions per step, the worker's
  per-session gate ladder (acting as the initiator), busy, failure, cancel and resume semantics,
  the wiki auto-accept, and the report.

### Modified Capabilities
- `api-contract-freeze`: ADDED "Batch autogenerate job object" and "Batch autogenerate
  endpoints"; MODIFIED "Run features are limited to approved users" (the start route applies the
  rule to its initiator).
- `team-management`: MODIFIED "Team roles, owner anchor and show access" (a role table row for
  batch autogenerate).
- `show-wiki`: ADDED "A batch job accepts suggestions as its initiator".
- `core-ports-architecture`: MODIFIED "Every catalog and session call is bound to a caller" (the
  batch worker is the second place a catalog user binding is created, for the job's recorded
  initiator; new reviewed system reason `autogenerate-worker`).
- `web-ui-system`: ADDED "Settings runs batch autogenerate for owners and admins".

## Non-goals

- No parallelism inside a job, and no per-job spend cap beyond each step's existing per-turn
  bounds (design Open questions).
- No regeneration: a session whose output exists is never re-run, and there is no "overwrite"
  option.
- No new WebSocket message: the section polls the job route.
- No change to the manual generate routes' observable behaviour (statuses, bodies, busy texts),
  except that a batch run can hold a session's slot and answer the existing `409`.
- The "autogenerate after import" checkbox of the YouTube playlist import is not built here (see
  "Follow-up").
- Members (non-managers) get no batch surface, even for shows they hold grants on.

## Contract impact

Additive: five new routes and their JSON objects; the start route joins the approved-user rule. A
new revision-note value `accepted suggestion <id> (batch <job id>)` can appear in the wiki
revision endpoints' existing `note` string. No existing route's status, body or ordering changes.

## Follow-up: "autogenerate after import"

The playlist import change (`youtube-playlist-import`, proposed in parallel) has no spec yet, so
this change cannot write a delta against it. This change ships everything that wiring needs: the
`session_ids` scope on the start route and an internal `startAutogenerateJob` service any
server-side caller can use as a given initiator (task group 9 tests a non-HTTP caller). The
checkbox itself, and the import job calling the service for the sessions it created, belong to
whichever of the two changes merges **second**: if `youtube-playlist-import` merges first, a small
follow-up change `playlist-import-autogenerate` adds them; if this one merges first,
`youtube-playlist-import` adds them in its own tasks. Either way the checkbox is shown only to an
owner or admin of the target team, since the job requires that role.

## Impact

- `supabase/migrations/20261025000000_autogenerate_jobs.sql`; the recorded schema and RLS listing
  tests; the legacy importer's `TARGET_SCHEMA_VERSION` pin.
- `packages/contract/src/autogenerate.ts` (schemas, outcome codes, details);
  `packages/catalog/src/autogenerateStore.ts` and the wiki suggestion store's accept note option;
  `packages/session-core` (transcript replace "only if empty").
- `server/src/generation/*` (runners extracted from `transcribe.ts`, `events.ts`,
  `wikiSuggestions.ts`), `server/src/autogenerate/*` (worker, gate ladder),
  `server/src/routers/autogenerate.ts`, `server/src/app.ts`, `server/src/main.ts`.
- `web/src/pages/index/components/settings/` (new section, `sections.ts`,
  `SettingsSections.tsx`), `web/src/api/hooks/`.
- README, `docs/security.md`, `docs/decisions/0033-batch-autogenerate-jobs.md`.

## After merge

- Nothing runs until an owner or admin starts a job. Rollback: cancel live jobs, revert the code,
  then drop the two tables (the migration header gives the statements). Pages changed by
  auto-accept keep their revisions; each batch revision is identifiable by its note and can be
  reverted from the page history.
