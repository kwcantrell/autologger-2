## Context

`containerize-split-images` (archived 2026-09-29) shipped:
- the `web` and `api` images from `docker/Dockerfile`;
- the internal Caddy router;
- a production `compose.yaml` fronted by Pangolin → Newt → `127.0.0.1:8080`;
- `npm run e2e:container`.

It gave no container story for development. The owner asked for Makefile/script entry
points covering prod, a hot-reload **dev**, and a locally built **stage**, where "dev
contains the full feature set (companion/signin/claude/...)".

Owner decisions, recorded before this proposal (2026-09-29):
1. **Shape: both.** `dev` is hot-reload and single-process. `stage` is a locally built split
   stack.
2. **Auth.** `dev` is anonymous (`REQUIRE_LOGIN=0`). The pre-proposal plan was
   `IP_ALLOWLIST` = loopback + docker subnet; gate G1 superseded that with a loopback bind
   behind a gate sidecar (D3). `stage` uses real Google sign-in on localhost with
   `REQUIRE_LOGIN=1` and a dev OAuth client.
3. **Companion.** Run Bitfocus Companion in a container, with this repo's module loaded
   and pointed at the API. Gate G6 put it in dev only.
4. **Process.** Merge and archive the previous change first (done), then `/compact`, then
   propose.

### Current state, measured on `containerized-dev-env` @ `aa05a05`

The nouns the framing names, and what the tree says about each.

- **Makefile / scripts.**
  - There is no `Makefile`.
  - `scripts/` holds only `teardown.mjs`.
  - GNU Make 4.3, Docker Compose v5.2.0, and `jq` 1.7 are installed.
- **`npm run dev`.**
  - `server/package.json` `dev` runs `tsx watch --env-file-if-exists=.env src/main.ts`, with
    `HOST` defaulting to `127.0.0.1`.
  - Next runs in-process. The dev HMR upgrade is routed by `server/src/node/nextFrontend.ts`
    `upgradeHandler`, so one port carries both the app and HMR.
  - `DATA_DIR` defaults to `./data` (`server/src/node/config.ts`). That resolves to
    **`server/data`, the live-data copy**.
  - The host `server/.env` exists and holds real secrets. It sets `DATA_DIR=./data` and
    `HOST=0.0.0.0`. Key names were read; values were redacted.
- **Host `npm run dev` exposure** (panel correction).
  - Because the host `.env` sets `HOST=0.0.0.0`, on this host `npm run dev` today binds all
    interfaces, with an empty `IP_ALLOWLIST`.
  - Recorded as a measured premise. Changing the host `.env` is out of scope.
- **Open-network gate** (`server/src/env.ts` `openNetworkRefused`).
  - Paid features are refused when all three hold: `REQUIRE_LOGIN` is off, `IP_ALLOWLIST`
    is empty, and the bind is non-loopback.
  - The features are AI chat/topics/events, AI v2, YouTube import, and Sheets import.
  - `main.ts` prints its open-network warning on the same predicate.
  - `loopbackHostname` is true only for `127.0.0.1`, `::1`, or `localhost`.
- **AI v2 credentials** (`aiV2CredentialsRefused`).
  - The `claude login` fallback is refused on any non-loopback bind, independently of
    `REQUIRE_LOGIN` and `IP_ALLOWLIST`, unless `AI_V2_API_KEY` is set.
  - So a container app bound `0.0.0.0` cannot use AI v2 without a key. This is resolved for
    dev by gate G1 (D3); stage keeps the prod behaviour.
- **Claude CLI and SDK settings isolation.**
  - The AI chat runner passes `--setting-sources ""` (`packages/ai-runtime/src/aiChatRunner.ts`).
  - The AI v2 SDK spawn sets `settingSources: []` (`aiV2SdkSpawn.ts`).
  - So a `~/.claude/settings.json` (hooks, plugins) would **not** be loaded by server
    turns.
  - Host `~/.claude/.credentials.json` and `~/.claude.json` exist, mode 0600, owned by uid
    1000. The image's `node` user is also uid 1000.
- **IP allowlist** (`server/src/middleware/ipAllowlist.ts`).
  - It takes CSV plus CIDR.
  - It uses the socket address unless `TRUST_PROXY` is set.
  - It is mounted as `app.use('*')`.
- **Server Host/Origin checks.** There are none in `server/src` (panel grep).
- **Signin.**
  - `oauthConfigured` needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and
    `PUBLIC_BASE_URL`. The redirect is `${PUBLIC_BASE_URL}/auth/google/callback`.
  - `routers/auth.ts` gates on `oauthConfigured` only, not on `REQUIRE_LOGIN`.
  - `routers/shows.ts` returns `{shows: []}` when `user === null && oauthConfigured`.
  - `cookieSecureForRequest` honours an explicit `COOKIE_SECURE`.
  - Self-serve team creation exists (`CreateTeamForm`).
- **Claude.**
  - The `api` image pins claude-code 2.1.284.
  - The CLI child env passes `HOME`.
  - `claude --version` crashed only under QEMU amd64; dev and stage build natively (arm64).
