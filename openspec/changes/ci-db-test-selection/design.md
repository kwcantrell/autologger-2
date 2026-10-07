# Design

## Context

See proposal.md for why. Today:

- `lifecycle.commands.test` is `npm test`. The root script chains `node --test` over two
  `docker/scripts` tests, then `npm run test -w <ws>` for 14 workspaces. Each workspace script is
  plain `vitest run`.
- Only `server/vitest.config.ts` (`unit`, `integration`, `pg`) and
  `packages/storage/vitest.config.ts` (`unit`, `pg`) define vitest projects. The pg and
  integration projects need a docker daemon and start the image pinned in
  `docker/supabase-db.yaml` through `test/pg/globalSetup.ts`.
- `lifecycle.yml` runs `--stage pr` on pull requests and `--stage commit` on pushes to `main`.
  The commit stage runs no stack commands. PRs merge into `supabase-migration`, which has no
  push trigger, so no full test run ever happens after a merge.
- `check_change.py` already computes `ctx.changed` against the merge-base, and it reads
  `EXEMPTION_KEYS` from the base's `openspec/config.yaml` (`with_base_exemptions`).

## Goals / Non-Goals

**Goals:**

- A PR whose changed files can't affect a pg or integration test skips those two projects, and
  says so in the output that decides it: the `commands` line locally, and each `db-shard`'s
  `--db-selection` line in CI (D5).
- The selection fails safe: if anything is unclear, run everything.
- Every merge into `supabase-migration` gets a full run.

**Non-Goals:** see proposal.md. In addition, there's no per-test or per-file dependency
analysis. The trigger is a fixed glob list.

## Decisions

### D1. A glob list, read from the base

`lifecycle.db_test_paths` starts as:

```yaml
db_test_paths:
- server/**
- packages/**
- supabase/**
- test/**
- docker/**
- fixtures/**
- package.json
- package-lock.json
- scripts/lib/check_change.py
- .github/workflows/**
- openspec/config.yaml
```

`server/**` and `packages/**` hold the code under test and the tests themselves. `supabase/**`
holds the migrations. `test/**` is the pg harness. `docker/**` pins the postgres image
(`docker/supabase-db.yaml`). `fixtures/**` is read by integration tests (for example
`sessions.youtubeImport.int.test.ts`). The root manifests change dependency versions. The last
three lines mean a change to the selection machinery itself always runs the full suite.

`db_test_paths` joins `EXEMPTION_KEYS`, so a PR's gates use the list on its merge-base. A PR
that removes `server/**` from the list still runs the full suite for itself.

*Alternative: a denylist of paths that can't matter (`web/**`, `openspec/**`, `docs/**`, ...).*
Rejected. A new top-level directory would silently skip DB tests until someone noticed. An
allowlist fails toward running more.

*Alternative: dependency analysis from the import graph.* Rejected as too much machinery. The
integration tests import nearly every package, so the result would be close to the glob list
anyway.

### D2. An environment variable read by the vitest configs

When `SKIP_DB_TESTS=1`, the two configs drop the `integration` and `pg` entries from
`test.projects`. `npm test` and the per-workspace scripts don't change.

*Alternative: `vitest run --project unit`.* Rejected. 12 of the 14 workspaces define no projects,
so the root script would need a second, parallel chain of workspace commands to keep in sync.
Vitest also fails when `--project` matches nothing.

### D3. When the gate selects

The `commands` gate sets `SKIP_DB_TESTS=1` for the `test` command only when all of these hold:

1. `FULL_TESTS` is not `1`;
2. the run is a pull request (`GITHUB_EVENT_NAME == pull_request`), or it is local (`CI` unset).
   There is no stage condition: `--stage hook`, `--stage pr` and `--only commands` all select the
   same way;
3. `ctx.base` is known;
4. `db_test_paths` (as read from the base) is a non-empty list;
5. no file in `ctx.changed` matches `db_test_paths`.

Otherwise it runs the full suite. In CI, D5 overrides this: `gates` never runs the DB tests, and
the same conditions are evaluated by each `db-shard` through `--db-selection`. The gate message names the outcome, for example
`ran ['typecheck', 'test'] (pg/integration skipped: no db_test_paths changed)`, or
`(full: server/src/app.ts matches db_test_paths)`. That way evidence lines show which suite
ran. Typecheck, lint and audit are never affected.

If `SKIP_DB_TESTS` is already in the environment, the gate removes it before running a full suite.
A stray export can't turn a full run into a partial one.

Under `--quiet`, the `commands` line still prints when it skipped DB tests, the same way the
`yaml` warning does. The pre-push hook (`verbose: true` in `.pre-commit-config.yaml`) therefore
shows the skip on a passing push. The Stop hook prints only on failure. Its output isn't evidence
anyway, since evidence comes from non-quiet runs.

