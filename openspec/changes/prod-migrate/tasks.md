# Tasks

**Branch and commits**
- The first commit on `prod-migrate` holds only `openspec/changes/prod-migrate/`.
- The PR targets `main`.

**Commands**
- `node --test docker/scripts/compose-run.test.mjs`
- `make check` and `sh docker/scripts/test_check_envs.sh`
- `scripts/check-change.sh --stage hook`
- Nothing runs against a real prod or stage stack, and nothing writes to OpenBao.

## 1. Baseline

- [x] 1.1 Record the base results of `node --test docker/scripts/compose-run.test.mjs`, `make check` and `sh docker/scripts/test_check_envs.sh`.
  - Evidence: base `3cbea66`. `node --test docker/scripts/compose-run.test.mjs` -> `ℹ tests 72` `ℹ pass 72` `ℹ fail 0`; `make check` -> `check-envs: ok (all)`; `sh docker/scripts/test_check_envs.sh` -> `FAIL clean tree passes (wanted ok, got fail)` ... `xargs: tar: terminated by signal 13` ... `test_check_envs: 48 passed, 1 failed`.

## 2. Snapshot fix (D4)

- [x] 2.1 Test first: the baseline's failing "clean tree passes" case is the failing test. Give the snapshot's reader `tar` `--ignore-zeros`, and rerun the suite.
  - Evidence: red is the 1.1 baseline (`48 passed, 1 failed`, the snapshot had no `server/`). After `tar --ignore-zeros -xf -`: `sh docker/scripts/test_check_envs.sh` -> `test_check_envs: 49 passed, 0 failed` (log `pm-logs/2.1-green.log`, `6-tce.log`).

## 3. Wrapper (D2)

- [x] 3.1 Test first: unit cases in `compose-run.test.mjs` for a new `checkProdPlan` (D2): it accepts each Makefile prod step and the full `prod-up` plan; it refuses `exec`, `run migrate`, `run --rm migrate sh`, `run --rm db`, `--profile tools run migrate`, `-f x.yaml up -d`, `up -d migrate`, `cp`, and `run --rm migrate` without `prod-tags` and `resolved` before it. The existing "prod refuses compose run and exec" case keeps only refused steps; no test calls the wrapper with an allowed prod step (a prod deploy checkout has real prod credentials). Then add `checkProdPlan` and call it from `main()` in place of the inline check.
  - Evidence: red: `node --test docker/scripts/compose-run.test.mjs` -> `ℹ pass 71` `ℹ fail 4` (`✖ accepts exactly the Makefile prod steps...`, `✖ prod refuses compose run and exec before any request, except the guarded migrate step`; `checkProdPlan` not exported) (log `pm-logs/3-red.log`). Green after `checkProdPlan`: the two older black-box cases that used a prod `compose version` and `reset 'compose down -v'` now use `prod-tags` and `reset` alone, plus a case that `compose down -v` is refused for prod -> `ℹ pass 74` `ℹ fail 1` (only the Makefile case, task 4.1) (log `pm-logs/3-green.log`).
- [x] 3.2 Test first: unit cases for a new `checkProdTree(root)` (D5) on temp git repos: clean `main` passes; a modified file, an untracked file, and another branch are refused. Then add it and call it in `runSteps` right before the `run --rm migrate` step.
  - Evidence: red in `pm-logs/3-red.log` -> `✖ the migrate step needs a clean tree on main`; green after `checkProdTree` (called in `runSteps` before the prod `run --rm migrate` step) -> the case passes in `pm-logs/3-green.log`.

## 4. Makefile (D1)

- [x] 4.1 Test first: a `compose-run.test.mjs` case that reads the `prod-up` recipe from the `Makefile` and asserts its steps are `prod prod-tags resolved 'compose run --rm migrate' 'compose up -d'`, after `prod-git`, and that no other prod target has a `run` or `exec` step. Then change `prod-up` and its help text.
  - Evidence: red in `pm-logs/3-green.log` -> `✖ prod-up runs the migrate step after the guards and before up`; after the Makefile change `node --test docker/scripts/compose-run.test.mjs` -> `ℹ pass 75` `ℹ fail 0` (log `pm-logs/4-green.log`); `make help` -> `prod-up            Clean main only: migrate the prod Postgres, then start prod ...`.

## 5. Docs

- [x] 5.1 `docs/supabase.md` (Commands table and the prod paragraph), README (make table, Update order and rollback: `prod-up` migrates from the `main` checkout, no backup is taken first, rollback means the last nightly dump), and the comment in `compose-run.mjs`. Completion check: `grep -rn -i "nothing migrates prod\|No prod target runs" README.md docs docker` finds nothing.
  - Evidence: `docs/supabase.md` (Commands row and prod paragraph), README (make table; "Update order and rollback": `prod-up` migrates first, no backup, nightly dump; prod-linode has `stage_db_backup_project: autologger`), `compose-run.mjs` header. `grep -rn -i "nothing migrates prod\|No prod target runs" README.md docs docker` -> no output (exit 1).

## 6. Verify

- [x] 6.1 `node --test docker/scripts/compose-run.test.mjs`, `make check`, `sh docker/scripts/test_check_envs.sh`, `openspec validate --all --strict` and `scripts/check-change.sh --stage hook` pass.
  - Evidence: `node --test docker/scripts/compose-run.test.mjs` -> `ℹ tests 75` `ℹ pass 75` `ℹ fail 0`; `make check` -> `check-envs: ok (all)`; `sh docker/scripts/test_check_envs.sh` -> `test_check_envs: 49 passed, 0 failed`; `openspec validate --all --strict` -> `Totals: 27 passed, 0 failed (27 items)`; `scripts/check-change.sh --stage hook` -> every gate PASS except `evidence` (this line was missing), `commands` -> `ran ['typecheck', 'test'] (pg/integration skipped: local run; CI runs them on the PR)` (logs `pm-logs/6-*.log`); rerun with this line -> exit 0, every gate PASS (`pm-logs/6-hook2.log`). Nothing ran against real prod or stage, and nothing wrote to OpenBao.
