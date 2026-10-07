# Tasks

The first commit on this branch is `openspec/changes/ci-db-test-selection/` only (AGENTS.md rule 6).
The checker has no test suite in this repo, so each checker task names the command that shows
the old behavior before the change and the new behavior after it.

## 1. Vitest configs honor SKIP_DB_TESTS

- [x] 1.1 Baseline. The per-project timings were measured before approval and are in design.md's
  Assumptions table. This task records them as evidence and characterizes the one baseline
  failure: run `npx vitest run --project integration src/test/session/crossProcess.int.test.ts`
  in `server/` 5 times on `origin/supabase-migration` and record pass/fail counts. Fixing that
  test is out of scope. If it also fails in the CI shards (tasks 3.4, 5.2), stop and raise it with
  the owner rather than retrying it green. Check: the evidence lists the timing row and the 5
  results.
  Evidence: timings (design.md Assumptions, measured 2026-10-07 on `origin/supabase-migration` 415cca6b plus artifacts): server unit 21s, integration 511s (rc=1), pg 35s; storage unit 2s, pg 51s; web 49s; typecheck 24s; full `npm test` 502s (rc=1; the `&&` chain stops after `server`). The integration failure was a re-run of `--project integration` -> `FAIL |integration| src/test/session/crossProcess.int.test.ts > two processes on one session > concurrent writes from two processes leave the last committed state in the catalog`, `Error: Test timed out in 5000ms.`, `Tests 1 failed | 1228 passed (1229)`. Isolated, 5 runs of `npx vitest run --project integration src/test/session/crossProcess.int.test.ts` (this branch; the vitest config edits are inert without `SKIP_DB_TESTS`) -> `Tests 3 passed (3)` 5/5, 34-39s each. So it times out only under full-suite load. The host was contended throughout (load average 7-10; a concurrent agent's `npm test`; orphaned `main.ts` boot-test processes at ~70% CPU, per that agent's report), which fits the timeout and inflates every local timing here.
- [x] 1.2 `server/vitest.config.ts` and `packages/storage/vitest.config.ts` drop their
  `integration`/`pg` projects when `SKIP_DB_TESTS=1`. Before: `SKIP_DB_TESTS=1 npx vitest run
  --project pg` in `packages/storage` runs the pg tests. After: vitest reports that no project
  matched, and `SKIP_DB_TESTS=1 npx vitest run` in `server/` runs only `unit`. Without the variable,
  `npx vitest run --project pg` still runs. Also passes `npm run typecheck`.
  Evidence: before, `SKIP_DB_TESTS=1 npx vitest list --project pg --filesOnly` (storage) -> 3 `[pg]` files, rc=0; `SKIP_DB_TESTS=1 npx vitest list --filesOnly` (server) -> `89 integration / 12 pg / 34 unit`. After, storage `SKIP_DB_TESTS=1 npx vitest run --project pg` -> `Error: No projects matched the filter "pg".` rc=1; without the variable, storage lists 3 `[pg]` files; server with the variable lists `34 unit` only, and `SKIP_DB_TESTS=1 npx vitest run` -> `Test Files 32 passed | 2 skipped (34)`; server without it -> `89 integration / 12 pg / 34 unit`; `npm run typecheck` rc=0; `biome check` on the storage config -> no fixes.

## 2. The commands gate selects

- [x] 2.1 Add `db_test_paths` to `openspec/config.yaml` (the D1 list) and to `EXEMPTION_KEYS` in
  `scripts/lib/check_change.py`. Check: `scripts/check-change.sh --only yaml,openspec` passes, and
  `git grep -n db_test_paths` shows the config key and the `EXEMPTION_KEYS` entry.
  Evidence: `scripts/check-change.sh --only yaml,openspec` -> `PASS yaml 105 YAML file(s) parse`, `PASS openspec openspec validate --strict`; `git grep -n db_test_paths -- openspec/config.yaml scripts/` -> `openspec/config.yaml:57:  db_test_paths:`, `scripts/lib/check_change.py:94:EXEMPTION_KEYS = ("managed_paths", "test_globs", "db_test_paths")`
