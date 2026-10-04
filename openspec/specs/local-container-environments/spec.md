# local-container-environments Specification

## Purpose

How AutoLogger runs as containers for day-to-day work, alongside the production deployment
owned by `container-deployment`. The capability defines three environments, each driven by
a root `Makefile`.

- **dev** runs a hot-reload `npm run dev`:
  - the app binds loopback behind a Host/Origin gate sidecar;
  - source is mounted read-only, data is kept isolated, and only the operator's Claude
    credentials file is shared;
  - a Bitfocus Companion container runs this repo's module.
- **stage** is the production stack built locally, with Google sign-in on localhost. It
  behaves as prod, and it can run beside prod on the same host.
- **prod** wraps the documented deployment procedure, with guards that bind it to
  committed content on `main`.

The capability also owns:
- env-file hygiene: untracked env files, and tracked templates for them;
- the static invariant check (`make check`), which guards the silent-failure safety
  properties of all three projects.

It changes no HTTP/WS behaviour of the server.

## Requirements

### Requirement: Makefile entry points per environment
The repository root SHALL have a `Makefile` with one target family per environment:
`dev-*`, `stage-*`, and `prod-*`. Each target wraps `docker compose` and/or
`docker buildx bake`.

Each environment SHALL be a separate compose project. Each compose file SHALL declare its
project name with a top-level `name:`, so that a hand-typed `docker compose` against the
dev or stage files never resolves to the prod project.

| Environment | `name:` | Compose files | Invocation |
|---|---|---|---|
| dev | `autologger-dev` | `docker/compose.dev.yaml` | `--project-directory .`, OpenBao KV path `kv/autologger/dev` |
| stage | `autologger-stage` | `compose.yaml` + `docker/compose.stage.yaml` | the overlay's `name:` wins; OpenBao KV path `kv/autologger/stage` |
| prod | `autologger` | `compose.yaml` | OpenBao KV path `kv/autologger/prod`, exactly as README "Container deployment" documents |

Every target that touches a compose project SHALL:
- log in to OpenBao once, with that environment's AppRole;
- read its environment's KV secret once, then revoke the token, check every name before any program is started with
  them, and run its guards and its compose commands in one clean environment that contains only
  a fixed base plus those secrets;
- pass an explicit empty `--env-file`, so compose never reads the root `.env` or any other env
  file for interpolation.

Variables in the operator's shell SHALL NOT reach compose or any container. Ports and tags are
set in OpenBao. A `docker compose` command typed by hand against these files, outside the
Makefile, SHALL fail with a message naming the Makefile, rather than start a service without
its secrets.

The Makefile SHALL also provide:
- `help`, as the default goal;
- `check`, which runs the static invariant check;
- `dev-up` and `stage-up`, which run their environment's check first and refuse to start if
  it fails, run the migrations runner once `db` is healthy and before starting the app, and
  print the app and Supabase URLs;
- `dev-migrate`, which runs only the migrations runner against dev;
- `dev-psql`, which opens `psql` inside the dev `db` container without keeping a history file.

The compose wrapper SHALL refuse a `compose run` or `compose exec` step for prod, so neither a
target nor a hand-written wrapper call can run the migrations runner or a shell against the prod
`db`.

A target that removes volumes (`dev-reset`, `stage-reset`) SHALL:
1. refuse unless `CONFIRM=yes` is given;
2. confirm that the resolved project name is exactly `autologger-dev` or
   `autologger-stage` before running `down -v`.

Because `down -v` removes every volume of the project, a reset SHALL also delete that
environment's Postgres data, its Postgres configuration volume and its Supabase storage volume
together. The help text and the documentation SHALL say so. Supabase's init SQL runs only on an
empty Postgres data volume. When it changes, the documentation SHALL give the one-time step that
removes only that environment's two Postgres volumes (never the app's data or home volumes)
before the next `up`.

No target SHALL remove a prod volume or run `docker volume prune` or
`docker system prune`.

#### Scenario: Help is the default goal
- **WHEN** `make` is run with no target
- **THEN** it prints the target list and starts no container

#### Scenario: Reset refuses without confirmation
- **WHEN** `make dev-reset` is run without `CONFIRM=yes`
- **THEN** it exits non-zero and no volume of project `autologger-dev` is removed

#### Scenario: Reset deletes the environment's Postgres
- **WHEN** `make dev-reset CONFIRM=yes` runs and then `make dev-up` runs
- **THEN** the dev `db` starts from an empty data directory, and the migrations runner applies
  every migration again

#### Scenario: The wrapper refuses run and exec against prod
- **WHEN** the compose wrapper is called for prod with a `compose run --rm migrate` or
  `compose exec db psql` step
- **THEN** it exits non-zero before running docker, and names the refused subcommand

#### Scenario: Hand-typed compose resolves to the right project
- **WHEN** `docker compose -f compose.yaml -f docker/compose.stage.yaml config` is resolved
  with no `-p`
- **THEN** the project name is `autologger-stage`, not `autologger`

#### Scenario: No prod volume removal
- **WHEN** the Makefile is searched for `down -v`, `--volumes`, `volume rm`, or `prune`
- **THEN** each use belongs to `dev-reset` or `stage-reset`, behind both guards

#### Scenario: A stray root .env is ignored
- **WHEN** a root `.env` exists that sets `DEV_PORT` or a secret key, and `make dev-up` runs
- **THEN** the resolved dev config takes neither value from that file

#### Scenario: Shell variables do not leak into a stack
- **WHEN** the operator's shell exports `API_TOKEN=weak`, the OpenBao `stage` KV secret
  has no `API_TOKEN`, and `make stage-up` runs
- **THEN** the stage `api` container has no `API_TOKEN`

