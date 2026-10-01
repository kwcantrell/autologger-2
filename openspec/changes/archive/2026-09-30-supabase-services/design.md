# Design

## Context

- **What 1.2a left.**
  - `docker/supabase-db.yaml` (`db`, `migrate`) is added to every stack by `compose-env.sh`.
  - Each base file declares the internal, host-isolated `db` network.
  - `compose-run.mjs` has `COMPOSE_KEYS`, `KEY_FORMAT`, the `POSTGRES_PASSWORD` value-leak rule
    and the prod `run`/`exec` refusal.
  - `check-envs.sh` invariant 16 covers `db`/`migrate`.
  - `supabase-keys.mjs` creates `POSTGRES_PASSWORD`, one key per batch.
- **Upstream** (supabase/supabase `docker/` v0.8.2, fetched 2026-09-30) runs a legacy-key Envoy
  or Kong gateway:
  - the `apikey` check;
  - `Bearer <apikey>` when the client sent no `Authorization`;
  - prefix strips;
  - the realtime Host rewrite.

  Upstream gives every service `POSTGRES_PASSWORD`. Realtime connects as `supabase_admin`.
- **Realtime's tenant** is the first label of the request `Host`.
- **Panel experiments** (`panel2at-*`, `panel2fa-*`) ran this design's pieces against the pinned
  images. Their results are the assumption evidence below.

## Goals / Non-Goals

**Goals:**
- **The same contract as upstream.** supabase-js against `http://localhost:<SUPABASE_PORT>`
  behaves as against upstream's gateway, for auth, rest, realtime and storage.
- **The gateway is the only door.** No host process, web page or other app container reaches a
  Supabase service except through the gateway's Host, Origin and key checks.
- **Superuser password confinement.** The superuser password stays in `db`, `migrate` and
  realtime. Every secret is confined per service by both enforcers.

**Non-Goals:** as in proposal.md.

## Decisions

### D1. Shared file `docker/supabase-services.yaml`, three networks

- **Wiring.** `compose_dev`, `compose_stage` and `compose_prod` add
  `-f docker/supabase-services.yaml` after `supabase-db.yaml`.
- **No per-environment values in service definitions.** `GOTRUE_SITE_URL` is the literal
  `http://localhost:${SUPABASE_PORT}`, because sign-up is off and no provider exists until slice
  5. So the base files declare only networks, and `compose.yaml` stays valid on its own, which
  `e2e:container` needs.
- **Networks each base file declares:**

  | Network | Settings | prod | stage | dev |
  | --- | --- | --- | --- | --- |
  | `db` | internal, isolated (from 1.2a) | 172.28.12.0/24 | 172.28.22.0/24 | 172.28.31.0/24 |
  | `supabase` | internal, `gateway_mode_ipv4/ipv6: isolated` | 172.28.13.0/24 | 172.28.23.0/24 | 172.28.32.0/24 |
  | `edge` | not internal; joined only by `supabase-gw`, for its published port | 172.28.14.0/24 | 172.28.24.0/24 | 172.28.33.0/24 |

  Stage uses `ipam: !override`.
- **Why `edge`.** A published port needs a non-internal network. Putting only the gateway on it
  keeps the four services unreachable from the host (A11).

### D2. Services

| Service | Image | User and capabilities | Database login |
| --- | --- | --- | --- |
| auth | `supabase/gotrue:v2.196.0` | the image's `supabase` user; `cap_drop: ALL` | `supabase_auth_admin` with `SUPABASE_ROLES_PASSWORD` |
| rest | `postgrest/postgrest:v14.17` | uid 1000; `cap_drop: ALL` | `authenticator` with `SUPABASE_ROLES_PASSWORD` |
| realtime | `supabase/realtime:v2.134.10` | `user: 65534`, no capabilities, custom entrypoint (below) | `supabase_admin` with `POSTGRES_PASSWORD`, `search_path _realtime` |
| storage | `supabase/storage-api:v1.74.0` | root with `cap_drop: ALL` (A7) | `supabase_storage_admin` with `SUPABASE_ROLES_PASSWORD` |

All four images are digest-pinned (A1).

