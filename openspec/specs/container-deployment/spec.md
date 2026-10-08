# container-deployment Specification

## Purpose

How AutoLogger is packaged and deployed as split containers. This capability owns the two
images built from one repository (a `web` image carrying only Next's standalone frontend
server and an `api` image running the Hono server API-only), their non-root, pinned,
multi-arch build; the internal Caddy router that fronts both and preserves the
single-process server's per-request disposition matrix at one public origin; the compose
topology (loopback-published router, segmented networks, persistent state, single api
replica); the explicit configuration required behind a TLS-terminating proxy; and the
non-browser router test that guards the routing.

## Requirements

### Requirement: Two images built from one repository
The repository SHALL provide one multistage Dockerfile with a `web` target and an `api`
target. Both SHALL build from the repo root context.

The **`web`** image SHALL contain only the Next.js standalone server output for `web/`: the
traced standalone tree, `.next/static`, and `public/`. It SHALL NOT contain `server/src/**`,
`packages/**`, `better-sqlite3`, the `claude` CLI, `yt-dlp`, or `deno`.

The **`api`** image SHALL contain `server/src/**`, `server/package.json`, the workspace
packages' `src/**` and `package.json`, and their production dependencies, including `tsx`.
It SHALL NOT contain a `web/.next` directory, so the server boots in its specified API-only
mode.

Neither image SHALL contain any of the following:
- the `companion/` or `e2e/` workspaces;
- test files;
- any `.env` file other than `.env.example`;
- any `DATA_DIR` content, including `server/data` or `catalog.db`.

`.dockerignore` SHALL exclude these at every depth (`**/`-prefixed patterns), together with
`node_modules`, `.next`, and VCS metadata. Dockerfile `COPY` instructions SHALL name the
source paths above explicitly, never a whole workspace directory.

#### Scenario: api image boots API-only
- **WHEN** the `api` image starts with a valid environment
- **THEN** the server logs its API-only warning, `/api/*` and `/auth/*` respond normally, and
  `GET /` answered directly by the `api` container is `404`

#### Scenario: web image carries no backend
- **WHEN** the `web` image filesystem is listed
- **THEN** no `server/src`, `packages/`, `better-sqlite3` native binding, `claude`, `yt-dlp`,
  or `deno` is present

#### Scenario: Live data and secrets on the build host stay out of the images
- **WHEN** both images are built on a host whose checkout contains `server/data/catalog.db`
  and `server/.env`
- **THEN** neither image contains a file named `catalog.db`, a `server/data` directory, or
  any `.env` file other than `.env.example`, and no `~/.claude` credential is present

### Requirement: Images run as non-root on pinned bases, for two architectures
Both images and the router image SHALL run as a non-root user, and all three base images
SHALL be pinned by digest. The `api` image SHALL install the `claude` CLI at a pinned
version. It SHALL install pinned `yt-dlp` and `deno` binaries into one directory, verifying
each download against a pinned checksum for the target architecture. `deno` is the
JavaScript runtime yt-dlp needs for YouTube, and the server gives the yt-dlp child only its
own directory on `PATH`. Both images SHALL build for `linux/amd64` and `linux/arm64` from the
same Dockerfile, and every per-architecture choice SHALL key on the build's target
architecture.

Directories that back volumes SHALL exist in the image owned by the runtime user. The
`claude` CLI's auto-updater SHALL be disabled.

#### Scenario: Multi-arch build
- **WHEN** both images are built with `--platform linux/amd64,linux/arm64`
- **THEN** both platform variants build. In each `api` variant, `better-sqlite3` loads,
  `claude --version` succeeds, and `yt-dlp` resolves the metadata of a known public video
  when run with the server's pinned child `PATH`.

#### Scenario: Non-root runtime
- **WHEN** any of the three containers is running
- **THEN** its main process's effective UID is not `0`, and the `api` process can write to
  every mounted volume on first start

#### Scenario: Tampered binary download
- **WHEN** a downloaded `yt-dlp` or `deno` binary does not match its pinned checksum for the
  target architecture
- **THEN** the image build fails

### Requirement: Internal router preserves the single-origin disposition matrix
A router service SHALL front `web` and `api` and SHALL be the only service reachable from
outside the compose networks.

