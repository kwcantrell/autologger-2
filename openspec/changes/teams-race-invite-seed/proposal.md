# Teams race invite seed: seed the invite-cap race's 199 pending invites in one statement

Tier: 2
Tier reason: forced by the path rule only. The edit is one test's setup in
`server/src/routers/teams.race.int.test.ts`, and `server/src/routers/**` is a
`lifecycle.high_risk_paths` entry (`scripts/lib/check_change.py` `check_risk_floor`). No production
code, contract, spec or behaviour changes.

Approved-by: Kalen 2026-10-05

## Why

"invite cap (#10) › two invites for new emails at 199 pending: one recorded, one 400" times out at
vitest's 5 s default in every full `npm test` run on `supabase-migration` (three of three on
2026-10-05), and passes alone. Alone it takes 2,364 ms, almost all of it the setup loop at
`teams.race.int.test.ts:388-390`: 199 sequential `authUpsertInvite` calls, each its own
`SERIALIZABLE` catalog transaction. Under full-suite load the loop crosses 5 s. The pre-push hook
runs the full suite, so this blocks every push from a migration slice branch, 7c-1 included. The
owner chose this fix on 2026-10-05.

## What Changes

- The loop is replaced by one `INSERT … SELECT … FROM generate_series(0, 198)` through the existing
  `testDb()` helper (`server/src/test/helpers.ts:14`, a `catalog_system` binding). It stores the
  same 199 rows the loop stored: emails `p0@example.com` to `p198@example.com`, invited by the team
  owner, with `invited_at_utc` from `nowIso()` (`@autologger/domain`), the columns
  `authUpsertInvite` writes (`packages/catalog/src/authStore.ts:507-519`).
- The race under test is unchanged: request A held after its pending-invite read, B committed, A
  released; one `200`, one `400`, and 200 invites stored.

## Alternatives considered (owner, 2026-10-05)

- **A per-test timeout** (`}, 30_000);`), the repo's precedent for this symptom
  (`server/src/routers/sessionHub.interleave.int.test.ts:292-294`; also `bootOrder.int.test.ts`,
  `access.int.test.ts:116`, `crossProcess.int.test.ts:41`). Rejected by the owner: it leaves the
  2.3 s of sequential `SERIALIZABLE` writes on the shared database under full-suite load, where it
  slows its neighbours, instead of removing it.
- **Seeding through the store method**, the convention in `server/src/test/helpers.ts:24-25`
  ("seed helpers … call the real store methods"). This departs from it: the statement copies
  `authUpsertInvite`'s four columns. Accepted because the cap check reads only the row set
  (`teams.ts:251-253`), `team_invites` has no defaults, triggers or other columns, and this file
  already seeds with raw `testDb().run` inserts (`teams.race.int.test.ts:255-265, 330, 369`). If
  `authUpsertInvite`'s row shape changes, this seed must change with it.

## Non-goals

- Raising any timeout, here or globally (see above).
- Changing any other test, the invite cap, `authUpsertInvite` or any production code.
- Profiling the full suite's general slowness under load.

## Impact

- **Code:** `server/src/routers/teams.race.int.test.ts` only (the setup of one test, and its
  `@autologger/domain` import gains `nowIso`).
- **Specs:** none (`skip_specs: true`).
- **Contract, operators, performance:** none; the test runs faster.
