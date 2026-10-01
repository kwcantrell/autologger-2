# Supabase API services and gateway in every compose stack

Tier: 2
Tier reason: adds auth, a public API gateway, new secrets and database roles to the compose stacks; dev and stage run them, prod gets the definitions only (auth, secrets, topology).

Approved-by: Kalen 2026-09-30

## Why

ADR 0021 slice 1.2b. Slice 1.2a gave each stack an isolated Supabase Postgres. Later slices need
Supabase's API services running beside it, reachable the way supabase-js expects:
- slice 2, the Companion Realtime spike;
- slice 5, Supabase Auth;
- slice 9, Realtime;
- slice 10, Storage.

## What Changes

- **Four Supabase services in dev, stage and prod,** defined once in a shared compose file:
  - auth (GoTrue);
  - rest (PostgREST);
  - realtime;
  - storage (file backend, in a named volume, with an explicit file-size limit).

  Images are pinned by digest. Each service drops all capabilities and runs as non-root where the
  image allows. Studio, meta, imgproxy, edge functions, analytics, vector, the pooler, the S3
  protocol, GraphQL, CORS and the asymmetric-key variables are left out.
- **A gateway, `supabase-gw`.** It uses the repo's pinned Caddy image and is published on
  `127.0.0.1:${SUPABASE_PORT}`. It reproduces upstream's legacy-key gateway for the four services:
  - **Host and Origin checks**, against DNS rebinding and cross-site requests.
  - **Routing:**
    - path routing with normalised, case-insensitive matching;
    - the realtime Host rewrite and websocket passthrough;
    - realtime's tenant APIs blocked.
  - **The `apikey` check:**
    - the key must be the anon or service-role key;
    - the service-role key is required for the REST root.
  - **Headers:**
    - `Authorization: Bearer <apikey>` when the client sent none;
    - no client `X-Forwarded-Path` reaches storage;
    - no keys in its logs.
- **Three networks:**

  | Network | Internal and host-isolated | Joined by |
  | --- | --- | --- |
  | `db` | yes | `db`, `migrate` and the four services |
  | `supabase` (new) | yes | the gateway and the four services |
  | `edge` (new) | no | the gateway only, to publish its port |

  The host can reach the services only through the gateway.
- **Seven new Infisical keys per environment:**
  - `SUPABASE_PORT` (compose port);
  - `SUPABASE_ROLES_PASSWORD`;
  - `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`;
  - `SECRET_KEY_BASE`, `REALTIME_DB_ENC_KEY`.

  Each has a fixed format. The wrapper checks that `ANON_KEY` and `SERVICE_ROLE_KEY` are distinct
  and unexpired HS256 JWTs signed with `JWT_SECRET`, with the right roles. The generator creates
  every key except `SUPABASE_PORT`, all in one request.
- **Per-service secret confinement.** Each secret value may appear only in the services that
  need it. The static check (sentinels) and the wrapper (real values) enforce this.
- **Split database passwords.**
  - `SUPABASE_ROLES_PASSWORD` is the password of `authenticator`, `supabase_auth_admin` and
    `supabase_storage_admin`. Only `db`, rest, auth and storage hold it.
  - `POSTGRES_PASSWORD`, the superuser password, is held only by `db`, `migrate` and realtime.
- **Init SQL:** `roles.sql`, adapted to set only the three service roles; `jwt.sql` and
  `realtime.sql`, verbatim. It runs only on an empty Postgres volume, so dev and stage remove
  their two Postgres volumes once. App data and logins are kept.
- **GoTrue starts with sign-up off and no provider.**
- **Commands:** `make dev-up` and `make stage-up` print the Supabase URL.
- **BREAKING for operators:**
  - dev and stage need the new keys, and a one-time removal of their Postgres volumes;
  - a checkout older than this change (including the frozen `main`) refuses an environment that
    holds the new keys.