**Realtime's entrypoint.** It replaces upstream's `run.sh`, which needs `sudo`:

```sh
ulimit -Sn 10000 && /app/bin/migrate && /app/bin/realtime eval 'Realtime.Release.seeds(Realtime.Repo)' && exec /app/bin/server
```

**Every service** gets:
- `restart: unless-stopped`, `init: true`, `*logging`, `no-new-privileges`;
- upstream's healthcheck. Those tools exist in each image (A6).

**auth:**
- `GOTRUE_DISABLE_SIGNUP=true`, and `GOTRUE_EXTERNAL_{EMAIL,PHONE,ANONYMOUS_USERS}_ENABLED=false`;
- no SMTP and no provider;
- `API_EXTERNAL_URL` and `GOTRUE_JWT_ISSUER` are `http://localhost:${SUPABASE_PORT}/auth/v1`;
- `GOTRUE_SITE_URL` is `http://localhost:${SUPABASE_PORT}`.

**realtime:**
- `SEED_SELF_HOST=true`, `APP_NAME=realtime`;
- `DB_ENC_KEY=${REALTIME_DB_ENC_KEY}`;
- `SECRET_KEY_BASE`;
- `API_JWT_SECRET` and `METRICS_JWT_SECRET` are `${JWT_SECRET}`;
- upstream's healthcheck carries the anon key, so `ANON_KEY` is allowed in realtime;
- `ERL_AFLAGS`, `DNS_NODES` and `RLIMIT_NOFILE` as upstream.

**storage:**
- `STORAGE_BACKEND=file`, `FILE_STORAGE_BACKEND_PATH=/var/lib/storage` on the named volume
  `supabase-storage`;
- `FILE_SIZE_LIMIT=52428800`, set explicitly;
- `ENABLE_IMAGE_TRANSFORMATION=false` and `S3_PROTOCOL_ENABLED=false`;
- `TENANT_ID`, `REGION` and `GLOBAL_S3_BUCKET` are `stub`;
- `STORAGE_PUBLIC_URL=http://localhost:${SUPABASE_PORT}`;
- `REQUEST_ALLOW_X_FORWARDED_PATH=true`. The gateway strips any client value.

**Dependencies:** `depends_on: db: service_healthy` everywhere. Storage also waits for rest.

**Networks:** `db` and `supabase` for all four services.

Why realtime keeps the superuser: with `DB_USER=postgres`, realtime exits with
`permission denied for schema _realtime` (A12).

### D3. The gateway

- **Container.** `supabase-gw` runs the router's pinned Caddy image with the router's posture:
  - user `65532`, read-only, tmpfs `/data` and `/config`;
  - `cap_drop: ALL` plus `cap_add: NET_BIND_SERVICE`, which the binary's file capability needs
    to exec (A13);
  - healthcheck `wget 127.0.0.1:2019/config/`, as the router.
- **Config.** `docker/supabase-gw.Caddyfile`, mounted read-only. The environment holds
  `ANON_KEY`, `SERVICE_ROLE_KEY` and `SUPABASE_PORT`.
- **Logging and listener:**
  - Global options set `admin 127.0.0.1:2019` and a log that excludes `http.log.error` and
    access logs. Caddy's upstream-error log writes the `apikey` header verbatim (A14).
  - The gateway listens on `:8000` with `auto_https off`.
