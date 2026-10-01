## MODIFIED Requirements

### Requirement: Compose topology is loopback-published, segmented, and operable
A `compose.yaml` SHALL define `router`, `web`, and `api` services. The prod project SHALL also
include:
- a `db` service: Supabase Postgres;
- a `migrate` tool service, which `up` never starts. No prod target runs it.

These properties SHALL hold:

- **Host exposure:** only `router` SHALL publish a host port, bound to host loopback
  (`127.0.0.1`). `db` and `migrate` SHALL publish no host port.
- **Network segmentation:** `web` and `api` SHALL be on separate networks, with only
  `router` joined to both. `db` and `migrate` SHALL be only on a `db` network. That network SHALL be
  internal (no route off the host), SHALL give the host no address on it (so no host process can
  connect to `db`), and SHALL be on a pinned subnet that no other project uses. No other service
  SHALL join it.
- **Single replica:** `api` SHALL have a fixed `container_name`, so it cannot be scaled past
  one replica.
- **Volumes:** `api` SHALL mount persistent volumes for `DATA_DIR` and for the runtime
  user's home directory, which holds `~/.claude/` and `~/.claude.json`. `db` SHALL keep its
  data directory and its `/etc/postgresql-custom` directory on named volumes.
- **Secrets:** secrets SHALL come from the Infisical `prod` environment, injected into the
  compose process at start. No service SHALL use `env_file`. `api` SHALL receive only the
  variables named in a shared allowlist file, as null passthroughs. The value of
  `POSTGRES_PASSWORD` SHALL appear in no service other than `db` and `migrate`. No secret value SHALL appear in any tracked file.
- **Posture:** `REQUIRE_LOGIN=1` SHALL be set as a literal in the compose `environment` block,
  so no Infisical value can turn it off.
- **Operability:** every long-running service SHALL have
  - a restart policy;
  - a healthcheck that needs no tools beyond the image's runtime (for `api`,
    `GET /api/profile`; for `db`, `pg_isready`);
  - an init process;
  - bounded log rotation.

  A tool service that only runs on demand (`migrate`) SHALL have `restart: "no"`, an init
  process, and bounded log rotation. It needs no healthcheck.
- **Image references:** this repository's images SHALL be referenced by explicit,
  git-SHA-derived tags, never `latest`. Third-party images (the router and `db`) SHALL be
  pinned by `@sha256:` digest.

#### Scenario: Only the router is reachable from the host
- **WHEN** the stack is up
- **THEN** the router answers on `127.0.0.1:<port>`; `web`, `api`, and `db` have no host
  port bindings; and `web` cannot open a connection to `api`

#### Scenario: Postgres is not reachable from the app or the host
- **WHEN** the prod configuration is resolved
- **THEN** `db` publishes no port, `db` is only on the internal `db` network, and no service
  other than `db` and `migrate` is on that network
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
- **THEN** the value appears nowhere in `router`, `web` or `api`, and `db` receives it
