# Tasks

**Branch and commits**
- The first commit on `supabase-8a-session-leases` holds only `openspec/changes/session-leases/`, so
  the plan is pinned before code.
- The PR targets `supabase-migration`.
- The gates run with `GITHUB_BASE_REF=supabase-migration`.
- One PR (ADR 0024: no size budget).

**Logs and test-first**
- Keep logs under the session scratchpad as `8a-<task>-<red|green>.log`, and name the log in each
  `Evidence:` line.
- Each "test first" item is red before its change. Record the failure line, then the green run.
- If a new test already passes, record that and why.

**Commands**
- **Server tiers:** `cd server && npx vitest run --project <unit|integration|pg> <files>`.
- **The full suites:**
  - `cd server && npx vitest run --project unit --project integration --project pg`;
  - `npx vitest run` in `packages/session-core` and `packages/storage`;
  - `cd web && npx vitest run`;
  - `npm run typecheck`.
- **Migrations:** `sh docker/supabase/test_migrate.sh`.

**Changing tests.** Changing an existing test is allowed only for the eight categories in design
D6. Any other change is a stop: update the artifacts and ask the owner.

Keep each task's text, and later its `Evidence:`, in one block with no blank line.

## 1. Baselines

- [ ] 1.1 On the base commit, run the full suites and record the counts. Record the existing tests design D6 expects to change: `grep -rn "lease_holder\|lease_seen_ms\|heartbeatLease\|expireIfStale\|LEASE_STALE_MS\|audio_recording_lease_holder_id" --include=*.test.ts --include=*.test.tsx server/src packages web/src`. Known flake: the storage "8 contending" test (deferred); record any recurrence.

## 2. The migration (design D1, A2, A6)

- [ ] 2.1 Test first, in `server/src/test/pg/catalogSchema.pg.test.ts`:
  - `session_leases` in the table lists, key columns and recorded schema;
  - the RLS matrix admits it with one system policy and four user policies;
  - a new describe "the session leases migration":
    - existing `lease_holder`/`lease_seen_ms` meta rows are unchanged;
    - a user binding inserts its own lease; one naming another user fails `42501`; one on an inaccessible show fails `42501`; one with a null holder fails `42501`;
    - the claim upsert against another user's live lease changes 0 rows with no error, and against an expired one replaces the holder;
    - updating the holder to another user fails `42501`;
    - a direct `UPDATE` stealing a live lease succeeds (accepted, D1);
    - deleting another user's lease deletes 0 rows;
    - kind `x` fails `23514`.
  Verify: red, recorded.
- [ ] 2.2 Add `supabase/migrations/20261011000000_session_leases.sql` as design D1 gives it, run as `postgres`. Verify: 2.1 green; the other `pg` files pass apart from D6 category 3 (record each); `sh docker/supabase/test_migrate.sh` passes; the full suites are green.

## 3. The lease store (D2, D3, D4, D5)

- [ ] 3.1 Test first. Rewrite `server/src/test/session/leaseStore.int.test.ts` against `catalog.session_leases` (D6 categories 1 and 4), adding a user-caller option to `boundCore`. It covers:
  - claim on a free lease;
  - the same user and client claim again (refreshed);
  - another client while alive → false, no write, no revision change;
  - same client, another user while alive → false;
  - takeover after expiry;
  - a blank or NUL client id: claim → false, heartbeat → false, release → no-op, nothing bound or stored;
  - heartbeat by the holder → true and re-armed; by another user or client → false; after expiry (not freed) → false;
  - release only by the same user and client;
  - status: alive from `expires_at_ms`, age from `heartbeat_at_ms`, an expired row reports not alive, and the holder id is real only for the holding user (or system/system) and `"another-client"` otherwise;
  - `expireIfStale`: deletes only expired rows, re-arms at the stored minimum, and a second run is a no-op.
  In `server/src/test/session/revision.int.test.ts`, remove the heartbeat from the +1 list (D6 category 2) and add: claim +1, heartbeat 0, refused claim 0, foreign release 0, release +1, expiry +1. Verify: red, recorded.
