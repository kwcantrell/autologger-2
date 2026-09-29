**Proportionality.** This change touches no server, web, or companion *source*, so
`npm test` and `npm run typecheck` cannot move. They still run once at branch completion
(9.1), as CLAUDE.md requires. Each phase is gated by its own checks: `make check`,
`docker compose config`, image builds, and live smokes. Evidence goes in the ledger.

**Anchors are orientation only.** Locate code by its content before editing.

**Protect live data.**
- Never mount, copy into, or point `DATA_DIR` at `server/data`.
- Never run `npm install` or `npm ci` on the host.
- Never print values from `.env`, `server/.env`, `.env.dev`, `.env.stage`, or `~/.claude*`.
- Never delete or reset the host `~/.claude`.

## 1. Plan of record

- [x] 1.1 Make the gated OpenSpec artifacts the branch's first commit, before any dispatch:
      `docs(openspec): propose containerized-dev-env`.

## 2. Env-file hygiene

- [x] 2.1 `.gitignore`: add `.env.*` and `!*.example`. Verify:
      - `git check-ignore .env .env.dev .env.stage` reports all three as ignored;
      - `docker/.env.example`, `docker/.env.dev.example`, `docker/.env.stage.example`, and
        `server/.env.example` are not ignored.
- [x] 2.2 `docker/.env.example`:
      - Rewrite the closing note: `PUBLIC_BASE_URL` **must** be set here, because compose
        interpolates it. The other pinned keys have no effect here.
      - Add `# e.g. WEB_TAG=6ca18cd906f8 (12-char SHA from make prod-push)`.
- [x] 2.3 Add `docker/.env.dev.example` (copied to `.env.dev`). It lists:
      - optional `DEEPGRAM_API_KEY`, `SHEETS_LOG_IMPORT_ENABLED`, `AI_V2_ENABLED`,
        `AI_V2_API_KEY`, and `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`;
      - `DEV_PORT` and `DEV_COMPANION_PORT`.

      The owner fills in the values. Apply never writes or reads real values. If `.env.dev`
      is missing at 4.4, copy the template with empty values and note it in the ledger.

      Its notes cover:
      - the optional sign-in redirect URI, and the empty-shows caveat;
      - that the Claude login comes from the host `~/.claude/.credentials.json` (the only
        host file dev mounts);
      - the warning never to use prod secrets, and to use low-limit keys;
      - the posture keys that compose pins.
- [x] 2.4 Add `docker/.env.stage.example` (copied to `.env.stage`). It lists:
      - `STAGE_PORT=8788`;
      - the dev OAuth client id and secret;
      - distinct `API_TOKEN` and `ADMIN_TOKEN`;
      - optional `AI_V2_API_KEY` and `DEEPGRAM_API_KEY`.

      The owner fills in the values. If `.env.stage` is missing at 6.2, use generated
      throwaway tokens and dummy OAuth values in a temp file, and leave sign-in to 9.4.

      Its notes cover:
      - the redirect URI;
      - to use `localhost`, not `127.0.0.1`;
      - that tokens must differ from prod's.

## 3. Router gateway parameterization (G3; security-sensitive, reviewed with phase 6)

- [x] 3.1 In the pinned Caddy image, run `caddy adapt --config docker/Caddyfile` and commit
      the output as `docker/scripts/caddy-adapt.baseline.json`. Replace the
      `trusted_proxies static` literals with
      `{$ROUTER_FRONT_GW:172.28.10.1} {$ROUTER_BACK_GW:172.28.11.1}`. Then show:
      - re-adapting with nothing set equals the baseline byte-for-byte;
      - adapting with the stage values differs only in the two addresses.

      Record both diffs.

## 4. Dev environment (security-sensitive posture → phase review)

