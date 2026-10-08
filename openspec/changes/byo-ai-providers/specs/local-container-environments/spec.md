## MODIFIED Requirements

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
- `PROVIDER_KEYS_SECRET` is unset, or does not base64-decode to exactly 32 bytes, in the KV
  secret. This applies to every stack, dev included, because the server refuses to boot without
  it (provider-credentials "Provider keys are encrypted at rest and write-only"). The shared
  allowlist file SHALL list it, so the app container receives it. The documentation SHALL say to
  generate it with `openssl rand -base64 32`, separately per environment, and that losing it makes
  every stored provider key unreadable.

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

#### Scenario: A stack without a provider-keys secret is refused
- **WHEN** the OpenBao `dev` KV secret has no `PROVIDER_KEYS_SECRET`, or holds a value that
  decodes to 16 bytes, and `make dev-up` runs
- **THEN** it exits non-zero naming `PROVIDER_KEYS_SECRET`, prints no value, and runs no docker
  command
