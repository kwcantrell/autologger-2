# Supabase Postgres and a migrations scaffold in every compose stack

Tier: 2
Tier reason: adds a database, its secret and a schema-migration runner to dev, stage and prod (migrations, secrets, production-critical).

Approved-by: Kalen 2026-09-30

## Why

ADR 0021 moves all storage to self-hosted Supabase, one instance per environment. Slice 1.2 was
split on 2026-09-30. This change is 1.2a. It puts the Supabase Postgres container into each
compose project, together with the `supabase/migrations/` convention and a runner. With those in
place:
- backups (1.3) have something to back up;
- the Supabase services (1.2b) have a database to run on;
- the catalog schema (slice 4) has somewhere to land.

## What Changes

- **A `db` service in dev, stage and prod.**
  - Image: `supabase/postgres`, pinned by digest.
  - Storage: named volumes, scoped per project.
  - Network: an internal-only network per environment, on a pinned subnet. The host gets no
    address on it, so nothing on the host can connect to Postgres.
  - Exposure: no host port.
- **A `migrate` one-shot.**
  - It applies `supabase/migrations/*.sql` in version order. Each file runs in one transaction,
    together with its record in `supabase_migrations.schema_migrations`, which uses the Supabase
    CLI's table shape. That transaction holds an advisory lock.
  - It refuses unsafe files before connecting: bad names, duplicate versions, psql
    meta-commands, and transaction-control statements.
  - It is idempotent and safe to run twice at once.
  - `make dev-up` and `make stage-up` run it after `db` is healthy. `make dev-migrate` runs it
    alone.
- **`make dev-psql`** opens psql in the dev `db`.
- **No run or exec against prod.** The compose wrapper refuses `compose run` and `compose exec`
  for prod, so no call can migrate prod or open a shell in its database.
- **A new key, `POSTGRES_PASSWORD`.**
  - It is a compose-interpolation key, allowed in every environment.
  - Its value must be at least 32 lowercase hex characters.
  - It reaches only `db` and `migrate`. The static check and the wrapper both fail if the value
    shows up anywhere in another service.
- **A committed generator, `docker/scripts/supabase-keys.mjs`.**
  - It creates missing Supabase secrets in an environment's Infisical project. In 1.2a that is
    only `POSTGRES_PASSWORD`; 1.2b extends the table.
  - It only creates keys: it never updates or overwrites one, and never prints a value.
  - It needs an identity that can write. The environment's read-only `viewer` identity can't.
- **BREAKING for operators.**
  - `make dev-reset` and `make stage-reset` now also delete that environment's Postgres.
  - Once the key is in an environment, a checkout older than this change (including the frozen
    `main`) refuses that environment's compose targets.
- **Static checks.** `check-envs.sh` learns the new services. A new invariant 16 covers the `db`
  network's isolation, pinned images, and where the password value appears.

## Decisions (owner, 2026-09-30)

- **The split:**
  - 1.2a `supabase-db` is this change.
  - 1.2b `supabase-services` adds auth, rest, realtime, storage, meta, studio and a gateway.
- **For 1.2b** (recorded here so that 1.2a doesn't contradict them):
  - The gateway is Caddy, using the legacy HS256 keys (`JWT_SECRET`, `ANON_KEY`,
    `SERVICE_ROLE_KEY`).
  - The gateway and Studio get their own `127.0.0.1` port per environment.
- **Secrets:**
  - A committed generator writes them to Infisical.
  - The agent runs it for dev and stage with the owner's bootstrap identity
    (`~/.infisical-bootstrap`).
  - The owner runs it for prod on the deploy host, as part of cutover.
- **No PAM.** Infisical PAM, dynamic secrets and secret rotation aren't on the owner's plan (org
  plan flags `pam: null`, `dynamicSecret: false`, `gateway: false`). Database credentials are
  therefore static, and adding those features later needs no redesign.

## Decisions (agent, from the panel, for the owner to confirm at approval)

- **Supabase's init SQL moves to 1.2b.** These are upstream's `roles.sql`, `jwt.sql`,
  `realtime.sql`, and the `webhooks.sql` that `roles.sql` depends on. They configure roles and
  settings for the 1.2b services. The panel showed that the planned subset fails initdb.
  - Dev and stage Postgres hold no data before slice 4, so 1.2b resets them at no cost.
  - Prod's `db` isn't started before cutover.
  - The question of whether the service roles get a password separate from the superuser's
    moves to 1.2b as well.
- **The prod key waits for cutover.** `POSTGRES_PASSWORD` is added to Infisical `prod` only at
  cutover, after `main` allows it. Adding it earlier would make the frozen `main` refuse every
  `make prod-*` target.

## Non-goals

- The Supabase services other than Postgres, their init SQL, `JWT_SECRET`, the anon and
  service-role keys, and any gateway or Studio. All are 1.2b.
- Connecting `api`/`app` to Postgres, or any schema migration beyond the empty scaffold
  (slice 4).
- Backups (1.3) and retiring host dev (1.4).
- Running migrations against prod, or adding the prod key before cutover (slice 11, cutover
  runbook). Prod gets the `db` definition, which `make check` checks statically.
- Publishing Postgres on any host port. Host access is `make dev-psql` only.
- A stage-only migrate target. `stage-up` migrates.
- Automating `POSTGRES_PASSWORD` rotation, which is documented as a manual procedure.
- Porting `check-envs.sh` to Node (that is `node-stack-tooling`).

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `container-deployment`:
  - Compose topology gains `db` and the `migrate` tool service.
  - The `db` network is isolated from the host.
  - The password value is confined to `db`/`migrate`.
  - Tool services are exempt from the always-up operability rules.
  - Third-party images are pinned by digest.
- `local-container-environments`:
  - Makefile entry points gain migrate-on-up, `dev-migrate`, `dev-psql` and the prod run/exec
    refusal, and a reset now deletes Postgres.
  - The dev bind exceptions add the runner script and the migrations directory.
  - Coexistence covers the new subnets.
  - Allowed names gain `POSTGRES_PASSWORD`, with its format and the cutover ordering.
  - The static check gains invariant 16.
  - Two new requirements cover the migrations runner and the secret generator.

## Impact

- **New files:**
  - `docker/supabase-db.yaml`;
  - `docker/supabase/migrate.sh` and `docker/supabase/test_migrate.sh`;
  - `docker/scripts/supabase-keys.mjs` and its test;
  - `supabase/migrations/.gitkeep`;
  - `docs/supabase.md`.
- **Changed files:**
  - `compose.yaml`, `docker/compose.dev.yaml`, `docker/compose.stage.yaml` (the `db` network);
  - `docker/scripts/compose-env.sh` (one more `-f`);
  - `docker/scripts/compose-run.mjs`: `COMPOSE_KEYS`, the password format, the prod run/exec
    refusal, and the value-leak check on the resolved config;
  - `docker/scripts/check-envs.sh` and `test_check_envs.sh`;
  - `package.json` (`test` script);
  - `Makefile`, `README.md`, `docs/infisical-secrets.md`;
  - the ADR 0021 slice list.
- **Infisical:** `POSTGRES_PASSWORD` is added to `autologger-dev` and `autologger-stage` (agent),
  and to `autologger-prod` at cutover (owner).
- **Resources:** one more always-on container per running stack (Postgres, a few hundred MB of
  RAM).
- **Unchanged:** the HTTP/WS contract and the app containers' environment.
