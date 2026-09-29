<!-- Plan of record once the post-gate consistency read is logged. Anchors are orientation
     only: locate code by its content before editing, and say so in every dispatch prompt. -->

## 1. Branch and plan of record

- [x] 1.1 Make the branch's first commit the gated OpenSpec artifacts
      (`openspec/changes/containerize-split-images/`), before any dispatch.

## 2. API_TOKEN scope (frozen contract + auth; phase review required)

- [x] 2.1 Characterize current behaviour. Integration tests pin the pre-change `API_TOKEN`
      behaviour, where any gaps remain beyond `server/src/routers/authz.int.test.ts`:
      - a token-only request on `/api/companion/state`;
      - a token-only request on `/api/sessions`;
      - a token-only session WS upgrade;
      - a token-only request on `/auth/*`, and a token-only request on `/api/admin/*` (which
        keeps its `ADMIN_TOKEN` handling);
      - the AI v2 dashboard, under both `REQUIRE_LOGIN` modes.

      All pass on unmodified code.
- [x] 2.2 Scope the token (design D10). In `server/src/middleware/auth.ts`, `apiTokenAuth` is
      true only when the path is under `/api/companion/`. Update the 2.1 tests to the new
      `api-contract-freeze` scenarios and the MODIFIED `core-ports-architecture` scenarios.
      Update the README `API_TOKEN` row and the example that curls `/api/sessions` with the
      bearer.
- [x] 2.3 Run `npm run typecheck` and `npm test`.

## 3. Web standalone output + server runtime dependency (gate: typecheck + test + e2e)

- [ ] 3.1 Confirm that `e2e/serving-contract.spec.ts` and `smoke.spec.ts` cover the
      single-process shell, asset, trailing-slash, and non-GET dispositions. Add any
      missing case and see it pass on the unmodified config.
- [ ] 3.2 In `web/next.config.ts`, set `output: 'standalone'` and `outputFileTracingRoot` to
      the repo root. Do not set an `assetPrefix`. Document both in the file's existing
      decision-comment style.
- [ ] 3.3 In `server/package.json`, move `tsx` from `devDependencies` to `dependencies`, then
      refresh `package-lock.json`. Diff the lockfile: only the `tsx`-family `dev` flags may
      change.
- [ ] 3.4 Run `npm run build`. Confirm `web/.next/standalone/web/server.js` exists, and that
      with `static` and `public` copied in it serves `/`, `/teams`, `/sessions/abc`,
      `/admin/users`, and a `/_next/static/*` asset.
- [ ] 3.5 Run `npm run typecheck`, `npm test`, `npm run e2e` (chromium + login-gate), and
      `npm run e2e:visual`. The single-process path must be unchanged.

## 4. Images (security posture; phase review required)

- [ ] 4.1 Add `.dockerignore` using `**/`-anchored patterns:
      - `**/node_modules`, `**/.next`, `**/data`, `**/.data*`;
      - `**/.env*` with `!**/.env.example`;
      - `.git`, `companion/`, `openspec/`, `docs/`, test artifacts.
- [ ] 4.2 Add `docker/Dockerfile` with the `web` and `api` targets (design D4, D5, D6), and
      `docker-bake.hcl` with git-SHA tags for GHCR.
      - Pin every base image by digest.
      - Use explicit `COPY` paths only.
      - Run as non-root, with volume directories pre-created and owned by `node`.
      - `tsx` runs by absolute path.
      - Install `yt-dlp` + `deno` into `/opt/ytdlp`, pinned and sha256-verified per
        `TARGETARCH`. Do not install ffmpeg.
      - Install a pinned `claude` CLI.
- [ ] 4.3 Verify the images natively (arm64):
      - Build once with a deliberately wrong `yt-dlp` checksum pin and confirm the build
        fails (scenario "Tampered binary download").
      - Build on this host, where `server/data` (17 GB) and any `server/.env` are present.
        Assert that no `catalog.db`, no `server/data`, and no `.env` (other than
        `.env.example`) exist in either image.
      - The `web` image contains no backend or binaries.
      - The `api` image boots API-only and `better-sqlite3` loads.
      - `claude --version` succeeds.
      - With `PATH=/opt/ytdlp`, `yt-dlp` resolves the metadata of a public video.
      - Both containers run with a non-zero UID and can write their volumes on first start.

## 5. Router and compose (frozen contract surface; phase review required)

- [ ] 5.1 **Spike (stop-gate).** Confirm which Caddy placeholder or matcher sees the raw,
      escaped, case-preserved request path, and that `reverse_proxy` forwards the raw path
      unmodified. Test `/sessions/a%2Fb`, `/sessions/a%2F`, `/API/x`, and
      `/api/companion/%2e%2e/x`. Record the result in the design's Panel & review log.
      If neither holds, stop and re-gate G1 (design Risks).
- [ ] 5.2 Add `docker/Caddyfile` with the ordered rules of design D2:
      - traversal is rewritten to `/__autologger_rejected` and sent to `api`;
      - a non-`/api` `Upgrade` gets `abort`;
      - `/api` and `/auth` go to `api`;
      - non-GET/HEAD requests go to `api`;
      - trailing-slash paths go to `api`;
      - everything else goes to `web`.

      Also: `auto_https off`, no `encode`, `-Server`, `trusted_proxies_strict` on the pinned
      subnet, and `header_up X-Forwarded-For {client_ip}`. Pin the Caddy image by digest.
