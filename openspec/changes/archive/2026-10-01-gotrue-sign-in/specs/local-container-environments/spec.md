## MODIFIED Requirements

### Requirement: Supabase gateway routes and key checks
Each project SHALL have a `supabase-gw` service, the only way to reach the Supabase services from
the host. It SHALL publish exactly one port, `127.0.0.1:${SUPABASE_PORT}`, through an `edge`
network that only it joins, and reach `auth`, `rest`, `realtime` and `storage` over the internal `supabase`
network. It SHALL, before any routing:
- reject a request whose `Host` header is not `localhost:<SUPABASE_PORT>` or
  `127.0.0.1:<SUPABASE_PORT>`, or that has no `Host`;
- reject a request, including a WebSocket upgrade, whose `Origin` is present and is not
  `http://localhost:<SUPABASE_PORT>` or `http://127.0.0.1:<SUPABASE_PORT>`.

It SHALL route by path, with the prefix removed, and apply the `apikey` rule shown. Path
matching SHALL be case-insensitive and SHALL normalise repeated slashes and percent-encoding, and
the key rule SHALL apply to exactly the requests the route serves:

| Path | Upstream | `apikey` |
| --- | --- | --- |
| `/auth/v1/verify`, `/auth/v1/callback`, `/auth/v1/authorize` | auth | not required |
| other `/auth/v1/` paths | auth | anon or service-role |
| `/rest/v1/` (exact) | rest `/` | service-role |
| other `/rest/v1/` paths | rest | anon or service-role |
| `/realtime/v1/api/tenants`, `/realtime/v1/api/openapi` | refused, `403` | |
| `/realtime/v1/api/` | realtime `/api/` | anon or service-role |
| other `/realtime/v1/` paths, including the websocket | realtime `/socket/` | anon or service-role, from the header or the `apikey` query parameter |
| `/storage/v1/` | storage | not required (storage checks the token itself) |
| anything else | refused, `404` | |

It SHALL also:
- answer `401` when a required `apikey` is missing, empty, or neither key, and `403` when a
  service-role route gets the anon key;
- when the client sent no `Authorization`, or an empty one, send `Authorization: Bearer <apikey>`
  upstream, and never replace a non-empty `Authorization` the client sent;
- reach realtime, for both the API and the websocket, with the `Host` realtime uses to find its
  tenant;
- drop any client `X-Forwarded-Path` toward storage;
- never write either API key, or any other secret, to its logs.

GoTrue SHALL start with Google as its only enabled sign-in provider, accepting ID tokens whose
audience is the environment's `GOOGLE_CLIENT_ID`; email, phone and anonymous sign-in SHALL stay
disabled, so a new user can be created only from a Google identity. GoTrue SHALL NOT auto-confirm
email addresses, so it links identities by email only when the address is verified.

#### Scenario: A request without a key is refused
- **WHEN** `GET /rest/v1/` arrives with no `apikey`
- **THEN** the gateway answers `401` and rest never sees the request

#### Scenario: The anon key cannot reach the REST root by a path trick
- **WHEN** the anon key is sent to `/rest/v1/`, `/REST/v1/`, `/rest/v1//` and `/rest/v1/%2F`
- **THEN** each is answered `403` or `401`, and none reaches rest

#### Scenario: A user token is not replaced
- **WHEN** a request carries the anon key in `apikey` and a user JWT in `Authorization`
- **THEN** the upstream service receives the user JWT

#### Scenario: Realtime tenant APIs are blocked
- **WHEN** `/realtime/v1/api/tenants` is requested with the service-role key, also as
  `/realtime/v1/api//tenants` and `/realtime/v1/api/%2Ftenants`
- **THEN** the gateway answers `403` or `401`, never forwarding it

#### Scenario: A rebound Host or a foreign Origin is refused
- **WHEN** a request reaches the Supabase port with `Host: evil.example:<SUPABASE_PORT>`, or with
  a valid Host and `Origin: https://evil.example`
- **THEN** the gateway refuses it

#### Scenario: Realtime works through the gateway
- **WHEN** a client opens `/realtime/v1/websocket?apikey=<anon key>&vsn=1.0.0` and joins a
  channel, and sends a REST broadcast to `/realtime/v1/api/broadcast`
