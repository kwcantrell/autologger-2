## MODIFIED Requirements

### Requirement: Dev environment runs the hot-reload single process with every integration
The dev environment SHALL run the repo's single-process `npm run dev` in a container built
from a `dev` target of `docker/Dockerfile`. The image SHALL include:
- the workspace dependencies for `server`, `web`, and `packages/*`;
- the pinned Claude CLI, with `CLAUDE_CLI_PATH` set to it;
- the pinned yt-dlp and deno in one directory, with `YTDLP_PATH` set to that yt-dlp.

Source subtrees SHALL be bind-mounted so that editing them reloads the running process
without an image rebuild. Every `packages/*` directory SHALL have its `src` mounted; a
missing mount SHALL fail the dev check. A dependency-manifest, lockfile, or config change
SHALL require `make dev-build`, and the documentation SHALL say so.

The following SHALL be settable through the Infisical `dev` environment:
- `DEEPGRAM_API_KEY`
- `SHEETS_LOG_IMPORT_ENABLED`
- `AI_V2_ENABLED`
- `AI_V2_API_KEY`
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- `API_TOKEN`

Sign-in is required, as in every stack:
- The Infisical `dev` environment SHALL hold its own Google OAuth client
  (`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`); without it, dev refuses to start (see
  "Secrets come from Infisical, one environment per stack").
- Google sign-in works against `PUBLIC_BASE_URL=http://localhost:${DEV_PORT}`, which the
  compose file pins.
- The documentation SHALL state the redirect URI the OAuth client needs, and that dev needs
  the Google client and an `API_TOKEN` in the Infisical `dev` environment.

#### Scenario: Server edit hot-reloads
- **WHEN** the dev environment is up and a file under `server/src/` is edited on the host
- **THEN** the server process restarts within the container, and no image rebuild runs

#### Scenario: Frontend edit hot-reloads
- **WHEN** a file under `web/src/` is edited on the host while a page is open
- **THEN** the page updates through the Next dev HMR socket served on the same published
  origin

#### Scenario: Every gated feature is available
- **WHEN** all of the following hold:
  - the dev environment is up;
  - the host `~/.claude/.credentials.json` holds a Claude login;
  - the Infisical `dev` environment sets `DEEPGRAM_API_KEY`, `SHEETS_LOG_IMPORT_ENABLED=1`,
    and `AI_V2_ENABLED=1`, and no `AI_V2_API_KEY`;
  - a signed-in member of the session's team makes the calls
- **THEN** none of these is answered with its "not configured" or credentials-refusal `503`:
  - AI chat;
  - `topics/generate`;
  - `events/generate`;
  - AI v2 design;
  - YouTube import;
  - Sheets log import;
  - transcript generation.

#### Scenario: Optional sign-in
- **WHEN** the Infisical `dev` environment sets a Google OAuth client whose redirect URI is
  `http://localhost:<DEV_PORT>/auth/google/callback`, and a user signs in at
  `http://localhost:<DEV_PORT>/`
- **THEN** the callback completes on that origin, and `/api/profile` reports the user

#### Scenario: Dev is not anonymous
- **WHEN** the dev environment is up and `GET /api/sessions` is sent with no session cookie
- **THEN** the response is `401` `{"detail": "Login required."}`

### Requirement: Dev app binds loopback behind a Host/Origin gate
The dev app SHALL bind `127.0.0.1` inside its container. The compose file SHALL pin these
as literal values, never `${…}` references, in the app's `environment:`:
- `HOST=127.0.0.1`
- `TRUST_PROXY=0`
- `IP_ALLOWLIST=` (empty)
- `DATA_DIR`
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

### Requirement: Stage behaves as production, with local sign-in
The stage environment SHALL run `compose.yaml` with `docker/compose.stage.yaml` layered
over it. Its `web` and `api` images SHALL be built locally from the same `docker/Dockerfile`
targets as production, for the host's native platform.

At the compose level, the overlay SHALL differ from production only in:
- `name:`;
- `api` `container_name`;
- network subnets, and the router gateway variables that match them;
- image names and tags;
- `PUBLIC_BASE_URL=http://localhost:${STAGE_PORT:-8788}`;
- `COOKIE_SECURE=0`;
- `SESSION_COOKIE=autologger_stage_sid`;
- the router's published port, `127.0.0.1:${STAGE_PORT:-8788}` via `ports: !override`.

Stage SHALL take its secrets from the Infisical `stage` environment, through the same
allowlist as production.

Things stage keeps from production:
- The api home, which holds the Claude login, SHALL remain a named volume of the stage
  project, logged in with `make stage-claude-login`. Stage SHALL NOT mount the host
  `~/.claude`.