- **Companion** (`companion/`).
  - The manifest declares `runtime.type node22` and `apiVersion 1.14.1`.
  - `scripts/check-base-version.mjs` targets Companion **4.3.4**.
  - `npm run build` = `check:base` + `tsc`. `npm run package` = `companion-module-build`,
    which webpacks `dist/main.js` and does not compile TypeScript (panel-verified).
  - The connection config is entered in the Companion UI (`companion/src/config.ts`).
  - `@companion-module/base` is pinned by the root `overrides`.
- **Bitfocus image** (panel-verified, 2026-09-29).
  - `ghcr.io/bitfocus/companion/companion:v4.3.4` exists, with index digest
    `sha256:7fddb11a82ed4934c6ef3d34782963bac9b12916f31be525b81df87bb2458df5` and an arm64
    manifest.
  - It runs as the non-root user `companion`.
  - Its entrypoint runs `main.js --admin-address :: --admin-port ${COMPANION_ADMIN_PORT:-8000}
    --config-dir … --extra-module-path /app/module-local-dev "$@"`. It skips the yarn
    install for a module directory that already has `node_modules/`.
  - Modules loaded from `--extra-module-path` register as dev modules (version id `dev`).
- **Docker networking on this host** (panel-verified).
  - Engine 29.6.2, `EnableUserlandProxy: true`, iptables backend.
  - A host request through a published port arrives from the network gateway.
  - User-defined bridge networks are isolated from each other.
- **This host's buildx.** `autologger-multi` currently lists only `linux/arm64`; the binfmt
  registration did not survive a reboot.
- **Build context.** `.dockerignore` excludes `**/companion`, `**/scripts`, `**/data`,
  `**/.env`, and `**/.env.*`. `.gitignore` ignores `.env` but not `.env.dev` or
  `.env.stage`.
- **Prod compose.**
  - `compose.yaml` pins subnets `172.28.10.0/24` and `172.28.11.0/24`, and
    `container_name: autologger-api`.
  - `api` uses `env_file: .env`.
  - `WEB_TAG`, `API_TAG`, and `PUBLIC_BASE_URL` are required interpolations (`:?`).
  - `docker/Caddyfile` hard-codes `trusted_proxies static 172.28.10.1 172.28.11.1`.
  - A second project from `compose.yaml` cannot start beside prod without an overlay and a
    parameterized Caddyfile (G3).
- **`docker/.env.example`.**
  - Its note wrongly lists `PUBLIC_BASE_URL` among values that "have no effect" there.
  - It gives no example tag.
- **Inherited deferral pointers:** none relied on.

## Goals / Non-Goals

**Goals**
- `make dev-up` runs a hot-reload app with every integration, including AI v2 on the
  operator's login and Companion. It is anonymous, loopback-bound, and rebinding-gated. It
  sees no live data and no host secrets other than the operator's Claude login.
- `make stage-up` runs the production images and router with real Google sign-in on
  localhost, beside a running prod stack, behaving as prod.
- `make prod-*` wraps the README's production procedure without changing it.
- `make check` mechanically guards the safety invariants.

**Non-Goals:** as listed in `proposal.md`.

## Decisions

### D1. Makefile over scripts, one compose project per environment
The root `Makefile` holds thin, declarative wrappers. Anything longer than a couple of lines
lives in `docker/scripts/*.sh`. That covers the invariant check and the env-file guard.

