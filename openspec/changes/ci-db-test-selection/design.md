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
  says so in the gate output.
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

Otherwise it runs the full suite. The gate message names the outcome, for example
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
`supabase-migration` runs only `FULL_TESTS=1 scripts/check-change.sh --only commands,audit`.
A push to `main` keeps `--stage commit`, and PRs keep `--stage pr`.

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

## Assumptions

| Assumption | Command | Observed |
| --- | --- | --- |
| The script's own file checks are negligible | `time scripts/check-change.sh --only openspec,yaml,workflows,skills-sync,guide-size,change,risk-floor,approval,panel,tasks,evidence,artifacts-first,tests-with-code` | `real 0m1.789s` |
| The gates step is ~8.5 min in CI | `gh api .../actions/runs/<last green>/jobs` | `Run lifecycle gates: 509s` |
| Most merged PRs touch no DB path | `gh pr list --state merged --limit 40 --json files` | 27 of 40 touched only `openspec/` |
| Only server and storage define pg/integration projects | `ls */vitest.config.ts packages/*/vitest.config.ts` | `companion`, `packages/storage`, `server`, `web`. The companion and web configs have no `projects` |
| Integration tests read `fixtures/` | `grep -rln 'fixtures/' server/src --include=*.int.test.ts` | `sessionHub.interleave`, `transcribe`, `sessions.youtubeImport` |
| The pg image is pinned under `docker/` | `grep -n supabase-db test/pg/globalSetup.ts` | `Runs the image pinned in docker/supabase-db.yaml` |
| pg/integration dominate test time | `time npx vitest run --project <p>` per project, plus web tests and `npm run typecheck`, on this host, 2026-10-07 | server integration 511s (exit 1, see tasks 1.1), server pg 35s, storage pg 51s: 597s of DB tests. Server unit 21s, storage unit 2s, web 49s, typecheck 24s |

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

## Migration Plan

Lands as one PR. Rollback is reverting that PR. With `db_test_paths` absent from the base config,
the gate always runs the full suite, so the first PR (and any revert) runs fully.
