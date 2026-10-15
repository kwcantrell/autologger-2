# Design: prod-migrate

## Context

- `compose_prod` resolves `compose.yaml` + `docker/supabase-db.yaml` +
  `docker/supabase-services.yaml` (`docker/scripts/compose-env.sh`). The `migrate` service in
  `docker/supabase-db.yaml` is profile `tools`, so `up` never starts it; `compose run` does.
- `stage-up` is `resolved 'compose run --rm migrate' 'compose up -d ...'` (Makefile
  `STAGE_UP_STEPS`); dev-up the same.
- `compose-run.mjs` `main()` refuses any prod plan with a `run` or `exec` word, before any
  request (supabase-db D6).
- `prod-up` is `@$(G) prod-git` then `$(RUN) prod prod-tags resolved 'compose up -d'`.

## Decisions

### D1. `prod-up` runs the runner between the guards and `up`

```make
prod-up:
	@$(G) prod-git
	$(RUN) prod prod-tags resolved 'compose run --rm migrate' 'compose up -d'
```

- The guards keep their order (`prod-git`, `prod-tags`, `resolved`); each fails before docker
  runs.
- `compose run` starts only `migrate`'s dependency `db` and waits for it to be healthy. The
  runner exits non-zero on a failed file, and the wrapper stops at the first failed step (H8),
  so `up` doesn't start an `api` against a half-migrated schema.
- A re-run is safe: recorded versions are skipped (`0 applied`), and the app role's password is
  set again to the same value.
- On an existing prod stack, `run` may start or recreate `db` before the runner, as `up -d`
  would; it touches no other service.

### D2. The wrapper runs only the prod compose steps the Makefile uses

A new exported `checkProdPlan(plan)` replaces the inline run/exec check in `main()`. It runs
before any request. For prod, every compose step's words SHALL be exactly one of:

| Step | Target |
| --- | --- |
| `config --quiet` | `prod-check` |
| `pull` | `prod-pull` |
| `run --rm migrate` | `prod-up` |
| `up -d` | `prod-up` |
| `down` | `prod-down` |
| `logs -f --tail=200` | `prod-logs` |

Anything else is refused: `exec`, global flags (`-f`, `--project-directory`, `--profile`), a
named service on `up`, `cp`, `run migrate` without `--rm`, `run --rm migrate sh`, `run --rm db`.
This closes more than the run/exec deny-list did: today a hand-written
`compose -f /tmp/o.yaml up -d migrate` reaches docker with the prod secrets.

The `run --rm migrate` step is also refused unless the plan has `prod-tags` and `resolved`
before it, so a hand-written wrapper call can't migrate prod without the tag and secret-scope
guards. `migrate`'s entrypoint is fixed (`sh /migrate.sh`), and no extra word can reach it.

### D5. The wrapper checks the tree right before migrating

`migrate` bind-mounts `./supabase/migrations` and `./docker/supabase/migrate.sh` from the
working tree, and the Makefile's `prod-git` runs in a separate process before the wrapper.
So `runSteps` calls a new exported `checkProdTree(root)` immediately before the
`run --rm migrate` step: `git status --porcelain` must be empty and the branch must be `main`,
the same rules as `prod-git`. A hand-written wrapper call from a dirty tree or another branch is
refused, and the window between the check and the run is the OpenBao login only, not the whole
make recipe.

### D6. No backup step; rollback means the last dump

`prod-up` takes no backup before migrating (non-goal). The only prod Postgres backup is the deploy
host's nightly dump (spark-infra `stage_db_backup` on the prod host, 03:30). README "Update order
and rollback" says so: undoing a migration means restoring that dump and losing the writes made
since. A pre-deploy dump belongs in the deploy host's Ansible, before `make prod-up`; it is a
follow-up there, for the owner to decide.

### D3. Migrations come from the `main` checkout