#### Scenario: Hand-typed compose refuses to start
- **WHEN** `docker compose -f compose.yaml up -d` is run by hand with the prod tags exported
- **THEN** it fails before creating a container, with a message naming the Makefile

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

The following SHALL be settable through the OpenBao `dev` KV secret:
- `DEEPGRAM_API_KEY`
- `SHEETS_LOG_IMPORT_ENABLED`
- `AI_V2_ENABLED`
- `AI_V2_API_KEY`
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- `API_TOKEN`

Sign-in is required, as in every stack:
- The OpenBao `dev` KV secret SHALL hold its own Google OAuth client
  (`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`); without it, dev refuses to start (see
  "Secrets come from OpenBao, one KV path per stack").
- Google sign-in works against `PUBLIC_BASE_URL=http://localhost:${DEV_PORT}`, which the
  compose file pins.
- The documentation SHALL state the redirect URI the OAuth client needs, and that dev needs
  the Google client and an `API_TOKEN` in the OpenBao `dev` KV secret.

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
  - the OpenBao `dev` KV secret sets `DEEPGRAM_API_KEY`, `SHEETS_LOG_IMPORT_ENABLED=1`,
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
- **WHEN** the OpenBao `dev` KV secret sets a Google OAuth client whose redirect URI is
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

### Requirement: Dev isolates data and secrets, sharing only the operator's Claude login
The dev environment SHALL set `DATA_DIR` to a path inside a named volume of the dev project.

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
  - `DATA_DIR` resolves to a named-volume mount.

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

### Requirement: Stage behaves as production, with local sign-in
The stage environment SHALL run `compose.yaml` with `docker/compose.stage.yaml` layered
over it. By default its `web` and `api` images SHALL be built locally from the same
`docker/Dockerfile` targets as production, for the host's native platform, and tagged
`autologger-stage-{web,api}:local`. When the operator passes `STAGE_IMAGE_TAG`, stage SHALL
instead run the pushed registry images, as "Stage can run pushed images behind a public HTTPS
edge" specifies.

At the compose level, the overlay SHALL differ from production only in:
- `name:`;
- `api` `container_name`;
- network subnets, and the router gateway variables that match them;
- image names and tags;
- `PUBLIC_BASE_URL`, which defaults to `http://localhost:${STAGE_PORT:-8788}`;
- `COOKIE_SECURE`, which defaults to `0`;
- `SESSION_COOKIE=autologger_stage_sid`;
- the router's published port, `127.0.0.1:${STAGE_PORT:-8788}` via `ports: !override`.

Stage SHALL take its secrets from the OpenBao `stage` KV secret, through the same
allowlist as production.

Things stage keeps from production:
- The api home, which holds the Claude login, SHALL remain a named volume of the stage
  project, logged in with `make stage-claude-login`. Stage SHALL NOT mount the host
  `~/.claude`.
- AI v2 in stage SHALL require `AI_V2_API_KEY`, as in production.
- Stage SHALL have no Companion service.

One variable, `STAGE_PORT`, SHALL drive both the published port and the default
`PUBLIC_BASE_URL`. The Makefile SHALL supply placeholders for `compose.yaml`'s required
`WEB_TAG`, `API_TAG`, and `PUBLIC_BASE_URL`, because compose interpolates the base file before
the merge. `TRUST_PROXY=1` SHALL remain as `compose.yaml` pins it, in every stage mode. Stage
does not set `REQUIRE_LOGIN`; the server refuses to boot when it is set.

The documentation SHALL state:
- that stage needs its own Google OAuth client, with authorized redirect URI
  `http://localhost:<STAGE_PORT>/auth/google/callback`, plus
  `https://<public host>/auth/google/callback` for a public stage;
- that a local stage must be opened on `localhost`, not `127.0.0.1`;
- that stage tokens must differ from prod's.

#### Scenario: Sign-in round-trips on localhost
- **WHEN** a user opens `http://localhost:<STAGE_PORT>/` with a configured dev OAuth client
  and completes Google sign-in, with no public variables set
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

#### Scenario: Unset public variables leave stage local
- **WHEN** `make stage-up` runs with neither `STAGE_IMAGE_TAG` nor `STAGE_PUBLIC_BASE_URL`
- **THEN** the resolved config runs `autologger-stage-web:local` and `autologger-stage-api:local`,
  `PUBLIC_BASE_URL` is `http://localhost:<STAGE_PORT>`, `COOKIE_SECURE` is `0`, and the images
  are built

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
network, authenticating with the `API_TOKEN` from the OpenBao `dev` KV secret, which is
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

### Requirement: Stage coexists with prod; dev is disjoint by construction
The stage project SHALL be startable while the prod project runs on the same host. Stage's
subnets, `container_name`, volumes, and published ports SHALL differ from prod's. Dev uses
a single app subnet, and ports distinct from both. Each project's `db` network SHALL have its own
pinned subnet: `172.28.12.0/24` for prod, `172.28.22.0/24` for stage, and `172.28.31.0/24` for
dev. Each project's `supabase` network (pinned `172.28.13.0/24` prod, `172.28.23.0/24` stage,
`172.28.32.0/24` dev) and `edge` network (pinned `172.28.14.0/24` prod, `172.28.24.0/24` stage,
`172.28.33.0/24` dev), `auth-egress` network (pinned `172.28.16.0/24` prod, `172.28.27.0/24`
stage, `172.28.35.0/24` dev) and `auth-app` network (pinned `172.28.17.0/24` prod,
`172.28.28.0/24` stage, `172.28.36.0/24` dev) SHALL be its own. Its Postgres and Supabase storage volumes SHALL be
scoped to that project. Each environment's `SUPABASE_PORT` SHALL differ from every other
published port of every environment on the host.

