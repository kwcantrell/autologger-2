# Design

## Context

- **Shared compose helper.** Every compose call goes through `docker/scripts/compose-env.sh`
  (`compose_dev`, `compose_stage` and `compose_prod`). The Makefile reaches it through
  `compose-run.mjs`, and `check-envs.sh` uses it too.
- **Path resolution.** Dev passes `--project-directory .`. Stage and prod start from
  `compose.yaml` at the repo root. So relative paths in any added `-f` file resolve against the
  repo root in all three (A3).
- **How the environment reaches compose.** `compose-run.mjs` fetches the environment from
  Infisical and admits only allowlist keys plus `COMPOSE_KEYS[env]`. It runs compose with only
  those keys in its environment. Every `compose …` step is accepted for every environment today
  (`compose-run.mjs:362-366`).
- **The container allowlist.** `docker/secrets-env.yaml` is the allowlist for `api`/`app`. Its
  header forbids Supabase-only secrets.
- **What the checks hard-code.** `check-envs.sh` (15 invariants) hard-codes:
  - the dev service set (`:239`);
  - which services publish ports;
  - the dev read-only bind allowlist `ALLOW` (`:275`).
- **The image** (`supabase/postgres:17.6.1.136`):
  - Alpine, with busybox `sh`, `psql` and `pg_isready`, and no Node;
  - it runs as root and drops to `postgres` (uid 100);
  - `POSTGRES_USER=supabase_admin`, and the `postgres` role is demoted (not a superuser);
  - its CMD is `postgres -D /etc/postgresql`;
  - it ships its own initdb scripts.
- **Bridge behaviour on this host (Docker 29.6.2).** An `internal: true` bridge still gives the
  host a gateway address. The host can therefore connect to a container on it unless
  `com.docker.network.bridge.gateway_mode_ipv4=isolated` is set (A11).

## Goals / Non-Goals

**Goals:**
- **Postgres in every stack.** One Postgres per environment, defined once and unreachable from
  the host and from every other service.
- **Migrations.** A migration convention plus a runner that is:
  - transactional per file, idempotent, and safe to run twice at once;
  - strict about what a file may contain;
  - compatible with the Supabase CLI's history table.
- **One new secret.** `POSTGRES_PASSWORD` enters Infisical through a committed, create-only
  generator. Its value is strong by construction and appears only in `db` and `migrate`.
- **No prod mutation in 1.2a.** Nothing in 1.2a can migrate or open a shell in prod's database.

**Non-Goals:** as in proposal.md. In addition:
- no Postgres tuning;
- no connection pooler;
- no `container_name` for `db`, since compose's per-project names are enough;
- no change to how the image's own initdb scripts behave.

## Decisions

### D1. One shared file `docker/supabase-db.yaml`, added by `compose-env.sh`

`docker/supabase-db.yaml` holds the `db` and `migrate` services and their two volumes. In
`compose-env.sh`, `compose_dev`, `compose_stage` and `compose_prod` each add
`-f docker/supabase-db.yaml` after the environment's base file:
- dev: `compose.dev.yaml`;
- prod: `compose.yaml`;
- stage: `compose.yaml`, before `compose.stage.yaml`.

Each environment declares the `db` network itself, in `compose.yaml`, `compose.dev.yaml` and
`compose.stage.yaml`. Stage uses `!override` on the ipam, as it already does for `front`/`back`.

| Property | Value |
|---|---|
| internal | `true` |
| `driver_opts` | `gateway_mode_ipv4: isolated` and `gateway_mode_ipv6: isolated` |
| subnet, prod | 172.28.12.0/24 |
| subnet, stage | 172.28.22.0/24 |
| subnet, dev | 172.28.31.0/24 |

The shared file holds no per-environment value. A3 shows that the resolved binds, subnets and
`internal` flag are right in all three projects, and that stage's `!override` keeps
`internal: true`.

- *Alternative: top-level `include:`.* Rejected. Included files can't be overridden per
  environment.
- *Alternative: copy the services into each file.* Rejected. The copies drift apart.
- *Alternative: a separate compose project for Supabase.* Rejected. It doubles the wrapper,
  reset and name-guard logic. One project keeps a reset atomic.

### D2. `db`: pinned upstream image, hardened, no init SQL yet

