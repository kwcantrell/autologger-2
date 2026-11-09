# Tasks

The first commit on `batch-autogenerate` holds only `openspec/changes/batch-autogenerate/`
(the approved artifacts and `panel.md`). The PR targets `main`.

Logs: keep every test and gate run under the session scratchpad as `ba-<task>-<red|green>.log`
and name the log in each `Evidence:` line. Each "test first" item is red before its change (record
the failure line) and green after; if a new test already passes, record that and why.

Test commands: server tiers are `cd server && npx vitest run --project <unit|integration|pg>
<files>`; packages are `npx vitest run <files>` from the package; web is `cd web && npx vitest run
<files>`. Gates run through `scripts/check-change.sh`, never by hand.

## 1. ADR, migration and row-level security (design D1, D2, D16)

- [ ] 1.1 Write `docs/decisions/0033-batch-autogenerate-jobs.md` (template 0000; Status Proposed;
  Rule: batch-autogenerate, show-wiki "A batch job accepts suggestions as its initiator",
  core-ports-architecture "Every catalog and session call is bound to a caller"), stating how it
  answers ADR 0031's "background run" revisit trigger, and add a one-line pointer to 0033 in ADR
  0031's Consequences. Docs only, no test; verify: `scripts/check-change.sh --only
  openspec,guide-size` passes and `grep -n 0033 docs/decisions/0031-show-wiki-ai.md` finds the
  pointer.
- [ ] 1.2 Test first, new `server/src/test/pg/autogenerateJobs.pg.test.ts`, plus the recorded
  expectation in `catalogSchema.pg.test.ts` and the RLS listing test:
  - the columns, checks and the live index: a second `queued`/`running` job for a team fails
    `23505`, a `finished` one does not; an outcome or stop reason outside the lists fails `23514`;
    `stop_reason` null with `failed` fails `23514`;
  - `catalog_user` select: owner and admin of the team see its jobs and items; a member, an outsider
    and an admin of another team see none;
  - insert: an admin inserts a `queued` job with itself as initiator and its items; a member, an
    admin naming another initiator, an admin of another team, a job inserted `running` or with lease
    or cancel columns set, and items for another user's job each fail (`42501` or the policy's
    `new row violates`);
  - update: an admin of the team requests a cancel on a `running` job (cancel columns only) and
    cancels a `queued` one (`status` `cancelled`, `stop_reason` `cancelled`); a member's cancel,
    a second cancel overwrite, `running → finished`, a change to `initiator_user_id`, `steps` or
    the lease each fail `42501`; `catalog_user` update or delete on items and delete on jobs fail
    `42501`;
  - `catalog_system` may do all of the above.
  Evidence: under 1.3.
- [ ] 1.3 `supabase/migrations/20261025000000_autogenerate_jobs.sql`: both tables, indexes, RLS,
  the system policies, the user policies, the column grant, `autogenerate_jobs_user_guard`, the
  header with the rollback statements; no transaction-control lines (`migrate.sh`). Verify:
  1.2 green; `docker/supabase/test_migrate.sh` green.
  Evidence:
- [ ] 1.4 Move the legacy importer's pin (`server/scripts/legacyImportSql.ts`
  `TARGET_SCHEMA_VERSION` → `20261025000000`); the importer never touches the new tables. Test
  first: `server/src/test/importLegacy.test.ts` "is the newest migration" is red before the move.
  Evidence:

## 2. Contract and catalog store (design D1, D3, D13, D14)

- [ ] 2.1 Test first, `packages/contract/src/autogenerate.test.ts`: the scope body (exactly one of
  `show_ids`/`session_ids`, non-empty, 200/1000 caps, steps non-empty and unique, `wiki_mode`
  default `accept`, `expected_sessions` required on start and a non-negative integer); the outcome
  list equals the contract table's 19 codes and each maps to its exact detail string; the job and
  detail response schemas parse the spec's examples.
  Evidence: under 2.2.
- [ ] 2.2 `packages/contract/src/autogenerate.ts` (schemas, `AUTOGENERATE_OUTCOMES`,
  `AUTOGENERATE_DETAIL`, step order). Verify: 2.1 green, `npm run typecheck` exit 0.
  Evidence:
- [ ] 2.3 Test first, `server/src/test/pg/autogenerateStore.pg.test.ts`:
  - create: candidates for a show scope exclude deleted and include archived sessions; a session
    scope dedupes; the ordinals follow design D13 for the spec's two ordering scenarios (B, A, C;
    `b` before `a`) and put undated sessions last; items are one per session and step in
    `(ordinal, step_order)`; the job and items commit together or not at all;
  - claim: two concurrent claims with one due job return it once; a `running` job with a lapsed
    lease is claimable, a live one is not; renewals and transitions fenced on `locked_by` change
    nothing for another holder;
  - list returns the newest 20 of the team; detail returns items in order with current titles
    (`""` for a vanished session); preview counts missing transcript, events (auto-generated only)
    and topics.
  Evidence: under 2.4.
- [ ] 2.4 `packages/catalog/src/autogenerateStore.ts` on the catalog facade; add
  `autogenerate-worker` to the reviewed system reasons (`server/src/catalogSystem.repo.test.ts`
  ALLOWLIST, file and reason). Verify: 2.3 green; `catalogSystem.repo.test.ts` green.
  Evidence:

## 3. Shared runners, no change to the manual routes (design D6, D7, D12)

- [ ] 3.1 Baseline: run the manual route suites before any edit and record the counts:
  `transcribe.int.test.ts`, `transcribe.test.ts`, `events.generate.int.test.ts`,
  `eventsGenerateWindow.test.ts`, `wikiSuggestions.int.test.ts`, `ai.int.test.ts`,
  `providers.int.test.ts`, `apiResponseFixtures.int.test.ts`. These files are not edited in group 3.
  Evidence:
- [ ] 3.2 Test first, `server/src/generation/transcript.test.ts`: `runTranscript` returns typed
  outcomes for unconfigured, forbidden, busy, `no_audio`, `no_speech`, upstream, oversize,
  missing blob, unreadable and ok; with `onlyIfEmpty`, a word inserted between the provider call
  and the replace makes the outcome `present`, the replace rolls back and the inserted word
  remains (`packages/session-core` replace test for the sentinel too). Then extract the runner from
  `transcribe.ts`; the route becomes an adapter. Verify: 3.2 green and the 3.1 transcript suites
  green with the same counts.
  Evidence:
- [ ] 3.3 Test first, `server/src/generation/events.test.ts`: `runEvents` outcomes for each guard
  of the route's ladder; with `ownRunIds`, events tagged with those run ids do not count as present,
  are deleted after a successful run and kept on a refused one; on a failed run with
  `deleteOwnOnFailure`, the events of its own run id are deleted through `session-undo` and manual
  and other runs' events remain. Then extract from `events.ts`. Verify: 3.3 green, 3.1 events
  suites green with the same counts.
  Evidence:
- [ ] 3.4 Test first, `server/src/generation/topics.test.ts`: `runTopics` outcomes (unconfigured,
  forbidden, no words, busy, failed, ok) and the swap unchanged. Then extract from
  `transcribe.ts`. Verify: 3.4 green, 3.1 suites green with the same counts.
  Evidence:
- [ ] 3.5 Test first, `server/src/generation/wiki.test.ts` and
  `server/src/test/pg/wikiSuggestionStore.pg.test.ts` additions: `runWiki` accepts a caller-chosen
  run id; `acceptSuggestion(id, {expectedRevision}, {batchJobId})` writes the note `accepted
  suggestion <id> (batch <job>)` (and `created from suggestion <id> (batch <job>)` for a new page),
  `resolved_by` is the bound user, and every refusal of the manual accept still refuses. Then
  extract from `wikiSuggestions.ts` and add the option. Verify: green, 3.1 wiki suites green with
  the same counts.
  Evidence:
- [ ] 3.6 `sdkTurnSpec` and `callerLlmRoute` take `(env, user)`; every 3.1 suite re-run green with
  the baseline counts, unedited (`git diff --stat` shows no change to those files).
  Evidence:

## 4. The worker (design D3, D4, D5, D7-D12)

- [ ] 4.1 Test first, `server/src/autogenerate/worker.test.ts` (fake clock, fake runners, fake
  store):
  - the ladder runs in D5's order, and step 4 (session access as the initiator) runs before every
    session even when steps 1-3 pass;
  - a session the initiator can no longer access is skipped `access-lost` with **no runner call**,
    and a deleted one `session-gone`; the job continues;
  - disabled initiator, role lost, not approved, and unconfigured STT / LLM each stop the job with
    their `stop_reason`, the remaining items `cancelled` with `job-stopped`;
  - present, precondition cascades (`no-audio` → `no-transcript`), failure cascade
    (`earlier-step-failed`), the D9 mapping table row by row;
  - busy: retried every 15 s, runs when free, skipped `busy` (with the session's remaining steps)
    after 10 min; a cancel during the wait ends the job without running;
  - cancel during a running step: the step's result is recorded, no further step starts;
  - the job row and items never receive any field but the listed columns (no credential).
  Evidence: under 4.2.
- [ ] 4.2 `server/src/autogenerate/worker.ts` and `principal.ts` (D4: system re-read of the
  account, `forUser`, `userCaller`), `main.ts` start and shutdown. Update the reviewed lists in
  `server/src/catalogSystem.repo.test.ts`: the worker's `forUser(` site, its `userCaller(` site,
  `autogenerate-worker`, and `session-undo` in `server/src/generation/events.ts`. Verify: 4.1
  green, the repo test green, and its mutation checks still fail a synthetic unlisted site.
  Evidence:
- [ ] 4.3 Test first (integration, real Postgres, stubbed providers),
  `server/src/autogenerate/worker.resume.int.test.ts`, **restart-resume**:
  - a job over three sessions with all steps; worker A is stopped (no release, as a crash) while
    session 2's topics step runs; the clock passes the lease; worker B claims within one poll;
    session 1's steps make no second provider call, session 2's topics re-runs once, then its wiki,
    then session 3; the job ends `finished`;
  - an events step interrupted after writing 2 events: on resume they do not count as present, the
    re-run succeeds and the 2 partial events are gone while manual events remain;
  - a wiki step interrupted after its suggestions were stored: no second wiki provider call, and
    in `accept` mode the stored suggestions are accepted;
  - an item interrupted three times ends `failed` `interrupted` and the job continues.
  Evidence:
- [ ] 4.4 Test first (integration), `server/src/autogenerate/worker.authz.int.test.ts`, **the
  per-session re-check as the initiator**:
  - a session deleted between two sessions is skipped `session-gone` with no provider call;
  - the initiator demoted to member (with grants on every show) mid-job: the running step finishes,
    the job ends `failed` `initiator-role-lost`, no further provider call;
  - the initiator removed from the team; the initiator's account disabled; `RUN_FEATURE_EMAILS`
    changed to exclude the initiator: each stops the job with its reason before the next session;
  - every catalog and session statement of a processed session's steps runs as `catalog_user` with
    the initiator's id (the binding spy the existing caller tests use), and the job writes run as
    `catalog_system` `autogenerate-worker`;
  - the provider requests carry the initiator's own stored key, not the operator's or another
    manager's, and a key the initiator changes mid-job is used from the next step.
  Evidence:
- [ ] 4.5 Test first (integration), `server/src/autogenerate/worker.concurrency.int.test.ts`: an AI
  chat turn holding a session's slot makes the batch step wait and then run; a live recording
  lease leads to `busy` after the window (clock-driven); a batch step holding the slot makes a
  manual `topics/generate` answer its existing `409` text unchanged; two worker instances (two
  "processes") never run the same job or the same session at once.
  Evidence:
- [ ] 4.6 Test first (integration), `server/src/autogenerate/worker.wiki.int.test.ts`: `accept`
  mode accepts the run's suggestions with the batch note and the initiator as author and resolver;
  a page edited after the run leaves its suggestion pending (`wiki_pending` 1); a title clash on a
  new page stays pending; `pending` mode leaves all pending; a suggestion from another run is never
  accepted; no suggestion is dismissed.
  Evidence:

## 5. Routes (design D14; api-contract-freeze delta)

- [ ] 5.1 Test first, `server/src/routers/autogenerate.int.test.ts`: every status table row of the
  five routes in the spec's order (401, masked 404 byte-identical to a missing team, member 403,
  400 body, show 404, session 404, no sessions, over 1000, both 503s, run-feature 403, live-job
  409 with `job_id`, `expected_sessions` 409 with `sessions`, 201); two concurrent starts give one
  `201` and one `409`; preview `runs`, `max_runs` and each `blocked` value and that it writes
  nothing; list newest 20; detail shape and order and the `Job not found.` 404 for another team's
  job; cancel of a queued (→ `cancelled`), running (cancel recorded, still `running`), repeated
  (200) and ended (409) job; no route sets a cookie; the shapes added to
  `apiResponseFixtures.int.test.ts`.
  Evidence: under 5.2.
- [ ] 5.2 `server/src/routers/autogenerate.ts`, `startAutogenerateJob` service, mount in
  `server/src/app.ts`, `requireTeamRole` shared from `teams.ts`; `pg_notify` after commit. Verify:
  5.1 green, `teams.int.test.ts` and `authz.int.test.ts` unchanged and green.
  Evidence:
- [ ] 5.3 Test first: add the five routes with their statuses to
  `server/src/routers/readmeEndpoints.repo.test.ts` (red). Then add them to README "Endpoints" and
  a README "Batch autogenerate" section (who may run it, gap rules, order, cancel, resume,
  auto-accept and how to revert a batch revision, rollback). Verify: green.
  Evidence:

## 6. Settings section (design D15; web-ui-system delta)

- [ ] 6.1 Test first, `web/src/pages/index/components/settings/BatchAutogenerateSection.test.tsx`
  and the `SettingsView`/`sections` tests: hidden for a member-only user and listed for an
  owner/admin; team picker limited to managed teams with the active team default; all shows and
  steps ticked by default; wiki mode disabled without Wiki; estimate shown from preview (debounced)
  and each `blocked` message disables Start; the confirm names sessions, max runs, the own-accounts
  note and the auto-accept warning (absent in pending mode); a `409` "sessions changed" refreshes
  and re-asks; a live job (another admin's) shows progress, initiator and Cancel instead of Start,
  polled every 5 s only while visible; cancel goes through the themed confirm; an ended job's
  report groups failed and skipped items by session with their details; Recent jobs opens a
  report; nothing is fetched while Settings is closed or another section is shown.
  Evidence: under 6.2.
- [ ] 6.2 `BatchAutogenerateSection.tsx`, `sections.ts`, `SettingsSections.tsx`,
  `web/src/api/hooks/useAutogenerateJobs.ts`, types. Verify: 6.1 green; `npm run typecheck` exit
  0; biome clean.
  Evidence:

## 7. Security notes

- [ ] 7.1 `docs/security.md`: the auto-accept residual (unreviewed AI text, possibly steered by an
  untrusted transcript, in live pages; marked, attributable, revertible), the spend residual (up to
  4000 runs on the initiator's accounts), and the worker as the second user-binding site. Verify:
  the consistency read (8.2) finds each residual referenced from ADR 0033.
  Evidence:

## 8. Verification

- [ ] 8.1 Dev stack (`make dev-up`): as an admin with a dev provider, run a job over three sessions
  of a test show (one without audio, one already transcribed) in `accept` mode; restart the `api`
  container during the second session; record the report (outcomes per step), that the job
  resumed, and a batch revision's note in the page history. Repeat once in `pending` mode.
  Evidence:
- [ ] 8.2 Tier 2 consistency read (`consistency-read` skill) over specs, design, code and tests;
  every finding fixed or escalated.
  Evidence:
- [ ] 8.3 `scripts/check-change.sh --stage hook` green, then `scripts/check-change.sh` (all gates,
  as CI) green with `GITHUB_BASE_REF=main`.
  Evidence:

## 9. Hand-off to the playlist import (proposal "Follow-up")

- [ ] 9.1 Test first, `server/src/autogenerate/startService.int.test.ts`: `startAutogenerateJob`
  called without an HTTP request, for a given initiator and a session-id list, creates the same job
  the route would (order, items, `scope` `sessions`), and refuses exactly as the route does when the
  initiator is a member, unapproved, unconfigured, or the team has a live job. Then export it for
  server-side callers. The "autogenerate after import" checkbox is not built here: it lands with
  whichever of `youtube-playlist-import` and this change merges second (proposal "Follow-up").
  Evidence:
