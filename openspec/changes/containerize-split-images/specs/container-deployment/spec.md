## ADDED Requirements

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
percent-encoded, case-sensitive, with no dot-segment removal or slash merging. The rules
SHALL mirror, byte for byte, the path checks in the server's bridge. They SHALL be evaluated
in this order:
1. A request whose raw path has a segment that is `.` or `..`, or percent-decodes to `.` or
   `..` (any mix of `.`, `%2e` and `%2E`), or contains an empty segment (`//`), or (under
   `/api` or `/auth`) contains `%2f`, `%2F`, `%5c`, or `%5C`, SHALL be forwarded to `api`
   with its path replaced by a fixed path outside the inventory and outside `/api` and
   `/auth`. The server's own `404` then answers it (see the `api-contract-freeze` delta).
2. A request carrying an `Upgrade` header whose path is not `/api` or under `/api/` SHALL be
   aborted: the connection is closed with no HTTP response written.
3. Requests whose path is `/api`, `/auth`, or starts with `/api/` or `/auth/` SHALL go to
   `api`, WebSocket upgrades included.
4. Requests with a method other than `GET` or `HEAD` SHALL go to `api`.
5. Paths other than `/` that end in `/` SHALL go to `api`.
6. All remaining requests SHALL go to `web`.

The router SHALL NOT compress, recompress, cache, or buffer responses. It SHALL NOT add,
remove, or alter response headers, except for removing its own `Server` header.
`Content-Encoding`, `Content-Length`, `Vary`, `Content-Range`, and streamed
(`text/event-stream`, chunked) bodies SHALL pass through exactly as the upstream emitted
them.

#### Scenario: Shell served by web
- **WHEN** `GET /`, `GET /teams`, `GET /sessions/abc`, `GET /sessions/a%2Fb`, or
  `GET /admin/users` is sent to the router
- **THEN** the response is `200` with the index or admin shell HTML from `web`, with no
  `Set-Cookie`

#### Scenario: Differential parity with the single-process server
- **WHEN** the same request list is sent to a single-process server and to the router, both
  built from the same commit
- **AND** the list covers: `GET` and `HEAD` of every shell route; an RSC flight request for
  `/teams`; a `/_next/static/*` asset; `/static/fonts/*`; `/_next/image?url=…`;
  `/sessions`; `/sessions/a/b`; `/sessions/a%2F`; `/teams/`; `HEAD /teams/`; `/nope`;
  `POST /sessions/abc`; `GET /api/does-not-exist`; `GET /API/profile`
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
  `GET /api/companion/state/..%2Fsessions` is sent to the router with a valid `API_TOKEN`
- **THEN** the response is the server's own `404`, and no session or admin route handler
  runs

#### Scenario: API encoding passes through untouched
- **WHEN** a compressible `/api/*` response over the threshold is requested through the
  router with `Accept-Encoding: gzip`, and again without it
- **THEN** the gzipped and identity responses, and their headers, match what `api` returns
  when addressed directly

### Requirement: Compose topology is loopback-published, segmented, and operable
A `compose.yaml` SHALL define `router`, `web`, and `api` services, with these properties:

- **Host exposure:** only `router` SHALL publish a host port, bound to host loopback
  (`127.0.0.1`).
- **Network segmentation:** `web` and `api` SHALL be on separate networks, with only
  `router` joined to both.
- **Single replica:** `api` SHALL have a fixed `container_name`, so it cannot be scaled past
  one replica.
- **Volumes:** `api` SHALL mount persistent volumes for `DATA_DIR` and for the runtime
  user's home directory, which holds `~/.claude/` and `~/.claude.json`.
- **Secrets:** secrets SHALL come from an env file that is not tracked in git.
- **Posture:** `REQUIRE_LOGIN=1` SHALL be set in the compose `environment` block, not in the
  env file, so the env file cannot turn it off.
- **Operability:** every service SHALL have
  - a restart policy;
  - a healthcheck that needs no tools beyond the image's runtime (for `api`,
    `GET /api/profile`);
  - an init process;
  - bounded log rotation.
- **Image references:** images SHALL be referenced by explicit, git-SHA-derived tags, never
  `latest`.

#### Scenario: Only the router is reachable from the host
- **WHEN** the stack is up
- **THEN** the router answers on `127.0.0.1:<port>`, `web` and `api` have no host port
  bindings, and `web` cannot open a connection to `api`

#### Scenario: State survives recreation
- **WHEN** the `api` container is recreated from a new image tag
- **THEN** the catalog, sessions, blobs, `~/.claude/` credentials, and `~/.claude.json` written before
  recreation are still present

#### Scenario: A second api replica is refused
- **WHEN** `docker compose up --scale api=2` is run
- **THEN** compose refuses to create a second `api` container

### Requirement: Deployment behind a TLS-terminating proxy is configured explicitly
The compose defaults and deployment documentation SHALL set:
- `REQUIRE_LOGIN=1`;
- `PUBLIC_BASE_URL` to the public HTTPS origin;
- `COOKIE_SECURE=1`, set explicitly;
- `TRUST_PROXY=1`, with the router trusting forwarded headers only from a pinned compose
  subnet and sending `api` exactly one `X-Forwarded-For` value: the client address the
  router resolved.

The documentation SHALL state:
- that the upstream proxy's Companion bypass rules name exactly the five paths the Companion
  module calls (`/api/companion/state`, `/categories`, `/log`, `/transport`, `/command`),
  never wildcards;
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

### Requirement: Container e2e project
The Playwright configuration SHALL provide a `container` project that does all of the
following:
- targets a running stack via a router base URL, with no `webServer`;
- runs `e2e/serving-contract.spec.ts` against it;
- runs a container-routing suite covering the router scenarios above: the differential,
  stray-upgrade, session-WebSocket, traversal, and encoding-parity scenarios, plus the
  Companion token scope.

The project SHALL NOT run as part of the default `npm run e2e`. A failing case SHALL name the
request that diverged.

#### Scenario: Routing regression is caught
- **WHEN** the router is misconfigured so that `POST /sessions/abc` reaches `web`
- **THEN** the `container` project fails and names that request