- [x] 4.1 `docker/Dockerfile`: add a `dev-deps` stage. It runs `npm ci` for `server`,
      `web`, and `packages/*`, dev deps included, on the target platform, with the build
      toolchain.

      Add a `dev` stage:
      - the node base;
      - claude-code at the shared `CLAUDE_CODE_VERSION` ARG;
      - `COPY --from=tools /opt/ytdlp`;
      - the deps and the baked configs (root, server, web `package.json`s and tsconfigs,
        `next.config.ts`, `postcss.config.mjs`, `next-env.d.ts`);
      - `/app` and `/data` chowned to `node`, and `/home/node` existing;
      - `USER node`, `CMD ["npm","run","dev"]`.

      Verify:
      - `docker buildx bake -f docker-bake.hcl --print` lists only `web` and `api`;
      - the `api` target's stage graph is unchanged.
- [x] 4.2 Add `docker/dev-gate.Caddyfile`, per D3/D9. It covers:
      - the Host allowlist: `127.0.0.1:{$GATE_PORT}` and `localhost:{$GATE_PORT}`, plus
        optional `{$GATE_EXTRA_HOST}` for `app:8787`;
      - the listen address `:{$LISTEN_PORT}`;
      - the Origin rule on non-GET/HEAD requests and on `Upgrade`;
      - `reverse_proxy 127.0.0.1:{$UPSTREAM_PORT}`, with WebSocket passthrough;
      - no `encode`.

      One file serves both gates, parameterized by env.
- [x] 4.3 Add `docker/compose.dev.yaml`, with `name: autologger-dev`, per D2–D4 and D13:
      - service `app` (`container_name: autologger-dev-app`), with:
        - the literal pins;
        - `PUBLIC_BASE_URL=http://localhost:${DEV_PORT:-8787}`;
        - `env_file` `.env.dev`, `required: true`;
        - the `:ro` subtree mounts, including `packages/catalog/migrations`;
        - a rw single-file bind of `${HOME}/.claude/.credentials.json` at
          `/home/node/.claude/.credentials.json`;
        - the `dev-home` volume at `/home/node`;
        - volumes `dev-data` and `dev-next`;
        - network `dev` at `172.28.30.0/24`;
        - `ports: ["127.0.0.1:${DEV_PORT:-8787}:8787"]`;
        - `init`, `cap_drop: [ALL]`, `no-new-privileges`;
        - a healthcheck of `GET 127.0.0.1:8786/api/profile`.
      - service `app-gate`:
        - the pinned Caddy image, with `network_mode: service:app`;
        - the gate Caddyfile mounted `:ro`;
        - env `LISTEN_PORT=8787`, `GATE_PORT=${DEV_PORT:-8787}`, `UPSTREAM_PORT=8786`,
          `GATE_EXTRA_HOST=app:8787`;
        - non-root, `read_only`, tmpfs.
- [x] 4.4 Live smoke on this host:
      - no open-network warning appears, and the startup log shows a loopback bind;
      - `/` and `/api/profile` answer on `127.0.0.1:8787`;
      - `/app/server/.env` and `/app/server/data` are absent;
      - `claude --version` and `/opt/ytdlp/yt-dlp --version` run;
      - the gate rejects `Host: evil.example:8787`;
      - the gate rejects a POST with `Origin: https://evil.example`;
      - the gate rejects an `Upgrade` with a foreign Origin;
      - the host's LAN IP on 8787 is refused;
      - `ss` inside the namespace shows the app only on `127.0.0.1:8786`.
- [x] 4.5 Hot reload and Claude:
      - Touch a `server/src` file and confirm the tsx restart.
      - Edit a `web/src` string and confirm the HMR update in agent-browser, then revert.
        Record the latency.
      - Confirm the session WebSocket connects through the gate.
      - Verify the credentials single-file bind stays live (D4):
        - record the host file's inode;
        - run an AI chat turn on a scratch session;
        - check the container sees no `EBUSY` and the inode is unchanged;
        - check the container sees the host file's current contents (compare hashes,
          never print contents).

        Also check the CLI runs with no host `~/.claude.json`, and that nothing new appears
        under the host `~/.claude` except that file's mtime. If any check fails, stop and
        route to the owner (D4).
      - **Paid calls: Claude features only** (owner, 2026-09-29). Run real turns for AI chat,
        `topics/generate`, `events/generate`, and an AI v2 design turn (`AI_V2_ENABLED=1`, no
        key) on a small scratch session. None may be `503`.
      - For YouTube import, Sheets log import, and transcript generation, make **no
        outbound calls**. Show each is not refused as unconfigured or open-network, using a
        request that fails validation before any egress (e.g. an invalid URL or sheet id →
        `4xx`, not `503`). DeepGram is checked only if the owner set `DEEPGRAM_API_KEY`;
        otherwise record its expected `503` and leave it to the owner.
