## MODIFIED Requirements

### Requirement: Dev app binds loopback behind a Host/Origin gate
The dev app SHALL bind `127.0.0.1` inside its container. The compose file SHALL pin these
as literal values, never `${…}` references, in the app's `environment:`:
- `HOST=127.0.0.1`
- `REQUIRE_LOGIN=0`
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

Because the bind is loopback, both the open-network refusal and the AI v2 credentials rule
pass. Only the host (through the published loopback port) and containers on the dev
network (through the gate) can reach the app. The app also joins the two-member `catalog`
network, whose only other member is `db`; the gate SHALL refuse every connection whose source
address is in the dev `catalog` subnet, and `make check` SHALL fail when the gate's refused
subnet differs from the `catalog` network's. The design SHALL record that this relies on
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

#### Scenario: Postgres cannot reach the dev app
- **WHEN** a request to the gate's port comes from an address in the dev `catalog` subnet, with
  `Host: app:8787`
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
allowlist file, each passed through from the Infisical `dev` environment, plus the catalog
connection literals `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` and `PGPASSWORD`, whose password
is `APP_DB_PASSWORD`. It SHALL have no `env_file`, and
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
  the five `PG*` catalog connection literals, and the image's own environment
- **AND** it shows no `INFISICAL_*` variable and no `SSL_CERT_FILE`

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
    - a Supabase service other than `supabase-gw` publishes a port, or `supabase-gw` publishes
      anything other than one `127.0.0.1` port mapped to its listener;
    - the `db`, `supabase` or `catalog` network is not internal, does not isolate the host from
      it (no host address on the bridge), or is not on that environment's pinned subnet
      (`catalog`: prod `172.28.15.0/24`, stage `172.28.25.0/24`, dev `172.28.34.0/24`); or the
      `edge` network is not on its pinned subnet;
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

**Ordering with frozen checkouts.** A checkout whose allowed names lack `POSTGRES_PASSWORD`
(or `APP_DB_PASSWORD`) refuses an environment that holds it. The Supabase keys SHALL therefore be added to the Infisical
`prod` environment only as part of the cutover, after `main` allows them. The documentation SHALL say so.

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

#### Scenario: Swapped Supabase API keys are refused
- **WHEN** the Infisical `dev` environment's `ANON_KEY` and `SERVICE_ROLE_KEY` are swapped, or
  either is signed with a different secret, and `make dev-up` runs
- **THEN** it exits non-zero naming the key, prints no value, and runs no docker command

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
`docker/scripts/supabase-keys.mjs ENV --writer FILE` SHALL create each missing Supabase secret
for environment `ENV` in that environment's Infisical project: `POSTGRES_PASSWORD`,
`SUPABASE_ROLES_PASSWORD`, `APP_DB_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`,
`SECRET_KEY_BASE` and `REALTIME_DB_ENC_KEY`. `SUPABASE_PORT` is set by the operator. It SHALL:
- read the project id, Infisical URL and CA path from `.env.infisical.<ENV>`, with the same
  checks as the compose wrapper (the URL SHALL be `https://`);
- read the client id and client secret from `FILE`. `FILE` SHALL pass the same ownership and
  permission checks as a credentials file;
- list existing keys with the same path, recursion and import settings the compose wrapper
  fetches with, and without reading values;
- generate each value from a cryptographically secure random source, in its format from
  "Allowed names". `ANON_KEY` and `SERVICE_ROLE_KEY` SHALL be HS256 JWTs signed with the
  `JWT_SECRET` created in the same run, with `role` `anon` and `service_role`, `iss`
  `supabase`, and an expiry five years after issue;
- create `JWT_SECRET`, `ANON_KEY` and `SERVICE_ROLE_KEY` together. If some but not all of the
  three exist, it SHALL refuse, naming them, without reading any value and without writing;
- send every missing key in one create request, so a run creates all of them or none;
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

#### Scenario: The anon and service-role keys verify against the JWT secret
- **WHEN** the generator creates `JWT_SECRET`, `ANON_KEY` and `SERVICE_ROLE_KEY`
- **THEN** both keys verify as HS256 against that `JWT_SECRET`, with roles `anon` and
  `service_role`

#### Scenario: A partial JWT trio is refused
- **WHEN** the environment holds `JWT_SECRET` but not `ANON_KEY`
- **THEN** the generator exits non-zero naming the missing keys, and writes nothing

#### Scenario: A rejected create is not retried as an update
- **WHEN** Infisical answers the create with an error, for example because a concurrent run
  created the key first
- **THEN** the generator exits non-zero, prints no value, and sends no update request

#### Scenario: The app password is created for an existing stack
- **WHEN** the environment holds every other Supabase key but not `APP_DB_PASSWORD`, and the
  generator runs
- **THEN** it creates only `APP_DB_PASSWORD`, reports the others as kept, and prints no value
