# Design

## Context

- **Stage today** (`local-container-environments`, "Stage behaves as production, with local
  sign-in"): `compose.yaml` + `docker/compose.stage.yaml`, `web`/`api` built locally as
  `autologger-stage-{web,api}:local`, `PUBLIC_BASE_URL=http://localhost:${STAGE_PORT:-8788}`,
  `COOKIE_SECURE=0`, `TRUST_PROXY=1`, router published only on `127.0.0.1:${STAGE_PORT}`. Every
  `make stage-*` target runs `docker/scripts/compose-run.mjs` under `env -i`; it reads stage's
  secrets from OpenBao (`openbao-secrets`, which this branch is stacked on) and builds the child
  environment from scratch.
- **Where stage is going.** A cloud host built by `~/spark-infra` (`stage-linode`): amd64, no build
  toolchain, reached by testers on the internet. The owner chose a Cloudflare Tunnel connector
  (`cloudflared`) on that host, proxying `https://stage.<domain>` to `http://127.0.0.1:8788`, with
  a Cloudflare Access application in front.
- **Prod images** are pushed by `make prod-push` as `ghcr.io/kwcantrell/autologger-{web,api}:<12-hex>`
  (multi-arch) from a clean `main`. Stage will share those GHCR repositories.
- **The server's cookie rule** (`server/src/env.ts` `cookieSecureForRequest`): an explicit
  `COOKIE_SECURE` of `1/true/yes` or `0/false/no` wins; only when it is unset does
  `X-Forwarded-Proto: https` (with `TRUST_PROXY`) make the cookie `Secure`. Stage pins `0`, so a
  public stage must pin `1` explicitly.

## Goals / Non-Goals

**Goals:**
- Stage can run on a host with no toolchain, from images pushed for exactly one commit.
- A public stage serves an https origin with a `Secure`, `SameSite=Lax` session cookie and the
  matching OAuth redirect URI, with the origin still bound to loopback only.
- Unset, stage is byte-for-byte today's local stage (static check proves it).
- No new value can arrive from OpenBao or the caller's shell other than the three validated
  operator variables (plus `STAGE_PLATFORMS` for `stage-push`, which never reaches compose).

**Non-Goals:** as in proposal.md (tunnel/Access configuration, origin-side Access JWT check,
public Supabase URLs, any prod change).

## Decisions

### D1. Two operator switches, passed by name and validated in one place

`STAGE_IMAGE_TAG` and `STAGE_PUBLIC_BASE_URL` are `make` variables, exported, and handed to
`compose-run.mjs` by name by the single `RUN` macro (`env -i ... CONFIRM="$${CONFIRM-}"
STAGE_IMAGE_TAG="$${STAGE_IMAGE_TAG-}" STAGE_PUBLIC_BASE_URL="$${STAGE_PUBLIC_BASE_URL-}"
DOCKER_CONFIG="$${DOCKER_CONFIG-}" ...`), which every dev/stage/prod target uses (the former
`RUN_CONFIRM`, which spliced `$(CONFIRM)` into recipe text, is gone). The values are never spliced
into the recipe's shell text; `make` itself still expands them (in `ifeq` and `export`), so they
are operator input with the operator's own privileges, not a boundary against untrusted input.
`compose-run.mjs` refuses `STAGE_IMAGE_TAG`/`STAGE_PUBLIC_BASE_URL` for dev and prod and ignores
`DOCKER_CONFIG` unless a stage tag is set (D4). All stage targets therefore validate and resolve with the same
options: `stage-down`/`stage-logs`/`stage-reset` accept them, and `stage-build` (a build step) is
refused while a tag is set, so it always builds `:local`. `compose-run.mjs`
validates them before any OpenBao request (`parseStageOptions`) and then derives the only
variables compose sees: `STAGE_WEB_IMAGE`, `STAGE_API_IMAGE`, `STAGE_PUBLIC_BASE_URL`,
`STAGE_COOKIE_SECURE` (`stageComposeEnv`). `STAGE_IMAGE_TAG` itself never reaches compose.
The Makefile's `ifeq` uses the tag only to pick the step list.

*Why not OpenBao:* these are per-run operator choices, not secrets; keeping them out of every
allowlist means a KV write cannot flip stage to another image or origin (tested).

### D2. Full 40-hex tags only

`STAGE_IMAGE_TAG` must match `^[0-9a-f]{40}$` (both in `make-guards.sh stage-git` and in
`compose-run.mjs`). `prod-push` tags `--short=12` multi-arch images in the same repositories; a
stage push is single-arch by default, so allowing a 12-char tag would let `make stage-push`
overwrite a prod release tag with an amd64-only image. A 40-char tag can never equal a 12-char one.
Uppercase, `latest`, `stage`, and padded values are refused.

### D3. `stage-push` is bound to a clean commit

`stage-git` refuses unless `git status --porcelain` is empty (untracked files count) and
`git rev-parse HEAD` equals the tag, so `ghcr.io/...:<sha>` always holds that commit's sources.
Unlike `prod-git` it does not require `main` (stage tests branches). `stage-platforms` allows
`linux/amd64`, `linux/arm64` or both; `prod-builder` is reused to check the builder. The bake
file, targets and registry are prod's; only `--set *.platform` and `GIT_SHA` differ.

### D4. With a tag, nothing builds

`stage-up` runs `compose pull web api`, `compose run --rm migrate`, `compose up -d --no-build`.
`checkStagePlan` refuses `build`/`--build` and any `up` without `--no-build` while a tag is set,
so a stale local build context can never be run under a registry name. `make stage-build` builds
`:local` and is refused while a tag is set (D1).

**With a tag only**, `DOCKER_CONFIG` may carry the registry login `compose pull` uses (a read-only
GHCR login on the stage host). Without a tag it is ignored, not validated and not forwarded, as for
dev and prod (re-panel RS1): a local stage run never depends on an ambient value. The Makefile's one
`RUN` macro still passes it by name; `parseStageOptions` reads it only when the tag is set.

A docker config directory is code, not data, for the child that holds every stage secret: a
`cli-plugins` entry (even a symlink to a world-writable directory), `cliPluginsExtraDirs` in
`config.json` (both make `docker compose` execute another binary; re-panel FA-2, reproduced with
the real CLI, A14), `currentContext` (another daemon) and `proxies`. So the caller's directory is
**only read, never handed to compose**:
- `checkDockerConfig` mirrors `checkCredFile` for reading it: `lstat`, not a symlink, a directory
  owned by the caller with no group/other write bit, and the same for `config.json` if present
  (`/tmp` is refused);
- `readDockerAuths` parses `config.json` (at most 1 MiB, a JSON object) and keeps only `auths`;
  a `credsStore` or non-empty `credHelpers` is **refused** with a message, because the credential
  then lives in a helper, not in `config.json`, and silently dropping it would make the pull
  anonymous;
- after the OpenBao read, `makeDockerConfig` creates a fresh `mkdtemp` directory (0700) with only
  `config.json` = `{"auths": ...}` (0600); compose gets that as `DOCKER_CONFIG`, plus
  `DOCKER_CONTEXT=default`. It is removed in a `finally` around the steps, on process `exit`
  (refusals, internal errors), and on `SIGTERM`/`SIGHUP`/`SIGINT` while no child runs (while one
  runs, the signal is forwarded as before and cleanup follows its exit).

Consequences: CLI plugins (compose itself) come only from the system plugin directories
(`/usr/libexec/docker/cli-plugins` on docker-ce), which root owns; a plugin installed only under
the caller's `~/.docker/cli-plugins` is not found in a tagged run with `DOCKER_CONFIG`. Without
`DOCKER_CONFIG` a tagged run uses the operator's own `~/.docker`, like every other target (the
operator's own home is not an attacker boundary).

`docker login` writes `"credsStore"` instead of the credential whenever a
`docker-credential-secretservice`/`-pass` helper is on `PATH` (A13), which this rule would refuse.
So the `~/spark-infra` pinned deploy writes `config.json` itself with an inline `auth` (base64
`user:pull_token`, `no_log`) into its `mkdtemp` directory instead of running `docker login`.

### D4a. With a tag, the tree is the tagged commit

The images are not the whole deployment: migrations, `migrate.sh`, the Caddyfiles, the Supabase
init SQL and the compose files are read from the tree `make` runs in. So with a tag,
`checkStageTree` (before any OpenBao request) requires: when `.git` exists, `git rev-parse HEAD`
equals the tag; otherwise a regular, small, non-symlink `REVISION` file at the tree root whose
trimmed content equals the tag. Anything else is refused. The `~/spark-infra` pinned deploy
(`git archive <commit>` into a temp dir, rsync `--delete`, no `.git`) writes `REVISION` with the
full commit before the rsync; its excludes (`/.git`, `node_modules/`, `.worktrees/`,
`server/data/`, `.env.infisical.*`, `.env.openbao.*`) do not drop it. Only `HEAD` is compared, not
cleanliness: tracked edits in a git checkout on the stage host are not detected (accepted; the
pinned deploy has no `.git` and rsyncs `--delete`).

`.git` wins over `REVISION`. The pinned deploy's rsync excludes `/.git`, so a host that was once a
git checkout would keep a stale `.git` and be compared on its old `HEAD`; the deploy therefore
removes `<dest>/.git` before the rsync (re-panel FA-1), and the refusal message, when both exist,
says the `.git` is probably left over and should be removed (rather than "check out the SHA").

### D4b. A pinned tree refuses untagged starts

`REVISION` is only written by the pinned deploy, which serves the public stage. So without a tag,
in a tree with `REVISION` and no `.git`, `checkPinnedUntagged` refuses any compose step containing
`up`, `build` or `run` (`stage-up`, `stage-build`) before any OpenBao request; `stage-down`,
`stage-logs` and `stage-reset` still work. This narrows the F2 residual to a public host that is a
git checkout (re-panel FA-3).

### D4c. The guards live in the deployed tree; the deploy checks for them

Every rule above is enforced by the tree `make` runs in. A pinned deploy of a commit from before
this change would silently ignore the tag and URL (its Makefile's `env -i` drops them), build
`:local` and serve `COOKIE_SECURE=0` through the tunnel. The deploy is therefore independent of
the app (re-panel FA-1, `~/spark-infra` `roles/autologger_env/tasks/up.yml`, pinned mode): before
`make` it refuses a tree whose `docker/scripts/compose-run.mjs` lacks `checkStageTree`; after
`make` it reads the running `autologger-stage` `api` and `web` containers by compose labels
(`docker inspect`, printing only the image and the `COOKIE_SECURE`/`PUBLIC_BASE_URL` entries) and
requires `ghcr.io/kwcantrell/autologger-{api,web}:<tag>`, `COOKIE_SECURE=1` and
`PUBLIC_BASE_URL=<url>`; on a mismatch it stops the project's containers and fails. The pinned
(and any rollback) SHA must contain this change; until it is merged, the cloud host's
`autologger_env_image_ref` and Spark's `autologger_images_ref` name `stage-public-https`.

### D5. Public origin: https only, bare origin, `COOKIE_SECURE=1`

`STAGE_PUBLIC_BASE_URL` must be `https://<dns name>` with no port (the edge serves 443), path,
query, fragment, userinfo, IP literal, `localhost` or unusual spelling (the input must equal
`URL.origin`, optionally with one trailing `/`). There is no http form: unset is the local stage
(`http://localhost:STAGE_PORT`), so a second spelling of the default would only add a branch.
`cookieSecure` is `1` exactly when the URL is set. **A tag requires the URL**: a tagged run is a
public run, so a later `make stage-up STAGE_IMAGE_TAG=...` on the public host cannot recreate `api`
with `COOKIE_SECURE=0` and a localhost redirect while the edge serves it. The `resolved`
step re-checks the merged config (`checkStageResolved`): images, `PUBLIC_BASE_URL`,
`COOKIE_SECURE` and `TRUST_PROXY=1`, so a compose-file edit that ignores a variable fails closed.

*Why `Secure`:* behind an https edge, a session cookie without `Secure` would be sent over any
plain-http request to that host name; and because stage pins `COOKIE_SECURE` explicitly, the
server would not upgrade it from `X-Forwarded-Proto` (Context). The OAuth redirect URI is
`${PUBLIC_BASE_URL}/auth/google/callback`, so it follows the public origin automatically.

### D6. The origin stays loopback-only; `TRUST_PROXY=1` unchanged

The router still publishes only `127.0.0.1:${STAGE_PORT}` (invariant 1, now also checked on the
public resolution). `cloudflared` runs on the same host and dials that port; nothing new listens
on a routable interface. The router trusts forwarded headers only from the compose gateways
(`trusted_proxies_strict`, walked right to left), and hands `api` one `X-Forwarded-For` value; the
api keeps `TRUST_PROXY=1`. Connections from host processes arrive from the bridge gateway, the
same path prod's Newt/Pangolin connector uses, so the existing "forged X-Forwarded-For is not
adopted" behaviour is expected to hold (A8, owner-verified in task 3.4).

Cloudflare documents that when a request already carries `X-Forwarded-For`, the edge appends the
address connecting to it, and that `CF-Connecting-IP` carries the client address (A8 source). The
router's right-most-untrusted walk then sees that appended address, not a client-forged one.
That documentation covers the **edge hop only** (client -> Cloudflare -> the next hop); it says
nothing about what the tunnel connector (`cloudflared` -> origin) sends as `X-Forwarded-For`. So
owner task 3.4 must show both: a forged header is not adopted, **and** the api-logged client IP
equals the tester's real public IP (what `CF-Connecting-IP` reports), with and without a forged
`X-Forwarded-For: 1.2.3.4` (re-panel RA-1). Until both pass, the fallback below applies.

**Fallback until 3.4 passes, or if it fails** (the api sees a client-chosen or a connector IP):
the client IP is not trustworthy on a public stage, so stage MUST NOT set `IP_ALLOWLIST` (README
says so) and IP-based log lines are not trustworthy; the fix would be a router change to adopt `CF-Connecting-IP` from the connector only,
which needs its own change (router is a non-goal here).

### D7. Access in front, Google sign-in behind it

Cloudflare Access authenticates every request at the edge; the app's own Google sign-in is still
always required (`require-login`). These are **not** two independent membership gates: the app's
sign-in creates a user for any Google account it has not seen (no sign-up allowlist), so **the
Access policy is the only control over who gets in**, and it must name the allowed identities
(owner task 3.2a). The second edge control is the tunnel connector's `access.required` check for
this application's `aud` (`~/spark-infra` `tofu/cloud/cloudflare.tf`, ingress `access { required =
true, team_name, aud_tag }`, catch-all `http_status:404`): a request reaching the connector without
a valid Access JWT for the app is refused there, and an unrouted hostname gets 404 (owner task
3.2b). Residual, same as prod: any process on the stage host can reach `127.0.0.1:8788` without
Access; accepted because the host runs only this stack and its operators. Origin-side Access JWT
verification and an app sign-up allowlist are non-goals (follow-ups).

The Google callback is a top-level GET navigation (`authRouter.get('/auth/google/callback')`) with
a single-use `state` (`takeOauthState`), so the Access cookie reaches it when its `SameSite` is
`Lax` or `None`; Cloudflare's default for `CF_Authorization` is `None` and `Strict` is an admin
option (A9 source). **Fallback if 3.3 fails** (Access re-challenges the callback): set the Access
application's cookie `SameSite` to `Lax` (never `Strict`); if it still fails, the owner decides
between an Access bypass rule for `/auth/google/callback` only (the callback still needs a valid
single-use `state` and Google `code`) and holding the public stage.

### D8. Supabase URLs stay localhost

The browser never calls the Supabase gateway, GoTrue or storage: sign-in is Google OAuth handled by
the api, which exchanges the Google ID token with GoTrue over the internal network
(`http://auth:9999`). So `API_EXTERNAL_URL`, `GOTRUE_SITE_URL`, `GOTRUE_JWT_ISSUER` and
`STORAGE_PUBLIC_URL` keep `http://localhost:${SUPABASE_PORT}` and no public Supabase host exists.

## Assumptions

| # | Assumption | Command | Observed |
| --- | --- | --- | --- |
| A1 | Prod tags are 12 hex chars, so a 40-hex stage tag cannot collide | `grep -n 'short=12' Makefile` | `117: @GIT_SHA=$$(git rev-parse --short=12 HEAD) docker buildx bake ... --push` |
| A2 | An explicit `COOKIE_SECURE=0` overrides `X-Forwarded-Proto: https`, so public stage must pin `1` | `sed -n 82,86p server/src/env.ts` | `if (['1','true','yes'].includes(raw)) return true; if (['0','false','no'].includes(raw)) return false; if (trustProxyEnabled(env) && req.headers.get('x-forwarded-proto') === 'https') return true;` |
| A3 | The session cookie's `secure` comes from that rule, `SameSite=Lax` | `grep -n -E 'sameSite\|secure:' server/src/routers/auth.ts` | `299: sameSite: 'Lax',` `300: secure: cookieSecureForRequest(c.env.config, c.req.raw),` |
| A4 | Unset, stage resolves to today's images and cookie; set, to the public values on the loopback port | `sh docker/scripts/check-envs.sh all` | `== stage (autologger-stage)` ... `check-envs: ok (all)` (invariant 7 jq checks for both resolutions, invariant 1 on the public one) |
| A5 | The static check catches a compose edit that breaks either mode | `sh docker/scripts/test_check_envs.sh` | `ok   a stage COOKIE_SECURE default other than 0 is caught`, `ok   a stage api image that ignores STAGE_API_IMAGE is caught`, `test_check_envs: 49 passed, 0 failed` |
| A6 | No browser code calls a Supabase/GoTrue/storage URL | `grep -rn -i -E 'supabase\|gotrue\|/storage/v1\|/auth/v1\|SUPABASE_PORT\|54321' web/src web/next.config.ts \| grep -v '\.test\.' \| wc -l` | `0` |
| A7 | The server talks to GoTrue on the internal network only | `grep -n GOTRUE_TOKEN_URL server/src/auth/gotrue.ts` | `6: const GOTRUE_TOKEN_URL = 'http://auth:9999/token?grant_type=id_token';` |
| A8 | Cloudflare's edge appends the real client IP to `X-Forwarded-For`, so the router's strict right-to-left walk never adopts a client-forged value | WebFetch `https://developers.cloudflare.com/fundamentals/reference/http-headers/` (2026-10-03); `grep -n -E 'trusted_proxies\|client_ip' docker/Caddyfile` | Docs: "If there was no existing `X-Forwarded-For` header ... identical value to the `CF-Connecting-IP` header"; existing header: "Cloudflare will append the IP address of the HTTP proxy connecting to Cloudflare to the header". Repo: `53: trusted_proxies static {$ROUTER_FRONT_GW:172.28.10.1} {$ROUTER_BACK_GW:172.28.11.1}`, `54: trusted_proxies_strict`, `78: header_up X-Forwarded-For {client_ip}`. **Documented for the edge hop only** (client -> Cloudflare); the docs do not cover `cloudflared` -> origin. Not observed: owner task 3.4 (forged header not adopted, and the logged IP equals the real public IP); D6 fallback until both pass. |
| A9 | The Access cookie (`CF_Authorization`) is sent on Google's top-level redirect back to the callback | WebFetch `https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/` (2026-10-03); `grep -n -E "get\('/auth/google/callback'\|takeOauthState" server/src/routers/auth.ts` | Docs: SameSite "Admin choice (Default: None)"; "Lax - Cookies are allowed to be sent with top-level navigations". Repo: `82: authRouter.get('/auth/google/callback', ...`, `111: if (!(await takeOauthState(c.env.ports.kv, state)))`. **Documented, not yet observed:** owner task 3.3; fallback in D7. |
| A10 | `stage-push` refuses a tag that is not `HEAD` and a dirty tree; accepts a clean `HEAD` | scratch clone: `sh docker/scripts/make-guards.sh stage-git $(git rev-parse HEAD)` / `... HEAD~1`; in the dirty worktree `... stage-git $(git rev-parse HEAD)` | `rc=0`; `make: refusing: STAGE_IMAGE_TAG is not HEAD (e862792...)` rc=1; `make: refusing: working tree is not clean (commit or stash; untracked files count)` rc=1 |
| A12 | The tree `make` runs in is the tagged commit (migrations, `migrate.sh`, Caddyfiles, init SQL and compose files are not in the images), on a git checkout and on the pinned deploy's tree without `.git` | `node --test docker/scripts/compose-run.test.mjs`; `grep -n -A3 'Write REVISION' ~/spark-infra/roles/autologger_env/tasks/sync_pinned.yml` | `✔ with a tag, the tree must be the tagged commit: git HEAD, or a REVISION file without .git`, `ℹ fail 0`; infra: `- name: Write REVISION (the full commit) into the exported tree` / `dest: "{{ autologger_env_export.path }}/REVISION"` / `content: "{{ autologger_env_commit }}\n"` |
| A13 | `docker login` into a fresh `DOCKER_CONFIG` writes the credential inline only when no credential helper is on `PATH`; with one it writes `credsStore` and an empty entry (so the deploy writes `config.json` itself) | scratch: a local HTTP stub answering `/v2/` on `127.0.0.1:5999`; `echo tok \| DOCKER_CONFIG=<fresh 0700> docker login localhost:5999 -u u --password-stdin`, then again with a no-op `docker-credential-secretservice` first on `PATH`; `ls /usr/bin/docker-credential-*` | without: `{"auths": {"localhost:5999": {"auth": "dTp0b2s="}}}`; with: `{"auths": {"localhost:5999": {}}, "credsStore": "secretservice"}`; this host: `ls: cannot access '/usr/bin/docker-credential-*'` (none installed; docker 29.6.2) |
| A14 | A caller's docker config dir can make `docker compose` run another binary; the wrapper's temporary dir cannot | scratch `evil/` (0777) with a `docker-compose` plugin script; `dc1/cli-plugins -> evil`; `dc2/config.json` `{"cliPluginsExtraDirs":["<evil>"]}`; `env -i PATH=/usr/bin:/bin DOCKER_CONFIG=<dcN> docker compose version`; then the same with `DOCKER_CONFIG=makeDockerConfig(readDockerAuths(<dcN>))` | caller dirs: `PWNED-by-plugin` (both); wrapper's dir: `Docker Compose version v5.2.0` (both) |
| A11 | The tagged `stage-up` never builds; the untagged one is unchanged | `make -n stage-up \| tail -1`; `make -n stage-up STAGE_IMAGE_TAG=<40 a> STAGE_PUBLIC_BASE_URL=https://stage.example.com \| tail -1` | `stage resolved 'compose run --rm migrate' 'compose up -d --build' urls`; `stage resolved 'compose pull web api' 'compose run --rm migrate' 'compose up -d --no-build' urls` |

## Risks / Trade-offs

- **Shared GHCR repositories.** Stage and prod tags live side by side; prod could in principle be
  pinned to a 40-hex (single-arch) stage tag. Prod's tag rule is unchanged (non-goal); the README
  says prod tags are 12 hex.
- **Loopback bypass of Access** (D7): accepted residual, documented.
- **Same-SHA re-push** overwrites a stage tag with a rebuild of the same commit's sources; the
  content is equivalent, so this is accepted.
- **`DOCKER_CONFIG`** (tagged runs only): compose gets a temporary copy of the caller's inline
  `auths` and nothing else; a credential helper is refused; the directory never comes from OpenBao
  (D4). Residual: the registry login sits on disk (0600 in a 0700 dir) while the run lasts.
- **Untagged run on the public host.** Refused in a pinned tree (D4b). Still possible on a public
  host that is a git checkout (documented; not the `~/spark-infra` deploy).
- **Deploying an older commit** to the public host would bypass every guard here; the
  `~/spark-infra` deploy refuses it and checks the running containers (D4c).

## Migration / Rollback

No data migration in this change.

- **Local stage (Spark):** revert the change; `make stage-up` without the variables is the local
  stage as before.
- **Public host:** roll back with `make stage-up STAGE_IMAGE_TAG=<previous sha>
  STAGE_PUBLIC_BASE_URL=https://stage.<domain>` from a tree at that SHA (the `~/spark-infra` pinned
  deploy with the previous tag does both). App migrations are forward-only, so the previous app
  then runs on the newer schema; if that is not safe, stop the tunnel first (`~/spark-infra`) and
  restore the database from the nightly dump. An untagged `make stage-up` is not a rollback on the
  public host (F2; refused in a pinned tree, D4b).
- **The rollback SHA must contain this change.** An older tree drops the tag and URL, builds
  `:local` and serves `COOKIE_SECURE=0` through the edge; the `~/spark-infra` pinned deploy refuses
  such a tree before `make` and checks the running containers after it (D4c). The first public
  deploy therefore uses a SHA from this branch (`autologger_env_image_ref` /
  `autologger_images_ref` = `stage-public-https` until it is merged), and there is no rollback to a
  pre-change SHA on the public host: stop the tunnel instead.