- AI v2 in stage SHALL require `AI_V2_API_KEY`, as in production.
- Stage SHALL have no Companion service.

One variable, `STAGE_PORT`, SHALL drive both the published port and `PUBLIC_BASE_URL`. The
Makefile SHALL supply placeholders for `compose.yaml`'s required `WEB_TAG`, `API_TAG`, and
`PUBLIC_BASE_URL`, because compose interpolates the base file before the merge.
`TRUST_PROXY=1` SHALL remain as `compose.yaml` pins it. Stage does not set `REQUIRE_LOGIN`;
the server refuses to boot when it is set.

The documentation SHALL state:
- that stage needs its own Google OAuth client, with authorized redirect URI
  `http://localhost:<STAGE_PORT>/auth/google/callback`;
- that stage must be opened on `localhost`, not `127.0.0.1`;
- that stage tokens must differ from prod's.

#### Scenario: Sign-in round-trips on localhost
- **WHEN** a user opens `http://localhost:<STAGE_PORT>/` with a configured dev OAuth client
  and completes Google sign-in
- **THEN**:
  - the callback lands on `http://localhost:<STAGE_PORT>/auth/google/callback`;
  - a session cookie is set;
  - `/api/profile` reports the signed-in user.

#### Scenario: Stage routing matches production
- **WHEN** the stage stack is up
- **THEN**:
  - the router serves the production Caddyfile with only the gateway variables changed;
  - `web` and `api` publish no host ports;
  - anonymous `/api/sessions` returns `401`.

#### Scenario: Scoped token through the stage router
- **WHEN** the stage `API_TOKEN` is sent as a Bearer token through the stage router
- **THEN** `/api/companion/state` returns `200` and `/api/sessions` returns `401`

#### Scenario: AI v2 without a key is refused, as in production
- **WHEN** stage runs with `AI_V2_ENABLED=1` and no `AI_V2_API_KEY`
- **THEN** AI v2 design turns are refused by the credentials rule

### Requirement: Dev Companion container runs this repo's module
The dev environment SHALL include a `companion` service. The service SHALL:
- run `ghcr.io/bitfocus/companion/companion` pinned by digest to `v4.3.4`, the version the
  module's base-API check targets;
- load this repository's `companion/` module, compiled (`npm run build -w companion`) and
  packaged (`companion-module-build`) in `docker/companion.Dockerfile`, through Companion's
  local-dev module directory;
- keep its configuration in a named volume of the dev project;
- expose its admin UI only through its own Host/Origin gate sidecar, published on
  `127.0.0.1`.

The connection's base URL SHALL be entered once in the Companion UI, and the documentation
SHALL give its value. Companion reaches the dev app through the app's gate on the dev
network, authenticating with the `API_TOKEN` from the Infisical `dev` environment, which is
also entered once in the Companion UI.

The build's per-Dockerfile ignore file SHALL be in allowlist form. It begins by excluding
everything, then re-admits only the root manifest, the lockfile, and the `companion/`
sources.

#### Scenario: Module is available
- **WHEN** the Companion admin UI is opened
- **THEN** the AutoLogger connection type is offered as a dev module
- **AND** the packaged manifest in the image carries `runtime.apiVersion` `1.14.x`

#### Scenario: Dev Companion drives the app
- **WHEN** a dev Companion connection is configured with the documented base URL and the
  dev `API_TOKEN`
- **THEN**:
  - it reaches status OK;
  - a Companion "log event" action creates an event visible in the dev app.

#### Scenario: Companion admin UI is rebinding-safe
- **WHEN** a request reaches the Companion port with `Host: evil.example:8000`
- **THEN** the Companion gate rejects it

### Requirement: Static invariant check
`docker/scripts/check-envs.sh` SHALL resolve each environment with
`docker compose config --no-env-resolution`, with every profile enabled so that tool services
are checked too, using placeholder `--env-file`s it writes to a
temporary directory. It SHALL never contact Infisical, and SHALL never read or print `.env`,
`.env.dev`, `.env.stage`, or any `.env.infisical.*` file.

It SHALL fail, naming the violated invariant, when any of the following holds:
1. A published port in any project is not bound to `127.0.0.1`.
2. A dev or stage port is `8080`.
3. A dev published port is not a gate port.
4. A dev bind mount violates the dev data and secret rule (its read-only exceptions
   included).
