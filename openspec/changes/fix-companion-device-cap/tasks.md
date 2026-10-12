# Tasks

Tests run as single files locally (`npx vitest run --project pg src/companionDevices.pg.test.ts` in
`packages/storage/`, `npx vitest run --project integration src/routers/companionDevices.int.test.ts`
in `server/`). The full suite runs in CI on the PR.

## 1. Failing tests first

- [x] 1.1 Add to `companionDevices.pg.test.ts`, on an adapter with `maxTries: 1`: (a) with 9
  devices and another connection holding the user's advisory key, two creates give one `created`
  and one `cap-reached` once it is released; (b) 8 rounds of 14 concurrent creates each give 10
  `created`, 4 `cap-reached` and 10 stored rows. Check: both fail on the current store.
  Evidence: in `packages/storage/`, `npx vitest run --project pg src/companionDevices.pg.test.ts` on the current store, 3 consecutive runs -> `× a user's creates in this process never count a stale snapshot (no serialization retry)`, `× rounds of 14 concurrent creates leave exactly 10 devices, with no serialization retry`, `PostgresError: could not serialize access due to read/write dependencies among transactions`, `Tests 2 failed | 9 passed (11)`. A throwaway probe (30 rounds of 14 creates, default retries) counted 665 `40001`s for 420 creates, every round still storing 10.

## 2. Fix

- [x] 2.1 Queue a user's creates per process in `PostgresCompanionDeviceStore.create()`; the
  transaction body is unchanged. Check: 1.1 passes on 5 consecutive runs; the storage suite,
  typecheck and biome pass; the route test passes 5 times.
  Evidence: `npx vitest run --project pg src/companionDevices.pg.test.ts` -> `Tests 11 passed (11)` x5; `npx vitest run` in `packages/storage/` -> `Test Files 11 passed (11)`, `Tests 193 passed (193)`; `npm run typecheck` (storage) rc=0; `npx biome check --error-on-warnings` on both files -> `Checked 2 files ... No fixes applied.`; in `server/`, `npx vitest run --project integration src/routers/companionDevices.int.test.ts` -> `Tests 15 passed (15)` x5. The probe after the fix (with two other users creating concurrently): 119 `40001`s (all cross-user) instead of 1 736.

## 2b. Panel follow-ups

