## MODIFIED Requirements

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

## ADDED Requirements

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
