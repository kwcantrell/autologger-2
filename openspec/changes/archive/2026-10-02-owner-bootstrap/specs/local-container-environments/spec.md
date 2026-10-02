## MODIFIED Requirements

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
  offending names that are valid identifiers;
- `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` is unset or empty in the environment. This
  applies to every stack, dev included, because the server refuses to boot without them.
- `BOOTSTRAP_OWNER_EMAIL` is unset, empty or only whitespace in the environment. This applies
  to every stack, dev included, because the server refuses to boot without it. The shared
  allowlist file SHALL list it, so the app container receives it.

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

#### Scenario: Dev without a Google client is refused
- **WHEN** the Infisical `dev` environment has no `GOOGLE_CLIENT_SECRET`, and `make dev-up` runs
- **THEN** it exits non-zero naming `GOOGLE_CLIENT_SECRET`, prints no value, and runs no
  docker command

#### Scenario: A stack without a bootstrap owner is refused
- **WHEN** the Infisical `stage` environment has no `BOOTSTRAP_OWNER_EMAIL`, or holds only
  spaces in it, and `make stage-up` runs
- **THEN** it exits non-zero naming `BOOTSTRAP_OWNER_EMAIL`, prints no value, and runs no
  docker command

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