- [x] 2.2 The `commands` gate applies D3. It sets `SKIP_DB_TESTS=1` for `test` only when every
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
  Evidence: scratch clone of this branch, base commit = branch + stub `commands` (`test` writes `${SKIP_DB_TESTS:-unset}` to a file, `typecheck: 'true'`) + the D1 list; runner `scratchpad/scen.sh`. Before (old checker): web-only, server, FULL_TESTS, push CI -> `ran ['typecheck', 'test']; not configured: ['lint']`, test saw `unset` in all four; server + exported `SKIP_DB_TESTS=1` -> test saw `1` (the leak); `--stage hook --quiet` printed nothing. After: web-only -> `(pg/integration skipped: no db_test_paths changed)`, saw `1`; server -> `(full: server/src/x.ts matches db_test_paths)`, saw `unset`; web + `FULL_TESTS=1` -> `(full: FULL_TESTS=1)`, `unset`; web + `CI=1 GITHUB_EVENT_NAME=push` -> `(full: CI event push is not a pull request)`, `unset`; server + exported `SKIP_DB_TESTS=1` -> `(full: ...)`, saw `unset` (stripped, so the pg project runs per 1.2); web `--stage hook --quiet` -> prints `PASS commands ... (pg/integration skipped: no db_test_paths changed)`.
- [x] 2.3 With `--base origin/supabase-migration` (no `db_test_paths` on that base), the gate runs
  the full suite. Check: `scripts/check-change.sh --only commands --base origin/supabase-migration`
  shows `full`.
  Evidence: real repo `env -u CI scripts/check-change.sh --base origin/supabase-migration --db-selection` -> `run: no db_test_paths on the base`, rc=0. Scratch, base = branch tip before the list (`git show $B:openspec/config.yaml | grep -c db_test_paths` -> 0), web-only diff, `--only commands` -> `(full: no db_test_paths on the base)`, test saw `unset`. (The real-repo `--only commands` form would run the full 10-minute suite; the scratch form runs the same code path with stub commands.)
- [x] 2.4 `scripts/check-change.sh --db-selection` prints `run: <reason>` or `skip: <reason>` from
  the same function the `commands` gate uses, runs no gates, and exits 0. Check, on the scratch
  setup from 2.2: the `web/`-only diff prints `skip: no db_test_paths changed`, the `server/` diff
  prints `run: server/... matches db_test_paths`, and `FULL_TESTS=1` prints `run: FULL_TESTS=1`.
  In every case stdout is exactly one line (`| wc -l` -> 1), and no gate or `change` line is
  printed. Before: `--db-selection` is an unknown argument (exit 2).
  Evidence: before, `--db-selection` -> `check_change.py: error: unrecognized arguments: --db-selection`, rc=2. After (scratch): web-only -> `[skip: no db_test_paths changed] lines=1 rc=0`; server -> `[run: server/src/x.ts matches db_test_paths] lines=1 rc=0`; `FULL_TESTS=1` -> `[run: FULL_TESTS=1] lines=1 rc=0`; no gate or `change` line on stdout.
- [x] 2.5 With `CI=1 DB_TESTS_IN_SHARDS=1`, the `commands` gate runs the test command with
  `SKIP_DB_TESTS=1` on any diff and reports `(pg/integration: db-tests job)`. Without `CI`,
  `DB_TESTS_IN_SHARDS` is ignored. Check: on the `server/` diff, `CI=1 DB_TESTS_IN_SHARDS=1
  GITHUB_EVENT_NAME=pull_request scripts/check-change.sh --only commands` shows the `db-tests job`
  message, and `DB_TESTS_IN_SHARDS=1 scripts/check-change.sh --only commands` (no `CI`) shows
  `full`.
  Evidence: (scratch, server diff) `CI=1 GITHUB_EVENT_NAME=pull_request DB_TESTS_IN_SHARDS=1 --only commands` -> `(pg/integration: db-tests job)`, test saw `1`; `DB_TESTS_IN_SHARDS=1` without `CI` -> `(full: server/src/x.ts matches db_test_paths)`, saw `unset`; push form `CI=1 GITHUB_EVENT_NAME=push FULL_TESTS=1 DB_TESTS_IN_SHARDS=1 --only commands,audit` -> `(pg/integration: db-tests job)`, rc=0.

