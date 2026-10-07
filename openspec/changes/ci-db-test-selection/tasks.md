# Tasks

The first commit on this branch is `openspec/changes/ci-db-test-selection/` only (AGENTS.md rule 6).
The checker has no test suite in this repo, so each checker task names the command that shows
the old behavior before the change and the new behavior after it.

## 1. Vitest configs honor SKIP_DB_TESTS

- [ ] 1.1 Baseline. The per-project timings were measured before approval and are in design.md's
  Assumptions table. This task records them as evidence and characterizes the one baseline
  failure: run `npx vitest run --project integration src/test/session/crossProcess.int.test.ts`
  in `server/` 5 times on `origin/supabase-migration` and record pass/fail counts. Fixing that
  test is out of scope. If it also fails in the CI shards (tasks 3.4, 5.2), stop and raise it with
  the owner rather than retrying it green. Check: the evidence lists the timing row and the 5
  results.
- [ ] 1.2 `server/vitest.config.ts` and `packages/storage/vitest.config.ts` drop their
  `integration`/`pg` projects when `SKIP_DB_TESTS=1`. Before: `SKIP_DB_TESTS=1 npx vitest run
  --project pg` in `packages/storage` runs the pg tests. After: vitest reports that no project
  matched, and `SKIP_DB_TESTS=1 npx vitest run` in `server/` runs only `unit`. Without the variable,
  `npx vitest run --project pg` still runs. Also passes `npm run typecheck`.

## 2. The commands gate selects

- [ ] 2.1 Add `db_test_paths` to `openspec/config.yaml` (the D1 list) and to `EXEMPTION_KEYS` in
  `scripts/lib/check_change.py`. Check: `scripts/check-change.sh --only yaml,openspec` passes, and
  `git grep -n db_test_paths` shows the config key and the `EXEMPTION_KEYS` entry.
- [ ] 2.2 The `commands` gate applies D3. It sets `SKIP_DB_TESTS=1` for `test` only when every
  condition holds, strips an inherited `SKIP_DB_TESTS` otherwise, and names the outcome in its
  message. Check, on a scratch branch off this one, with `--base` pointing at a commit whose config
  already has the list:
  - a `web/`-only diff gives `(pg/integration skipped: no db_test_paths changed)`;
  - a `server/` diff gives `(full: server/... matches db_test_paths)`;
  - `FULL_TESTS=1` on the `web/` diff gives `full`;
  - `GITHUB_EVENT_NAME=push CI=1` gives `full`;
  - `SKIP_DB_TESTS=1` exported on the `server/` diff still gives `full`, and the pg project runs;
  - `--stage hook --quiet` on the `web/` diff still prints the `commands` skip line.
  Before the change, all six give `ran ['typecheck', 'test']` (or print nothing under `--quiet`)
  with no qualifier.
- [ ] 2.3 With `--base origin/supabase-migration` (no `db_test_paths` on that base), the gate runs
  the full suite. Check: `scripts/check-change.sh --only commands --base origin/supabase-migration`
  shows `full`.

- [ ] 2.4 `scripts/check-change.sh --db-selection` prints `run: <reason>` or `skip: <reason>` from
  the same function the `commands` gate uses, runs no gates, and exits 0. Check, on the scratch
  setup from 2.2: the `web/`-only diff prints `skip: no db_test_paths changed`, the `server/` diff
  prints `run: server/... matches db_test_paths`, and `FULL_TESTS=1` prints `run: FULL_TESTS=1`.
  In every case stdout is exactly one line (`| wc -l` -> 1), and no gate or `change` line is
  printed. Before: `--db-selection` is an unknown argument (exit 2).
- [ ] 2.5 With `CI=1 DB_TESTS_IN_SHARDS=1`, the `commands` gate runs the test command with
  `SKIP_DB_TESTS=1` on any diff and reports `(pg/integration: db-tests job)`. Without `CI`,
  `DB_TESTS_IN_SHARDS` is ignored. Check: on the `server/` diff, `CI=1 DB_TESTS_IN_SHARDS=1
  GITHUB_EVENT_NAME=pull_request scripts/check-change.sh --only commands` shows the `db-tests job`
  message, and `DB_TESTS_IN_SHARDS=1 scripts/check-change.sh --only commands` (no `CI`) shows
  `full`.

## 3. CI runs the full suite after merge, sharded

