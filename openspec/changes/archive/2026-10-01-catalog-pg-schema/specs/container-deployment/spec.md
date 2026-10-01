## MODIFIED Requirements

### Requirement: Compose topology is loopback-published, segmented, and operable
A `compose.yaml` SHALL define `router`, `web`, and `api` services. The prod project SHALL also
include:
- a `db` service: Supabase Postgres;
- a `migrate` tool service, which `up` never starts. No prod target runs it;
- the Supabase services `auth`, `rest`, `realtime` and `storage`;
- the Supabase gateway `supabase-gw`.

These properties SHALL hold:

- **Host exposure:** only `router` and `supabase-gw` SHALL publish a host port, each exactly
  one, bound to host loopback (`127.0.0.1`). No other Supabase service SHALL publish a port, and
  no host process SHALL be able to connect to one directly.
- **Network segmentation:** `web` and `api` SHALL be on separate networks, with only
  `router` joined to both. `db` and `migrate` SHALL be only on a `db` network. That network SHALL be
  internal (no route off the host), SHALL give the host no address on it (so no host process can
  connect to `db`), and SHALL be on a pinned subnet that no other project uses. Besides `db` and
  `migrate`, only `auth`, `rest`, `realtime` and `storage` SHALL join it. `db` SHALL also join a
  `catalog` network, internal and host-isolated in the same way and on its own pinned subnet,
  whose only other member SHALL be `api`: `api` reaches Postgres there as the catalog's client,
  connecting as the `autologger_app` role with `APP_DB_PASSWORD`, never with the superuser
  password, and reaches no Supabase service. A `supabase` network, internal and
  host-isolated in the same way and on its own pinned subnet, SHALL join `supabase-gw` to those
  four services and to nothing else. `supabase-gw` SHALL publish its port through an `edge`
  network that no other service joins. None of the `db`, `supabase` and `edge` networks SHALL be
  joined by `router`, `web` or `api`, and `router` and `web` SHALL NOT join `catalog`.
- **Single replica:** `api` SHALL have a fixed `container_name`, so it cannot be scaled past
  one replica.
- **Volumes:** `api` SHALL mount persistent volumes for `DATA_DIR` and for the runtime
  user's home directory, which holds `~/.claude/` and `~/.claude.json`. `db` SHALL keep its
  data directory and its `/etc/postgresql-custom` directory on named volumes, and `storage` its
  objects on a named volume.
- **Secrets:** secrets SHALL come from the Infisical `prod` environment, injected into the
  compose process at start. No service SHALL use `env_file`. `api` SHALL receive only the
  variables named in a shared allowlist file, as null passthroughs, plus the catalog connection
  literals `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` and `PGPASSWORD` (`APP_DB_PASSWORD`). Each Supabase
  secret's value SHALL appear only in the services that secret is allowed for. The superuser
  password SHALL appear in no public-facing service (`auth`, `rest`, `storage`, `supabase-gw`). No secret value SHALL appear in any tracked file.
- **Posture:** `REQUIRE_LOGIN=1` SHALL be set as a literal in the compose `environment` block,
  so no Infisical value can turn it off.
- **Operability:** every long-running service SHALL have
  - a restart policy;
  - a healthcheck that needs no tools beyond the image's runtime (for `api`,
    `GET /api/profile`; for `db`, `pg_isready`; for each Supabase service, its own health
    endpoint);
  - an init process;
  - bounded log rotation.

  A tool service that only runs on demand (`migrate`) SHALL have `restart: "no"`, an init
  process, and bounded log rotation. It needs no healthcheck.
- **Image references:** this repository's images SHALL be referenced by explicit,
  git-SHA-derived tags, never `latest`. Third-party images (the router,
  `db` and every Supabase service) SHALL be pinned by `@sha256:` digest.

#### Scenario: Only the router is reachable from the host
- **WHEN** the stack is up
- **THEN** the router answers on `127.0.0.1:<port>`, and only `supabase-gw` besides it, on
  `127.0.0.1:<SUPABASE_PORT>`; `web`, `api`, `db` and the four Supabase services have no host
  port bindings; and `web` cannot open a connection to `api`

#### Scenario: Postgres is not reachable from the app or the host
- **WHEN** the prod configuration is resolved
- **THEN** `db` publishes no port, `db` is only on the internal `db` network, and no service
  other than `db`, `migrate` and the four Supabase services is on that network; the app (`api`)
  reaches `db` only over the two-member `catalog` network, as `autologger_app`, never with the
  superuser password
- **AND** when the stack is up, a TCP connection from the host to the `db` container's address
  on port 5432 fails

#### Scenario: State survives recreation
- **WHEN** the `api` container is recreated from a new image tag
- **THEN** the catalog, sessions, blobs, `~/.claude/` credentials, and `~/.claude.json` written before
  recreation are still present

#### Scenario: A second api replica is refused
- **WHEN** `docker compose up --scale api=2` is run
- **THEN** compose refuses to create a second `api` container

#### Scenario: Posture cannot be flipped from Infisical
- **WHEN** the Infisical `prod` environment sets `REQUIRE_LOGIN=0`
- **THEN** the running `api` still has `REQUIRE_LOGIN=1`

#### Scenario: The Postgres password does not reach the app
- **WHEN** the prod configuration is resolved with `POSTGRES_PASSWORD` set
- **THEN** the value appears nowhere in `router`, `web`, `api`, `auth`, `rest`, `storage` or
  `supabase-gw`, and `db` receives it

#### Scenario: The app's database password stays with the api
- **WHEN** the prod configuration is resolved with `APP_DB_PASSWORD` set
- **THEN** the value appears in `api` and `migrate` only, and `api`'s Postgres user is
  `autologger_app`