- [x] 2.6 (Owner delta, D3a.) With `CI` unset, the `commands` gate runs the test command with
  `SKIP_DB_TESTS=1` on any diff, `server/` included, and reports `(pg/integration skipped: local
  run; ...)` unless `FULL_TESTS=1`. CI behavior (2.5, `--db-selection`) is unchanged. Check on the
  scratch setup: before, a `server/` diff gives `(full: server/src/x.ts matches db_test_paths)`.
  After, it gives the local-skip message and the test sees `1`. `FULL_TESTS=1` on the same diff
  gives `(full: FULL_TESTS=1)`. `CI=1 GITHUB_EVENT_NAME=pull_request` on the same diff gives
  `full`. `CI=1 DB_TESTS_IN_SHARDS=1` gives `db-tests job`. `--stage hook --quiet` prints the skip
  line. `--db-selection` on the `server/` diff still prints `run: ...`. Docs: `docs/lifecycle.md`
  and ADR 0026 say local runs skip the DB suite and that TDD runs the targeted test.
  Evidence: (scratch, stub commands) before D3a, local `server/` diff `--only commands` -> `(full: server/src/x.ts matches db_test_paths)`, test saw `unset`; `--stage hook --quiet` printed nothing. After: local `server/` -> `(pg/integration skipped: local run; CI runs them on the PR, FULL_TESTS=1 runs them here)`, saw `1`; `FULL_TESTS=1` -> `(full: FULL_TESTS=1)`, `unset`; `CI=1 GITHUB_EVENT_NAME=pull_request` -> `(full: server/src/x.ts matches db_test_paths)`, `unset`; CI PR web-only -> `(pg/integration skipped: no db_test_paths changed)`; `CI=1 DB_TESTS_IN_SHARDS=1` -> `(pg/integration: db-tests job)`; push-gates env -> `db-tests job`; `--stage hook --quiet` -> prints the local-skip line; local `--db-selection` -> `run: server/src/x.ts matches db_test_paths`; `SKIP_DB_TESTS=0 FULL_TESTS=1` -> `full`, `unset`. Docs: `grep -n 'Not locally\|Locally, never' docs/lifecycle.md docs/decisions/0026-*.md` -> `docs/lifecycle.md:75`, `docs/decisions/0026-select-db-tests-by-path.md:18`.

## 3. CI runs the full suite after merge, sharded

- [x] 3.1 `.github/workflows/lifecycle.yml`: `push.branches: [main, supabase-migration]`. A push to
  `supabase-migration` runs only `FULL_TESTS=1 DB_TESTS_IN_SHARDS=1 scripts/check-change.sh --only commands,audit`. A
  push to `main` keeps `--stage commit`, and PRs keep `--stage pr`. Actions stay SHA-pinned.
  Check: `scripts/check-change.sh --only workflows,yaml` passes, and loading the workflow with
  `python3 -c` shows both branches and the per-ref command.
  Evidence: `scripts/check-change.sh --only workflows,yaml` -> `PASS workflows actions pinned, token scoped`, `PASS yaml 105 YAML file(s) parse`; `python3 -I -c` loading the workflow -> `push ['main', 'supabase-migration']`, `gates env: {'DB_TESTS_IN_SHARDS': '1'}`, `perms: {'contents': 'read'}`. The "Run lifecycle gates" step branches on `EVENT`/`REF`: `pull_request` -> `--stage pr`; `refs/heads/supabase-migration` -> `FULL_TESTS=1 scripts/check-change.sh --only commands,audit`; else `--stage commit`. `DB_TESTS_IN_SHARDS=1` comes from `gates`' job-level `env`.
- [x] 3.2 `.github/workflows/lifecycle.yml` gets the `db-shard` matrix job (`shard: [1, 2, 3]`)
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
  Evidence: `scripts/check-change.sh --only workflows,yaml` -> `PASS workflows actions pinned, token scoped`, `PASS yaml 105 YAML file(s) parse`. In `server/`, `npx vitest run --project integration --project pg --shard=<i>/3 --reporter=json` for i = 1..3 -> `shard 1 rc=0 Test Files 34 passed (34)`, `shard 2 rc=0 Test Files 33 passed | 1 skipped (34)`, `shard 3 rc=0 Test Files 33 passed (33)`; file sets from the JSON reports -> `sizes [34, 34, 33] union 101 overlap 0`. The Select step's `run:` was extracted from the workflow with PyYAML and run (`bash -e`) against a fake `scripts/check-change.sh`: `skip: no db_test_paths changed`/0 -> `run=false`; `run: ...`/0, empty/0, `garbage`/0, two lines (`warning...` + `skip: ...`)/0 and `skip:no`/0 -> `run=true`; `skip: ...`/exit 1 -> step rc=1. Loading the workflow: `db-tests if: ${{ !cancelled() && (github.event_name == 'pull_request' || github.ref == 'refs/heads/supabase-migration') }}`, which is `db-shard`'s condition plus `!cancelled()`. Storage pg runs unsharded on shard 1 (`if: ... && matrix.shard == 1`). Implementation note: the server command uses `--shard=${{ matrix.shard }}/${{ strategy.job-total }}`, so the count lives only in the matrix.
