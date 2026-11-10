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

- [x] 1.1 Write `docs/decisions/0033-batch-autogenerate-jobs.md` (template 0000; Status Proposed;
  Rule: batch-autogenerate, show-wiki "A batch job accepts suggestions as its initiator",
  core-ports-architecture "Every catalog and session call is bound to a caller"). It states how the
  change answers ADR 0031's "background run" revisit trigger: the human initiator is the author,
  the credential is the initiator's, and auto-accept is limited to safe changes (owner decision
  8a: new pages and additions-only rewrites, the precise rule, and the residual of R1). Add a
  one-line pointer to 0033 in ADR 0031's Consequences. Docs only, no test; verify:
  `scripts/check-change.sh --only openspec,guide-size` passes and `grep -n 0033
  docs/decisions/0031-show-wiki-ai.md` finds the pointer.
  Evidence: `scripts/check-change.sh --only openspec,guide-size` -> `PASS openspec openspec validate --strict`, `PASS guide-size AGENTS.md 96/150 lines`; `grep -n 0033 docs/decisions/0031-show-wiki-ai.md` -> `59:- **Background run:** ADR 0033 (batch autogenerate) answers that trigger` (ba-1.1-green.log)
- [x] 1.2 Test first, new `server/src/test/pg/autogenerateJobs.pg.test.ts`, plus the recorded
  expectation in `catalogSchema.pg.test.ts` and the RLS listing test:
  - the columns, checks and the live index: a second `queued`/`running` job for a team fails
    `23505`, a `finished` one does not; an outcome or stop reason outside the lists fails `23514`;
    an outcome with the wrong item status (`present` on a `failed` item) fails `23514`;
    `stop_reason` null with `failed` fails `23514`;
  - deleting a team row (as `postgres`, standing in for `adminDeleteStudio` and the importer)
    deletes its jobs and their items (cascade);
  - `catalog_user` select: owner and admin of the team see its jobs and items; a member, an outsider
    and an admin of another team see none;
  - insert: an admin inserts a `queued` job with itself as initiator and its items; a member, an
    admin naming another initiator, an admin of another team, a job inserted `running` or with lease
    or cancel columns set, and items for another user's job each fail (`42501` or the policy's
    `new row violates`);
  - update: an admin of the team requests a cancel on a `running` job (cancel columns only) and
    cancels a `queued` one (`status` `cancelled`, `stop_reason` `cancelled`); a member's cancel,
    a second cancel overwrite, `running → finished`, a change to `initiator_user_id`, `steps`,
    either `consecutive_*_failures` count or the lease each fail `42501`; `catalog_user` update or delete
    on items and delete on jobs fail `42501`;
  - `catalog_system` may do all of the above.
  Evidence: under 1.3; red before 1.3: `npx vitest run --project pg src/test/pg/autogenerateJobs.pg.test.ts` -> `PostgresError: relation "autogenerate_jobs" does not exist`, `11 skipped`; catalogSchema/catalogPolicies with the expectations unchanged -> `× matches the recorded catalog schema`, `expected [...] to have a length of 49 but got 54` (ba-1.2-red.log)
- [x] 1.3 `supabase/migrations/20261025000000_autogenerate_jobs.sql`: both tables (with
  `on delete cascade` from `studio_definitions`, `own_topic_ids`, `kept_edited`, the two
  `consecutive_*_failures` counts, an index on items `(session_id, step)`,
  the outcome/status check), indexes, RLS, the system policies, the user policies, the column
  grant, `autogenerate_jobs_user_guard`, the header with the rollback statements; no
  transaction-control lines (`migrate.sh`). Verify: 1.2 green; `docker/supabase/test_migrate.sh`
  green.
  Evidence: `npx vitest run --project pg src/test/pg/catalogSchema.pg.test.ts src/test/pg/catalogPolicies.pg.test.ts src/test/pg/autogenerateJobs.pg.test.ts` -> `Tests 73 passed (73)` (ba-1.3-green.log); `sh docker/supabase/test_migrate.sh` -> `test_migrate: 55 passed, 0 failed` (ba-1.3-migrate.log)
- [x] 1.4 Legacy importer (design D1, R11). Test first, `server/src/test/importLegacy.test.ts` and
  the importer's pg test: "is the newest migration" is red before the pin moves; `--replace` and
  `--replace-live` of a team with a `queued` and with a `running` job each fail with `legacy import
  refused: team <id> has a batch autogenerate job in progress; cancel it first` and change
  nothing; with only a `finished` job, both succeed and the job and its items are gone; the job
  table is in the importer's lock list. Then move `TARGET_SCHEMA_VERSION` to `20261025000000` and
  add the refusal and the lock in `server/scripts/legacyImportSql.ts`. Verify: green.
  Evidence: red: `npx vitest run --project unit src/test/importLegacy.test.ts` -> `× is the newest migration`, `× locks the batch autogenerate jobs table`; pg -> `Tests 9 failed | 1 passed` (the pin, ba-1.4-red.log); green: unit `Tests 25 passed (25)`, `npx vitest run --project pg src/test/pg/importLegacy.pg.test.ts` -> `Tests 10 passed (10)` (ba-1.4-green.log)
