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
  print the app and Supabase URLs (`prod-up` also runs the migrations runner; see "Prod targets
  are explicit and bound to committed content");
- `dev-migrate`, which runs only the migrations runner against dev;
- `dev-psql`, which opens `psql` inside the dev `db` container without keeping a history file.

For prod, the compose wrapper SHALL run only compose steps whose words are exactly one of
`config --quiet`, `pull`, `run --rm migrate`, `up -d`, `down` and `logs -f --tail=200`, and
SHALL refuse any other prod compose step before any request. It SHALL refuse the
`run --rm migrate` step unless the plan has the `prod-tags` and `resolved` steps before it, and
SHALL refuse to run it unless, checked immediately before the step, the working tree is clean
and on branch `main`. So no target and no hand-written wrapper call can open a shell against the
prod `db`, pass extra compose files or flags, or run the migrations runner from uncommitted
files or without the prod guards.

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
- **WHEN** the compose wrapper is called for prod with a `compose exec db psql`,
  `compose run migrate`, `compose run --rm migrate sh`, `compose run --rm db`,
  `compose --profile tools run migrate` or `compose -f other.yaml up -d` step, or with
  `compose run --rm migrate` not preceded by `prod-tags` and `resolved`
- **THEN** it exits non-zero before any OpenBao request and before running docker, and names
  the refused step

#### Scenario: The wrapper lets prod run the migrations runner
- **WHEN** the prod plan is `prod-tags`, `resolved`, `compose run --rm migrate`, `compose up -d`
- **THEN** the plan check accepts it

#### Scenario: The wrapper refuses to migrate prod from an unclean tree
- **WHEN** the prod migrate step is reached in a tree with an uncommitted or untracked file, or
  on a branch other than `main`
- **THEN** the wrapper exits non-zero before running docker, naming the reason

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
  KV secret;
- after those guards and the resolved-config check, run the migrations runner once `db` is
  healthy, and only then start the project; if the runner fails, start nothing else.

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

#### Scenario: Prod start migrates first
- **WHEN** `make prod-up` runs on a clean `main` against an empty prod `db`
- **THEN** the migrations runner applies every migration and sets the `autologger_app`
  password before `api` is started, and `api` connects as `autologger_app`

#### Scenario: A repeated prod start applies nothing new
- **WHEN** `make prod-up` runs again with no new migration file
- **THEN** the runner reports `0 applied` and the project starts as before

#### Scenario: A failed prod migration starts nothing
- **WHEN** a migration fails during `make prod-up`
- **THEN** the target exits non-zero naming the file, and `compose up` does not run

#### Scenario: Prod dry run starts nothing
- **WHEN** `make prod-check` runs on any branch with valid prod credentials
- **THEN** it exits zero and no container of project `autologger` is created or recreated