It SHALL evaluate every rule on the **raw request-target path exactly as received**: still
percent-encoded, case-sensitive, with no dot-segment removal or slash merging. Each rule
SHALL reproduce the path semantics of the server check it replaces:
- the `Upgrade` rule SHALL match `/api` literally on the raw path, as the server's upgrade
  dispatch does (it uses the undecoded WHATWG pathname);
- the `/api` and `/auth` HTTP rule SHALL also match percent-encoded forms of the prefix's
  letters (for example `/%61pi/x`), because the server's HTTP routing applies `decodeURI`
  and serves `/%61pi/x` as `/api/x`. It SHALL stay case-sensitive in the decoded letters
  (`/API/x` is not `/api`) and SHALL NOT decode `%2F`, which `decodeURI` also leaves
  encoded.

The rules SHALL be evaluated in this order:
1. A request whose raw path has a segment that is `.` or `..`, or percent-decodes to `.` or
   `..` (any mix of `.`, `%2e` and `%2E`), or contains an empty segment (`//`), or (under
   `/api` or `/auth`) contains `%2f`, `%2F`, `%5c`, or `%5C`, SHALL be forwarded to `api`
   with its path replaced by a fixed path outside the inventory and outside `/api` and
   `/auth`. The server's own `404` then answers it (see the `api-contract-freeze` delta).
2. An upgrade request (Node's definition: an `Upgrade` header together with a `Connection`
   header containing the `upgrade` token, case-insensitive) SHALL be aborted if its raw
   path is not literally `/api` or under `/api/`. Aborting closes the connection with no
   HTTP response written.
3. Requests whose path is `/api` or `/auth`, or starts with `/api/` or `/auth/`, SHALL go to
   `api`, WebSocket upgrades included. Prefix letters may be percent-encoded, per the HTTP
   rule above.
4. Requests with a method other than `GET` or `HEAD` SHALL go to `api`.
5. Paths other than `/` that end in `/` SHALL go to `api`.
6. All remaining requests SHALL go to `web`.

**Accepted fail-closed exceptions (owner ruling, archive gate, 2026-09-28).** Four
malformed request shapes are outside the endpoint inventory and never sent by the frontend or
Companion. For these shapes the router's answer is not required to match the single-process
server, but it SHALL NOT reach a handler the server would refuse:
- a `GET`/`HEAD` path containing a literal `\`: the server treats it as `/` and can serve
  it; the router sends it to `web`, which answers `404`;
- `OPTIONS *`: the server answers `400`; the router answers an empty `200`;
- an `/api` request line too large for the server's header limits: the server answers `431`;
  above roughly 60 KB the router can give an empty reply instead;
- an upgrade whose `/api` path contains dot-segments: the server can admit it; the router
  (traversal rule) answers `502` or `404`.

These are the only cases in which the router writes a response of its own. (An absolute-form
request target, `GET http://host/…`, is NOT an exception: it was measured to route exactly
like its origin-form equivalent.)

The router SHALL NOT compress, recompress, cache, or buffer responses. It SHALL NOT add,
remove, or alter response headers, except for removing the `Server` and `Via` headers it would otherwise add, and the
normal proxy handling of hop-by-hop headers (`Connection`, `Keep-Alive`) and header-name
case.
`Content-Encoding`, `Content-Length`, `Vary`, `Content-Range`, and streamed
(`text/event-stream`, chunked) bodies SHALL pass through exactly as the upstream emitted
them.

#### Scenario: Shell served by web
- **WHEN** `GET /`, `GET /teams`, `GET /sessions/abc`, or `GET /sessions/a%2Fb` is sent to
  the router
- **THEN** the response is `200` with the index shell HTML from `web`, with no `Set-Cookie`

#### Scenario: The retired admin page is not a shell path
- **WHEN** `GET /admin/users` is sent to the router
- **THEN** the response is `404` with the app's not-found page from `web`, and the
  `/api/admin/*` routes are unaffected

#### Scenario: Differential parity with the single-process server
- **WHEN** the same request list is sent to the router, and compared with the dispositions the
  single-process server gives for it (recorded in the router test's expectation table, last
  verified against a single-process server built from the same commit)
- **AND** the list covers: `GET` and `HEAD` of every shell route; an RSC flight request for
  `/teams`; a `/_next/static/*` asset; `/static/fonts/*`; `/_next/image?url=…`;
  `/sessions`; `/sessions/a/b`; `/sessions/a%2F`; `/teams/`; `HEAD /teams/`; `/nope`;
  `POST /sessions/abc`; `GET /api/does-not-exist`; `GET /API/profile`; `GET /%61pi/profile`
