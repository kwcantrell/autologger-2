## MODIFIED Requirements

### Requirement: Two images built from one repository
The repository SHALL provide one multistage Dockerfile with a `web` target and an `api`
target. Both SHALL build from the repo root context. A third image, **`media-worker`**, SHALL
build from `docker/media-worker.Dockerfile` with the same root context; it SHALL contain the
`media-worker/` workspace's `src/**` and `package.json`, the workspace packages it imports
(`packages/domain`, `packages/storage`, `packages/transcription` and their `src/**` and
`package.json`) and their production dependencies, the Node runtime and a digest-pinned
`ffmpeg`, and SHALL NOT
contain `server/src/**`, `web/**`, the `claude` CLI, `yt-dlp`, `deno` or anything the list
below excludes. It SHALL be named `ghcr.io/kwcantrell/autologger-media-worker` and tagged
like the other two.

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

#### Scenario: media-worker image carries only the worker
- **WHEN** the `media-worker` image filesystem is listed
- **THEN** `ffmpeg` and `node` are present and no `server/src`, `web`, `claude`, `yt-dlp` or
  `deno` is

### Requirement: Images run as non-root on pinned bases, for two architectures
All three of this repository's images and the router image SHALL run as a non-root user, and
every base image SHALL be pinned by digest; the `media-worker` image SHALL run as a uid
different from the `api` image's, and its `ffmpeg` SHALL come from a digest-pinned image or a
checksum-pinned per-architecture download. The `api` image SHALL install the `claude` CLI at a pinned
version. It SHALL install pinned `yt-dlp` and `deno` binaries into one directory, verifying
each download against a pinned checksum for the target architecture. `deno` is the
JavaScript runtime yt-dlp needs for YouTube, and the server gives the yt-dlp child only its
own directory on `PATH`. All three images SHALL build for `linux/amd64` and `linux/arm64` by
the same `docker buildx bake` invocation, and every per-architecture choice SHALL key on the
build's target architecture.

Directories that back volumes SHALL exist in the image owned by the runtime user. The
`claude` CLI's auto-updater SHALL be disabled.

#### Scenario: Multi-arch build
- **WHEN** the images are built with `--platform linux/amd64,linux/arm64`
- **THEN** every platform variant builds. In each `api` variant, `better-sqlite3` loads,
  `claude --version` succeeds, and `yt-dlp` resolves the metadata of a known public video
  when run with the server's pinned child `PATH`; in each `media-worker` variant
  `ffmpeg -version` and `node --version` succeed and a fixture decodes to PCM.

#### Scenario: Non-root runtime
- **WHEN** any of the four containers is running
- **THEN** its main process's effective UID is not `0`, the `api` process can write to
  every mounted volume on first start, and the `media-worker` process can read `audio/` and
  write `media/` under the blob volume but cannot create a file under `audio/`

#### Scenario: Tampered binary download
- **WHEN** a downloaded `yt-dlp` or `deno` binary does not match its pinned checksum for the
  target architecture
- **THEN** the image build fails

### Requirement: Compose topology publishes only the router, segmented, and operable
A `compose.yaml` SHALL define `router`, `web`, `api` and `media-worker` services. The prod
project SHALL also include:
- a `db` service: Supabase Postgres;
- a `migrate` tool service, which `up` never starts. No prod target runs it;
- the Supabase Auth service `auth` (GoTrue), the only Supabase API service. No `rest`,
  `realtime`, `storage` or Supabase gateway service SHALL be defined.

`media-worker` (media-processing "The worker is sandboxed and computes only") SHALL run as a
non-zero uid different from `api`'s, with `read_only: true`, `cap_drop: [ALL]`,
`no-new-privileges`, a tmpfs `/tmp`, CPU, memory and pid limits, and SHALL join exactly one
network, `media`.

These properties SHALL hold:

- **Host exposure:** only `router` SHALL publish a host port, exactly one, bound to host
  loopback (`127.0.0.1`). `db`, `migrate` and `auth` SHALL publish no port, and no host process
  SHALL be able to connect to `db` directly. `auth` is reachable from the host only at its
  address on `auth-egress`, the network that gives GoTrue its way out; that residual SHALL be
  documented with the deployment's Supabase notes.
