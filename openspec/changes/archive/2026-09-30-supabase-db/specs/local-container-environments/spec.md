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
- fetch its environment's secrets once, check every name before any program is started with
  them, and run its guards and its compose commands in one clean environment that contains only
  a fixed base plus those secrets;
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
  it fails, and which run the migrations runner once `db` is healthy;
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
environment's Postgres data and its Postgres configuration volume together. The help text and
the documentation SHALL say so.

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
- **WHEN** the operator's shell exports `API_TOKEN=weak`, the Infisical `stage` environment
  has no `API_TOKEN`, and `make stage-up` runs
- **THEN** the stage `api` container has no `API_TOKEN`

#### Scenario: Hand-typed compose refuses to start
- **WHEN** `docker compose -f compose.yaml up -d` is run by hand with the prod tags exported
- **THEN** it fails before creating a container, with a message naming the Makefile

### Requirement: Dev isolates data and secrets, sharing only the operator's Claude login
The dev environment SHALL set `DATA_DIR` to a path inside a named volume of the dev project.

Bind mounts:
- Source bind mounts SHALL be read-only.
- Each source mount SHALL resolve under a repository source subtree. The exceptions are
  the gate configuration file `docker/dev-gate.Caddyfile`, the migrations runner script
  `docker/supabase/migrate.sh`, and the migrations directory `supabase/migrations`. Each of
  these SHALL also be read-only, and the last two SHALL be mounted only into `migrate`.
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
  and the image's own environment
- **AND** it shows no `INFISICAL_*` variable and no `SSL_CERT_FILE`

### Requirement: Stage coexists with prod; dev is disjoint by construction
The stage project SHALL be startable while the prod project runs on the same host. Stage's
subnets, `container_name`, volumes, and published ports SHALL differ from prod's. Dev uses
a single app subnet, and ports distinct from both. Each project's `db` network SHALL have its own
pinned subnet: `172.28.12.0/24` for prod, `172.28.22.0/24` for stage, and `172.28.31.0/24` for
dev. Its Postgres volumes SHALL be scoped to that project.

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

#### Scenario: Production router defaults unchanged
- **WHEN** the Caddyfile is adapted with neither gateway variable set
- **THEN** the adapted JSON equals the pre-change adapted JSON, and `npm run e2e:container`
  passes, including the forged `X-Forwarded-For` case

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
16. In any of the dev, stage, or prod projects:
    - `db` or `migrate` publishes a port, or joins a network other than `db`;
    - a service other than `db` and `migrate` joins the `db` network;
    - the `db` network is not internal, does not isolate the host from it (no host address on
      the bridge), or is not on that environment's pinned subnet;
    - the `db` or `migrate` image is not pinned by `@sha256:` digest;
    - the placeholder value given for `POSTGRES_PASSWORD` appears anywhere in a service other
      than `db` or `migrate` (environment, command, labels, healthcheck, build arguments, or any
      other field).

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

#### Scenario: Clean tree passes
- **WHEN** `make check` runs on the committed files
- **THEN** it exits zero

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
- `POSTGRES_PASSWORD`, in every environment. It is an interpolation key that only `db` and
  `migrate` receive, and it SHALL NOT be listed in the shared allowlist file. Its value SHALL be
  at least 32 lowercase hexadecimal characters. A compose target SHALL refuse the environment,
  naming the key and printing no value, when it is not. At run time, the wrapper SHALL refuse to
  start compose if the value appears anywhere in the resolved configuration of a service other
  than `db` or `migrate`.

**Ordering with frozen checkouts.** A checkout whose allowed names lack `POSTGRES_PASSWORD`
refuses an environment that holds it. The key SHALL therefore be added to the Infisical `prod`
environment only as part of the cutover, after `main` allows it. The documentation SHALL say so.

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
  offending names that are valid identifiers.

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

## ADDED Requirements

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
- print no secret value.

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

### Requirement: Supabase secret generator
`docker/scripts/supabase-keys.mjs ENV --writer FILE` SHALL create each missing Supabase secret
for environment `ENV` in that environment's Infisical project. In this change the only secret is
`POSTGRES_PASSWORD`. It SHALL:
- read the project id, Infisical URL and CA path from `.env.infisical.<ENV>`, with the same
  checks as the compose wrapper (the URL SHALL be `https://`);
- read the client id and client secret from `FILE`. `FILE` SHALL pass the same ownership and
  permission checks as a credentials file;
- list existing keys with the same path, recursion and import settings the compose wrapper
  fetches with, and without reading values;
- generate each value from a cryptographically secure random source. For `POSTGRES_PASSWORD`
  that is 32 lowercase hexadecimal characters;
- only ever create. It SHALL never update, overwrite or delete a key. A key that already exists
  SHALL be reported as kept. A create that Infisical rejects SHALL exit non-zero without retrying
  or updating;
- print key names and outcomes only, never a value or a token;
- refuse Node older than 22.12, and need no npm packages.

#### Scenario: Existing secrets are kept
- **WHEN** the environment already holds `POSTGRES_PASSWORD` and the generator runs
- **THEN** it reports `POSTGRES_PASSWORD` as kept, makes no write request, and exits zero

#### Scenario: A missing secret is created without being shown
- **WHEN** the environment has no `POSTGRES_PASSWORD` and the generator runs
- **THEN** it creates the key with a newly generated value, and neither its output nor its
  error output contains that value

#### Scenario: A rejected create is not retried as an update
- **WHEN** Infisical answers the create with an error, for example because a concurrent run
  created the key first
- **THEN** the generator exits non-zero, prints no value, and sends no update request
