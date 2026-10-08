# Supabase in the compose stacks

ADR 0021 slices 1.2a (`supabase-db`) and 1.2b (`supabase-services`). Each stack (dev, stage,
prod) has its own self-hosted Supabase:
- Postgres;
- the API services auth (GoTrue), rest (PostgREST), realtime and storage;
- a gateway, `supabase-gw`.

Studio and postgres-meta are deferred to a later slice. Use `make dev-psql` for admin work.
The app uses only Supabase's Postgres so far: the catalog moved in slice 4, and sign-in moves in
slice 5. Slice 4a created the catalog's schema and the app's database role and network path; since
4c the app's catalog runs on Postgres, and 4e removed the SQLite catalog code. Prod
gets the definitions only. Its keys and first start wait for the cutover.

## Layout

- **Compose files.** `docker/supabase-db.yaml` (`db`, `migrate`) and
  `docker/supabase-services.yaml` (`auth`, `rest`, `realtime`, `storage`, `supabase-gw`). Both
  are added to every stack by `docker/scripts/compose-env.sh`.
- **The gateway** is the only way in. It's published on `127.0.0.1:${SUPABASE_PORT}` (dev 8790,
  stage 8791), and `make dev-up` prints the URL. It's configured in
  `docker/supabase-gw.Caddyfile`.
