# prod-up applies the migrations before it starts prod

Tier: 2
Tier reason: it runs schema migrations against the production database, which can't be undone,
and lifts a guard (supabase-db D6, "nothing migrates prod") that the compose wrapper enforces in
code; secrets (`POSTGRES_PASSWORD`, `APP_DB_PASSWORD`) reach a new prod container.

## Why

The first prod deploy on Linode (2026-10-07, `make prod-up` from a clean `main`) brought up an
empty Postgres. Nothing applied `supabase/migrations/`, so there was no
`supabase_migrations` schema and no `autologger_app` role, and `api` crash-looped with
`Role "autologger_app" does not exist`.

Dev and stage don't have this problem: `dev-up` and `stage-up` run `compose run --rm migrate`
once `db` is healthy and before `compose up -d`. The runner applies every unrecorded migration
and then sets the `autologger_app` password from `APP_DB_PASSWORD` (stage printed `8 applied`
and `app role password set`).

Prod already has everything else this needs:
- the prod project includes `docker/supabase-db.yaml`, so its `migrate` service exists (check-envs
  invariant 16 asserts it);
- `SECRET_SCOPE` already allows `POSTGRES_PASSWORD` and `APP_DB_PASSWORD` in prod's `migrate`.

What's missing is the step itself. supabase-db D6 kept it out on purpose: no prod target ran
`migrate`, and the wrapper refused every prod `compose run` and `compose exec`. With prod now on
Postgres, that guard stops the app from starting at all.

## What changes

- **`make prod-up`** runs `'compose run --rm migrate'` after the existing guards (`prod-git`,
  `prod-tags`, `resolved`) and before `'compose up -d'`, exactly as `stage-up` does. A failed
  migration stops the target before `up`.
- **The compose wrapper** (`docker/scripts/compose-run.mjs`) runs only the exact prod compose
  steps the Makefile uses, now including `run --rm migrate`; anything else (`exec`, global
  flags such as `-f`, other services, extra words) is refused before any request. The migrate
  step also needs `prod-tags` and `resolved` earlier in the plan, and the wrapper itself checks
  for a clean `main` tree right before it.
- **Tests:** `compose-run.test.mjs` pins what's allowed and refused. `test_check_envs.sh`'s tree
  snapshot is fixed so the suite runs on a tree with more files than one `tar` call takes (see
  design D4).
- **Specs and docs:** the `container-deployment` and `local-container-environments` specs,
  `docs/supabase.md` and the README say that `prod-up` migrates, and what that means for
  rollback.

## Not changing

- `migrate.sh`, the `migrate` service and the secret scopes: prod reuses stage's runner as is.
- `prod-check` and `prod-pull` (`prod-check` still starts nothing; `prod-pull` still pulls).
- `prod-down` and `prod-logs`, and the refusals of `reset` and of the test hooks for prod.

## Non-goals

- No `prod-migrate` or `prod-psql` target. A shell against prod stays refused, and the
  migrate step runs only after the `prod-tags` and `resolved` guards on a clean `main`.
- No check that the checkout's HEAD matches `API_TAG`. Migrations come from the `main` checkout
  that `prod-up` already requires, as before (design D3).
- No SQLite-to-Postgres data copy for prod, no backup step (design D6), and no down-migrations.
- No change to the demo rows two migrations seed (design A8; open for the owner).
- No change to the deploy host's Ansible (`spark-infra`): it already runs `make prod-up`.

## Impact

- `Makefile`, `docker/scripts/compose-run.mjs`, `docker/scripts/compose-run.test.mjs`,
  `docker/scripts/test_check_envs.sh`.
- `docs/supabase.md`, `README.md`.
- Specs: `local-container-environments` (Makefile entry points; prod targets),
  `container-deployment` (compose topology).
