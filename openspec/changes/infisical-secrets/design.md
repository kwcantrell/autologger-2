# Design

## Context

- **How compose is called.** Every call goes through `docker/scripts/compose-env.sh`:
  `compose_dev`, `compose_stage` and `compose_prod` each take an env file as `$1`. The Makefile
  and `check-envs.sh` share it, so they resolve the same compose file set (seam S2 of
  containerized-dev-env).
- **How the containers get secrets.**
  - Dev `app` reads `.env.dev` through `env_file` (`docker/compose.dev.yaml:44-46`).
  - Prod `api` reads `.env` (`compose.yaml:89`).
  - Stage `api` overrides that with `.env.stage` (`docker/compose.stage.yaml:36-38`).
  - Literal `environment:` pins take precedence over the env file.
  - `env_file` hands the container every key in the file.
  - `check-envs.sh` also resolves prod plus the e2e overlay (`e2e/container/compose.e2e.yaml`),
    which keeps its own throwaway `env_file`. That harness is out of scope.
- **Guards.** `make-guards.sh envfile` validates the resolved config (ports, project name, no
  `COMPOSE_*` keys). `urls` and `reset` resolve with `.env.dev` and `.env.stage` directly.
  `prod-tags` greps `WEB_TAG` and `API_TAG` out of `.env`.
- **The Infisical instance.** It is served by Caddy with `tls internal` on `192.168.0.100:443`.
  The certificate's SAN is `IP Address:192.168.0.100`, and this host already trusts the CA
  (see the assumptions).
- **The Infisical CLI's `run` behaviour** (`packages/cmd/run.go`; why D1 no longer uses it):
  - it copies the caller's environment, then writes every secret over it;
  - it reserves only a short list: `HOME`, `PATH`, `PWD`, `SHELL`, `USER`, `TERM` and a few
    others;
  - it expands `${…}` inside secret values by default;
  - at debug log level it logs every injected variable.

## Goals / Non-Goals

**Goals:**
- **One source for secrets.** Infisical, with separate `dev`, `stage` and `prod` environments,
  each read by its own read-only machine identity.
- **Least exposure.** A container receives only the variables the shared allowlist names. The
  compose process receives only a clean base environment plus the allowlisted Infisical names.
- **Hostile-input safe.** A secret name in Infisical can't retarget docker, preload code, or
  flip a guard.
- **Relocatable.** Moving Infisical to another host means editing the per-host credentials files
  only.
- **Fail clearly.** Every failure names its fix and prints no value.
- **One login per `make` target.** The guards check exactly what compose then uses.

**Non-Goals:** as listed in proposal.md, including no prod deploy before cutover and no
e2e-harness change.

## Decisions

### D1. One wrapper: `docker/scripts/compose-run.mjs ENV STEP...` (Node, no packages)

Every Makefile target that touches a compose project calls this wrapper once, as
`node docker/scripts/compose-run.mjs ENV STEP...`. It replaces the separate `$(G) envfile` and
`$(DEV) …` calls.

**Revision history.** Re-panel 2026-09-30, then owner decision 2026-09-30:
1. v1 used `infisical run`, whose injected variables take effect when the child program starts
   (see "Why not `infisical run`").
2. v2 used `infisical export` plus jq plus `eval` in shell. Reviewers found quoting and NUL
   bypasses.
3. v3 moves the wrapper to Node and calls Infisical's HTTP API directly with Node's built-in
   HTTPS client. Secrets are strings in an object; no shell ever parses them, and no Infisical
   CLI or npm package is needed.

**Steps, all in one Node process:**