The router's trusted-proxy gateways SHALL be read from `ROUTER_FRONT_GW` and
`ROUTER_BACK_GW`. They default to `172.28.10.1` and `172.28.11.1`, so production's adapted
router configuration is byte-identical. `compose.yaml` SHALL NOT set either variable.
Wherever either is set, its value SHALL be a single dotted IPv4 address.

#### Scenario: Stage beside prod
- **WHEN** the prod stack is up and `make stage-up` runs
- **THEN** stage starts without a network-pool overlap or container-name conflict, and
  prod's containers are not recreated

#### Scenario: Each environment has its own Postgres
- **WHEN** the dev and stage stacks are both up
- **THEN** each has its own `db` container, data volume, and `db` network, and neither `db`
  can reach the other
- **AND** each has its own Supabase gateway on its own `SUPABASE_PORT`, and a request to one
  gateway never reaches the other environment's services

#### Scenario: Production router defaults unchanged
- **WHEN** the Caddyfile is adapted with neither gateway variable set
- **THEN** the adapted JSON equals the committed baseline (`make check` invariant 13), and
  `docker/scripts/test_router.sh stage` passes

### Requirement: Prod targets are explicit and bound to committed content
`prod-push` and `prod-up` SHALL refuse to run unless both hold:
- `git status --porcelain` is empty (this covers untracked, non-ignored files);
- the current branch is `main`.

`prod-push` SHALL:
- build and push the multi-arch images with `GIT_SHA=$(git rev-parse --short=12 HEAD)`;
- first verify that the named builder lists `linux/amd64` and `linux/arm64`.

`prod-build` SHALL:
- build the production images for the native platform, and load them locally;
- tag them `:local`, never with a git SHA.

`prod-up` SHALL:
- use `compose.yaml` with the OpenBao `prod` KV secret exactly as README "Container
  deployment" documents, with no overlay;
- fail if `WEB_TAG` or `API_TAG` is unset, empty, or `latest` in the OpenBao `prod`
  KV secret.

`prod-check` SHALL run the prod guards and resolve the prod config through OpenBao `prod`
without starting anything and without the `main` requirement. This lets a deploy host dry-run
the OpenBao path before cutover.

#### Scenario: Dirty or untracked tree refuses push
- **WHEN** a tracked file is modified, or an untracked source file exists, and
  `make prod-push` runs
- **THEN** it exits non-zero before invoking `docker buildx bake`

#### Scenario: Missing emulation refuses push
- **WHEN** the builder does not list `linux/amd64`
- **THEN** `make prod-push` exits non-zero with the binfmt setup hint

#### Scenario: Local build never takes a release tag
- **WHEN** `make prod-build` runs
- **THEN** the loaded images are tagged `:local`, and no image tagged with the current git
  SHA is created or overwritten

#### Scenario: Unpinned prod tag refuses start
- **WHEN** the OpenBao `prod` KV secret has `API_TAG=latest` and `make prod-up` runs on a
  clean `main`
- **THEN** it exits non-zero naming `API_TAG`, and starts nothing

#### Scenario: Prod dry run starts nothing
- **WHEN** `make prod-check` runs on any branch with valid prod credentials
- **THEN** it exits zero and no container of project `autologger` is created or recreated

### Requirement: Static invariant check
`docker/scripts/check-envs.sh` SHALL resolve each environment with
`docker compose config --no-env-resolution`, with every profile enabled so that tool services
are checked too, using placeholder `--env-file`s it writes to a
temporary directory. It SHALL never contact OpenBao, and SHALL never read or print `.env`,
`.env.dev`, `.env.stage`, or any `.env.openbao.*` file.

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

### Requirement: Migrations runner
Schema migrations SHALL live in `supabase/migrations/` as `<version>_<name>.sql` files.
`<version>` is a 14-digit UTC timestamp, and `<name>` uses lowercase letters, digits and
underscores. Each environment's `migrate` tool service SHALL apply them to that environment's
`db` over the internal `db` network. The migrations directory SHALL be mounted read-only.

Before connecting, the runner SHALL refuse the whole directory, naming the offending entry, when:
- an entry is not a regular file, or its name does not match the pattern;
- two files share a version;
- a file contains a psql meta-command (a line starting with a backslash), or a statement that
  begins, commits, rolls back or ends a transaction.

When it runs, it SHALL:
- create the `supabase_migrations.schema_migrations` table (`version`, `name`, `statements`) if
  it is missing;
- apply each file whose version is not recorded, in ascending version order;
- run each file and the insert of its record in one transaction. The transaction SHALL hold a
  database-wide advisory lock, re-check that the version is still unrecorded, and run under a
  lock timeout, so two concurrent runs apply each file at most once and neither waits forever;
- record the file's full text exactly, whatever quotes, dollar quotes or colons it contains;
- after each file, confirm that its version is recorded;
- exit non-zero, naming the failing file, when a file fails or its record is missing. The failed
  file's changes and its record SHALL then both be absent, and later files SHALL NOT be applied;
- after the migrations, in one transaction with statement logging and `pg_stat_statements`
  utility tracking turned off, give the `autologger_app` role `LOGIN` and set its password to
  `APP_DB_PASSWORD`, read from the environment and never from the command line. When no such
  role exists, it SHALL say so and succeed;
- report the number of files it applied;
- print no secret value.

Before connecting, the runner SHALL also refuse, printing no value, when `APP_DB_PASSWORD` is
unset, or is not a single line of at least 32 lowercase hexadecimal characters.

#### Scenario: A second run applies nothing
- **WHEN** the migrations runner runs twice with no new migration file
- **THEN** both runs exit zero, and the second one applies nothing and leaves the record
  count unchanged

#### Scenario: A failing migration leaves nothing behind
- **WHEN** a migration file contains a valid statement followed by an invalid one, and the
  migrations runner runs
