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
| dev | `autologger-dev` | `docker/compose.dev.yaml` | `--project-directory .`, `--env-file .env.dev` |
| stage | `autologger-stage` | `compose.yaml` + `docker/compose.stage.yaml` | the overlay's `name:` wins; `--env-file .env.stage` |
| prod | `autologger` | `compose.yaml` | root `.env`, exactly as README "Container deployment" documents |

Every dev and stage target SHALL pass its `--env-file`, so compose's default interpolation
file (the root `.env`, which is prod's) is never read for dev or stage.

The Makefile SHALL also provide:
- `help`, as the default goal;
- `check`, which runs the static invariant check;
- `dev-up` and `stage-up`, which run their environment's check first and refuse to start if
  it fails.

A target that removes volumes (`dev-reset`, `stage-reset`) SHALL:
1. refuse unless `CONFIRM=yes` is given;
2. confirm that the resolved project name is exactly `autologger-dev` or
   `autologger-stage` before running `down -v`.

No target SHALL remove a prod volume or run `docker volume prune` or
`docker system prune`.

#### Scenario: Help is the default goal
- **WHEN** `make` is run with no target
- **THEN** it prints the target list and starts no container

#### Scenario: Reset refuses without confirmation
- **WHEN** `make dev-reset` is run without `CONFIRM=yes`
- **THEN** it exits non-zero and no volume of project `autologger-dev` is removed

#### Scenario: Hand-typed compose resolves to the right project
- **WHEN** `docker compose -f compose.yaml -f docker/compose.stage.yaml config` is resolved
  with no `-p`
- **THEN** the project name is `autologger-stage`, not `autologger`

#### Scenario: No prod volume removal
- **WHEN** the Makefile is searched for `down -v`, `--volumes`, `volume rm`, or `prune`
- **THEN** each use belongs to `dev-reset` or `stage-reset`, behind both guards

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

The following SHALL be settable through the dev env file:
- `DEEPGRAM_API_KEY`
- `SHEETS_LOG_IMPORT_ENABLED`
- `AI_V2_ENABLED`
- `AI_V2_API_KEY`
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`

Sign-in is optional:
- With the Google keys empty, dev is anonymous.
- With them set, Google sign-in works against `PUBLIC_BASE_URL=http://localhost:${DEV_PORT}`,
  which the compose file pins.
- The documentation SHALL state:
  - the redirect URI the OAuth client needs;
  - that while OAuth is configured, anonymous requests see an empty show list.

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
  - `.env.dev` sets `DEEPGRAM_API_KEY`, `SHEETS_LOG_IMPORT_ENABLED=1`, and
    `AI_V2_ENABLED=1`, and no `AI_V2_API_KEY`
- **THEN** none of these is answered with its "not configured", open-network-refusal, or
  credentials-refusal `503`:
  - AI chat;
  - `topics/generate`;
  - `events/generate`;
  - AI v2 design;
  - YouTube import;
  - Sheets log import;
  - transcript generation.

#### Scenario: Optional sign-in
- **WHEN** `.env.dev` sets a Google OAuth client whose redirect URI is
  `http://localhost:<DEV_PORT>/auth/google/callback`, and a user signs in at
  `http://localhost:<DEV_PORT>/`
- **THEN** the callback completes on that origin, and `/api/profile` reports the user

### Requirement: Dev app binds loopback behind a Host/Origin gate
The dev app SHALL bind `127.0.0.1` inside its container. The compose file SHALL pin these
as literal values, never `${…}` references, in the app's `environment:`:
- `HOST=127.0.0.1`
- `REQUIRE_LOGIN=0`
- `TRUST_PROXY=0`
- `IP_ALLOWLIST=` (empty)
- `DATA_DIR`
- `PORT`

`PUBLIC_BASE_URL` SHALL be pinned to `http://localhost:${DEV_PORT:-8787}`, which is the only
permitted variable in the pinned block.

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
- Every port the dev project publishes SHALL be a gate port.
- No dev or stage published port SHALL be `8080`.

Because the bind is loopback, both the open-network refusal and the AI v2 credentials rule
pass. Only the host (through the published loopback port) and containers on the dev
network (through the gate) can reach the app. The design SHALL record that this relies on
the gate for exactly the reach the loopback rule assumes.

#### Scenario: Loopback posture
- **WHEN** the dev app starts with the pinned environment
- **THEN** the server reports a loopback bind, prints no open-network warning, and neither
  the open-network refusal nor the AI v2 credentials refusal is in effect

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

### Requirement: Dev isolates data and secrets, sharing only the operator's Claude login
The dev environment SHALL set `DATA_DIR` to a path inside a named volume of the dev project.

Bind mounts:
- Source bind mounts SHALL be read-only.
- Each source mount SHALL resolve under a repository source subtree. The one exception is
  the gate configuration file `docker/dev-gate.Caddyfile`, which SHALL also be read-only.
- The mounted source subtrees SHALL include `packages/catalog/migrations`.
- The only read-write bind mount SHALL be the host `~/.claude/.credentials.json` file,
  mounted at the runtime user's `~/.claude/.credentials.json`. This gives the dev CLI and
  Agent SDK the operator's Claude login.
- No bind mount SHALL be any of the following:
  - the repository root;
  - a path with a `data` segment;
  - a `.env` file;
  - any other path under the host home directory, which includes `~/.claude` as a directory
    and `~/.claude.json`.

The runtime user's home SHALL be a named volume of the dev project (`dev-home`). The CLI's
session store, its `~/.claude.json`, and its history live there, never on the host.

The env file SHALL be read only through compose `env_file`. The documentation SHALL state
the accepted residuals of the credentials mount:
- the container can read the operator's Claude login;
- the OAuth token may be refreshed, and the file rewritten, by either the container or host
  Claude Code sessions.

#### Scenario: Resolved config mounts nothing forbidden
- **WHEN** the dev project's config is resolved the way the Makefile resolves it
- **THEN**:
  - every source mount is read-only, and names an existing path under a source subtree;
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

### Requirement: Stage behaves as production, with local sign-in
The stage environment SHALL run `compose.yaml` with `docker/compose.stage.yaml` layered
over it. Its `web` and `api` images SHALL be built locally from the same `docker/Dockerfile`
targets as production, for the host's native platform.

At the compose level, the overlay SHALL differ from production only in:
- `name:`;
- `api` `container_name`;
- network subnets, and the router gateway variables that match them;
- image names and tags;
- the `api` env file;
- `PUBLIC_BASE_URL=http://localhost:${STAGE_PORT:-8788}`;
- `COOKIE_SECURE=0`;
- `SESSION_COOKIE=autologger_stage_sid`;
- the router's published port, `127.0.0.1:${STAGE_PORT:-8788}` via `ports: !override`.

Things stage keeps from production:
- The api home, which holds the Claude login, SHALL remain a named volume of the stage
  project, logged in with `make stage-claude-login`. Stage SHALL NOT mount the host
  `~/.claude`.
- AI v2 in stage SHALL require `AI_V2_API_KEY`, as in production.
- Stage SHALL have no Companion service.

One variable, `STAGE_PORT`, SHALL drive both the published port and `PUBLIC_BASE_URL`. The
Makefile SHALL supply placeholders for `compose.yaml`'s required `WEB_TAG`, `API_TAG`, and
`PUBLIC_BASE_URL`, because compose interpolates the base file before the merge.
`REQUIRE_LOGIN=1` and `TRUST_PROXY=1` SHALL remain as `compose.yaml` pins them.

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
network, anonymously.

The build's per-Dockerfile ignore file SHALL be in allowlist form. It begins by excluding
everything, then re-admits only the root manifest, the lockfile, and the `companion/`
sources.

#### Scenario: Module is available
- **WHEN** the Companion admin UI is opened
- **THEN** the AutoLogger connection type is offered as a dev module
- **AND** the packaged manifest in the image carries `runtime.apiVersion` `1.14.x`

#### Scenario: Dev Companion drives the app
- **WHEN** a dev Companion connection is configured with the documented base URL
- **THEN**:
  - it reaches status OK;
  - a Companion "log event" action creates an event visible in the dev app.

#### Scenario: Companion admin UI is rebinding-safe
- **WHEN** a request reaches the Companion port with `Host: evil.example:8000`
- **THEN** the Companion gate rejects it

### Requirement: Stage coexists with prod; dev is disjoint by construction
The stage project SHALL be startable while the prod project runs on the same host. Stage's
subnets, `container_name`, volumes, and published ports SHALL differ from prod's. Dev uses
a single subnet, and ports distinct from both.

The router's trusted-proxy gateways SHALL be read from `ROUTER_FRONT_GW` and
`ROUTER_BACK_GW`. They default to `172.28.10.1` and `172.28.11.1`, so production's adapted
router configuration is byte-identical. `compose.yaml` SHALL NOT set either variable.
Wherever either is set, its value SHALL be a single dotted IPv4 address.

#### Scenario: Stage beside prod
- **WHEN** the prod stack is up and `make stage-up` runs
- **THEN** stage starts without a network-pool overlap or container-name conflict, and
  prod's containers are not recreated

#### Scenario: Production router defaults unchanged
- **WHEN** the Caddyfile is adapted with neither gateway variable set
- **THEN** the adapted JSON equals the pre-change adapted JSON, and `npm run e2e:container`
  passes, including the forged `X-Forwarded-For` case

### Requirement: Env files are untracked and templated
The files `.env`, `.env.dev`, and `.env.stage` SHALL be ignored by git.

The tracked templates are `docker/.env.example`, `docker/.env.dev.example`, and
`docker/.env.stage.example`. They SHALL:
- not be ignored;
- contain no real values;
- each name the path it is copied to;
- warn against reusing prod secrets.

`docker/.env.example` SHALL:
- state that `PUBLIC_BASE_URL` must be set there, because compose interpolates it into the
  `api` environment;
- show the `WEB_TAG`/`API_TAG` format: the 12-character git SHA that `prod-push` produces.

A dev or stage target SHALL fail when its env file is missing, with a message naming the
template.

#### Scenario: Env files are ignored
- **WHEN** `git check-ignore .env .env.dev .env.stage` is run
- **THEN** all three are ignored, and none of the three `docker/*.example` templates is
  ignored

#### Scenario: Missing env file
- **WHEN** `make stage-up` runs with no `.env.stage`
- **THEN** it exits non-zero with a message naming `docker/.env.stage.example`, and starts
  nothing

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
- use `compose.yaml` and `.env` exactly as README "Container deployment" documents, with no
  overlay;
- fail if `WEB_TAG` or `API_TAG` is unset.

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

### Requirement: Static invariant check
`docker/scripts/check-envs.sh` SHALL resolve each environment with
`docker compose config --no-env-resolution`, using placeholder `--env-file`s it writes to a
temporary directory. It SHALL never read or print `.env`, `.env.dev`, or `.env.stage`.

It SHALL fail, naming the violated invariant, when any of the following holds:
1. A published port in any project is not bound to `127.0.0.1`.
2. A dev or stage port is `8080`.
3. A dev published port is not a gate port.
4. A dev bind mount violates the dev data and secret rule (the gate Caddyfile read-only
   exception included).
5. A `packages/*/src` directory is not mounted.
6. A dev posture pin is not a literal in the raw file, or resolves to a different value.
7. Stage's or prod's `REQUIRE_LOGIN=1` is missing or has a different value.
8. Stage mounts a host path under the home directory.
9. A compose file resolves, without `-p`, to a project name other than its declared one.
10. A router gateway variable is set in `compose.yaml`, or is set anywhere to a value that
    is not a single dotted IPv4 address.
11. `docker/.env` exists.
12. The companion ignore file does not begin with an exclude-all line.
13. The Caddyfile adapted with no gateway variables differs from the committed baseline.

It SHALL need only `docker`, `jq`, and a POSIX shell.

#### Scenario: A LAN-published port is caught
- **WHEN** the dev compose file is edited to publish `0.0.0.0:8787:8787`
- **THEN** `make check` exits non-zero and names the dev port binding

#### Scenario: An overridable pin is caught
- **WHEN** the dev compose file is edited to `HOST: ${DEV_HOST:-127.0.0.1}`
- **THEN** `make check` exits non-zero and names the non-literal pin

#### Scenario: Clean tree passes
- **WHEN** `make check` runs on the committed files
- **THEN** it exits zero