- [x] 4.6 Phase review over the Dockerfile, gate, and compose diffs and the 4.4/4.5
      evidence. Security focus: the gate rules, loopback reach, and mounts.

## 5. Dev Companion

- [x] 5.1 Add `docker/companion.Dockerfile` and `docker/companion.Dockerfile.dockerignore`
      (allowlist form), per D9. Use the digest-pinned `v4.3.4` base. In the build, assert
      that:
      - `runtime.apiVersion` matches `1.14.`;
      - `/module/autologger/node_modules` exists;
      - no file outside the allowlist entered the context (a `find` listing in the build
        log).
- [x] 5.2 In `compose.dev.yaml`, add:
      - service `companion`: `dev` network, `dev-companion` volume, `cap_drop`,
        `ports: ["127.0.0.1:${DEV_COMPANION_PORT:-8000}:8001"]`;
      - service `companion-gate`: `network_mode: service:companion`, `LISTEN_PORT=8001`,
        `GATE_PORT=${DEV_COMPANION_PORT:-8000}`, `UPSTREAM_PORT=8000`.

      Smoke:
      - the UI offers the AutoLogger dev module;
      - a connection with base URL `http://app:8787` reaches status OK;
      - a "log event" action creates an event visible in the dev app;
      - the Companion gate rejects a foreign `Host`.

## 6. Stage environment (phase review, together with phase 3)

- [ ] 6.1 Add `docker/compose.stage.yaml`, with `name: autologger-stage`, per D5–D6. Verify
      with `docker compose -f compose.yaml -f docker/compose.stage.yaml --env-file
      <placeholder> config --no-env-resolution`. The resolved config must show:
      - `REQUIRE_LOGIN=1`, `TRUST_PROXY=1`, `COOKIE_SECURE=0`;
      - `SESSION_COOKIE=autologger_stage_sid`;
      - the stage subnets and gateways, and no `172.28.10`/`.11`;
      - the router on `127.0.0.1:8788`;
      - no host-home binds;
      - project `autologger-stage` without `-p`.
- [ ] 6.2 Live smoke, with the prod-shaped project up alongside if images are available
      (otherwise note it):
      - stage starts with no pool or name conflict;
      - `/` returns `200`, anonymous `/api/sessions` returns `401`, `/teams/` returns `404`;
      - the stage `API_TOKEN` through the router gets `200` on `/api/companion/state` and
        `401` on `/api/sessions`;
      - with `AI_V2_ENABLED=1` and no key, AI v2 is refused.
- [ ] 6.3 Phase review over the phase 3 and phase 6 diffs and their evidence.

## 7. Makefile and invariant check

- [ ] 7.1 Write `docker/scripts/check-envs.sh`, per D11 and all 13 of the spec's invariants.
      It resolves with `--no-env-resolution` and placeholder `--env-file`s in a temp dir,
      and never reads the real env files. It takes an optional argument (`dev`, `stage`,
      `prod`, `all`).