- [x] 3.3 Simulate the push run before merge. In a clone checked out at `origin/supabase-migration`
  with this branch's checker and vitest configs applied, run
  the push run's two halves:
  `env -u GITHUB_BASE_REF CI=1 GITHUB_EVENT_NAME=push FULL_TESTS=1 DB_TESTS_IN_SHARDS=1 scripts/check-change.sh --only commands,audit`
  (the `gates` step), and `... FULL_TESTS=1 scripts/check-change.sh --db-selection` (the `db-shard`
  decision). Check: the first exits 0 with `(pg/integration: db-tests job)`, and no `change`
  failure blocks it. The second prints `run: FULL_TESTS=1`. For contrast, `--stage commit` under the same env shows the "one
  change per branch" failure that the push path avoids.
  Evidence: fresh clone at `origin/supabase-migration` 415cca6b, with this branch's `check_change.py`, `openspec/config.yaml` and both vitest configs copied in, `npm ci`. `env -u GITHUB_BASE_REF CI=1 GITHUB_EVENT_NAME=push FULL_TESTS=1 DB_TESTS_IN_SHARDS=1 scripts/check-change.sh --only commands,audit` -> `PASS commands ran ['typecheck', 'test'] (pg/integration: db-tests job)`, `PASS audit ran ['audit']`, rc=0, 92s; same env `FULL_TESTS=1 --db-selection` -> `run: FULL_TESTS=1`, rc=0; contrast `--stage commit` -> `FAIL change one change per branch; found ['openspec/changes/archive/2026-09-30-infisical-secrets', ...`, `SKIP risk-floor blocked: change failed`, rc=1.
- [x] 3.4 On the PR's own CI run (it touches `scripts/`, so the shards run), record each
  `db-shard` job's duration and the `gates` duration next to the 509s baseline. Check: `gh api
  repos/:owner/:repo/actions/runs/<id>/jobs` shows 3 `db-shard` jobs, `db-tests` green, and the
  times recorded in the evidence.
  Evidence: PR #83, run 37607424547 (this branch touches `scripts/`, so every shard ran). `gh api repos/kwcantrell/autologger-2/actions/runs/37607424547/jobs` -> `db-shard (1): success 237s` (server 184s + storage pg 24s), `db-shard (2): success 126s` (server 95s), `db-shard (3): success 186s` (server 157s), `db-tests: success 3s`, `gates: failure 232s` ("Run lifecycle gates" 198s; failed only on `tasks`). `npm ci` took 18-19s per job. Wall clock went from about 9 min (gates job, "Run lifecycle gates" 509s in run 37578446349) to about 4 min (max of gates 232s and shard 1 237s). Per-shard server time ranges 95-184s: vitest balances by file count, so shards are uneven (design Risks).

## 4. Docs and ADR

- [x] 4.1 New ADR `docs/decisions/0026-select-db-tests-by-path.md`, with the measurements from
  1.1 and design.md as evidence. `docs/lifecycle.md` explains the selection, `db_test_paths`,
  `FULL_TESTS=1`, the shards (`db-shard`, `db-tests`, `DB_TESTS_IN_SHARDS`) and the post-merge run, and says
  the owner adds `db-tests` to the required checks. Check: `grep -n 'db_test_paths\|FULL_TESTS'
  docs/lifecycle.md docs/decisions/0026-*.md` hits both files.
  Evidence: new `docs/decisions/0026-select-db-tests-by-path.md` (Context, Decision, Evidence with the 509s / 1.8s / 597s / 92s numbers, Consequences); `docs/lifecycle.md` gains "### Which tests run (ADR 0026)" and `db_test_paths` in the base-read sentence. `grep -n 'db_test_paths\|FULL_TESTS' docs/lifecycle.md docs/decisions/0026-*.md` -> `docs/lifecycle.md:63,74,78,81,89`, `docs/decisions/0026-select-db-tests-by-path.md:5,18`.
- [x] 4.2 `docs/security.md` (the required-checks setup list, line ~25) and the header comment
  of `.github/workflows/lifecycle.yml` name `db-tests` among the required checks. Check:
  `grep -n 'db-tests' docs/security.md .github/workflows/lifecycle.yml` hits the setup line and
  the header.
  Evidence: `grep -n 'db-tests' docs/security.md .github/workflows/lifecycle.yml` -> `docs/security.md:26:   \`dependency-review\` and \`db-tests\` (the pg and integration tests, ADR 0026), code owner`, `.github/workflows/lifecycle.yml:1:# The enforced gates. Make the \`gates\`, \`secrets\`, \`dependency-review\` and \`db-tests\` jobs`.