`prod-git` requires a clean `main`, so `supabase/migrations/` and `migrate.sh` are `main`'s
committed files. The images are pinned separately (`API_TAG`). A deploy that pins an older
`API_TAG` than `main` therefore runs `main`'s migrations under older code. That is already the
contract: migrations are forward-only and must leave the previous `api` working (README "Update
order and rollback"). This change doesn't add a HEAD-equals-`API_TAG` check (non-goal); the
README now says that `prod-up` applies `main`'s migrations, so re-pinning an older tag is safe
only while no newer migration exists.

### D4. `test_check_envs.sh` snapshot

`snapshot()` pipes `git ls-files -z | xargs -0 tar -cf -` into one `tar -xf -`. With more paths
than one command line holds, `xargs` runs `tar -c` several times, and the reader stops at the
first archive's end marker: later files are missing, and the "clean tree passes" case fails on
a clean `main`. The reader gets `--ignore-zeros` (`-i`), which reads the concatenated archives.

## Assumptions

- **A1. The prod project already has `migrate`, with both passwords in scope.**
  `make check` -> `== prod (autologger)` ... `check-envs: ok (all)`; check-envs invariant 16
  (`check-envs.sh:202`) requires `.services.db and .services.migrate` for prod.
  `grep -n "APP_DB_PASSWORD: {" docker/scripts/compose-run.mjs` ->
  `APP_DB_PASSWORD: { dev: ['app', 'migrate'], stage: ['api', 'migrate'], prod: ['api', 'migrate'] },`.
- **A2. `resolved` sees `migrate`.** `resolveConfig` runs
  `--profile '*' config --no-env-resolution --format json` (`compose-run.mjs:677`), so the
  secret-scope check already covers prod's `migrate`.
- **A3. `compose run --rm migrate` works without `--profile`.** It is stage's step
  (`Makefile:39,41`), and stage's deploy printed `8 applied` and `app role password set`
  (2026-10-07).
- **A4. The runner is idempotent.** `docker/supabase/test_migrate.sh:71` "a rerun applies
  nothing" (`^0 applied`) and `:72` "a rerun leaves the record count unchanged".
- **A5. A failed step stops the plan.** `runSteps`: `if (code !== 0) return code; // H8`
  (`compose-run.mjs`).
- **A6. `migrate` needs no separate pull.** It uses `db`'s digest-pinned image (the
  `x-image: &image` anchor in `docker/supabase-db.yaml`), which `prod-pull`'s `compose pull`
  already fetches for `db`.
- **A8. Every migration is fit for prod.** Not true as is: two migrations seed demo rows.
  `grep -n -i "insert into" supabase/migrations/*` -> `20261001000000_catalog_schema.sql:103`
  inserts show `show-autolog-test` into team `test-studios`; `20261004000000_team_owner.sql:16`
  inserts teams `test-studios` ("Test Studio") and `test-studio-2`. Those rows will exist on prod
  after the first `prod-up`, and the bootstrap owner's first sign-in claims ownerless teams.
  This change doesn't alter them (applied migrations are final); see Risks.
- **A7. The snapshot bug is real and only the reader is wrong.** On this tree,
  `git ls-files -co --exclude-standard | wc -l` -> `4003`; the snapshot pipeline prints
  `xargs: tar: terminated by signal 13`, and the copy has no `server/`.

## Risks

- **An older `API_TAG` under newer migrations** (D3). Mitigation: the forward-only rule, now
  stated next to `prod-up`.
- **A migration that fails on prod data** stops `prod-up` before `up`. The old containers keep
  running (only `db` may have been started or recreated), and the failed file left nothing
  behind.
- **Demo rows on prod** (A8). The first `prod-up` creates "Test Studio", "Test Studio 2" and
  "Autolog Test Show", and the bootstrap owner then owns them. Removing them is an owner
  decision: a later migration, or deleting them in the app. Open for the owner.
- **No fresh backup** (D6): a bad migration rolls back to the last nightly dump.
- **A long migration** holds `prod-up` up to the runner's 15-minute statement timeout per file.

## Rollback

Revert the Makefile line and the wrapper check. Applied migrations stay applied; restore a
backup to undo them (README "Update order and rollback").