5. A `packages/*/src` directory is not mounted.
6. A dev posture pin is not a literal in the raw file, or resolves to a different value.
7. Stage's or prod's `TRUST_PROXY=1` is missing or has a different value.
8. Stage mounts a host path under the home directory.
9. A compose file resolves, without `-p`, to a project name other than its declared one.
10. A router gateway variable is set in `compose.yaml`, or is set anywhere to a value that
    is not a single dotted IPv4 address.
11. `docker/.env` exists.
12. The companion ignore file does not begin with an exclude-all line.
13. The Caddyfile adapted with no gateway variables differs from the committed baseline.
14. Any service in the dev, stage, or prod project has an `env_file`.
15. The key names listed in the shared allowlist file differ from the null-passthrough names
    of the resolved prod `api` or dev `app`, excluding keys that service pins with a literal.
16. In any of the dev, stage, or prod projects:
    - a service other than `db`, `migrate`, `auth`, `rest`, `realtime` and `storage` joins the
      `db` network; `migrate` joins any other network; or `db` joins any network other than
      `db` and `catalog`;
    - the `catalog` network's members are not exactly `db` and the app service (dev `app`;
      stage and prod `api`), or the app service joins `db`. A service with
      `network_mode: service:X` counts as a member of X's networks, and only `app-gate` may
      share `app`'s namespace;
    - a service other than `supabase-gw`, `auth`, `rest`, `realtime` and `storage` joins the `supabase`
      network, or a service other than `supabase-gw` joins the `edge` network, or `supabase-gw`
      joins `db`;
    - `auth`'s networks are not exactly `db`, `supabase`, `auth-egress` and `auth-app`; a service
      other than `auth` joins `auth-egress`; the `auth-app` network's members are not exactly
      `auth` and the app service (dev `app`; stage and prod `api`); or the stage or prod `api`
      joins networks other than `back`, `catalog` and `auth-app`;
    - a Supabase service other than `supabase-gw` publishes a port, or `supabase-gw` publishes
      anything other than one `127.0.0.1` port mapped to its listener;
    - the `db`, `supabase`, `catalog` or `auth-app` network is not internal, does not isolate the
      host from it (no host address on the bridge), or is not on that environment's pinned subnet
      (`catalog`: prod `172.28.15.0/24`, stage `172.28.25.0/24`, dev `172.28.34.0/24`;
      `auth-app`: prod `172.28.17.0/24`, stage `172.28.28.0/24`, dev `172.28.36.0/24`); or the
      `edge` or `auth-egress` network is not on its pinned subnet (`auth-egress`: prod
      `172.28.16.0/24`, stage `172.28.27.0/24`, dev `172.28.35.0/24`);
    - the image of `db`, `migrate`, `auth`, `rest`, `realtime`, `storage` or `supabase-gw` is not
      pinned by `@sha256:` digest;
    - the placeholder value given for any Supabase secret appears anywhere (environment, command,
      labels, healthcheck, build arguments, or any other field) in a service outside that
      secret's allowed set:

      | Secret | Allowed services |
      | --- | --- |
      | `POSTGRES_PASSWORD` | `db`, `migrate`, `realtime` |
      | `SUPABASE_ROLES_PASSWORD` | `db`, `auth`, `rest`, `storage` |
      | `APP_DB_PASSWORD` | dev: `app`, `migrate`; stage and prod: `api`, `migrate` |
      | `JWT_SECRET` | `auth`, `rest`, `realtime`, `storage` |
      | `ANON_KEY` | `supabase-gw`, `realtime`, `storage` |
      | `SERVICE_ROLE_KEY` | `supabase-gw`, `storage` |
      | `SECRET_KEY_BASE`, `REALTIME_DB_ENC_KEY` | `realtime` |

It SHALL need only `docker`, `jq`, and a POSIX shell.

#### Scenario: A LAN-published port is caught
- **WHEN** the dev compose file is edited to publish `0.0.0.0:8787:8787`
- **THEN** `make check` exits non-zero and names the dev port binding

#### Scenario: An overridable pin is caught
- **WHEN** the dev compose file is edited to `HOST: ${DEV_HOST:-127.0.0.1}`
- **THEN** `make check` exits non-zero and names the non-literal pin

#### Scenario: A reintroduced env file is caught
- **WHEN** `env_file: .env` is added back to the prod `api` service
- **THEN** `make check` exits non-zero and names invariant 14

#### Scenario: Allowlist drift is caught
- **WHEN** a passthrough key is added directly to the prod `api` service instead of the shared
  allowlist file
- **THEN** `make check` exits non-zero and names invariant 15

#### Scenario: A published Postgres port is caught
- **WHEN** `ports: ["127.0.0.1:5432:5432"]` is added to `db`
- **THEN** `make check` exits non-zero and names invariant 16