### D4. A full suite after every merge

`lifecycle.yml` `push.branches` becomes `[main, supabase-migration]`. A push to
`supabase-migration` runs only `FULL_TESTS=1 scripts/check-change.sh --only commands,audit`, under `gates`' job-level
`DB_TESTS_IN_SHARDS=1` (D5).
A push to `main` keeps `--stage commit`, and PRs keep `--stage pr`. With D5, the push's DB tests
run in the `db-shard` jobs with `FULL_TESTS=1`, and the `gates` step runs typecheck, unit tests and
audit.

The commit stage can't run on a `supabase-migration` push. There is no `GITHUB_BASE_REF`, so
`resolve_base` falls back to `origin/main`, 486 commits behind. The diff then holds 43 archive
dirs, and `change` fails with "one change per branch". All three panel reviewers reproduced this.
Every file check in the commit stage already ran on the PR that produced the push, so nothing is
lost. `commands` and `audit` don't read the change directory (`NEEDS_CHANGE`), so a failing
`change` resolution doesn't block them under `--only`.

*Alternative: `--base ${{ github.event.before }}`.* Rejected. It makes the commit stage
pass, but it adds a second base-resolution path to a run whose only job is the full suite. The
existing `concurrency` group (`lifecycle-${{ github.ref }}` with
cancel-in-progress) means quick back-to-back merges cancel the older run. The newest merge always
gets a full run, which covers the earlier ones.

*Alternative: a nightly scheduled run.* Rejected by the owner (2026-10-07) in favor of per-merge
runs, which tie a failure to one merge.

### D5. Shard the DB tests in CI (re-approval delta, 2026-10-07)

The workflow gets two new jobs. `gates` stays the same apart from one env var.

- **`db-shard`**, a matrix over `shard: [1, 2, 3]`. It runs on pull requests and on pushes to
  `supabase-migration`, and checks out with `fetch-depth: 0`. It installs PyYAML, then runs
  `scripts/check-change.sh --db-selection`, which prints `run: <reason>` or `skip: <reason>`. On
  `skip`, the remaining steps are skipped, so no `npm ci` or image pull happens. On `run`, it runs
  `npm ci`, then `npx vitest run --project integration --project pg --shard=${{ matrix.shard }}/3`
  in `server/`. Shard 1 also runs `npx vitest run --project pg` in `packages/storage/`, unsharded.
  That project has only 3 files (about 51s locally), and vitest exits 1 when the shard count
  exceeds the file count, so sharding it would cap the matrix at 3. Pushes set `FULL_TESTS=1`.
- **The selection step fails toward running.** `--db-selection` returns before `main()` resolves
  the change or prints any gate line, so its stdout is exactly one line. The step skips the tests
  only when the command exits 0 *and* stdout is exactly one line starting `skip: `. Empty output,
  extra lines and unknown words all mean run. A non-zero exit (missing PyYAML, a traceback in base
  resolution) fails the shard, which fails `db-tests`.
- **`db-tests`** has `needs: db-shard` and the same event condition as `db-shard` (pull requests and
  pushes to `supabase-migration`), combined with `!cancelled()` rather than `always()`. It fails
  unless `needs.db-shard.result == 'success'`, so it's the one name to make required. A matrix
  job's check names change with the matrix. A shard that stops after `skip` still reports
  `success`. On a push to `main`, both jobs are skipped by their `if`, so no red check is posted.
  When `cancel-in-progress` cancels a run (a new push, or a label or description edit),
  `db-tests` doesn't run, so a cancelled run never posts a failure.
- **`gates`** sets `DB_TESTS_IN_SHARDS=1` as job-level `env`, so it applies to the PR and push
  commands alike. When `CI` is set too, the `commands` gate runs the test
  command with `SKIP_DB_TESTS=1` whatever the paths, and its message reads
  `(pg/integration: db-tests job)`. The checker ignores `DB_TESTS_IN_SHARDS` locally (`CI` unset),
  so a stray export can't skip local DB tests. There, D3 still decides.