- [ ] 3.2 Add `SessionCore.heartbeatLeaseUncounted` and `SessionCore.callerUserId`, and rewrite `packages/session-core/src/leaseStore.ts` on the table as D3 and D4 give it, with a `LeaseKind` type and a TTL map. Update `retry.int.test.ts:33-40`, `SessionHub.alarm.int.test.ts:100-110` and `isolation.int.test.ts`'s `TABLES` (D6 categories 1, 5 and 6). Verify: 3.1 green; the full suites are green; `grep -rn "lease_holder\|lease_seen_ms" packages server/src --include=*.ts | grep -v test` prints nothing.

## 4. Cross-process (D5, D6)

- [ ] 4.1 Test first, in a new `server/src/test/session/leaseRace.int.test.ts`: two registries over two adapters with a shared fake time. Cases (a) to (e) are in design D6. Verify: run it on the 3.2 code. Each case is expected green, because the statements decide outcomes on their own. Record each case, and prove the test can fail: temporarily weaken the claim's `WHERE` (for example drop the expiry check) and show case (a) or (b) failing, then restore. Run it three times in a row and record the round counts.

## 5. Routes (D3, D4)

- [ ] 5.1 Test first, in `server/src/test/SessionHub.int.test.ts`, with a second user who has access to the session:
  - B claims → 409;
  - B heartbeats with A's client id → `{ok:false}`;
  - B releases with A's client id → `{ok:true}` and A's status still shows A alive;
  - B's status shows `another-client`;
  - A claims with another client → 409;
  - after A releases, B claims → 200;
  - a whitespace-only and a NUL client id give 409 / `{ok:false}` / `{ok:true}` and never 500;
  - the status field names and types are unchanged.
  Add `GET /api/companion/state` showing `is_recording` true while A holds the lease. Update other status assertions per D6 category 7. Verify: red where the behaviour is new, recorded; then green with no route code change; `apiResponseFixtures.int.test.ts` and `web/src/apiResponseShapes.repo.test.ts` pass unchanged.

## 6. The recorder re-claims (D7)

- [x] 6.1 Test first, in the `AudioRecorder` tests:
  - a heartbeat answering `{ok:false}` during capture sends one re-claim with the same client id, and capture continues;
  - a re-claim answering 409 shows one warning toast; later ticks send claims and no heartbeats; repeated 409s show no second toast;
  - a later successful claim returns to heartbeats (and a new loss warns again);
  - at most one claim or heartbeat is in flight; a tick skips while one is pending;
  - stopping while a re-claim is in flight sends the release only after the claim settles, and the lease ends free;
  - a claim that succeeds after its take stopped is released at once;
  - a successful heartbeat sends no claim.
  Red, then `web/src/pages/index/components/AudioRecorder.tsx`. Verify: green; `cd web && npx vitest run` is green; typecheck and biome are clean.
  - Evidence: red `npx vitest run src/pages/index/components/AudioRecorder` → "Tests  6 failed | 27 passed (33)" (e.g. "expected "vi.fn()" to be called 2 times, but got 1 times"); green → "Tests  36 passed (36)"; `cd web && npx vitest run` → "Test Files  133 passed (133) / Tests  1685 passed (1685)"; `npx tsc --noEmit` exit 0; `npx biome check web/src` → "Checked 333 files … No fixes applied."

## 7. Docs, measurement and checks

- [ ] 7.1 README: hub notes (~90, ~487-490), the revision list (~879), and a lease paragraph (user binding, masked holder id, strict heartbeat and re-claim) next to the row-versions block. ADR 0021: under slice 8, add 8a's owner decisions 1-8, its mechanism, the 8b split, and the slice 9 follow-ups (sweeper, cross-process `lease.changed`, Realtime exposure of `holder_user_id`). Verify: `grep -n "session_leases" README.md docs/decisions/0021-migrate-to-self-hosted-supabase.md` shows both.
- [ ] 7.2 Measure on the dev stack the median claim, heartbeat and status request time, before (base) and after, 500 calls each. Record only; there is no stop rule.
- [ ] 7.3 Live check on the dev stack (owner pass):
  1. Record in one tab.
  2. A second user gets the 409, and their status shows `another-client`.
  3. Stop recording; `catalog.session_leases` is empty.
  4. Restart the app container for more than 40 s mid-take; the recorder re-claims.
  5. `catalog.sessions.revision` does not move on heartbeats.
- [ ] 7.4 Checks:
  - the full suites;
  - `npm run typecheck` and biome;
  - `openspec validate --all --strict`;
  - the tier-2 consistency read;
  - `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook` and `--stage pr`, unless the owner waives it during this change.