- **Networks.** Each base compose file declares them on pinned subnets, and `make check`
  invariant 16 enforces membership:

  | Network | Internal, host-isolated | Members | prod | stage | dev |
  | --- | --- | --- | --- | --- | --- |
  | `db` | yes | `db`, `migrate`, `auth`, `rest`, `realtime`, `storage` | 172.28.12.0/24 | .22 | .31 |
  | `catalog` | yes | `db` and the app only (dev `app`, stage/prod `api`) | 172.28.15.0/24 | .25 | .34 |
  | `supabase` | yes | `supabase-gw`, `auth`, `rest`, `realtime`, `storage` | 172.28.13.0/24 | .23 | .32 |
  | `edge` | no (it publishes the port) | `supabase-gw` only | 172.28.14.0/24 | .24 | .33 |
  | `auth-egress` | no (GoTrue's way out, to Google) | `auth` only | 172.28.16.0/24 | .27 | .35 |
  | `auth-app` | yes | `auth` and the app only (dev `app`, stage/prod `api`) | 172.28.17.0/24 | .28 | .36 |

  Nothing on the host can connect to Postgres or to a service directly. `docker/supabase/test_gateway.sh` checks this.
  The app reaches Postgres only over `catalog`, and GoTrue only over `auth-app`, for sign-in; it
  can't reach the other Supabase services. In dev, `app-gate` also refuses any connection from the
  `catalog` and `auth-app` subnets (`GATE_DENY_SUBNET`). In stage and prod, `db` and `auth` can
  reach the `api` port over their two-member networks; the API still needs a login.
  `auth-egress` reaches the internet, the LAN and the host's bridge address, not only Google
  (accepted for now; ADR 0021 revisit list).
- **Volumes.**
  - `<project>_supabase-db` (data) and `<project>_supabase-db-config` (the pgsodium root key)
    are **one unit**. Back them up, restore them and delete them together. A data volume without
    its config volume silently gets a new root key.
  - `<project>_supabase-storage` holds storage objects. Each file is capped at 50 MB, but the
    volume has no quota: watch `docker system df`.
- **Database roles.**

  | Role | Used by | Password |
  | --- | --- | --- |
  | `supabase_admin` (superuser), `postgres` | `db`, `migrate`, realtime | `POSTGRES_PASSWORD` |
  | `authenticator` (rest), `supabase_auth_admin` (auth), `supabase_storage_admin` (storage) | those services | `SUPABASE_ROLES_PASSWORD` |
  | `autologger_app`: no table privileges (`USAGE` on schema `catalog` only); member (set only) of `catalog_user` and `catalog_system`; at most 45 connections (all processes together; 14 per process, session-frame-bus D7), 30 s statement and 15 s idle-in-transaction timeouts, `search_path` `catalog` | the app (`PGUSER`) | `APP_DB_PASSWORD`, set by the migrations runner |
  | `catalog_user` (NOLOGIN): DML under the 6b-2 policies on every catalog table except `kv` (none); `users`: `SELECT` and `UPDATE (given_name, family_name)`; no `INSERT` on memberships and invites; executes the policy helpers; statements made for a signed-in user, whose id the transaction sets in `app.user_id` | the app, per transaction (`set_config('role', …, true)`) | none |
  | `catalog_system` (NOLOGIN): DML on every catalog table, under row-level security; statements made for a named system task | the app, per transaction (`set_config('role', …, true)`) | none |

  The public-facing API services never hold the superuser password. Realtime does, because
  upstream requires it. The keys and their allowed services are listed in
  [openbao-secrets.md](openbao-secrets.md).

## The gateway

The gateway reproduces upstream's legacy-key gateway. Supabase clients use
`http://localhost:<SUPABASE_PORT>` with the anon key (`ANON_KEY`) or the service-role key
(`SERVICE_ROLE_KEY`).

| Path | Goes to | `apikey` |
| --- | --- | --- |
| `/auth/v1/verify`, `/callback`, `/authorize` | auth | not required |
| other `/auth/v1/` | auth | anon or service-role |
| `/rest/v1/` (the root) | rest | service-role |
| other `/rest/v1/` | rest | anon or service-role |
| `/realtime/v1/api/tenants`, `/realtime/v1/api/openapi` | refused, 403 | |
| `/realtime/v1/api/` | realtime `/api/` | anon or service-role |
| other `/realtime/v1/` (websocket) | realtime `/socket/` | anon or service-role (header or `?apikey=`) |
| `/storage/v1/` | storage | not required; storage checks the token |
| anything else | 404 | |

Before routing, the gateway refuses (403):
- a `Host` other than `localhost:<port>` or `127.0.0.1:<port>`;
- an `Origin` other than those two.

A missing or wrong key gets 401, and the anon key on the REST root gets 403. With no
`Authorization` header (or an empty one), the gateway sends `Bearer <apikey>`. A client token is
never replaced. Realtime gets the `Host` it uses to find its tenant (`realtime-dev`). The
gateway's upstream-error log is turned off, because it would print the `apikey` header. Debug
with each service's own logs.

GoTrue's only sign-in provider is Google, and it accepts ID tokens whose audience is the
environment's `GOOGLE_CLIENT_ID` (gotrue-sign-in, ADR 0021 slice 5a). Email, phone and anonymous
sign-in are off and auto-confirm is off, so a user can be created only from a Google identity.
The browser never talks to GoTrue: the app keeps its own Google flow and, once it has verified the
ID token, exchanges it with GoTrue (`POST http://auth:9999/token?grant_type=id_token`) over
`auth-app`. The GoTrue user id is the catalog user's id. Every stack, dev included, needs
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (require-login): `compose-run` refuses a stack
without both. Dev uses its own Google client (redirect `http://localhost:8787/auth/google/callback`)
and the dev Companion needs a device token from dev's Settings → Companion devices (`API_TOKEN` is
ignored since ADR 0021 slice 9d); without it the dev Companion gets `401`. There is no CORS and no public GoTrue route.

To check a running stack: `sh docker/supabase/test_gateway.sh dev` (or `stage`). It prints
statuses only.

## Commands

| Command | What it does |
| --- | --- |
| `make dev-up`, `make stage-up` | Start the stack (Supabase included), apply migrations, print the URLs |
| `make prod-up` | Clean `main` only: apply migrations, then start prod |
| `make dev-migrate` | Apply migrations to dev. It starts `db` and waits for it to be healthy. |
| `make dev-psql` | psql in the dev `db` as `postgres`, with no history file |
| `make dev-reset CONFIRM=yes`, `make stage-reset CONFIRM=yes` | **Delete** every volume of that stack, Postgres and Supabase storage included |

Prod is migrated only by `make prod-up`. It runs `compose run --rm migrate` after the tag and
resolved-config guards and before `compose up -d`, from the clean `main` checkout (the wrapper
checks the tree again right before the runner), and a failed migration stops it before `up`. A
re-run applies nothing new. For prod, the compose wrapper runs only the Makefile's own compose
steps: it refuses `compose exec`, any other `compose run`, and extra flags such as `-f`. Nothing
opens a shell in the prod database. No backup is taken first: see README "Update order and
rollback".