`--db-selection` and the `commands` gate call the same function (D3's conditions 1-5), so CI and
local can't disagree about which paths need DB tests. `--db-selection` loads the config and base
the same way a normal run does, and runs no gates.

**Why 3 shards:** the local measurement puts the DB tests at about 600s. Three runners at about
200s each, plus setup, should finish within the time `gates` already takes for typecheck and unit
tests. Shard count is the matrix literal plus the `/3` in the server command. Storage isn't
sharded, so the count is bounded only by the server's 101 files. Task 3.4 measures the real
per-shard times.

*Alternative: shard inside the `gates` job.* Not possible. Sharding only helps when the shards run
on separate machines.

*Alternative: let `--shard` handle selection by having every shard always run the full check
(`--stage pr`) with a shard index.* Rejected. It repeats every file gate three times and mixes
evidence for the same gates across jobs.

*Alternative: `vitest --shard` over all workspaces from the root.* Rejected. The root `npm test` is
a chain of workspace commands, not a single vitest run, and only `server` and `storage` have DB
projects.

## Assumptions

| Assumption | Command | Observed |
| --- | --- | --- |
| The script's own file checks are negligible | `time scripts/check-change.sh --only openspec,yaml,workflows,skills-sync,guide-size,change,risk-floor,approval,panel,tasks,evidence,artifacts-first,tests-with-code` | `real 0m1.789s` |
| The gates step is ~8.5 min in CI | `gh api .../actions/runs/<last green>/jobs` | `Run lifecycle gates: 509s` |
| Most merged PRs touch no DB path | `gh pr list --state merged --limit 40 --json files` | 27 of 40 touched only `openspec/` |
| Only server and storage define pg/integration projects | `ls */vitest.config.ts packages/*/vitest.config.ts` | `companion`, `packages/storage`, `server`, `web`. The companion and web configs have no `projects` |
| Integration tests read `fixtures/` | `grep -rln 'fixtures/' server/src --include=*.int.test.ts` | `sessionHub.interleave`, `transcribe`, `sessions.youtubeImport` |
| The pg image is pinned under `docker/` | `grep -n supabase-db test/pg/globalSetup.ts` | `Runs the image pinned in docker/supabase-db.yaml` |
| pg/integration dominate test time | `time npx vitest run --project <p>` per project, plus web tests and `npm run typecheck`, on this host, 2026-10-07 | server integration 511s (exit 1: one test, `crossProcess.int.test.ts` "concurrent writes from two processes...", timed out at 5000ms; 1228 of 1229 passed. See task 1.1. Measured under contention: load average 7-10, a concurrent agent's test runs and orphaned `main.ts` processes, so the seconds are inflated and the CI times in task 3.4 are authoritative), server pg 35s, storage pg 51s: 597s of DB tests. Server unit 21s, storage unit 2s, web 49s, typecheck 24s |
| `vitest run --shard` splits files within selected projects | `cd server && npx vitest run --project unit --shard=<i>/3` for i = 1..3 | `Test Files 12 passed`, `10 passed, 1 skipped (11)`, `10 passed, 1 skipped (11)`: 34 files, disjoint shards |
| `vitest list` can't be used to check shards | `npx vitest list --project integration --project pg --shard=<i>/3 --filesOnly \| grep -c '^\['` | `101` for every i: list ignores `--shard`, so task 3.2 checks with `run` instead |
| Runners have 4 vCPUs | `gh repo view --json visibility` | `PUBLIC`: standard public-repo Linux runners are 4 vCPU |

## Risks / Trade-offs

- [A path that DB tests depend on is missing from the list] → the full run on every merge
  catches it within one merge. Adding the path is a one-line config change.
- [A PR edits a vitest config to always skip] → that file is under `server/**` or `packages/**`,
  so the PR's own run is full. After merge, it would hide tests the same way deleting them
  would. Human PR review is the control there, as it is today.
- [Post-merge failures land after the PR merged] → the run is visible on the branch. It isn't a
  required check (non-goal). Expect a red X on `supabase-migration` and a fix-forward.
- [Local `hook` runs skip DB tests that the agent needed] → the skip line prints even under
  `--quiet` (D3), and `FULL_TESTS=1 scripts/check-change.sh --stage hook` forces the full suite.

- [A shard gets most of the slow files, because vitest balances by file count, not duration] →
  task 3.4 records per-shard times. Rebalancing (more shards, or splitting a slow file) is a
  follow-up, not part of this change.
- [The `gates` check passes while the DB tests fail] → `db-tests` is a separate check. The
  `main-protect` ruleset (refs/heads/main) requires only `gates`, `secrets` and
  `dependency-review`, so until `db-tests` is added, a PR into `main` could merge with red DB
  tests. `supabase-migration` has no protection either way. Task 4.2 updates the docs that list
  the required checks. Task 4.3 is the owner's ruleset edit, ticked with `gh api` evidence before
  this change is archived.
- [More CI minutes: 3 × (checkout, `npm ci`, image pull)] → the repo is public, so standard
  runners cost nothing. A `skip` shard stops after checkout and the PyYAML install.

## Migration Plan

Lands as one PR. Rollback is reverting that PR. The owner adds `db-tests` to `main-protect`'s
required checks before archive (task 4.3). A ruleset can name a check before any run has
produced it, and PRs into `supabase-migration` are unprotected either way. With `db_test_paths` absent from the base config,
the gate always runs the full suite, so the first PR (and any revert) runs fully.