- **Ordering.** All checks and routes sit inside one `route { }` block. Caddy otherwise sorts
  `handle`/`handle_path` before `respond`, which disables every check (A15). Inside it, in order:
  1. **Host.** `@badhost not header_regexp Host ^(localhost|127\.0\.0\.1):{$SUPABASE_PORT}$` →
     `403`. A missing Host also fails.
  2. **Origin.** `@badorigin` is `header Origin *` and not
     `header_regexp Origin ^http://(localhost|127\.0\.0\.1):{$SUPABASE_PORT}$` → `403`. This
     applies to every method and to upgrades, because there is no browser client yet. Slice 5
     revisits it together with CORS.
  3. **Tenant APIs.** `@blocked path /realtime/v1/api/tenants* /realtime/v1/api/openapi*` → `403`.
  4. **Routes.** Each route's key check uses the same `path` matcher that selects it (`path` is
     case-insensitive and normalises slashes and encoding). CEL is used only to compare key
     values, never paths (A16).
     - `/auth/v1/verify`, `/auth/v1/callback`, `/auth/v1/authorize`: no key.
     - Other `/auth/v1/*` and `/rest/v1/*`: anon or service-role.
     - Exactly `/rest/v1/`: service-role.
     - `/realtime/v1/*`: anon or service-role, from the header or `{query.apikey}`.
     - `/storage/v1/*`: no key.
     - Anything else: `404`.
  5. **Key comparison.** `{http.request.header.apikey} != "" && ({http.request.header.apikey} == "{$ANON_KEY}" || … == "{$SERVICE_ROLE_KEY}")`.
     The non-empty guard means an unset key can't open a route. The wrapper's format check and
     compose's `:?` also make empty values impossible.
  6. **`Authorization`.** Under `@noauth` (no `Authorization` header, or an empty one), set
     `Authorization "Bearer {http.request.header.apikey}"`. On realtime, the query parameter is
     used when the header is absent.
  7. **Proxies.** `handle_path` strips each prefix:
     - `/realtime/v1/api/*` → `realtime:4000/api`;
     - `/realtime/v1/*` → `realtime:4000/socket`;
     - both realtime routes send `header_up Host realtime-dev.supabase-realtime` (A4, A17);
     - storage gets `header_up -X-Forwarded-Path` and `header_up X-Forwarded-Prefix /storage/v1`.
- **Why Caddy:** the owner's decision. It is already pinned and hardened, and the config is
  small. The cost is no opaque-key swap later.

### D4. Secrets: confinement table, formats, JWT consistency

- **Confinement.** One table, in `compose-run.mjs` as `SECRET_SCOPE` and in `check-envs.sh` as
  one sentinel per key, enforces the spec's invariant 16 table. The rule: every string in a
  service outside a key's allowed set (object keys included) must not contain that key's value
  or sentinel.
- **Keys and formats.** `COMPOSE_KEYS` gains the seven new keys for every environment, and
  `KEY_FORMAT` their formats.
- **JWT consistency** is checked after the per-key formats:
  - both keys must be three base64url parts with header `alg: HS256`, and an HMAC-SHA256
    signature over `header.payload` with `JWT_SECRET` that matches (compared with
    `timingSafeEqual`);
  - `role` is `anon` and `service_role` respectively, the two keys are distinct, and `exp` is in
    the future;
  - a warning, with the name only, when `exp` is under 90 days away.
- **Ports.** `checkResolved` expects dev 3 published ports (app, Companion, gateway) and stage
  and prod 2 (router, gateway), all distinct. `urls()` prints `Supabase:`.

### D5. The generator

- **Keys and formats:**
  - hex: `POSTGRES_PASSWORD`, `SUPABASE_ROLES_PASSWORD`;
  - base64url: `JWT_SECRET` (32 bytes), `SECRET_KEY_BASE` (64 bytes), and `REALTIME_DB_ENC_KEY`
    (12 bytes, giving 16 characters and 96 bits).
- **The JWT trio.** `ANON_KEY` and `SERVICE_ROLE_KEY` are built in-process, with header
  `{"alg":"HS256","typ":"JWT"}` and payload `{role, iss:"supabase", iat, exp: iat+5y}`. They are
  signed with `createHmac('sha256', JWT_SECRET)`.
  - If one or two of the three exist, the generator refuses and writes nothing. It never reads
    a value.
- **One request.** All missing keys go in one `POST /api/v4/secrets/batch`. Infisical rejects the
  whole batch if any key exists, and inserts inside one transaction (A8).
- **Unchanged:** the listing parameters, the rejected-create exit, the output, and the test
  hooks.

### D6. Init SQL and the one-time Postgres re-initialisation

