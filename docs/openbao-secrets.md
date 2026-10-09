# Stack secrets from OpenBao

The dev, stage and prod compose stacks get their secrets from the owner's self-hosted OpenBao
(OpenSpec change `openbao-secrets`, which replaces `infisical-secrets`). There are no `.env.dev`,
`.env.stage` or prod `.env` files. Every `make dev-*`, `stage-*` and `prod-*` target that runs
compose goes through `docker/scripts/compose-run.mjs`. That script:

1. logs in to OpenBao with the stack's AppRole (`POST /v1/auth/approle/login`, body
   `{role_id, secret_id}`), which returns `auth.client_token`;
2. reads the stack's KV v2 secret into memory (`GET /v1/<mount>/data/<path>`, header
   `X-Vault-Token`);
3. revokes the token (`POST /v1/auth/token/revoke-self`). A failed revoke is a warning only; the
   token still expires at its TTL;
4. checks every name and value;
5. runs the guards and `docker compose` with an environment built only from the allowed keys,
   and passes `--env-file /dev/null`.

Nothing is written to disk. No secret is put on a command line or read by a shell.

The OpenBao server, its policies, AppRoles, KV seed and the per-host credentials files are managed
by the infra repo `~/spark-infra` (Ansible). This repo only reads.

## Requirements on each host

- **Node 22.12 or newer on `PATH`** when you run `make`. The Makefile resolves `node` from your
  `PATH`, then runs it under `env -i`. No `npm ci` is needed, because the wrapper uses only
  built-in modules.
- **Network access to OpenBao.** VMs on `lxdbr0` use `https://10.88.0.10:8200`; the host and LAN
  use `https://192.168.0.100:8200` (an LXD proxy device).
- **The CA certificate that OpenBao's TLS chains to** (the internal root CA from `~/spark-infra`).
  Node does not use the system trust store, so the path is required even if the CA is installed
  system-wide. The file must be a regular file, not a symlink, not writable by group or others,
  and at most 64 KiB.

## The credentials file

Each host holds one untracked file per environment it runs, at the repo root:
`.env.openbao.dev`, `.env.openbao.stage` or `.env.openbao.prod`. Ansible renders it on the VMs. By
hand:

```bash
cp docker/openbao-credentials.example .env.openbao.dev
chmod 600 .env.openbao.dev
$EDITOR .env.openbao.dev
```

| Key | Value |
| --- | --- |
| `BAO_ADDR` | A bare `https://host[:port]` origin, with no path, e.g. `https://10.88.0.10:8200` |
| `BAO_CACERT` | Absolute path of the CA certificate (PEM) |
| `BAO_ROLE_ID` | That environment's AppRole role id |
| `BAO_SECRET_ID` | That environment's AppRole secret id (CIDR-bound to this host) |
| `BAO_KV_PATH` | `<mount>/<path>`, e.g. `kv/autologger/dev` |

The wrapper refuses the file if any of these hold:
- it is a symlink;
- it is not owned by you;
- it is readable or writable by group or others;
- a key is missing or empty;
- `BAO_ADDR` is not a bare `https` origin;
- `BAO_KV_PATH` has fewer than two segments, a segment outside `[A-Za-z0-9_-]+`, or a last segment
  that is not the environment name (`dev`, `stage` or `prod`). The first segment is the KV v2
  mount. This is checked before any request, so a dev host can't be pointed at the prod path by a
  typo.

The file is git-ignored (`.env.*`), and agents are denied reading it with the Read tool.

Moving OpenBao means editing `BAO_ADDR` and `BAO_CACERT` in these files. No repo change is needed.

## KV layout

One KV v2 mount, `kv`, with one secret per stack:

| Path | Read by |
| --- | --- |
| `kv/autologger/dev` | AppRole `autologger-dev` |
| `kv/autologger/stage` | AppRole `autologger-stage` |
| `kv/autologger/prod` | AppRole for the prod host (created at cutover) |

Each secret is a flat map of string keys to string values. A non-string value is refused.

## What goes in each KV secret

