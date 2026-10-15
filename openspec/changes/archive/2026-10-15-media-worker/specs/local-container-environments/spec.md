## MODIFIED Requirements

### Requirement: Prod targets are explicit and bound to committed content
`prod-push` and `prod-up` SHALL refuse to run unless both hold:
- `git status --porcelain` is empty (this covers untracked, non-ignored files);
- the current branch is `main`.

`prod-push` SHALL:
- build and push the multi-arch images (`web`, `api` and `media-worker`, the bake file's
  default group) with `GIT_SHA=$(git rev-parse --short=12 HEAD)`;
- first verify that the named builder lists `linux/amd64` and `linux/arm64`.

`prod-build` SHALL:
- build the production images for the native platform, and load them locally;
- tag them `:local`, never with a git SHA.

`prod-up` SHALL:
- use `compose.yaml` with the OpenBao `prod` KV secret exactly as README "Container
  deployment" documents, with no overlay;
- fail if `WEB_TAG`, `API_TAG` or `MEDIA_TAG` is unset, empty, or `latest` in the OpenBao
  `prod` KV secret.

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
- **WHEN** the OpenBao `prod` KV secret has `API_TAG=latest` (or `MEDIA_TAG` unset) and
  `make prod-up` runs on a clean `main`
- **THEN** it exits non-zero naming `API_TAG` (or `MEDIA_TAG`), and starts nothing

#### Scenario: Push covers the worker image
- **WHEN** `make prod-push` runs on a clean `main`
- **THEN** the bake pushes `autologger-web`, `autologger-api` and `autologger-media-worker`
  under the same 12-character SHA tag, each with both platforms

#### Scenario: Prod dry run starts nothing
- **WHEN** `make prod-check` runs on any branch with valid prod credentials
- **THEN** it exits zero and no container of project `autologger` is created or recreated

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
  `APP_DB_PASSWORD`, and likewise give the `autologger_media` role `LOGIN` and set its
  password to `MEDIA_DB_PASSWORD`, both read from the environment and never from the command
  line. When a role does not exist, it SHALL say so for that role and succeed;
- report the number of files it applied;
- print no secret value.

Before connecting, the runner SHALL also refuse, printing no value, when `APP_DB_PASSWORD` or
`MEDIA_DB_PASSWORD` is unset, or is not a single line of at least 32 lowercase hexadecimal
characters.

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

#### Scenario: The worker role gets its password without leaking it
- **WHEN** the migrations runner runs with `MEDIA_DB_PASSWORD` set
- **THEN** `autologger_media` can log in with that password over TCP and a wrong password is
  refused, and no row of `pg_stat_statements`, no line of the database log and no line of the
  runner's output contains it; with `MEDIA_DB_PASSWORD` unset the runner exits non-zero
  naming it and applies nothing

### Requirement: Stage can run pushed images behind a public HTTPS edge
`make stage-up` SHALL accept two optional, non-secret operator values, passed to
`docker/scripts/compose-run.mjs` by name (never spliced into the recipe's shell text) by the
same Makefile macro every target uses, and validated there before any OpenBao request. The other
stage targets SHALL treat them the same way: `stage-down`, `stage-logs` and `stage-reset`
validate and resolve with the same options, and `stage-build` always builds `:local` (it is
refused while a tag is set).
- `STAGE_IMAGE_TAG`: exactly 40 lowercase hex characters (a full git SHA). With it, stage SHALL
  run `ghcr.io/kwcantrell/autologger-web:<tag>`, `ghcr.io/kwcantrell/autologger-api:<tag>` and
  `ghcr.io/kwcantrell/autologger-media-worker:<tag>`:
  `stage-up` SHALL pull `web`, `api` and `media-worker`, run the migrations, and start with
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
- pass compose only the derived `STAGE_WEB_IMAGE`, `STAGE_API_IMAGE`, `STAGE_MEDIA_IMAGE`,
  `STAGE_PUBLIC_BASE_URL`, `STAGE_COOKIE_SECURE` (and, with a tag and `DOCKER_CONFIG`, its own
  temporary `DOCKER_CONFIG` with `DOCKER_CONTEXT=default`), never `STAGE_IMAGE_TAG`;
- refuse every one of those names, and `STAGE_IMAGE_TAG`, as an OpenBao secret;
- in the `resolved` step, refuse unless the merged stage config runs exactly the expected `web`,
  `api` and `media-worker` images, `PUBLIC_BASE_URL` and `COOKIE_SECURE` match the options, and
  `TRUST_PROXY` is `1`.

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
  `STAGE_MEDIA_IMAGE=ghcr.io/kwcantrell/autologger-media-worker:<sha>`,
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
      other network; or `db` joins any network other than `db`, `catalog` and `media`;
    - the `media` network's members are not exactly `db` and `media-worker`; `media-worker`'s
      networks are not exactly `media`; `media-worker` publishes a port, is not `read_only`,
      runs as uid `0` or as the app's uid, keeps any capability, lacks `no-new-privileges`, or
      mounts a volume other than the blob volume at `/blobs`; or the `media` network is not
      internal, host-isolated and on its pinned subnet (prod `172.28.18.0/24`, stage
      `172.28.29.0/24`, dev `172.28.37.0/24`);
    - the dev service set is not exactly `app`, `app-gate`, `auth`, `companion`,
      `companion-gate`, `db`, `media-worker` and `migrate`;
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
      | `MEDIA_DB_PASSWORD` | `media-worker`, `migrate` |
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

#### Scenario: A widened worker is caught
- **WHEN** `media-worker` is joined to `catalog` or `back`, `api` is joined to `media`,
  `media-worker` publishes a port, drops `read_only`, runs as `node`, or mounts `/data`, or
  `${MEDIA_DB_PASSWORD}` is referenced in `api` or `auth`
- **THEN** `make check` exits non-zero and names invariant 16

### Requirement: Database and GoTrue secret generator
`docker/scripts/supabase-keys.mjs ENV [--writer FILE]` SHALL create each missing Supabase secret
for environment `ENV` in that environment's OpenBao KV secret: `POSTGRES_PASSWORD`,
`SUPABASE_ROLES_PASSWORD`, `APP_DB_PASSWORD`, `MEDIA_DB_PASSWORD` and `JWT_SECRET`. It SHALL NOT create, change, delete
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
- only ever add keys. It SHALL never change or delete an existing key. One of its five keys that
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
- **WHEN** the environment holds the five keys and also `ANON_KEY`, `SERVICE_ROLE_KEY`,
  `SECRET_KEY_BASE`, `REALTIME_DB_ENC_KEY` and `SUPABASE_PORT`, and the generator runs
- **THEN** it reports the five keys as kept, names no retired key, makes no write request, and
  exits zero

#### Scenario: The worker password is created for an existing stack
- **WHEN** the environment holds the generator's other four keys but not `MEDIA_DB_PASSWORD`,
  and the generator runs
- **THEN** it creates only `MEDIA_DB_PASSWORD`, reports the others as kept, and prints no value

#### Scenario: A rejected create is not retried as an update
- **WHEN** OpenBao answers the write with an error, for example a check-and-set mismatch because
  a concurrent run wrote first
- **THEN** the generator exits non-zero, prints no value, and sends no second write

#### Scenario: The app password is created for an existing stack
- **WHEN** the environment holds the generator's other four keys but not `APP_DB_PASSWORD`, and the
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
