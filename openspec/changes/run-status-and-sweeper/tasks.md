# Tasks

**Branch and commits**
- The first commit on `run-status-and-sweeper` holds only `openspec/changes/run-status-and-sweeper/`.
- The PR targets `supabase-migration`.
- The gates run with `GITHUB_BASE_REF=supabase-migration`.

**Logs and test-first**
- Logs live under the session scratchpad as `9c-<task>-<red|green>.log`, and each `Evidence:` line
  names its log.
- Each "test first" item is red before its change, or records why it already passes.
- Each task's text and its `Evidence:` stay in one block with no blank line.

**Commands**
- Targeted tests while working (ADR 0026): `cd server && npx vitest run --project <unit|integration|pg> <files>`.
- Packages: `npx vitest run` in `packages/session-core`, `packages/ai-runtime`, `packages/transcription`, `packages/media-import` and `packages/log-import`; `cd packages/storage && npx vitest run --project <unit|pg> <files>`.
- `cd web && npx vitest run`.
- `npm run typecheck`.
- Migrations: `sh docker/supabase/test_migrate.sh`.
- The full pg/integration suites run in CI on the PR (ADR 0026; owner preference: no local full DB runs). Locally, only the targeted tests being written, plus the unit suites and typecheck.

**Changing tests.** Changing an existing test is allowed only for the categories in design D7.
Anything else is a stop: update the artifacts and ask the owner.

## 1. Baselines

- [x] 1.1 Run the unit suites and typecheck on the base, and record the counts. The DB-suite baseline is the last CI run on `supabase-migration`. List every existing test that D7 categories 1-3 may touch, using `grep -rn "at-capacity\|AT_CAPACITY\|AI_CHAT_MAX_CONCURRENT\|YOUTUBE_IMPORT_MAX_CONCURRENT\|tryAcquire(\|transcriptGenerationLock\|transcript-generation/status\|session_leases" --include=*.test.ts --include=*.test.tsx server/src packages web/src`. Classify each hit by category, or as unchanged. Name the tests category 1 deletes, for the owner. Known flakes (record if they recur): storage "8 contending", `catalogContention.pg` cross-team retry, `aiMcpServer` "Cap holds under concurrent calls", `crossProcess.int` timeout.
  - Evidence: `cd server && npx vitest run --project unit` -> `Tests  326 passed | 3 skipped (329)`; `npx vitest run` in session-core -> `Tests  55 passed (55)`, ai-runtime -> `Tests  194 passed (194)`, transcription -> `Tests  67 passed (67)`, media-import -> `Tests  34 passed | 2 skipped (36)`, log-import -> `Tests  41 passed (41)`; `cd packages/storage && npx vitest run --project unit` -> `Tests  60 passed (60)`; `cd web && npx vitest run` -> `Tests  1692 passed (1692)`; `npm run typecheck` -> exit 0, 0 `error TS` (log `9c-1.1-baseline.log`). DB baseline: the merge runs on `supabase-migration` skip the DB shards (ADR 0026), so the baseline is the last full run, PR #89 CI run 37632042304: server pg+integration `Tests 479 + 372 + 513 passed | 1 skipped` (1364), storage pg `Tests 87 passed (87)`. No known flake recurred.
  - Evidence: the grep matches 32 files (log `9c-1.1-grep.log`). Category 1, to be deleted or rewritten as same-session cases, for the owner:
    - `ai.int.test.ts:735` "409 when the process-wide ceiling is reached";
    - `aiV2.int.test.ts:419`, the same;
    - `events.generate.int.test.ts:461` "7b. process-wide ceiling reached";
    - `sessions.youtubeImport.int.test.ts:426` "409 at-capacity when the GLOBAL ceiling is reached";
    - `youtubeImportGuard.test.ts:50-110`, the whole "global concurrency ceiling" describe (4 cases);
    - `transcribe.int.test.ts:974`, `:1026`, `:1050`, `:1080`, `:1099`, `:1185` (cross-session 409s, rewritten as same-session) and `:1498` (now holder-named);
    - `packages/transcription/src/generateTranscript.inflight.test.ts`;
    - `packages/transcription/src/transcriptGenerationLock.test.ts` (rewritten for per-session runs).
    Category 2: `transcriptGenerationLock` readers in `access.int`, `apiResponseFixtures.int`, `sessionHub.interleave.int`, `transcribe.int`, `generateTranscript.remap.int`, `retry.int`, `isolation.int`, `transcription/src/index.test.ts` and `packageBoundaries.repo.test.ts`; the `AI_CHAT_MAX_CONCURRENT` literals in `upgradeDispatch.test.ts` and `aiV2.int.test.ts:331`. Category 3: `catalogSchema.pg.test.ts` and the `session_leases` row assertions in `leaseStore.int`, `runLease.int`, `leaseRace.int` and `SessionHub.alarm.int`. Unchanged: `eventsGenerateWindow.test.ts` (it scans for the kept `aiChatTurns.tryAcquire(` literal) and the web hits (status shape unchanged).