Each compose file declares its project `name:`: `autologger-dev`, `autologger-stage` (the
overlay's `name:` wins), and `autologger`. Dev and stage targets always pass `--env-file`.
Dev targets also pass `--project-directory .`, because without it relative paths in
`docker/compose.dev.yaml` resolve under `docker/`. Docker then silently creates missing
bind sources as empty directories (panel-verified).

Alternatives considered:
- *npm scripts.* Rejected: they need host node/npm, which here needs an nvm `PATH` and must
  not run installs.
- *`just` or `task`.* Rejected: an extra tool to install.
- *One `.sh` per environment.* Rejected: duplicated flag plumbing, and no `make help`.

### D2. Dev: deps baked into the image; source bind-mounted read-only by subtree
A `dev-deps` stage runs `npm ci` for `server`, `web`, and `packages/*`, including dev
dependencies, on the native platform. A `dev` stage adds:
- the `tools` stage's yt-dlp and deno;
- the pinned claude-code;
- the baked configs;
- `/app` owned by `node`.

Compose bind-mounts these, `:ro`:
- `server/src` and `server/scripts`;
- `web/src` and `web/public`;
- `packages/<each>/src` and `packages/catalog/migrations`.

Config, manifest, or lockfile changes mean `make dev-build`. `web/.next` is a named volume.

Alternatives considered:
- *Whole-repo mount with `node_modules` shadow volumes.* Rejected, for three reasons:
  - The host `node_modules` is built for node 24.21 (ABI 137), while the image runs node 22.
    There are 14 `node_modules` directories, measured by
    `ls -d */node_modules packages/*/node_modules` plus the root.
  - It would expose `server/data` and `server/.env`. `tsx --env-file-if-exists=.env` would
    load host prod secrets and `DATA_DIR=./data` for every unpinned key.
  - The container could write the host tree.
- *devcontainer.* Rejected: IDE-coupled.

**Invariant a future reader might undo:** do not "simplify" to a whole-repo mount. The
subtree list is the data-and-secret fence. The check asserts every `packages/*` has a mount.

### D3. Dev posture: loopback bind behind a Host/Origin gate sidecar (G1 + G5)
The dev `app` pins these literals: `HOST=127.0.0.1`, `PORT=8786`, `REQUIRE_LOGIN=0`,
`TRUST_PROXY=0`, `IP_ALLOWLIST=` (empty), `DATA_DIR=/data`, and
`PUBLIC_BASE_URL=http://localhost:${DEV_PORT}`. `DEV_PORT` is the *published* port, default
8787.

A Caddy sidecar, `app-gate`, sits in front of the app:
- It runs with `network_mode: service:app`, so it shares the app's network namespace.
- It listens on `:8787`, and forwards to `127.0.0.1:8786`.
- It is the only listener on the namespace's external interfaces.

Compose attaches `ports:` to the namespace owner, so `app` declares
`127.0.0.1:${DEV_PORT:-8787}:8787`; the target port is the gate's.

The gate's Caddyfile (`docker/dev-gate.Caddyfile`) does four things:
1. It rejects (`abort`) any request whose `Host` is not one of `127.0.0.1:{$DEV_PORT}`,
   `localhost:{$DEV_PORT}`, or `app:8787` (the name dev Companion uses).
2. It rejects non-GET/HEAD requests and `Upgrade` requests whose `Origin` is present and
   not `http://127.0.0.1:{$DEV_PORT}` or `http://localhost:{$DEV_PORT}`.
3. It forwards everything else, WebSocket upgrades included (HMR and the session WS).
4. It adds no `X-Forwarded-For` trust. The app sees `127.0.0.1`, and `TRUST_PROXY=0`.

Consequences:
- `loopbackHostname` is true, so the open-network refusal and the AI v2 credentials rule
  both pass. With the mounted login (D4), every gated feature works, AI v2 included,
  without a key.
- The allowlist is unnecessary and left empty. The panel showed it was not a boundary in
  the published-port topology anyway: host traffic arrives from the gateway.
- **Reach.** The app is reachable only through the gate. The gate in turn is reachable
  only from host loopback (the literal `127.0.0.1` publish) and from containers on the dev
  network (Companion).
- **Honest note for future readers.** The AI v2 loopback rule exists so a multi-user
  deployment never spends the operator's personal subscription. This design satisfies the
  rule's *check* structurally (a real loopback bind), and keeps its *intent* by making the
  gate's reach single-operator: host loopback plus the operator's own Companion.
  **Do not publish the dev gate on a non-loopback address, or join other networks to it.**
  Doing either turns this into exactly what the rule forbids. `check-envs.sh` enforces
  loopback-only publishing and literal pins.

Residuals:
- Any local process or user on the host can use the dev app anonymously, with the
  operator's Claude login. This is equivalent to a loopback `npm run dev`.
- A same-origin page served *by* the dev app itself is trusted, trivially.

Alternatives considered:
- *`HOST=0.0.0.0` + `IP_ALLOWLIST`* (the pre-gate plan). AI v2 would need a key; the owner
  wanted it on the login.
- *Host networking with `HOST=127.0.0.1`.* Linux-only, and the Companion entrypoint's
  `--admin-address ::` would bind the host's LAN.
- *A server knob.* A policy-rule change; rejected at G1.

### D4. Dev state: named volumes, plus the operator's Claude credentials file bind-mounted rw (G1)
State is kept in named volumes:
- `dev-data` → `/data`;
- `dev-next` → `/app/web/.next`;
- `dev-companion` → `/companion`;
- `dev-home` → `/home/node`. This holds the CLI's session store (needed for AI chat
  `--resume`), its own `~/.claude.json`, and its history.

**Only the login is shared** (owner amendment to G1, 2026-09-29: "instead of mounting the
entire ~/.claude, can we just mount what is needed for login"; read-write chosen). The
host `${HOME}/.claude/.credentials.json` is bind-mounted **read-write** at
`/home/node/.claude/.credentials.json`, nested inside `dev-home`. Both sides are uid 1000.

That one file is sufficient:
- **AI v2** already reads only that file. `server/src/node/config.ts` sets
  `AI_V2_CREDENTIAL_SOURCE_PATH` to `~/.claude/.credentials.json`, and
  `prepareDesignTurnCredentials` copies it into a fresh per-turn `CLAUDE_CONFIG_DIR`.
- **AI chat, topics, and events** run the CLI with `HOME`, and it reads its credentials
  from `$HOME/.claude/.credentials.json`.
- Server turns load no host settings or hooks (`--setting-sources ""` /
  `settingSources: []`).

Why read-write: token refreshes by either side stay visible to the other. With a read-only
copy, a refresh inside the container can't be saved, and if refresh tokens rotate, that
could invalidate the host's login.

Accepted residuals:
- Anything executing in the dev container, including a compromised dependency, can read or
  overwrite the login file.
- The container and host Claude Code may both rewrite the file.

**Verified at task 4.5:**
- **The single-file bind stays live.** A single-file bind follows the inode. If the CLI
  saves credentials by write-to-temp-and-rename, a host refresh would leave the container on
  a stale inode, and a container refresh would fail (`EBUSY`) or never reach the host. The
  task checks the file's inode and contents after a token refresh on each side (or after a
  forced write), and that the container sees no `EBUSY`.