A secret may hold only these keys:
- the container keys listed in `docker/secrets-env.yaml`;
- that environment's compose keys:

  | Environment | Compose keys |
  | --- | --- |
  | `dev` | `DEV_PORT`, `DEV_COMPANION_PORT`, plus the Supabase keys |
  | `stage` | `STAGE_PORT`, plus the Supabase keys |
  | `prod` | `ROUTER_PORT`, `WEB_TAG`, `API_TAG`, `PUBLIC_BASE_URL`, plus the Supabase keys |

  Every environment also accepts the retired Supabase keys (see "Retired keys" below), and
  ignores them.

Any other name is refused before anything runs, and the error names the key without printing its
value. That includes `LD_PRELOAD`, `DOCKER_HOST`, any `COMPOSE_*` name, any `BAO_*` name, and a key
meant for another service.

Other rules:
- **Tags.** `WEB_TAG` and `API_TAG` are the 12-character git SHA that `make prod-push` prints.
  `latest` is refused.
- **Required prod keys.** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BOOTSTRAP_OWNER_EMAIL` and
  `ADMIN_TOKEN`. `API_TOKEN` is no longer required: it is ignored since ADR 0021 slice 9d
  (companion-devices), and you may leave it or delete it. A Companion uses a device token created
  in Settings → Companion devices.
- **`GOOGLE_CLIENT_ID` is also read by GoTrue** (gotrue-sign-in D3), as the audience of the ID
  tokens it accepts. It is public, so it has no secret scope. `GOOGLE_CLIENT_SECRET` stays with
  the app only.
- **Every stack needs Google sign-in** (require-login). `compose-run` refuses dev, stage and prod
  unless both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set, and the server refuses to boot
  without them. Dev needs its own Google OAuth client (authorized redirect
  `http://localhost:8787/auth/google/callback`). The dev Companion connection needs a device token
  created in dev's Settings → Companion devices; without it the dev Companion gets `401`
  (`API_TOKEN` in `kv/autologger/dev` is ignored since 9d).
- **Every stack needs `BOOTSTRAP_OWNER_EMAIL`** (owner-bootstrap D8). It names the bootstrap
  owner: at every sign-in whose verified Google email matches it (trimmed, ASCII
  case-insensitive; an email with any non-ASCII character never matches), that user becomes the
  owner of every team that has no owner, and each claimed team id is logged. A missing or blank
  value refuses `make <env>-up` (`compose-run`) and refuses the server's boot; a non-ASCII value
  also refuses boot. At boot the server logs a masked form, `bootstrap owner: <domain> #<8 hex>`,
  never the local part, so you can check the value for a typo.
