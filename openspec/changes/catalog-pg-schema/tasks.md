# Tasks

The first commit on `supabase-4a-catalog-pg-schema` is `openspec/changes/catalog-pg-schema/`
only. The PR targets `supabase-migration`. Gates run with `GITHUB_BASE_REF=supabase-migration`.

Logs: keep the full output of every test and gate run under the session scratchpad as
`4a-<task>-<red|green>.log`, and name the log in each `Evidence:` line.

## 1. Test Postgres (design D6)

- [x] 1.1 Test first: `test/pg/globalSetup.test.ts`, run by the server `unit` project (its
  `include` gains `../test/pg/*.test.ts`), with an injected `docker` stub. Cases:
  Evidence: `4a-1.1-red.log`: `npx vitest run --project unit ../test/pg` -> `Failed to load
  ./globalSetup`, `Tests  no tests`; `4a-1.1-pg-red.log`: `npx vitest run --project pg` -> setup
  ran (8.1 s), `password authentication failed for user "autologger_app"`, `Tests  2 failed (2)`.
  - a failing `docker info` rejects with the daemon message;
  - the `run`/`exec` argv carries no password and publishes only on `127.0.0.1`;
  - stale reaping removes only containers whose labelled pid is dead.

  Also `server/src/test/pg/harness.pg.test.ts`: a row inserted in one test's database is absent
  in another's.

  Red: modules missing.

- [x] 1.2 Write `test/pg/globalSetup.ts` and `test/pg/testDb.ts`, add the server `pg` vitest
  project (`src/**/*.pg.test.ts`, `globalSetup`), and add `postgres` 3.4.9 as a root
  devDependency. The setup:
  Evidence: `4a-1.2-green.log`: `Tests  3 passed (3)` (unit); `4a-3.2-pg-green.log`: `Tests  16
  passed (16)` (pg, harness cases included); `check_change.matches('test/pg/globalSetup.ts',
  ['**/test/**'])` -> `True`; `npx vitest list --filesOnly` -> `[pg] src/test/pg/harness.pg.test.ts`,
  `[unit] ../test/pg/globalSetup.test.ts`.
  - pulls the image with a 10-minute timeout;
  - runs it with the stack's `db` command plus `max_connections=300`;
  - waits for the TCP query to succeed twice;
  - creates the template database and runs `migrate.sh` on both databases.

  Green: 1.1. Confirm with `check-change.sh --only size` that `test/pg/**` is excluded.

## 2. Schema and role (design D1-D3)

- [x] 2.1 Test first: `server/src/test/pg/catalogSchema.pg.test.ts`, with every case in design D7:
  Evidence: `4a-2.1-red.log`: `Tests  15 failed | 1 passed (16)`, first error `expected [] to
  deeply equal [ 'app_settings', 'kv', …(7) ]` (no `catalog` schema).
  - parity with fixed type and default tables;
  - seed shows, collation, and the int8 and float ranges;
  - the app role's DML and refusals, its attributes, and having no memberships;
  - no exposure on the `postgres` database;
  - the role guard being idempotent.

  Red: no `catalog` schema.

- [x] 2.2 Write `supabase/migrations/20261001000000_catalog_schema.sql` (D1-D3), with `DO`
  blocks whose `begin`/`end` are indented. Green: 2.1, except the password cases (task 3).
  Evidence: `4a-2.2-green.log`: `Tests  8 failed | 8 passed (16)`. Every failure was `password
  authentication failed for user "autologger_app"` or the role's `rolcanlogin` (task 3). The first
  try failed with `permission denied to alter role`: `postgres` can't alter SUPERUSER/REPLICATION,
  so the block now refuses a role holding either (design D3 updated).

## 3. Runner password step (design D4)

- [x] 3.1 Tests first:
  Evidence: `4a-3.1-red.log`: `sh docker/supabase/test_migrate.sh` -> `FAIL with no app role the
  password step says so and succeeds`, `FAIL the first run reports two applied`, `FAIL
  APP_DB_PASSWORD refused before connecting: unset` … `test_migrate: 26 passed, 9 failed`.
  - `docker/supabase/test_migrate.sh`:
    - `runner()` passes `APP_DB_PASSWORD`;
    - unset, `-e`, multi-line and 31-character values are refused before connecting, naming the
      key and printing no value;
    - the existing fixtures report "app role absent" and pass;
    - the rerun's `0 applied` and the first run's real count are asserted.
  - The password cases in `catalogSchema.pg.test.ts`:
    - host-port login with the right password, and refusal of a wrong one;
    - no row in `pg_stat_statements`, queried as `postgres` on `postgres`;
    - nothing in `docker logs`.

  Red: no step; the summary reads `0 applied`.

