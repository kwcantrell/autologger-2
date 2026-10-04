## MODIFIED Requirements

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

#### Scenario: Unnamed Infisical secrets stay out of the container
- **WHEN** dev is up
- **THEN** `env` inside the `app` container shows no variable outside the allowlist, the pins,
  the five `PG*` catalog connection literals, and the image's own environment
- **AND** it shows no `BAO_*` variable and no `SSL_CERT_FILE`

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

Stage SHALL take its secrets from the OpenBao `stage` KV secret, through the same
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

## ADDED Requirements

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

## REMOVED Requirements

### Requirement: Secrets come from Infisical, one environment per stack
**Reason**: OpenBao replaces Infisical as the secret source. The requirement is replaced by
"Secrets come from OpenBao, one KV path per stack", which keeps the allowed names, formats,
failure rules and ignore rules, and swaps the provider, the credentials file and the request
flow.
**Migration**: The owner, with `~/spark-infra`:
1. Export every key from the Infisical `autologger-dev`, `-stage` and `-prod` projects into
   `kv/autologger/<env>`, and compare the key names.
2. Create the AppRoles and render `.env.openbao.<env>` on each host.
3. Verify each stack with `make check`, then `make dev-up` or `make stage-up` (prod: `make prod-check`).
4. Delete the `.env.infisical.<env>` files and decommission Infisical after the soak period.