- **The CLI runs `-p` turns with no host `~/.claude.json`** (only its own, in `dev-home`).

If either check fails, apply **stops and routes to the owner**. The known fallback,
`claude setup-token` (a long-lived token with no refresh), needs a server change to let
the token variable through the child-env allowlists, which is outside this change's
no-source-change scope.

`make dev-reset CONFIRM=yes` removes only the dev project's named volumes, `dev-home`
included. It never touches the bind-mounted host credentials file.

### D5. Stage is an overlay on the production `compose.yaml`, behaving as prod
`docker/compose.stage.yaml` is used as `-f compose.yaml -f docker/compose.stage.yaml
--env-file .env.stage`. It sets:

| Setting | Stage value |
|---|---|
| top-level `name:` | `autologger-stage` |
| `web`/`api` `image` | `autologger-stage-{web,api}:local` |
| `api` `container_name` | `autologger-stage-api` |
| `api` `env_file` | `!override [.env.stage]` |
| `api` `environment` | `PUBLIC_BASE_URL=http://localhost:${STAGE_PORT:-8788}`, `COOKIE_SECURE: "0"`, `SESSION_COOKIE: autologger_stage_sid` |
| subnets | `!override` to `172.28.20.0/24` and `172.28.21.0/24` |
| router `environment` | `ROUTER_FRONT_GW=172.28.20.1`, `ROUTER_BACK_GW=172.28.21.1` |
| router `ports` | `!override ["127.0.0.1:${STAGE_PORT:-8788}:8080"]`; `ROUTER_PORT` is never used |

