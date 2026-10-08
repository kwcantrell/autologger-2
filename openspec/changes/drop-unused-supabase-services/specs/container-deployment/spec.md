## REMOVED Requirements

### Requirement: Compose topology is loopback-published, segmented, and operable
**Reason**: Removing PostgREST, Realtime, Storage and the gateway makes its scenario title "Only the router is reachable from the host" false: GoTrue (`auth`) stays reachable from the host at its address on the non-internal `auth-egress` network (true before this change too, behind the gateway's published port). A MODIFIED requirement must keep every scenario title, so the requirement is re-added under a new title with that scenario renamed "Only the router publishes a host port".
**Migration**: Use "Compose topology publishes only the router, segmented, and operable", which carries the same rules without the four services, the `supabase` and `edge` networks and the storage volume.

## ADDED Requirements

### Requirement: Compose topology publishes only the router, segmented, and operable
A `compose.yaml` SHALL define `router`, `web`, and `api` services. The prod project SHALL also
include:
- a `db` service: Supabase Postgres;
- a `migrate` tool service, which `up` never starts. No prod target runs it;
- the Supabase Auth service `auth` (GoTrue), the only Supabase API service. No `rest`,
  `realtime`, `storage` or Supabase gateway service SHALL be defined.

These properties SHALL hold:

- **Host exposure:** only `router` SHALL publish a host port, exactly one, bound to host
  loopback (`127.0.0.1`). `db`, `migrate` and `auth` SHALL publish no port, and no host process
  SHALL be able to connect to `db` directly. `auth` is reachable from the host only at its
  address on `auth-egress`, the network that gives GoTrue its way out; that residual SHALL be
  documented with the deployment's Supabase notes.
- **Network segmentation:** `web` and `api` SHALL be on separate networks, with only
  `router` joined to both. `db` and `migrate` SHALL be only on a `db` network. That network SHALL be
  internal (no route off the host), SHALL give the host no address on it (so no host process can
  connect to `db`), and SHALL be on a pinned subnet that no other project uses. Besides `db` and
  `migrate`, only `auth` SHALL join it. `db` SHALL also join a
  `catalog` network, internal and host-isolated in the same way and on its own pinned subnet,
  whose only other member SHALL be `api`: `api` reaches Postgres there as the catalog's client,
  connecting as the `autologger_app` role with `APP_DB_PASSWORD`, never with the superuser
  password. `auth` SHALL also join an `auth-app` network, internal and host-isolated in the same
  way and on its own pinned subnet, whose only other member SHALL be `api`: `api` reaches
  `auth` there for sign-in and holds no Supabase key. `auth` SHALL also join an `auth-egress`
  network, not internal, on its own pinned subnet, that no other service joins, so GoTrue can
  reach Google. `auth`'s networks SHALL be exactly `db`, `auth-egress` and `auth-app`. No
  `supabase` or `edge` network SHALL be defined. The `db` network SHALL NOT be joined by
  `router`, `web` or `api`, and `router` and `web` SHALL NOT join `catalog`, `auth-app` or
  `auth-egress`.
- **Single replica:** `api` SHALL have a fixed `container_name`, so it cannot be scaled past
  one replica.
- **Volumes:** `api` SHALL mount persistent volumes for `DATA_DIR`, for `BLOB_DIR` (its own
  named volume at `/blobs`, holding the audio blobs, separate from the `DATA_DIR` volume so
  every server process can share it; `BLOB_DIR` is a literal in `api`'s `environment`, never an
  OpenBao value) and for the runtime user's home directory, which holds `~/.claude/` and
  `~/.claude.json`. `db` SHALL keep its
  data directory and its `/etc/postgresql-custom` directory on named volumes. No Supabase
  storage volume SHALL be declared.
- **Secrets:** secrets SHALL come from the OpenBao `kv/autologger/prod` KV secret, read with the prod
  AppRole and injected into the compose process at start. No service SHALL use `env_file`.
  `api` SHALL receive only the
  variables named in a shared allowlist file, as null passthroughs, plus the catalog connection
  literals `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` and `PGPASSWORD` (`APP_DB_PASSWORD`). Each Supabase
  secret's value SHALL appear only in the services that secret is allowed for. The superuser
  password SHALL appear only in `db` and `migrate`, never in `auth`. The retired Supabase keys
  (`ANON_KEY`, `SERVICE_ROLE_KEY`, `SECRET_KEY_BASE`, `REALTIME_DB_ENC_KEY`, `SUPABASE_PORT`)
  SHALL reach no service. No secret value SHALL appear in any tracked file.
- **Posture:** login is always required. No service's compose `environment` block SHALL set
  `REQUIRE_LOGIN`, and the shared allowlist file SHALL NOT list it. The server refuses to boot
  when it is set (see `web-frontend-platform` "Single-process development").
- **Operability:** every long-running service SHALL have
  - a restart policy;
  - a healthcheck that needs no tools beyond the image's runtime (for `api`,
    `GET /api/profile`; for `db`, `pg_isready`; for `auth`, its own `/health` endpoint);
  - an init process;
  - bounded log rotation.

  A tool service that only runs on demand (`migrate`) SHALL have `restart: "no"`, an init
  process, and bounded log rotation. It needs no healthcheck.
- **Image references:** this repository's images SHALL be referenced by explicit,
  git-SHA-derived tags, never `latest`. Third-party images (the router,
  `db` and `auth`) SHALL be pinned by `@sha256:` digest.

#### Scenario: Only the router publishes a host port
- **WHEN** the stack is up
- **THEN** the router answers on `127.0.0.1:<port>`; `web`, `api`, `db`, `migrate` and `auth`
  have no host port bindings; and `web` cannot open a connection to `api`

#### Scenario: Postgres is not reachable from the app or the host
- **WHEN** the prod configuration is resolved
- **THEN** `db` publishes no port, `db` is only on the internal `db` network, and no service
  other than `db`, `migrate` and `auth` is on that network; the app (`api`)
  reaches `db` only over the two-member `catalog` network, as `autologger_app`, never with the
  superuser password
- **AND** when the stack is up, a TCP connection from the host to the `db` container's address
  on port 5432 fails

#### Scenario: State survives recreation
- **WHEN** the `api` container is recreated from a new image tag
- **THEN** the catalog, sessions, the audio blobs in the `BLOB_DIR` volume, `~/.claude/`
  credentials, and `~/.claude.json` written before recreation are still present

#### Scenario: A second api replica is refused
- **WHEN** `docker compose up --scale api=2` is run
- **THEN** compose refuses to create a second `api` container

#### Scenario: Posture cannot be flipped from OpenBao
- **WHEN** the OpenBao `prod` KV secret sets `REQUIRE_LOGIN=0`
- **THEN** the compose target refuses the environment, naming `REQUIRE_LOGIN` as outside its
  allowed names, and starts nothing

#### Scenario: The Postgres password does not reach the app
- **WHEN** the prod configuration is resolved with `POSTGRES_PASSWORD` set
- **THEN** the value appears nowhere in `router`, `web`, `api` or `auth`, and `db` and
  `migrate` receive it

#### Scenario: The app's database password stays with the api
- **WHEN** the prod configuration is resolved with `APP_DB_PASSWORD` set
- **THEN** the value appears in `api` and `migrate` only, and `api`'s Postgres user is
  `autologger_app`

#### Scenario: The app reaches only the auth service among Supabase services
- **WHEN** the prod configuration is resolved
- **THEN** `api`'s networks are exactly `back`, `catalog` and `auth-app`; `auth-app`'s members are
  exactly `api` and `auth`; and `auth-egress`'s only member is `auth`