1. **Read the credentials file.** It reads `.env.infisical.<ENV>` from the repo root as plain
   `KEY=value` lines. It is never sourced or printed. The keys are:
   - `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID`, `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET`;
   - `INFISICAL_PROJECT_ID`, `INFISICAL_DOMAIN`;
   - `INFISICAL_CA_FILE`, which is now **required**. Node doesn't trust the host's system store
     by default: without it, a fetch failed with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` (see the
     assumptions).

   It refuses when:
   - a key is missing or empty;
   - `INFISICAL_DOMAIN` isn't an `https:` URL;
   - the CA file doesn't exist;
   - the credentials file is readable by group or others.
2. **Log in.** `POST {domain}/api/v1/auth/universal-auth/login` with the JSON body
   `{clientId, clientSecret}`, over `node:https` with `ca` set to the CA file's contents only.
   - The response must be JSON with a non-empty string `accessToken`; otherwise the wrapper
     refuses.
   - On failure it prints the HTTP status and Infisical's `message` field only. A TLS error adds
     "trust the Infisical CA (INFISICAL_CA_FILE)". It never suggests plain HTTP or disabling
     verification.
   - `rejectUnauthorized` is never set to false.
3. **Fetch.** `GET {domain}/api/v4/secrets?projectId=…&environment=ENV&secretPath=/&expandSecretReferences=false&includeImports=false&recursive=false&viewSecretValue=true`
   with `Authorization: Bearer <token>`.
   - The response must be JSON with a `secrets` array.
   - The token is dropped after this call.
4. **Validate, all or nothing.** Each secret must be an object whose `secretKey` and
   `secretValue` are strings (the CLI's own model: `json:"secretKey"`, `json:"secretValue"`).
   Beyond that:
   - each key must match `/^[A-Za-z_][A-Za-z0-9_]*$/` (JS `$` doesn't match before a trailing
     newline without the `m` flag) and be an exact member of the allowed set (D3);
   - there must be no duplicate keys and no NUL in any value;
   - at least one secret must be returned.

   On any violation it refuses, printing only offending names that are valid identifiers, a
   count of the others, and a reason word. Values never appear in a message.
5. **Build the child environment explicitly** (H6, H12). It starts from `Object.create(null)`,
   not `process.env`:
   - `PATH=/usr/local/bin:/usr/bin:/bin`, `HOME` and `TERM`;
   - the validated secrets;
   - `AUTOLOGGER_STACK=ENV` (D4).

   Nothing from the operator's shell crosses. No `LD_*`, `DOCKER_*`, `COMPOSE_*`, `INFISICAL_*` or
   `LOG_*` value can appear, because only validated allowlist names are copied in.
   - Test hook: `AUTOLOGGER_TEST=1` plus `AUTOLOGGER_TEST_PATH` puts a stub directory first on
     that `PATH`, and `AUTOLOGGER_TEST_CRED_DIR` moves the credentials file. These are read from
     the operator's environment, never from Infisical.
6. **Run the steps in order, each child spawned with that environment,** using argv arrays (no
   shell string is built from any value):
   - **`compose ARGS…`** spawns
     `sh -c '. docker/scripts/compose-env.sh && "$@"' sh compose_ENV /dev/null ARGS…`. That keeps
     seam S2 (`check-envs.sh` still sources the same file) until the follow-up change ports it.
     `stdio: 'inherit'`, so `dev-shell` and `logs -f` are interactive.
   - **`resolved`** resolves the same compose config as JSON, in memory, and applies the checks
     `make-guards.sh envfile` did: project name, loopback, numeric ports, no 8080, no 80 or 443 in
     dev, and the expected port set. The JSON inlines passthrough values, so it is never printed.
   - **`prod-tags`** checks `WEB_TAG` and `API_TAG` from the validated secrets.
   - **`urls`** prints the published ports from the resolved config.
   - **`reset`** requires `CONFIRM=yes` in the operator's environment, read before any fetch, and
     the resolved project name. It is refused for `prod` (H8).
7. **Exit** with the first failing step's status. Node has no core-dump-on-crash by default, and
   the process exits when the steps finish.

**`make-guards.sh`** keeps only the guards that never touch secrets: `creds-exists`,
`creds-inode`, `prod-git`, `prod-builder` and `native-platform`. `envfile`, `urls`, `reset` and
`prod-tags` move into the wrapper.

**Hardening rules** (re-panel of v3, 2026-09-30). Each has a test row in task 3.2.

- **H1. The Makefile starts Node with a clean environment.** It runs
  `env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$HOME" TERM="$TERM" [CONFIRM=…] [AUTOLOGGER_TEST*=…] node docker/scripts/compose-run.mjs …`.
  - So none of these can change the wrapper's own behaviour: `NODE_OPTIONS` (a `--require`
    preload would see the token), `NODE_DEBUG=http` (logs `Authorization`),
    `NODE_TLS_REJECT_UNAUTHORIZED=0`, `NODE_EXTRA_CA_CERTS` or `NODE_USE_ENV_PROXY`/`HTTPS_PROXY`.
  - The wrapper checks itself at start-up: it refuses if any `NODE_*` variable or
    `HTTP(S)_PROXY` is present, as a second line of defence.
  - It also refuses a Node version below 22.12, naming the fix.
