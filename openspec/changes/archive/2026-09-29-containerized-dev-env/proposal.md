## Why

`containerize-split-images` produced production images and a production `compose.yaml`,
but gave no container path for day-to-day work. It also gave no way to exercise the full
feature set locally: Google sign-in, Companion, the Claude CLI and AI v2, yt-dlp.

Today the only way to run those together is `npm run dev` on the host. That has problems:
- It defaults `DATA_DIR` to `server/data`, which on this host is a copy of live production
  data.
- It binds all interfaces here, because the host `server/.env` sets `HOST=0.0.0.0`.
- It needs host-installed tools.
- It cannot run sign-in the way production does.

The owner wants one-command, containerized **dev**, **stage**, and **prod** environments,
with a Bitfocus Companion running this repo's module in dev.

## What Changes

- **A root `Makefile`** of thin wrappers over `docker compose` and `docker buildx bake`:
  - `dev-*`: `build`, `up`, `down`, `logs`, `shell`, `reset`
  - `stage-*`: `build`, `up`, `down`, `logs`, `claude-login`, `reset`
  - `prod-*`: `build`, `push`, `pull`, `up`, `down`, `logs`
  - `check`, `help`

  Each environment is a separate compose project, and each compose file declares its
  project `name:`. Dev and stage always pass their own `--env-file`. `dev-up` and
  `stage-up` run the invariant check first. Resets need `CONFIRM=yes` and verify the
  project name. Prod has no destructive target.
- **`dev` environment.** A new `dev` target in `docker/Dockerfile`, plus
  `docker/compose.dev.yaml`.
  - It runs single-process, hot-reload `npm run dev`. The image carries the deps, the Claude
    CLI, and yt-dlp with deno.
  - Source subtrees are bind-mounted **read-only**. `server/data` and `server/.env` are
    never mounted.
  - The app is anonymous (`REQUIRE_LOGIN=0`) and binds **`127.0.0.1` inside its
    container**. A Caddy **Host/Origin gate sidecar** shares its network namespace, and is
    the only listener, published on host loopback. This rejects DNS-rebinding and
    cross-origin writes. The loopback bind satisfies both the open-network refusal and
    AI v2's loopback-only login rule.
  - Only the operator's `~/.claude/.credentials.json` is bind-mounted, read-write. The
    container's home, with its session store and `~/.claude.json`, is a `dev-home`
    volume. AI chat, topics, events, and **AI v2** all run on the existing Claude login,
    with no separate login.
  - Google sign-in is optional: set `GOOGLE_*` in `.env.dev`.
  - `DATA_DIR`, the Next cache, and Companion config live in named volumes.
- **Dev Companion.** Bitfocus Companion `v4.3.4` (pinned by digest), with this repo's
  module compiled and packaged in `docker/companion.Dockerfile`. It loads through
  Companion's local-dev module path. Its admin UI sits behind its own gate sidecar on host
  loopback. The connection is configured once in the UI, pointed at the dev app's gate.
- **`stage` environment.** A `docker/compose.stage.yaml` overlay on the production
  `compose.yaml`, with images built locally for the native architecture. It behaves as prod:
  - `REQUIRE_LOGIN=1`, and its own named-volume Claude login (`make stage-claude-login`);
  - AI v2 needs `AI_V2_API_KEY`;
  - no Companion.

  Real Google sign-in uses a dev OAuth client with redirect
  `http://localhost:8788/auth/google/callback`. The overlay changes only: project name,
  container name, subnets, image names, env file, `PUBLIC_BASE_URL`, `COOKIE_SECURE=0`,
  `SESSION_COOKIE`, and the loopback port.
- **Router trusted-proxy gateways become env placeholders** (`{$ROUTER_FRONT_GW:…}`,
  `{$ROUTER_BACK_GW:…}`), so stage can run beside prod. The defaults are prod's, so the
  adapted config is byte-identical, checked against a committed baseline. `compose.yaml`
  never sets them, and any set value must be a single IPv4 address.