- **Image:** `supabase/postgres:17.6.1.136@sha256:f371b5f3…7c00`, the index digest. It covers
  amd64 and arm64 (A1).
- **Run settings:**
  - `restart: unless-stopped`, `init: true`, `*logging`;
  - healthcheck `pg_isready -U postgres -h localhost`;
  - `security_opt: [no-new-privileges:true]`.
- **Command:** upstream's,
  `postgres -c config_file=/etc/postgresql/postgresql.conf -c log_min_messages=fatal`.
  `log_min_messages=fatal` keeps failed-auth lines out of the logs, which also takes away a
  path for writing attacker-chosen text into logs that the agent reads.
- **Capabilities:** `cap_drop: [ALL]`, then the smallest set that passes all three of these:
  an empty volume, a restart on the existing volume, and a `--force-recreate`. The panel found:
  - `[SETUID, SETGID]` is healthy on an empty volume, but exits on restart (root's `find
    $PGDATA` is denied);
  - `[DAC_READ_SEARCH, SETUID, SETGID]` and `[CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID]`
    both pass (A7).

  Task 2.2 records the final set with all three boots.
- **Environment:** literal `POSTGRES_DB: postgres`, `PGPORT`/`POSTGRES_PORT` `5432`,
  `POSTGRES_HOST: /var/run/postgresql`, and `JWT_EXP: "3600"` (harmless until 1.2b).
  `POSTGRES_PASSWORD` and `PGPASSWORD` are `${POSTGRES_PASSWORD:?…}`. The `:?` message names the
  fix: "add POSTGRES_PASSWORD to Infisical <env> with docker/scripts/supabase-keys.mjs".
- **No vendored init SQL in 1.2a.** Upstream's `roles.sql` alters `supabase_functions_admin`,
  which only `webhooks.sql` creates. The planned subset failed initdb (A12). 1.2b vendors the
  set its services need and resets dev and stage, which hold no data before slice 4.
- **Volumes:**
  - named `supabase-db` (`/var/lib/postgresql/data`) and `supabase-db-config`
    (`/etc/postgresql-custom`, which holds `pgsodium_root.key`), both scoped per project;
  - **the two are one unit.** `down -v` removes both, and 1.3 must back up and restore both.
    Losing only the config volume would silently create a new root key;
  - *Alternative: upstream's `./volumes/db/data` bind.* Rejected. It puts database files in
    the checkout and would break invariants 4 and 8.

### D3. `migrate`: a one-shot service with POSIX sh and psql, in the db image

- **Service:**
  - `profiles: [tools]`, so `up` never starts it (A2);
  - `restart: "no"`, `init: true`, `*logging`;
  - the same pinned image, run as `user: postgres` with `cap_drop: [ALL]`, `read_only: true`,
    tmpfs `/tmp` and `no-new-privileges`;
  - `networks: [db]`;
  - `depends_on: db: {condition: service_healthy}`. `compose run` waits for that (A9).
- **Mounts** (both read-only): `./supabase/migrations` at `/migrations`, and
  `./docker/supabase/migrate.sh` at `/migrate.sh`.
- **Connection:** `PGHOST=db`, `PGUSER=postgres`, `PGDATABASE=postgres`, and
  `PGPASSWORD=${POSTGRES_PASSWORD:?…}`. The `postgres` role can create the history schema
  (A10).

**`migrate.sh` (`set -eu`, `LC_ALL=C`)** runs in two phases.

1. **Check, before connecting.** Enumerate `/migrations` once with a shell glob (sorted under
   `LC_ALL=C`). Refuse, naming the entry, if any of these holds:
   - an entry is not a regular file, other than `.gitkeep`;
   - a name fails a `case` match against `[0-9]{14}_[a-z0-9_]+.sql`, checked by character
     class over the whole name. A name with a newline therefore fails;
   - two files share a 14-digit prefix;
   - a file has a line matching `^[[:space:]]*\\` (a psql meta-command);
   - a file has a statement keyword `begin`, `commit`, `rollback`, `end`, `start transaction` or
     `savepoint` at the start of a line, case-insensitively. This is deliberately conservative:
     a function body that needs one of these words at the start of a line has to be indented.
2. **Apply.**
   - Create `supabase_migrations` and
     `schema_migrations(version text primary key, statements text[], name text)` if missing.
     This is the CLI's shape (A13).
   - For each file, run one `psql -X -q -v ON_ERROR_STOP=1 --single-transaction`, passing the
     version, name and path with `-v`. It runs a fixed wrapper script (`/migrate-one.sql`,
     emitted by `migrate.sh` from a heredoc with no interpolation) that:
     - sets `lock_timeout = '10s'` and `statement_timeout = '15min'`;
     - runs `RESET ROLE` and `RESET search_path`;
     - runs `select pg_advisory_xact_lock(<constant>)`;
     - re-checks `exists(select 1 from supabase_migrations.schema_migrations where version =
       :'version')` with `\gset`;
     - if the version is unrecorded, runs `\i :file`, `RESET ROLE` and `RESET search_path`, then
       `\set stmts \`cat "$MIGRATION_FILE"\`` and
       `insert into supabase_migrations.schema_migrations values (:'version', array[:'stmts'], :'name')`.

     The file's text reaches SQL only through `:'stmts'`, which psql quotes as a literal. It is
     never interpolated by `sh` (A14).
   - After psql exits 0, query that the version is recorded. Fail, naming the file, if it isn't.
     This catches `\set ON_ERROR_STOP off`-style evasions in case the phase 1 check misses one.
   - Print `applied <version>` or `skipped <version>`, and `N applied` at the end. Never print
     `PGPASSWORD` or file contents.
- **Why sh and psql, not Node.** The image has psql and no Node. A Node runner would need a
  Postgres driver, which arrives in slice 4. The owner's Node decision is about host-side
  tooling.
- *Alternative: the Supabase CLI (`supabase db push`).* Rejected for now. It needs a Go binary
  and Postgres reachable from the host. It can replace this runner later without changing the
  history table.
- **Out-of-order and edited files.** A file merged late with an older version is still applied,
  since every unrecorded version runs. A file edited after it was applied is not re-run.
  `docs/supabase.md` documents both, along with what can't run in a transaction
  (`CREATE INDEX CONCURRENTLY`, `VACUUM`). Hashes and drift detection are out of scope.

### D4. `POSTGRES_PASSWORD`: an interpolation key, format-checked, value-confined

- **Allowed.** `COMPOSE_KEYS` gains `POSTGRES_PASSWORD` for dev, stage and prod. It is never
  added to `docker/secrets-env.yaml`.
- **Format check.** `validateSecrets` gets a per-key format table, which refuses the whole
  environment if `POSTGRES_PASSWORD` doesn't match `^[0-9a-f]{32,}$`. That rules out
  weak values, values that busybox `echo` would mangle (`-e`), and values that aren't URL-safe.
- **Leak check at run time.** `checkResolved` gets one more rule: the real value must not
  appear in any string field of any service other than `db` and `migrate`.
- **Leak check, static.** `check-envs.sh` resolves with a unique placeholder (for example
  `PGPW_SENTINEL_7f3c`) and applies the same rule (invariant 16), using
  `[.. | strings | contains($s)]`. That catches `DATABASE_URL`-style embedding, labels, commands
  and build args, not just key names.
- **Hand-typed compose.** It hits `${POSTGRES_PASSWORD:?…}` as well as the existing
  `AUTOLOGGER_STACK` sentinel.

### D5. `supabase-keys.mjs`: a create-only generator

`node docker/scripts/supabase-keys.mjs ENV --writer FILE`:

- **Shared code.** It reuses `httpsJson`, `checkCredFile`, `checkCaFile`, `parseDomain` and
  `checkNodeVersion` from `compose-run.mjs`. `main` already runs only when the file is executed
  directly (`compose-run.mjs:435`).
- **Credentials.** `readCreds` requires all five keys, but the writer file has only the client
  id and secret. So `readCreds` gets an option to read only the project id, URL and CA from
  `.env.infisical.<ENV>`. The writer file gets `checkCredFile` plus a two-key parse.
- **Steps.**
  1. Log in.
  2. `GET /api/v4/secrets` with the same `secretPath=/`, `recursive=false` and
     `includeImports=false` as compose-run, plus `viewSecretValue=false`.
  3. For each missing key in its table, generate a value with `randomBytes(16).toString('hex')`
     and create it with `POST /api/v4/secrets/batch`. Any non-2xx answer exits non-zero with no
     retry and no PATCH.

  Both calls were used against this Infisical in 1.1 (A15).
- **Output.** `created KEY`, `kept KEY`, or an error naming the key and HTTP status. Nothing
  else.
- **Prod.** The generator accepts `prod`. This host has no `.env.infisical.prod`, and the owner
  runs the prod step at cutover. The risk that the agent writes prod with the bootstrap identity
  is the existing accepted risk (infisical-secrets D6).

### D6. Make targets and the wrapper's prod refusal

- **`dev-up` and `stage-up`:** after `'compose up -d --build'`, they run
  `'compose run --rm migrate'`.
- **New targets:**
  - `dev-migrate`: `$(RUN) dev resolved 'compose run --rm migrate'`;
  - `dev-psql`: `$(RUN) dev 'compose exec -e PSQL_HISTORY=/dev/null db psql -U postgres'`.
- **No stage or prod migrate target.**
- **The wrapper refuses prod `run`/`exec`.** `compose-run.mjs` refuses any `compose` step whose
  subcommand is `run` or `exec` when the environment is `prod`. No current prod target uses
  either. This enforces "nothing migrates prod" in code (AGENTS.md rule 8).
- **Resets:** `dev-reset` and `stage-reset` are unchanged, and their help text says
  "(incl. Postgres)". `dev-restart` keeps the app services only.

### D7. Checks

- **`check-envs.sh`:**
  - resolves with `--profile '*'`, since without it `migrate` is invisible (A2);
  - the dev service set gains `db` and `migrate`;
  - `ALLOW` gains exactly `docker/supabase/migrate.sh` and `supabase/migrations`, read-only
    (invariant 4);
  - it unsets `POSTGRES_PASSWORD` and gives it the sentinel placeholder;
  - invariant 16 is implemented per the spec, as one jq filter over all three projects, with
    the pinned subnets in a table in the script.
- **`test_check_envs.sh`** gets one failing case for each invariant 16 clause:
  - a published `db` port;
  - `db` on `dev`;
  - `companion` joined to `db`;
  - a non-internal network;
  - no gateway isolation;
  - the wrong subnet;
  - an unpinned `db` image;
  - an unpinned `migrate` image;
  - `DATABASE_URL` embedding the password on `app`;
  - the password in a label on `api`.

  It also gets an invariant 4 case: a `docker/` bind outside the two exceptions.
- **Size check.** It runs with `--base origin/supabase-migration`, because the default base
  (`origin/main`) already counts 1.1's 888 lines.

## Assumptions

| # | Assumption | Command | Observed |
|---|---|---|---|
| A1 | The pinned image has an arm64 build (this host is aarch64) | `docker buildx imagetools inspect supabase/postgres:17.6.1.136`; `uname -m` | index `sha256:f371b5f3…7c00` lists `linux/amd64` and `linux/arm64`; `aarch64` |
| A2 | `compose config` omits a profiled service unless `--profile` names it | scratch project: `config` vs `--profile '*' config` | `[["app","db"]]` vs `[["app","db","migrate"]]` (Compose v5.2.0) |
| A3 | The design resolves as intended in all three projects | panel: `compose_{dev,stage,prod} /dev/null --profile '*' config` on a copy with the design applied | binds resolve to `<root>/docker/supabase/…` and `<root>/supabase/migrations`; subnets .31/.22/.12, all `internal: true`; only `db`/`migrate` on `db`; stage keeps `internal` under `!override`; volumes `<project>_<volume>` |
| A4 | The image's initdb runs only on an empty data directory | entrypoint.sh:342 `if [ -z "$DATABASE_ALREADY_EXISTS" ]`; `--force-recreate` on an existing volume, then `docker logs \| grep -c init-scripts` | `0` |
| A5 | The chosen subnets are free | `docker network inspect` for every network | in use: 172.17-20/16 and 172.28.20/21/30 /24 |
| A6 | Upstream's `db` needs no `JWT_SECRET` | upstream `docker-compose.yml` `db:` block | environment is `POSTGRES_*`, `PGPASSWORD`, `PGPORT`, `PGDATABASE` and `JWT_EXP` only |
| A7 | A small cap set survives an empty volume, a restart and a recreate | panel, per set | `[SETUID,SETGID]`: empty healthy, restart `exited 1` (`find: … Permission denied`); `[DAC_READ_SEARCH,SETUID,SETGID]`: healthy on both; none at all: `failed switching to 'postgres'` |
| A8 | `--single-transaction` across two `-f` files commits both or neither | `psql -v ON_ERROR_STOP=1 --single-transaction -f bad.sql -f rec.sql` | exit 3; the good file's table is absent and there is no record |
| A9 | `compose run` waits for `service_healthy` | `compose run --rm migrate` on a stopped project | `…-db-1 Waiting … Healthy … migrate-ran`; an unhealthy db gives `dependency failed to start`, exit 1 |
| A10 | `postgres` (non-superuser) can create the history schema | as `--user postgres --cap-drop ALL --read-only` over the internal network | `CREATE SCHEMA` and `CREATE TABLE` succeed; `rolsuper = f` |
| A11 | Without isolated gateway mode, the host can reach a container on an internal bridge | panel: internal net + postgres, then `echo > /dev/tcp/<ip>/5432` from the host | `HOST_CAN_CONNECT`; with `gateway_mode_ipv4=isolated`: `NO_HOST_IP`, `HOST_CANNOT_CONNECT`, and peer `pg_isready` accepting |
| A12 | Upstream `roles.sql` without `webhooks.sql` fails initdb | panel: roles/jwt/realtime mounted on an empty volume | `ERROR: role "supabase_functions_admin" does not exist`; adding `98-webhooks.sql` gives healthy |
| A13 | The CLI history table shape | Supabase CLI `history.go` | `version text NOT NULL PRIMARY KEY, statements text[], name text` |
| A14 | psql `:'var'` quotes arbitrary text as a literal, and backtick `\set` reads a file | task 3.1 case: a file containing `'`, `$$` and `:foo` | PENDING (task 3.1) |
| A15 | `GET /api/v4/secrets` (`viewSecretValue=false`) and `POST /api/v4/secrets/batch` work on this Infisical | 1.1 setup (`copy-secrets.mjs`, names only) | `created 14: HTTP 200`; the listing returned names without values |

## Risks / Trade-offs

- **[A reset deletes Postgres]** → `CONFIRM=yes` is still required, the help text and docs say
  so, and prod reset stays refused.
- **[Frozen checkouts refuse an environment that holds the new key]** → For dev and stage, this
  applies only on pre-1.2a checkouts during the migration. `main` is frozen and isn't run in dev.
  Prod gets the key only at cutover (Decisions).
- **[`${POSTGRES_PASSWORD:?}` blocks every compose command while the key is missing,
  including `down`]** → The `:?` message names the generator. The break-glass section of
  `docs/infisical-secrets.md` gains the key.
- **[Rotating the password after initdb]** → `docs/supabase.md` gives a tested procedure:
  `ALTER ROLE` through `dev-psql` over the socket, using `\password` so the value isn't logged
  or kept in history, then update Infisical. If the old value is lost, recover it from
  Infisical's version history, or reset (dev and stage).
- **[The image pin goes stale; Dependabot doesn't watch docker]** → Same as the caddy pin.
  Upgrades are deliberate changes.
- **[Docker's default pools include 172.28.0.0/16]** → This risk already exists for
  `front`/`back`. An unpinned network created while the stacks are down could take a pinned
  subnet. `up` then fails loudly; it doesn't share the subnet.
- **[The writer is the bootstrap identity (admin on prod)]** → This is an accepted risk
  (infisical-secrets D6). The generator only creates and prints no values.
- **[`PGPASSWORD` is visible in `docker inspect` of `db` and `migrate`]** → Same as every
  container secret today. Docker socket access is already root-equivalent.

## Migration Plan

1. Merge into `supabase-migration`.
2. Run the generator for dev and stage, then `make dev-up` and `make stage-up`.
3. Prod: at cutover, after `main` contains this change, the owner runs the generator on the
   deploy host, then `make prod-check`.
4. Rollback, before reverting the PR:
   1. `make dev-reset CONFIRM=yes` and `make stage-reset CONFIRM=yes` remove the `db`
      containers and both volumes.
   2. Revert the PR.
   3. Remove `POSTGRES_PASSWORD` from Infisical dev and stage. Older checkouts refuse it.

   If the revert came first: `docker compose -p autologger-dev down --remove-orphans` (same for
   stage), then `docker volume rm` the `<project>_supabase-db` and `<project>_supabase-db-config`
   volumes.
