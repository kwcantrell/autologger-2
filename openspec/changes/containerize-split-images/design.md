## Context

Motivation is in `proposal.md`. This design turns the owner's grilling-session decisions into
a buildable topology: `router` (Caddy) → `web` (Next standalone) + `api` (server,
API-only), fronted by Pangolin through a host-side Newt tunnel.

### Current state, measured on `main` @ `13a6f2b`

Measured against the nouns the framing names (web, server, proxy, Companion, `DATA_DIR`,
the claude/yt-dlp integrations):

- **Next is embedded in the server process.** `server/src/node/nextFrontend.ts` builds Next
  with `next({dev, dir, …})`. `server/src/main.ts` resolves `webDir` as `../../web` relative
  to its own file and calls `createNextFrontend`. The `app.get('*')` bridge in
  `server/src/app.ts` hands unmatched GETs to Next.
- **API-only mode already exists.** `isApiOnly()` returns true when `<dir>/.next` is absent in
  production. `main.ts` then warns, and the bridge answers `404`. This is spec-pinned in
  `web-frontend-platform` → "API-only fallback mode and boot ordering".
- **The bridge pins these dispositions:**
  - Non-`/` trailing-slash paths → `404` (checked before Next).
  - Unmatched `/api*` and `/auth*` → Hono `404`.
  - Non-GET unmatched requests → `404`.
  - Stray non-`/api` upgrades are destroyed in production (`upgradeDispatch.ts`).
  - `ipAllowlistMiddleware` and `authContext` run before the bridge.
- **Web pages are client-island shells.**
  - `web/src/app/(index)/[[...path]]/page.page.tsx` is `force-dynamic` and validates its
    segments with `isShellSegments` → `notFound()`.
  - `web/src/app/(admin)/admin/users/page.page.tsx` is a static shell.
  - There are no route handlers, no `middleware.ts`, and no `NEXT_PUBLIC_*` variables.
  - `web/next.config.ts` has no `output` setting.
  - The spec requires that the Next graph never include `server/src/**` or `packages/**`.
- **The frontend is same-origin.** `API_ROOT = '/api'` (`web/src/api/client.ts`). The
  WebSocket URL is built from `location.host`. There is no CORS anywhere in `server/src`.
- **Server runtime.**
  - Start command: `NODE_ENV=production tsx --env-file-if-exists=.env src/main.ts`.
  - `tsx` is a server devDependency.
  - `next` is a server dependency, required lazily.
  - `better-sqlite3` is a native dependency.
  - `packages/*` are source-only TypeScript (their `exports` point at `src/*.ts`).
- **Subprocesses.**
  - The `claude` CLI is launched via `CLAUDE_CLI_PATH`. It connects back to a loopback,
    port-0 MCP HTTP server (`packages/ai-runtime/src/aiMcpServer.ts`), so it must share the
    `api` network namespace.
  - The claude-agent-sdk platform binaries.
  - `yt-dlp` is launched via `YTDLP_PATH` or a `PATH` lookup. It selects a single
    `bestaudio` format (no `-x`, no merge), and its child `PATH` is pinned to its own
    directory (`ytdlp.ts:144`). *(An earlier draft claimed ffmpeg was used; the panel
    falsified that.)*
- **State on disk.**
  - `DATA_DIR`: `catalog.db`, `sessions/`, `blobs/`, `tmp/`.
  - `os.tmpdir()/autologger-ai-chat-cwd/<sessionId>`, recreated per turn. `--resume`
    bindings are an in-memory `Map` (`ai.ts:87`), so they never survive a restart.
  - `$HOME/.claude`.
- **Companion.** `companion/src/api.ts` calls only `/api/companion/{state,categories,log,
  transport,command}` over HTTP with `Authorization: Bearer <API_TOKEN>`. It opens no
  WebSocket. The server also mounts `/api/companion/commands/wait` and
  `/api/companion/commands/:commandId/ack` (`server/src/routers/companion.ts`).
- **Proxy (measured live, 2026-09-28).** `https://autologger.nrvo.ai/`, `/api/me`, and
  `/teams/` all return `302` to `pangolin.cantrell-systems.com/auth/resource/…`: Pangolin SSO
  fronts every path. The Pangolin resource rules docs list Path, IP, CIDR, Country, Region,
  and ASN as match criteria; there is no header matching. `*` matches a single path segment.
  Open bug fosrl/pangolin#2294 (v1.14.1): multiple targets on one domain load-balance and
  ignore path rules.
- **Build host.** This host is arm64, runs Docker 29.6.2, and its buildx default driver
  supports `linux/arm64` only. Neither an autologger process nor a Newt process runs here.
  The live server runs on a **different machine** (owner, 2026-09-28).
- There is no existing Dockerfile, `.dockerignore`, or compose file.
- **Live deployment posture (owner-reported, 2026-09-28).** `REQUIRE_LOGIN=0`, no
  `IP_ALLOWLIST`, and `TRUST_PROXY` unset: Pangolin SSO is today's only access control. A 17 GB
  point-in-time copy of the live `DATA_DIR` (WAL mode) now sits on this host at
  `server/data`. The copy is finished, but the live server on the other machine keeps
  writing, so this copy is the **pre-seed source only**.
- **Consequence, measured in `server/src/env.ts` and `server/src/middleware/auth.ts`.**
  - When `REQUIRE_LOGIN=0`, `authContext` never evaluates `apiRequestRequiresLogin`, so
    `/api/companion/*` accepts requests **with no token at all**.
  - `openNetworkRefused` returns true when login is off, no allowlist is set, and the bind
    is non-loopback. A container must bind `0.0.0.0`, so under today's posture every
    paid/outbound feature (AI chat, AI v2, YouTube import, Sheets import) refuses to run.

