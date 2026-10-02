# Design

## Context

`PostgresCatalogDb.tx` (`packages/storage/src/postgresCatalogStore.ts:262-281`) loops
`attempt(fn, deadlineAt)` and rethrows when `n >= maxTries` (default 3), when the adapter is
closed, or when the error code isn't in `RETRYABLE` (`40001`, `40P01`). There is no delay
between runs. `deadlineAt` is computed once per transaction, and `attempt` enforces it for
waiting, statements and commit.

## Goals / Non-Goals

**Goals:** contending transactions stop re-running in lockstep, and retries at realistic
contention (up to 8 writers on one row) don't run out.

**Non-Goals:** see proposal.md.

## Decisions

### D1. Full jitter, 20 ms base, doubling; five runs
After failed run `n` (1-based), when another run is allowed, wait
`Math.random() * 20 * 2 ** (n - 1)` ms, then run again. The default `maxTries` becomes 5, and
the option stays. Full jitter (a uniform draw from zero to the cap) spreads contenders out best
for a small number of retries. The probe in proposal.md compares the alternatives.

### D2. The wait respects the deadline and close, and holds no connection
- **The wait holds no connection.** It sits in `tx()`'s retry loop, after `attempt()`'s
  `finally` has already released or recycled the slot. A queued transaction can take the slot
  during the wait.
- **The wait is `min(delay, deadlineAt - now)`.**
- **A deadline check before every re-run** (panel: two reviewers). `attempt()` has no upfront
  deadline check, and `acquire()` hands out a free slot whatever the deadline. A re-run that
  starts after the deadline would send `BEGIN` and either retire a connection on the about 1 ms
  bounded timer, or, with a fast reply, even commit. So when `Date.now() >= deadlineAt` after the
  wait (or when no wait applies), the loop throws `CatalogTxTimeoutError` with the existing
  message (`catalog transaction exceeded <txTimeoutMs> ms`), with no statement sent and no
  connection taken.
- **Close is checked twice.** It is checked before the wait (the existing
  `this.closed` check in the catch, so no wait starts once closed) and again after it. If
  `close()` arrived during the wait, the loop rethrows the last error and no new run starts.
  `close()` awaits `running`, so it waits for at most the remaining backoff (at most 160 ms).
- **The timer can't keep the process alive.** The timer is `unref`'d and bounded by the
  deadline.

### D3. Randomness and the wait are injectable for the unit test
The constructor accepts optional `random?: () => number` and `sleep?: (ms) => Promise<void>`,
which default to `Math.random` and an `unref`'d `setTimeout`. A unit test with a fake connection
(the existing `connect` injection) records the requested waits. They are `[0, 20)`, `[0, 40)`,
`[0, 80)` and `[0, 160)` with `random` near 1.

For the deadline cases the test uses `vi.useFakeTimers({ toFake: ['Date'] })`, and the injected
`sleep` advances the system time:
- a wait is capped by the remaining deadline;
- a wait that reaches the deadline raises the timeout error with no further statement sent and
  no new connection.

During an injected wait, the test also checks that all `txSlots` are free, and that no wait
follows the last run, a non-retryable error, or an adapter that is already closed.

## Assumptions (each with the command that tests it)

| # | Assumption | Command | Observed |
|---|---|---|---|
| A1 | Retries are immediate today, with default 3 | `sed -n 262,281p packages/storage/src/postgresCatalogStore.ts` | loop with `if (n >= this.maxTries \|\| this.closed \|\| !RETRYABLE.has(code)) throw error;`, no wait; `maxTries = 3` at line 232 |
| A2 | Lockstep retries exhaust at moderate contention | probe in proposal.md (`zzProbe.pg.test.ts`, deleted) | `n=5 exhausted=60/150`, `n=8 exhausted=115/240` |
| A3 | Jitter + 5 runs removes exhaustion at N ≤ 8 | same probe with the patch | `n=5 0/150`, `n=8 0/240` |
| A4 | The server uses the default `maxTries` | `grep -n "PostgresCatalogDb(" -A8 server/src/node/config.ts` | constructed without `maxTries` |
| A5 | The spec pins three runs | `grep -n "at most three runs" openspec/specs/core-ports-architecture/spec.md` | line 691 |

## Risks / Trade-offs

- **Latency.** A contended write can take up to about 300 ms longer before committing or
  failing. An uncontended write is unchanged.
- **Tests that count runs.** The existing pg case "gives up on serialization failure after 3
  runs" becomes 5 runs and also waits up to 300 ms. The fast pg suite stays fast.
- **A probe on a quiet machine.** The probe ran on an idle host. The CI gate is the new
  8-writer pg scenario, which is repeated within the test.