- **THEN** it exits non-zero naming that file, the valid statement's effect is absent, no
  record for that version exists, and later files are not applied

#### Scenario: Unsafe files are refused before anything runs
- **WHEN** `supabase/migrations/` contains `add_table.sql`, two files with the same version, or a
  file containing `COMMIT;` or a line starting with `\`
- **THEN** the migrations runner exits non-zero naming that file, and applies nothing

#### Scenario: Concurrent runs apply each file once
- **WHEN** two migrations runners start at the same time against the same `db` with one new file
- **THEN** the file is applied once, it has exactly one record, and neither run reports a failure

#### Scenario: The record holds the file exactly
- **WHEN** a migration file contains a single quote, a `$$` block and a `:name` token
- **THEN** its recorded `statements` equals the file's text

#### Scenario: The app role gets its password without leaking it
- **WHEN** the migrations runner runs with `APP_DB_PASSWORD` set
- **THEN** `autologger_app` can log in with that password over TCP and a wrong password is
  refused, and no row of `pg_stat_statements`, no line of the database log and no line of the
  runner's output contains it

#### Scenario: A missing app password is refused before connecting
- **WHEN** the migrations runner runs with `APP_DB_PASSWORD` unset or set to `-e`
- **THEN** it exits non-zero naming `APP_DB_PASSWORD`, prints no value, and applies nothing

### Requirement: Supabase secret generator
`docker/scripts/supabase-keys.mjs ENV [--writer FILE]` SHALL create each missing Supabase secret
for environment `ENV` in that environment's OpenBao KV secret: `POSTGRES_PASSWORD`,
`SUPABASE_ROLES_PASSWORD`, `APP_DB_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`,
`SECRET_KEY_BASE` and `REALTIME_DB_ENC_KEY`. `SUPABASE_PORT` is set by the operator. It SHALL:
- read the OpenBao address, CA path and KV path from `.env.openbao.<ENV>`, with the same
  checks as the compose wrapper (the address SHALL be `https://`); the AppRole keys are not
  needed;
- take an admin token from `FILE`, or from `BAO_TOKEN` when `--writer` is not given. `FILE`
  SHALL pass the same ownership and permission checks as a credentials file, and SHALL hold a
  `BAO_TOKEN=` line or a single token line;
- read the KV secret at the same path the compose wrapper reads, keep only its key names and
  current version, and discard the values;
- refuse, exiting non-zero before any write, when the path exists but its current version is
  soft-deleted or destroyed: a `404` whose body still carries `metadata.version`,
  `metadata.destroyed` true, or a non-empty `metadata.deletion_time` at or before the current
  time (a value that does not parse SHALL count as passed). A future `deletion_time`, which KV v2
  sets on a live version when `delete_version_after` is configured, SHALL NOT count. The message
  SHALL name `bao kv undelete` and `bao kv rollback` for a deleted version and only
  `bao kv rollback` for a destroyed one. It SHALL never write a fresh set of keys over such a
  path;
- generate each value from a cryptographically secure random source, in its format from
  "Allowed names". `ANON_KEY` and `SERVICE_ROLE_KEY` SHALL be HS256 JWTs signed with the
  `JWT_SECRET` created in the same run, with `role` `anon` and `service_role`, `iss`
  `supabase`, and an expiry five years after issue;
- create `JWT_SECRET`, `ANON_KEY` and `SERVICE_ROLE_KEY` together. If some but not all of the
  three exist, it SHALL refuse, naming them, without printing any value and without writing;
- send every missing key in one write: a KV v2 `PATCH` (`application/merge-patch+json`) with
  `options.cas` set to the version it read, or, when the path does not exist yet, a `POST` with
  `options.cas` `0`. A concurrent write SHALL make the whole write fail, so a run creates all of
  them or none;
- only ever add keys. It SHALL never change or delete an existing key. A key that already exists
  SHALL be reported as kept. A write that OpenBao rejects SHALL exit non-zero without retrying;
- print key names and outcomes only, never a value or a token;
- refuse Node older than 22.12, and need no npm packages.

#### Scenario: Existing secrets are kept
- **WHEN** the environment already holds `POSTGRES_PASSWORD` and the generator runs
- **THEN** it reports `POSTGRES_PASSWORD` as kept, makes no write request, and exits zero

#### Scenario: A missing secret is created without being shown
- **WHEN** the environment has no `POSTGRES_PASSWORD` and the generator runs
- **THEN** it creates the key with a newly generated value, and neither its output nor its
  error output contains that value

#### Scenario: The anon and service-role keys verify against the JWT secret
- **WHEN** the generator creates `JWT_SECRET`, `ANON_KEY` and `SERVICE_ROLE_KEY`
- **THEN** both keys verify as HS256 against that `JWT_SECRET`, with roles `anon` and
  `service_role`

#### Scenario: A partial JWT trio is refused
- **WHEN** the environment holds `JWT_SECRET` but not `ANON_KEY`
- **THEN** the generator exits non-zero naming the missing keys, and writes nothing

#### Scenario: A rejected create is not retried as an update
- **WHEN** OpenBao answers the write with an error, for example a check-and-set mismatch because
  a concurrent run wrote first
- **THEN** the generator exits non-zero, prints no value, and sends no second write

#### Scenario: The app password is created for an existing stack
- **WHEN** the environment holds every other Supabase key but not `APP_DB_PASSWORD`, and the
  generator runs
- **THEN** it creates only `APP_DB_PASSWORD`, reports the others as kept, and prints no value

#### Scenario: A soft-deleted current version is refused
- **WHEN** the current version of the environment's KV secret has been deleted with
  `bao kv delete` (or destroyed), and the generator runs
- **THEN** it exits non-zero naming `bao kv undelete` (only `bao kv rollback` when destroyed),
  sends no write request, and prints no value