- **H2. TLS.** Every request sets `rejectUnauthorized: true` explicitly (this also defeats a stray
  `NODE_TLS_REJECT_UNAUTHORIZED=0`), plus `ca` from the CA file only.
  - The domain is parsed with `new URL`. It must be `https:`, with no username, password,
    search or hash, and pathname `/`. Requests are built from `hostname` and `port`, never by
    string concatenation.
- **H3. Responses.**
  - The status must be exactly 200; redirects are never followed (`node:https` doesn't follow
    them, and `fetch` isn't used).
  - Timeouts are 15 s to connect and 30 s in total.
  - Bodies are capped at 1 MiB, with no decompression (no `accept-encoding` sent).
- **H4. No secret in any output.**
  - Every `JSON.parse` is in a `try`/`catch` that prints a fixed message. A parse error message
    quotes about 10 characters of the input, so it is never printed.
  - A `process.on('uncaughtException')` and an `unhandledRejection` handler print a fixed
    string and exit 1. Node's default crash printer shows the offending source line, which for a
    JSON body is the secrets.
  - On an Infisical error, only the status is printed, plus `message` if it is a string, with
    control characters stripped and cut to 200 characters. A 422 array prints only its issues'
    `path`/`code`.
- **H5. Hidden values.** The fetch sends `viewSecretValue=true`, and any secret with
  `secretValueHidden !== false` is refused, naming the key. An identity without ReadValue gets
  `"<hidden-by-infisical>"` as the value (backend `secret-fns.ts`).
- **H6. Prototype-safe collections.**
  - The allowlist and the duplicate check use a `Set`, because `"constructor" in {}` is true.
  - The child env is built on `Object.create(null)`. Node's `spawn` copies inherited enumerable
    properties.
  - `__proto__` and `constructor` are test cases.
- **H7. File integrity.** The credentials file decides where secrets go, so it is checked with
  `lstat`:
  - a regular file (no symlink), owned by the current user, mode `& 0o077 === 0`;
  - the CA file: a regular file, not group- or other-writable, at most 64 KiB, read only once.
- **H8. Steps stop at the first failure.** No later step runs.
  - `reset` is refused for `prod`, keeping `make-guards.sh`'s old `dev|stage` rule.
  - `reset` also needs `CONFIRM=yes` and the resolved project name, both checked before the
    destructive compose step.
- **H9. Signals.** While a child runs, the wrapper ignores SIGINT (the terminal delivers it to the
  whole process group, so compose gets it directly) and forwards SIGTERM and SIGHUP to the child.
  It exits with the child's status.
- **H10. Test hooks.** They are honored only with `AUTOLOGGER_TEST=1`.
  - `AUTOLOGGER_TEST_PATH` and `AUTOLOGGER_TEST_CRED_DIR` must be absolute.
  - Both are refused for `prod`.
  - When they are active, a banner goes to stderr.
- **H11. Step syntax.** A compose step is split on spaces only, with no quoting.
  - Allowed words match `/^[A-Za-z0-9@%+=:,./_-]+$/`, which is enough for every Makefile target.
  - Anything else is refused.
  - No value from Infisical is ever part of a step.
- **H12. Child environment** is `PATH`, `HOME`, `TERM` (not a secret; keeps `dev-shell`
  usable), `AUTOLOGGER_STACK` and the validated keys. The compose step's `sh` adds only `PWD`,
  and stage's `compose-env.sh` adds its placeholders. The test asserts the environment the
  wrapper spawns with.

**Tests** are `docker/scripts/compose-run.test.mjs`, run with
`node --test docker/scripts/compose-run.test.mjs`, which is added to the root `npm test`.
- The file is named explicitly: `node --test docker/scripts/` fails ("Cannot find module"), and a
  bare `node --test` would also pick up `server/src/test/fixtures/*.mjs`.
- The stand-in for Infisical is a local HTTPS server bound to `127.0.0.1` only, with a
  throwaway CA and server certificate generated by `openssl` into a temp directory at test time.
  No key is committed (gitleaks).
- A stub `docker` first on `PATH` records argv, env and stdin.

**Why not `infisical run`.** It builds its child's environment from the caller's plus every
secret, then starts the child. The dynamic loader reads `LD_PRELOAD` as that child starts, before
any code can inspect the environment. Observed:

```
LD_PRELOAD=/tmp/evil-value.so sh -c 'echo inner-ran'
-> ERROR: ld.so: object '/tmp/evil-value.so' from LD_PRELOAD cannot be preloaded (...): ignored.
   inner-ran
```

**Why not `infisical export` plus shell `eval` (v2).** A non-string value made `@sh` emit several
words, so a validated key set an unvalidated variable (`export API_TOKEN='x'
'LD_PRELOAD=…'`). `eval "$(…)"` also hid jq failures. Building the environment as a JS object
removes the whole class.

**Why not the Infisical Node SDK.** `@infisical/sdk` 5.0.2 pulls in
`@aws-sdk/credential-providers`, the `@smithy/*` packages and `typescript` at runtime. That is a
large supply-chain surface for two HTTPS calls (owner, 2026-09-30).

**Makefile shape.** Examples:
- `dev-up: ; @node docker/scripts/compose-run.mjs dev resolved 'compose up -d --build' urls`
- `dev-restart` passes its four `compose restart X` steps in one call, so one login and one
  environment.

Every compose target needs Node ≥22.12 on the host (the repo's `engines`). No `npm ci` is needed:
the wrapper imports only `node:` modules.

### D2. The containers' allowlist lives in one file

- `docker/secrets-env.yaml` defines one service, `secrets`. Its `environment:` lists every
  operator-settable app key as a null passthrough, with a comment per key.
- Dev `app` and prod `api` use `extends: {file: docker/secrets-env.yaml, service: secrets}`.
  Stage inherits prod's `api`.
- Literal pins in each service override extended keys. For example, dev keeps
  `IP_ALLOWLIST: ""`.
- `env_file` is removed from dev `app`, prod `api`, and the stage overlay.

The allowlist is the server's direct env reads, minus pins, test flags and server-internal
names:
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `API_TOKEN`, `ADMIN_TOKEN`
- `DEEPGRAM_API_KEY`, `DEEPGRAM_MODEL`
- `AI_V2_ENABLED`, `AI_V2_API_KEY`, `AI_V2_MAX_BUDGET_USD`
- `AI_CHAT_MAX_BUDGET_USD`, `AI_CHAT_MAX_CONCURRENT`, `AI_CHAT_TIMEOUT_SEC`
- `EVENT_GENERATE_MAX_BUDGET_USD`, `EVENT_GENERATE_MAX_CREATED_EVENTS`,
  `EVENT_GENERATE_MAX_INSTRUCTION_BYTES`, `EVENT_GENERATE_MAX_INSTRUCTION_ENTRIES`,
  `EVENT_GENERATE_TIMEOUT_SEC`
- `TOPIC_GENERATE_MAX_BUDGET_USD`, `TOPIC_GENERATE_TIMEOUT_SEC`
- `IP_ALLOWLIST`, `NEW_USER_ALL_TEAMS`, `SESSION_DAYS`, `SHEETS_LOG_IMPORT_ENABLED`

The panel found these 23 match the server's direct reads exactly. The optional child-process
passthroughs (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`) are left out. If
the owner's name check (task 1.3) finds them in a current env file, adding them is a scope edit
handled by the consistency read.

### D3. The allowed Infisical names per environment

The allowed set is the allowlist keys from D2, plus the compose-interpolation keys for that
environment. `compose-run.mjs` holds the latter as constants:

| Environment | Compose-interpolation keys |
| --- | --- |
| dev | `DEV_PORT`, `DEV_COMPANION_PORT` |
| stage | `STAGE_PORT` |
| prod | `ROUTER_PORT`, `WEB_TAG`, `API_TAG`, `PUBLIC_BASE_URL` |

- The D2 keys are read from `docker/secrets-env.yaml` with a line match
  (`^      [A-Z][A-Z0-9_]*:$`). A static invariant keeps that line match equal to the resolved
  passthrough names (D5).
- There is no second list: `docs/infisical-secrets.md` documents the keys and points at the file.
- Ambient overrides such as `DEV_PORT=9000 make dev-up` stop working. The Makefile's `env -i`
  and the wrapper's explicit child environment drop them (H1, H12). To change a port, set it in
  Infisical. README and
  the `compose-env.sh` header comment say so.

### D4. Hand-typed compose fails loudly

- The allowlist file also carries `AUTOLOGGER_STACK: ${AUTOLOGGER_STACK:?run compose through make
  (docker/scripts/compose-run.mjs); secrets come from Infisical}`.
- Without that variable, a hand-typed `docker compose up` stops with that message instead of
  starting `api` with no secrets.
- `check-envs.sh` supplies a placeholder value. The value is non-secret (`dev`, `stage` or
  `prod`), and the container sees it as an informational variable.

### D5. Static check (`check-envs.sh`)

It still uses placeholder env files, never contacts Infisical, and its `env -i`-style stripping
now also covers the allowlist keys and `AUTOLOGGER_STACK`. Two invariants are new:

- **14.** No service has `env_file`, in the dev, stage and prod projects. The prod plus e2e
  overlay project is explicitly exempt; its throwaway env file is a non-goal.
- **15.** The line-matched key list from `docker/secrets-env.yaml` equals the null-passthrough
  names of the resolved prod `api` and dev `app`, excluding keys the service pins with a literal.
  It is read with `config --no-interpolate`, and it handles both the map form and the array form
  (bare `"KEY"`) that overlays produce.

Invariant 6's `env_file` bookkeeping is removed, because 14 replaces it. The never-read list gains
`.env.infisical.*`.

The panel's "literal or passthrough" invariant was dropped. `KEY:` and `KEY: ${KEY}` read the
same source, and invariants 6 and 7 already pin the posture literals.

### D6. Identity hardening (owner configuration, recorded here)

Each environment is its own Infisical project (`autologger-dev`, `autologger-stage`,
`autologger-prod`), holding only that environment (`dev`, `stage` or `prod`). Each project has one
machine identity, created inside that project, with the built-in `viewer` role. (Owner,
2026-09-30: the free plan refuses custom roles, "Upgrade to Infisical Enterprise plan to create
custom roles". Per-environment projects give the same isolation. The wrapper is unchanged, because
each `.env.infisical.<env>` already carries its own project ID.)

Each machine identity:
- has read-only access to its one environment, by being a viewer of only that project;
- has an access-token TTL of 15 minutes and a maximum TTL of 1 hour;
- would have Trusted IPs on the client secret and the access token, but the free plan refuses them
  ("Failed to add IP access range ... due to plan restriction"). The network boundary is instead
  the Infisical proxy's LAN/Tailscale allowlist (`~/infisical`), plus the short token TTL;
- has its client secret rotated when a host is decommissioned, and at least yearly.

### D7. Cutover, rollback and break-glass

- **Rollback** is reverting the change. No target deletes an env file.
- **Old env files stay until main.** The owner deletes `.env.dev` and `.env.stage` only after this
  change reaches `main` at the ADR 0021 cutover, because `main`'s Makefile still reads them until
  then.
- **Backup before deletion.** Deleting them also requires a verified Infisical backup and a
  restore test, because the owner's `~/infisical/README.md` says the `.env` holding
  `ENCRYPTION_KEY` must be kept off-host.
- **Prod dry run.** `make prod-check` runs `compose-run.mjs prod resolved prod-tags 'compose config
  --quiet'`. It has no `main` requirement, so the deploy host can dry-run it before cutover.
- **Break-glass** is documented in `docs/infisical-secrets.md`, for when Infisical is down:
  - stop prod with `docker stop autologger-api autologger-web autologger-router`, which needs no
    interpolation;
  - running containers keep their environment;
  - a restart needs Infisical, or a temporary `env_file` restored by reverting this change.

## Assumptions (each checked)

1. **Null passthrough, unset stays unset, and `/dev/null` blocks the root `.env`.**
   - `FOO=secretval docker compose -f c.yaml --env-file /dev/null config --format json | jq -c .services.a.environment`
     gave `{"BAR":null,"FOO":"secretval","PIN":"1"}`.
   - With no `FOO`, and a `.env` containing `FOO=fromdotenv`, it gave `{"BAR":null,"FOO":null,…}`.
   - Confirmed independently by the panel.
2. **`--no-env-resolution` inlines passthrough values, but `--no-interpolate` keeps them null, and
   an overlay turns the map into an array.** From the panel: `--no-interpolate` gave
   `"FOO":null`, and stage `.services.api.environment|type` gave `"array"`.
3. **`extends` carries the allowlist, and a literal in the service wins.**
   - A scratch `allow.yaml` has `GOOGLE_CLIENT_ID:` and `IP_ALLOWLIST:`, and `c.yaml` extends it
     with `IP_ALLOWLIST: ""`.
   - `GOOGLE_CLIENT_ID=g IP_ALLOWLIST=x docker compose -f c.yaml --env-file /dev/null config`
     gave `{"GOOGLE_CLIENT_ID":"g","IP_ALLOWLIST":"","REQUIRE_LOGIN":"1"}`.
   - With `--no-interpolate` it gave `["GOOGLE_CLIENT_ID","IP_ALLOWLIST=","REQUIRE_LOGIN=1"]`.
4. **Literal pins beat the process env.** From the panel: `REQUIRE_LOGIN=0 GOOGLE_CLIENT_ID=g …
   config` gave `{"GOOGLE_CLIENT_ID":"g","REQUIRE_LOGIN":"1"}`.
5. **`env -i` leaves a known base.**
   `env -i PATH=/usr/bin:/bin HOME=$HOME sh -c 'jq -rn "env|keys[]"'` gave `HOME`, `PATH`, `PWD`.
6. **CLI behaviour, from the panel's reading of `Infisical/cli` source:**
   - secrets override the caller's environment (`run.go`);
   - `--domain` falls back to `INFISICAL_DOMAIN`, then `INFISICAL_API_URL`, then Infisical Cloud,
     so the domain must be set for both the login and the export (`root.go`);
   - `/api` is appended automatically (`util/helper.go`);
   - universal auth writes no secrets backup to disk (`util/secrets.go`);
   - `infisical secrets --plain` prints `KEY=VALUE`, so it is never used here (`secrets.go`);
   - `--expand` defaults to true.
7. **TLS.** From the panel: `openssl s_client -connect 192.168.0.100:443 | openssl x509 -ext
   subjectAltName` gave `IP Address:192.168.0.100`, issuer "Caddy Local Authority - ECC
   Intermediate", `Verify return code: 0`. The CA is in this host's system store, but Node doesn't
   use that store (assumption 14), so `INFISICAL_CA_FILE` is required.
8. **Environment.** `uname -m` gave `aarch64`, and `docker compose version` gave `v5.2.0`. After
   owner task 1.1, `command -v infisical; infisical --version` gave `/usr/bin/infisical` and
   `infisical version 0.43.138`.
9. **Not checkable by the agent:** whether the deploy host reaches `192.168.0.100`. The owner
   checks it with `make prod-check` before cutover.
10. **`infisical export` (re-panel).**
    - `infisical export --help` lists `-f, --format string ... (dotenv, dotenv-export,
      dotenv-eval, json, csv, yaml)`, `--expand ... (default true)`, `--projectId`, `--token`,
      and the global `--silent` and `-l, --log-level`.
    - `Infisical/cli packages/cmd/export.go`: JSON is `json.Marshal(envs)`, an array of
      `SingleEnvironmentVariable`, printed with `util.PrintStdout` unless `--output-file` is
      set. No default file.
    - The fields are lowercase `key` and `value`, both strings (`models/cli.go`). Imported
      secrets are excluded with `--include-imports=false`. An empty environment marshals as
      `null`.
    - A machine-identity token needs `--projectId`: without it, the CLI printed `Project ID is
      required when using machine identity`, rc=1, 0 bytes on stdout (panel).
    - On failure stdout is empty and errors go to stderr. `--silent` suppresses the update check
      (`root.go`). `LOG_DESTINATION=stdout` would move logs to stdout, which is why it never
      crosses `env -i`.
    - With an empty `INFISICAL_TOKEN`, `export` prompted for a user login on stdout and created
      `$HOME/.infisical/infisical-config.json` (panel, scratch `HOME`). Hence the empty-token
      refusal.
    - `jq @sh` plus `eval` in dash round-trips `' " $ \` \\`, newlines (including trailing
      ones), leading dashes, an empty string, unicode, tab and CR, and `$(…)` is not executed
      (panel). A non-string value is not safe: an array makes `@sh` emit several words (panel
      critical), hence the string-type requirement.
11. **The loader applies `LD_PRELOAD` before the child's code runs.** See the D1 excerpt.

12. **The HTTP API (v3 design), from `Infisical/cli packages/api/model.go`:**
    - `UniversalAuthLoginRequest{clientSecret, clientId}`;
    - `UniversalAuthLoginResponse{accessToken, expiresIn, tokenType, accessTokenMaxTTL}`;
    - `GetSecretsV4Response{secrets[{_id, version, type, environment, secretKey, secretValue, secretComment, secretPath, …}], imports[…]}`;
    - `api.go` calls `POST /v1/auth/universal-auth/login/` and `GET /v4/secrets` with
      `projectId`, `environment`, `secretPath`, `includeImports`, `recursive` and
      `expandSecretReferences`.
13. **The owner's server (v0.165.16) serves both endpoints.** A Node `fetch` with no credentials
    and `NODE_EXTRA_CA_CERTS=~/infisical/infisical-root-ca.crt`:
    - `GET /api/v4/secrets?projectId=x&environment=dev` gave `401 {"message":"Token missing"}`;
    - `POST /api/v1/auth/universal-auth/login` with `{}` gave `422` (a validation error on the
      body).
14. **Node doesn't use the host's system trust store by default.** `--use-system-ca` exists in Node
    24 (the panel: a fetch returned 200 with it), but not on the 22.12 floor. Pinning one CA file
    is also stricter than trusting the whole system store.
    `node -e 'fetch("https://192.168.0.100/api/status")…'` with no CA setting gave
    `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, though `openssl` verifies against the system store
    (assumption 7). Hence `INFISICAL_CA_FILE` is required, passed as `ca` to `node:https`.
15. **Node version.** The root `package.json` has `"engines": {"node": ">=22.12"}`, and this host
    runs `v24.21.0`. `node:test`, `node:https` and `node:child_process` are built in.

16. **Re-panel v3 checks (panel):**
    - `ca` replaces the default roots, and `NODE_EXTRA_CA_CERTS` doesn't widen it: the wrong CA
      gave `UNABLE_TO_VERIFY_LEAF_SIGNATURE`;
    - `NODE_TLS_REJECT_UNAUTHORIZED=0` defeats the default, and an explicit
      `rejectUnauthorized:true` restores the check;
    - a `spawn` `env` adds nothing, and dash adds only `PWD`;
    - Node throws on NUL in env values, but not on odd keys, so the key regex is load-bearing;
    - `sh -c '. f && "$@"' sh fn …` passes args verbatim;
    - `stdio:'inherit'` gives a TTY;
    - the v4 router accepts `viewSecretValue` and returns `secretValueHidden`;
    - `includeImports=false` returns `imports: []`;
    - the login path works with or without a trailing slash.
17. **Test tooling.** `node:crypto` has no certificate generator (only `X509Certificate`), so the
    tests call `openssl`. It is present on this host and on `ubuntu-latest`.

Assumptions 5, 6, 8 (the CLI) and 10 and 11 (`export` and the loader) describe the superseded v1
and v2 designs. They are kept for the record: 11 is why `infisical run` was rejected.

## Risks / Trade-offs

- **[Availability] Infisical is on the start path of every stack.**
  - It binds only `192.168.0.100` on this host, so a DHCP change or an Infisical `make reset`
    (which issues a new CA) blocks dev and stage starts until fixed.
  - Running containers are unaffected, and break-glass is documented (D7).
  - For prod, this is accepted only at cutover, after `prod-check` passes on the deploy host.
- **[Exposure] Values are still readable from the operator account.** An agent or any process
  running as the operator can still read:
  - the credentials file (`Bash` `cat` is not denied);
  - container environments (`docker inspect`, `docker exec env`);
  - `/proc/<pid>/environ` of a long-running `make dev-logs`.

  The Read deny rule only stops the Read tool. `docs/security.md` ASI03 states this. The short
  token TTL (D6) limits what a stolen token is worth.
- **[Drift] An allowlist miss silently drops a key.** The owner's name check (task 1.3) compares
  today's env-file key names with the allowed set before cutover.
- **[Behaviour change] Ambient overrides no longer work** (D3). This is documented.
- **[Complexity] One ~250-line Node wrapper** replaces the per-call Makefile layering and the
  secret-bearing guards. It is tested with `node --test` against a local HTTPS stand-in for
  Infisical (task 3.2).
- **[Dependency] Node ≥22.12 is required on every host that runs `make`,** including the deploy
  host. The owner checks it in task 1.1.
- **[Size] About 520 to 580 counted lines, over the 400 budget:**
  - 168 already committed;
  - about 300 for the hardened wrapper;
  - about 60 for the Makefile;
  - about 20 for the README pointer;
  - about 15 for templates.

  The pieces can't land separately: the committed `AUTOLOGGER_STACK` sentinel already breaks
  the old Makefile until 3.4 lands. To limit the count:
  - the four superseded `make-guards.sh` functions stay as dead code, and `node-stack-tooling`
    deletes them;
  - the README sections become a pointer to `docs/infisical-secrets.md`, which is excluded.

  The PR needs the owner's `size-override` label. That is the owner's decision at task 5.3.
- **[Tooling] `check-yaml --unsafe` is scoped** to the compose files only (a second hook entry
  with `files:`). Every other YAML file keeps duplicate-key and multi-document detection. The
  lifecycle `yaml` gate (ADR 0017) is unchanged.