Everything else is inherited:
- `REQUIRE_LOGIN=1` and `TRUST_PROXY=1`.
- The api `/home/node` named volume. Stage gets its own login via `make stage-claude-login`
  and **does not** mount the host `~/.claude` (owner: "stage should behave the same as
  prod").
- AI v2 therefore needs `AI_V2_API_KEY`, as in prod.
- There is no Companion (G6). The scoped token is tested with `curl` through the router.

Compose interpolates the base file's `${WEB_TAG:?}`, `${API_TAG:?}`, and
`${PUBLIC_BASE_URL:?}` before merging, so the Makefile passes placeholders for all three.
`make stage-build` runs `docker compose … build` for the native platform.

Alternatives considered:
- *A standalone stage compose copy.* Rejected: routing and hardening drift is what stage
  exists to catch.
- *GHCR images with localhost settings.* Rejected: they don't exercise the working tree.
  `prod-build :local` plus `prod-up` is not that either (G7).

### D6. Stage uses `COOKIE_SECURE=0`
Stage is plain `http://localhost`. Chromium and Firefox accept `Secure` cookies there, but
Safari does not. The production Secure-cookie property remains an owner-owed check on the
public origin (archived task 8.3).

### D7. Router gateways become env placeholders (G3)
The Caddyfile line becomes
`trusted_proxies static {$ROUTER_FRONT_GW:172.28.10.1} {$ROUTER_BACK_GW:172.28.11.1}`.
Caddy substitutes these at parse time (verified in v2.11.4 `replaceEnvVars`). The default
applies only when the variable is *unset*.

Hardening, enforced by `check-envs.sh`:
- `compose.yaml` never sets `ROUTER_*`.
- Any set value must be a single dotted IPv4 address. This blocks injection of
  `private_ranges`, `0.0.0.0/0`, newlines, and empty values.
- The Caddyfile adapted with nothing set must equal a committed baseline JSON
  (`docker/scripts/caddy-adapt.baseline.json`).

`e2e:container` re-verifies prod behaviour, including the forged-XFF case.

Alternatives considered:
- *Stage refuses to start while prod runs.* Rejected: this host becomes the prod host at
  cutover.
- *A stage-only Caddyfile copy.* Rejected: it forks the routing rules.

### D8. AI v2: works in dev on the login; needs a key in stage (G1)
- **Dev:** loopback bind (D3) plus the mounted login (D4). AI v2 works when `AI_V2_ENABLED=1`.
  `AI_V2_API_KEY` is optional; a key takes precedence, as in prod.
- **Stage:** `api` must bind `0.0.0.0` for the router to reach it, so the credentials rule
  refuses AI v2 without a key, as in prod.

### D9. Companion (dev only): pinned Bitfocus image plus the packaged module
`docker/companion.Dockerfile` has two stages.

**`module` stage** (node 22 base):
1. Copy the root `package.json` and `package-lock.json` (so the base override applies),
   then `companion/`: `package.json`, `tsconfig.json`, `src/`, `scripts/`, `companion/`.
2. `npm ci --workspace=companion --include-workspace-root=false`.
3. `npm run build -w companion`, then `npm run package -w companion`.
4. Extract `pkg/` to `/module/autologger`. Copy `@companion-module/base` (1.14.x, asserted)
   into `/module/autologger/node_modules/`. Companion 4.3.4 treats `--extra-module-path`
   modules as unpackaged, and reads the module API version from
   `@companion-module/base/package.json`; an empty `node_modules/` fails with "Cannot find
   module" (found at task 5.2). The non-empty directory also makes the entrypoint skip its
   yarn install.
5. Assert the packaged manifest's `runtime.apiVersion` starts with `1.14.`.

**Runtime stage:** `FROM ghcr.io/bitfocus/companion/companion:v4.3.4@sha256:7fdd…`, and
`COPY --from=module` to `/app/module-local-dev/autologger`.

The build uses `docker/companion.Dockerfile.dockerignore`, which *replaces* the root
`.dockerignore`. It is written in allowlist form:
1. `*`
2. `!package.json`, `!package-lock.json`, `!companion/**`
3. re-exclude `**/node_modules`, `**/dist`, `**/pkg`, `**/*.tgz`, `**/.env*`, `**/.npmrc`, `**/*.pem`,
   `**/*.key`, `**/id_*`, `**/.git*`

Service settings:
- It runs as `companion`, with `cap_drop: [ALL]` and `no-new-privileges`, on the `dev`
  network, with the `dev-companion` volume.
- Its admin UI is gated like the app. A `companion-gate` Caddy sidecar with
  `network_mode: service:companion` listens on `:8001` and forwards to `127.0.0.1:8000`.
- It allows `Host` `127.0.0.1:{$DEV_COMPANION_PORT}` or `localhost:{$DEV_COMPANION_PORT}`,
  and applies the same Origin rule.
- `companion` declares `127.0.0.1:${DEV_COMPANION_PORT:-8000}:8001`.

`companion` sets `command: ["--admin-address", "127.0.0.1"]`: the image entrypoint passes its own
`--admin-address ::` first and appends `"$@"`, and the later flag wins (verified: from the host,
`curl -H 'Host: evil.example' http://<container-ip>:8000/` is 200 without it and refused with it). The
ungated admin UI therefore listens on loopback inside the namespace, reachable only by the gate sidecar.
Residual (phase-5 fix wave): Companion 4.3.4's Satellite TCP `16622` and WebSocket `16623` listeners are
hard-coded on `0.0.0.0` with no CLI flag, env var, or user-config key to disable or rebind them
(`main.js --help` lists none; the services are constructed without an enable key). They stay reachable
ungated from the dev network and, via the fixed bridge IP, from the host. They are never published.

The base URL to enter is `http://app:8787`, i.e. the app's gate. The gate allows
`Host: app:8787`. No token is needed, since dev is anonymous.

Alternatives considered:
- *Bind-mounting `companion/` as a dev module.* Rejected: the entrypoint yarn-installs into
  the host tree, and the base-version hoisting hazard applies.
- *Importing the tgz through the UI.* Rejected: manual on every rebuild.

### D10. Companion connection config is entered once in the UI (G2)
There is no supported env or CLI seeding in 4.3.4. `make dev-up` prints the Companion URL
and the base URL to enter. The config persists in `dev-companion`.

### D11. Static invariant check via `docker compose config` + `jq`, not vitest
`check-envs.sh` resolves each project with
`docker compose config --no-env-resolution --format json`, using placeholder `--env-file`s
in a temp dir. `--no-env-resolution` matters: otherwise `config` inlines the `env_file`
contents, which would print secrets (panel-verified). Literal pins are checked on the raw
YAML text.

Invariant 11 (`docker/.env` must not exist) closes a hand-typed path: compose auto-reads `.env` from the project directory, which is `docker/` when `compose.dev.yaml` is run without `--project-directory .`. So a `cp docker/.env.example docker/.env` would feed prod values into dev interpolation (failure & abuse m11).

`dev-up` and `stage-up` run their project's check first. The check covers only invariants
whose failure is **silent**. Name, subnet, and port collisions fail loudly at `up`, so they
are not checked, except the 8080 rule: that collision is silent whenever prod is down.

It is not part of `npm test`, for three reasons:
- There is no hoisted YAML parser, and `npm install` is blocked on this host.
- Only compose reproduces compose's merge semantics.
- `npm test` must not need docker.

Correctness is shown by mutation (task 7.3).

### D12. The dev target lives in `docker/Dockerfile`
It reuses `manifests`, `tools`, and the claude pin, so they cannot drift.
`docker-bake.hcl` names only `web` and `api`, so `dev` is never baked or pushed. Companion
has its own Dockerfile because its base, context rules, and lifecycle differ.

### D13. Ports, subnets, names

| Project | Host ports (all `127.0.0.1`) | Subnets | Fixed names |
|---|---|---|---|
| prod `autologger` | router `ROUTER_PORT` 8080 | 172.28.10.0/24, 172.28.11.0/24 | `autologger-api` |
| stage `autologger-stage` | router `STAGE_PORT` 8788 | 172.28.20.0/24, 172.28.21.0/24 | `autologger-stage-api` |
| dev `autologger-dev` | app gate `DEV_PORT` 8787; Companion gate `DEV_COMPANION_PORT` 8000 | 172.28.30.0/24 | `autologger-dev-app` |

Dev's 8787 collides with a host `npm run dev`; run one or the other, or set `DEV_PORT`.
`alg-e2e` still uses the prod subnets (follow-up).

### D14. Prod targets (G7)
- **`prod-push`:**
  1. Refuse unless `git status --porcelain` is empty and the branch is `main`.
  2. Verify the builder (`BUILDER ?= autologger-multi`) lists `linux/amd64` and
     `linux/arm64`; if not, print the binfmt hint.
  3. Run `GIT_SHA=$(git rev-parse --short=12 HEAD) docker buildx bake -f docker-bake.hcl
     --builder $(BUILDER) --push`.
- **`prod-build`:** runs `GIT_SHA=local docker buildx bake -f docker-bake.hcl --set
  '*.platform=linux/<native>' --load`, which tags `…:local`. It never uses a SHA tag, so a
  pulled release is never overwritten.
- **`prod-pull`, `prod-down`, `prod-logs`:** plain wrappers.
- **`prod-up`:** the same clean/main guard as `prod-push`, then `docker compose up -d` with
  `compose.yaml` and `.env`. It requires `WEB_TAG`/`API_TAG` and adds no overlay.
- **No destructive prod target exists.**

## Risks / Trade-offs

- **The dev gate is the only thing between the loopback-bound app and the dev network or
  host.** Its Host and Origin rules are security-critical.
  → The phase-4 review, plus smokes for a foreign `Host`, a foreign `Origin` on POST and on
  upgrade, and HMR and session-WS success. Literal pins and loopback publishing are checked.
- **The shared Claude credentials file (D4).**
  → Accepted by the owner. Only the one file is mounted, and server turns load no host
  settings. Bind liveness is verified at 4.5; if it fails, apply stops and routes to the
  owner.
- **File watching over bind mounts** is Linux-targeted; Docker Desktop needs polling.
  → Documented. Task 4.5 measures it.
- **`companion-module-build` resolves the base from the root.**
  → Copy the root manifest and lockfile, and assert `apiVersion` in the build.
- **The Caddyfile edit touches a prod file.**
  → Byte-identical adapted-JSON baseline in `make check`, plus `e2e:container`.
- **Stage OAuth needs owner setup.**
  → Documented. Stage sign-in is owner-run (9.4).
- **`network_mode: service:app` couples the gate's lifecycle to `app`.** Recreating `app`
  requires recreating the gate.
  → Compose handles this via `depends_on`. Verified in the smokes.

## Migration Plan

The change is additive. In prod, only the Caddyfile placeholders change, and their
defaults are byte-identical. Rollback is reverting the branch. Dev and stage volumes are
project-scoped; `make {dev,stage}-reset CONFIRM=yes` removes them. The host credentials file
bind is never removed or reset.

## Open Questions

None open. G1–G7 are decided (see the gate record below).

## Panel & review log

*(Pre-panel fact-check pass: not run. This is a code/infra change, and CLAUDE.md scopes the
pass to process changes.)*

**2026-09-29 — adversarial panel.** Four opus reviewers: requirements, assumptions, failure
& abuse, scope. All were read-only. The assumptions reviewer verified the compose, Caddy,
and Companion premises on scratch copies and upstream sources.

### Blockers/majors fixed in place
1. **Stage read prod's `.env` for interpolation** (assumptions M1, failure & abuse M3,
   requirements 5; verified).
   - Fixed with `--env-file` on every dev and stage target, and placeholders for all three
     `:?` variables.
   - The stage port comes from `STAGE_PORT` only, via `ports: !override`.
   - The check has an 8080 rule.