- **THEN** each pair has the same status and the same values (present or absent) for
  `Set-Cookie`, `X-Powered-By`, `Location`, `Content-Type`, `Vary`, and `Cache-Control`

#### Scenario: Stray upgrade writes nothing
- **WHEN** a WebSocket upgrade, or any other `Upgrade` request, is attempted through the
  router on `/teams`
- **THEN** the connection is closed with no HTTP status line received

#### Scenario: Session WebSocket upgrades through the router
- **WHEN** a signed-in browser opens `/api/sessions/<id>/ws?role=browser` through the router
- **THEN** the upgrade completes and live frames are delivered

#### Scenario: Traversal cannot reach a non-Companion route
- **WHEN** `GET /api/companion/%2e%2e/sessions/x`, `GET /api/companion/.%2E/admin/users`, or
  `GET /api/companion/state/..%2Fsessions` is sent to the router with a live Companion device
  token as a `Bearer`
- **THEN** the response is the server's own `404`, and no session or admin route handler
  runs

#### Scenario: API encoding passes through untouched
- **WHEN** a compressible `/api/*` response over the threshold is requested through the
  router with `Accept-Encoding: gzip`, and again without it
- **THEN** the gzipped and identity responses, and their headers, match what `api` returns
  when addressed directly

### Requirement: Compose topology is loopback-published, segmented, and operable
A `compose.yaml` SHALL define `router`, `web`, and `api` services. The prod project SHALL also
include:
- a `db` service: Supabase Postgres;
- a `migrate` tool service, which `up` never starts. No prod target runs it;
- the Supabase services `auth`, `rest`, `realtime` and `storage`;
- the Supabase gateway `supabase-gw`.

These properties SHALL hold:

- **Host exposure:** only `router` and `supabase-gw` SHALL publish a host port, each exactly
  one, bound to host loopback (`127.0.0.1`). No other Supabase service SHALL publish a port, and
  no host process SHALL be able to connect to one directly.
- **Network segmentation:** `web` and `api` SHALL be on separate networks, with only
  `router` joined to both. `db` and `migrate` SHALL be only on a `db` network. That network SHALL be
  internal (no route off the host), SHALL give the host no address on it (so no host process can
  connect to `db`), and SHALL be on a pinned subnet that no other project uses. Besides `db` and
  `migrate`, only `auth`, `rest`, `realtime` and `storage` SHALL join it. `db` SHALL also join a
  `catalog` network, internal and host-isolated in the same way and on its own pinned subnet,
  whose only other member SHALL be `api`: `api` reaches Postgres there as the catalog's client,
  connecting as the `autologger_app` role with `APP_DB_PASSWORD`, never with the superuser
  password. `auth` SHALL also join an `auth-app` network, internal and host-isolated in the same
  way and on its own pinned subnet, whose only other member SHALL be `api`: `api` reaches
  `auth` there for sign-in, holds no Supabase key, and reaches no other Supabase service. `auth`
  SHALL also join an `auth-egress` network, not internal, on its own pinned subnet, that no other
  service joins, so GoTrue can reach Google. A `supabase` network, internal and
  host-isolated in the same way and on its own pinned subnet, SHALL join `supabase-gw` to those
  four services and to nothing else. `supabase-gw` SHALL publish its port through an `edge`
  network that no other service joins. None of the `db`, `supabase` and `edge` networks SHALL be
  joined by `router`, `web` or `api`, and `router` and `web` SHALL NOT join `catalog`,
  `auth-app` or `auth-egress`.
- **Single replica:** `api` SHALL have a fixed `container_name`, so it cannot be scaled past
  one replica.
- **Volumes:** `api` SHALL mount persistent volumes for `DATA_DIR` and for the runtime
  user's home directory, which holds `~/.claude/` and `~/.claude.json`. `db` SHALL keep its
  data directory and its `/etc/postgresql-custom` directory on named volumes, and `storage` its
  objects on a named volume.
- **Secrets:** secrets SHALL come from the OpenBao `kv/autologger/prod` KV secret, read with the prod
  AppRole and injected into the compose process at start. No service SHALL use `env_file`.
  `api` SHALL receive only the
  variables named in a shared allowlist file, as null passthroughs, plus the catalog connection
  literals `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` and `PGPASSWORD` (`APP_DB_PASSWORD`). Each Supabase
  secret's value SHALL appear only in the services that secret is allowed for. The superuser
  password SHALL appear in no public-facing service (`auth`, `rest`, `storage`, `supabase-gw`). No secret value SHALL appear in any tracked file.