## 2. `AI_PROVIDER` (design D1)

- [x] 2.1 Test first: `parseAiProvider` (unset or blank gives `claude_cli`, `claude_cli` is accepted, anything else throws with the accepted list), `createBindings` refusing `AI_PROVIDER=openai` before taking the `DATA_DIR` lock. Red, then add the parser, `Config.AI_PROVIDER`, and the check in `createBindings`. Remove `AI_CHAT_MAX_CONCURRENT` and `aiChatMaxConcurrent` from the config port, `env.ts`, `config.ts`, and `server/.env.example`; add `AI_PROVIDER` to `docker/secrets-env.yaml` and mark `AI_CHAT_MAX_CONCURRENT` there as ignored (D1). Config literals in tests change under D7 category 2. Green.
  - Evidence: red, `cd server && npx vitest run --project unit src/env.test.ts src/node/config.test.ts` -> `TypeError: parseAiProvider is not a function`, the refusal case `expected [Function] to throw an error`, `Tests  5 failed | 35 passed (40)` (log `9c-2.1-red.log`); green, `cd server && npx vitest run --project unit` -> `Tests  331 passed | 3 skipped (334)` (326 at 1.1: +5 new cases) (log `9c-2.1-green.log`); `npm run typecheck` -> 0 `error TS`.
  - Evidence: `parseAiProvider` in `env.ts`; `Config.AI_PROVIDER` in the port and `node/config.ts`, checked in `createBindings` right after `FRAME_BUS_SECRET` and before the `DATA_DIR` lock; `aiChatMaxConcurrent` and the `AI_CHAT_MAX_CONCURRENT` config field removed; `server/.env.example` documents `AI_PROVIDER=claude_cli`; `docker/secrets-env.yaml` gains `AI_PROVIDER` and keeps `AI_CHAT_MAX_CONCURRENT`, commented as ignored. Interim: the four AI routes pass the old default `2` to `tryAcquire` until 3.2 deletes it. Existing tests, D7 category 2: the full `Config` literals in `upgradeDispatch.test.ts:41` and `aiV2.int.test.ts:331` swap `AI_CHAT_MAX_CONCURRENT` for `AI_PROVIDER`; `node/config.test.ts` "ruling E6" gains `AI_PROVIDER: 'claude_cli'` in its proxy's base env (the category amended in this task, owner "amend", re-panel no findings).

## 3. No ceilings (design D2)

- [ ] 3.1 Test first: unit tests for `AiChatTurnRegistry` (new file) and `youtubeImportGuard.test.ts`. Three different sessions all acquire, the same session is refused as session-busy, and `release` is idempotent. Red, then drop the global counts, `maxConcurrent`, `at-capacity` and `YOUTUBE_IMPORT_MAX_CONCURRENT`. Green. Existing guard tests change only under D7 categories 1-2.
- [ ] 3.2 Test first: integration cases where four AI requests on four sessions (chat, v2, topics, events) get no at-capacity `409`, and three YouTube imports on three sessions are all admitted. Red, then drop the at-capacity branches and detail strings from `ai.ts`, `aiV2.ts`, `transcribe.ts`, `events.ts`, `sessions.ts` and `_aiSlot.ts`. Green. Delete the category 1 cases named in 1.1.

## 4. `started_at_ms` and the lease reads (design D4, D5)

- [ ] 4.1 Test first, in `catalogSchema.pg.test.ts` (D7 category 3) and the session pg tests: the column exists and is nullable; a run claim sets it; a renewal by the same holder keeps it; a takeover of an expired row resets it; a recording claim leaves it null. Red, then add the migration `20261014000000_session_lease_started_at.sql` and the `claimLeaseUncounted` change. Green, plus `sh docker/supabase/test_migrate.sh`.
- [ ] 4.2 Test first: storage pg tests for `LeaseDirectory`. `earliestLiveRun` orders by `started_at_ms, session_id` and skips expired and null rows. `deleteExpiredRunLeases` deletes only expired rows of the three run kinds (an allow-list; a recording row is untouched) and leaves every session's revision unchanged. `expiredRecordingSessions` respects `limit`. Red, then add the port, the storage implementation on `bindSystem('lease-directory')`, and `Bindings.ports.leases`; add the reason to the `catalogSystem.repo.test.ts` ALLOWLIST (D7 category 4). Green.

## 5. Transcript generation per session and the status (design D3, D5)

