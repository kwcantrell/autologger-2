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

- [ ] 2.1 Test first, in `server/src/test/pg/catalogSchema.pg.test.ts`:
  - the kind-check snapshot admits the four kinds (D6 category 4);
  - a new describe "the session run leases migration (session-run-leases D1)" checks that:
    - a `catalog_user` inserts `ai-turn`, `transcript-generation` and `youtube-import` rows naming
      itself, beside a `recording` row of the same session;
    - kind `x` still fails with `23514`;
    - a `recording` row present before the migration is unchanged after it.

  Red, then add `supabase/migrations/20261012000000_session_run_leases.sql`. Green, plus `sh docker/supabase/test_migrate.sh`.

## 3. Silent run leases in the store (design D2)

- [ ] 3.1 Test first, in `server/src/test/session/runLease.int.test.ts`, covering every D6 store case:
  - claim, re-claim and release of each run kind, with the revision unchanged, no `lease.changed`
    and no alarm armed;
  - a claim refused while another holder's lease is live, and a takeover after expiry;
  - the holder re-taking its own lapsed row (fake clock);
  - a former holder's release leaving the new row;
  - blank and NUL holder ids;
  - `expireIfStale` freeing only recording rows and re-arming only from recording expiries;
  - `leaseStatus` ignoring run rows.

  Red, then implement `LeaseKind`/`RunLeaseKind`/TTL, the raw-handle `SessionCore` helpers, `claimRunLease`/`releaseRunLease`, the narrowed `expireIfStale`, and the facade methods. Green. Then run every existing `server/src/test/session/*` lease test, unchanged or changed only under D6 category 2.
- [ ] 3.2 Test first, in `leaseRace.int.test.ts`:
  - (f) 200 rounds of two processes claiming `ai-turn` for different users: one winner per round,
    revision unchanged;
  - (g) a dead process's `youtube-import` lease taken over through process B after expiry, replacing
    the row.

  Then weaken the run claim's `WHERE` on purpose (locally, not committed), record that (f) fails, and restore it.

## 4. The lease-hold helper (design D3)

- [ ] 4.1 Test first, `holdRunLease`:
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
