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
  print the app URLs;
- `dev-migrate`, which runs only the migrations runner against dev;
- `dev-psql`, which opens `psql` inside the dev `db` container without keeping a history file.

Every `compose up` step of a target (`dev-up`, `stage-up` with or without a tag, and `prod-up`)
and every `compose down` step (`dev-down`, `dev-reset`, `stage-down`, `stage-reset`,
`prod-down`) SHALL pass `--remove-orphans`, so a container of a service that the compose files
no longer define is removed on the next `up` or `down`, and a reset never leaves one running
against the fresh database. Removing such a container SHALL delete none of its volumes.

The compose wrapper SHALL refuse a `compose run` or `compose exec` step for prod, so neither a
target nor a hand-written wrapper call can run the migrations runner or a shell against the prod
`db`.

A target that removes volumes (`dev-reset`, `stage-reset`) SHALL:
1. refuse unless `CONFIRM=yes` is given;
2. confirm that the resolved project name is exactly `autologger-dev` or
   `autologger-stage` before running `down -v`.

Because `down -v` removes every volume the project's compose files declare, a reset SHALL also
delete that environment's Postgres data and its Postgres configuration volume together. The help
text and the documentation SHALL say so. A volume the compose files no longer declare, such as
the retired `supabase-storage` volume, survives a reset; the documentation SHALL give the command
that removes it by hand. Supabase's init SQL runs only on an
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

#### Scenario: A retired service's container is removed on the next up
- **WHEN** the dev project still runs `rest`, `realtime`, `storage` and `supabase-gw` containers
  started from an older checkout, and `make dev-up` runs
- **THEN** those four containers are removed, and the `supabase-storage`, `supabase-db` and
  `supabase-db-config` volumes still exist

#### Scenario: A reset leaves no retired container running
- **WHEN** the dev project runs those four containers from an older checkout and
  `make dev-reset CONFIRM=yes` runs
- **THEN** the four containers are removed with the project's own, so none of them reaches the
  database the next `make dev-up` creates

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
  "Secrets come from one OpenBao KV path per stack, retired keys ignored").
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
- Every port the dev project publishes SHALL be a gate port: the app gate or the Companion
  gate.
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
  `docker/supabase/migrate.sh`, the migrations directory `supabase/migrations`, and the Supabase
  init SQL files under `docker/supabase/init/`. Each of these SHALL also be read-only. The runner
  script and the migrations directory SHALL be mounted only into `migrate`, and the init SQL only
  into `db`.
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

### Requirement: Stage coexists with prod; dev is disjoint by construction
The stage project SHALL be startable while the prod project runs on the same host. Stage's
subnets, `container_name`, volumes, and published ports SHALL differ from prod's. Dev uses
a single app subnet, and ports distinct from both. Each project's `db` network SHALL have its own
pinned subnet: `172.28.12.0/24` for prod, `172.28.22.0/24` for stage, and `172.28.31.0/24` for
dev. Each project's `catalog` network (pinned `172.28.15.0/24` prod, `172.28.25.0/24` stage,
`172.28.34.0/24` dev), `auth-egress` network (pinned `172.28.16.0/24` prod, `172.28.27.0/24`
stage, `172.28.35.0/24` dev) and `auth-app` network (pinned `172.28.17.0/24` prod,
`172.28.28.0/24` stage, `172.28.36.0/24` dev) SHALL be its own. No project SHALL define a
`supabase` or `edge` network. Its Postgres volumes SHALL be scoped to that project. No Supabase
service publishes a port, so no environment has a Supabase port to keep distinct.

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
- **AND** each has its own `auth` service on its own `auth-app` network, and neither
  environment's app can reach the other environment's `auth`

#### Scenario: Production router defaults unchanged
- **WHEN** the Caddyfile is adapted with neither gateway variable set
- **THEN** the adapted JSON equals the committed baseline (`make check` invariant 13), and
  `docker/scripts/test_router.sh stage` passes

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
  `compose up -d --no-build --remove-orphans`; the wrapper SHALL refuse any build step, and any `up` without
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

GoTrue's `API_EXTERNAL_URL`, `GOTRUE_SITE_URL` and `GOTRUE_JWT_ISSUER` SHALL be the internal
literal `http://auth:9999` in every mode; no public Supabase host is configured, and no browser
reaches GoTrue.

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

## REMOVED Requirements

