## MODIFIED Requirements

### Requirement: Compose topology is loopback-published, segmented, and operable
A `compose.yaml` SHALL define `router`, `web`, and `api` services, with these properties:

- **Host exposure:** only `router` SHALL publish a host port, bound to host loopback
  (`127.0.0.1`).
- **Network segmentation:** `web` and `api` SHALL be on separate networks, with only
  `router` joined to both.
- **Single replica:** `api` SHALL have a fixed `container_name`, so it cannot be scaled past
  one replica.
- **Volumes:** `api` SHALL mount persistent volumes for `DATA_DIR` and for the runtime
  user's home directory, which holds `~/.claude/` and `~/.claude.json`.
- **Secrets:** secrets SHALL come from the Infisical `prod` environment, injected into the
  compose process at start. No service SHALL use `env_file`. `api` SHALL receive only the
  variables named in a shared allowlist file, as null passthroughs. No secret value SHALL
  appear in any tracked file.
- **Posture:** `REQUIRE_LOGIN=1` SHALL be set as a literal in the compose `environment` block,
  so no Infisical value can turn it off.
- **Operability:** every service SHALL have
  - a restart policy;
  - a healthcheck that needs no tools beyond the image's runtime (for `api`,
    `GET /api/profile`);
  - an init process;
  - bounded log rotation.
- **Image references:** images SHALL be referenced by explicit, git-SHA-derived tags, never
  `latest`.

#### Scenario: Only the router is reachable from the host
- **WHEN** the stack is up
- **THEN** the router answers on `127.0.0.1:<port>`, `web` and `api` have no host port
  bindings, and `web` cannot open a connection to `api`

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