- [ ] 5.1 Test first: unit tests for `TranscriptGenerationRuns` (two sessions both acquire, and the same session is refused with its `startedAt`), plus the pg test for the facade `runLeaseStartedAt`. Red, then rewrite the registry and add the facade read. Green.
- [ ] 5.2 Test first: integration cases.
  - Two sessions generate concurrently, and both get `200`.
  - A same-session in-process refusal gives `409` with the holder-named detail and `started_at`.
  - A same-session lease refusal (another process holds it, using the `holdAsAnotherProcess` helper with `started_at_ms` set) gives the holder-named detail with the lease's start time.
  - The same refusal when the row has no `started_at_ms` gives the generic detail.
  - The status names the earliest live run across two apps sharing the database, and is redacted for a non-member.

  Red, then change `generateTranscript.ts` and the status route. Green. Existing transcript and status tests change only under D7 categories 1-2.

## 6. The sweeper (design D6)

- [ ] 6.1 Test first: unit tests for `startLeaseSweeper` with a fake clock and fake ports.
  - It ticks every 60 s.
  - A slow tick blocks overlap.
  - A failing `deleteExpiredRunLeases` warns, and the tick goes on to recording rows.
  - One failing session warns, and the others are still swept.
  - The timer is unref'd.

  Red, then add it, plus the facade `expireStaleLeases`, and wire it into `main.ts` (started after the purge, cleared on shutdown); add `session-lease-sweep` to the ALLOWLIST (D7 category 4). Green.
- [ ] 6.2 Test first: integration cases.
  - With two apps on one database and a Postgres frame bus, an expired recording lease claimed on A, with no alarm armed on B, is freed by a sweeper tick on B.
  - The session revision advances once, and A's socket gets `lease.changed`.
  - Expired run rows are deleted with no revision change.
  - A second tick on A deletes nothing.

  Red, then fix whatever fails. Green.

## 7. Approved users (design D9)

- [ ] 7.1 Test first: unit tests for `runFeatureEmails` and `runFeatureAllowed`.
  - Unset, blank and `","` all give the bootstrap owner alone.
  - A set list adds to the owner, who stays approved.
  - A comma list with blanks and duplicates.
  - Case folding.
  - A non-ASCII token email never matches (strict `=== true`; `'non-ascii'` is truthy).

  Plus the `bootGuard` non-ASCII refusal. Red, then add them, `Config.RUN_FEATURE_EMAILS` (port and `node/config.ts`), the masked boot log (count plus masked forms, next to `main.ts:43`), and the entries in `server/.env.example`, `docker/.env{,.dev,.stage}.example`, `docker/secrets-env.yaml` and `docs/openbao-secrets.md` (optional key, how to grant). Green.
- [ ] 7.2 Test first: integration cases on each of the six routes. A non-approved member gets `403` with the D9 detail, with no fixture CLI invocation and no lease row. An approved user is admitted. An unconfigured feature still gives `503` to a non-approved user. A log-import job by a non-approved creator records the skip line and claims no `transcript-generation` lease. Red, then add `requireRunFeature` to the routes (AI v2: after `guardAiV2Route`, so the answer route stays ungated, with a test that it does) and the creator flag to log-import, and make the D7 category 5 harness change. Green. Existing route tests change only under D7 category 5.

## 8. Docs and verify

- [ ] 8.1 README (panel, re-panel): the approved-users rule and `RUN_FEATURE_EMAILS`; **403** added to the six endpoint-table rows (~885-897: ai/chat, ai/v2/design, topics/generate, events/generate, youtube-import, transcript-words/generate); the endpoint table rows that advertise at-capacity `409`s (~885 events/generate, ~890 topics/generate, ~895 youtube-import), the AI-limit and ceiling paragraphs (~183, 239, 304-305, 372-373, 421, 426, 429, 441, 483-484), the package tree (~721 "Process-wide generation lock", ~741 "process-wide concurrency guard", ~809), the run-lease paragraph (~992) and the env tables. Done when `grep -n "AI_CHAT_MAX_CONCURRENT\|at-capacity\|process-wide concurrency\|Process-wide generation lock" README.md` prints only lines that say the limit is gone, and each of the six endpoint rows names **403**. ADR 0021 §8b/§9 records owner decisions 1–4, and §9's 9c line says what shipped and what was deferred.
- [ ] 8.2 Unit suites, typecheck and `openspec validate --all --strict` locally. The pg/integration suites come from the PR's CI run. Compare the counts with 1.1 and explain every difference.
- [ ] 8.3 Latency (D8): record the status route's median and one sweeper tick's median, with 0 rows and with 50 expired run rows. Recorded only, no stop rule.
- [ ] 8.4 Live check on the dev stack, with a second app process as in 9b 5.3 and the owner's temporary login row:
  - two transcript generations on different sessions both run (or, without `DEEPGRAM_API_KEY`, check the lease rows and the status with seeded rows);
  - the status through B names A's earliest run;
  - an expired run row seeded in the database is gone within 60 s;
  - the dev app boots with `AI_PROVIDER` unset, and refuses `AI_PROVIDER=nope`;
  - the owner's login is admitted to a gated route, and a seeded non-approved login gets the `403`.
- [ ] 8.5 `scripts/check-change.sh` (all gates) and the tier 2 `consistency-read`.
