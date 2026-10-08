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

- [ ] 1.1 Record the base results of `node --test docker/scripts/compose-run.test.mjs`, `make check` and `sh docker/scripts/test_check_envs.sh`.

## 2. Snapshot fix (D4)

- [ ] 2.1 Test first: the baseline's failing "clean tree passes" case is the failing test. Give the snapshot's reader `tar` `--ignore-zeros`, and rerun the suite.

## 3. Wrapper (D2)

- [ ] 3.1 Test first: unit cases in `compose-run.test.mjs` for a new `checkProdPlan` (D2): it accepts each Makefile prod step and the full `prod-up` plan; it refuses `exec`, `run migrate`, `run --rm migrate sh`, `run --rm db`, `--profile tools run migrate`, `-f x.yaml up -d`, `up -d migrate`, `cp`, and `run --rm migrate` without `prod-tags` and `resolved` before it. The existing "prod refuses compose run and exec" case keeps only refused steps; no test calls the wrapper with an allowed prod step (a prod deploy checkout has real prod credentials). Then add `checkProdPlan` and call it from `main()` in place of the inline check.
- [ ] 3.2 Test first: unit cases for a new `checkProdTree(root)` (D5) on temp git repos: clean `main` passes; a modified file, an untracked file, and another branch are refused. Then add it and call it in `runSteps` right before the `run --rm migrate` step.

## 4. Makefile (D1)

- [ ] 4.1 Test first: a `compose-run.test.mjs` case that reads the `prod-up` recipe from the `Makefile` and asserts its steps are `prod prod-tags resolved 'compose run --rm migrate' 'compose up -d'`, after `prod-git`, and that no other prod target has a `run` or `exec` step. Then change `prod-up` and its help text.

## 5. Docs

- [ ] 5.1 `docs/supabase.md` (Commands table and the prod paragraph), README (make table, Update order and rollback: `prod-up` migrates from the `main` checkout, no backup is taken first, rollback means the last nightly dump), and the comment in `compose-run.mjs`. Completion check: `grep -rn -i "nothing migrates prod\|No prod target runs" README.md docs docker` finds nothing.

## 6. Verify

- [ ] 6.1 `node --test docker/scripts/compose-run.test.mjs`, `make check`, `sh docker/scripts/test_check_envs.sh`, `openspec validate --all --strict` and `scripts/check-change.sh --stage hook` pass.
