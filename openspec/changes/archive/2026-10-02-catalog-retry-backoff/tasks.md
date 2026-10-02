# Tasks

The first commit on `supabase-catalog-retry-backoff` holds only
`openspec/changes/catalog-retry-backoff/`. The PR targets `supabase-migration`, and the gates run
with `GITHUB_BASE_REF=supabase-migration`. Logs go to the session scratchpad as
`rb-<task>-<red|green>.log`.

## 1. Tests first (design D1, D2, D3)

- [x] 1.1 Unit test in `postgresCatalogStore.test.ts`, using a fake connection and the injected
  `random` and `sleep`:
  - a body that always fails with `40001` runs 5 times;
  - the waits requested before runs 2-5 are below 20, 40, 80 and 160 ms (`random` returns
    0.999);
  - during a wait every slot is free;
  - no wait follows the last run, a non-retryable error, or an adapter already closed, and a
    `close()` during a wait starts no new run;
  - a wait is capped by the remaining deadline (fake `Date`, the `sleep` advances it);
  - a wait that reaches the deadline gives `CatalogTxTimeoutError` with no further statement sent
    and no new connection opened.
  In `postgresCatalogStore.pg.test.ts`:
  - "gives up on serialization failure after 3 runs" becomes 5;
  - a new case: 8 concurrent read-modify-write transactions on one row, each body making 4
    statements, all commit with the row incremented 8 times, repeated 5 times; on failure it
    reports the run counts.
  Verify: these are red before 2.1. Record the failures.
  Evidence: `cd packages/storage && npx vitest run src/postgresCatalogStore.test.ts
  src/postgresCatalogStore.pg.test.ts` (`rb-1.1-red.log`) -> `Tests  5 failed | 40 passed (45)`:
  - 5 runs -> `expected 3 to be 5` (unit and pg);
  - close during a wait -> `expected 3 to be 1`;
  - deadline -> `expected PostgresError: server 40001 ... to be an instance of CatalogTxTimeoutError`;
  - 8 writers -> `expected [ 'repetition 0: 4/8 exhausted', …(4) ] to deeply equal []`.
  The holds-no-connection case passed before the change (a guard: there was no wait yet).

## 2. Backoff (design D1, D2, D3)

- [x] 2.1 Implement D1-D3 in `PostgresCatalogDb`.
  Verify: 1.1 green; `packages/storage` suite green; `npm run typecheck` green.
  Evidence: same command (`rb-2.1-green.log`) -> `Tests  45 passed (45)`; `cd packages/storage &&
  npx vitest run` (`rb-2.1-storage.log`) -> `Test Files  5 passed (5)`, `Tests  72 passed (72)`;
  `npm run typecheck` -> exit 0; `npx biome check packages/storage/src/postgresCatalogStore*.ts`
  -> `No fixes applied`.

## 3. Docs and verification

- [x] 3.1 Docs:
  - ADR 0021:
    - the 4b entry (line 199): "at most 3 tries" becomes "at most 5 runs, with full-jitter
      backoff (owner, 2026-10-02, `catalog-retry-backoff`)";
    - hazard 20 (line 182): note that backoff makes exhaustion rarer;
    - "Revisit after the migration": the session-create item (lines 286-288) is resolved by this
      change; the flood item (line 280) stays and notes the 5/3 work bound; `503` +
      `Retry-After` stays;
  - `docs/supabase.md:149`: "retried up to 3 runs" becomes "up to 5 runs with a jittered
    backoff";
  - `packages/ports/src/catalogDb.ts:13`: "(at most three runs)" becomes "(at most five runs)".
  Verify: `grep -rniE "three runs|3 runs|3 tries|3 SERIALIZABLE" --exclude-dir=node_modules
  --exclude-dir=archive --exclude-dir=changes .` gives no hits outside history and specs text
  this change replaces.
  Evidence: the grep -> remaining hits are unrelated (`audioMerge.ts` "MP3 runs", ADR 0018 "3
  tries", ADR 0023 "three runs"), the ADR 0021 history phrase "first 3 tries, no wait", and
  `openspec/specs/core-ports-architecture/spec.md:691`, which archive replaces;
  `sed -n 12,13p packages/ports/src/catalogDb.ts` -> `(at most five runs)`.
- [x] 3.2 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`; it is
  green. Run the full server suite 3 times; it is green each time.
  Evidence: `rb-3.2-hook.log` -> every gate PASS (`size  34/400 changed lines`, `commands  ran
  ['typecheck', 'test']`) once the evidence lines sat inside each task's first block;
  `cd server && npx vitest run` x3 (`rb-3.2-server-{1,2,3}.log`) -> `Tests  940 passed | 3 skipped
  (943)` each run.