- **Network segmentation:** `web` and `api` SHALL be on separate networks, with only
  `router` joined to both. `db` and `migrate` SHALL be only on a `db` network. That network SHALL be
  internal (no route off the host), SHALL give the host no address on it (so no host process can
  connect to `db`), and SHALL be on a pinned subnet that no other project uses. Besides `db` and
  `migrate`, only `auth` SHALL join it. `db` SHALL also join a
  `catalog` network, internal and host-isolated in the same way and on its own pinned subnet,
  whose only other member SHALL be `api`: `api` reaches Postgres there as the catalog's client,
  connecting as the `autologger_app` role with `APP_DB_PASSWORD`, never with the superuser
  password. `auth` SHALL also join an `auth-app` network, internal and host-isolated in the same
  way and on its own pinned subnet, whose only other member SHALL be `api`: `api` reaches
  `auth` there for sign-in and holds no Supabase key. `auth` SHALL also join an `auth-egress`
  network, not internal, on its own pinned subnet, that no other service joins, so GoTrue can
  reach Google. `auth`'s networks SHALL be exactly `db`, `auth-egress` and `auth-app`. `db`
  SHALL also join a `media` network, internal and host-isolated in the same way and on its own
  pinned subnet (prod `172.28.18.0/24`), whose only other member SHALL be `media-worker`:
  the worker reaches Postgres there as the `autologger_media` role with `MEDIA_DB_PASSWORD`,
  never as `autologger_app` or the superuser. `db`'s networks SHALL be exactly `db`,
  `catalog` and `media`. No
  `supabase` or `edge` network SHALL be defined. The `db` network SHALL NOT be joined by
  `router`, `web`, `api` or `media-worker`, and `router`, `web` and `media-worker` SHALL NOT
  join `catalog`, `auth-app` or `auth-egress`.
- **Single replica:** `api` SHALL have a fixed `container_name`, so it cannot be scaled past
  one replica.
- **Volumes:** `api` SHALL mount persistent volumes for `DATA_DIR`, for `BLOB_DIR` (its own
  named volume at `/blobs`, holding the audio blobs, separate from the `DATA_DIR` volume so
  every server process can share it; `BLOB_DIR` is a literal in `api`'s `environment`, never an
  OpenBao value) and for the runtime user's home directory, which holds `~/.claude/` and
  `~/.claude.json`. `media-worker` SHALL mount the same `BLOB_DIR` volume at `/blobs` and no
  other volume; its write access is confined by file ownership to `media/` (the API creates
  `audio/` and `.tmp/` owned by its own uid, and `media/` sticky and world-writable). `db`
  SHALL keep its
  data directory and its `/etc/postgresql-custom` directory on named volumes. No Supabase
  storage volume SHALL be declared.
- **Secrets:** secrets SHALL come from the OpenBao `kv/autologger/prod` KV secret, read with the prod
  AppRole and injected into the compose process at start. No service SHALL use `env_file`.
  `api` SHALL receive only the
  variables named in a shared allowlist file, as null passthroughs, plus the catalog connection
  literals `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` and `PGPASSWORD` (`APP_DB_PASSWORD`).
  `media-worker` SHALL receive only the five connection literals with `PGUSER
  autologger_media` and `PGPASSWORD` (`MEDIA_DB_PASSWORD`) plus `BLOB_DIR`; it SHALL NOT use
  the shared allowlist file. `MEDIA_DB_PASSWORD` SHALL appear only in `media-worker` and
  `migrate`. Each Supabase
  secret's value SHALL appear only in the services that secret is allowed for. The superuser
  password SHALL appear only in `db` and `migrate`, never in `auth`. The retired Supabase keys
  (`ANON_KEY`, `SERVICE_ROLE_KEY`, `SECRET_KEY_BASE`, `REALTIME_DB_ENC_KEY`, `SUPABASE_PORT`)
  SHALL reach no service. No secret value SHALL appear in any tracked file.