#### Scenario: A version with a future deletion time is live
- **WHEN** the current version's `metadata.deletion_time` is in the future because
  `delete_version_after` is set, and the generator runs
- **THEN** it treats the version as live, reports existing keys as kept, and writes only the
  missing ones

#### Scenario: A writer without a token is refused
- **WHEN** the generator runs without `--writer` and without `BAO_TOKEN`
- **THEN** it exits non-zero before any request, naming `BAO_TOKEN`

### Requirement: Supabase gateway routes and key checks
Each project SHALL have a `supabase-gw` service, the only way to reach the Supabase services from
the host. It SHALL publish exactly one port, `127.0.0.1:${SUPABASE_PORT}`, through an `edge`
network that only it joins, and reach `auth`, `rest`, `realtime` and `storage` over the internal `supabase`
network. It SHALL, before any routing:
- reject a request whose `Host` header is not `localhost:<SUPABASE_PORT>` or
  `127.0.0.1:<SUPABASE_PORT>`, or that has no `Host`;
- reject a request, including a WebSocket upgrade, whose `Origin` is present and is not
  `http://localhost:<SUPABASE_PORT>` or `http://127.0.0.1:<SUPABASE_PORT>`.

It SHALL route by path, with the prefix removed, and apply the `apikey` rule shown. Path
matching SHALL be case-insensitive and SHALL normalise repeated slashes and percent-encoding, and
the key rule SHALL apply to exactly the requests the route serves:

| Path | Upstream | `apikey` |
| --- | --- | --- |
| `/auth/v1/verify`, `/auth/v1/callback`, `/auth/v1/authorize` | auth | not required |
| other `/auth/v1/` paths | auth | anon or service-role |
| `/rest/v1/` (exact) | rest `/` | service-role |
| other `/rest/v1/` paths | rest | anon or service-role |
| `/realtime/v1/api/tenants`, `/realtime/v1/api/openapi` | refused, `403` | |
| `/realtime/v1/api/` | realtime `/api/` | anon or service-role |
| other `/realtime/v1/` paths, including the websocket | realtime `/socket/` | anon or service-role, from the header or the `apikey` query parameter |
| `/storage/v1/` | storage | not required (storage checks the token itself) |
| anything else | refused, `404` | |

It SHALL also:
- answer `401` when a required `apikey` is missing, empty, or neither key, and `403` when a
  service-role route gets the anon key;
- when the client sent no `Authorization`, or an empty one, send `Authorization: Bearer <apikey>`
  upstream, and never replace a non-empty `Authorization` the client sent;
- reach realtime, for both the API and the websocket, with the `Host` realtime uses to find its
  tenant;
- drop any client `X-Forwarded-Path` toward storage;
- never write either API key, or any other secret, to its logs.

GoTrue SHALL start with Google as its only enabled sign-in provider, accepting ID tokens whose
audience is the environment's `GOOGLE_CLIENT_ID`; email, phone and anonymous sign-in SHALL stay
disabled, so a new user can be created only from a Google identity. GoTrue SHALL NOT auto-confirm
email addresses, so it links identities by email only when the address is verified.

#### Scenario: A request without a key is refused
- **WHEN** `GET /rest/v1/` arrives with no `apikey`
- **THEN** the gateway answers `401` and rest never sees the request

#### Scenario: The anon key cannot reach the REST root by a path trick
- **WHEN** the anon key is sent to `/rest/v1/`, `/REST/v1/`, `/rest/v1//` and `/rest/v1/%2F`
- **THEN** each is answered `403` or `401`, and none reaches rest

#### Scenario: A user token is not replaced
- **WHEN** a request carries the anon key in `apikey` and a user JWT in `Authorization`
- **THEN** the upstream service receives the user JWT

#### Scenario: Realtime tenant APIs are blocked
- **WHEN** `/realtime/v1/api/tenants` is requested with the service-role key, also as
  `/realtime/v1/api//tenants` and `/realtime/v1/api/%2Ftenants`
- **THEN** the gateway answers `403` or `401`, never forwarding it

#### Scenario: A rebound Host or a foreign Origin is refused
- **WHEN** a request reaches the Supabase port with `Host: evil.example:<SUPABASE_PORT>`, or with
  a valid Host and `Origin: https://evil.example`
- **THEN** the gateway refuses it

#### Scenario: Realtime works through the gateway
- **WHEN** a client opens `/realtime/v1/websocket?apikey=<anon key>&vsn=1.0.0` and joins a
  channel, and sends a REST broadcast to `/realtime/v1/api/broadcast`
- **THEN** the join succeeds and the broadcast is accepted

#### Scenario: The host cannot bypass the gateway
- **WHEN** the dev stack is up and a host process connects to the container address of
  `auth`, `rest`, `realtime` or `storage`
- **THEN** the connection fails

#### Scenario: Keys stay out of the gateway log
- **WHEN** an upstream is stopped and a request with the service-role key gets `502`
- **THEN** the gateway's log contains neither API key

#### Scenario: Only Google can create a user
- **WHEN** the gateway's `/auth/v1/settings` is read with the anon key
- **THEN** it reports sign-up enabled, `google` as the only enabled external provider, and email,
  phone and anonymous sign-in disabled

### Requirement: Secrets come from OpenBao, one KV path per stack
Each stack SHALL read its secrets and its compose interpolation values from one OpenBao KV v2
secret: `kv/autologger/dev`, `kv/autologger/stage` or `kv/autologger/prod`. Each environment SHALL
log in with its own AppRole, whose policy SHALL allow reading only its own KV path (`read` on
`kv/data/autologger/<env>`) and nothing else. Each AppRole's secret ids SHALL be bound to the CIDR of the host
that runs that stack.