- [x] 1.5 Test first, `server/src/routers/teams.int.test.ts` addition: a team that has only
  finished jobs and no shows is deleted through `DELETE /api/teams/:id` (`200`) and its jobs are
  gone; a team with a live job still has shows and answers the existing `400` "Team still has N
  show(s)". Expected to pass once 1.3 lands (no `adminDeleteStudio` change); record it.
  Evidence: passed on first run as expected (no adminDeleteStudio change): `npx vitest run --project integration src/routers/teams.int.test.ts` -> `Tests 67 passed (67)` (ba-1.5-green.log)

## 2. Contract and catalog store (design D1, D3, D12, D13, D14)

- [x] 2.1 Test first, `packages/contract/src/autogenerate.test.ts`: the scope body (exactly one of
  `show_ids`/`session_ids`, non-empty, 200/1000 caps, steps non-empty and unique, `wiki_mode`
  default `accept`, `expected_sessions` required on start and a non-negative integer), each refusal
  producing zod 4 issues; the outcome list equals the contract table's 20 codes, each maps to its
  exact detail string and its one item status; the stop reasons include `provider-failing`; the job
  and detail response schemas parse the spec's examples.
  Evidence: under 2.2; red: `npx vitest run src/autogenerate.test.ts` (packages/contract) -> `Error: Cannot find module './autogenerate'`, `Tests no tests` (ba-2.1-red.log)
- [x] 2.2 `packages/contract/src/autogenerate.ts` (schemas, `AUTOGENERATE_OUTCOMES` with status
  and detail, stop reasons, step order). Verify: 2.1 green, `npm run typecheck` exit 0.
  Evidence: `npx vitest run src/autogenerate.test.ts` -> `Tests 11 passed (11)` (ba-2.2-green.log); `npm run typecheck` -> `exit=0`, 0 `error TS` (ba-2.2-typecheck.log)
- [x] 2.3 Test first, `packages/contract/src/wikiSafeSuggestion.test.ts` for `isSafeSuggestion`
  (design D12): a new page is safe; `A\nB\nC` → `A\nB\nnew\nC` safe, → `new\nA\nB\nC\nend` safe;
  `A\nB more\nC` unsafe; `A\nC` unsafe; `B\nA\nC` (reordered) unsafe; `CRLF` bodies compare as
  `LF`; a trailing-space change on a line unsafe; title changed (beyond trim) unsafe; an alias
  dropped unsafe, an alias added safe; an empty old body with any new body safe. Then implement.
  Verify: green.
  Evidence: red: `npx vitest run src/wikiSafeSuggestion.test.ts` -> `Cannot find module './wikiSafeSuggestion'` (ba-2.3-red.log); green: `Tests 7 passed (7)` (ba-2.3-green.log)
- [x] 2.4 Test first, `server/src/test/pg/autogenerateStore.pg.test.ts`:
  - create: candidates for a show scope exclude deleted and include archived sessions; a session
    scope dedupes; the ordinals follow design D13 for the spec's two ordering scenarios (B, A, C;
    `b` before `a`) and put undated sessions last; items are one per session and step in
    `(ordinal, step_order)`; the job and items commit together or not at all;
  - claim: two concurrent claims with one due job return it once; a `running` job with a lapsed
    lease is claimable, a live one is not; renewals and transitions fenced on `locked_by` change
    nothing for another holder; a renewal of a job whose row was deleted reports "gone";
  - write-ahead: appending to `run_ids` and `own_topic_ids` is fenced like every item write and
    reports 0 rows for a holder that lost the lease;
  - recorded partial output: for a session and step, the store returns the run ids and topic ids
    on non-`done` items of every job (two jobs, one `done` item excluded);
  - list returns the newest 20 of the team; detail returns items in order with current titles
    (`""` for a vanished session); preview counts missing transcript, events (auto-generated only)
    and topics.
  Evidence: under 2.5; red with the store not yet on the facade: `npx vitest run --project pg src/test/pg/autogenerateStore.pg.test.ts` -> `× a show scope: deleted sessions excluded...`, every case failing on `autogenerate` undefined (ba-2.4-red.log). The store file was drafted before this test was run; the red run is with it unwired. Two of the test's own expectations were wrong and corrected (the session-scope order is `a, A` by D13, since both are dated 2024-03-01 and `a` started first; the empty-output check used a session that held another test's recorded ids)
- [x] 2.5 `packages/catalog/src/autogenerateStore.ts` on the catalog facade; add
  `autogenerate-worker` to the reviewed system reasons (`server/src/catalogSystem.repo.test.ts`
  ALLOWLIST, file and reason). Verify: 2.4 green; `catalogSystem.repo.test.ts` green.
  Evidence: `npx vitest run --project pg src/test/pg/autogenerateStore.pg.test.ts` -> `Tests 14 passed (14)`; `npx vitest run --project unit src/catalogSystem.repo.test.ts` -> `Tests 18 passed (18)` (allowlist entry `packages/catalog/src/autogenerateStore.ts autogenerate-worker`: `autogenerateWorkerCatalog` is the one reviewed binding site the worker uses); `packages/catalog` `src/catalog.test.ts` -> `Tests 8 passed (8)`; typecheck exit 0 (ba-2.5-green.log, ba-2-typecheck.log)