2. **Dev relative paths resolved under `docker/`** (assumptions M2, requirements 10;
   verified). Fixed with `--project-directory .`. The check asserts bind sources exist
   under source subtrees.
3. **`check-envs.sh` would inline secrets** (assumptions M3; verified). Fixed with
   `--no-env-resolution` and placeholder env files.
4. **The Companion build omitted `tsc`** (assumptions M4). Added
   `npm run build -w companion`.
5. **The "other network → 403" scenario was false, and the allowlist over-claimed**
   (assumptions M5, requirements 2, scope m5). The scenario was removed. G1 then removed
   the allowlist entirely (D3).
6. **The "manifest version offered" scenario could not pass**, because dev modules report
   `dev` (assumptions M6). The scenario now asserts a dev module plus the packaged
   `apiVersion`.
7. **Project identity lived only in `-p`** (failure & abuse M2).
   - Each file now declares `name:`.
   - Resets verify the resolved name.
   - Nothing prunes.
   - The check verifies names without `-p`.
8. **Overridable pins; Caddy placeholder injection** (failure & abuse M4).
   - The check requires literal pins.
   - Gateway values must be IPv4, and are never set in `compose.yaml`.
   - The adapted-JSON baseline is part of `make check`.
9. **The Companion ignore file replaces the root `.dockerignore`** (failure & abuse M6,
   assumptions m4). It is now in allowlist form, and the check asserts it.
10. **The `prod-push` dirty check missed untracked files** (requirements 4, failure & abuse
    M5, assumptions m2). It now uses `git status --porcelain`, and there is an amd64
    preflight (assumptions m3).