## 5. Verify

- [x] 5.1 `scripts/check-change.sh --stage hook` passes on the branch, and its `commands` line
  shows `full` (this branch touches `scripts/lib/check_change.py`).
  Evidence: first attempt (load average 7-14, a concurrent agent `vitest run`) -> `FAIL commands \`npm test\` exited 1 (full: no db_test_paths on the base)`: `crossProcess.int.test.ts` timed out at 5000ms, `Tests 1 failed | 1657 passed`. The owner chose to push PR #83 with `--no-verify`. Retry on a quiet host (load average 0.94 at start, no other vitest running): `scripts/check-change.sh --stage hook` -> all PASS, including `PASS commands ran ['typecheck', 'test'] (full: no db_test_paths on the base)`, rc=0, 446s. `full` is right: the base `supabase-migration` has no `db_test_paths` yet, and this branch touches `scripts/lib/check_change.py`.
- [x] 5.2 The PR's CI run passes. `gates`' `commands` line shows `(pg/integration: db-tests job)`,
  and every `db-shard` shows `run:`.
  Evidence: PR #83, run 37607424547: every gate except `tasks` passed. `tasks` listed only the then-unticked 3.4, 5.1, 5.2 and the two owner items now moved below. `gates` -> `PASS commands ran ['typecheck', 'test'] (pg/integration: db-tests job)`, `PASS audit`, `WARN tests-with-code source changed without tests (overridden)` (label `no-test-needed`); each `db-shard` Select -> `run: no db_test_paths on the base`; shards -> `Test Files 34 passed (34)` + storage `3 passed (3)`, `33 passed | 1 skipped (34)`, `33 passed (33)`; `db-tests` success. `crossProcess.int.test.ts` passed in CI. An earlier run, 37607423603, was cancelled by the label-add re-trigger, and its `db-tests` shows `cancelled`, not failed (D5 `!cancelled()`). The push after this tick is the fully green run.

- [x] 5.3 After D3a, `scripts/check-change.sh --stage hook` on the branch passes without starting
  Postgres, and its `commands` line shows the local skip. Check: the run passes, the `commands`
  line shows `(pg/integration skipped: local run; ...)`, and it's quicker than 5.1's 446s.
  Evidence: `scripts/check-change.sh --stage hook` -> all PASS, `PASS commands ran ['typecheck', 'test'] (pg/integration skipped: local run; CI runs them on the PR, FULL_TESTS=1 runs them here)`, rc=0, 81s (5.1's full local run took 446s); `docker ps` -> no `supabase/postgres` container started during the run (`grep -c` -> 0).
- [x] 5.4 The PR's CI run after D3a passes, with `db-tests` green and `gates` all PASS. Check: `gh
  api .../runs/<id>/jobs` shows every job `success`.
  Evidence: PR #83, run 37610453938 (commit ef7be091): `dependency-review`, `secrets` and `db-shard (1|2|3)` succeeded (241s, 122s, 182s), and `db-tests` succeeded (4s). `gates` (213s) passed every gate except `tasks`: `FAIL tasks 1 unticked task(s)`, which was this task. The task was circular as written (CI can't pass until 5.4 is ticked), the same as 5.2. `gates` -> `PASS commands ran ['typecheck', 'test'] (pg/integration: db-tests job)`, `PASS audit`, `WARN tests-with-code (overridden)`. The push after this tick is the fully green run.

## Owner-owed, after merge (tracked here, done by the human; no checkboxes, so the tasks gate ignores them)

- After merge (was 3.5): the push run on `supabase-migration` runs all 3 shards with
  `FULL_TESTS=1`. Check: `gh run view <id> --log | grep 'run: FULL_TESTS=1'` hits each shard, and
  `db-tests` is green. Recorded in the archive PR.
- Before archive (was 4.3): add `db-tests` to the `main-protect` ruleset's required status
  checks. Check: `gh api repos/:owner/:repo/rulesets/19850235 --jq
  '.rules[]|select(.type=="required_status_checks")'` lists `db-tests` alongside `gates`,
  `secrets` and `dependency-review`.
