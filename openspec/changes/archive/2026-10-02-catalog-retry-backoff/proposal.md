# Catalog transactions back off before retrying a serialization failure

Tier: 2
Tier reason: concurrency and retry behavior of the catalog adapter's SERIALIZABLE transactions; changes an owner decision from slice 4 (at most 3 runs).

Approved-by: Kalen 2026-10-02

## Why

The Postgres catalog adapter re-runs a transaction body right away after a serialization failure
(`40001`) or deadlock (`40P01`), at most three runs in total. Contending transactions therefore
re-run in lockstep and conflict again. When the retries run out, the caller gets a 500.

Slice 5b (`require-login`) moves every integration test onto the signed-in path. There, the
existing test "concurrent same-clock creates for the same show never duplicate a title"
(`sessions.int`) failed with a `40001` 500 in 3 of about 9 full-suite runs. With only two
concurrent creates it passed 6 of 6 times when run alone. ADR 0021 already lists this hazard
under "Revisit after the migration". 5b would make CI flaky, and the same 500 reaches real users.

A probe measured exhausted transactions out of all transactions. Each trial ran N concurrent
read-modify-write transactions on one row, each body making four statements, 30 trials each,
against the pinned Postgres:

| Backoff | Max runs | N = 5 | N = 8 |
|---|---|---|---|
| none (today) | 3 | 60/150 | 115/240 |
| none | 5 | 0/150 | 59/240 |
| full jitter, 20 ms doubling | 3 | 5/150 | 11/240 |
| full jitter, 20 ms doubling | 5 | 0/150 | 0/240 |

The owner chose jitter with 5 runs (2026-10-02).

## What Changes

- Before re-running a transaction body after a serialization failure or deadlock, the adapter
  waits a random delay in `[0, 20 × 2^(n−1))` ms, where `n` is the number of runs so far. This is
  "full jitter". The wait holds no connection and never extends past the transaction's deadline.
  If the deadline has passed when a re-run would start, the caller gets the timeout error at once,
  with no statement sent and no connection taken.
- At most **five** runs in total, up from three. The added wait is at most 20 + 40 + 80 + 160 =
  300 ms, inside the existing 10 s transaction deadline.
- Nothing else changes: which errors are retried, the deadline, commit-unknown handling and
  connection handling all stay as they are.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `core-ports-architecture`: "The Postgres catalog adapter". Retries wait a jittered backoff
  and allow five runs. "Retries are bounded and selective" now says five runs, and a new
  scenario covers eight contending writers all committing.

## Non-goals

- `503` with `Retry-After` for exhausted retries, which is still on the ADR revisit list.
- Retrying at the HTTP layer, or changing any transaction body.
- Changing the deadline (10 s), the root-statement deadline, or the pool and slot sizes.
- Slice 5b's test changes; 5b rebases onto this.

## Impact

- **Code:** `packages/storage/src/postgresCatalogStore.ts` (the retry loop and a `maxTries`
  default of 5), plus tests in `postgresCatalogStore.test.ts` and `postgresCatalogStore.pg.test.ts`.
- **Docs:**
  - ADR 0021: the slice 4 entry ("at most 3 tries" becomes 5 with backoff), hazard 20, and the
    two retry-exhaustion revisit items;
  - `docs/supabase.md` "Catalog time limits";
  - the port contract comment in `packages/ports/src/catalogDb.ts:13` ("at most three runs").
- **No HTTP contract change.** Fewer requests end in 500, and a contended write can take up to
  about 300 ms longer.
- **Size:** about 50 counted lines.

## Risks

- **A deliberate flood.** Raising the cap from 3 to 5 runs means a contended request can do up
  to 5/3 as much database work. Backoff spreads out accidental contention but not deliberate
  contention. ADR 0021 already records that team writes have no rate limit, and that some
  bodies take wide predicate locks (the invite path reads all of `users`). Accepted: the
  rate-limit and email-index items stay on the revisit list.
- **Probabilistic outcome.** "All writers commit" is measured, not guaranteed. The probe ran on
  an idle host (0/240; the panel re-ran it at 0/2400 with 8 writers, 0/600 with 12 and 0/800
  with 16). Under heavy CI load a rare exhaustion is still possible. The CI test uses 8 writers
  × 5 repetitions and reports the run counts when it fails.