11. **The check only ran on request** (scope M1). `dev-up` and `stage-up` now depend on it.
    Loud-failing collision rules were trimmed.
12. **Integration coverage** (requirements 9). Every gated endpoint is now in a scenario.
13. **Dev Companion had no scenario** (requirements 8). Added.
14. **New packages silently missing from the dev mounts** (requirements 11, scope m8). The
    check now asserts one mount per package.
15. **Template naming and cookie sharing** (failure & abuse m7, m9). Templates are
    `docker/.env.{dev,stage}.example`, and stage uses `SESSION_COOKIE=autologger_stage_sid`.
16. **Measured premise:** host `npm run dev` binds `0.0.0.0` here (failure & abuse m10).
    Recorded.

### Escalated to the gate — decisions (owner, 2026-09-29)
- **G1 — AI v2 / Claude credentials.** The owner first answered "pass local ~/.claude* as
  volumes into dev/stage". Clarified: the goal is "mainly to skip the login and still make
  AI v2 work". Mounting credentials alone cannot satisfy the bind rule, so an alternative
  was presented and **adopted: "Adopt, mount dev only, stage should behave the same as
  prod"**:
  - dev loopback-binds behind the gate sidecar (D3);
  - the host `~/.claude` and `~/.claude.json` are mounted rw into dev only (D4);
  - **amended by the owner before apply** (2026-09-29): only `~/.claude/.credentials.json` is
    mounted, read-write. The rest of the container home is the `dev-home` volume (D4);
  - stage keeps its own named-volume login, and needs a key for AI v2 (D5, D8).
- **G2 — Companion connection config.** Manual, once (D10).
- **G3 — Caddyfile gateways.** Parameterized with defaults, plus hardening (D7).
- **G4 — Dev sign-in.** Optional in dev (D3's pinned `PUBLIC_BASE_URL`; `GOOGLE_*`
  settable). The empty-shows caveat is documented.
- **G5 — Rebinding.** Host/Origin gate in front of the dev app and dev Companion. This is
  merged with G1's sidecar (D3, D9).
- **G6 — Companion scope.** Dev only (D9). Stage tests the scoped token with `curl`.
- **G7 — Prod guards.** "Same, keep prod-build :local":
  - `prod-push` and `prod-up` require a clean tree on `main`;
  - `prod-build` tags `:local`, never a SHA (D14).

### Minors accepted as residual
- A compromised dependency in the dev or Companion container can read the mounted Claude
  login and `.env.dev`, and egress is unrestricted (failure & abuse m8). Documented: use
  low-limit keys, and never prod secrets. The G1 decision widens this to the operator's
  real login; the owner accepted that.
- Docker's default pools include `172.28.0.0/16` (assumptions m6). Documented.
- The `dev-next` volume survives `dev-build` (assumptions m7). Documented.
- `e2e:visual` stays in the final gates per `openspec/config.yaml` despite the host-baseline
  failure (scope m4). Counts are compared to main.
- A pattern-rule Makefile (scope m2) is optional. Explicit targets are kept.
- The Companion Satellite ports 16622/16623 are reachable ungated from the dev network and the host bridge IP; no off-switch in 4.3.4 (D9).

**2026-09-29 — post-gate consistency read** (light tier; proposal.md, design.md, spec.md, and tasks.md read). The stale-language scan was clean. Ten findings, all fixed:
1. Task reference corrected from 4.4 to 4.5.
2. Gate `LISTEN_PORT` added, and `GATE_PORT` defaults set, in 4.2/4.3/5.2.
3. Spec's Origin rule changed to non-GET/HEAD.
4. Rationale for invariant 11 added to D11.
5. Mutations added for invariants 3, 8, and 11.
6. Verifying steps added for the full gated-feature list, the prune grep, the emulation preflight, and plain `make`.
7. Task 7.2 now lists named targets, `--project-directory`, placeholders, and the `prod-up` tag guard.
8. Spec exception added for the read-only gate Caddyfile mount.
9. Port defaults written into the spec.
10. The migrations mount made explicit.

**2026-09-29 — owner amendment before apply, plus consistency read of the edit.** The owner
narrowed G1's mount from all of `~/.claude` and `~/.claude.json` to just
`~/.claude/.credentials.json`, read-write, with a `dev-home` volume for the rest. The edit
touched D4, the Risks, the Migration Plan, and the G1 record in design.md; the dev-isolation
requirement and two scenarios in spec.md; and tasks 2.3, 4.3, 4.5, 7.3 and 8.1. Consistency
read (orchestrator, targeted grep over all four artifacts for `~/.claude`/`.claude.json`
references): one stale phrase was fixed ("a mounted host `~/.claude/settings.json`",
Current state). The remaining hits are deliberate negations or history.

**2026-09-29 — owner pre-apply answers.**
1. Paid smoke calls: Claude features only. YouTube, Sheets, and DeepGram are verified without egress (task 4.5).
2. Apply creates the env templates; the owner fills in `.env.dev` and `.env.stage` (tasks 2.3/2.4).
3. Apply commits as it goes on the branch; no push or merge unless asked.

