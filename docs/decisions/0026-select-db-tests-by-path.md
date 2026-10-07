# 0026: Run the pg and integration tests only when their paths change, sharded in CI

- Date: 2026-10-07
- Status: Accepted
- Rule: the `commands` gate's DB-test selection (`lifecycle.db_test_paths`), and the `db-shard` and `db-tests` CI jobs

## Context

The `gates` job ran every test on every PR, in one process, and took about 8.5 minutes. The
checker's own file gates take under 2 seconds. The rest is the stack commands, and most of that
is the pg and integration vitest projects. Those start a pinned Postgres container and clone a
catalog per test. Most PRs can't affect them: archive PRs touch only `openspec/`, and the shadcn
port touched only `web/`. No test ran after a merge either, because pushes ran the commit stage
only.

## Decision

- **Select by path.** `lifecycle.db_test_paths` lists what the DB tests depend on, and is read
  from the merge-base. A change that matches none of it runs the test command with
  `SKIP_DB_TESTS=1`, and the server and storage vitest configs drop those projects. Anything
  unclear runs them.
- **Shard in CI.** The DB tests leave `gates` for a 3-way `db-shard` matrix (`vitest --shard`).
  Each shard asks the checker the same question (`--db-selection`), and `db-tests` aggregates
  the shards into one required check.
- **Run everything after merge.** A push to `supabase-migration` runs the full suite, sharded.
  The push skips the commit stage, which has no PR base on a push.

Change: `openspec/changes/archive/*-ci-db-test-selection` (design D1-D5, panel and re-panel).

## Evidence

- CI run 37578446349: "Run lifecycle gates" took 509s. Locally,
  `time scripts/check-change.sh --only <all file gates>` took 1.8s.
- Local timings, 2026-10-07: server integration 511s, server pg 35s, storage pg 51s, so 597s of
  DB tests. Server unit 21s, storage unit 2s, web 49s, typecheck 24s. The push-path `gates` half
  (typecheck, every unit suite, audit) took 92s.
- 27 of the last 40 merged PRs touched only `openspec/`.
- The local timings were taken on a shared 8-core host with load average 7-10. Another agent's
  test runs were going at the same time, and in part of the window orphaned `main.ts` processes
  from a boot test were running at about 70% CPU each. The seconds are inflated. The conclusion
  (DB tests dominate) is not affected. Task 3.4's CI per-shard and `gates` times are the clean
  numbers.
- One baseline integration test (`crossProcess.int.test.ts`) timed out at 5000ms in the
  contended full-suite run (1228/1229 passed) and passed 5/5 alone. That fits the load above
  rather than a defect. It's not addressed here.

## Consequences

- PRs that touch no DB path pay only for `gates`. PRs that do pay for `gates` or the slowest
  shard, whichever is longer, instead of the sum.
- CI minutes go up: each shard pays its own checkout, `npm ci` and image pull, and every merge
  runs a full suite. The repo is public, so standard runners are free.
- The path list can miss a dependency. The post-merge full run is the backstop, and a miss means
  adding a glob.
- Vitest shards by file count, not duration, so shards can be uneven. Raise the matrix count, or
  split a slow file, if one shard dominates.
- Drop it if the DB tests get fast enough that one runner beats three, or if a missed path ever
  lets a DB regression merge.