- **Files in `docker/supabase/init/`,** each with a header naming its upstream source:
  - `roles.sql` is adapted. It sets `authenticator`, `supabase_auth_admin` and
    `supabase_storage_admin` through `\set pgpass \`printf %s "$SUPABASE_ROLES_PASSWORD"\``. It
    drops the `pgbouncer` and `supabase_functions_admin` lines, since there is no pooler or
    webhooks.
  - `jwt.sql` is verbatim. Upstream's current version needs only `JWT_EXP`, so `db` doesn't need
    `JWT_SECRET` (A10).
  - `realtime.sql` is verbatim.
- **Mounts** follow upstream's paths: `init-scripts/99-jwt.sql`, `init-scripts/99-roles.sql` and
  `migrations/99-realtime.sql`. `db` gains `SUPABASE_ROLES_PASSWORD`.
- **One-time step** for dev and stage (owner, 2026-09-30):
  1. Stop the stack.
  2. `docker volume rm <project>_supabase-db <project>_supabase-db-config`.
  3. Bring the stack up.

  App data and logins are untouched. docs/supabase.md documents the step and when it's needed.
- *Alternative: running the SQL once with `psql` as `supabase_admin`.* Rejected. A fresh volume
  is simpler and tests the real init path.
- *Alternative: a migration.* Rejected. `postgres` can't alter reserved roles (A18).

### D7. Checks

- **`check-envs.sh`:**
  - **Dev service set:** adds `auth`, `rest`, `realtime`, `storage` and `supabase-gw`.
  - **Invariant 3:** dev publishes app, Companion and gateway; stage and prod publish router and
    gateway.
  - **Invariant 2:** `SUPABASE_PORT` is numeric, distinct from the others, and not 8080.
  - **Invariant 4:** bind exceptions for `docker/supabase-gw.Caddyfile` (gateway only) and
    `docker/supabase/init/` (db only).
  - **Invariant 16:** rewritten per the spec.
- **`test_check_envs.sh`** gets a failing case per new clause, at least:
  - the superuser password in `rest`;
  - the gateway on `db`;
  - `rest` on `edge`;
  - the `supabase` network not internal;
  - an unpinned `auth` image;
  - `storage` publishing a port;
  - the `edge` subnet drifting;
  - `ANON_KEY` in `api`;
  - a gateway Caddyfile bind in `app`.
- **`docker/supabase/test_gateway.sh ENV`** runs by hand against a running stack. It covers every
  row of the spec's gateway table, plus:
  - path tricks: `/REST/v1/`, `/rest/v1//`, `/rest/v1/%2F`, `/realtime/v1/api//tenants`,
    `/realtime/v1/api/%2Ftenants`;
  - Host, missing Host and Origin;
  - a user-JWT passthrough;
  - an empty `Authorization`;
  - a websocket join and a REST broadcast;
  - a storage upload;
  - a host connection to each service IP;
  - a `502` with the service-role key, followed by a log count of 0;
  - the other environment's gateway never answering for this one.

  Key values come from the wrapper child, never printed.

## Assumptions

