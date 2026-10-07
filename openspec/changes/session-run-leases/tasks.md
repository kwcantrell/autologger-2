# Tasks

**Branch and commits**
- The first commit on `session-leases-auto` holds only `openspec/changes/session-run-leases/`, so the
  plan is pinned before code.
- The PR targets `supabase-migration`.
- The gates run with `GITHUB_BASE_REF=supabase-migration`.
- One PR (ADR 0024: no size budget).

**Logs and test-first**
- Keep logs under the session scratchpad as `8b-<task>-<red|green>.log`, and name the log in each
  `Evidence:` line.
- Each "test first" item is red before its change. Record the failure line, then the green run.
- If a new test already passes, record that and why.

**Commands**
- **Server tiers:** `cd server && npx vitest run --project <unit|integration|pg> <files>`.
- **The full suites:**
  - `cd server && npx vitest run --project unit --project integration --project pg`;
  - `npx vitest run` in `packages/session-core`, `packages/ai-runtime`, `packages/transcription`,
    `packages/media-import` and `packages/storage`;
  - `cd web && npx vitest run`;
  - `npm run typecheck`.
- **Migrations:** `sh docker/supabase/test_migrate.sh`.

**Changing tests.** Changing an existing test is allowed only for the two categories in design D6.
Any other change is a stop: update the artifacts and ask the owner.

Keep each task's text, and later its `Evidence:`, in one block with no blank line.

## 1. Baselines

- [ ] 1.1 On the base commit, run the full suites and record the counts. Record the existing tests D6 expects to change: `grep -rn "aiChatTurns\|youtubeImportGuard\|transcriptGenerationLock\|expireIfStale\|session_leases_kind_check" --include=*.test.ts server/src packages`. Classify each hit by D6 category, or as unchanged (the registries are unchanged, so most hits are unchanged). Known flakes (storage "8 contending", `catalogContention.pg` cross-team retry, `aiMcpServer` "Cap holds under concurrent calls"): record any recurrence.
  - Evidence: base code 07acaaf8 (HEAD 9a24e769 = artifacts only). Full suites -> server `Test Files  129 passed | 3 skipped (132)`, `Tests  1595 passed | 4 skipped (1599)` (log `8b-1.1-server.log`); session-core `Tests  33 passed (33)`, ai-runtime `Tests  181 passed (181)`, transcription `Tests  67 passed (67)`, media-import `Tests  34 passed | 2 skipped (36)` (logs `8b-1.1-<package>.log`); storage first `Tests  1 failed | 132 passed (133)`: the deferred "8 contending" test (`expected [ 'repetition 3: 1/8 exhausted' ] to deeply equal []`; recurrence recorded, log `8b-1.1-storage.log`), rerun `Tests  133 passed (133)` (log `8b-1.1-storage2.log`); no `catalogContention` or `aiMcpServer` recurrence; web `Test Files  133 passed (133)`, `Tests  1689 passed (1689)` (log `8b-1.1-web.log`); `npm run typecheck` exit 0 (log `8b-1.1-typecheck.log`). The grep (log `8b-1.1-grep.log`) prints 137 lines in 21 files. Expected to change per D6: `server/src/test/pg/catalogSchema.pg.test.ts:409` (the kind-check snapshot; cat. 1). D6 cat. 2: none; the `expireIfStale` hits (`leaseStore.int.test.ts:226-251`, `revision.int.test.ts:236`, `session/SessionHub.int.test.ts:121,240`) use recording rows only, so they hold unchanged under the narrowed delete. Expected unchanged (registry calls, unchanged per D5): `packages/media-import/src/{index,youtubeImportGuard}.test.ts`, `packages/transcription/src/{generateTranscript.inflight,index,transcriptGenerationLock}.test.ts`, `server/src/packageBoundaries.repo.test.ts`, `server/src/routers/{access,ai,aiV2,apiResponseFixtures,events.generate,sessionHub.interleave,sessions.youtubeImport,transcribe}.int.test.ts`, `eventsGenerateWindow.test.ts`, `session/{anchorRolling,generateTranscript.remap}.int.test.ts`.
