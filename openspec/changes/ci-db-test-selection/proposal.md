# Run the pg and integration tests only when a PR touches the paths they exercise

Tier: 2
Tier reason: changes the lifecycle itself: `scripts/lib/check_change.py`, `.github/workflows/lifecycle.yml` and `openspec/config.yaml` are all high-risk paths.

Approved-by: Kalen 2026-10-07 (reapproved)

## Why

The `gates` CI job takes about 8.5 minutes (509s for "Run lifecycle gates" in the last green run),
and almost all of it is `npm test` and `npm run typecheck`. The script's own file checks take under
2 seconds. Every PR pays that cost even when nothing it changes can affect a database test: of
the last 40 merged PRs, 27 touched only `openspec/` (mostly archive PRs). The `pg` and
`integration` vitest projects start the pinned `supabase/postgres` image and clone a catalog per
test. These are the slow tests, and they only exercise `server/`, `packages/`, `supabase/`,
`test/pg/`, `docker/` and `fixtures/`.

## What Changes

- **New `lifecycle.db_test_paths` in `openspec/config.yaml`.** It holds globs for the paths the
  pg and integration tests depend on, plus the files that decide the selection (the checker, the
  workflow, the vitest configs, root `package.json`/`package-lock.json`). Like `test_globs`, a PR's
  own gates read this list from the merge-base, so a PR can't shrink it to skip its own tests.
- **`scripts/lib/check_change.py`, `commands` gate.** Whenever the gate runs (any stage, or
  `--only`) on a pull request or locally, if a base is known and no changed file matches
  `db_test_paths`, the test command runs with `SKIP_DB_TESTS=1`. The gate's message says the pg
  and integration projects were skipped and why, and that line is printed even under `--quiet`,
  so pre-push shows it. In every other case (any match, no base, a non-PR CI run, or
  `FULL_TESTS=1`), the full suite runs as today. In CI, the DB tests always run in `db-shard`
  instead (see the sharding bullet), and `gates` runs typecheck, unit tests and audit.
- **`server/vitest.config.ts` and `packages/storage/vitest.config.ts`.** When `SKIP_DB_TESTS=1`,
  the `integration` and `pg` projects are left out of `test.projects`. Unit projects always run.
  Without the variable, nothing changes.
- **`.github/workflows/lifecycle.yml`: full suite after merge.** `push` also triggers on
  `supabase-migration`, the branch PRs merge into. A push to `supabase-migration` runs only
  `FULL_TESTS=1 scripts/check-change.sh --only commands,audit` in `gates` (typecheck, unit tests,
  audit; `gates` carries `DB_TESTS_IN_SHARDS=1` as job-level env), plus all three `db-shard`s with `FULL_TESTS=1` for the DB tests. It skips the commit stage, which
  has no PR base on a push and would diff the branch against `main`. A push to `main` keeps
  today's `--stage commit`. Today no push runs any tests. Nobody waits on this run. It catches
  anything the path list missed.
- **Sharded DB tests in CI (re-approval delta).** In CI the pg and integration projects move out
  of the `gates` job into a `db-shard` matrix job with 3 shards. Each shard runs
  `vitest run --project integration --project pg --shard=<i>/3` in `server/` on its own runner,
  with its own Postgres container. Shard 1 also runs `packages/storage`'s 3 pg files, unsharded. Each shard asks the checker for the same path decision
  (`scripts/check-change.sh --db-selection`). If the answer is `skip`, it stops after checkout
  and the PyYAML install, before `npm ci` or the Postgres image pull. A `db-tests` job waits for all shards and gives one stable
  required-check name. The `gates` job sets `DB_TESTS_IN_SHARDS=1`, so its `commands` gate runs
  typecheck and unit tests only and says the DB tests ran in `db-tests`. Pushes to
  `supabase-migration` shard the same way with `FULL_TESTS=1`. Locally, nothing is sharded: the
  hook stage still runs the DB tests in-process (or skips them by path).
- **Docs.** `docs/lifecycle.md` explains the selection, the shards and `FULL_TESTS=1`. The AGENTS.md commands
  table gets no new row (the gate's message is self-describing).

Typecheck, unit tests and `npm audit` still run on every PR.

## Capabilities

### New Capabilities

None. The lifecycle gates have no OpenSpec capability (they are described in `docs/lifecycle.md`
and ADRs), so this change sets `skip_specs: true`, as `retire-size-budget-and-minors` did.

### Modified Capabilities

None.

## Non-goals

- Sharding locally, sharding unit tests or typecheck, running the 14 workspaces concurrently, test
  caching, or making the pg/integration tests themselves faster.
- Balancing shards by duration. Vitest shards by file, and the shard count is a fixed 3.
- Editing the GitHub ruleset as the agent. Adding `db-tests` to `main-protect`'s required checks
  is the owner's action, tracked as task 4.3 and done before archive.
- Selecting unit tests or typecheck by path. They stay unconditional.
- Retiring or changing any other gate (`artifacts-first`, `tests-with-code` and the rest). Those
  are separate decisions.
- Branch protection on `supabase-migration`, or making the post-merge run a required check.
- `.claude/settings.json` and `.claude/hooks/` (human-only). `stop-check.sh` keeps calling
  `--stage hook` and picks up the selection with no edit.

## Impact

- `scripts/lib/check_change.py`, `openspec/config.yaml`, `.github/workflows/lifecycle.yml`,
  `server/vitest.config.ts`, `packages/storage/vitest.config.ts`, `docs/lifecycle.md`, and a new
  ADR in `docs/decisions/` (AGENTS.md rule 10).
- PRs that touch only `web/`, `companion/`, `openspec/`, `docs/` or `.claude/` skip the pg and
  integration projects. Every other PR runs them split over 3 parallel runners instead of one.
- CI minutes go up. Each shard pays its own checkout, `npm ci` and Postgres image pull, and each
  merge now runs a full suite on `supabase-migration`. Wall-clock time per PR goes down.
- Check names change. `gates` no longer covers the DB tests. `db-tests` does, and needs adding
  to the ruleset's required checks (task 4.3). `docs/security.md` and the workflow header, which
  list the required checks, are updated (task 4.2).
