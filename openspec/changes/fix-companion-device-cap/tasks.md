# Tasks

Tests run as single files locally (`npx vitest run --project pg src/companionDevices.pg.test.ts` in
`packages/storage/`, `npx vitest run --project integration src/routers/companionDevices.int.test.ts`
in `server/`). The full suite runs in CI on the PR.

## 1. Failing tests first

- [ ] 1.1 Add to `companionDevices.pg.test.ts`, on an adapter with `maxTries: 1`: (a) with 9
  devices and another connection holding the user's advisory key, two creates give one `created`
  and one `cap-reached` once it is released; (b) 8 rounds of 14 concurrent creates each give 10
  `created`, 4 `cap-reached` and 10 stored rows. Check: both fail on the current store.

## 2. Fix

- [ ] 2.1 Queue a user's creates per process in `PostgresCompanionDeviceStore.create()`; the
  transaction body is unchanged. Check: 1.1 passes on 5 consecutive runs; the storage suite,
  typecheck and biome pass; the route test passes 5 times.

## 2b. Panel follow-ups

- [ ] 2.2 Bound the queue wait (panel finding 1): test first, with a 200 ms `queueTimeoutMs`
  override, that a create queued behind one held on the lock rejects with `CatalogTxTimeoutError`,
  never inserts, and that a later create still succeeds; and that the default equals the adapter's
  `txTimeoutMs`. Then: the store takes `PostgresCatalogDb`, reads its now-public `txTimeoutMs`,
  rejects a create that has not started its transaction in time with the adapter's own timeout
  error (same HTTP answer as today, no new status) and drops it from the queue. No abort signal is
  available on the store port (noted in proposal).
- [ ] 2.3 Read `created_at_utc` once the create's turn comes (panel finding 2).
- [ ] 2.4 Proposal non-goals state the single-process assumption (panel finding 3).
- [ ] 2.5 Make 1.1(a)'s wait robust on a loaded CI (panel finding 4): wait up to 20 s for the
  first advisory waiter (asserted), then up to 2 s for a second (only the old code has one).
- [ ] 2.6 Re-run the checks after 2.2-2.5.

## 3. Verify

- [ ] 3.1 `scripts/check-change.sh --stage hook` passes (DB tests skip locally).