**2026-09-29 — phase-4 review I1, owner decision (path 1).** The credentials bind was verified live for inode, hash, and in-place writes, but no token refresh occurred. So the rename-on-refresh path is **unexercised**, and it is recorded as unverified, not as verified.
- If the in-container CLI refreshes by writing a temp file and renaming it, the refresh is lost (`EBUSY`), and token rotation could log out the host.
- The owner accepted this as a residual, with two mitigations:
  - **detection:** `dev-up` and `check dev` warn when the host and container inodes differ (task 7.2);
  - **documented recovery:** host `claude` re-login, then `make dev-restart` (task 8.1).
- **Follow-up (separate change):** a `claude setup-token` long-lived token passed as `CLAUDE_CODE_OAUTH_TOKEN`. This needs the AI chat and AI v2 child-env allowlists (and the ai-runtime spec) widened for that one variable. Once it lands, the dev credentials-file mount can be removed.

**2026-09-29 — phase-5 review, owner decision.**
- **Finding:** I1, Companion's ungated admin UI reachable from the host via the bridge IP.
- **Fix:** fixed in `0b8e912` with `--admin-address 127.0.0.1`. This was demonstrated red then green, and the mutation was re-executed by the re-reviewer.
- **Satellite ports 16622/16623:** these are hard-bound on `0.0.0.0` in Companion 4.3.4 and stay host-reachable via the container IP (not from the LAN). The owner **accepted this as a residual**. It was rated Low: presses reach only the dev `/api/companion/log|transport|command`, with no spend and no secrets.
- **Rejected alternative:** an isolated-gateway network plus a forwarder container, proven live by the reviewer. It was rejected because it cuts Companion's internet and LAN access and adds a container.
- **Also residual:** Companion sends Sentry error reports by default. Only the user-config key `detailed_data_collection` controls this, and it is not seeded. Documented in 8.1.

**2026-09-29 — phase-7 review.** The review found three Important items; two fix waves closed them, and each fix shipped with a demonstrated red→green run plus a re-executed mutation (`a6ebbb4`, `9550092`, `4959dd4`):
- **I1:** a `COMPOSE_PROJECT_NAME` in an env file could re-target dev or stage onto the prod project.
- **I2:** the port guard failed open on `export`, indentation, `X = Y`, and shell-env forms.
- **I3 + N1:** home and ancestor bind sources, including non-normalized spellings, escaped invariant 8.

The `make-guards.sh envfile` guard now checks the *resolved* config (project name, loopback ports, numeric ports that are not 8080, no `COMPOSE_*` keys). `check-envs.sh` normalizes bind sources lexically; symlinks are not resolved.

**Accepted residual (N2, outside the spec's invariants):** the check does not enforce any of the following. Adding them would need a spec change.
- a service allowlist for stage;
- `cap_add`, `pid: host`, or `devices` on any service;
- a bind of `/var/run/docker.sock`.

Dev does enforce an exact four-service set, plus no `network_mode: host` and no `privileged`.

**2026-09-29 — whole-branch audit (task 9.5).** Result: PASS, with 0 Critical, 0 Important and 9 Minor findings. All nine Minors were fixed in `dcac51c` and `f30298e`, and a scoped re-review confirmed the fixes, with red/green re-executed for M5, M6 and M8.
- **Frozen HTTP/WS surface:** no delta. No TS changed, and the prod router adapted config is byte-identical.
- **Seams:** S1 and S2 hold.
- **Tree hygiene:** 23 files. The only flag was `README.md` at 141,957 B; it was already 127,784 B at the base, so this was accepted.

Residuals to carry into the archive:
- The credentials rename-on-refresh path was never exercised (detector and recovery are documented).
- Companion Satellite ports 16622/16623 are reachable from the host through the container IP.
- Companion sends Sentry error reports by default.
- The context-audit listing is printed only on uncached builds.
- N2: no stage service or capability allowlist.
- The port guard rejects quoted values.
- `STAGE_PORT=80` is allowed.
- DeepGram-configured transcription and the Google sign-ins are owner-verified only (task 9.4).
- Bind normalization is lexical; symlinks are not resolved.

Follow-ups:
- A `claude setup-token` path to replace the credentials bind; this needs a server child-env allowlist change.
- An isolated-gateway Companion network.
- Seeding `detailed_data_collection`.
- The Companion "Presets reference action definitions" startup warning.
- A binfmt/amd64 builder before the first `prod-push`.
- Letting `e2e:container` run alongside a live prod stack.

Invariants the merge must not disturb:
- The Caddyfile adapt stays byte-equal to the baseline.
- `compose.yaml` never sets `ROUTER_FRONT_GW` or `ROUTER_BACK_GW`.
- `compose-env.sh` stays the single source of compose invocations.
- Dev posture pins stay literals.
- The only rw bind is `~/.claude/.credentials.json`.
- `server/data` is never mounted.

**2026-09-29 — owner verification (task 9.4).** The owner reports that every check passed:
- stage Google sign-in round-trip on `http://localhost:8788` (callback, session cookie, `/api/profile`);
- dev Companion driven by hand;
- DeepGram transcript generation in dev with a configured key.

This closes the "owner-verified only" residual for sign-in and DeepGram.