- **Prod targets.**
  - `prod-push` and `prod-up` require a clean tree (`git status --porcelain`) on `main`.
  - `prod-push` checks the builder has amd64 and arm64, then tags with the 12-character SHA.
  - `prod-build` loads native images tagged `:local`, never a SHA.
- **Env-file hygiene.**
  - `.gitignore` gains `.env.*` with a `!*.example` exception.
  - New templates: `docker/.env.dev.example` and `docker/.env.stage.example`.
  - `docker/.env.example` gets two fixes: its `PUBLIC_BASE_URL` note is wrong (compose
    interpolates it, so it must be set there), and it gains an example `WEB_TAG`/`API_TAG`
    value.
- **`docker/scripts/check-envs.sh`** (run by `make check`, `dev-up`, and `stage-up`).
  - It resolves each environment with `docker compose config --no-env-resolution` and
    placeholder env files, so it never reads real secrets.
  - It asserts the silent-failure invariants: loopback-only publishing, no 8080 in dev or
    stage, dev mounts, literal posture pins, resolved project names, gateway rules, the
    Companion ignore file's shape, and the adapted-Caddyfile baseline.
- **Docs.** A README "Local container environments" section, and a `CLAUDE.md` pointer.

## Capabilities

### New Capabilities
- `local-container-environments`: the dev, stage, and prod container environments and
  their Makefile entry points. That covers:
  - the dev posture: loopback bind behind a Host/Origin gate, read-only source, isolated
    data, shared Claude login;
  - stage's production-parity sign-in;
  - the dev Companion container;
  - env-file hygiene;
  - stage–prod coexistence;
  - prod target guards;
  - the static invariant check.

### Modified Capabilities
None. The `container-deployment` requirements hold as written. The router still trusts
forwarded headers only from the pinned compose subnet, because the placeholders default to
the pinned gateways, which the baseline check and `npm run e2e:container` re-verify.

## Contract impact

None. No HTTP/WS route, JSON shape, status code, or header semantics change, and no server
source changes. The environments only set existing configuration variables. The dev gate
is a local proxy in front of an unchanged server.

## Non-Goals

- Seeding dev or stage data from production or `server/data`.
- Changing any server rule, including AI v2's loopback-only login rule. Dev satisfies it
  with a real loopback bind; stage and prod still need a key.
- Auto-provisioning the Companion connection.
- Companion in stage.
- CI (multi-arch matrix, bake cache, `check-envs.sh` in CI).
- Hot reload of the Companion module.
- Making `npm run e2e:container` coexist with a running prod stack (follow-up).
- Docker Desktop support. The design targets Linux Docker Engine.
- Changing the host `server/.env` (`HOST=0.0.0.0`) or host `npm run dev`.

## Impact

- **New files:**
  - `Makefile`
  - `docker/compose.dev.yaml`
  - `docker/compose.stage.yaml`
  - `docker/dev-gate.Caddyfile`
  - `docker/companion.Dockerfile`
  - `docker/companion.Dockerfile.dockerignore`
  - `docker/.env.dev.example`
  - `docker/.env.stage.example`
  - `docker/scripts/check-envs.sh`
  - `docker/scripts/caddy-adapt.baseline.json`
- **Changed files:**
  - `docker/Dockerfile`: new `dev-deps`/`dev` stages; `web` and `api` unchanged.
  - `docker/Caddyfile`: gateway placeholders.
  - `docker/.env.example`
  - `.gitignore`
  - `README.md`
  - `CLAUDE.md`
- **Runtime:** no server, web, or companion source change.
- **Dependencies:** new pinned image `ghcr.io/bitfocus/companion/companion:v4.3.4@sha256:7fddb11a…`.
  The existing pinned Caddy image is reused for the gates.
- **Operator:** dev reads and writes the operator's `~/.claude/.credentials.json`, and
  nothing else under `~/.claude` (accepted at gate G1, amended before apply).