### Requirement: Static invariant check
**Reason**: Two scenario titles, "The gateway on the db network is caught" and "A host-reachable supabase network is caught", name a service and a network that no longer exist, and invariant 16 changes for the removed services.
**Migration**: Replaced by "Static invariant check of the compose projects", which keeps every other scenario and adds checks that the removed services, the `supabase` and `edge` networks, and the retired keys stay out.

### Requirement: Supabase secret generator
**Reason**: The generator no longer creates `ANON_KEY`, `SERVICE_ROLE_KEY`, `SECRET_KEY_BASE` or `REALTIME_DB_ENC_KEY`, so the scenarios "The anon and service-role keys verify against the JWT secret" and "A partial JWT trio is refused" no longer hold.
**Migration**: Replaced by "Database and GoTrue secret generator", which creates `POSTGRES_PASSWORD`, `SUPABASE_ROLES_PASSWORD`, `APP_DB_PASSWORD` and `JWT_SECRET` and leaves the retired keys alone.

### Requirement: Secrets come from OpenBao, one KV path per stack
**Reason**: The anon and service-role keys are retired and no longer checked, so the scenario "Swapped Supabase API keys are refused" no longer holds.
**Migration**: Replaced by "Secrets come from one OpenBao KV path per stack, retired keys ignored", which is the same requirement with four Supabase keys and the five retired keys accepted, ignored and named in a warning.

### Requirement: Supabase gateway routes and key checks
**Reason**: The gateway (`supabase-gw`) and the services it routed to (`rest`, `realtime`, `storage`) are removed. Nothing in the server, the web or the Companion called them (ADR 0021 slice 10, owner decision 3, and this change's owner decisions, 2026-10-08).
**Migration**: The GoTrue rules (Google only, no email, phone or anonymous sign-in, no auto-confirm) move to "GoTrue accepts only Google sign-in", checked from inside the `auth-app` network against `http://auth:9999/settings`. `docker/supabase-gw.Caddyfile` and `docker/supabase/test_gateway.sh` are deleted and remain in git history.

## ADDED Requirements

### Requirement: Static invariant check of the compose projects
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
    - a service other than `db`, `migrate` and `auth` joins the `db` network; `migrate` joins any
      other network; or `db` joins any network other than `db` and `catalog`;
    - the `catalog` network's members are not exactly `db` and the app service (dev `app`;
      stage and prod `api`), or the app service joins `db`. A service with
      `network_mode: service:X` counts as a member of X's networks, and only `app-gate` may
      share `app`'s namespace;
    - a service named `rest`, `realtime`, `storage` or `supabase-gw` exists, or a service joins a
      network named `supabase` or `edge`;
    - `auth`'s networks are not exactly `db`, `auth-egress` and `auth-app`; a service other than
      `auth` joins `auth-egress`; the `auth-app` network's members are not exactly `auth` and the
      app service (dev `app`; stage and prod `api`); or the stage or prod `api` joins networks
      other than `back`, `catalog` and `auth-app`;
    - `db`, `migrate` or `auth` publishes a port;
    - the `db`, `catalog` or `auth-app` network is not internal, does not isolate the host from
      it (no host address on the bridge), or is not on that environment's pinned subnet
      (`catalog`: prod `172.28.15.0/24`, stage `172.28.25.0/24`, dev `172.28.34.0/24`;
      `auth-app`: prod `172.28.17.0/24`, stage `172.28.28.0/24`, dev `172.28.36.0/24`); or the
      `auth-egress` network is not on its pinned subnet (prod `172.28.16.0/24`, stage
      `172.28.27.0/24`, dev `172.28.35.0/24`);
    - the image of `db`, `migrate` or `auth` is not pinned by `@sha256:` digest;
    - the placeholder value given for any Supabase secret appears anywhere (environment, command,
      labels, healthcheck, build arguments, or any other field) in a service outside that
      secret's allowed set. A retired key has no allowed service, so its placeholder appearing in
      any service fails:

      | Secret | Allowed services |
      | --- | --- |
      | `POSTGRES_PASSWORD` | `db`, `migrate` |
      | `SUPABASE_ROLES_PASSWORD` | `db`, `auth` |
      | `APP_DB_PASSWORD` | dev: `app`, `migrate`; stage and prod: `api`, `migrate` |
      | `JWT_SECRET` | `auth` |
      | `ANON_KEY`, `SERVICE_ROLE_KEY`, `SECRET_KEY_BASE`, `REALTIME_DB_ENC_KEY`, `SUPABASE_PORT` (retired) | none |

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
- **WHEN** `POSTGRES_PASSWORD` is referenced in the `auth` service's environment
- **THEN** `make check` exits non-zero and names invariant 16