- **Static checks** (`check-envs.sh`) cover:
  - the new dev service set;
  - published ports (dev: app, Companion and gateway; stage and prod: router and gateway);
  - invariant 16, rewritten for network membership, isolation, subnets, digest pins and the
    confinement table;
  - new read-only bind exceptions for the gateway Caddyfile and the init SQL.

## Decisions (owner, 2026-09-30)

- **Gateway:** Caddy with the legacy HS256 keys, on its own `127.0.0.1` port per environment.
- **Passwords:** the service-role password is split from the superuser password.
- **Google sign-in:** waits for slice 5, which also gives auth (only) the egress it will need.
- **Size:** one change with `size-override`.
- **Prod is on hold:** dev and stage only. Prod gets the definitions and the static check, and its
  keys wait for cutover. Stage may later be seeded from `server/data`.
- **After the panel:**
  - **Studio and meta are deferred** to a later slice. They were the path to both critical
    findings: cross-site SQL through Studio, and meta's unauthenticated SQL endpoint.
  - **The `supabase` network is internal and host-isolated,** with a gateway-only `edge` network.
  - **Re-initialisation removes only the two Postgres volumes,** never app data or logins.

## Non-goals

- **Studio and postgres-meta** (deferred). Admin access stays `make dev-psql`.
- **Supabase features beyond starting the four services:** Google or any provider, SMTP, the
  bootstrap owner, user tables, RLS, buckets (slices 5, 6, 10). Also auth egress (slice 5).
- **App connections:** no app service (`app`, `api`, `web`, `router`, Companion) connects to
  Supabase. Slice 2 decides how Companion reaches Realtime.
- **Upstream extras:** imgproxy, edge functions, analytics/Logflare, vector, Supavisor, the S3
  protocol, MinIO, GraphQL, CORS, `webhooks.sql`, and the new opaque or asymmetric keys.
- **Prod:** no keys, no start and no migration before cutover.
- **TLS on the gateway** (it is loopback only), and **automated key rotation.**

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `container-deployment`, "Compose topology":
  - the four services and the gateway;
  - the gateway as a second published port;
  - the three networks, with no direct host reach;
  - per-secret confinement;
  - operability for the new services.
- `local-container-environments`:
  - **Makefile entry points:** URLs, and the one-time Postgres-volume step.
  - **Dev gate rule:** the gateway is a Host- and Origin-checking gate port.
  - **Dev isolation:** bind exceptions.
  - **Coexistence:** subnets and port.
  - **Allowed names:** the new keys, formats and JWT consistency.
  - **Static invariant 16:** rewritten.
  - **Secret generator:** the new keys.
  - **New requirement:** "Supabase gateway routes and key checks".

## Impact

- **New files:**
  - `docker/supabase-services.yaml`;
  - `docker/supabase-gw.Caddyfile`;
  - `docker/supabase/init/{roles,jwt,realtime}.sql`;
  - `docker/supabase/test_gateway.sh`.
- **Changed files:**
  - `compose.yaml`, `docker/compose.dev.yaml`, `docker/compose.stage.yaml` (the `supabase` and
    `edge` networks);
  - `docker/supabase-db.yaml` (init mounts, `SUPABASE_ROLES_PASSWORD` on `db`);
  - `docker/scripts/compose-env.sh`, `compose-run.mjs`, `supabase-keys.mjs`, `check-envs.sh`, and
    their tests;
  - `Makefile`, `README.md`, `docs/supabase.md`, `docs/infisical-secrets.md`, `docs/security.md`
    (container logs are untrusted data);
  - the ADR 0021 slice list.
- **Infisical:** the new keys in `autologger-dev` and `autologger-stage`, created by the agent,
  plus `SUPABASE_PORT` (dev 8790, stage 8791).
- **Data:** the dev and stage Postgres volumes are recreated once. Nothing else is removed.
- **Resources:** five more containers per running stack.
- **Unchanged:** the HTTP/WS contract.
