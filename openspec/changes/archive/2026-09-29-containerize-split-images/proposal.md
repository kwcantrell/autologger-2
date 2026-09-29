## Why

AutoLogger has no container build. The live deployment (https://autologger.nrvo.ai, behind a
Pangolin proxy) runs `npm run build && npm run start`, where one Node process serves both the
API and the Next.js frontend through an in-process bridge. The owner wants a modular,
separation-of-concerns container layout — one container per logical unit — so that frontend
and backend can each be built and deployed on their own, and so that the frontend's static
assets can later move to a CDN. It also has to run on both `linux/amd64` and `linux/arm64`
hosts.

Putting the app behind Pangolin with a Companion bypass also exposes `API_TOKEN` to the
internet, and today that token is an all-`/api`, cross-team super-credential. This change
narrows it to the Companion surface (gate ruling G4).

## What Changes

- Add **two images built from one multistage Dockerfile** (`docker/Dockerfile`, with targets
  `web` and `api`, built via `docker-bake.hcl`), both from the repo root:
  - **`web`**: the Next.js frontend built with `output: 'standalone'`, running Next's
    standalone server. It contains no API code, no `better-sqlite3`, and no external
    binaries.
  - **`api`**: the existing server booted in its **already-specified API-only mode** (no
    `web/.next` in the image). The image also bundles the `claude` CLI, plus `yt-dlp` with a
    pinned `deno` JS runtime next to it (YouTube extraction needs it), so the
    configuration-gated features can be turned on. It runs as a non-root user, and its state
    lives on volumes.
- Add an **internal router** (Caddy) as a third compose service. It is the single upstream
  target for Pangolin and keeps one origin for the browser:
  - It sends `GET`/`HEAD` shell and asset requests to `web`.
  - It sends everything the in-process bridge answers with the server's own `404` to `api`:
    all `/api*` and `/auth*` traffic, non-GET requests, and trailing-slash paths.
  - It closes stray non-`/api` `Upgrade` requests with no response written, matching the
    server's socket destroy.
  - It matches the raw, escaped path case-sensitively, byte-for-byte like the server.
  - It neutralizes dot-segment and encoded-separator traversal (rewritten so the server
    answers `404`), and adds no response headers.
- Add a **`compose.yaml`** that wires `router` + `web` + `api`:
  - Only the router publishes a port, and only on host loopback (`127.0.0.1`). The host's
    Newt agent is Pangolin's path into that port.
  - `web` and `api` sit on separate networks.
  - Restart policies, healthchecks, `init`, log rotation, and git-SHA image tags.
- **`web/next.config.ts`**: add `output: 'standalone'` and set `outputFileTracingRoot` to the
  repo root. The existing single-process `npm run start` bridge path keeps working unchanged.
- **`server/package.json`**: move `tsx` from `devDependencies` to `dependencies`, so a
  production-only install can still boot the server the same way `npm run start` does
  today.
- **BREAKING — `API_TOKEN` is scoped to `/api/companion/*`.** Under `REQUIRE_LOGIN=1`, a
  request authenticated only by `API_TOKEN` is treated as unauthenticated everywhere else
  (`401 Login required.`), including other `/api/*` routes and the session WebSocket (also
  `role=companion`).
  - Deployed Companion modules only call `/api/companion/{state,categories,log,transport,
    command}` and are unaffected.
  - Headless scripts that used the token on other routes break, for example the README's
    `curl … /api/sessions` example.
- Add a **multi-arch build procedure** (buildx `docker-container` driver + QEMU,
  `--platform linux/amd64,linux/arm64`, pushed to private GHCR; the deploy host pulls with
  a `read:packages` PAT).
- Add a **Playwright `container` project** (`baseURL` is the router, no `webServer`). It
  re-runs `e2e/serving-contract.spec.ts` against the stack, plus a new
  `container-routing.spec.ts` covering:
  - a differential status/header matrix, router versus single-process server;
  - upgrades;
  - traversal;
  - the Companion token scope.
- Add a README **"Container deployment"** section covering:
  - the Pangolin resource and target setup, and the exact-path Companion bypass rules;
  - Google OAuth client setup;
  - required env and the volumes;
  - the WAL-safe `DATA_DIR` migration;
  - the `ADMIN_TOKEN` membership bootstrap;
  - backup, update, and rollback.

## Capabilities

### New Capabilities
- `container-deployment`: covers the following:
  - the `web` and `api` images: contents and exclusions, runtime user, pinned bases and
    binaries, and multi-arch builds;
  - the internal router's routing, disposition, path-semantics, and traversal rules;
  - the compose topology: loopback-only publishing, network segmentation, a single `api`
    replica, restart/health/logging;
  - the volumes;
  - the env the deployment must set behind a TLS-terminating proxy;
  - the container e2e project.