#### Scenario: The app password in another service is caught
- **WHEN** `PGPASSWORD: ${APP_DB_PASSWORD}` is added to the `auth` service's environment
- **THEN** `make check` exits non-zero and names invariant 16

#### Scenario: The app on the shared db network is caught
- **WHEN** the dev `app` is joined to the `db` network
- **THEN** `make check` exits non-zero and names invariant 16

#### Scenario: A third member of the catalog network is caught
- **WHEN** `auth`, or the dev `companion`, is joined to the `catalog` network, or a new service
  sets `network_mode: service:app`
- **THEN** `make check` exits non-zero and names invariant 16

#### Scenario: Clean tree passes
- **WHEN** `make check` runs on the committed files
- **THEN** it exits zero

#### Scenario: A second member of the auth egress network is caught
- **WHEN** `db`, or the app service, is joined to the `auth-egress` network
- **THEN** `make check` exits non-zero and names invariant 16

#### Scenario: A third member of the auth-app network is caught
- **WHEN** `db`, or the dev `companion`, is joined to the `auth-app` network
- **THEN** `make check` exits non-zero and names invariant 16

#### Scenario: A retired Supabase service is caught
- **WHEN** a `rest`, `realtime`, `storage` or `supabase-gw` service is added back to
  `docker/supabase-services.yaml`, digest-pinned and publishing no port
- **THEN** `make check` exits non-zero and names invariant 16

#### Scenario: A supabase or edge network is caught
- **WHEN** `auth` is joined to a new `supabase` network, or any service to a new `edge` network
- **THEN** `make check` exits non-zero and names invariant 16

#### Scenario: A retired key in a compose file is caught
- **WHEN** `${ANON_KEY}` or `${SERVICE_ROLE_KEY}` is referenced in any service, for example in a
  label of the prod `api` or of `auth`
- **THEN** `make check` exits non-zero and names invariant 16

### Requirement: Database and GoTrue secret generator
`docker/scripts/supabase-keys.mjs ENV [--writer FILE]` SHALL create each missing Supabase secret
for environment `ENV` in that environment's OpenBao KV secret: `POSTGRES_PASSWORD`,
`SUPABASE_ROLES_PASSWORD`, `APP_DB_PASSWORD` and `JWT_SECRET`. It SHALL NOT create, change, delete
or report the retired keys `ANON_KEY`, `SERVICE_ROLE_KEY`, `SECRET_KEY_BASE`,
`REALTIME_DB_ENC_KEY` and `SUPABASE_PORT`. It SHALL:
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
  "Allowed names" (see "Secrets come from one OpenBao KV path per stack, retired keys ignored");
- send every missing key in one write: a KV v2 `PATCH` (`application/merge-patch+json`) with
  `options.cas` set to the version it read, or, when the path does not exist yet, a `POST` with
  `options.cas` `0`. A concurrent write SHALL make the whole write fail, so a run creates all of
  them or none;
- only ever add keys. It SHALL never change or delete an existing key. One of its four keys that
  already exists SHALL be reported as kept. A write that OpenBao rejects SHALL exit non-zero without retrying;
- print key names and outcomes only, never a value or a token;
- refuse Node older than 22.12, and need no npm packages.

#### Scenario: Existing secrets are kept
- **WHEN** the environment already holds `POSTGRES_PASSWORD` and the generator runs
- **THEN** it reports `POSTGRES_PASSWORD` as kept, makes no write request, and exits zero

#### Scenario: A missing secret is created without being shown
- **WHEN** the environment has no `POSTGRES_PASSWORD` and the generator runs
- **THEN** it creates the key with a newly generated value, and neither its output nor its
  error output contains that value

#### Scenario: The JWT secret is created alone
- **WHEN** the environment has no `JWT_SECRET` and the generator runs
- **THEN** it creates `JWT_SECRET`, and creates neither `ANON_KEY` nor `SERVICE_ROLE_KEY`