- **Posture:** login is always required. No service's compose `environment` block SHALL set
  `REQUIRE_LOGIN`, and the shared allowlist file SHALL NOT list it. The server refuses to boot
  when it is set (see `web-frontend-platform` "Single-process development").
- **Operability:** every long-running service SHALL have
  - a restart policy;
  - a healthcheck that needs no tools beyond the image's runtime (for `api`,
    `GET /api/profile`; for `db`, `pg_isready`; for each Supabase service, its own health
    endpoint);
  - an init process;
  - bounded log rotation.

  A tool service that only runs on demand (`migrate`) SHALL have `restart: "no"`, an init
  process, and bounded log rotation. It needs no healthcheck.
- **Image references:** this repository's images SHALL be referenced by explicit,
  git-SHA-derived tags, never `latest`. Third-party images (the router,
  `db` and every Supabase service) SHALL be pinned by `@sha256:` digest.

#### Scenario: Only the router is reachable from the host
- **WHEN** the stack is up
- **THEN** the router answers on `127.0.0.1:<port>`, and only `supabase-gw` besides it, on
  `127.0.0.1:<SUPABASE_PORT>`; `web`, `api`, `db` and the four Supabase services have no host
  port bindings; and `web` cannot open a connection to `api`

#### Scenario: Postgres is not reachable from the app or the host
- **WHEN** the prod configuration is resolved
- **THEN** `db` publishes no port, `db` is only on the internal `db` network, and no service
  other than `db`, `migrate` and the four Supabase services is on that network; the app (`api`)
  reaches `db` only over the two-member `catalog` network, as `autologger_app`, never with the
  superuser password
- **AND** when the stack is up, a TCP connection from the host to the `db` container's address
  on port 5432 fails

#### Scenario: State survives recreation
- **WHEN** the `api` container is recreated from a new image tag
- **THEN** the catalog, sessions, blobs, `~/.claude/` credentials, and `~/.claude.json` written before
  recreation are still present

#### Scenario: A second api replica is refused
- **WHEN** `docker compose up --scale api=2` is run
- **THEN** compose refuses to create a second `api` container

#### Scenario: Posture cannot be flipped from OpenBao
- **WHEN** the OpenBao `prod` KV secret sets `REQUIRE_LOGIN=0`
- **THEN** the compose target refuses the environment, naming `REQUIRE_LOGIN` as outside its
  allowed names, and starts nothing

#### Scenario: The Postgres password does not reach the app
- **WHEN** the prod configuration is resolved with `POSTGRES_PASSWORD` set
- **THEN** the value appears nowhere in `router`, `web`, `api`, `auth`, `rest`, `storage` or
  `supabase-gw`, and `db` receives it

#### Scenario: The app's database password stays with the api
- **WHEN** the prod configuration is resolved with `APP_DB_PASSWORD` set
- **THEN** the value appears in `api` and `migrate` only, and `api`'s Postgres user is
  `autologger_app`

#### Scenario: The app reaches only the auth service among Supabase services
- **WHEN** the prod configuration is resolved
- **THEN** `api`'s networks are exactly `back`, `catalog` and `auth-app`; `auth-app`'s members are
  exactly `api` and `auth`; and `auth-egress`'s only member is `auth`

### Requirement: Deployment behind a TLS-terminating proxy is configured explicitly
The compose defaults and deployment documentation SHALL set:
- `PUBLIC_BASE_URL` to the public HTTPS origin;
- `COOKIE_SECURE=1`, set explicitly;
- `TRUST_PROXY=1`, with the router trusting forwarded headers only from a pinned compose
  subnet and sending `api` exactly one `X-Forwarded-For` value: the client address the
  router resolved.

The documentation SHALL state:
- that the upstream proxy's Companion bypass rules name exactly the five paths the Companion
  module calls (`/api/companion/state`, `/categories`, `/log`, `/transport`, `/command`),
  never wildcards;
- that `API_TOKEN` is ignored since ADR 0021 slice 9d, and every Companion install must be given
  a device token from Settings › Companion devices after the deploy that ships it (re-pairing);
- that a Google OAuth client with redirect URI `${PUBLIC_BASE_URL}/auth/google/callback`
  must exist and be verified before cutover;
