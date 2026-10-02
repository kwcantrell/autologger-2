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
  password. `auth` SHALL also join an `auth-app` network, internal and host-isolated in the same
  way and on its own pinned subnet, whose only other member SHALL be `api`: `api` reaches
  `auth` there for sign-in, holds no Supabase key, and reaches no other Supabase service. `auth`
  SHALL also join an `auth-egress` network, not internal, on its own pinned subnet, that no other
  service joins, so GoTrue can reach Google. A `supabase` network, internal and
  host-isolated in the same way and on its own pinned subnet, SHALL join `supabase-gw` to those
  four services and to nothing else. `supabase-gw` SHALL publish its port through an `edge`
  network that no other service joins. None of the `db`, `supabase` and `edge` networks SHALL be
  joined by `router`, `web` or `api`, and `router` and `web` SHALL NOT join `catalog`,
  `auth-app` or `auth-egress`.
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
- **Posture:** login is always required. No service's compose `environment` block SHALL set
  `REQUIRE_LOGIN`, and the shared allowlist file SHALL NOT list it. The server refuses to boot
  when it is set (see `web-frontend-platform` "Single-process development").
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
- **THEN** the compose target refuses the environment, naming `REQUIRE_LOGIN` as outside its
  allowed names, and starts nothing

#### Scenario: The Postgres password does not reach the app
- **WHEN** the prod configuration is resolved with `POSTGRES_PASSWORD` set
- **THEN** the value appears nowhere in `router`, `web`, `api`, `auth`, `rest`, `storage` or
  `supabase-gw`, and `db` receives it

#### Scenario: The app's database password stays with the api
- **WHEN** the prod configuration is resolved with `APP_DB_PASSWORD` set
- **THEN** the value appears in `api` and `migrate` only, and `api`'s Postgres user is
  `autologger_app`

#### Scenario: The app reaches only the auth service among Supabase services
- **WHEN** the prod configuration is resolved
- **THEN** `api`'s networks are exactly `back`, `catalog` and `auth-app`; `auth-app`'s members are
  exactly `api` and `auth`; and `auth-egress`'s only member is `auth`

### Requirement: Deployment behind a TLS-terminating proxy is configured explicitly
The compose defaults and deployment documentation SHALL set:
- `PUBLIC_BASE_URL` to the public HTTPS origin;
- `COOKIE_SECURE=1`, set explicitly;
- `TRUST_PROXY=1`, with the router trusting forwarded headers only from a pinned compose
  subnet and sending `api` exactly one `X-Forwarded-For` value: the client address the
  router resolved.

The documentation SHALL state:
- that the upstream proxy's Companion bypass rules name exactly the five paths the Companion
  module calls (`/api/companion/state`, `/categories`, `/log`, `/transport`, `/command`),
  never wildcards;
- that a Google OAuth client with redirect URI `${PUBLIC_BASE_URL}/auth/google/callback`
  must exist and be verified before cutover;
- that existing sessions and teams become visible to signed-in users only after memberships
  are granted via `ADMIN_TOKEN`;
- that AI chat, topics, and events use the mounted subscription credentials, which is the
  owner's accepted risk;
- that AI v2 needs `AI_V2_API_KEY`;
- that shell and asset requests are not guaranteed the server's `IP_ALLOWLIST` coverage in
  this topology;
- that any process on the host can reach the loopback port without passing through the
  upstream proxy;
- private-registry login for the deploy host;
- the WAL-safe backup, the minimal-downtime migration (pre-seed, then a final copy inside
  the window), update, and rollback procedures.

#### Scenario: Forged X-Forwarded-For is not adopted
- **WHEN** a client sends its own `X-Forwarded-For: 1.2.3.4` through the upstream proxy and
  the router
- **THEN** the server's resolved client IP is not `1.2.3.4`

#### Scenario: Session cookie is Secure
- **WHEN** a user completes Google sign-in through the public origin
- **THEN** the session cookie is set with `Secure`, and the OAuth redirect URI is
  `${PUBLIC_BASE_URL}/auth/google/callback`
