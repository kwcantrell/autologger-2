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
| dev | `autologger-dev` | `docker/compose.dev.yaml` | `--project-directory .`, Infisical environment `dev` |
| stage | `autologger-stage` | `compose.yaml` + `docker/compose.stage.yaml` | the overlay's `name:` wins; Infisical environment `stage` |
| prod | `autologger` | `compose.yaml` | Infisical environment `prod`, exactly as README "Container deployment" documents |

Every target that touches a compose project SHALL:
- log in to Infisical once;
- run its guards and its compose commands in a single `infisical run` for its environment,
  under a clean environment that contains only a fixed base plus that environment's secrets;
- pass an explicit empty `--env-file`, so compose never reads the root `.env` or any other env
  file for interpolation.

Variables in the operator's shell SHALL NOT reach compose or any container. Ports and tags are
set in Infisical. A `docker compose` command typed by hand against these files, outside the
Makefile, SHALL fail with a message naming the Makefile, rather than start a service without
its secrets.

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

#### Scenario: A stray root .env is ignored
- **WHEN** a root `.env` exists that sets `DEV_PORT` or a secret key, and `make dev-up` runs
- **THEN** the resolved dev config takes neither value from that file

#### Scenario: Shell variables do not leak into a stack
- **WHEN** the operator's shell exports `API_TOKEN=weak`, the Infisical `stage` environment
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

The following SHALL be settable through the Infisical `dev` environment:
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
  - the Infisical `dev` environment sets `DEEPGRAM_API_KEY`, `SHEETS_LOG_IMPORT_ENABLED=1`,
    and `AI_V2_ENABLED=1`, and no `AI_V2_API_KEY`
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
- **WHEN** the Infisical `dev` environment sets a Google OAuth client whose redirect URI is
  `http://localhost:<DEV_PORT>/auth/google/callback`, and a user signs in at
  `http://localhost:<DEV_PORT>/`
- **THEN** the callback completes on that origin, and `/api/profile` reports the user

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
  - a `.env` file, including an Infisical credentials file;
  - any other path under the host home directory, which includes `~/.claude` as a directory
    and `~/.claude.json`.

The runtime user's home SHALL be a named volume of the dev project (`dev-home`). The CLI's
session store, its `~/.claude.json`, and its history live there, never on the host.

The dev `app` container SHALL receive secrets only as the variables named in the shared
allowlist file, each passed through from the Infisical `dev` environment. It SHALL have no `env_file`, and
SHALL NOT receive the Infisical access token or machine-identity credentials. The
documentation SHALL state the accepted residuals of the credentials mount:
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

#### Scenario: Unnamed Infisical secrets stay out of the container
- **WHEN** dev is up
- **THEN** `env` inside the `app` container shows no variable outside the allowlist, the pins,
  and the image's own environment
- **AND** it shows no `INFISICAL_*` variable and no `SSL_CERT_FILE`

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
- use `compose.yaml` with the Infisical `prod` environment exactly as README "Container
  deployment" documents, with no overlay;
- fail if `WEB_TAG` or `API_TAG` is unset, empty, or `latest` in the Infisical `prod`
  environment.

`prod-check` SHALL run the prod guards and resolve the prod config through Infisical `prod`
without starting anything and without the `main` requirement. This lets a deploy host dry-run
the Infisical path before cutover.

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
- **WHEN** the Infisical `prod` environment has `API_TAG=latest` and `make prod-up` runs on a
  clean `main`
- **THEN** it exits non-zero naming `API_TAG`, and starts nothing

#### Scenario: Prod dry run starts nothing
- **WHEN** `make prod-check` runs on any branch with valid prod credentials
- **THEN** it exits zero and no container of project `autologger` is created or recreated

### Requirement: Static invariant check
`docker/scripts/check-envs.sh` SHALL resolve each environment with
`docker compose config --no-env-resolution`, using placeholder `--env-file`s it writes to a
temporary directory. It SHALL never contact Infisical, and SHALL never read or print `.env`,
`.env.dev`, `.env.stage`, or any `.env.infisical.*` file.

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
14. Any service in the dev, stage, or prod project has an `env_file`. The prod project
    combined with the `e2e:container` overlay is exempt.
15. The key names listed in the shared allowlist file differ from the null-passthrough names
    of the resolved prod `api` or dev `app`, excluding keys that service pins with a literal.

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

