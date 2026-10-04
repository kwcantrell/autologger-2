# Public stage behind an HTTPS edge, from pushed registry images

Tier: 2
Tier reason: changes the session-cookie posture (`COOKIE_SECURE`) and the OAuth redirect origin of
a stack that becomes reachable from the internet, and adds operator inputs to the compose wrapper
that handles secrets (auth, sessions, secrets handling; security-sensitive, so human-led).

Approved-by: Kalen 2026-10-03

## Why

Stage is moving to a cloud host (`stage-linode`, built by `~/spark-infra`) that has no build
toolchain and must be reachable by testers outside the LAN. Today stage can only:
- build `web`/`api` locally (`make stage-up` runs `compose up -d --build`), and
- serve `http://localhost:${STAGE_PORT}` with `COOKIE_SECURE=0` and a localhost OAuth redirect.

The owner chose a Cloudflare Tunnel with Cloudflare Access in front (owner, 2026-10-03): the
`cloudflared` connector runs on the stage host and proxies `https://stage.<domain>` to the
router's loopback port `http://127.0.0.1:8788`. Nothing listens on a public interface, and Access
authenticates every request before it reaches the origin.

For that, stage needs two operator switches: run images pushed for one commit instead of
building, and serve a public HTTPS origin with a `Secure` session cookie. Unset, stage must stay
exactly today's local stage.

## What Changes

- **`make stage-push STAGE_IMAGE_TAG=<sha>`** (new). On a clean tree whose `HEAD` is exactly
  `<sha>` (any branch), bake `docker-bake.hcl` for `STAGE_PLATFORMS` (default `linux/amd64`) with
  the `autologger-multi` builder and push `ghcr.io/kwcantrell/autologger-{web,api}:<sha>`.
  `<sha>` must be the full 40-character lowercase hex SHA. Guards: `make-guards.sh stage-git`,
  `stage-platforms`, and the existing `prod-builder`.
- **`make stage-up STAGE_IMAGE_TAG=<sha> STAGE_PUBLIC_BASE_URL=https://stage.<domain>`**:
  `compose pull web api`, the migrations, then `compose up -d --no-build`. `compose-run.mjs`
  refuses any build step while a tag is set. A tag requires the public URL (a tagged run is a
  public run), and the tree `make` runs in must be the tagged commit (git `HEAD`, or a `REVISION`
  file where there is no `.git`), because migrations, Caddyfiles and compose files come from it.
- **`STAGE_PUBLIC_BASE_URL=https://stage.<domain>`** (with or without a tag): the api's
  `PUBLIC_BASE_URL` becomes that origin and `COOKIE_SECURE=1`. `TRUST_PROXY=1` and the
  loopback-only published port `127.0.0.1:${STAGE_PORT}` are unchanged.
- **One `RUN` macro** in the Makefile passes `CONFIRM`, `STAGE_IMAGE_TAG`,
  `STAGE_PUBLIC_BASE_URL` and `DOCKER_CONFIG` to `compose-run.mjs` by name for every target
  (replacing the separate `RUN_CONFIRM`, which spliced `CONFIRM` into the recipe text).
- **Validation, stage only** (`docker/scripts/compose-run.mjs`), before any OpenBao request:
  - `STAGE_IMAGE_TAG` matches `^[0-9a-f]{40}$`;
  - `STAGE_PUBLIC_BASE_URL` is a bare `https://<dns name>` (no port, path, query, fragment, user,
    IP literal, `localhost` or uppercase); unset means the local stage;
  - `STAGE_IMAGE_TAG` requires `STAGE_PUBLIC_BASE_URL`, and the tree must be the tagged commit;
  - `DOCKER_CONFIG` (optional, **tagged runs only**, for the registry login `compose pull` uses;
    ignored without a tag) is an absolute directory of plain characters, owned by the caller, not
    a symlink, not group/other-writable (and so is its `config.json`). It is only read: compose
    gets the wrapper's own temporary 0700 directory holding just the caller's inline `auths`
    (a `credsStore`/`credHelpers` is refused), plus `DOCKER_CONTEXT=default`; the directory is
    removed on exit, failure or signal;
  - without a tag, a pinned tree (`REVISION` and no `.git`) refuses `up`, `build` and `run`;
  - `STAGE_IMAGE_TAG` / `STAGE_PUBLIC_BASE_URL` are refused for dev and prod;
  - none of `STAGE_IMAGE_TAG`, `STAGE_WEB_IMAGE`, `STAGE_API_IMAGE`, `STAGE_PUBLIC_BASE_URL`,
    `STAGE_COOKIE_SECURE`, `DOCKER_CONFIG` can come from OpenBao (not in any allowlist).
- **Resolved-config guard** (`resolved` step, stage): `web`/`api` run exactly the expected images
  (`:local` without a tag), `PUBLIC_BASE_URL` and `COOKIE_SECURE` match the options, and
  `TRUST_PROXY` is `1`.