#### Scenario: The Postgres password leaking to the app is caught
- **WHEN** `DATABASE_URL: postgres://postgres:${POSTGRES_PASSWORD}@db/postgres` is added to the
  dev `app` environment
- **THEN** `make check` exits non-zero and names invariant 16

#### Scenario: Another service on the db network is caught
- **WHEN** the dev `companion` service is joined to the `db` network
- **THEN** `make check` exits non-zero and names invariant 16

#### Scenario: The superuser password in a service-role service is caught
- **WHEN** `POSTGRES_PASSWORD` is referenced in the `rest` service's environment
- **THEN** `make check` exits non-zero and names invariant 16

#### Scenario: The gateway on the db network is caught
- **WHEN** `supabase-gw` is joined to the `db` network
- **THEN** `make check` exits non-zero and names invariant 16

#### Scenario: A host-reachable supabase network is caught
- **WHEN** the `supabase` network's `internal: true` is removed
- **THEN** `make check` exits non-zero and names invariant 16

#### Scenario: The app password in another service is caught
- **WHEN** `PGPASSWORD: ${APP_DB_PASSWORD}` is added to the `rest` service's environment
- **THEN** `make check` exits non-zero and names invariant 16

#### Scenario: The app on the shared db network is caught
- **WHEN** the dev `app` is joined to the `db` network
- **THEN** `make check` exits non-zero and names invariant 16

#### Scenario: A third member of the catalog network is caught
- **WHEN** `rest`, or the dev `companion`, is joined to the `catalog` network, or a new service
  sets `network_mode: service:app`
- **THEN** `make check` exits non-zero and names invariant 16

#### Scenario: Clean tree passes
- **WHEN** `make check` runs on the committed files
- **THEN** it exits zero

#### Scenario: A second member of the auth egress network is caught
- **WHEN** `rest`, or the app service, is joined to the `auth-egress` network
- **THEN** `make check` exits non-zero and names invariant 16

#### Scenario: A third member of the auth-app network is caught
- **WHEN** `rest`, or the dev `companion`, is joined to the `auth-app` network
- **THEN** `make check` exits non-zero and names invariant 16

### Requirement: Secrets come from Infisical, one environment per stack
Each stack SHALL read its secrets and its compose interpolation values from one Infisical
environment (`dev`, `stage`, or `prod`), held in its own Infisical project. Each environment SHALL
be read with its own machine identity, which SHALL have no access to the other environments'
projects.

The per-host credentials for an environment SHALL live in an untracked file
`.env.infisical.<env>` at the repository root. The file SHALL hold:
- the machine identity's client id and client secret;
- the project id of that environment's project;
- the Infisical URL, which SHALL use `https://`;
- the path of the CA certificate that Infisical's TLS chains to.

The Infisical URL and CA path SHALL NOT be written in any tracked file other than examples and
documentation, so moving Infisical to another host needs no code change. The tracked template
SHALL be `docker/infisical-credentials.example`, with keys and no values.

**Git ignore rules.** The files `.env`, `.env.dev`, `.env.stage`, and `.env.infisical.*` SHALL be
ignored by git, and the tracked templates SHALL NOT be.

**Allowed names.** Every Infisical key an environment may hold SHALL be either:
- listed in the shared allowlist file, which lists the keys containers may receive; or
- one of that environment's fixed compose-interpolation keys: `DEV_PORT` and
  `DEV_COMPANION_PORT` for dev, `STAGE_PORT` for stage, and `ROUTER_PORT`, `WEB_TAG`, `API_TAG`,
  and `PUBLIC_BASE_URL` for prod; or
- one of the Supabase keys, in every environment. These are interpolation keys that only the
  services allowed for them in invariant 16 receive, and they SHALL NOT be listed in the shared
  allowlist file. Each value SHALL match its format, and a compose target SHALL refuse the
  environment, naming the key and printing no value, when one does not:

  | Key | Format |
  | --- | --- |
  | `POSTGRES_PASSWORD`, `SUPABASE_ROLES_PASSWORD`, `APP_DB_PASSWORD` | at least 32 lowercase hexadecimal characters |
  | `JWT_SECRET` | at least 40 characters of `[A-Za-z0-9_-]` |
  | `SECRET_KEY_BASE` | at least 64 characters of `[A-Za-z0-9_-]` |
  | `REALTIME_DB_ENC_KEY` | exactly 16 characters of `[A-Za-z0-9_-]` |
  | `ANON_KEY`, `SERVICE_ROLE_KEY` | HS256 JWTs that verify against `JWT_SECRET`, with `role` `anon` and `service_role` respectively, distinct, and not expired |
  | `SUPABASE_PORT` | a port number 1024-65535 |

  The wrapper SHALL warn, naming the key, when `ANON_KEY` or `SERVICE_ROLE_KEY` expires within
  90 days. At run time, it SHALL refuse to start compose if any Supabase secret's value appears in
  the resolved configuration of a service outside that secret's allowed set.

