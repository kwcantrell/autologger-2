# 0033: Batch autogenerate is a durable leased job that acts as its human initiator; it auto-accepts only safe wiki changes

- Date: 2026-11-09
- Status: Proposed
- Rule: batch-autogenerate (the whole capability), show-wiki "A batch job accepts suggestions as its initiator", core-ports-architecture "Every catalog and session call is bound to a caller" (the worker as the second user-binding site and the reviewed system reason `autogenerate-worker`), and the tests `server/src/test/pg/autogenerateJobs.pg.test.ts`, `server/src/autogenerate/worker.test.ts`, `server/src/autogenerate/worker.*.int.test.ts` and `packages/contract/src/wikiSafeSuggestion.test.ts`

## Context

Every generation feature (transcript, events, topics, wiki update) runs one session at a time from the session workspace, as a synchronous request by a signed-in person. Studios that import a back catalogue (the legacy import, the YouTube playlist import) end up with hundreds of sessions that have none of that output. Filling them means opening each session and pressing up to four buttons in order. The owner asked for one job per studio that fills the gaps in episode order (change `batch-autogenerate`, owner decisions 1-8 and 8a).

Two existing rules stood in the way:

- ADR 0031 lists "a background run is wanted (that would need a non-human author and a different credential story)" as a revisit trigger for the wiki AI. Auto-accepting a batch job's wiki suggestions is that background run.
- core-ports-architecture lets only the auth middleware create a catalog user binding. A job that runs as its initiator needs a second, reviewed site.

## Decision

- **A durable leased queue.** Jobs and per-session, per-step items are rows in `catalog.autogenerate_jobs` and `catalog.autogenerate_items` (migration `20261025000000`). Every API process polls every 15 s, claims at most one job with `FOR UPDATE SKIP LOCKED` under a 60 s lease renewed every 10 s, fences every job and item write on the lease, and resumes a job whose lease lapsed. No `NOTIFY`. At most one `queued`/`running` job per team (a partial unique index).
- **The human initiator is the author; the credential is the initiator's.** The job stores only the initiator's user id, never a token, cookie or key. Before each session the worker re-reads the account under `autogenerate-worker`, re-checks the team role and the approved-user rule, then binds the catalog and the session hub to that user and re-checks access to the session, so every read and write of the session's steps runs under the initiator's row-level security. Each step resolves the initiator's own provider credential when it starts, exactly as the manual route does. A disabled account, a lost role or approval stops the job; a lost credential stops it too.
- **Runners shared with the manual routes.** Each generate route is split into a context-free runner (`server/src/generation/`) and a thin adapter, so the worker runs exactly the route's code and refusals.
- **Only gaps, and only its own output.** A step runs only where its output is missing. Before a step writes a row that a later attempt must recognise, the item records how (events by run id, topics by id), fenced on the lease. Re-entry, failure and every non-`done` ending delete exactly those rows, as the initiator, one at a time with the insert-time version, so a row a person edited is kept and counts as present.
- **Wiki auto-accept, safe changes only (owner decision 8a).** In `accept` mode the job accepts, through the existing accept transaction and as the initiator, only a suggestion that proposes a new page or rewrites an existing page by additions only: the trimmed title unchanged, every existing alias kept exactly, and the existing body's lines (`CRLF` read as `LF`) a byte-exact, in-order subsequence of the new body's lines. A changed line, even one that only grew, counts as a removal. Every other suggestion stays pending for a person. The expected revision is the suggestion's base revision, and the note is `accepted suggestion <id> (batch <job id>)` or `created from suggestion <id> (batch <job id>)`.

How this answers ADR 0031's revisit trigger: the author is still a human, the person who confirmed the batch and whose role, approval and access are re-checked before every session; the credential is that person's own; and the pre-authorisation they give in the confirm covers only additions, never the removal or change of existing text.

*Alternatives considered.*
- **A separate worker container** like the media worker: rejected, the work needs the API's providers, session hub, AI slot registry and provider-key cipher.
- **Calling the routes over HTTP from the worker:** it would need a stored session for the initiator, which decision 6 refuses.
- **A tag column on topics** to recognise partial output: rejected, it changes the frozen topic row shape; an item-side id list keeps the change inside the new tables.
- **Auto-accepting every suggestion** (owner decision 8 as first written): narrowed after the panel showed `propose_page` can replace whole pages, up to 20 per run, without review.

## Evidence

- The panel and re-panel are in `openspec/changes/batch-autogenerate/panel.md` (1 critical and 12 major findings, then 4 major at the re-panel, all resolved), and the measured assumptions are in that change's `design.md`.
- Row-level security and the user guard: `server/src/test/pg/autogenerateJobs.pg.test.ts`.
- The safe-suggestion rule: `packages/contract/src/wikiSafeSuggestion.test.ts`; the accepts end to end: `server/src/autogenerate/worker.wiki.int.test.ts`.
- Acting as the initiator, the per-session re-check and the binding spy: `server/src/autogenerate/worker.authz.int.test.ts`.

## Consequences

- **Residual of R1: unreviewed AI text goes live.** A false or injected claim (transcripts are untrusted input) in an added line or a new page, even one supported by a true quote, is published without review. Removals and changes always wait for a person. Every batch revision is marked, attributable to the initiator and revertible from the page history, but batch revisions stack, so reverting an early one by hand means re-applying the later additions. Recorded in `docs/security.md`.
- **Spend on the initiator's accounts.** A job can make up to 4000 paid runs (1000 sessions × 4 steps). It is bounded by the estimate and confirm, each step's per-turn bounds, cancel by any manager, a 429 backoff and the stop after 3 consecutive sessions of provider failure per provider kind. There is no per-job budget.
- **Recorded in `docs/security.md` ("Batch autogenerate jobs"):** the unreviewed-AI-text residual above, the spend residual below, and the worker as the second user-binding site.
- **Partial output whose cleanup was refused** (access lost, account gone) stays visible until a later job reaches the session; it never counts as present.
- **Drop or revisit if:** reviewers find batch additions they would have rejected often enough that `pending` should be the default; a spend cap becomes necessary; or the initiator model breaks (for example a job that must outlive its initiator's role).