#### Scenario: Clean tree passes
- **WHEN** `make check` runs on the committed files
- **THEN** it exits zero

## ADDED Requirements

### Requirement: Secrets come from Infisical, one environment per stack
Each stack SHALL read its secrets and its compose interpolation values from one Infisical
environment of the owner's Infisical project: `dev`, `stage`, or `prod`. Each environment SHALL
be read with its own machine identity.

The per-host credentials for an environment SHALL live in an untracked file
`.env.infisical.<env>` at the repository root. The file SHALL hold:
- the machine identity's client id and client secret;
- the project id;
- the Infisical URL, which SHALL use `https://`;
- optionally, the path of the CA certificate that Infisical's TLS chains to.

The Infisical URL and CA path SHALL NOT be written in any tracked file other than examples and
documentation, so moving Infisical to another host needs no code change. The tracked template
SHALL be `docker/infisical-credentials.example`, with keys and no values.

**Git ignore rules.** The files `.env`, `.env.dev`, `.env.stage`, and `.env.infisical.*` SHALL be
ignored by git, and the tracked templates SHALL NOT be.

**Allowed names.** Every Infisical key an environment may hold SHALL be either:
- listed in the shared allowlist file, which lists the keys containers may receive; or
- one of that environment's fixed compose-interpolation keys: `DEV_PORT` and
  `DEV_COMPANION_PORT` for dev, `STAGE_PORT` for stage, and `ROUTER_PORT`, `WEB_TAG`, `API_TAG`,
  and `PUBLIC_BASE_URL` for prod.

**Documentation.** The documentation SHALL:
- list those keys;
- state the `WEB_TAG`/`API_TAG` format (the 12-character git SHA that `prod-push` produces);
- warn against reusing prod secrets in dev or stage;
- describe a break-glass procedure for when Infisical is unreachable.

**Failures.** A compose target SHALL fail before starting anything, with a message that names
the fix and prints no secret value, when:
- the Infisical CLI is not installed;
- the environment's credentials file is missing, lacks a key, names a missing CA file, uses a
  non-`https` URL, or is readable by group or others;
- login fails, including a TLS verification failure. The message SHALL NOT suggest disabling
  verification or using plain HTTP;
- the environment injects any name outside its allowed names. The message SHALL list only
  offending names that are valid identifiers.

**Secret handling.** The client secret and the access token SHALL NOT appear on any command line
and SHALL NOT be written to disk by the Makefile or its scripts. Secret values SHALL be injected
without reference expansion.

#### Scenario: Credentials and old env files are ignored, templates are not
- **WHEN** `git check-ignore .env .env.dev .env.stage .env.infisical.dev .env.infisical.prod` is run
- **THEN** all five are ignored, and `docker/infisical-credentials.example` is not

#### Scenario: Missing credentials file
- **WHEN** `make stage-up` runs with no `.env.infisical.stage`
- **THEN** it exits non-zero with a message naming `docker/infisical-credentials.example`,
  and starts nothing

#### Scenario: Plain HTTP is refused
- **WHEN** `.env.infisical.dev` sets an `http://` Infisical URL and `make dev-up` runs
- **THEN** it exits non-zero before contacting Infisical, and starts nothing

#### Scenario: A hostile secret name is refused
- **WHEN** the Infisical `dev` environment holds a key named `LD_PRELOAD` or `DOCKER_HOST`, and
  `make dev-up` runs
- **THEN** it exits non-zero naming that key, prints no value, and runs no docker command

#### Scenario: Secrets stay off the process list
- **WHEN** `make dev-up` is running and `ps -eo args` is captured
- **THEN** no captured argument contains the client secret or the access token

## REMOVED Requirements

### Requirement: Env files are untracked and templated
**Reason**: Infisical replaces the per-stack env files `.env`, `.env.dev`, and `.env.stage` as
the source of secrets. The ignore rules and the template warnings move to "Secrets come from
Infisical, one environment per stack".
**Migration**: The owner does the following, in order:
1. Copy each env file's values into the matching Infisical environment, after comparing its key
   names with the allowed names.
2. Put the per-host credentials files in place from `docker/infisical-credentials.example`.
3. Verify the stacks.
4. After this reaches `main` at cutover, and after a verified Infisical backup and restore
   test, delete the old env files and the `docker/.env*.example` templates.
