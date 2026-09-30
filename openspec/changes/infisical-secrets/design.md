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
- **The Infisical CLI's `run` behaviour** (`packages/cmd/run.go`):
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

### D1. One wrapper: `docker/scripts/compose-run.sh ENV STEP...`

Every Makefile target that touches a compose project calls this wrapper once. It replaces the
separate `$(G) envfile` and `$(DEV) …` calls. It works in two stages.

**Outer stage** (runs with the operator's shell environment):

1. `set +x`.
2. Read `.env.infisical.<ENV>` from the repo root. It reads only these keys, with `grep`/`sed`,
   and never sources or prints the file:
   - `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID`, `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET`;
   - `INFISICAL_PROJECT_ID`, `INFISICAL_DOMAIN`;
   - optionally `INFISICAL_CA_FILE`.

   It refuses when:
   - a required key is missing;
   - `INFISICAL_DOMAIN` doesn't start with `https://`;
   - the CA file is named but missing;
   - the file is group- or world-readable.
3. Log in: `infisical login --method=universal-auth --silent --plain`.
   - The id and secret go in its environment, never on argv.
   - `INFISICAL_DOMAIN` and, if set, `SSL_CERT_FILE` go in too.
   - The token is kept in a shell variable only.
   - On failure it prints the CLI's error line only. A TLS failure adds "trust the Infisical CA
     (INFISICAL_CA_FILE)". It never suggests plain HTTP or skipping verification.
4. Run the inner stage under a clean environment:

   ```
   env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$HOME" INFISICAL_TOKEN=… INFISICAL_DOMAIN=… [SSL_CERT_FILE=…] \
     infisical run --env=ENV --projectId=… --expand=false --silent -- sh docker/scripts/compose-run.sh --inner ENV STEP...
   ```

   The log level is left at its default and no debug flag is ever passed.

**Inner stage** (its environment is exactly the clean base plus the Infisical secrets):

1. Build the set of injected names: `jq -rn 'env|keys[]'` minus the base names (`PATH`, `HOME`,
   `PWD`, `SHLVL`, `_`, `INFISICAL_TOKEN`, `INFISICAL_DOMAIN`, `SSL_CERT_FILE`).
2. **Refuse any injected name outside the allowed set for ENV** (D3). The message prints only the
   offending names, and only names that match `^[A-Za-z_][A-Za-z0-9_]*$`. Anything else is
   counted, never printed. This closes `LD_PRELOAD`, `DOCKER_HOST`, `BASH_ENV`, `COMPOSE_*`,
   `CONFIRM` and `AUTOLOGGER_TEST`.
3. `unset INFISICAL_TOKEN INFISICAL_DOMAIN SSL_CERT_FILE`, then export
   `AUTOLOGGER_STACK=ENV` (D4).
4. Run the guard steps and the compose steps in order, all in this one process:
   - `resolved`: the existing checks on the resolved config, moved from `envfile`: project name,
     loopback, numeric ports, no 8080, no 80 or 443 in dev.
   - `prod-tags`: `WEB_TAG` and `API_TAG` set, and not `latest`.
   - `compose <args>`: `compose_<ENV> /dev/null <args>`.
   - `urls`: the printed URLs.
   - `reset`: the confirmation check.

   The resolved JSON inlines passthrough values, so it is only ever piped into `jq -e`, never
   printed.

**Makefile shape.** Examples:
- `dev-up: ; @sh docker/scripts/compose-run.sh dev resolved 'compose up -d --build' urls`
- `dev-restart` passes its four `compose restart X` steps in one call, so there is one login and
  a single environment.
- There is no `$(DEV)` variable and no `sh -c` inside make, which avoids the `$@` / `$$@`
  quoting trap.
- `CONFIRM` is read in the outer stage, before `env -i`, and passed as a `reset` step argument.

**Alternatives rejected:**
- A Makefile-level `sh -c '. compose-env.sh && compose_dev …'`: fragile quoting, one login per
  call, and a separate guard fetch (a time-of-check to time-of-use gap).
- An Infisical Agent rendering env files: writes secrets to disk.
- `infisical export`: values would need parsing and passing, which is fragile and puts them on
  argv or disk.

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
environment. `compose-run.sh` holds the latter as constants:

| Environment | Compose-interpolation keys |
| --- | --- |
| dev | `DEV_PORT`, `DEV_COMPANION_PORT` |
| stage | `STAGE_PORT` |
| prod | `ROUTER_PORT`, `WEB_TAG`, `API_TAG`, `PUBLIC_BASE_URL` |

- The D2 keys are read from `docker/secrets-env.yaml` with a line match
  (`^      [A-Z][A-Z0-9_]*:$`). A static invariant keeps that line match equal to the resolved
  passthrough names (D5).
- There is no second list: `docs/infisical-secrets.md` documents the keys and points at the file.
- Ambient overrides such as `DEV_PORT=9000 make dev-up` stop working. `env -i` drops them, and
  the Infisical CLI would override them anyway. To change a port, set it in Infisical. README and
  the `compose-env.sh` header comment say so.

### D4. Hand-typed compose fails loudly

- The allowlist file also carries `AUTOLOGGER_STACK: ${AUTOLOGGER_STACK:?run compose through make
  (docker/scripts/compose-run.sh); secrets come from Infisical}`.
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

Each machine identity:
- has read-only access to its one environment;
- has an access-token TTL of 15 minutes and a maximum TTL of 1 hour;
- has Trusted IPs on both the client secret and the access token, limited to the hosts that run
  that stack: this host for dev and stage, and the deploy host for prod;
- has its client secret rotated when a host is decommissioned, and at least yearly.

### D7. Cutover, rollback and break-glass

- **Rollback** is reverting the change. No target deletes an env file.
- **Old env files stay until main.** The owner deletes `.env.dev` and `.env.stage` only after this
  change reaches `main` at the ADR 0021 cutover, because `main`'s Makefile still reads them until
  then.
- **Backup before deletion.** Deleting them also requires a verified Infisical backup and a
  restore test, because the owner's `~/infisical/README.md` says the `.env` holding
  `ENCRYPTION_KEY` must be kept off-host.
- **Prod dry run.** `make prod-check` runs `compose-run.sh prod resolved prod-tags 'compose config
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
     so the domain must be on both the login and the run step (`root.go`);
   - `/api` is appended automatically (`util/helper.go`);
   - universal auth writes no secrets backup to disk (`util/secrets.go`);
   - `infisical secrets --plain` prints `KEY=VALUE`, so it is never used here (`secrets.go`);
   - `--expand` defaults to true.
7. **TLS.** From the panel: `openssl s_client -connect 192.168.0.100:443 | openssl x509 -ext
   subjectAltName` gave `IP Address:192.168.0.100`, issuer "Caddy Local Authority - ECC
   Intermediate", `Verify return code: 0`. The CA is already in this host's system store, so
   `INFISICAL_CA_FILE` is optional.
8. **Environment.** `uname -m` gave `aarch64`, `docker compose version` gave `v5.2.0`, and
   `which infisical` gave exit 1 (not installed). Installing it is owner task 1.1.
9. **Not checkable by the agent:** whether the deploy host reaches `192.168.0.100`. The owner
   checks it with `make prod-check` before cutover.

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
- **[Complexity] One ~120-line wrapper** replaces the per-call Makefile layering. It is tested with
  a stub `infisical` (tasks 3.x).