- [ ] 3.1 `.github/workflows/lifecycle.yml`: `push.branches: [main, supabase-migration]`. A push to
  `supabase-migration` runs only `FULL_TESTS=1 DB_TESTS_IN_SHARDS=1 scripts/check-change.sh --only commands,audit`. A
  push to `main` keeps `--stage commit`, and PRs keep `--stage pr`. Actions stay SHA-pinned.
  Check: `scripts/check-change.sh --only workflows,yaml` passes, and loading the workflow with
  `python3 -c` shows both branches and the per-ref command.
- [ ] 3.2 `.github/workflows/lifecycle.yml` gets the `db-shard` matrix job (`shard: [1, 2, 3]`)
  and the `db-tests` result job from D5, and `gates` sets `DB_TESTS_IN_SHARDS=1`. `db-tests` uses
  `db-shard`'s event condition with `!cancelled()`. Storage pg runs unsharded on shard 1 only.
  Actions stay SHA-pinned, and permissions stay `contents: read`. Checks:
  - `scripts/check-change.sh --only workflows,yaml` passes.
  - Running the server vitest command locally with `--shard=<i>/3` (i = 1..3) runs disjoint file
    sets whose `Test Files` totals add up to the unsharded 101.
  - The selection step's shell, extracted to a scratch script and fed stdin/exit codes, behaves as
    follows: `skip: x` with exit 0 skips; empty output, `run: x`, `garbage` and two lines all run;
    exit 1 fails the step.
  - Loading the workflow with `python3 -c` shows `db-tests`' `if` matching `db-shard`'s plus
    `!cancelled()`.
- [ ] 3.3 Simulate the push run before merge. In a clone checked out at `origin/supabase-migration`
  with this branch's checker and vitest configs applied, run
  the push run's two halves:
  `env -u GITHUB_BASE_REF CI=1 GITHUB_EVENT_NAME=push FULL_TESTS=1 DB_TESTS_IN_SHARDS=1 scripts/check-change.sh --only commands,audit`
  (the `gates` step), and `... FULL_TESTS=1 scripts/check-change.sh --db-selection` (the `db-shard`
  decision). Check: the first exits 0 with `(pg/integration: db-tests job)`, and no `change`
  failure blocks it. The second prints `run: FULL_TESTS=1`. For contrast, `--stage commit` under the same env shows the "one
  change per branch" failure that the push path avoids.
- [ ] 3.4 On the PR's own CI run (it touches `scripts/`, so the shards run), record each
  `db-shard` job's duration and the `gates` duration next to the 509s baseline. Check: `gh api
  repos/:owner/:repo/actions/runs/<id>/jobs` shows 3 `db-shard` jobs, `db-tests` green, and the
  times recorded in the evidence.
- [ ] 3.5 After the PR merges, the push run on `supabase-migration` runs all 3 shards with
  `FULL_TESTS=1`. Check: `gh run view <id> --log | grep 'run: FULL_TESTS=1'` hits each shard, and
  `db-tests` is green. Owner-visible. Tick after merge,
  with evidence.

## 4. Docs and ADR

- [ ] 4.1 New ADR `docs/decisions/0026-select-db-tests-by-path.md`, with the measurements from
  1.1 and design.md as evidence. `docs/lifecycle.md` explains the selection, `db_test_paths`,
  `FULL_TESTS=1`, the shards (`db-shard`, `db-tests`, `DB_TESTS_IN_SHARDS`) and the post-merge run, and says
  the owner adds `db-tests` to the required checks. Check: `grep -n 'db_test_paths\|FULL_TESTS'
  docs/lifecycle.md docs/decisions/0026-*.md` hits both files.

- [ ] 4.2 `docs/security.md` (the required-checks setup list, line ~25) and the header comment
  of `.github/workflows/lifecycle.yml` name `db-tests` among the required checks. Check:
  `grep -n 'db-tests' docs/security.md .github/workflows/lifecycle.yml` hits the setup line and
  the header.
- [ ] 4.3 Owner step, done before archive: add `db-tests` to the `main-protect` ruleset's
  required status checks. Check: `gh api repos/:owner/:repo/rulesets/19850235 --jq
  '.rules[]|select(.type=="required_status_checks")'` lists `db-tests` alongside `gates`,
  `secrets` and `dependency-review`.

## 5. Verify

- [ ] 5.1 `scripts/check-change.sh --stage hook` passes on the branch, and its `commands` line
  shows `full` (this branch touches `scripts/lib/check_change.py`).
- [ ] 5.2 The PR's CI run passes. `gates`' `commands` line shows `(pg/integration: db-tests job)`,
  and every `db-shard` shows `run:`.