The per-host credentials for an environment SHALL live in an untracked file
`.env.openbao.<env>` at the repository root. The file SHALL hold:
- `BAO_ADDR`, the OpenBao address, a bare `https://host[:port]` origin with no path;
- `BAO_CACERT`, the absolute path of the CA certificate that OpenBao's TLS chains to;
- `BAO_ROLE_ID` and `BAO_SECRET_ID`, the AppRole credentials;
- `BAO_KV_PATH`, the KV path as `<mount>/<path>`. Every segment SHALL match `[A-Za-z0-9_-]+`,
  there SHALL be at least two segments, the first SHALL be the KV v2 mount, and the last SHALL be
  the environment name.

The OpenBao address and CA path SHALL NOT be written in any tracked file other than examples and
documentation, so moving OpenBao needs no code change. The tracked template SHALL be
`docker/openbao-credentials.example`, with keys and no values.

**Git ignore rules.** The files `.env`, `.env.dev`, `.env.stage`, and `.env.openbao.*` SHALL be
ignored by git, and the tracked templates SHALL NOT be.

**Request flow.** The compose wrapper SHALL:
1. log in with `POST /v1/auth/approle/login` and the body `{role_id, secret_id}`, and refuse
   unless the response holds a non-empty string `auth.client_token`;
2. read `GET /v1/<mount>/data/<path>` with the token in the `X-Vault-Token` header, and refuse
   unless `data.data` is a non-empty object;
3. revoke the token with `POST /v1/auth/token/revoke-self` once the read has finished, whether it
   succeeded or not. A failed revoke SHALL be a warning only.

**Allowed names.** Every key a KV secret may hold SHALL be either:
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

**Documentation.** The documentation SHALL:
- list those keys and the KV layout;
- state the `WEB_TAG`/`API_TAG` format (the 12-character git SHA that `prod-push` produces);
- describe the AppRole settings (policy, CIDR binding, secret-id TTL, token TTL);
- warn against reusing prod secrets in dev or stage;
- describe a break-glass procedure for when OpenBao is sealed or unreachable.

**Failures.** A compose target SHALL fail before starting anything, with a message that names
the fix and prints no secret value, when:
- Node older than 22.12 is running the wrapper;
- the environment's credentials file is missing, lacks a key, names a missing CA file, uses a
  non-`https` address, has a malformed `BAO_KV_PATH` or one whose last segment is not the
  environment name, or is readable by group or others. These SHALL be checked before any
  request;
- login fails, including a TLS verification failure. The message SHALL give the HTTP status and
  OpenBao's sanitized error text only, and SHALL NOT suggest disabling verification or using
  plain HTTP;
- the KV secret holds any name outside its allowed names. The message SHALL list only offending
  names that are valid identifiers;
- `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` is unset or empty in the KV secret. This
  applies to every stack, dev included, because the server refuses to boot without them.
- `BOOTSTRAP_OWNER_EMAIL` is unset, empty or only whitespace in the KV secret. This applies
  to every stack, dev included, because the server refuses to boot without it. The shared
  allowlist file SHALL list it, so the app container receives it.

**Secret handling.** The secret id and the token SHALL NOT appear on any command line, SHALL NOT
reach any child process, and SHALL NOT be written to disk by the Makefile or its scripts. Every
key and value in the KV secret SHALL be a string, and the read SHALL be refused as a whole if any
key fails validation, if the latest version is deleted or destroyed (`data.data` null,
`metadata.destroyed` true, or a `metadata.deletion_time` at or before the current time, an
unparseable one counting as passed), or if the secret is empty. A future `deletion_time` is a
live version and SHALL NOT be refused.

**Tooling.** The compose targets SHALL need Node 22.12 or newer on the host and no npm packages.

#### Scenario: A weak Postgres password is refused
- **WHEN** the OpenBao `dev` KV secret's `POSTGRES_PASSWORD` is `-e`, or any value that is
  not at least 32 lowercase hexadecimal characters, and `make dev-up` runs
- **THEN** it exits non-zero naming `POSTGRES_PASSWORD`, prints no value, and runs no docker
  command

#### Scenario: Swapped Supabase API keys are refused
- **WHEN** the OpenBao `dev` KV secret's `ANON_KEY` and `SERVICE_ROLE_KEY` are swapped, or
  either is signed with a different secret, and `make dev-up` runs
- **THEN** it exits non-zero naming the key, prints no value, and runs no docker command

#### Scenario: Credentials and old env files are ignored, templates are not
- **WHEN** `git check-ignore .env .env.dev .env.stage .env.openbao.dev .env.openbao.prod` is run
- **THEN** all five are ignored, and `docker/openbao-credentials.example` is not

#### Scenario: Missing credentials file
- **WHEN** `make stage-up` runs with no `.env.openbao.stage`
- **THEN** it exits non-zero with a message naming `docker/openbao-credentials.example`,
  and starts nothing

#### Scenario: Dev without a Google client is refused
- **WHEN** the OpenBao `dev` KV secret has no `GOOGLE_CLIENT_SECRET`, and `make dev-up` runs
- **THEN** it exits non-zero naming `GOOGLE_CLIENT_SECRET`, prints no value, and runs no
  docker command

#### Scenario: A stack without a bootstrap owner is refused
- **WHEN** the OpenBao `stage` KV secret has no `BOOTSTRAP_OWNER_EMAIL`, or holds only
  spaces in it, and `make stage-up` runs
- **THEN** it exits non-zero naming `BOOTSTRAP_OWNER_EMAIL`, prints no value, and runs no
  docker command

#### Scenario: Plain HTTP is refused
- **WHEN** `.env.openbao.dev` sets an `http://` `BAO_ADDR` and `make dev-up` runs
- **THEN** it exits non-zero before contacting OpenBao, and starts nothing