- [x] 2.2 Bound the queue wait (panel finding 1): test first, with a 200 ms `queueTimeoutMs`
  override, that a create queued behind one held on the lock rejects with `CatalogTxTimeoutError`,
  never inserts, and that a later create still succeeds; and that the default equals the adapter's
  `txTimeoutMs`. Then: the store takes `PostgresCatalogDb`, reads its now-public `txTimeoutMs`,
  rejects a create that has not started its transaction in time with the adapter's own timeout
  error (same HTTP answer as today, no new status) and drops it from the queue. No abort signal is
  available on the store port (noted in proposal).
  Evidence: on the store before 2.2, `npx vitest run --project pg src/companionDevices.pg.test.ts` -> `× a create queued past the timeout fails like a transaction timeout and never inserts 20115ms` (the queued create ran after the first one's 10 s transaction timeout and itself timed out), `× the queue timeout defaults to the adapter transaction timeout` (`expected undefined to be 10000`), `Tests 2 failed | 11 passed (13)`. After: `Tests 13 passed (13)`.
- [x] 2.3 Read `created_at_utc` once the create's turn comes (panel finding 2).
  Evidence: `insertCapped` reads `iso(this.clock.now())` before `tx()`; existing created-at assertions pass (`Tests 13 passed (13)`). Green only at this step; the red test is 2.10.
- [x] 2.4 Proposal non-goals state the single-process assumption (panel finding 3).
  Evidence: proposal.md Non-goals, first bullet.
- [x] 2.5 Make 1.1(a)'s wait robust on a loaded CI (panel finding 4): wait up to 20 s for the
  first advisory waiter (asserted), then up to 2 s for a second (only the old code has one).
  Evidence: `waitFor` helper in `companionDevices.pg.test.ts`; the pg file -> `Tests 13 passed (13)` x5.
- [x] 2.6 Re-run the checks after 2.2-2.5.
  Evidence: `npx vitest run --project pg src/companionDevices.pg.test.ts` -> `Tests 13 passed (13)` x5; `npx vitest run` in `packages/storage/` -> `Test Files 11 passed (11)`, `Tests 195 passed (195)`; in `server/`, `npx vitest run --project integration src/routers/companionDevices.int.test.ts` -> `Tests 15 passed (15)` x5; `npm run typecheck -w server` and `-w packages/storage` rc=0; `npx biome check --error-on-warnings` on `companionDevices.ts` and `companionDevices.pg.test.ts` -> `No fixes applied` (`postgresCatalogStore.ts` already has 3 biome format errors on the base, unchanged by the one-line edit).

## 2c. Panel follow-ups (reviewers 2 and 3)

- [x] 2.7 A create whose turn throws (reviewers' finding 1): test first that with a clock that
  throws once, that create rejects within 2 s, the user's next create succeeds, the store's queue
  map is empty afterwards and no unhandled rejection is reported (vitest fails the run on one).
  Then: the turn runs `insertCapped` through `Promise.resolve().then(...)` so any throw settles
  the caller, and both the chain and the cleanup use `.then(cb, cb)`, so no tail ever rejects.
  Evidence: before the fix, `npx vitest run --project pg src/companionDevices.pg.test.ts` -> `× a create whose clock read throws rejects, and the queue and later creates are unaffected 2079ms`, `expected 'never settled' to be 'rejected: clock failed'`, `Unhandled Rejection Error: clock failed`, `Tests 1 failed | 14 passed (15)`, `Errors 1 error`. After: `Tests 15 passed (15)`, no errors.
- [x] 2.8 Robust timing of 1.1(a) (reviewers' finding 2): that test's adapter gets
  `txTimeoutMs: 120_000`, so X's transaction outlasts the 20 s + 2 s waits; comment updated.
  Evidence: the pg file -> `Tests 15 passed (15)` x5 (2.11).
- [x] 2.9 Route-level reproduction (reviewers' finding 3): in `companionDevices.int.test.ts`, 14
  concurrent `POST /api/companion-devices` through a store on an adapter with `maxTries: 1`
  (`envWith` port override) give ten 201s and four 409s.
  Evidence: on the base store (`git show HEAD:packages/storage/src/companionDevices.ts`), `npx vitest run --project integration src/routers/companionDevices.int.test.ts -t "maxTries 1"` -> `× 14 concurrent creates give ten 201s and four 409s on an adapter with maxTries 1`, `expected [ 201, 201, 201, 500, 500, 500, …(8) ]` (3 x 201, 11 x 500), `Tests 1 failed | 15 skipped (16)`, 4 of 4 runs. With the fix: `Tests 16 passed (16)` x5.
- [x] 2.10 A red test for 2.3 (reviewers' finding 4): with the first create held on the lock, the
  fake clock advanced an hour while the second is queued, the second's `created_at_utc` is the
  advanced time and the first's the start time.
  Evidence: on the base store -> `× a queued create's created_at_utc is read when its turn comes`, `Expected: "2026-10-08T13:00:00.000Z" Received: "2026-10-08T12:00:00.000Z"`, `Tests 1 failed | 14 skipped (15)`. With the fix: passes (2.11).
- [x] 2.11 Re-run the checks after 2.7-2.10.
  Evidence: `npx vitest run --project pg src/companionDevices.pg.test.ts` -> `Tests 15 passed (15)` x5; in `server/`, `npx vitest run --project integration src/routers/companionDevices.int.test.ts` -> `Tests 16 passed (16)` x5; `npx vitest run` in `packages/storage/` -> `Test Files 11 passed (11)`, `Tests 197 passed (197)`; `npm run typecheck -w server` and `-w packages/storage` -> 0 errors; `npx biome check --error-on-warnings` on `companionDevices.ts`, `companionDevices.pg.test.ts`, `companionDevices.int.test.ts` -> `No fixes applied`.

## 3. Verify

- [x] 3.1 `scripts/check-change.sh --stage hook` passes (DB tests skip locally).
  Evidence: `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook` -> all PASS (`change tier 2`, `risk-floor 0 high-risk path(s)`, `evidence`, `commands ran ['typecheck', 'test'] (pg/integration skipped: local run ...)`); `npx openspec validate --all --strict` -> `28 passed, 0 failed`; `npm run typecheck -w server` rc=0. Without `GITHUB_BASE_REF` the `change` check counts the base's archived changes (expected).