- [ ] 7.2 Write the root `Makefile`, per spec, D1, and D14:
      - `help` is the default goal;
      - named targets: `dev-build`, `dev-up`, `dev-down`, `dev-logs`, `dev-shell`,
        `dev-reset`; `stage-build`, `stage-up`, `stage-down`, `stage-logs`,
        `stage-claude-login`, `stage-reset`; `prod-build`, `prod-push`, `prod-pull`,
        `prod-up`, `prod-down`, `prod-logs`;
      - dev targets pass `--project-directory .` and `--env-file .env.dev`;
      - stage targets pass `--env-file .env.stage` plus placeholders for `WEB_TAG`,
        `API_TAG`, and `PUBLIC_BASE_URL`;
      - `prod-up` fails when `WEB_TAG` or `API_TAG` is unset;
      - the `dev-*`, `stage-*`, and `prod-*` families, plus `check`;
      - `dev-up` and `stage-up` depend on their check;
      - env-file guards that name the template;
      - resets require `CONFIRM=yes` and a resolved-name check;
      - prod guards: clean tree, `main`, the builder platform preflight, and
        `prod-build` tagging `:local`;
      - `dev-restart` restarts `app` then `app-gate` (and `companion` then `companion-gate`),
        because a direct restart of the namespace owner leaves its gate dead (phase-4 M1);
      - `dev-up` (and `check dev`) WARN, without failing, when the inode of the host
        `~/.claude/.credentials.json` differs from the inode the running dev container sees
        (`stat -c %i` on both sides; never read contents). This is the rename-on-refresh
        detector (owner decision, phase-4 I1);
      - `dev-up` and `stage-up` print their URLs (the Companion base URL for dev,
        "use localhost" for stage).

      Verify with `make -n` on each target, and a plain `make` that prints help and starts
      nothing.
- [ ] 7.3 Mutation-check `check-envs.sh`. Each broken copy must fail naming its invariant,
      and the clean tree must pass:
      1. dev port on `0.0.0.0`
      2. dev mount `./server:/app/server`
      3. `HOST: ${DEV_HOST:-127.0.0.1}`
      4. stage `REQUIRE_LOGIN: "0"`
      5. stage port `8080`
      6. a `packages/*` mount removed
      7. `ROUTER_FRONT_GW: private_ranges`
      8. the Caddyfile default changed
      9. `name:` removed from the stage overlay
      10. a leading `*` missing from the Companion ignore file
      11. a dev port targeting the app's 8786 instead of the gate
      12. a stage bind of `${HOME}/.claude/.credentials.json`, and a dev bind of the whole
          `${HOME}/.claude` directory
      13. a `docker/.env` file present

      Also check the Makefile guards:
      - `make dev-reset` without `CONFIRM` leaves volumes intact;
      - `make prod-push` with an untracked file exits before bake;
      - `make stage-up` without `.env.stage` names the template;
      - `make prod-build` creates only `:local` tags;
      - `make prod-push` with a builder missing `linux/amd64` exits with the binfmt hint
        (use a throwaway builder name);
      - grep the Makefile for `down -v`, `--volumes`, `volume rm`, and `prune`: every hit
        belongs to a guarded reset.

## 8. Docs

- [ ] 8.1 Add a README "Local container environments" section, linked from "Container
      deployment". It covers:
      - the target table, and a dev/stage/prod differences table;
      - the dev posture: the loopback bind plus gate, the reach, and "never publish the
        gate beyond loopback";
      - the shared credentials-file residuals, including the unexercised token-refresh path
        and its recovery: host `claude` re-login, then `make dev-restart`. Name `claude
        setup-token` as the planned follow-up;
      - AI v2: works on the login in dev, needs a key in stage and prod;
      - Companion first-run steps and the base URL;
      - optional dev sign-in and the empty-shows caveat;
      - stage OAuth client setup and "use localhost";
      - Linux-only file watching;
      - protecting `server/data`.
- [ ] 8.2 CLAUDE.md: add one line under Setup & commands pointing at `make help` and the
      README section.

## 9. Final gates

- [ ] 9.1 Run `npm run typecheck` and `npm test` for branch completion. Expected to be
      unchanged, since no source changed.
- [ ] 9.2 Run `npm run e2e` and `npm run e2e:visual`. The latter is a known host-baseline
      failure (40/4/4 at `aa05a05`): record the counts versus main and do not re-bless.
- [ ] 9.3 Re-run on the final tree:
      - `make check`;
      - `npm run e2e:container` (prod stack not running);
      - the smokes from 4.4, 4.5, 5.2, and 6.2.
- [ ] 9.4 Owner-run: a stage Google sign-in round-trip on `http://localhost:8788`, and
      optionally a dev one on `http://localhost:8787`.
- [ ] 9.5 Whole-branch layered scoped audit, per the apply skill.