#### Scenario: A KV path for another environment is refused before any request
- **WHEN** `.env.openbao.dev` sets `BAO_KV_PATH=kv/autologger/prod` and `make dev-up` runs
- **THEN** it exits non-zero naming `BAO_KV_PATH`, sends no request to OpenBao, and starts
  nothing

#### Scenario: A failed AppRole login prints the status only
- **WHEN** OpenBao answers the AppRole login with HTTP 400 and an `errors` message
- **THEN** the wrapper exits non-zero printing the status and that message, sends no read
  request, and prints neither the role id nor the secret id

#### Scenario: The token is revoked after the read
- **WHEN** `make dev-up` runs and the KV read succeeds
- **THEN** the wrapper sends `POST /v1/auth/token/revoke-self` with that token before running
  any docker command, and no child process receives the token

#### Scenario: A hostile secret name is refused
- **WHEN** the OpenBao `dev` KV secret holds a key named `LD_PRELOAD` or `DOCKER_HOST`, and
  `make dev-up` runs
- **THEN** it exits non-zero naming that key, prints no value, and runs no docker command

#### Scenario: A malformed secret is refused as a whole
- **WHEN** OpenBao returns a value that is not a string, a deleted or destroyed latest version, or an empty
  secret, and `make dev-up` runs
- **THEN** it exits non-zero, prints no value, and runs no docker command

#### Scenario: One environment's AppRole cannot read another's path
- **WHEN** the dev AppRole credentials are used to read `kv/autologger/stage` or
  `kv/autologger/prod`
- **THEN** the read is refused with HTTP 403, and no value is printed

#### Scenario: Secrets stay off the process list
- **WHEN** `make dev-up` is running and `ps -eo args` is captured
- **THEN** no captured argument contains the secret id or the token