### Modified Capabilities
- `web-frontend-platform`: two changes.
  - The requirement "Next.js frontend served through the Hono bridge" is reframed as
    *one of two* supported serving topologies. The ADDED "Split-container serving topology"
    requirement pins that the router preserves the bridge's dispositions at the public
    origin.
  - The "Page requests pass through server middleware" guarantee is **not guaranteed** for
    shell/asset requests in the split topology. The deployment's upstream proxy (Pangolin
    SSO) gates them instead.
- `api-contract-freeze`: two ADDED requirements.
  - "API_TOKEN authenticates only the Companion surface" authorizes the `401` for
    token-only requests outside `/api/companion/*`.
  - "Traversal-shaped request targets are not normalized into inventory routes in the split
    topology" authorizes the traversal `404`.
- `core-ports-architecture`: MODIFIED requirement "Authentication and authorization are
  distinct, single seams". Its "API_TOKEN machine clients bypass studio membership" scenario
  is re-scoped to `/api/companion/*`.

## Contract impact

**Two intended changes, both authorized by the `api-contract-freeze` delta:**

- **BREAKING:** `API_TOKEN` no longer authenticates outside `/api/companion/*`.
- In the split topology, traversal-shaped request targets get `404` (see below).

Everything else at the public origin is intended to be unchanged:

- The browser still sees one origin.
- `/api/*`, `/auth/*`, and the session WebSocket are answered by the same server code.
- The router does not compress, buffer, re-encode, or add headers to them.
- Shell routes are answered by the same Next build.
- The pinned `404`s (outside the inventory, trailing slash, non-GET, unknown `/api`) are
  still produced by the server, because the router forwards those requests to it.
- The stray-upgrade socket close is preserved by the router's `abort`, which writes no
  response.

The traversal edge: raw URIs that contain a dot-segment, an empty segment, or an encoded
separator under `/api`/`/auth` are forwarded to `api` rewritten to a non-inventory path, so
the server answers `404`. The single-process server does not do this: it normalizes them
into a route. These URIs are outside the endpoint inventory. The `api-contract-freeze`
delta's traversal requirement authorizes the change.

## Non-Goals

- CDN wiring and `assetPrefix`. Both belong to the CDN change.
- Cross-origin frontend/API (CORS, `SameSite=None`, a configurable API base URL).
- API replicas or horizontal scaling. The single-process / on-disk invariant stands.
- Bundling the server to plain JS. `tsx` stays as the runtime.
- Running Newt inside compose. Newt runs on the host.
- A CI build/push workflow. The multi-arch build is a documented local procedure for now.
- Per-user Companion tokens, and any change to Pangolin itself.
- AI chat `--resume` surviving a process restart. Its bindings are in memory today, and
  that stays unchanged.
- Removing the in-process bridge. `npm run dev` and `npm run start` keep single-process
  serving.
- Packaging the Companion module.

## Impact

- **New files:**
  - `docker/Dockerfile`, `docker-bake.hcl`, `docker/Caddyfile`
  - `compose.yaml`, `docker/.env.example`, `.dockerignore`
  - `e2e/container-routing.spec.ts` and a `container` Playwright project
  - `server/scripts/copyDataDir.ts` (+ test) and a membership-bootstrap script template
  - README section
- **Modified:**
  - `web/next.config.ts` (standalone output, tracing root)
  - `server/package.json` + `package-lock.json` (`tsx` moves to `dependencies`)
  - `server/src/middleware/auth.ts` (token scope), plus tests
    including `server/src/routers/authz.int.test.ts`
  - README `API_TOKEN` docs and examples
- **Operational:**
  - Pangolin resource target → `127.0.0.1:<router port>`.
  - Pangolin Bypass-Auth rules on the 5 exact Companion paths.
  - A Google OAuth client is created.
  - `server/data` (17 GB, WAL) is migrated into the `api` volume.
  - Memberships are granted by a re-runnable `ADMIN_TOKEN` bootstrap script. It is
    rehearsed before cutover and re-run in the window after the final copy.
  - Companion installs are configured with `API_TOKEN`.
- **Security posture:**
  - Shell and asset requests are not guaranteed server IP-allowlist coverage in the split
    topology; Pangolin SSO covers them.
  - `API_TOKEN` exposure is narrowed to the Companion surface.
  - **AI chat, topics, and events run on the owner's subscription `~/.claude`**, by explicit
    owner ruling G5, which accepts the policy and cost risk the codebase flags.
  - The AI v2 `claude login` fallback is unavailable, because the container binds a
    non-loopback interface. AI v2 stays off in this deployment; enabling it would need
    `AI_V2_API_KEY`.
- **Image size:** `next` stays a declared server dependency (the bridge `require`s it lazily),
  so a production install puts it in the `api` image even though API-only mode never loads it.
  Accepted for now.