- [ ] 1.2 Record the base latency of the guarded request path: there is none to measure separately, because the in-process acquire is a `Set` check. Record that statement and the 8a lease medians (claim 12.0 ms, heartbeat 11.1 ms) as the reference for 7.2. There is no stop rule; latency is recorded only during the migration.
  - Evidence: recorded, no command: today's guarded path adds no I/O before the guard (`aiChatTurns.tryAcquire`, `youtubeImportGuard.tryAcquire` and `transcriptGenerationLock.tryAcquire` are synchronous `Set`/field checks), so there is no separate base latency to measure. Reference for 7.2: the 8a lease medians, claim 12.0 ms and heartbeat 11.1 ms (archive `2026-10-06-session-leases/tasks.md` 7.2: after-medians 11976.8 us and 11129.5 us).

## 2. The migration (design D1)

- [x] 2.1 Test first, in `server/src/test/pg/catalogSchema.pg.test.ts`:
  - the kind-check snapshot admits the four kinds (D6 category 4);
  - a new describe "the session run leases migration (session-run-leases D1)" checks that:
    - a `catalog_user` inserts `ai-turn`, `transcript-generation` and `youtube-import` rows naming
      itself, beside a `recording` row of the same session;
    - kind `x` still fails with `23514`;
    - a `recording` row present before the migration is unchanged after it.

  Red, then add `supabase/migrations/20261012000000_session_run_leases.sql`. Green, plus `sh docker/supabase/test_migrate.sh`.
  - Evidence: `server/src/test/pg/catalogSchema.pg.test.ts`: the kind-check snapshot line now `CHECK ((kind = ANY (ARRAY['recording'::text, 'ai-turn'::text, 'transcript-generation'::text, 'youtube-import'::text])))` (D6 category 1; the task's "category 4" means D6's category 1, the snapshot line), and the describe "the session run leases migration (session-run-leases D1)" (replay to `20261011000000`, a `recording` row, then the migration: rows equal before and after; `owner` as catalog_user inserts `recording`, `ai-turn`, `transcript-generation`, `youtube-import` on `ss1` -> `count 1` each, select `count 4`; kind `x` -> `23514`). `cd server && npx vitest run --project pg src/test/pg/catalogSchema.pg.test.ts` -> `Tests  3 failed | 22 passed (25)`: `matches the recorded catalog schema` (`expected { …(24) } to deeply equal { …(24) }`), `ENOENT: … 20261012000000_session_run_leases.sql`, `expected [ { count: 1 }, { code: '23514' } ] to deeply equal [ { count: 1 }, { count: 1 }, …(3) ]` (log `8b-2.1-red.log`). Added `supabase/migrations/20261012000000_session_run_leases.sql` (D1: drop and re-add the named check) -> `Tests  25 passed (25)` (log `8b-2.1-green.log`); whole pg project `Test Files  11 passed | 1 skipped (12)`, `Tests  105 passed | 1 skipped (106)` (log `8b-2.1-pg.log`); `sh docker/supabase/test_migrate.sh` -> `test_migrate: 35 passed, 0 failed` (log `8b-2.1-migrate.log`).

## 3. Silent run leases in the store (design D2)