No contradiction between these measurements and the owner's framing was found. One premise was
refined: the owner assumed a split needs substantial rework. The measurement shows that the
backend half already exists (API-only mode).

## Goals / Non-Goals

**Goals:**
- Two images (`web` and `api`) that can be built, versioned, and deployed independently,
  each one a logical unit with a single concern. "Ownership" means modularity and
  separation of concerns — not separate repos or lockfiles; both images build from the one
  workspace lockfile.
- Preserve the frozen contract at the public origin, except for the one gate-authorized
  delta: the `API_TOKEN` scope (G4). Also authorized: the traversal-`404` edge, which is
  confined to the split topology.
- Multi-arch builds (`linux/amd64` and `linux/arm64`) from one Dockerfile.
- Routing that lives in the repo and is testable, independent of the Pangolin version.
- State survives image upgrades; the stack is operable on day one (health, restart, logs,
  backup, rollback).

**Non-Goals:** as listed in `proposal.md`.

## Decisions

### D1. Split into `web` + `api`, keep the in-process bridge
The `web` image runs Next's standalone server. The `api` image runs the unchanged server with
no `web/.next`, so it boots API-only. The bridge stays for `npm run dev` and `npm run start`.
- *Alternative: a single image (bridge serving everything).* This is the simplest option and
  needs no spec delta. The owner rejected it: it gives neither independent deploys nor
  separation of concerns.
- *Alternative: static export (`output: 'export'`) served by nginx or a CDN.* This would put
  the HTML on a real CDN, but it is rejected for now for two reasons:
  - The `[[...path]]` catch-all would have to be rebuilt as an SPA fallback, because session
    ids can't be enumerated statically.
  - The host's rewrite rules would have to re-encode the shell set to keep the pinned `404`s.

  It remains a follow-up.
- *Alternative: remove the bridge entirely.* Rejected. The "Single-process development"
  requirement and the current `npm run start` path both depend on it.