| # | Assumption | Command | Observed |
|---|---|---|---|
| A1 | The pinned images publish arm64 | `docker buildx imagetools inspect` per image | gotrue `c0c25187…4232`, postgrest `c9dc201e…030f2c`, realtime `cbcc6a79…bb03`, storage-api `f1546fac…7c85`: `arm64=1` |
| A2 | Compose merges partial services across files | panel: base partial + later full | `{"image":"alpine","environment":{…}}`; later files win (so no per-environment partials are used, see D1) |
| A3 | `{$VAR}` works in CEL comparisons | panel matrix in `route {}` | rest: nokey 401, wrong 401, anon 200, root anon 403, root svc 200; repeated apikey 401; realtime: query key 200, bad 401 |
| A4 | Realtime takes its tenant from the upstream Host | panel: `node ws.mjs` via the gateway, realtime container with no special name | `phx_reply {"status":"ok"}` |
| A5 | (dropped with Studio) | | |
| A6 | Upstream healthcheck tools exist | panel | gotrue wget, storage wget and node, realtime curl; all healthy |
| A7 | auth, rest and storage run with `cap_drop: ALL`; storage can write its volume | panel | all healthy under `cap_drop: ALL` and no-new-privileges, also after `--force-recreate`; storage as root uploaded (200); as uid 1000, `EACCES` |
| A8 | Infisical's batch create is all-or-nothing | panel: grep of `infisical/infisical:v0.165.16` source | `createManySecret` rejects if any key exists, then inserts inside `secretDAL.transaction` |
| A9 | GoTrue starts with nothing enabled | panel | `/auth/v1/settings` → `{"email":false,…,"disable_signup":true}`; signup → `422 signup_disabled` |
| A10 | `jwt.sql` needs only `JWT_EXP`; init order works; the roles split works | panel: init over the `db` network | 99-jwt, then 99-roles, then migrations/99-realtime; service roles log in with the roles password, `supabase_admin`/`postgres` fail with it, `authenticator` fails with the superuser password; `jwt_exp` 3600 |
| A11 | An internal, isolated `supabase` network plus a gateway-only `edge` network keeps the host off the services and still works | panel | host→meta `000 unreachable`; gateway rest 404 (reached rest); websocket join ok; all services healthy |
| A12 | Realtime needs `supabase_admin` | panel: `DB_USER=postgres` | `ERROR 42501 permission denied for schema _realtime` |
| A13 | Caddy needs `NET_BIND_SERVICE` to exec under `cap_drop: ALL` | panel | without it: `caddy: Operation not permitted` (126); with it: runs |
| A14 | Caddy's error log writes `apikey` verbatim | panel: meta stopped, service key → 502 | log `"Apikey":["<SERVICE_ROLE_KEY>"]`, count 1; `Authorization` redacted |
| A15 | A flat Caddyfile runs `handle_path` before `respond` | panel | flat: no key 200, evil Host 200; in `route {}`: 401 and 403 |
| A16 | `path` matchers normalise; CEL path tests don't | panel | CEL: `/PG/tables`, `//pg/tables` and `/REST/v1/` all reached upstream (200); `path`: all 403 or 401 |
| A17 | `/realtime/v1/api` also needs the tenant Host | panel | without it, broadcast gives `Tenant not found in database` 401; with it, 202 |
| A18 | `postgres` can't alter reserved roles | panel | `ERROR: "authenticator" is a reserved role, only superusers can modify it` |
| A19 | The realtime custom entrypoint as uid 65534 with no capabilities works | panel | `running healthy caps=[]`, websocket join ok; upstream `run.sh` under `cap_drop: ALL` gives `sudo: … setresuid … not permitted` |
| A20 | The JWT format is accepted by the services | panel | PostgREST anon → 404 PGRST205 (not 401), forged → 401 PGRST301; GoTrue admin with the service key → 200; realtime join ok; storage with the service key → 200 |

## Risks / Trade-offs

- **[Realtime holds the superuser password]** → Upstream requires it (A12). Realtime is
  reachable only through the gateway's key check, on internal networks.
- **[The anon key will be public once a browser client exists]** → RLS is the authorization
  (slice 6). Until then, rest serves an empty `public` schema.
- **[An east-west compromise]** → auth, rest and storage share `db` and `supabase` with realtime,
  so a remote-code-execution flaw in one reaches the others' ports, though not meta or Studio
  (deferred). Accepted for dev and stage. Revisit with network splits before cutover.
- **[The gateway hides upstream-error details]** → `http.log.error` is excluded to keep keys out
  of logs. Debugging uses each service's own logs.
- **[Storage's volume has no quota]** → `FILE_SIZE_LIMIT` caps each file. The total isn't capped.
  docs/supabase.md says to watch `docker system df`.
- **[Container logs carry attacker-controlled text]** → docs/security.md records that logs are
  untrusted data. The log checks count values; they don't read the logs.
- **[No auth egress until slice 5]** → Nothing needs it before then.

## Migration Plan

1. Merge into `supabase-migration`.
2. Run the generator for dev and stage, and set `SUPABASE_PORT`.
3. For dev, then stage: stop the stack, remove the two Postgres volumes, bring it up, and run
   `test_gateway.sh`.
4. Prod: at cutover.
5. Rollback:
   1. Remove the two Postgres volumes again.
   2. Revert the PR.
   3. Remove the keys from Infisical.

   Doing it in this order means no Postgres was initialised with keys that no longer exist.