- [x] 3.1 Test first, in `server/src/test/session/runLease.int.test.ts`, covering every D6 store case:
  - claim, re-claim and release of each run kind, with the revision unchanged, no `lease.changed`
    and no alarm armed;
  - a claim refused while another holder's lease is live, and a takeover after expiry;
  - the holder re-taking its own lapsed row (fake clock);
  - a former holder's release leaving the new row;
  - blank and NUL holder ids;
  - `expireIfStale` freeing only recording rows and re-arming only from recording expiries;
  - `leaseStatus` ignoring run rows.

  Red, then implement `LeaseKind`/`RunLeaseKind`/TTL, the raw-handle `SessionCore` helpers, `claimRunLease`/`releaseRunLease`, the narrowed `expireIfStale`, and the facade methods. Green. Then run every existing `server/src/test/session/*` lease test, unchanged or changed only under D6 category 2.
  - Evidence: `server/src/test/session/runLease.int.test.ts` (11 cases on the bound-core harness plus one through a registry hub: the per-kind TTL map; claim, re-claim and release of each kind with revision unchanged, no frame, no alarm; refused for another run id of the same user, the same run id of another user and another user's run while live, another kind independent, takeover at expiry; the holder re-taking its own lapsed row; a former holder's release leaving the new row; blank/NUL ids; `expireIfStale` leaving expired and live run rows, re-arming at the recording expiry not the earlier run expiry, then freeing only the recording row with one frame and revision +1; `leaseStatus` ignoring run rows; the facade `claimRunLease`/`releaseRunLease` as a user, silent). `cd server && npx vitest run --project integration src/test/session/runLease.int.test.ts` -> `Tests  11 failed (11)`: `TypeError: s.lease.claimRunLease is not a function`, `TypeError: va.claimRunLease is not a function`, `expected { recording: 40000 } to deeply equal { recording: 40000, …(3) }`, `expected [ { kind: 'youtube-import', …(4) } ] to deeply equal [ { kind: 'ai-turn', …(4) }, …(1) ]` (log `8b-3.1-red.log`). Implemented `RunLeaseKind`, `LeaseKind = 'recording' | RunLeaseKind`, `RUN_LEASE_RENEW_MS`, `TTL_MS` 40 000 per run kind, `LeaseStore.claimRunLease`/`releaseRunLease`, `SessionCore.claimLeaseUncounted`/`releaseLeaseUncounted` (raw handle), `expireIfStale` narrowed to `kind = 'recording'` (delete and re-arm), facade `claimRunLease`/`releaseRunLease` (`inTxn`) -> `Tests  11 passed (11)` (log `8b-3.1-green.log`). Every existing session test unchanged (no D6 category 2 change was needed): `npx vitest run --project integration src/test/session/` -> `Test Files  34 passed (34)`, `Tests  335 passed (335)` (log `8b-3.1-session.log`); `packageBoundaries.repo.test.ts` `Tests  84 passed (84)` (log `8b-3.1-boundaries.log`); `npm run typecheck` exit 0 (log `8b-3.1-typecheck.log`).
- [x] 3.2 Test first, in `leaseRace.int.test.ts`:
  - (f) 200 rounds of two processes claiming `ai-turn` for different users: one winner per round,
    revision unchanged;
  - (g) a dead process's `youtube-import` lease taken over through process B after expiry, replacing
    the row.

  Then weaken the run claim's `WHERE` on purpose (locally, not committed), record that (f) fails, and restore it.
  - Evidence: `server/src/test/session/leaseRace.int.test.ts` gains the describe "run leases across two processes (session-run-leases D2, D6)": (f) 200 rounds through two registries over two adapters, a fresh run id per round, alternating send order, the winner releasing (one winner per round, row held by the winner, revision unchanged over all rounds, table empty at the end); (g) process one claims `youtube-import` and closes, process B is refused at `TTL - 1` and then replaces the row 41 s after the claim (`holder_client_id: 'srv:two:1'`, B as holder, expiry `T + 41 s + 40 s`), revision unchanged. Green first, because 3.1 already implemented the raw-handle claim: `npx vitest run --project integration src/test/session/leaseRace.int.test.ts -t "run leases across"` -> `Tests  2 passed | 5 skipped (7)` (log `8b-3.2-first.log`). Can fail: the run claim's WHERE weakened to `(session_leases.expires_at_ms <= ? OR true)` in `SessionCore.claimLeaseUncounted` -> `Tests  2 failed | 5 skipped (7)`, (f) `AssertionError: expected [ 'round 0: a=true b=true', …(199) ] to deeply equal []`, (g) `expected true to be false` (log `8b-3.2-mutation.log`); restored, `git diff packages/session-core/src/sessionCore.ts` empty. Whole file 3 consecutive runs each `Tests  7 passed (7)` (logs `8b-3.2-run1..3.log`; run 1: a won 105, b won 95); verbose (f) 7374 ms, (g) 417 ms (log `8b-3.2-verbose.log`).