- **Posture:** login is always required. No service's compose `environment` block SHALL set
  `REQUIRE_LOGIN`, and the shared allowlist file SHALL NOT list it. The server refuses to boot
  when it is set (see `web-frontend-platform` "Single-process development").
- **Operability:** every long-running service SHALL have
  - a restart policy;
  - a healthcheck that needs no tools beyond the image's runtime (for `api`,
    `GET /api/profile`; for `db`, `pg_isready`; for `auth`, its own `/health` endpoint; for
    `media-worker`, a `node` check of the heartbeat file its loop touches);
  - an init process;
  - bounded log rotation.

  A tool service that only runs on demand (`migrate`) SHALL have `restart: "no"`, an init
  process, and bounded log rotation. It needs no healthcheck.
- **Image references:** this repository's images SHALL be referenced by explicit,
  git-SHA-derived tags, never `latest`. Third-party images (the router,
  `db` and `auth`) SHALL be pinned by `@sha256:` digest.

#### Scenario: Only the router publishes a host port
- **WHEN** the stack is up
- **THEN** the router answers on `127.0.0.1:<port>`; `web`, `api`, `media-worker`, `db`,
  `migrate` and `auth` have no host port bindings; and `web` cannot open a connection to `api`

#### Scenario: Postgres is not reachable from the app or the host
- **WHEN** the prod configuration is resolved
- **THEN** `db` publishes no port, `db` is only on the internal `db`, `catalog` and `media`
  networks, and no service other than `db`, `migrate` and `auth` is on the `db` network; the
  app (`api`) reaches `db` only over the two-member `catalog` network, as `autologger_app`,
  never with the superuser password; `media-worker` reaches `db` only over the two-member
  `media` network, as `autologger_media`
- **AND** when the stack is up, a TCP connection from the host to the `db` container's address
  on port 5432 fails

#### Scenario: State survives recreation
- **WHEN** the `api` container is recreated from a new image tag
- **THEN** the catalog, sessions, the audio blobs in the `BLOB_DIR` volume, `~/.claude/`
  credentials, and `~/.claude.json` written before recreation are still present

#### Scenario: A second api replica is refused
- **WHEN** `docker compose up --scale api=2` is run
- **THEN** compose refuses to create a second `api` container

#### Scenario: Posture cannot be flipped from OpenBao
- **WHEN** the OpenBao `prod` KV secret sets `REQUIRE_LOGIN=0`
- **THEN** the compose target refuses the environment, naming `REQUIRE_LOGIN` as outside its
  allowed names, and starts nothing

#### Scenario: The Postgres password does not reach the app
- **WHEN** the prod configuration is resolved with `POSTGRES_PASSWORD` set
- **THEN** the value appears nowhere in `router`, `web`, `api` or `auth`, and `db` and
  `migrate` receive it

#### Scenario: The app's database password stays with the api
- **WHEN** the prod configuration is resolved with `APP_DB_PASSWORD` set
- **THEN** the value appears in `api` and `migrate` only, and `api`'s Postgres user is
  `autologger_app`

#### Scenario: The app reaches only the auth service among Supabase services
- **WHEN** the prod configuration is resolved
- **THEN** `api`'s networks are exactly `back`, `catalog` and `auth-app`; `auth-app`'s members are
  exactly `api` and `auth`; and `auth-egress`'s only member is `auth`

#### Scenario: The worker's database password stays with the worker
- **WHEN** the prod configuration is resolved with `MEDIA_DB_PASSWORD` set
- **THEN** the value appears in `media-worker` and `migrate` only, `media-worker`'s Postgres
  user is `autologger_media`, and `media-worker` carries no `APP_DB_PASSWORD`,
  `POSTGRES_PASSWORD` or allowlisted application variable

#### Scenario: The worker is confined
- **WHEN** the prod configuration is resolved
- **THEN** `media-worker`'s networks are exactly `media`, `media`'s members are exactly `db`
  and `media-worker`, `media-worker` publishes no port, runs read-only as a non-zero uid other
  than `api`'s with every capability dropped, and mounts only the blob volume