- **THEN** the join succeeds and the broadcast is accepted

#### Scenario: The host cannot bypass the gateway
- **WHEN** the dev stack is up and a host process connects to the container address of
  `auth`, `rest`, `realtime` or `storage`
- **THEN** the connection fails

#### Scenario: Keys stay out of the gateway log
- **WHEN** an upstream is stopped and a request with the service-role key gets `502`
- **THEN** the gateway's log contains neither API key

#### Scenario: Only Google can create a user
- **WHEN** the gateway's `/auth/v1/settings` is read with the anon key
- **THEN** it reports sign-up enabled, `google` as the only enabled external provider, and email,
  phone and anonymous sign-in disabled

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
    - `auth`'s networks are not exactly `db`, `supabase`, `auth-egress` and `auth-app`; a service
      other than `auth` joins `auth-egress`; the `auth-app` network's members are not exactly
      `auth` and the app service (dev `app`; stage and prod `api`); or the stage or prod `api`
      joins networks other than `back`, `catalog` and `auth-app`;
    - a Supabase service other than `supabase-gw` publishes a port, or `supabase-gw` publishes
      anything other than one `127.0.0.1` port mapped to its listener;
    - the `db`, `supabase`, `catalog` or `auth-app` network is not internal, does not isolate the
      host from it (no host address on the bridge), or is not on that environment's pinned subnet
      (`catalog`: prod `172.28.15.0/24`, stage `172.28.25.0/24`, dev `172.28.34.0/24`;
      `auth-app`: prod `172.28.17.0/24`, stage `172.28.28.0/24`, dev `172.28.36.0/24`); or the
      `edge` or `auth-egress` network is not on its pinned subnet (`auth-egress`: prod
      `172.28.16.0/24`, stage `172.28.27.0/24`, dev `172.28.35.0/24`);
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

#### Scenario: A second member of the auth egress network is caught
- **WHEN** `rest`, or the app service, is joined to the `auth-egress` network
- **THEN** `make check` exits non-zero and names invariant 16

#### Scenario: A third member of the auth-app network is caught
- **WHEN** `rest`, or the dev `companion`, is joined to the `auth-app` network
- **THEN** `make check` exits non-zero and names invariant 16

### Requirement: Stage coexists with prod; dev is disjoint by construction
The stage project SHALL be startable while the prod project runs on the same host. Stage's
subnets, `container_name`, volumes, and published ports SHALL differ from prod's. Dev uses
a single app subnet, and ports distinct from both. Each project's `db` network SHALL have its own
pinned subnet: `172.28.12.0/24` for prod, `172.28.22.0/24` for stage, and `172.28.31.0/24` for
dev. Each project's `supabase` network (pinned `172.28.13.0/24` prod, `172.28.23.0/24` stage,
`172.28.32.0/24` dev) and `edge` network (pinned `172.28.14.0/24` prod, `172.28.24.0/24` stage,
`172.28.33.0/24` dev), `auth-egress` network (pinned `172.28.16.0/24` prod, `172.28.27.0/24`
stage, `172.28.35.0/24` dev) and `auth-app` network (pinned `172.28.17.0/24` prod,
`172.28.28.0/24` stage, `172.28.36.0/24` dev) SHALL be its own. Its Postgres and Supabase storage volumes SHALL be
scoped to that project. Each environment's `SUPABASE_PORT` SHALL differ from every other
published port of every environment on the host.

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
- **AND** each has its own Supabase gateway on its own `SUPABASE_PORT`, and a request to one
  gateway never reaches the other environment's services

#### Scenario: Production router defaults unchanged
- **WHEN** the Caddyfile is adapted with neither gateway variable set
- **THEN** the adapted JSON equals the committed baseline (`make check` invariant 13), and
  `docker/scripts/test_router.sh stage` passes

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
network, whose only other member is `db`, and the two-member `auth-app` network, whose only
other member is `auth`; the gate SHALL refuse every connection whose source address is in the
dev `catalog` or `auth-app` subnet, and `make check` SHALL fail when the gate's refused subnets
differ from those two networks' subnets. The design SHALL record that this relies on
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

#### Scenario: The gate refuses the auth service
- **WHEN** a request to the gate's port comes from an address in the dev `auth-app` subnet
- **THEN** the gate refuses it, and the app never sees it