## Re-initialising Postgres (when the init SQL changes)

`docker/supabase/init/` holds three files:
- `roles.sql`, which sets the service-role passwords;
- `jwt.sql`;
- `realtime.sql`.

They run only when the Postgres data volume is empty. To apply changed init SQL to dev or stage
without touching app data, logins or Companion config:

```sh
make dev-down
docker volume rm autologger-dev_supabase-db autologger-dev_supabase-db-config
make dev-up
```

For stage, use `make stage-down`, the `autologger-stage_…` volumes, and `make stage-up`. This
deletes that environment's Postgres data. Run `docker/supabase/test_gateway.sh` afterwards.

## The catalog schema

The catalog lives in schema `catalog` (`supabase/migrations/20261001000000_catalog_schema.sql`),
not `public`, because the image grants every new `public` table to `anon`, `authenticated` and
`service_role`, and PostgREST serves `public`. It is a faithful port of the SQLite catalog (text
timestamps, 0/1 flags, JSON text, `bigint` integers, `COLLATE "C"`); a typed schema follows the
migration. `postgres` is a member of `pg_read_all_data`, so anything holding `POSTGRES_PASSWORD`
(`db`, `migrate`, `realtime`) can read it; slice 6 revisits that.

**The app's password.** After the migrations, `migrate.sh` gives `autologger_app` `LOGIN` and
sets its password from `APP_DB_PASSWORD`, with statement logging and `pg_stat_statements` off for
that transaction (both would otherwise record the plaintext). To rotate: change the key in
OpenBao, then run `make dev-up` (or `make stage-up`). That applies `migrate` first, which sets the
new password, and then recreates the app with the new value, because its env changed. There is no
window in which both passwords work: between those two steps (a few seconds), any new or replaced
catalog connection fails with `28P01` and its request gets a 500. Connections already open keep
working until the app is recreated.

**Catalog time limits** (catalog-concurrency-hazards). A transaction has a 10 s deadline and is
retried up to 5 runs on a serialization failure or deadlock, with a jittered backoff before each
re-run (`catalog-retry-backoff`). A statement outside a transaction is a short `READ COMMITTED`
transaction on one of 3 dedicated root connections, resolved after its commit (catalog-roles). It
has a 5 s client deadline: one still queued for a root connection is withdrawn at its deadline,
while one already sent is left to the role's timeouts (30 s `statement_timeout`, 15 s
idle-in-transaction) and may still apply. Either timeout reaches the client as the generic 500.

**The server's catalog** (catalog-on-postgres) is this schema: the app connects as
`autologger_app` with the `PG*` env the compose files pass, and refuses to boot without them. It
never runs migrations. Before listening it waits up to 30 s for the catalog to answer (logging
each failure code once), then exits 1 so the supervisor retries. `make dev-up` and
`make stage-up` run `migrate` before starting the app.

## Tests against Postgres

The server's `pg` vitest project (`*.pg.test.ts`) and its `integration` project (`*.int.test.ts`,
one catalog clone per test; `server/src/test/pgIntegrationSetup.ts` raises the app role's
connection limit to 200 in its own container only) run against the pinned image. Its global setup
(`test/pg/globalSetup.ts`) starts a container published on `127.0.0.1` only, applies
`supabase/migrations` with `migrate.sh` to `postgres` and to `autologger_template`, and each test
clones the template (`test/pg/testDb.ts`). Passwords are random per run. `npm test` therefore
needs a running docker daemon. A crashed run can leave its container behind; a later run removes
it once the owning process is gone, or by hand:

```sh
docker rm -f $(docker ps -qf label=autologger-test-pg.pid)
```

## Writing a migration

- **Naming.** `supabase/migrations/<14-digit UTC timestamp>_<name>.sql`, where `<name>` uses
  `a-z`, `0-9` and `_`, for example `20261001120000_catalog_tables.sql`.
  - Each version must be unique.
  - The runner refuses the whole directory if a name is wrong, a version repeats, or an entry
    isn't a plain file.