**Ordering with frozen checkouts.** A checkout whose allowed names lack `POSTGRES_PASSWORD`
(or `APP_DB_PASSWORD`) refuses an environment that holds it. The Supabase keys SHALL therefore be added to the Infisical
`prod` environment only as part of the cutover, after `main` allows them. The documentation SHALL say so.

**Documentation.** The documentation SHALL:
- list those keys;
- state the `WEB_TAG`/`API_TAG` format (the 12-character git SHA that `prod-push` produces);
- warn against reusing prod secrets in dev or stage;
- describe a break-glass procedure for when Infisical is unreachable.

**Failures.** A compose target SHALL fail before starting anything, with a message that names
the fix and prints no secret value, when:
- Node older than 22.12 is running the wrapper;
- the environment's credentials file is missing, lacks a key, names a missing CA file, uses a
  non-`https` URL, or is readable by group or others;
- login fails, including a TLS verification failure. The message SHALL NOT suggest disabling
  verification or using plain HTTP;
- the environment injects any name outside its allowed names. The message SHALL list only
  offending names that are valid identifiers;
- `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` is unset or empty in the environment. This
  applies to every stack, dev included, because the server refuses to boot without them.

**Secret handling.** The client secret and the access token SHALL NOT appear on any command line
and SHALL NOT be written to disk by the Makefile or its scripts. Secret values SHALL be fetched
without reference expansion and without imports. Every secret key and value SHALL be a string,
and the fetch SHALL be refused as a whole if any secret fails validation.

**Tooling.** The compose targets SHALL need Node 22.12 or newer on the host and no npm packages.

#### Scenario: A weak Postgres password is refused
- **WHEN** the Infisical `dev` environment's `POSTGRES_PASSWORD` is `-e`, or any value that is
  not at least 32 lowercase hexadecimal characters, and `make dev-up` runs
- **THEN** it exits non-zero naming `POSTGRES_PASSWORD`, prints no value, and runs no docker
  command

#### Scenario: Swapped Supabase API keys are refused
- **WHEN** the Infisical `dev` environment's `ANON_KEY` and `SERVICE_ROLE_KEY` are swapped, or
  either is signed with a different secret, and `make dev-up` runs
- **THEN** it exits non-zero naming the key, prints no value, and runs no docker command

#### Scenario: Credentials and old env files are ignored, templates are not
- **WHEN** `git check-ignore .env .env.dev .env.stage .env.infisical.dev .env.infisical.prod` is run
- **THEN** all five are ignored, and `docker/infisical-credentials.example` is not

#### Scenario: Missing credentials file
- **WHEN** `make stage-up` runs with no `.env.infisical.stage`
- **THEN** it exits non-zero with a message naming `docker/infisical-credentials.example`,
  and starts nothing

#### Scenario: Dev without a Google client is refused
- **WHEN** the Infisical `dev` environment has no `GOOGLE_CLIENT_SECRET`, and `make dev-up` runs
- **THEN** it exits non-zero naming `GOOGLE_CLIENT_SECRET`, prints no value, and runs no
  docker command

#### Scenario: Plain HTTP is refused
- **WHEN** `.env.infisical.dev` sets an `http://` Infisical URL and `make dev-up` runs
- **THEN** it exits non-zero before contacting Infisical, and starts nothing

#### Scenario: A hostile secret name is refused
- **WHEN** the Infisical `dev` environment holds a key named `LD_PRELOAD` or `DOCKER_HOST`, and
  `make dev-up` runs
- **THEN** it exits non-zero naming that key, prints no value, and runs no docker command

#### Scenario: A malformed secret list is refused as a whole
- **WHEN** Infisical returns a secret whose value is not a string, a duplicate key, or no
  secrets at all, and `make dev-up` runs
- **THEN** it exits non-zero, prints no value, and runs no docker command

#### Scenario: One environment's identity cannot read another's
- **WHEN** the dev credentials are pointed at the stage or prod project
- **THEN** the fetch is refused with an HTTP 403, and no value is printed

#### Scenario: Secrets stay off the process list
- **WHEN** `make dev-up` is running and `ps -eo args` is captured
- **THEN** no captured argument contains the client secret or the access token