## 3. Shared runners (design D6, D7, D9, D12)

- [x] 3.1 Baseline: before any edit, run the regression net of design D6 and record the per-file
  counts: `transcribe.int.test.ts`, `transcribe.test.ts`, `events.generate.int.test.ts`,
  `eventsGenerateWindow.test.ts`, `wikiSuggestions.int.test.ts`, `wiki.int.test.ts`,
  `ai.int.test.ts`, `aiV2.int.test.ts`, `providers.int.test.ts`,
  `sessions.youtubeImport.int.test.ts`, `apiResponseFixtures.int.test.ts`, `_aiRoute.test.ts`, and
  `server/src/test/aiSdk.real.test.ts` (record whether it runs or skips without real keys). Their
  assertions are not edited in group 3; the only allowed edits are the signature updates of 3.6.
  Evidence: before any edit, `npx vitest run --project integration <9 int files> --reporter=verbose` -> `Tests 503 passed (503)`; `--project unit <4 unit files>` -> `Tests 10 passed | 2 skipped (12)`. Per file: transcribe.int 83, transcribe 6, events.generate.int 46, eventsGenerateWindow 1, wikiSuggestions.int 34, wiki.int 78, ai.int 54, aiV2.int 76, providers.int 20, sessions.youtubeImport.int 44, apiResponseFixtures.int 68, _aiRoute 3, aiSdk.real 0 passed + 2 skipped (skips without real keys) (ba-3.1-baseline.log)
- [x] 3.2 Test first, `server/src/generation/transcript.test.ts`: `runTranscript` returns typed
  outcomes for unconfigured, forbidden, busy, `no_audio`, `no_speech`, upstream, upstream `429`
  (`rate-limited`, via a numeric `status` on `DeepgramUpstreamError`), oversize, missing blob,
  unreadable and ok; with `onlyIfEmpty`, a word inserted between the provider call and the replace
  makes the outcome `present`, the replace rolls back and the inserted word remains
  (`packages/session-core` replace test for the sentinel too). Then extract the runner from
  `transcribe.ts`; the route becomes an adapter. Verify: 3.2 green and the 3.1 transcript suites
  green with the baseline counts.
  Evidence: red: `npx vitest run --project integration src/generation/transcript.int.test.ts src/test/session/replaceOnlyIfEmpty.int.test.ts` -> `Cannot find module './transcript'`; the replace test `× throws the sentinel and writes nothing` (ba-3.2-red.log). Green: `Tests 9 passed (9)`; net: transcribe.int 83 passed, transcribe 6 passed (baseline counts); packages/transcription `Tests 101 passed` (ba-3.2-green.log). Deviation: the runner test is `server/src/generation/transcript.int.test.ts` (integration, not `.test.ts`): the onlyIfEmpty sentinel needs the real hub transaction; the session-core replace test is `server/src/test/session/replaceOnlyIfEmpty.int.test.ts`, where the hub's database tests live; `oversize` is covered through `transcriptOutcomeOf` (a 2 GB group is not producible in a test)