- **`docker/compose.stage.yaml`**: image names, `PUBLIC_BASE_URL` and `COOKIE_SECURE` read
  `STAGE_WEB_IMAGE`, `STAGE_API_IMAGE`, `STAGE_PUBLIC_BASE_URL`, `STAGE_COOKIE_SECURE`, whose
  defaults are today's values. Only `compose-run.mjs` sets them.
- **Static check** (`check-envs.sh`, invariant 7): unset, stage resolves to the `:local` images and
  `COOKIE_SECURE=0`; with the public variables it resolves to the ghcr images, the https origin,
  `COOKIE_SECURE=1` and the loopback port. Two new regression cases in `test_check_envs.sh`.
- **README**: a "Public stage (HTTPS edge)" section, the target table, the environment table, the
  OAuth note (add `https://stage.<domain>/auth/google/callback` to the stage OAuth client), the
  tree-must-be-the-commit rule, the public-host rollback, and that the Access policy is the only
  membership control.
- **`~/spark-infra` (coordinated, separate repo):** the pinned deploy
  (`roles/autologger_env/tasks/sync_pinned.yml`) writes `REVISION` (the full commit) into the
  `git archive` export before the rsync, and removes a stale `.git` at the destination, so the host
  tree satisfies the tree check (committed in 27430a9, the `.git` removal after re-panel). Its
  `up.yml` requires the public URL, refuses a tree without this change before `make`, writes the
  pull login as an inline `config.json` `auth` (no `docker login`, which may write `credsStore`),
  and after `make` checks the running api/web images and posture, stopping the stack on a mismatch.
  The deployed and any rollback SHA must contain this change.

## Decisions (owner, 2026-10-03)

- **Edge: Cloudflare Tunnel + Cloudflare Access**, connector on the stage host, origin
  `http://127.0.0.1:8788`. Configured in `~/spark-infra` (`cloudflared` role), not here.
- **Images come from GHCR**, the same `ghcr.io/kwcantrell/autologger-{web,api}` repositories as
  prod, pushed from the Spark build host (arm64) for `linux/amd64` through the existing
  `autologger-multi` builder.
- **Supabase public URLs stay `http://localhost:${SUPABASE_PORT}`**: no browser code calls the
  Supabase gateway, GoTrue or storage (design, assumption A6), so no public Supabase hostname.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-container-environments`:
  - modified: "Stage behaves as production, with local sign-in" (images, origin and cookie posture
    are the local defaults unless the operator passes the public values);
  - added: "Stage can run pushed images behind a public HTTPS edge";
  - added: "Stage images are pushed only from a clean commit, under full-SHA tags".

This change is stacked on `openbao-secrets` (not yet merged). Its MODIFIED Stage requirement is
written against `openbao-secrets`' version of that requirement (OpenBao wording), so
`openbao-secrets` must be archived first. Task 5.1 makes that a checked step: archiving refuses
while `openspec/changes/openbao-secrets/` exists and re-diffs the MODIFIED block first.

## Non-goals

- Configuring the tunnel, Cloudflare Access policies, DNS, the cloud host, its firewall or
  `cloudflared` (that is `~/spark-infra`).
- Verifying the Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`) at the origin, and a sign-up
  allowlist in the app. Today the Access policy is the only membership control (the app creates a
  user for any unseen Google account); the edge-side check of the Access token is the tunnel
  connector's `access.required` (in `~/spark-infra`). Both are possible follow-ups.
- Exposing the Supabase gateway, GoTrue or storage publicly.
- Changing prod: `prod-push`, `prod-up`, its tags, guards or compose file are untouched.
- Restricting which tag prod may pin (prod still only refuses unset or `latest`).
- Changing the HTTP/WS contract, the router (Caddyfile) or the server's cookie logic.
- Porting `make-guards.sh` to Node (`node-stack-tooling`).

## Impact

- **Files:** `Makefile`, `README.md`, `docker/compose.stage.yaml`, `docker/scripts/compose-run.mjs`
  and its test, `docker/scripts/check-envs.sh`, `docker/scripts/test_check_envs.sh`,
  `docker/scripts/make-guards.sh`. In `~/spark-infra`: `roles/autologger_env/tasks/sync_pinned.yml`,
  `roles/autologger_env/tasks/up.yml`, `roles/autologger_env/defaults/main.yml`, its README and
  `docs/roles.md`.
- **Operators:** unchanged unless they pass the new variables. A public stage additionally needs a
  GHCR read login on the stage host, the tunnel and Access application, and the extra OAuth
  redirect URI on the stage Google client.
- **Security posture:** stage becomes internet-reachable behind Access; its cookie gains `Secure`.
  Residual: any process on the stage host can still reach the loopback port without passing
  Access (as documented for prod).
- No HTTP/WS contract change. No app code change.