- **`RUN_FEATURE_EMAILS` is optional** (run-status-and-sweeper D9). It lists, comma-separated, the
  users approved for the run features: the AI chat, AI v2 design, topic and event generation,
  YouTube import and transcript generation (including the log import's). The bootstrap owner is
  always approved in addition; anyone else gets `403` on those routes. Entries match like the
  bootstrap owner (trimmed, ASCII case-insensitive), and a non-ASCII entry refuses boot. To grant
  someone, add their email to the key in the stack's KV secret and restart the stack
  (`make <env>-up`). At boot the server logs `run-feature users: <count> (<masked forms>)`, never
  the addresses.
- **Never reuse prod secrets in dev or stage.** Use separate, low-limit keys and separate OAuth
  clients.
- **Ports are set in OpenBao.** `DEV_PORT=9000 make dev-up` does not override them, because the
  wrapper builds the child environment from the KV secret only.

### Supabase keys

Each Supabase key reaches only the services listed below (see [supabase.md](supabase.md)). Never
add one to `docker/secrets-env.yaml`. The wrapper and `make check` (invariant 16) refuse a config
where a value appears in any other service.

| Key | Format | Services |
| --- | --- | --- |
| `POSTGRES_PASSWORD` (superuser) | at least 32 lowercase hex characters | `db`, `migrate` |
| `SUPABASE_ROLES_PASSWORD` (`supabase_auth_admin`) | at least 32 lowercase hex characters | `db`, `auth` |
| `APP_DB_PASSWORD` (`autologger_app`, the catalog's app role) | at least 32 lowercase hex characters | dev: `app`, `migrate`; stage and prod: `api`, `migrate` |
| `JWT_SECRET` (signs GoTrue's tokens) | at least 40 characters of `A-Za-z0-9_-` | `auth` |

Any value outside its format is refused.

- **Create the keys with the generator,** never by hand. It needs an admin token (the AppRole
  can only read), from a file or from `BAO_TOKEN`:

  ```sh
  bao login -method=userpass username=<you>        # writes ~/.vault-token
  node docker/scripts/supabase-keys.mjs dev --writer ~/.vault-token
  # or: BAO_TOKEN=... node docker/scripts/supabase-keys.mjs dev
  ```

  The writer file must be mode 600 and hold either a `BAO_TOKEN=...` line or a single raw token
  line. `BAO_ADDR`, `BAO_CACERT` and `BAO_KV_PATH` come from `.env.openbao.<env>`.

  The generator reads the secret's key names (values are discarded), then writes every missing
  one of the four keys in one request: a KV v2 `PATCH` (`application/merge-patch+json`)
  with `options.cas` set to the version it read, or a `POST` with `cas: 0` if the path doesn't
  exist yet. A concurrent write makes the whole request fail, and nothing is retried. An existing
  key is never overwritten. It prints `created` or `kept` for each of the four keys and never
  shows a value. It never reads, reports, writes or deletes a retired key. If the path's current
  version is deleted (`bao kv delete`) or destroyed, it
  refuses and writes nothing: restore a deleted version with `bao kv undelete` or
  `bao kv rollback`, a destroyed one with `bao kv rollback` only. A future `deletion_time` (set on
  live versions when `delete_version_after` is configured) is not a deletion.
- **Changing a password or `JWT_SECRET` after the database exists** needs more than a KV write.
  See "Rotation" in [supabase.md](supabase.md).

### Retired keys

`drop-unused-supabase-services` (ADR 0021 slice 10) removed PostgREST, Realtime, Storage and the
gateway. Their five keys are retired: `ANON_KEY`, `SERVICE_ROLE_KEY`, `SECRET_KEY_BASE`,
`REALTIME_DB_ENC_KEY` and `SUPABASE_PORT`.
- **The tooling accepts and ignores them.** A secret that still holds any of them isn't refused,
  their values aren't format-checked, and `compose-run` passes them to no container. It prints one
  warning naming the ones present (names only):
  `compose-run: warning: the OpenBao <env> secret holds retired keys <names>; …`.
- **Keep them while any checkout runs the old stack.** `kv/autologger/dev` is shared with
  `~/autologger-ui`, whose branch still starts the old services and needs these keys.
- **Then remove them,** with a KV v2 merge patch whose values are `null` (it removes those keys
  and keeps the rest), or in the OpenBao UI:

  ```sh
  echo '{"ANON_KEY":null,"SERVICE_ROLE_KEY":null,"SECRET_KEY_BASE":null,"REALTIME_DB_ENC_KEY":null,"SUPABASE_PORT":null}' \
    | bao kv patch kv/autologger/<env> -
  ```

- **Then rotate `JWT_SECRET`.** The retired `SERVICE_ROLE_KEY` is a `service_role` JWT signed
  with the `JWT_SECRET` the stack still uses (5-year expiry), so it stays a GoTrue admin
  credential until `JWT_SECRET` changes. Rotate it only after the retired keys are gone: an older
  `compose-run.mjs` refuses a `JWT_SECRET` its stored `ANON_KEY` and `SERVICE_ROLE_KEY` don't
  verify against. See "Rotation" in [supabase.md](supabase.md).

To add a container key:
1. Add a line `KEY:` to `docker/secrets-env.yaml`. `make check` invariant 15 keeps compose in
   step with that file.
2. Set the key in OpenBao (`bao kv patch kv/autologger/<env> KEY=...`).

## AppRole hardening

Each stack has its own AppRole, created by `~/spark-infra`:

| Setting | Value |
| --- | --- |
| Roles | `autologger-dev`, `autologger-stage`; prod's at cutover |
| Policy | `read` on `kv/data/autologger/<env>` only. The dev role must not read stage or prod. |
| `secret_id_bound_cidrs` | The VM's own IP (`/32`), e.g. dev `10.88.0.21/32`, stage `10.88.0.20/32` |
| `token_bound_cidrs` | Same as above (recommended) |
| `secret_id_ttl` | 90 days; Ansible rotates it and re-renders `.env.openbao.<env>` |
| `token_ttl` / `token_max_ttl` | 5 minutes / 10 minutes (the wrapper revokes its token right after the read anyway) |

To check that the dev role can't read prod, on the dev VM:
1. Copy `.env.openbao.dev` to `.env.openbao.prod` (mode 600) and set `BAO_KV_PATH=kv/autologger/prod`.
2. Run `make prod-check`. It must fail with `HTTP 403` at the read.
3. Delete the copy.

A login from a host outside the bound CIDR fails at login (`HTTP 400` or `403`).

## Commands

| Command | What it does |
| --- | --- |
| `make dev-up`, `make stage-up` | Log in, read, revoke, check the resolved config, then `compose up` |
| `make dev-check` | Static check plus credentials-inode warning; reads nothing from OpenBao |
| `make dev-psql` | psql in the dev `db` as `postgres`, with no history file (goes through `compose-run`, so it needs OpenBao) |
| `make prod-check` | Prod dry run on any branch: log in, read, guards, `compose config`. Starts nothing. |
| `make prod-up`, `make prod-pull` | Clean `main` only |
| `make dev-reset CONFIRM=yes`, `make stage-reset CONFIRM=yes` | Reset. Refused for prod. |

## What the wrapper protects against

- **Your shell's Node settings can't change the wrapper.** The Makefile runs it under `env -i`,
  so `NODE_OPTIONS`, `NODE_DEBUG`, `NODE_TLS_REJECT_UNAUTHORIZED` and proxy variables never reach
  it, and it refuses to start if they are present anyway.
- **TLS is always verified,** with `rejectUnauthorized: true` against your CA file only.
- **Responses are strict:** exactly HTTP 200 (204 for the revoke), no redirects, 15 s to connect,
  30 s in total, a 1 MiB cap, and no compression.
- **Error messages never contain a value.** Parse errors and crashes print a fixed message.
  OpenBao's `errors` strings are stripped of control characters and cut to 200 characters. A
  failed login prints the HTTP status and that message only.
- **The whole read is refused on any bad secret:** a non-string value, a NUL byte, an invalid or
  disallowed name, a bad format, a deleted or destroyed current version, or an empty secret.
- **The token lives for one target.** It is revoked right after the read, and never reaches a
  child process.
- **Steps stop at the first failure.** SIGTERM and SIGHUP are forwarded to compose.

## Break-glass: OpenBao is sealed or down

- **Running containers are unaffected.** They keep the environment they started with.
- **Stopping prod needs no secrets:**
  `docker stop autologger-router autologger-web autologger-api`.
- **Every compose target needs the Supabase keys,** including `down` and `logs`. Stop a stack
  without OpenBao with `docker stop` on its containers.
- **Sealed after a restart.** OpenBao uses a static-key auto-unseal, so a restart unseals it with
  no human step: `lxc restart openbao`, then `bao status` should show `Sealed false`.
- **Data lost or corrupt.** Restore the latest raft snapshot (a daily timer keeps 14):
  `bao operator raft snapshot restore <file>`. The recovery keys are held offline by the owner.
- **OpenBao unrecoverable.** Rebuild it with `~/spark-infra`, re-seed `kv/autologger/<env>` from
  the owner's offline export, recreate the AppRoles, and re-render `.env.openbao.<env>` with
  Ansible.
- **Psql without OpenBao.** `make dev-psql` goes through `compose-run`, and so needs OpenBao.
  With OpenBao down, use
  `docker exec -it -e PSQL_HISTORY=/dev/null <db container> psql -U postgres`.
- **Never paste a secret into a tracked file,** and never write a temporary `.env` to start a
  stack.