### D2. A hardened internal Caddy router (gate ruling G1: Caddy, not api-as-router)
The router is Pangolin's only target. It evaluates these rules in order, on the **raw,
escaped, case-sensitive** request path (`container-deployment` spec):
1. Traversal-shaped targets are **rewritten** to a fixed non-inventory path
   (`/__autologger_rejected`) and proxied to `api`, so the server's own `404` answers them.
   "Traversal-shaped" means any of:
   - a `.`/`..` segment in any encoding;
   - an empty segment;
   - an encoded `/` or `\` under `/api` or `/auth`.
2. An `Upgrade` request outside `/api` → `abort`. The connection closes with no response
   written, which reproduces the server's socket destroy.
3. `/api`, `/api/…`, `/auth`, `/auth/…` → `api`.
4. Non-GET/HEAD → `api`.
5. Trailing slash (not `/`) → `api`.
6. Everything else → `web`.

The key move: every `404` the bridge pins today is still produced **by the server**. The
router writes no response of its own, and `abort` writes nothing at all.

**Why raw, case-sensitive matching.** Caddy's default `path` matcher decodes the path,
cleans it, and ignores case. Hono's `c.req.path` does none of those things.
- The panel's cases that would flip layers under the default matcher:
  - `/sessions/a%2F`: `200` → `404`;
  - `/API/x`;
  - `%2e%2e` traversal.
- So every rule uses an `expression`/regexp matcher on the escaped request path.
  - The placeholder to use (e.g. `{http.request.orig_uri.path}` versus an escaped-path
    variant) is **confirmed by a spike at apply time**.
  - The differential e2e pins the result.
  - If no placeholder exposes the raw path, the spike stops the phase, and the choice
    returns to the owner as a re-gate (Risks).

**Why rule 1 rewrites instead of responding.**
- `respond 404` would be a router-authored `404`. For non-GET methods, the spec says "the
  server's own `404`".
- Rewriting to an `/api` path would hit `authContext`'s `401` first.
- A non-`/api`, non-`/auth` path lands in the API-only bridge's `notFound()` for every
  method.

Why rule 1 exists: WHATWG URL normalization turns `/api/companion/%2e%2e/sessions/x` into
`/api/sessions/x`, which would let an SSO-bypassed Companion path reach any route.

- *Alternative (G1b): api-as-router.* The API-only bridge would stream non-API GETs to
  `web`. The owner rejected it: it puts proxy code on the frozen server surface, makes `api`
  a single point of failure for `web`, and weakens separation.
- *Alternative: Pangolin path-based targets.* Rejected. They are affected by fosrl/pangolin#2294,
  and the routing would live outside the repo.
- *Alternative: Next `rewrites` proxying to `api`.* Rejected. WebSocket upgrades are
  unreliable through them, and the module-graph separation rule forbids it.
- *Router choice: Caddy over nginx.* Caddy has:
  - a compact config;
  - native WebSocket support;
  - immediate flush for `text/event-stream`;
  - `abort`;
  - `trusted_proxies`.

  `auto_https off`, because Pangolin terminates TLS.
- *Invariants a future reader must not "helpfully" undo:*
  - **no `encode` directive** anywhere, because `/api` compression is server-owned
    (`api-contract-freeze`);
  - **`-Server` header removal**, so the router adds no headers;
  - **no switch back to the default `path` matcher**.

### D3. Keep `tsx` as the `api` runtime by moving it to `dependencies`
Moving `tsx` to `dependencies` means `npm ci --omit=dev` keeps it. The container invokes it
by absolute path (`/app/node_modules/.bin/tsx`), because it is hoisted to the root and is not
on `PATH`. `esbuild` and its `@esbuild/*` platform packages were dev-only in the lockfile. They become
production-kept together with `tsx` (apply, task 3.3: 29 `dev` flags removed).
- *Alternative: bundle the server with esbuild.* Rejected for now. The resolution risk is
  real: source-only `packages/*` exports, the SDK binary lookup, and the native
  `better-sqlite3`.
- *Alternative: install devDependencies at runtime.* Rejected. `vitest` and `typescript`
  would ship in the production image.

### D4. Base image `node:22-bookworm-slim`, pinned by digest
The image needs glibc: `better-sqlite3` prebuilds and the SDK's glibc binaries depend on it.
Build stages add `python3 make g++` only as the node-gyp fallback. The Caddy image is also
pinned by digest.

### D5. One Dockerfile, two targets, built with bake
`docker/Dockerfile` has stages `deps` → `web-build` → `web`, and `deps` → `api-deps` → `api`.
`docker-bake.hcl` builds both targets for both platforms and tags each with
`ghcr.io/<owner>/autologger-{web,api}:<git-sha>`. The two targets share the `deps` stage, the
digest pins, and the build cache, while still producing independent images.
- `deps`: runs `npm ci` over the root plus the `server`, `web`, and `packages/*`
  workspaces. `e2e` is not a workspace. `companion` is excluded via workspace flags, with a
  full `npm ci` as the build-stage-only fallback if the flags turn out to be unreliable.
- `web-build`: `next build` with `NEXT_TELEMETRY_DISABLED=1`. It produces
  `web/.next/standalone`.
- `web`: the standalone tree plus `.next/static` and `public`, run as `USER node` with
  `node web/server.js`, `HOSTNAME=0.0.0.0` and `PORT=3000`.
- `api-deps`: `npm ci --omit=dev` for `server` and `packages/*`.
- `api`: builds the runtime image as follows.
  - **Explicit COPYs only:** `server/src`, `server/package.json`, `server/tsconfig.json`,
    `packages/*/src` and `packages/*/package.json`, plus the pruned `node_modules`. It never
    copies the whole `server/` directory; that is the panel's blocker #1 (`server/data` is
    17 GB of live data and `server/.env` holds secrets).
  - **`yt-dlp` + `deno`:** the upstream standalone binaries chosen by `TARGETARCH`, pinned,
    `sha256sum -c`-verified, and installed into **one directory** (`/opt/ytdlp/`). The
    server pins the yt-dlp child's `PATH` to `dirname(yt-dlp)` (`ytdlp.ts:144`), and
    YouTube extraction needs a JS runtime on that `PATH`.
  - **No ffmpeg.** The server's invocation selects a single `bestaudio` format, without
    `-x` and without merging.
  - **`claude`:** `npm i -g @anthropic-ai/claude-code@<pinned>`.
  - **Runtime:** `USER node`, `WORKDIR /app/server`, and
    `CMD ["/app/node_modules/.bin/tsx", "src/main.ts"]`.
  - **Environment:** `NODE_ENV=production`, `DATA_DIR=/data`, `HOST=0.0.0.0`, `PORT=8787`,
    `YTDLP_PATH=/opt/ytdlp/yt-dlp`, `CLAUDE_CLI_PATH`.
  - **Volume mount points** are pre-created and owned by `node`.

### D6. Volumes and persistence
The `api` service has two named volumes:
- `/data`, used as `DATA_DIR`.
- `/home/node`, the whole home directory. It holds both `~/.claude/` and `~/.claude.json`,
  and the CLI's config lives in both places. The owner ruled for subscription auth (G5).
  `DISABLE_AUTOUPDATER` is set in `~/.claude/settings.json` `env`, because the server's CLI
  child env strips unlisted variables.

There is **no `TMPDIR` volume**. The panel falsified the D6 premise: `--resume` bindings
live in an in-memory `Map` (`ai.ts:87`), so they don't survive a process restart whatever is
on disk, and the cwd is re-created on every turn.
- *Alternative: persist resume bindings.* Out of scope, and listed as a non-goal.

### D7. Proxy-facing configuration (Pangolin → Newt → router → api)
- The router publishes `127.0.0.1:${ROUTER_PORT:-8080}`. The host Newt targets it.
- Networks: `front` (router + web) and `back` (router + api). `web` cannot reach `api`.
  - The `back` subnet is pinned with `ipam`, so `trusted_proxies` is stable.
  - Caddy trusts forwarded headers only from the pinned gateway, via
    `trusted_proxies_strict`, and sends `header_up X-Forwarded-For {client_ip}`. `api`
    therefore sees exactly one value.
  - **Apply-time verification:** a forged `X-Forwarded-For` sent through Pangolin is not
    adopted.
- `api` settings:
  - `TRUST_PROXY=1`.
  - `COOKIE_SECURE=1`.
  - `PUBLIC_BASE_URL=https://autologger.nrvo.ai`.
  - `REQUIRE_LOGIN=1` in the compose `environment` block (E1), so the env file can't flip
    it.
- Companion: Pangolin **Bypass Auth** rules on exactly
  `/api/companion/{state,categories,log,transport,command}` (G3). No wildcards. `API_TOKEN`
  guards them, and after D10 it guards only them.

### D8. Multi-arch build procedure
A buildx `docker-container` builder with binfmt/QEMU runs
`docker buildx bake --push` for `linux/amd64` and `linux/arm64` to **private** GHCR
(`ghcr.io/kwcantrell/autologger-{web,api}`; Q2). Pushing needs a `write:packages` PAT, and
the deploy host pulls with a `read:packages` PAT via `docker login ghcr.io`. Local compose
builds for the native architecture. CI automation is a follow-up.

### D9. Standalone output in `next.config.ts`
Add `output: 'standalone'` and `outputFileTracingRoot: <repo root>`. The root is needed
because the workspace hoists `node_modules`. **No `assetPrefix`.** The panel found it YAGNI,
and an ambient `ASSET_PREFIX` would silently change single-process builds. It belongs to
the CDN change. Standalone output only *adds* `.next/standalone`, and the bridge still reads
`.next` in place. e2e pins this.

### D10. Scope `API_TOKEN` to `/api/companion/*` (gate ruling G4)
In `authContext`, `apiTokenAuth` becomes
`requestHasValidApiToken(...) && path.startsWith('/api/companion/')`, with the path taken
from the same `URL(c.req.url).pathname` the login gate uses. Everything that reads
`apiTokenAuth` then sees `false` outside the Companion surface:
- the login gate;
- `requireSession`'s membership bypass;
- the AI v2 principal-less refusal.

There is still exactly one authentication decision, in middleware, which keeps the
`core-ports-architecture` single-seam requirement intact.
- The session WebSocket upgrade path authenticates through the same middleware, so
  token-only upgrades are refused. That includes `role=companion`, which no in-repo client
  uses.
- *Alternative: enforce scope only at Pangolin.* Rejected. Host-local callers and a future
  proxy misconfiguration would still hold a cross-tenant super-credential.
- *Alternative: per-route policy.* Deferred, as the core-ports spec already records.
- **Tests:**
  - characterize the current token behaviour first: `authz.int.test.ts` already exercises
    the bearer;
  - then pin the new scope scenarios: companion `200`, `/api/sessions` `401`, WS refused,
    AI v2 inert under `REQUIRE_LOGIN=0`.

### D11. Day-2 operations
- **Every service:** `restart: unless-stopped`, `init: true`, and json-file logging with
  `max-size`/`max-file`.
- **Healthchecks** (node one-liners; the images have no curl):
  - `api`: `fetch('http://127.0.0.1:8787/api/profile')`.
  - `web`: `fetch('http://127.0.0.1:3000/')`.
  - `router`: Caddy's own endpoint.
- **Image pinning:** `api` has a fixed `container_name`, which blocks `--scale`. Images are
  pinned by `WEB_TAG`/`API_TAG` in the compose `.env`, never `latest`.
- **Update order:** `api`, then `web`.
- **Backup:** online, using `server/scripts/copyDataDir.ts` (task 7.3), which calls
  `better-sqlite3`'s `db.backup()`. The script runs **from the repo checkout on the host**,
  where `tsx` and `better-sqlite3` are installed, against the volume's host path. It is not
  in the image, and D5's explicit COPY list stays unchanged. Blobs are copied with
  `rsync`.
- **Rollback:**
  - an image rollback is safe only if no migration ran, because migrations are
    forward-only (`packages/storage/src/migrate.ts`);
  - repointing Pangolin at the old host drops every write made since cutover.

### D12. Container e2e instead of a shell smoke
Add a Playwright `container` project (`baseURL: process.env.ROUTER_URL`, no `webServer`,
excluded from the default run). It runs `serving-contract.spec.ts` and a new
`container-routing.spec.ts`. The new spec covers:
- the differential matrix against a single-process server from the same commit;
- raw-socket upgrade checks;
- traversal;
- encoding parity through a throwaway curl container on the `back` network;
- the token scope.

The panel's rationale: this reuses maintained assertions and avoids curl-less images. The
SSE-incrementality smoke is dropped, because it costs money when AI is configured and is
pinned by configuration instead.

## Risks / Trade-offs

- **Caddy may not expose the raw escaped path to matchers.** → An apply-time spike (task
  5.1) confirms it before any router config lands. If it fails, the phase stops and G1 goes
  back to the owner (api-as-router or an nginx `$request_uri` router).
- **Shell and asset requests are not guaranteed `IP_ALLOWLIST` coverage in split mode.** →
  Pangolin SSO fronts them, and they carry no data. The owner does not use `IP_ALLOWLIST`
  today.
- **The `API_TOKEN` scoping breaks headless scripts** that used it outside Companion (the
  README example). → This is an authorized delta; the README is updated.
- **Subscription `~/.claude` used for multi-user AI.** → Accepted by owner ruling G5, and
  recorded in the README.
- **The AI v2 login fallback is loopback-only.** → AI v2 stays off in this deployment (owner,
  2026-09-28). Enabling it later would need `AI_V2_API_KEY`.
- **Version skew between `web` and `api`.** → The contract is frozen. Deploy `api` first.
- **A pinned `yt-dlp`/`deno` goes stale as YouTube changes.** → Rebuild with bumped pins;
  the README says so.
- **The QEMU amd64 build is slow.** → `better-sqlite3` uses prebuilds, and cache mounts help.
- **The `api` image carries the unused `next`.** → Accepted.
- **Host-local processes can reach `127.0.0.1:${ROUTER_PORT}` without SSO.** → The host is
  single-tenant; this is documented. Docker 29 blocks LAN access to loopback-published
  ports.

## Migration Plan

Minimal-downtime cutover (owner ruling, 2026-09-28). The volume is seeded while the old
server keeps running. Only the final SQLite copy and the blob delta happen inside the
maintenance window.

1. **Preconditions:**
   - The Google OAuth client exists with redirect URI
     `https://autologger.nrvo.ai/auth/google/callback`, and every intended user is listed if
     its consent screen is in Testing mode.
   - The compose `.env` is filled in: Google creds, a `API_TOKEN` of at least 32 bytes,
     `ADMIN_TOKEN`, and `DEEPGRAM_API_KEY`. No `AI_V2_API_KEY`: AI v2 stays off.
   - The images are pushed to **private** GHCR and their tags are pinned. This host has run
     `docker login ghcr.io` with a `read:packages` PAT.
2. **Pre-seed from `server/data` on this host (no downtime; the old server keeps running
   elsewhere):**
   - Copy `blobs/` into the `/data` volume.
   - Use `copyDataDir.ts` to make a WAL-safe copy of **every** `*.db` (the catalog and each
     `sessions/*.db`) into the volume.
   - Copy `~/.claude` and `~/.claude.json` into the `/home/node` volume.
   - Set ownership to UID 1000.
3. **Pre-flight on loopback, against the seeded copy:**
   - Run `docker compose up -d`, then the `container` e2e project, then a Google sign-in on
     `127.0.0.1:${ROUTER_PORT}`.
   - **Rehearse the membership bootstrap (G6) as a script.** It inspects users, memberships,
     and studio-less sessions, then grants via the `ADMIN_TOKEN` endpoints. It must be a
     re-runnable script, because step 4 replaces the catalog and its grants.
4. **Cutover window (downtime starts):**
   1. Stop the old server **on the other machine**, and run `docker compose stop api`.
   2. On the old host, run `copyDataDir.ts` from its checkout against its live `DATA_DIR`
      into a staging directory. That gives a WAL-safe copy of every `*.db` with integrity and
      row-count checks. `rsync` the staging directory here, overwriting the seeded DB copies
      in the volume.
   3. Run `rsync --delete` on `blobs/` from the old host, which transfers only the delta and
      mirrors deletions.
   4. Run `PRAGMA integrity_check` on every DB copy, and compare per-table row counts with
      the source.
   5. Run `docker compose up -d api`.
   6. Re-run the membership bootstrap script.
   7. Repoint the Pangolin target to Newt → `127.0.0.1:${ROUTER_PORT}`.
   8. Add the 5 exact-path Companion bypass rules.
   9. Reconfigure the Companion installs with `API_TOKEN`.

   Downtime ends.
5. **Verify from outside:**
   - the OAuth round trip;
   - Companion `state`, `log` and `command`;
   - traversal through a bypass path returns `404`;
   - a non-Companion `/api` path returns the SSO `302`;
   - a live session WebSocket;
   - a forged `X-Forwarded-For` is not adopted.
6. **Rollback:**
   - Repoint Pangolin at the old host. Writes made after cutover exist only in the volume.
   - An image rollback is safe only across releases with no migration in between.

## Open Questions

- **Q1: resolved (owner, 2026-09-28).** The live server runs on another machine.
  `server/data` on this host is a finished pre-seed copy. The old host's name and its
  `DATA_DIR` path are needed only in the cutover window (owner-supplied at task 8.3), not for
  implementation.
- **Q2: resolved (owner, 2026-09-28).** Private GHCR (`ghcr.io/kwcantrell/autologger-{web,api}`).
  The deploy host runs `docker login ghcr.io` with a `read:packages` PAT.
- None open.

## Panel & review log

- *Fact-check pass:* not run. This is a code change, and CLAUDE.md limits the pre-panel
  fact-check to process changes.
- **Panel, 2026-09-28.** Four opus reviewers (requirements, assumptions, failure & abuse,
  scope & simpler design) read proposal + specs + design. The orchestrator spot-checked the
  load-bearing code claims:
  - `ai.ts:87`: `issuedClaudeSessionIds` is an in-memory Map.
  - `ytdlp.ts:144`: the child `PATH` is pinned to yt-dlp's own directory; no `-x`.
  - `companion/src/api.ts`: only 5 routes are called; `/presence` is called by `web`.
  - `aiChatRunner.ts:84`: the CLI child env passthrough excludes `ANTHROPIC_API_KEY`.
  - `server/data` on this host is 17 GB, with live `-wal`/`-shm` files.

  Findings are deduplicated below. Findings from more than one reviewer are marked ×n.

### Blockers/majors to fix in place (folded into all four artifacts after the gate)
1. **`.dockerignore` is root-anchored** (×2, blocker). `data/` and `.env*` don't match
   `server/data` (17 GB of live data) or `server/.env`, so data and secrets would be baked
   into the image and pushed to GHCR.
   → Use `**/data`, `**/.data*`, `**/.env*` with `!**/.env.example`, `**/node_modules`,
   and `**/.next`. COPY only `server/{src,package.json,tsconfig.json}` and
   `packages/*/{src,package.json}`. Add an assertion that neither image contains
   `catalog.db`, `.env`, or `server/data`.
2. **The stray non-`/api` upgrade gets a proxy `502`, not a destroyed socket** (requirements).
   This would break api-contract-freeze "Stray-path upgrade disposition".
   → For any request with an `Upgrade` header outside `/api`, Caddy uses `abort`, which
   closes the connection with no response. The spec pins "no HTTP response is written". D2's
   "router never authors a response" becomes "…except `abort`, which writes nothing".
3. **Router path semantics are unspecified** (requirements). Caddy matchers are
   case-insensitive and work on the decoded path, while Hono is case-sensitive and works on
   the raw path. So `/sessions/a%2F` flips to `404`.
   → The rules match the **escaped, raw** path **case-sensitively**, mirroring the `app.ts`
   checks byte for byte. Add scenarios for `/sessions/a%2Fb` → 200 and `/sessions/a%2F`
   parity.
4. **Traversal through the Companion bypass** (failure, blocker). WHATWG normalization turns
   `/api/companion/%2e%2e/sessions/x` into `/api/sessions/x`, so a wildcard bypass rule
   exposes every `/api` route without SSO.
   → The router rejects any raw URI containing a dot-segment (`/.`, `%2e` in any case),
   `%2f`/`%5c` inside `/api*` or `/auth*`, or `//`. The Pangolin rules become **exact paths
   for the 5 routes Companion calls**, not wildcards (see G3). An external smoke case covers
   traversal.
5. **The disposition matrix is incomplete** (requirements). Missing: HEAD, RSC/flight,
   `/_next/image`, `public/` files, `/sessions`, `/sessions/a/b`, `X-Powered-By`,
   `Set-Cookie` on 404s.
   → Add a **differential** scenario: the same request list goes to the single-process server
   and to the router, and status plus named headers must match. The router also strips
   `Server` and adds no response headers.
6. **Rule 2 matched only WebSocket upgrades** → it now matches any `Upgrade` header.
7. **The persistent TMPDIR premise is false** (assumptions M1 and failure m6). Resume
   bindings are in memory, and the cwd is recreated per turn.
   → Drop the TMPDIR volume, the scenario, and D6's rationale. Resume across restarts stays
   a non-goal, as it is today.
8. **yt-dlp** (assumptions M2). ffmpeg is unused and would be invisible on the pinned PATH.
   Current yt-dlp needs a JS runtime (Deno) **in its own directory** for YouTube.
   → Install a pinned, checksummed `deno` next to `yt-dlp` and drop ffmpeg. Task 4.3 gets a
   real extraction probe, not just `--version`.
9. **The WAL-unsafe migration and narrow check** (failure M4, assumptions).
   → *(Superseded by the minimal-downtime Migration Plan and task 7.3's
   `better-sqlite3` copier.)* Stop the source, run `sqlite3 … ".backup"` / `VACUUM INTO` on
   **every** DB, run
   `integrity_check` on all of them, and compare row counts. Pre-create the volume
   directories owned by `node`.
10. **REQUIRE_LOGIN 0→1 on anonymous-era data** (×2). The first Google user sees no teams and
    gets `404` on every existing session.
    → Before cutover, inspect a copy of `catalog.db` (users, memberships, sessions without a
    studio). Plan the bootstrap (G6). Precondition: the OAuth client exists and the round
    trip works on `127.0.0.1` before Pangolin is repointed. Reconfigure Companion installs
    with `API_TOKEN` at cutover.
11. **Day-2 operations** (scope M2). Add:
    - `restart: unless-stopped`;
    - node-based healthchecks (`/api/profile`, and `/` for web);
    - `init: true`;
    - json-file `max-size`/`max-file` log rotation;
    - git-SHA image tags pinned via `WEB_TAG`/`API_TAG` (never `:latest`);
    - an update order (api, then web);
    - a documented `.backup`-based backup;
    - a rollback that states forward-only migrations and the loss of post-cutover writes.
12. **Smoke duplicates e2e and can't run `curl` in the images** (scope M3). → Add a
    Playwright `container` project (`baseURL=ROUTER_URL`, no `webServer`) that runs
    `serving-contract.spec.ts` plus a new `container-routing.spec.ts`, covering the
    differential, upgrades, Companion, and traversal cases. Gzip parity runs from a throwaway
    curl container on the network. The SSE-incrementality smoke is dropped; it's pinned by
    config instead.
13. **Hardening minors**:
    - `header_up X-Forwarded-For {client_ip}`, so `api` sees exactly one value;
    - a pinned compose subnet (`ipam`) for `trusted_proxies`;
    - separate networks, so `web` can't reach `api`;
    - `container_name` on `api`, which blocks `--scale`;
    - the Caddy image pinned by digest;
    - the claude CLI auto-updater disabled via `~/.claude/settings.json`;
    - the `~/.claude.json` location handled;
    - an absolute `tsx` path in CMD;
    - an explicit statement that `REQUIRE_LOGIN` in compose is not env-file-overridable.
14. **`assetPrefix` is YAGNI** and an ambient `ASSET_PREFIX` risk to single-process builds
    (scope m3). → Drop it and its spec clause; it moves to the CDN change.
15. **One Dockerfile with `web`/`api` targets plus `docker-bake.hcl`** (scope m1). This shares
    the `deps` stage and pins, and still produces independent images.
16. **The carve-out scenario turned a gap into a SHALL** → reworded to "is not guaranteed".

### Escalated to the gate
- **G1. Router tier.** (a) Keep Caddy with fixes 2–6 and 13. (b) **api-as-router**: in
  API-only mode the bridge streams non-API GETs to `WEB_UPSTREAM` instead of `404`.
  - (b) removes the `IP_ALLOWLIST` carve-out, the XFF three-hop, and the path-semantics
    mirroring, because dispositions are produced by the same code.
  - (b) costs new proxy code on the frozen surface, makes `api` a SPOF for `web`, and
    weakens separation of concerns.
  - The owner had chosen "internal router"; this is a priced alternative the design had not
    offered.
- **G2.** *(folded into fix 2 — no owner decision needed unless (b) is chosen.)*
- **G3. Narrow the Companion bypass** from wildcards to 5 exact paths (`state`,
  `categories`, `log`, `transport`, `command`) plus router traversal rejection. This narrows
  an owner decision.
- **G4. `API_TOKEN` is a cross-tenant super-credential.**
  - With a token, `requireSession` skips the membership check, and `authContext` exempts
    every `/api` path, not just Companion routes.
  - Through the bypass a token holder can set presence on any session id and trigger
    `record`, which is remote mic activation.
  - Options: accept with documentation (long random token, rotation, a Companion admin
    password), or schedule a separate change that scopes token auth to
    `/api/companion/*`. That is a frozen-contract delta.
- **G5. Claude credential.**
  - A mounted subscription `~/.claude` spends the owner's personal claude.ai login on every
    signed-in user's AI chat, topics, and events turns.
  - The codebase's own `aiV2CredentialsRefused` comment calls this a policy problem.
  - The refresh token also sits in the process that runs yt-dlp on attacker-chosen media.
  - Option: an API key configured *inside* the mounted `~/.claude` (`settings.json`
    `apiKeyHelper`/`env`). The server strips unlisted env from the CLI child, so an env-var
    key would need a code change.
- **G6. Membership bootstrap after the 0→1 flip.** (a) The admin grants memberships via
  `ADMIN_TOKEN` against `127.0.0.1` before cutover. (b) Set `NEW_USER_ALL_TEAMS=1`
  (deprecated) and rely on Pangolin SSO to restrict who arrives.
- **Gate rulings (owner, 2026-09-28):**
  - **G3/G4 → scope the token in this change.**
    - Narrow the Pangolin bypass to the 5 exact Companion paths, and add router traversal
      rejection.
    - **Add** a server-side change: `API_TOKEN` authenticates only `/api/companion/*` (the audit
      found no other in-repo token client: the Companion module calls 5 `/api/companion/*`
      routes; the server test harness and `authz.int.test.ts` use the token on other routes
      and are updated; the README's headless `/api/sessions` example is the documented
      external use that breaks). This is an api-contract-freeze
      delta that the change must author (new spec requirement + tests).
  - **G5 → keep the subscription login** (mounted `~/.claude`). This is an explicit owner
    ruling that accepts the policy and cost risk the codebase flags; the README records it.
  - **G6 → admin grants via `ADMIN_TOKEN`** before Pangolin is repointed.
  - **Pre-apply owner answers (2026-09-28):**
    - Nothing besides the Companion module uses `API_TOKEN` today, so the G4 scope breaks
      no live client.
    - AI v2 stays **off** in the container; no `AI_V2_API_KEY` is set.
    - GHCR images are **private**. The deploy host logs in with a `read:packages` PAT (D8).
    - Cutover is **minimal-downtime**: pre-seed, then a final DB copy + blob delta inside
      the window (Migration Plan).
  - **G1 → Caddy, hardened** (fixes 2–6 and 13; D2). The api-as-router option is recorded as
    a rejected alternative and as the fallback if the raw-path spike fails.
- Carried from before the panel:
  - the split-mode `IP_ALLOWLIST` carve-out (moot under G1b);
  - the AI v2 key requirement;
  - E1, decided `REQUIRE_LOGIN=1`.

### Minors accepted as residual
- `next` is included in the `api` image.
- The `web-frontend-platform` MODIFIED requirement is an intentionally edited full
  restatement (two-topology framing, a re-scoped middleware scenario), not an ADDED-only
  delta. The panel's word-diff confirmed that nothing else was dropped. The
  `core-ports-architecture` MODIFIED block is likewise a full copy with only the token-scope
  edits.
- Multi-arch via local QEMU now. The owner requires amd64 + arm64, and a CI matrix is a
  follow-up.
- A pinned yt-dlp goes stale, so it needs rebuilds.
- Host-local users can reach `127.0.0.1:${ROUTER_PORT}` and bypass SSO. This host is
  single-tenant.
- `commands/wait` long-polls, `commands/:id/ack`, and presence-map growth. These are
  reachable only by a token holder or a signed-in user through SSO, or from the host, because
  none of them is among the 5 bypass paths. Rate limiting is left to Pangolin.
- `docker/.env.example` vs `server/.env.example` drift. The compose file is documented as
  authoritative for containers.

- *Post-gate consistency read, 2026-09-28 (sonnet, light tier):* read proposal.md,
  design.md, tasks.md, and all four spec deltas. **Not clean: 8 findings, all fixed in
  place.**
  1. A stale `400` traversal disposition in the proposal was corrected to rewrite + server
     `404`.
  2. The proposal named the wrong authorizing capability for the traversal edge, and the
     second api-contract-freeze requirement was missing from Capabilities / Contract impact.
     Both fixed; "one intended change" became "two".
  3. Current state had a stale ffmpeg claim, which was corrected.
  4. Current state had a stale "must persist for `--resume`" claim, which was corrected.
  5. The spec's volume scope was `~/.claude` only. It is now the home directory, including
     `~/.claude.json`.
  6. The Minors entry misdescribed the MODIFIED blocks. Corrected.
  7. Seven spec scenarios had no covering task. Coverage was added to tasks 2.1, 4.3, 5.4 and
     8.3: forged X-Forwarded-For, Secure cookie, state survives recreation, tampered binary,
     same shell, cookie traversal, `/auth` and `/api/admin` token clauses.
  8. The `commands/wait` residual was misstated. Corrected.

  Notes also applied:
  - the proposal Impact no longer lists `identity.ts`;
  - the G4 audit outcome is recorded.

  All cross-references (D1–D12, task numbers, requirement/scenario names) were verified to
  match. `openspec validate --strict` passes after the fixes.
- *Second post-gate consistency read, 2026-09-28 (sonnet, light tier)*, after folding in the
  private-GHCR, minimal-downtime, AI-v2-off, and Companion-only-token answers. Read
  design.md, tasks.md, proposal.md, and specs/container-deployment/spec.md. **Not clean: 8
  findings, all fixed in place:**
  1. A stale Risk line said an AI v2 key is used. Changed to "stays off".
  2. The proposal said memberships are granted "before cutover". Changed to a re-runnable
     script, rehearsed and then re-run in the window.
  3. The log's migration disposition is marked as superseded.
  4. Q2 and the proposal now say *private* GHCR.
  5. The data source was ambiguous. The owner confirmed that the live server runs on another
     machine and that `server/data` is a finished pre-seed copy. Current state, Q1, the
     Migration Plan, and tasks 7.3/8.3 now copy from the old host in the window.
  6. The copier ran inside the image. It now runs from a host checkout, and D5's COPY list is
     unchanged.
  7. The proposal's New files list was missing the task 7.3 files. Added.
  8. The 8.3 preconditions and the spec's documentation list were missing the GHCR login and
     the minimal-downtime procedure. Added.

  The task 6.1 private-pull check stays a task-only verification, with no spec scenario.
  Accepted as residual.
- **Task 5.1 raw-path spike, 2026-09-28. Verdict: PASS (proceed with D2 as designed).**
  Spike files lived in the session scratchpad only; containers and network were removed.
  - *Image:* `caddy:2` = Caddy **v2.11.4**, pinned
    `caddy@sha256:0c994536bddb66445885237f1a5dcc1916bccea922661c76b4e9fc24061f9b52`
    (task 5.2 reuses this pin). Upstream was a `node:22` echo server printing its request line.
  - *Q1 — which placeholder sees the raw path:* **`{http.request.uri}`** (equally
    `{http.request.orig_uri}`). It is `RequestURI`-shaped: still percent-encoded, case kept, no
    dot-segment removal, no `//` merge, and it includes `?query`, so a rule must anchor with
    `[^?]*` / `(/|\?|$)`. **Not usable:** `{http.request.uri.path}` and
    `{http.request.orig_uri.path}` are Go's *decoded* `URL.Path` (`/sessions/a%2Fb` shows as
    `/sessions/a/b`; `%2e%2e` as `..`; `/%61pi/x` as `/api/x`).
  - *Q2 — case-sensitive raw matcher:* CEL `expression` with `.matches()` (RE2) on
    `{http.request.uri}` is case-sensitive and raw: `/api/x` matched, `/API/x` and `/Api` did not,
    `/%61pi/x` did not. The stock `path` matcher matched `/API/x` and `/%61pi/x`; `path_regexp`
    matched `/%61pi/x` (decoded input), so both stay banned, as D2 says. Raw expressions also
    detected: encoded `/` or `\` (`^[^?]*%(2[fF]|5[cC])`), dot-segments in any encoding
    (`(?i)^[^?]*/(\.|%2e){1,2}(/|\?|$)`), empty segment (`^[^?]*//`), trailing slash.
  - *Q3 — `reverse_proxy` forwards the raw request-target unchanged:* upstream request lines
    were byte-identical for `/sessions/a%2Fb`, `/sessions/a%2F`, `/API/x`,
    `/api/companion/%2e%2e/x` (with no rewrite rule present), `/sessions/%41%2f%5c`,
    `/%61pi/x`, and `/api/x?q=%2F&A=b`. Raw-socket `GET /A%2fb/%2E/c//d?x=%2F` was also
    forwarded verbatim when routed to the default handler.
  - *Q4 — `rewrite * /__autologger_rejected` then `reverse_proxy`:* works; upstream saw
    `GET /__autologger_rejected` for `%2e%2e`, `%2E%2e`, `./`, `//`. The query string is kept
    (`?x=%2F` survived), which is harmless for a path that 404s.
  - *Q5 — `abort` on `Upgrade` outside `/api`:*
    `printf 'GET /teams HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n' | nc localhost 18080 | wc -c` printed `0`;
    `curl` exited 52 (empty reply). An `Upgrade` on `/api/x` was proxied.
  - *Q6 — headers:* `header { -Server  -Via }` at site level removes both. `Server: Caddy` was
    absent from every response, and an upstream-set `Server` was removed too. **`Via: 1.1 Caddy`
    is added by `reverse_proxy` and is *not* removed by `header_down -Via`; only the site-level
    `header -Via` removes it.** No `Alt-Svc` appeared (`auto_https off`, HTTP only). `Date`
    passes through. No `Accept-Encoding` rewrite or compression happened without `encode`.
  - *Surprises to carry into 5.2/5.3:*
    1. Hono's `c.req.path` uses `decodeURI`, so `/%61pi/x` becomes `/api/x` and is served by the
       API in single-origin, while `/api%2Fx` stays `/api%2Fx` and `/%41pi` becomes `/Api`
       (verified against the installed Hono 4.12.29). A purely literal `^/api(/|$)` rule would
       send `/%61pi/x` to `web` (a layer flip). The router's api-prefix and Upgrade-exemption
       rules therefore allow a percent-encoded lowercase letter in each prefix letter:
       `^/(a|%61)(p|%70)(i|%69)(/|\?|$)` and `^/(a|%61)(u|%75)(t|%74)(h|%68)(/|\?|$)`. Add a
       differential-e2e row for `/%61pi/x`.
    2. Bytes outside the ASCII request-target (raw UTF-8) are re-encoded lowercase by Caddy
       (`ü` → `%c3%bc`). Browsers never send that form; not an issue.
    3. Caddy adds a sniffed `Content-Type: text/plain; charset=utf-8` when the upstream sends a
       body without one (the echo server did; a `204`/empty body gets none). The API and Next set
       their own types, so this is expected to be inert; the 5.3 differential should include a
       body-without-type check only if the server has such a route.
    4. A real WebSocket handshake through Caddy was not exercised here (the echo upstream is not
       a WS server); that belongs to 5.3's differential e2e.
  - Full evidence and a recommended Caddyfile: `.apply/task-5.1-report.md`.