- **One transaction per file.** The runner wraps each file, together with its record in
  `supabase_migrations.schema_migrations`, in one transaction under an advisory lock. So a file
  must not:
  - start a line with a psql meta-command (`\`);
  - start a line with `BEGIN`, `COMMIT`, `ROLLBACK`, `END`, `ABORT`, `SAVEPOINT`, `RELEASE` or
    `START TRANSACTION`. Indent a function body's `BEGIN … END`;
  - use statements that can't run in a transaction, such as `CREATE INDEX CONCURRENTLY`,
    `VACUUM`, `ALTER SYSTEM` or `CREATE DATABASE`.
- **Limits.** Each file waits at most 10 s for a lock and runs for at most 15 minutes.
- **Order.** Every unrecorded version runs, in version order, even one older than the newest
  applied version.
- **Applied files are final.** Editing a file that has already run has no effect. Write a new
  migration instead.
- **CLI compatibility.** The history table has the Supabase CLI's shape (`version`,
  `statements`, `name`).

## Rotation and recovery

OpenBao holds the values, but the database keeps the passwords it was given. Changing a value
in OpenBao alone breaks the services that use it.

- **`POSTGRES_PASSWORD`** (tested on dev, 2026-09-30):
  1. Set the new value (`openssl rand -hex 16`) in OpenBao.
  2. In the running database, run `make dev-psql`, then `\c postgres supabase_admin`, then
     `\password postgres` and `\password supabase_admin`, entering the new value. Stage uses
     `docker exec -it autologger-stage-db-1 psql -U supabase_admin`. Prod, at the owner's hand,
     uses `docker exec -it autologger-db-1 …`.
  3. `make dev-up` (or `make stage-up`) recreates the services with the new value.
- **`SUPABASE_ROLES_PASSWORD`:** the same steps, with `\password authenticator`,
  `\password supabase_auth_admin` and `\password supabase_storage_admin` as `supabase_admin`.
- **`JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`** change together. Remove all three
  from `kv/autologger/<env>` (a KV v2 merge patch with `null` values removes keys, for example
  `PATCH /v1/kv/data/autologger/<env>` with body
  `{"data":{"JWT_SECRET":null,"ANON_KEY":null,"SERVICE_ROLE_KEY":null}}`, or the OpenBao UI), run
  `node docker/scripts/supabase-keys.mjs <env> --writer ~/.vault-token` (it creates the three), then `make <env>-up`. Old user sessions become invalid. The wrapper warns 90 days
  before the API keys' 5-year expiry.
- **`SECRET_KEY_BASE`:** change it in OpenBao, then `make <env>-up`.
- **`REALTIME_DB_ENC_KEY`** encrypts realtime's stored tenant settings. After changing it,
  re-initialise Postgres (above) on dev or stage.
- **A failed generator run** creates nothing, because each run is one all-or-nothing request.
  If the JWT trio is incomplete for some other reason, the generator refuses. Delete whichever
  of the three exist in OpenBao and run it again.
- **A deleted current version:** if `kv/autologger/<env>` was deleted with `bao kv delete` (or
  destroyed), the generator refuses and writes nothing, because a fresh set would replace every
  database and JWT secret. Restore a deleted version with
  `bao kv undelete -versions=<n> kv/autologger/<env>` (or `bao kv rollback -version=<n>`); a
  destroyed one only with `bao kv rollback -version=<older n>`. Then run it again. The compose
  targets refuse it too. A `deletion_time` in the future (`delete_version_after`) is a live
  version and is not refused.
- **If you lose a password:** inside the `db` container, `supabase_admin` can still log in over
  the local socket without one, so `\password` still works. KV v2's version history also
  keeps old values (`bao kv get -version=<n> kv/autologger/<env>`).

## Residual risks

- **Realtime holds the superuser password,** as upstream requires. It is reachable only through
  the gateway's key check, on internal networks.
- **The four services can reach each other's ports** on the shared `db` and `supabase`
  networks. Revisit before cutover.
- **Container logs carry text from outside the stack,** such as request paths and failed-login
  names. Treat them as untrusted data (see [security.md](security.md)).