- [ ] 3.3 Test first, `server/src/generation/events.test.ts` (design D7 events):
  - with `excludeEventIds` (the earlier attempts' events), those events are absent from the
    prompt's existing-events list and from `create_event`'s anchor basis, exactly as a regenerate
    snapshot is, while the run is not a regenerate;
  - with earlier `run_ids`, events tagged with them do not count as present; after a successful
    run they are deleted (also when the run created none); manual events and other runs' events
    remain;
  - a failed run, and a run ended as `interrupted`, delete the events of every run id in the
    item's `run_ids`, the current one included, as the initiator (user caller), and nothing else;
  - deletes are per row with expected version 1: an event a person edited is kept, counted in
    `kept_edited`, and makes the gap check `present`;
  - when the run-id append changes 0 rows (lease lost), the run does not start and no provider
    request is made;
  - an AI SDK `429` is reported as `rate-limited`.
  Then extract from `events.ts`. Verify: 3.3 green, 3.1 events suites green with the baseline
  counts.
  Evidence: NOT TICKED: the runner is extracted and its new test is green, but one regression-net test cannot stay green with its assertions unchanged. `server/src/routers/eventsGenerateWindow.test.ts` reads the text of `routers/events.ts` and looks for the literal `const transcriptWords = await (await getSessionHub(c, sessionId)).listTranscriptWords();`, and that code now lives in `server/src/generation/events.ts` (design D6). Retargeting it needs the human: D6 allows edits only in `_aiRoute.test.ts` and `aiSdk.real.test.ts`. The same invariant is enforced on the runner by a new `server/src/generation/eventsWindow.test.ts` (green). Red (batch behaviour stripped from the runner): `npx vitest run --project integration src/generation/events.int.test.ts` -> `Tests 5 failed | 1 passed (6)` (ba-3.3-red.log); green -> `Tests 6 passed (6)` (ba-3.3-green.log); net: events.generate.int 46, _aiRoute 3 passed, eventsGenerateWindow 0/1 (ba-3.4-net-raw.log). Deviation: integration test (`events.int.test.ts`), since it needs the real hub, row versions and a fake provider
- [x] 3.4 Test first, `server/src/generation/topics.test.ts` and `packages/ai-runtime`
  `aiMcpServer` tests (design D7 topics):
  - `create_topic` with an id allocator calls it before `insertTopic`, inserts with the allocated
    id, and an allocator that throws makes the tool return an error without inserting; after one
    refusal every later call of the turn refuses too and the runner reports the turn failed;
  - own-topic deletes use expected version 1: a topic a person edited is kept, counted in
    `kept_edited`, and makes the gap check `present`;
  - the manual route: a run whose tool created 0 topics while a person added one answers the
    existing `502 Topic generation failed.` and keeps both the pre-run topics and the person's
    (R12 edge);
  - the runner deletes on failure exactly the topics its tool created: a topic a person inserts
    during a failing run survives (manual route included, R12), and the success swap still
    deletes the pre-run topics;
  - `runTopics` outcomes (unconfigured, forbidden, no words, busy, failed, `rate-limited`, ok).
  Then extract from `transcribe.ts` and add the allocator and `insertTopic`'s optional id. Verify:
  green, 3.1 suites green with the baseline counts.
  Evidence: red: `npx vitest run --project integration src/test/session/aiMcpTopicAllocator.int.test.ts` -> `expected [ 'insert', 'insert' ] to deeply equal [ 'allocate', 'insert', …` (2 failed); `src/generation/topics.int.test.ts` -> `Cannot find module './topics'` (ba-3.4-red.log). Green: `Tests 10 passed (10)` (ba-3.4-green.log); net after the extraction: transcribe.int 83, ai.int 54, aiV2.int 76, providers.int 20, sessions.youtubeImport.int 44, apiResponseFixtures.int 68, wiki.int 78, wikiSuggestions.int 34, transcribe 6, _aiRoute 3 passed, aiSdk.real 2 skipped (ba-3.4-net-raw.log, then transcribe.int rerun 83 passed). The page-coverage tests in transcribe.int stub `generateTopicsTurn` and insert through `opts.registry` rather than the tool. They stay unchanged and green because the runner hands the turn a registry handle that allocates (and, for a batch, records) an id for any topic inserted through it. Production inserts come only from `create_topic`, which carries an explicit allocated id. Deviation: integration tests (`topics.int.test.ts`; the aiMcpServer allocator test is `server/src/test/session/aiMcpTopicAllocator.int.test.ts`, beside the existing MCP server suite)
- [x] 3.5 Test first, `server/src/generation/wiki.test.ts` and
  `server/src/test/pg/wikiSuggestionStore.pg.test.ts` additions: `runWiki` accepts a caller-chosen
  run id; `acceptSuggestion(id, {expectedRevision}, {batchJobId})` writes the note `accepted
  suggestion <id> (batch <job>)` (and `created from suggestion <id> (batch <job>)` for a new page),
  `resolved_by` is the bound user, and every refusal of the manual accept still refuses. Then
  extract from `wikiSuggestions.ts` and add the option. Verify: green, 3.1 wiki suites green with
  the baseline counts.
  Evidence: red: `npx vitest run --project integration src/generation/wiki.int.test.ts` -> `Cannot find module './wiki'`; `--project pg src/test/pg/wikiSuggestionStore.pg.test.ts` -> `× notes an existing page ... (batch <job>)`, `× notes a new page ...`, `× lists a run’s pending suggestion ids`, `Tests 3 failed | 27 passed` (the refusals case passed before the change, as expected) (ba-3.5-red.log). Green: wiki.int `Tests 3 passed (3)`, store pg `Tests 30 passed (30)` (ba-3.5-green.log); net: wikiSuggestions.int 34, wiki.int 78 (ba-3.6-net-raw.log). The store also gains `pendingOfRun`/`anyOfRun` (a run's suggestions by run id, for the worker's resume and accept order). Deviation: integration test name `wiki.int.test.ts`
- [ ] 3.6 `sdkTurnSpec` and `callerLlmRoute` take `(env, user)`. Update only the call sites in
  `_aiRoute.test.ts` and `aiSdk.real.test.ts` to the new signature. Verify: every 3.1 suite green
  with the baseline counts; `git diff --stat` over the net shows changes only in those two files,
  and their diffs touch only `sdkTurnSpec`/`callerLlmRoute` call lines.
  Evidence: NOT TICKED: its verify needs every net suite green, and `eventsGenerateWindow.test.ts` is red (see 3.3). Otherwise done: `sdkTurnSpec(env, …)`/`callerLlmRoute(env, user)` in `server/src/generation/aiRoute.ts` (re-exported by `routers/_aiRoute.ts`, plus a `requestLlmRoute(c)` wrapper for the routes). Net, `--reporter=verbose`: every file at its baseline count except `eventsGenerateWindow.test.ts` 0/1 (see 3.3) (ba-3.6-green.log). `git diff --stat` over the 13 net files -> `server/src/routers/_aiRoute.test.ts | 6 +++---` only, its three lines `sdkTurnSpec(ctx, …)` -> `sdkTurnSpec(ctx.env, …)`. `aiSdk.real.test.ts` needed no edit (it never calls `sdkTurnSpec` directly).

## 4. The worker (design D3, D4, D5, D7-D12, D17)

- [x] 4.1 Test first, `server/src/autogenerate/worker.test.ts` (fake clock, fake runners, fake
  store):
  - the ladder runs in D5's order, and step 4 (session access as the initiator) runs before every
    session even when steps 1-3 pass;
  - a session the initiator can no longer access is skipped `access-lost` with **no runner call**,
    and a deleted one `session-gone`; the job continues;
  - disabled initiator, role lost, not approved, and unconfigured STT / LLM each stop the job with
    their `stop_reason` (the detecting item `failed` `unconfigured` for the last two), the remaining
    items `cancelled` with `job-stopped`;
  - present, precondition cascades (`no-audio` → `no-transcript`), failure cascade
    (`earlier-step-failed`), the D9 mapping table row by row, and every item status/outcome pair
    matches the contract table;
  - busy: retried every 15 s, runs when free, skipped `busy` (with the session's remaining steps)
    after 10 min; a cancel during the wait ends the job without running;
  - `rate-limited`: retried after 30, 60, 120, 240, 480 s, a cancel during a wait is honoured, the
    fifth refusal ends the item `failed` `rate-limited`; a success after two refusals is `done`;
  - consecutive provider failures per kind: three sessions in a row with an LLM step failing with
    `provider-failed`, `generation-failed` or `rate-limited` stop the job `provider-failing` even
    though each had a `done` transcript; an LLM `done` resets only the LLM count, an STT `done`
    only the STT count; skips change neither; both counts survive a resume;
  - every ending cleans up: for an item with recorded partial output, a cancel (also during a busy
    and during a rate-limit wait), each job stop reason, `provider-failing`, and ladder steps 1-4
    refusing the session each call `cleanupOwnOutput` before the item's ending write; when the
    initiator's deletes are refused, the item still ends and the rows stay recorded;
  - cancel during a running step: the step's result is recorded, no further step starts;
  - the worker polls every 15 s and sends no `pg_notify`;
  - the job row and items never receive any field but the listed columns (no credential).
  Evidence: under 4.2; red with the worker module absent: `npx vitest run --project unit src/autogenerate/worker.test.ts` -> `Cannot find module './worker'` (ba-4.1-red.log). The worker was drafted beside the test; its first run against it failed 2 cases, which led to fixes: `account` cleanup was skipped when the account was gone (now attempted through a bound principal), and the source comment matched the no-pg_notify check (ba-4.1 notes). Green: `Tests 23 passed (23)` (ba-4.1-green.log)
- [x] 4.2 `server/src/autogenerate/worker.ts` and `principal.ts` (D4: system re-read of the
  account, `forUser`, `userCaller`), `main.ts` start and shutdown. Update the reviewed lists in
  `server/src/catalogSystem.repo.test.ts`: the worker's `forUser(` site, its `userCaller(` site and
  `autogenerate-worker` (no `session-undo` site: cleanup runs as the initiator, D7). Verify: 4.1
  green, the repo test green, and its mutation checks still fail a synthetic unlisted site.
  Evidence: `server/src/autogenerate/{worker,principal,ports,steps}.ts`, `main.ts` start and shutdown; `catalogSystem.repo.test.ts`: `server/src/autogenerate/principal.ts` added to USER_BINDERS (`forUser(`) and USER_SESSION_CALLERS (`userCaller(`). The `autogenerate-worker` reason stays reviewed at `packages/catalog/src/autogenerateStore.ts` (`autogenerateWorkerCatalog`, task 2.5), the one system site the worker uses. No `session-undo` entry. `packageBoundaries.repo.test.ts` enumerates `generation` and `autogenerate`. `npx vitest run --project unit src/autogenerate/worker.test.ts src/catalogSystem.repo.test.ts src/packageBoundaries.repo.test.ts` -> `Tests 126 passed (126)`, the repo test's synthetic-tree mutation cases included (ba-4.2-green.log)
- [x] 4.3 Test first (integration, real Postgres, stubbed providers),
  `server/src/autogenerate/worker.resume.int.test.ts`, **restart-resume**:
  - a job over three sessions with all steps; worker A is stopped (no release, as a crash) while
    session 2's topics turn runs, after its tool created 2 topics; the fake clock advances 90 s
    from A's last renewal; worker B claims the job by then; session 1's steps make no second
    provider call; session 2's 2 partial topics are deleted, its topics step is **not** `present`
    and re-runs once, then its wiki, then session 3; the job ends `finished`;
  - a topic a person adds to session 2 between the crash and the resume makes the resumed step
    `present` after the partial topics are deleted, and the person's topic remains;
  - an events step interrupted after writing 2 events: the resumed run's prompt and anchor basis
    exclude them, the re-run succeeds, and the 2 partial events are gone while manual events
    remain; an events item interrupted three times ends `failed` `interrupted` and the events of
    all its run ids are deleted;
  - a wiki step interrupted after its suggestions were stored: no second wiki provider call, and
    in `accept` mode its safe suggestions are accepted;
  - the job continues after an `interrupted` item;
  - **cross-job exclusion**: job 1 is stopped with the initiator's access to session 2 removed
    after its topics attempt wrote 2 topics (cleanup refused); job 2, by another admin, finds those
    topics not `present`, deletes them as its initiator and generates topics; an edited one is kept
    and makes the step `present`;
  - **lease takeover**: worker A's lease is taken over by worker B mid topics turn; A's next
    `create_topic` refuses (0-row fenced write), A inserts no unrecorded topic and writes nothing
    more; every topic in the session is recorded on the item; B's step proceeds once A's run lease
    is released.
  Evidence: red: with the worker's catch for unexpected runner throws reverted, `npx vitest run --project integration src/autogenerate/worker.resume.int.test.ts` -> `× job 2 finds job 1’s recorded topics not present…`, `SessionAccessDeniedError` (ba-4.3-red.log); green `Tests 9 passed (9)` (ba-4.3-green.log). The crash is emulated by abandoning A's hung turn (`worker.stop()`, `aiChatTurns.reset()`, A's run lease rows removed, clock +90 s). The events resume finds the earlier attempt's events already deleted by the pre-gap cleanup; the exclusion path itself is covered in 3.3
- [x] 4.4 Test first (integration), `server/src/autogenerate/worker.authz.int.test.ts`, **the
  per-session re-check as the initiator**:
  - a session deleted between two sessions is skipped `session-gone` with no provider call;
  - the initiator demoted to member (with grants on every show) mid-job: the running step finishes,
    the job ends `failed` `initiator-role-lost`, no further provider call;
  - the initiator removed from the team; the initiator's account disabled; `RUN_FEATURE_EMAILS`
    changed to exclude the initiator: each stops the job with its reason before the next session;
  - every catalog and session statement of a processed session's steps, the cleanup deletes
    included, runs as `catalog_user` with the initiator's id (the binding spy the existing caller
    tests use), and the job writes run as `catalog_system` `autogenerate-worker`;
  - the provider requests carry the initiator's own stored key, not the operator's or another
    manager's, and a key the initiator changes mid-job is used from the next step.
  Evidence: passed on its first run against the 4.2 worker; mutation red (session gate always ok, role check accepting member) -> `Tests 2 failed | 5 passed` (ba-4.4-red.log); green `Tests 7 passed (7)` (ba-4.4-green.log). Binding spy: the `GatedCatalog` statement log, plus a storage-caller recorder. Every session statement runs as `user:<initiator>` (except the hub's own `system:session-open`), and job writes as `system:autogenerate-worker`
- [x] 4.5 Test first (integration), `server/src/autogenerate/worker.concurrency.int.test.ts`: an AI
  chat turn holding a session's slot makes the batch step wait and then run; a live recording
  lease leads to `busy` after the window (clock-driven); a batch step holding the slot makes a
  manual `topics/generate` answer its existing `409` text unchanged; two worker instances (two
  "processes") never run the same job or the same session at once; a job whose team row is
  deleted mid-job (as the importer would, bypassing its guard) stops the worker without writes.
  Evidence: passed on its first run; mutation red (recording gate disabled) -> `× a live recording lease leads to busy after the 10-minute window` (ba-4.5-red.log); green `Tests 5 passed (5)` (ba-4.5-green.log)
- [x] 4.6 Test first (integration), `server/src/autogenerate/worker.provider.int.test.ts`: with a
  stub STT provider answering `401` for every request, a 6-session job ends `failed`
  `provider-failing` after session 3 and the stub saw exactly 3 transcript requests; **LLM key
  revoked, STT fine**: the STT stub answers `200`, the LLM stub `401`, a 6-session job with
  transcript and events ends `provider-failing` after session 3 with 3 transcript `done` and 3
  events `provider-failed`, and no request for session 4; with a stub answering `429` twice then
  `200`, the step is `done` after the 30 s and 60 s waits (fake clock); a cancel during a `429`
  wait after an events attempt wrote 3 events deletes them and ends the job `cancelled`.
  Evidence: red: `npx vitest run --project integration src/autogenerate/worker.provider.int.test.ts` -> `expected 'failed generation-failed' to be 'failed provider-failed'` (ba-4.6-red.log); green `Tests 4 passed (4)` (ba-4.6-green.log): STT 401 -> provider-failing after 3 DeepGram requests; LLM 401 -> 3 events provider-failed; 429×2 -> done after [30000, 60000]; a cancel in the 429 wait deletes the 3 events. An AI SDK refusal with an HTTP status other than 429 is now `provider-failed` (D9 says generation-failed; the spec scenario requires provider-failed; flagged)
- [x] 4.7 Test first (integration), `server/src/autogenerate/worker.wiki.int.test.ts` (design D12):
  in `accept` mode, a new-page suggestion and an additions-only rewrite are accepted with the batch
  note and the initiator as author and resolver; a rewrite that changes a line, one that drops a
  line, one that changes the title and one that drops an alias each stay `pending`; a page edited
  after the run leaves its suggestion pending; a title clash on a new page stays pending; the item
  records the matching `wiki_accepted` and `wiki_pending`; `pending` mode leaves all pending; a
  suggestion from another run is never accepted; no suggestion is dismissed.
  Evidence: mutation red (safe check skipped) -> `expected 'accepted' to be 'pending'` (ba-4.7-red.log); green `Tests 2 passed (2)` (ba-4.7-green.log); all five worker suites plus generation int: `Tests 51 passed (51)` (ba-4.3-4.7-all.log)

## 5. Routes (design D14; api-contract-freeze delta)

- [x] 5.1 Test first, `server/src/routers/autogenerate.int.test.ts`: every status table row of the
  five routes in the spec's order (401, masked `404 {"detail":"Team not found"}` byte-identical to
  a missing team, member 403, `422` with zod 4 issues for a body with both scopes, with neither,
  with duplicate steps and for a start without `expected_sessions`, show 404, session 404, no
  sessions, over 1000, both 503s, run-feature 403, live-job 409 with `job_id`, `expected_sessions`
  409 with `sessions`, 201); two concurrent starts give one `201` and one `409`; preview `runs`,
  `max_runs` and each `blocked` value and that it writes nothing; list newest 20; detail shape and
  order, item status/outcome pairs per the contract table, `kept_edited`, and the `Job not found.` 404 for another
  team's job; cancel of a queued (→ `cancelled`), running (cancel recorded, still `running`),
  repeated (200) and ended (409) job; no route sets a cookie; the five success shapes and the two
  typed `409` bodies captured in `apiResponseFixtures.int.test.ts` into `fixtures/api-responses/`.
  Evidence: under 5.2; red: `npx vitest run --project integration src/routers/autogenerate.int.test.ts` -> `Tests 8 failed (8)` (no routes, ba-5.1-red.log). Fixtures captured with `UPDATE_API_FIXTURES=1 npx vitest run --project integration src/routers/apiResponseFixtures.int.test.ts -t 'batch autogenerate routes'` into `fixtures/api-responses/autogenerate{Preview,Start,List,Detail,Cancel,LiveJob,SessionsChanged}.ts`, then re-asserted: `Tests 69 passed (69)` (ba-5.1-fixtures.log)
- [x] 5.2 `server/src/routers/autogenerate.ts`, `startAutogenerateJob` service, mount in
  `server/src/app.ts`, `requireTeamRole` shared from `teams.ts` (no `pg_notify`: the worker polls).
  Verify: 5.1 green, `teams.int.test.ts` and `authz.int.test.ts` unchanged and green.
  Evidence: `npx vitest run --project integration src/routers/apiResponseFixtures.int.test.ts src/routers/autogenerate.int.test.ts` -> `Tests 77 passed (77)`; `src/routers/teams.int.test.ts src/routers/authz.int.test.ts` (assertions unchanged; teams.int carries only the 1.5 addition) -> `Tests 75 passed (75)` (ba-5.2-green.log). `startAutogenerateJob` is in `server/src/autogenerate/service.ts`; `requireTeamRole`/`OWNER_OR_ADMIN` are exported from `teams.ts`; no notify call
- [x] 5.3 Test first: add the five routes with their statuses to
  `server/src/routers/readmeEndpoints.repo.test.ts` (red). Then add them to README "Endpoints" and
  a README "Batch autogenerate" section (who may run it, gap rules, order, cancel, resume, provider
  stop, safe-only auto-accept and how to revert a batch revision, the importer refusal, rollback).
  Verify: green.
  Evidence: red: `npx vitest run --project unit src/routers/readmeEndpoints.repo.test.ts` -> `Tests 5 failed | 6 passed (11)` (ba-5.3-red.log); after the README rows and the "Batch autogenerate" section -> `Tests 11 passed (11)` (ba-5.3-green.log)

## 6. Settings section (design D15; web-ui-system delta)

- [x] 6.1 Test first, web API-response conformance for the five new client call sites: client
  types in `web/src/api/types.ts` (job object, detail, preview, the typed `409` bodies `{detail,
  job_id}` and `{detail, sessions}`, the `422` issues body); type-level assignments in
  `web/src/api/types.conformance.test.ts` against each fixture captured in 5.1, including both
  `409` bodies; a verdict entry for every new parse site in `web/src/apiResponseShapes.repo.test.ts`
  (red until the sites and types exist). Verify: `npm run typecheck` and both tests green after
  6.3.
  Evidence: under 6.3; red: `npx tsc --noEmit -p web` -> `error TS2305: Module '"./types"' has no exported member 'AutogenerateDetailResponse'` (ba-6.1-red.log); green: `cd web && npx vitest run src/api/types.conformance.test.ts src/apiResponseShapes.repo.test.ts` -> `Tests 134 passed (134)` (ba-6.1-green.log). No new verdict entry was needed: every new `apiFetch<T>` site names a fixture-checked type
- [x] 6.2 Test first, `web/src/pages/index/components/settings/BatchAutogenerateSection.test.tsx`
  and the `SettingsView`/`sections` tests: hidden for a member-only user and listed for an
  owner/admin; team picker limited to managed teams with the active team default; all shows and
  steps ticked by default; wiki mode disabled without Wiki; estimate shown from preview (debounced)
  and each `blocked` message disables Start; the confirm names sessions, max runs, the own-accounts
  note and what auto-accept adds and leaves for review (absent in pending mode); a `409` "sessions
  changed" refreshes and re-asks; a `422` shows a generic error; a live job (another admin's) shows
  progress, initiator and Cancel instead of Start, polled every 5 s only while visible; cancel goes
  through the themed confirm; an ended job's report groups failed and skipped items by session with
  their details, words each stop reason (`provider-failing` included), and shows the wiki
  accepted/left-pending counts; Recent jobs opens a report; nothing is fetched while Settings is
  closed or another section is shown.
  Evidence: under 6.3; red: `cd web && npx vitest run src/pages/index/components/settings/BatchAutogenerateSection.test.tsx` -> `Failed Tests 21` (ba-6.2-red.log); green `Tests 23 passed (23)`; settings dir `Tests 183 passed` (ba-6.2-green.log)
- [x] 6.3 `BatchAutogenerateSection.tsx`, `sections.ts`, `SettingsSections.tsx`,
  `web/src/api/hooks/useAutogenerateJobs.ts`, `web/src/api/types.ts`. Verify: 6.1 and 6.2 green;
  `npm run typecheck` exit 0; biome clean.
  Evidence: `cd web && npx vitest run` -> `Test Files 183 passed`, `Tests 2463 passed` (ba-6.3-web-full.log); `npm run typecheck` exit 0 (ba-6.3-typecheck.log); biome clean on the touched files. Adds an optional `active` prop to the Settings sections, so a hidden mounted section stops polling

## 7. Security notes

- [ ] 7.1 `docs/security.md`: the auto-accept residual (new pages and added lines, possibly
  steered by an untrusted transcript, live without review; removals always wait for a person;
  marked, attributable, revertible; stacked revisions), the spend residual (up to 4000 runs on the
  initiator's accounts, bounded by the provider-failure stop), and the worker as the second
  user-binding site. Verify: the consistency read (8.2) finds each residual referenced from ADR
  0033.
  Evidence: NOT TICKED: its verify is the 8.2 consistency read, which is still open. Done: `docs/security.md` gains "Batch autogenerate jobs" (the auto-accept residual, the spend residual, the worker as the second user-binding site, uncleaned partial output). `grep -n 'docs/security.md' docs/decisions/0033-batch-autogenerate-jobs.md` -> the R1 residual line and the "Recorded in docs/security.md" line

## 8. Verification

- [ ] 8.1 Dev stack (`make dev-up`): as an admin with a dev provider, run a job over three sessions
  of a test show (one without audio, one already transcribed) in `accept` mode; restart the `api`
  container during the second session's topics step; record the report (outcomes per step), that
  the job resumed within 90 s, that no partial topic set was kept, and a batch revision's note in
  the page history. Repeat once in `pending` mode.
  Evidence:
- [ ] 8.2 Tier 2 consistency read (`consistency-read` skill) over specs, design, code and tests;
  every finding fixed or escalated.
  Evidence:
- [ ] 8.3 `scripts/check-change.sh --stage hook` green, then `scripts/check-change.sh` (all gates,
  as CI) green with `GITHUB_BASE_REF=main`.
  Evidence:

## 9. Hand-off to the playlist import (proposal "Follow-up")

- [x] 9.1 Test first, `server/src/autogenerate/startService.int.test.ts`: `startAutogenerateJob`
  called without an HTTP request, for a given initiator and a session-id list, creates the same job
  the route would (order, items, `scope` `sessions`), and refuses exactly as the route does when the
  initiator is a member, unapproved, unconfigured, or the team has a live job. Then export it for
  server-side callers. The "autogenerate after import" checkbox is not built here: it lands with
  whichever of `youtube-playlist-import` and this change merges second (proposal "Follow-up").
  Evidence: `npx vitest run --project integration src/autogenerate/startService.int.test.ts` -> `Tests 2 passed (2)` on its first run (ba-9.1-green.log). It passed at once because `startAutogenerateJob` (`server/src/autogenerate/service.ts`, exported) was already built in 5.2 as the route's service and re-runs every start check itself. The checkbox is not built here (proposal "Follow-up")
