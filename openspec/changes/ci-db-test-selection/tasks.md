# Tasks

The first commit on this branch is `openspec/changes/ci-db-test-selection/` only (AGENTS.md rule 6).
The checker has no test suite in this repo, so each checker task names the command that shows
the old behavior before the change and the new behavior after it.

## 1. Vitest configs honor SKIP_DB_TESTS

- [ ] 1.1 Record the baseline split: time `npx vitest run --project <p>` for `unit`,
  `integration` and `pg` in `server/`, `unit` and `pg` in `packages/storage/`, plus the full
  `npm test` and `npm run typecheck`. Fill the TIMING row in design.md's Assumptions table. Check:
  the row holds measured seconds.
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

## 3. CI runs the full suite after merge

- [ ] 3.1 `.github/workflows/lifecycle.yml`: `push.branches: [main, supabase-migration]`. A push to
  `supabase-migration` runs only `FULL_TESTS=1 scripts/check-change.sh --only commands,audit`. A
  push to `main` keeps `--stage commit`, and PRs keep `--stage pr`. Actions stay SHA-pinned.
  Check: `scripts/check-change.sh --only workflows,yaml` passes, and loading the workflow with
  `python3 -c` shows both branches and the per-ref command.
- [ ] 3.2 Simulate the push run before merge. In a clone checked out at `origin/supabase-migration`
  with this branch's checker and vitest configs applied, run
  `env -u GITHUB_BASE_REF CI=1 GITHUB_EVENT_NAME=push FULL_TESTS=1 scripts/check-change.sh --only commands,audit`.
  Check: it exits 0, the `commands` line says `full`, and the pg/integration projects ran (no
  `change` failure blocks it). For contrast, `--stage commit` under the same env shows the "one
  change per branch" failure that the push path avoids.
- [ ] 3.3 After the PR merges, the push run on `supabase-migration` shows the full suite. Check:
  `gh run view <id> --log | grep 'PASS  commands'` shows `full`. Owner-visible. Tick after merge,
  with evidence.

## 4. Docs and ADR

- [ ] 4.1 New ADR `docs/decisions/0026-select-db-tests-by-path.md`, with the measurements from
  1.1 and design.md as evidence. `docs/lifecycle.md` explains the selection, `db_test_paths`,
  `FULL_TESTS=1` and the post-merge run. Check: `grep -n 'db_test_paths\|FULL_TESTS'
  docs/lifecycle.md docs/decisions/0026-*.md` hits both files.

## 5. Verify

- [ ] 5.1 `scripts/check-change.sh --stage hook` passes on the branch, and its `commands` line
  shows `full` (this branch touches `scripts/lib/check_change.py`).
- [ ] 5.2 The PR's CI run passes, and its `commands` line shows `full`.