## 4. The lease-hold helper (design D3)

- [x] 4.1 Test first, `holdRunLease`:
  - 180 s under the fake clock and fake timers: 18 renewals, alive throughout, and a competing claim
    refused throughout;
  - a refusal logs once and stops;
  - an error is retried, and a renewal after more than 40 s of errors re-takes the row;
  - no overlapping ticks;
  - `release()` is memoized, never rejects, and awaits a pending tick;
  - a refused claim gives `null` with no timer;
  - an evicted hub is re-resolved on the next tick;
  - `newRunHolderId()` starts with `srv:<SERVER_BOOT_ID>:` and is unique across 1000 calls.

  Red, then implement `packages/session-core/src/runLease.ts` and export it. Green.
  - Evidence: stub-hub cases in `packages/session-core/src/runLease.test.ts` (8: renew every `renewMs` as one holder until release, no timer after; refused claim `null` with no timer; a throwing claim or `getHub` propagates with no timer; a refused renewal logs `run lease lost: …` once and stops; errors (claim and `getHub`) logged and retried; no overlapping ticks; `release()` memoized, awaits the pending tick, resolves when the release or `getHub` throws, logged; `newRunHolderId()` = `srv:<SERVER_BOOT_ID>:<uuid>`, 1000 unique) and Postgres cases in `server/src/test/session/runLease.int.test.ts` "holdRunLease on Postgres (session-run-leases D3)" (4: 180 s under the registry clock and driver-safe fake timers: 19 claims (claim + 18 renewals), alive after every tick, a competing holder refused at every tick, one holder id, row expiry `T + 220 s`; 50 s of failed renewals, row lapsed, then a renewal re-takes it; another holder takes the expired row, the renewal is refused, logged once, no more ticks, release leaves the new holder's row; an evicted hub re-resolved on the next tick, new entry, row renewed). Red: `cd packages/session-core && npx vitest run src/runLease.test.ts` -> `Error: Cannot find module './runLease'`, `Tests  no tests` (log `8b-4.1-red-unit.log`); `cd server && npx vitest run --project integration src/test/session/runLease.int.test.ts` -> `Error: Cannot find package '@autologger/session-core/runLease'`, `Test Files  1 failed (1)` (log `8b-4.1-red-int.log`). Implemented `packages/session-core/src/runLease.ts` (`SERVER_BOOT_ID`, `newRunHolderId`, `RunLeaseHold`, `holdRunLease`; adds an optional `sessionId` that only labels the log lines, since the facade carries no session id) and `export * from './runLease'` in `index.ts`. Green: unit `Tests  8 passed (8)` (log `8b-4.1-green-unit.log`); integration first `Tests  1 failed | 14 passed (15)`: the eviction case's wait loop (10 000 `setImmediate` turns) ran out before the re-opened hub's claim (`waited for claim 2, have 1`), a test-harness wait, so the wait became 10 s of real time (`performance.now()`, not faked) -> `Tests  15 passed (15)` (log `8b-4.1-green-int.log`), then 3 consecutive runs each `Tests  15 passed (15)` (logs `8b-4.1-int-run1..3.log`). After `biome check --write` (format only): runLease, leaseRace and leaseStore integration `Tests  34 passed (34)` (log `8b-4.1-green-int2.log`); session-core `Tests  41 passed (41)` (log `8b-4.1-session-core.log`); `packageBoundaries.repo.test.ts` `Tests  84 passed (84)` (log `8b-4.1-boundaries.log`); `npm run typecheck` exit 0 (log `8b-4.1-typecheck.log`).

## 5. Guards on leases (design D4, D5)

- [ ] 5.1 AI turn. Test first, in `ai.int.test.ts`, `aiV2.int.test.ts`, `transcribe.int.test.ts` (topics) and `events.generate.int.test.ts`:
  - another holder's live `ai-turn` lease gives each route's session-busy `409` detail, with no
    spawn and the process slot free afterwards;
  - the lease row is gone when the response completes, after success, error and abort;
  - an immediate second request on the same session is not `409`;
  - a claim that throws leaves the process slot free;
  - `eventsGenerateWindow.test.ts` passes unchanged.

  Red, then add `server/src/routers/_aiSlot.ts` and switch the four routes (D4). Green.
- [ ] 5.2 YouTube import. Test first, in `sessions.youtubeImport.int.test.ts`:
  - another holder's live `youtube-import` lease gives `YOUTUBE_IMPORT_SESSION_BUSY_DETAIL`, with
    no spawn and the guard free afterwards;
  - the same holder's lease after expiry lets the import run;
  - the lease is gone when the response completes, after success and failure;
  - back-to-back imports are not `409`;
  - a claim that throws leaves the guard free.

  Red, then switch `sessions.ts`. Green.
- [ ] 5.3 Transcript generation. Test first, in `transcribe.int.test.ts`:
  - another holder's live `transcript-generation` lease gives the generic in-flight detail, with no
    provider call and the process lock free afterwards;
  - in-process busy keeps the holder/`started_at` detail;
  - the lease is gone after success, error and pre-provider abort, released after the replace
    commits and before the lock;
  - a claim whose `getHub` rejects leaves the lock free, and the next generate succeeds;
  - back-to-back generations are not `409`;
  - a log-import run claims as the job's creator.

  Red, then change `generateTranscriptWords`. Green, with the `packages/transcription` tests.
- [ ] 5.4 The revision contract scenario, in `ai.int.test.ts`: status, then an AI chat turn that calls no write tool (with the existing fake CLI and `renewMs` shortened so that at least one renewal happens), then status; the revision is unchanged. Test first. It may already pass after 5.1; if so, record that and why.

## 6. Docs

- [ ] 6.1 README: the `aiChatTurns`, `transcriptGenerationLock` and `youtubeImportGuard` paragraphs and the leases section name the run kinds, the 10 s/40 s renewal, the per-process ceilings, and the up-to-40 s restart window. ADR 0021: an 8b entry. Rollback note (design Rollback) under the ADR entry.

## 7. Verify

- [ ] 7.1 Full suites (as 1.1), `npm run typecheck`, `openspec validate --all --strict`. Compare counts with 1.1 and explain every difference.
- [ ] 7.2 Latency: a one-off bench (run locally, not committed) of 200 `claimRunLease` + `releaseRunLease` pairs and 200 same-holder re-claims (renewals) through a hub on the dev database. Record the medians beside the 1.2 reference.
- [ ] 7.3 Live check on the dev stack:
  1. Start an AI chat turn, then a topic generation request on the same session, which gives `409`
     session-busy.
  2. During the turn, `select kind, holder_client_id, holder_user_id, expires_at_ms from
     catalog.session_leases` shows the `ai-turn` row renewing.
  3. After the turn, the row is gone.
  4. `docker restart` the app mid-turn, then retry: `409` until about 40 s, then it runs.
  5. A transcript generation and a YouTube import each leave no row afterwards.

  The owner does the browser-side check.
- [ ] 7.4 `scripts/check-change.sh` (all gates) and the tier 2 `consistency-read`, then fix findings.