- [ ] 5.3 Add `compose.yaml` (design D7, D11) and a tracked `docker/.env.example` with no real
      values. It includes:
      - the `front`/`back` networks with `ipam` pins, and only the router published, on
        `127.0.0.1:${ROUTER_PORT:-8080}`;
      - the `/data` and `/home/node` volumes;
      - `REQUIRE_LOGIN=1`, `TRUST_PROXY=1`, `COOKIE_SECURE=1`, and `PUBLIC_BASE_URL` in the
        `environment` block;
      - `container_name` on `api`;
      - restart policy, `init`, node-based healthchecks, log rotation, and the
        `WEB_TAG`/`API_TAG` image references.
- [ ] 5.4 Add a Playwright `container` project (`baseURL=ROUTER_URL`, no `webServer`,
      excluded from the default run) running `serving-contract.spec.ts` and a new
      `e2e/container-routing.spec.ts`. The new spec covers every `container-deployment`
      router scenario:
      - the differential matrix against a single-process server from the same commit (this
        also covers the `web-frontend-platform` scenario "Same shell from both
        topologies");
      - raw-socket stray upgrades (no status line) and the session WS;
      - traversal (`404` with a valid token, and with a valid session cookie per the
        `api-contract-freeze` scenario "Encoded dot-segments do not reach a route");
      - a forged `X-Forwarded-For` sent to the router from a non-trusted peer is not the
        resolved client IP (scenario "Forged X-Forwarded-For is not adopted"; the
        through-Pangolin variant is repeated in 8.3);
      - state survives recreation: write a session, recreate `api` from the same tag, and
        find the session, `~/.claude/` and `~/.claude.json` still present;
      - gzip/identity parity via a throwaway curl container on `back`;
      - the Companion token scope;
      - `--scale api=2` refused;
      - `web` unable to reach `api`.
- [ ] 5.5 Prove that the container project catches a regression. Temporarily route non-GET
      requests to `web`, confirm the project fails and names `POST /sessions/abc`, then
      revert.

## 6. Multi-arch build

- [ ] 6.1 Set up the buildx `docker-container` builder and binfmt. Run
      `docker buildx bake --push` for `linux/amd64` and `linux/arm64` to GHCR. Run the task
      4.3 binary checks inside the amd64 `api` variant under QEMU. Images go to **private**
      `ghcr.io/kwcantrell/autologger-{web,api}`; confirm an anonymous pull is refused and an
      authenticated pull with a `read:packages` PAT succeeds.

## 7. Documentation

- [ ] 7.1 Add a README "Container deployment" section covering:
      - the topology (Pangolin → Newt → router → web/api);
      - bake, push, and compose, with tag pinning;
      - the env reference, stating what is required and why;
      - the volumes;
      - the Pangolin target and the **5 exact-path** Companion bypass rules, which replace
        the README's existing wildcard `/api/companion/*` advice;
      - Google OAuth client creation;
      - the security notes the spec requires: G5 subscription risk, AI v2 key, shell
        allowlist, host-local reach, token scope;
      - private-GHCR login (`read:packages` PAT);
      - the WAL-safe backup, and the minimal-downtime migration: pre-seed, then a final DB
        copy plus a `rsync --delete` blob delta;
      - the re-runnable membership bootstrap script, the update order, and rollback with
        forward-only migrations;
      - rebuilding when yt-dlp or deno go stale.
- [ ] 7.2 Add a brief mention of the split topology to `CLAUDE.md`'s Setup & commands and
      project overview, pointing to the README and noting the `API_TOKEN` scope. Do not
      duplicate the README.

- [ ] 7.3 Add `server/scripts/copyDataDir.ts`, a WAL-safe DATA_DIR copier used both to
      pre-seed and in the cutover window. For every `*.db` it runs `better-sqlite3`
      `db.backup()` into the destination, then `PRAGMA integrity_check` and a per-table
      row-count comparison, and it exits non-zero on any mismatch. Blobs stay a documented
      `rsync --delete`. The script must run from any AutoLogger checkout, including the old
      host's (for the final copy), so it depends only on `better-sqlite3` and `node:`
      built-ins. It copies into a destination directory and never writes to the source. Add a
      unit/integration test against a WAL-mode fixture that has
      uncheckpointed writes. Also add a re-runnable membership-bootstrap script template
      that drives the `ADMIN_TOKEN` endpoints and is idempotent. Run `npm run typecheck` and
      `npm test`.

## 8. Final gates and live cutover

- [ ] 8.1 Run root `npm test`, `npm run typecheck`, `npm run e2e` (chromium + login-gate),
      `npm run e2e:visual`, and the `container` project against a fresh `docker compose up`.
- [ ] 8.2 Run the whole-branch review (layered scoped audit, per the CLAUDE.md SDLC).
- [ ] 8.3 Owner runs the cutover per the design's Migration Plan:
      - preconditions (OAuth client, secrets, pushed tags, and `docker login ghcr.io` with a
        `read:packages` PAT on this host);
      - pre-seed the volume while the old server runs;
      - the loopback pre-flight, including a Google sign-in whose session cookie carries
        `Secure` and whose redirect URI is `${PUBLIC_BASE_URL}/auth/google/callback`
        (scenario "Session cookie is Secure");
      - a rehearsal of the membership bootstrap script;
      - the cutover window: stop the old server on the other machine, run the WAL-safe copy of
        every DB there and rsync it here, run the blob delta from the old host, integrity and
        row-count checks, start, re-run bootstrap (needs the old host name and its
        `DATA_DIR` path);
      - the Pangolin repoint with exact-path bypass rules;
      - Companion reconfiguration;
      - outside verification (OAuth, Companion, traversal `404`, SSO `302` on other `/api`,
        session WS, forged `X-Forwarded-For`).