- [x] 3.2 Write `docker/supabase/migrate.sh`: the pre-connect check, the post-migration
  transaction (`log_statement` and `track_utility` off, the role-absent branch), and the summary
  fix. In `docker/supabase-db.yaml`, `migrate` gets `APP_DB_PASSWORD: ${APP_DB_PASSWORD:?…}`.
  Green: 3.1.
  Evidence: `4a-3.2-green.log`: `test_migrate: 35 passed, 0 failed` (includes `ok   the database log
  holds no password` on a db without `log_min_messages=fatal`); `4a-3.2-pg-green.log`: `npx vitest
  run --project pg` -> `Tests  16 passed (16)`.

## 4. Secret plumbing and the `catalog` network (design D4-D5)

- [x] 4.1 Tests first:
  Evidence: `4a-4.1-red.log`: `node --test …` -> `ℹ fail 4` (`compose-run.test.mjs` fails to load
  `allowedNames`; keys: `0 !== 1` batch posts); `4a-4.1-checkenvs-red.log`: `test_check_envs: 0
  passed, 36 failed` (`required variable APP_DB_PASSWORD is missing a value`).
  - `docker/scripts/compose-run.test.mjs`:
    - `APP_DB_PASSWORD` format refusal;
    - the value is refused in `rest`, in dev `api` and in prod `app`;
    - it is allowed in dev `app`/`migrate` and prod `api`/`migrate`.
  - `docker/scripts/supabase-keys.test.mjs`: the generator creates a missing `APP_DB_PASSWORD`
    and keeps an existing one.
  - `docker/scripts/test_check_envs.sh`: every D7 tooling case.

  Red: the key and the network are unknown.

- [x] 4.2 `compose-run.mjs` (`SUPABASE_KEYS`, `KEY_FORMAT`, per-stack `SECRET_SCOPE`) and
  `supabase-keys.mjs` (`KEYS`). Green: the 4.1 Node tests.
  Evidence: `4a-4.2-green.log`: `ℹ tests 58`, `ℹ pass 58`, `ℹ fail 0`.

- [x] 4.3 Compose:
  Evidence: `4a-4.3-green.log`: `test_check_envs: 37 passed, 0 failed` (incl. `ok   an app gate that
  admits the catalog subnet is caught`); `make check` -> `check-envs: ok (all)`. Invariant 6 now
  admits the app's `PGPASSWORD` reference (spec delta updated). Line-number seds in
  `test_check_envs.sh` became pattern-based because this change shifts `compose.dev.yaml`.
  - the `catalog` network (pinned per stack) in `compose.yaml`, `docker/compose.dev.yaml` and
    `docker/compose.stage.yaml`;
  - `db` on `[db, catalog]`;
  - the dev `app` on `[dev, catalog]` and the prod `api` on `[back, catalog]`, each with the
    five `PG*` literals.

  In `docker/dev-gate.Caddyfile`, a `remote_ip` refusal of `{$CATALOG_SUBNET}`, set literally
  in `app-gate`.

  `check-envs.sh`: invariant 16's `catalog` membership, the namespace counting and subnets, the
  `APP_DB_PASSWORD` sentinel and per-stack scope; and invariant 3's `app` networks
  `["catalog","dev"]`.

  Stale comments: `docker/supabase-db.yaml`'s header, `docker/compose.dev.yaml`'s header
  (lines 7 and 17-19), and the `docker/secrets-env.yaml` header.

  Green: `make check` and `test_check_envs.sh`.

## 5. Docs and verification

- [x] 5.1 Docs:
  Evidence: `git diff --stat -- docs/` -> `docs/supabase.md`, `docs/infisical-secrets.md`,
  `docs/security.md`, `docs/decisions/0021-migrate-to-self-hosted-supabase.md` changed.
  - `docs/supabase.md`: the roles table, the networks table with `catalog`, the schema, the
    rotation order, the test Postgres and the leak cleanup.
  - `docs/infisical-secrets.md`: the key, its format and its per-stack scope.
  - `docs/security.md`: the `/proc` residual and PUBLIC `CONNECT`/`TEMP`.
  - ADR 0021:
    - the slice 4 split (4a-4e) with the owner decisions;
    - a database per test instead of rollback per test;
    - the typed schema as a post-migration follow-up;
    - the `roles.sql` follow-up;
    - the 4c items (NUL bytes, NOCASE, int8 parsing, rotation and boot order).

- [ ] 5.2 Live on dev, after the owner runs `supabase-keys.mjs dev --writer …`:
  - `make dev-up` applies the migration and prints "app role password set";
  - from the `app` container, a Node one-liner as `autologger_app` selects from `shows`;
  - from the `app` container, `rest:3000` does not resolve or connect;
  - from the `db` container, the gate's port is refused;
  - `sh docker/supabase/test_gateway.sh dev` passes;
  - the app still boots on SQLite (`GET /api/profile` 200).
- [ ] 5.3 `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook` is green,
  with the counted size recorded. Then the consistency read.