#### Scenario: Retired keys are left alone
- **WHEN** the environment holds the four keys and also `ANON_KEY`, `SERVICE_ROLE_KEY`,
  `SECRET_KEY_BASE`, `REALTIME_DB_ENC_KEY` and `SUPABASE_PORT`, and the generator runs
- **THEN** it reports the four keys as kept, names no retired key, makes no write request, and
  exits zero

#### Scenario: A rejected create is not retried as an update
- **WHEN** OpenBao answers the write with an error, for example a check-and-set mismatch because
  a concurrent run wrote first
- **THEN** the generator exits non-zero, prints no value, and sends no second write

#### Scenario: The app password is created for an existing stack
- **WHEN** the environment holds the generator's other three keys but not `APP_DB_PASSWORD`, and the
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

### Requirement: Secrets come from one OpenBao KV path per stack, retired keys ignored
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
- one of the Supabase keys `POSTGRES_PASSWORD`, `SUPABASE_ROLES_PASSWORD`, `APP_DB_PASSWORD`
  and `JWT_SECRET`, in every environment. These are interpolation keys that only the services
  allowed for them in invariant 16 receive, and they SHALL NOT be listed in the shared allowlist
  file. Each value SHALL match its format, and a compose target SHALL refuse the environment,
  naming the key and printing no value, when one does not:

  | Key | Format |
  | --- | --- |
  | `POSTGRES_PASSWORD`, `SUPABASE_ROLES_PASSWORD`, `APP_DB_PASSWORD` | at least 32 lowercase hexadecimal characters |
  | `JWT_SECRET` | at least 40 characters of `[A-Za-z0-9_-]` |

  At run time, the wrapper SHALL refuse to start compose if any of these values appears in the
  resolved configuration of a service outside that key's allowed set.
- one of the retired Supabase keys `ANON_KEY`, `SERVICE_ROLE_KEY`, `SECRET_KEY_BASE`,
  `REALTIME_DB_ENC_KEY` and `SUPABASE_PORT`, in every environment. No service uses them. The
  wrapper SHALL accept them without checking their format, SHALL NOT pass them to compose or to
  any other child process, and, when any is present, SHALL print one warning that names the
  retired keys present, prints no value, and says they can be removed from OpenBao. They stay
  allowed until every OpenBao secret has dropped them, because a checkout of an older branch may
  still run the services that used them.

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

#### Scenario: Retired Supabase keys are accepted and not passed on
- **WHEN** the OpenBao `dev` KV secret holds `ANON_KEY` with a value that is not a JWT, and
  `SUPABASE_PORT`, and `make dev-up` runs
- **THEN** it is not refused for them, it prints one warning naming both keys and no value, and
  neither key is in the environment of any compose process or container

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

### Requirement: GoTrue accepts only Google sign-in
Each project SHALL have an `auth` service running GoTrue, the only Supabase API service. It SHALL
publish no port, and its networks SHALL be exactly `db`, `auth-egress` (its way out, to Google)
and `auth-app` (shared only with the app service). The app SHALL reach it only at
`http://auth:9999`, over `auth-app`, with no Supabase key.

GoTrue SHALL start with Google as its only enabled sign-in provider, accepting ID tokens whose
audience is the environment's `GOOGLE_CLIENT_ID`; email, phone and anonymous sign-in SHALL stay
disabled, so a new user can be created only from a Google identity. GoTrue SHALL NOT auto-confirm
email addresses, so it links identities by email only when the address is verified.

GoTrue's `API_EXTERNAL_URL`, `GOTRUE_SITE_URL` and `GOTRUE_JWT_ISSUER` SHALL be the literal
`http://auth:9999`, so its configuration depends on no published port.

#### Scenario: Only Google can create a user
- **WHEN** `http://auth:9999/settings` is read from inside the app container, over the
  `auth-app` network
- **THEN** it reports sign-up enabled, `google` as the only enabled external provider, email,
  phone and anonymous sign-in disabled, and auto-confirm off

#### Scenario: Google sign-in works through the internal address
- **WHEN** a user with a verified Google account signs in to the dev app at
  `http://localhost:<DEV_PORT>/`
- **THEN** the server's exchange with `http://auth:9999/token?grant_type=id_token` succeeds, and
  `/api/profile` reports the user

#### Scenario: GoTrue publishes no port
- **WHEN** any project's configuration is resolved
- **THEN** `auth` has no published port