### Requirement: Stage can run pushed images behind a public HTTPS edge
`make stage-up` SHALL accept two optional, non-secret operator values, passed to
`docker/scripts/compose-run.mjs` by name (never spliced into the recipe's shell text) by the
same Makefile macro every target uses, and validated there before any OpenBao request. The other
stage targets SHALL treat them the same way: `stage-down`, `stage-logs` and `stage-reset`
validate and resolve with the same options, and `stage-build` always builds `:local` (it is
refused while a tag is set).
- `STAGE_IMAGE_TAG`: exactly 40 lowercase hex characters (a full git SHA). With it, stage SHALL
  run `ghcr.io/kwcantrell/autologger-web:<tag>` and `ghcr.io/kwcantrell/autologger-api:<tag>`:
  `stage-up` SHALL pull `web` and `api`, run the migrations, and start with
  `compose up -d --no-build`; the wrapper SHALL refuse any build step, and any `up` without
  `--no-build`, while a tag is set. A tag SHALL require `STAGE_PUBLIC_BASE_URL` (a tagged run
  is a public run). With a tag, the wrapper SHALL refuse unless the tree it runs in is the tagged
  commit: when `.git` exists, `git rev-parse HEAD` SHALL equal the tag; otherwise a regular file
  `REVISION` (not a symlink) at the tree root SHALL contain exactly the tag (surrounding
  whitespace ignored). The documentation SHALL state that the tree must be the tagged commit.
- `STAGE_PUBLIC_BASE_URL`: a bare `https://<dns name>` origin (lowercase, at least one dot, no
  port, path, query, fragment or userinfo, not an IP literal or `localhost`); unset is the local
  stage. A set value SHALL become the api's `PUBLIC_BASE_URL` and SHALL set `COOKIE_SECURE=1`.

With a tag, `DOCKER_CONFIG` MAY also be passed, for the registry login `compose pull` uses;
without a tag the wrapper SHALL ignore it (neither validate nor forward it), as for dev and prod.
With a tag it SHALL be an absolute path of plain characters naming a directory that is not a
symlink, is owned by the caller and is not writable by group or others; a `config.json` inside it,
if present, SHALL meet the same rules for a regular file. The wrapper SHALL only read that
`config.json`, and SHALL refuse it when it names a credential helper (`credsStore` or
`credHelpers`). It SHALL NOT hand the caller's directory to compose: it SHALL create its own
temporary directory (mode `0700`) holding only a `config.json` with the caller's `auths`, pass that
as `DOCKER_CONFIG` together with `DOCKER_CONTEXT=default`, and remove it when the wrapper exits,
including after a failed step or a signal.

Without a tag, in a tree that has a `REVISION` file at its root and no `.git` (a pinned deploy,
which serves the public stage), the wrapper SHALL refuse any compose step containing `up`,
`build` or `run`.

The wrapper SHALL:
- refuse `STAGE_IMAGE_TAG` and `STAGE_PUBLIC_BASE_URL` for dev and prod;
- pass compose only the derived `STAGE_WEB_IMAGE`, `STAGE_API_IMAGE`, `STAGE_PUBLIC_BASE_URL`,
  `STAGE_COOKIE_SECURE` (and, with a tag and `DOCKER_CONFIG`, its own temporary `DOCKER_CONFIG`
  with `DOCKER_CONTEXT=default`), never `STAGE_IMAGE_TAG`;
- refuse every one of those names, and `STAGE_IMAGE_TAG`, as an OpenBao secret;
- in the `resolved` step, refuse unless the merged stage config runs exactly the expected `web`
  and `api` images, `PUBLIC_BASE_URL` and `COOKIE_SECURE` match the options, and `TRUST_PROXY`
  is `1`.

In every mode the router SHALL publish only `127.0.0.1:${STAGE_PORT}`; the HTTPS edge connector
runs on the same host and targets that port. The static invariant check SHALL resolve stage both
without and with the public variables, and fail (invariant 7) when the defaults are not the
`:local` images and `COOKIE_SECURE=0`, or when the public resolution does not carry the registry
images, the https `PUBLIC_BASE_URL`, `COOKIE_SECURE=1` and the loopback port.

The Supabase gateway, GoTrue and storage public URLs SHALL stay
`http://localhost:${SUPABASE_PORT}`; no public Supabase host is configured.

#### Scenario: Public stage sets a Secure cookie origin
- **WHEN** `make stage-up STAGE_IMAGE_TAG=<40-hex sha> STAGE_PUBLIC_BASE_URL=https://stage.example.com` runs
- **AND** the tree is that commit (git `HEAD`, or `REVISION` without `.git`)
- **THEN** compose receives `STAGE_WEB_IMAGE=ghcr.io/kwcantrell/autologger-web:<sha>`,
  `STAGE_API_IMAGE=ghcr.io/kwcantrell/autologger-api:<sha>`,
  `STAGE_PUBLIC_BASE_URL=https://stage.example.com` and `STAGE_COOKIE_SECURE=1`, no
  `STAGE_IMAGE_TAG`, and `urls` prints the https origin with the loopback port it proxies to

#### Scenario: Malformed values stop before any request
- **WHEN** `STAGE_IMAGE_TAG` is a 12-character SHA, uppercase, `latest` or padded, or is set
  without `STAGE_PUBLIC_BASE_URL`, or `STAGE_PUBLIC_BASE_URL` is any `http://` URL (including
  `http://localhost`), has a path, query, fragment, port or userinfo, or is an IP literal, or,
  with a tag, `DOCKER_CONFIG` is a symlink, not owned by the caller, or writable by group or
  others, or its `config.json` names `credsStore` or `credHelpers`
- **THEN** the wrapper exits non-zero naming the variable, sends no OpenBao request and runs no
  docker command

#### Scenario: An ambient DOCKER_CONFIG does not change a local stage run
- **WHEN** `make stage-up` runs without `STAGE_IMAGE_TAG` and the caller's environment has any
  `DOCKER_CONFIG` (even a world-writable one)
- **THEN** the run is not refused for it and compose receives no `DOCKER_CONFIG` or
  `DOCKER_CONTEXT`

#### Scenario: compose never sees the caller's docker config directory
- **WHEN** a tagged run passes a `DOCKER_CONFIG` whose directory has a `cli-plugins` entry (for
  example a symlink to a world-writable directory) and whose `config.json` sets
  `cliPluginsExtraDirs` or `currentContext` next to its `auths`
- **THEN** compose's `DOCKER_CONFIG` is a different, `0700` directory containing only a
  `config.json` equal to `{"auths": <the caller's auths>}`, and that directory no longer exists
  after the wrapper exits, whether the steps succeeded, one failed, or the wrapper got `SIGTERM`

#### Scenario: A pinned tree refuses an untagged start
- **WHEN** the tree has a `REVISION` file and no `.git`, `STAGE_IMAGE_TAG` is unset, and a step
  contains `up`, `build` or `run` (`make stage-up`, `make stage-build`)
- **THEN** the wrapper refuses before any OpenBao request; `compose down` and `compose logs` are
  still allowed

#### Scenario: The tree must be the tagged commit
- **WHEN** `STAGE_IMAGE_TAG` is set and the tree's git `HEAD` differs from it, or the tree has no
  `.git` and no `REVISION` file, or its `REVISION` holds another value
- **THEN** the wrapper exits non-zero naming `STAGE_IMAGE_TAG`, sends no OpenBao request and runs
  no docker command

#### Scenario: A tag forbids building
- **WHEN** `STAGE_IMAGE_TAG` is set and a step is `compose build`, `compose up -d --build`, or
  `compose up -d`
- **THEN** the wrapper refuses before running any step

#### Scenario: Stage values are refused elsewhere
- **WHEN** `STAGE_IMAGE_TAG` or `STAGE_PUBLIC_BASE_URL` is set for a dev or prod run, or any of
  the stage variable names appears in the OpenBao secret
- **THEN** the run is refused

#### Scenario: A compose edit that ignores the variables fails the check
- **WHEN** `docker/compose.stage.yaml` hard-codes the `api` image, or defaults
  `COOKIE_SECURE` to anything but `0`
- **THEN** `check-envs.sh` fails invariant 7 for stage

### Requirement: Stage images are pushed only from a clean commit, under full-SHA tags
`make stage-push STAGE_IMAGE_TAG=<sha>` SHALL refuse, before invoking `docker buildx bake`,
unless:
- `<sha>` is exactly 40 lowercase hex characters;
- `git status --porcelain` is empty (untracked files count);
- `git rev-parse HEAD` equals `<sha>`;
- `STAGE_PLATFORMS` (default `linux/amd64`) is `linux/amd64`, `linux/arm64`, or both,
  comma-separated;
- the named builder lists `linux/amd64` and `linux/arm64` (the `prod-push` builder check).

It SHALL then bake `docker-bake.hcl` with `GIT_SHA=<sha>` and `--set *.platform=$STAGE_PLATFORMS`
and push. It SHALL NOT require the `main` branch. Because `prod-push` tags the 12-character SHA,
a stage push can never overwrite a prod tag.

#### Scenario: Short or foreign tag refuses push
- **WHEN** `make stage-push` runs with a 12-character tag, or with a 40-character tag that is
  not `HEAD`
- **THEN** it exits non-zero before invoking `docker buildx bake`

#### Scenario: Dirty tree refuses push
- **WHEN** a tracked file is modified, or an untracked source file exists, and
  `make stage-push STAGE_IMAGE_TAG=$(git rev-parse HEAD)` runs
- **THEN** it exits non-zero before invoking `docker buildx bake`

#### Scenario: Unknown platform refuses push
- **WHEN** `STAGE_PLATFORMS=linux/riscv64`
- **THEN** `make stage-push` exits non-zero naming the allowed platforms
