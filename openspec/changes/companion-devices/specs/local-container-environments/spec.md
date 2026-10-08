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

The following SHALL be settable through the OpenBao `dev` KV secret:
- `DEEPGRAM_API_KEY`
- `SHEETS_LOG_IMPORT_ENABLED`
- `AI_V2_ENABLED`
- `AI_V2_API_KEY`
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`

`API_TOKEN` is no longer read by the server (ADR 0021 slice 9d). `docker/secrets-env.yaml` SHALL
keep allowing it, commented as ignored, until every OpenBao secret has dropped it, because the
allowlist refuses a whole secret that holds an unlisted key. The env examples SHALL NOT list it
and SHALL point to Settings › Companion devices instead.

Sign-in is required, as in every stack:
- The OpenBao `dev` KV secret SHALL hold its own Google OAuth client
  (`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`); without it, dev refuses to start (see
  "Secrets come from OpenBao, one KV path per stack").
- Google sign-in works against `PUBLIC_BASE_URL=http://localhost:${DEV_PORT}`, which the
  compose file pins.
- The documentation SHALL state the redirect URI the OAuth client needs, and that dev needs
  the Google client in the OpenBao `dev` KV secret.

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
- **WHEN** a Companion device token created in stage's Settings › Companion devices is sent as a
  Bearer token through the stage router
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
network, authenticating with a Companion device token that the operator creates in the dev
app's Settings › Companion devices and enters once in the Companion UI, where the module keeps it
as a secret. After the deploy that retires `API_TOKEN`, the dev connection SHALL be re-paired with
such a token.

The build's per-Dockerfile ignore file SHALL be in allowlist form. It begins by excluding
everything, then re-admits only the root manifest, the lockfile, and the `companion/`
sources.

#### Scenario: Module is available
- **WHEN** the Companion admin UI is opened
- **THEN** the AutoLogger connection type is offered as a dev module
- **AND** the packaged manifest in the image carries `runtime.apiVersion` `1.14.x`

#### Scenario: Dev Companion drives the app
- **WHEN** a dev Companion connection is configured with the documented base URL and a device
  token created in the dev app's Settings, while a signed-in browser of that token's user has a
  session open
- **THEN**:
  - it reaches status OK;
  - a Companion "log event" action creates an event visible in the dev app.

#### Scenario: Companion admin UI is rebinding-safe
- **WHEN** a request reaches the Companion port with `Host: evil.example:8000`
- **THEN** the Companion gate rejects it
