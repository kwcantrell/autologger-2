## MODIFIED Requirements

### Requirement: Dev app binds loopback behind a Host/Origin gate
The dev app SHALL bind `127.0.0.1` inside its container. The compose file SHALL pin these
as literal values, never `${…}` references, in the app's `environment:`:
- `HOST=127.0.0.1`
- `TRUST_PROXY=0`
- `IP_ALLOWLIST=` (empty)
- `DATA_DIR`
- `BLOB_DIR=/blobs`
- `PORT`

`PUBLIC_BASE_URL` SHALL be pinned to `http://localhost:${DEV_PORT:-8787}`. Besides it, the only
variables permitted in the app's `environment:` are the `AUTOLOGGER_STACK` sentinel and the
catalog's `PGPASSWORD`, which SHALL be a `${APP_DB_PASSWORD:?…}` reference next to the literals
`PGHOST=db` and `PGUSER=autologger_app`.

A gate sidecar SHALL share the app's network namespace and be the only listener on the
namespace's external interfaces. It SHALL forward to the app's loopback port. It SHALL
reject any request whose `Host` is not one of:
- `127.0.0.1:<DEV_PORT>`
- `localhost:<DEV_PORT>`
- the in-network name the dev Companion uses

It SHALL also reject a non-GET/HEAD request or WebSocket upgrade whose `Origin` is present and
not one of those origins.

Published ports:
- Every port the dev project publishes SHALL be bound to the literal `127.0.0.1`.
- Every port the dev project publishes SHALL be a gate port: the app gate, the Companion gate,
  or the Supabase gateway, which applies its own Host and Origin checks (see "Supabase gateway
  routes and key checks").
- No dev or stage published port SHALL be `8080`.

Because the bind is loopback, the AI v2 credentials rule passes. Only the host (through the published loopback port) and containers on the dev
network (through the gate) can reach the app. The app also joins the two-member `catalog`
network, whose only other member is `db`, and the two-member `auth-app` network, whose only
other member is `auth`; the gate SHALL refuse every connection whose source address is in the
dev `catalog` or `auth-app` subnet, and `make check` SHALL fail when the gate's refused subnets
differ from those two networks' subnets. The design SHALL record that this relies on
the gate for exactly the reach the loopback rule assumes.

#### Scenario: Loopback posture
- **WHEN** the dev app starts with the pinned environment
- **THEN** the server reports a loopback bind, and the AI v2 credentials refusal is not in
  effect

#### Scenario: DNS-rebound request is rejected
- **WHEN** a request reaches the dev port with `Host: evil.example:8787`
- **THEN** the gate rejects it, and the app never sees it

#### Scenario: Cross-origin write is rejected
- **WHEN** a `POST` arrives with `Host: 127.0.0.1:8787` and `Origin: https://evil.example`
- **THEN** the gate rejects it

#### Scenario: HMR and the session WebSocket work through the gate
- **WHEN** a dev page is open at `http://127.0.0.1:8787/`
- **THEN** the Next HMR upgrade and the session WebSocket upgrade both succeed

#### Scenario: Not reachable from the LAN
- **WHEN** another machine connects to the host's LAN address on the dev port
- **THEN** the connection is refused

#### Scenario: Postgres cannot reach the dev app
- **WHEN** a request to the gate's port comes from an address in the dev `catalog` subnet, with
  `Host: app:8787`
- **THEN** the gate refuses it, and the app never sees it

#### Scenario: The gate refuses the auth service
- **WHEN** a request to the gate's port comes from an address in the dev `auth-app` subnet
- **THEN** the gate refuses it, and the app never sees it

### Requirement: Dev isolates data and secrets, sharing only the operator's Claude login
The dev environment SHALL set `DATA_DIR` to a path inside a named volume of the dev project,
and `BLOB_DIR` to `/blobs`, the mount of a second named volume of the dev project
(`dev-blobs`). `make dev-reset` SHALL delete `dev-blobs` with the project's other volumes.

Bind mounts:
- Source bind mounts SHALL be read-only.
- Each source mount SHALL resolve under a repository source subtree. The exceptions are
  the gate configuration file `docker/dev-gate.Caddyfile`, the migrations runner script
  `docker/supabase/migrate.sh`, the migrations directory `supabase/migrations`, the Supabase
  gateway configuration `docker/supabase-gw.Caddyfile`, and the Supabase init SQL files under
  `docker/supabase/init/`. Each of these SHALL also be read-only. The runner script and the
  migrations directory SHALL be mounted only into `migrate`, the gateway configuration only into
  `supabase-gw`, and the init SQL only into `db`.
- The only read-write bind mount SHALL be the host `~/.claude/.credentials.json` file,
  mounted at the runtime user's `~/.claude/.credentials.json`. This gives the dev CLI and
  Agent SDK the operator's Claude login.
- No bind mount SHALL be any of the following:
  - the repository root;
  - a path with a `data` segment;
  - a `.env` file, including an OpenBao credentials file (`.env.openbao.<env>`);
  - any other path under the host home directory, which includes `~/.claude` as a directory
    and `~/.claude.json`.

The runtime user's home SHALL be a named volume of the dev project (`dev-home`). The CLI's
session store, its `~/.claude.json`, and its history live there, never on the host.

The dev `app` container SHALL receive secrets only as the variables named in the shared
allowlist file, each passed through from the OpenBao `dev` KV secret, plus the catalog
connection literals `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` and `PGPASSWORD`, whose password
is `APP_DB_PASSWORD`. It SHALL have no `env_file`, and
SHALL NOT receive the OpenBao token or AppRole credentials. The
documentation SHALL state the accepted residuals of the credentials mount:
- the container can read the operator's Claude login;
- the OAuth token may be refreshed, and the file rewritten, by either the container or host
  Claude Code sessions.

#### Scenario: Resolved config mounts nothing forbidden
- **WHEN** the dev project's config is resolved the way the Makefile resolves it
- **THEN**:
  - every source mount is read-only, and names an existing path under a source subtree or one
    of the named exceptions;
  - the only read-write bind is `~/.claude/.credentials.json`;
  - the runtime home is the `dev-home` named volume;
  - `DATA_DIR` resolves to a named-volume mount;
  - `BLOB_DIR` resolves to `/blobs`, the `dev-blobs` named-volume mount.

#### Scenario: Host server/.env is invisible
- **WHEN** a shell runs in the dev container
- **THEN** `/app/server/.env` and `/app/server/data` do not exist

#### Scenario: Login is shared, not repeated
- **WHEN** the host `~/.claude/.credentials.json` holds a Claude login and dev starts
- **THEN** an AI chat turn succeeds without any login step inside the container
- **AND** nothing is written under the host `~/.claude` other than that file

#### Scenario: Unnamed OpenBao secrets stay out of the container
- **WHEN** dev is up
- **THEN** `env` inside the `app` container shows no variable outside the allowlist, the pins,
  the five `PG*` catalog connection literals, and the image's own environment
- **AND** it shows no `BAO_*` variable and no `SSL_CERT_FILE`