- that existing sessions and teams become visible to signed-in users only after memberships
  are granted via `ADMIN_TOKEN`;
- that AI chat, topics, and events use the mounted subscription credentials, which is the
  owner's accepted risk;
- that AI v2 needs `AI_V2_API_KEY`;
- that shell and asset requests are not guaranteed the server's `IP_ALLOWLIST` coverage in
  this topology;
- that any process on the host can reach the loopback port without passing through the
  upstream proxy;
- private-registry login for the deploy host;
- the WAL-safe backup, the minimal-downtime migration (pre-seed, then a final copy inside
  the window), update, and rollback procedures.

#### Scenario: Forged X-Forwarded-For is not adopted
- **WHEN** a client sends its own `X-Forwarded-For: 1.2.3.4` through the upstream proxy and
  the router
- **THEN** the server's resolved client IP is not `1.2.3.4`

#### Scenario: Session cookie is Secure
- **WHEN** a user completes Google sign-in through the public origin
- **THEN** the session cookie is set with `Secure`, and the OAuth redirect URI is
  `${PUBLIC_BASE_URL}/auth/google/callback`

### Requirement: Router behaviour is checked without a browser
A shell test, `docker/scripts/test_router.sh ENV`, SHALL exercise a running stack's router over
plain HTTP and raw TCP, and SHALL print case names and statuses only. It SHALL cover:
- the shell routes served by `web` with `200` and no `Set-Cookie`;
- the request list of "Differential parity with the single-process server", compared with a
  committed expectation table of status and header presence;
- stray upgrades closed with no bytes written, and the session WebSocket path still proxied;
- traversal to a non-Companion route with a live Companion device token, including a non-GET and
  a query string carrying a dot-segment;
- device-token scope: Companion state is allowed; sessions, admin routes and the browser-role
  WebSocket are handled as unauthenticated;
- `web` unable to connect to `api`, and the router's port unreachable on a non-loopback host
  address.

The device token SHALL be supplied to the script by the operator, created in the stack's
Settings › Companion devices, and SHALL be held only in the script's process environment, never
printed. It SHALL run against stage (`make stage-up`) by hand. CI has no docker.

#### Scenario: A router regression is caught
- **WHEN** the router is misconfigured so that `POST /sessions/abc` reaches `web`
- **THEN** `test_router.sh stage` fails and names that request

### Requirement: The Companion module authenticates with a device token kept as a secret
The Bitfocus Companion module in `companion/` SHALL authenticate with a Companion device token
(api-contract-freeze "Companion device tokens authenticate only the Companion surface"), sent as
`Authorization: Bearer <token>` on the five paths it calls
(`/api/companion/{state,categories,log,transport,command}`), which are unchanged, so the upstream
proxy's Companion bypass rules do not change. The module SHALL NOT post presence.

- **Secret field.** The token SHALL be a `secret-text` configuration field labelled "Device token
  (required)", so Companion keeps its value in its secrets store rather than in the plain
  connection config. The module SHALL read the token from its secrets on start and on every
  configuration update.
- **Upgrade.** The module SHALL ship one upgrade script: when a connection's plain config holds a
  non-empty `token` and its secrets hold none, the script SHALL move the value into the secrets and
  remove it from the plain config; otherwise it SHALL change nothing.
- **Status on 401.** A `401` from the server SHALL set the connection status to bad configuration
  with the message "Device token invalid or revoked: create one in AutoLogger Settings → Companion
  devices".
- **Help and version.** The module's help SHALL explain how to create a device token in Settings
  and that an install must be re-paired after the deploy that retires `API_TOKEN`, and the module
  version SHALL be bumped.

#### Scenario: An existing token is moved into secrets
- **WHEN** the upgrade script runs on a connection whose plain config holds `token: "abc"` and
  whose secrets hold no token, then on one whose secrets already hold a token, then on one with
  no token at all
- **THEN** the first comes out with the secret token `abc` and no plain `token`, and the other two
  are unchanged

#### Scenario: The module reads the token from secrets
- **WHEN** the module starts with a device token in its secrets and calls the server
- **THEN** each request carries `Authorization: Bearer <that token>`, and no token is read from
  the plain config

#### Scenario: A revoked token tells the operator what to do
- **WHEN** the server answers the module's state poll with `401`
- **THEN** the connection status is bad configuration with the device-token message naming
  Settings → Companion devices
