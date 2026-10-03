# Tasks

The branch `stage-public-https` is stacked on `openbao-secrets` (not yet merged into
`supabase-migration` or `main`). The PR targets `openbao-secrets` until that merges, then is
retargeted.

**Order.** The code in sections 1-2 was drafted before this plan (the same inversion as
`openbao-secrets` panel finding 8). Before anything is committed:
1. the tier-2 panel runs (assumption tester, failure and abuse, scope and simplicity) and writes
   `panel.md`; any `[critical]` is fixed or declined by the owner;
2. the owner reads proposal, design, spec delta and panel and adds the approval line to
   `proposal.md`;
3. the first commit on the branch is `openspec/changes/stage-public-https/` only, committed by
   path (AGENTS.md rule 6); the code and README follow in later commits;
4. tasks are ticked only with `Evidence:` (command and a short excerpt of its output).

**Panel (2026-10-03).** All findings were applied before approval (panel.md). Every Evidence line
below was re-run after those edits on 2026-10-03; the code and README are in the working tree
only (not staged), so the artifacts-first commit holds this directory alone.

**Re-panel (2026-10-03).** The re-panel findings (panel.md "Re-panel") added tasks 1.6-1.8 and
2.6 and changed 1.5, 2.3, 2.5 and 3.4. Every Evidence line in sections 1-2 was re-run after those
edits on 2026-10-03; the code and README are still in the working tree only.

**Tests.** `docker/scripts/compose-run.test.mjs` (suite `stage public mode (stage-public-https)`)
runs under `npm test` against the local OpenBao stand-in and a stub `docker`.
`docker/scripts/test_check_envs.sh` covers the static check. "Fails on the base" below means: a
scratch clone of `openbao-secrets` (e8627927) with only the current test file copied in (re-run:
`ℹ tests 72`, `ℹ pass 61`, `ℹ fail 11`). "Fails on the draft" means the same clone with the
pre-panel `compose-run.mjs` copied in as well (first panel round; that draft no longer exists, so
it was not re-run). "Fails before the re-panel" means a scratch clone with the current test file
and the working-tree code as it was before the re-panel fixes (re-run: `ℹ tests 72`,
`ℹ pass 64`, `ℹ fail 8`).

## 1. Wrapper (`compose-run.mjs`)

- [x] 1.1 Validate `STAGE_PUBLIC_BASE_URL` (bare https DNS origin only; no http form) and
  `STAGE_IMAGE_TAG` (`^[0-9a-f]{40}$`; requires `STAGE_PUBLIC_BASE_URL`). Tests:
  `STAGE_PUBLIC_BASE_URL accepts only a bare https DNS origin`,
  `STAGE_IMAGE_TAG must be a full 40-hex SHA (never prod-push's 12-char tag); it selects the ghcr images; https sets COOKIE_SECURE=1`.
  Evidence: `node --test docker/scripts/compose-run.test.mjs` -> both `✔`, `ℹ tests 72`, `ℹ pass 72`, `ℹ fail 0`; on the base both `✖`; on the draft both `✖` (first round: the draft accepted `http://localhost:8788` and a tag without a URL).
- [x] 1.2 With a tag nothing builds; the resolved config must carry the expected images, origin,
  `COOKIE_SECURE` and `TRUST_PROXY=1`. Tests: `with a tag nothing builds and every up passes --no-build`,
  `the resolved stage config must carry the expected images, origin and cookie posture`.
  Evidence: `node --test docker/scripts/compose-run.test.mjs` -> both `✔`, `ℹ fail 0`; on the base both `✖`.
- [x] 1.3 Stage-only, stops before any request, and never from OpenBao; end-to-end run passes only
  the derived compose variables and prints the https origin. Tests:
  `the stage values are refused for dev and prod, and a bad one stops before any request`,
  `a tagged public stage run resolves, passes the compose variables and prints the https origin`,
  `an untagged stage run is the local one (resolved checks the :local images; DOCKER_CONFIG ignored)`,
  `the stage values cannot come from OpenBao`.
  Evidence: `node --test docker/scripts/compose-run.test.mjs` -> all four `✔`, `ℹ fail 0`; on the base the first two `✖`, on the draft the first two `✖` (tag without URL, tag not HEAD, `/tmp` DOCKER_CONFIG were accepted); the last two pass on the base too (regression guards: the untagged run and the allowlist must not change).
- [x] 1.4 (panel F1, A-1) With a tag, the tree is the tagged commit: git `HEAD` when `.git`
  exists, else a regular non-symlink `REVISION` file whose trimmed content is the tag; checked
  before any OpenBao request. Test: `with a tag, the tree must be the tagged commit: git HEAD, or a REVISION file without .git`
  (plus the `STAGE_IMAGE_TAG is not HEAD` case in 1.3).
  Evidence: `node --test docker/scripts/compose-run.test.mjs` -> `✔ with a tag, the tree must be the tagged commit: git HEAD, or a REVISION file without .git`, `ℹ fail 0`; on the base and on the draft `✖`.
- [x] 1.5 (panel F4) `DOCKER_CONFIG` (read with a tag only, 1.6): `lstat`, not a symlink, a
  directory owned by the caller with no group/other write, same for `config.json` if present; the
  child gets `DOCKER_CONTEXT=default`. Test: `DOCKER_CONFIG must be a directory you own that no one else can write (and so must its config.json)`
  (one assertion per refusal: symlink dir, symlink `config.json`, `/tmp`, other uid, mode 0770 dir,
  mode 0620 `config.json`, a file, missing, relative), and the end-to-end run in 1.3 asserts
  `DOCKER_CONTEXT=default` in the child env.
  Evidence: `node --test docker/scripts/compose-run.test.mjs` -> `✔ DOCKER_CONFIG must be a directory you own that no one else can write (and so must its config.json)`, `ℹ fail 0`; on the base and on the draft `✖`. Daemon pin, scratch `config.json` `{"currentContext":"nonexistent-ctx"}`: `env -i ... DOCKER_CONFIG=<dir> docker compose ls` -> `context "nonexistent-ctx": context not found`; with `DOCKER_CONTEXT=default` -> `NAME  STATUS  CONFIG FILES` (projects listed).

- [x] 1.6 (re-panel RS1) `DOCKER_CONFIG` is read, validated and forwarded only when
  `STAGE_IMAGE_TAG` is set; untagged it is ignored like dev/prod (`parseStageOptions`,
  compose-run.mjs:300). Tests: `STAGE_IMAGE_TAG must be a full 40-hex SHA ...` (untagged `rel/dir`,
  `/tmp`, a missing dir give `dockerAuths: null` and no compose variables; tagged they refuse),
  `an untagged stage run is the local one (resolved checks the :local images; DOCKER_CONFIG ignored)`
  (end to end with `DOCKER_CONFIG=/tmp`: exit 0, no `DOCKER_CONFIG`/`DOCKER_CONTEXT` in the child env).
  Evidence: `node --test docker/scripts/compose-run.test.mjs` -> both `✔`, `ℹ fail 0`; before the re-panel both `✖`.
- [x] 1.7 (re-panel FA-2) compose never gets the caller's docker config directory: `readDockerAuths`
  (compose-run.mjs:339) keeps only the inline `auths` of `config.json` and refuses
  `credsStore`/`credHelpers`; `makeDockerConfig` (:361) creates a 0700 temp dir with only
  `config.json` = `{"auths": ...}` (0600); it is removed in a `finally` (:810), on `exit` (:861) and
  on a signal while no child runs (:867). Tests:
  `DOCKER_CONFIG: only the inline auths of config.json are kept; a credential helper is refused`,
  `a tagged public stage run ...` (caller dir with a `cli-plugins` symlink to a 0777 dir and
  `cliPluginsExtraDirs` + `currentContext` in `config.json`: the child's `DOCKER_CONFIG` is another
  dir, mode `700`, listing only `config.json` = `{auths}`, gone after the run),
  `the stage values are refused ...` (`credsStore` -> refused, no request),
  `the temporary DOCKER_CONFIG is removed when a step fails and on SIGTERM` (exit 3 and 143, dir gone).
  Evidence: `node --test docker/scripts/compose-run.test.mjs` -> all four `✔`, `ℹ tests 72`, `ℹ pass 72`, `ℹ fail 0`; before the re-panel all four `✖`. Real CLI (design A14): caller dirs -> `PWNED-by-plugin` (both cases); `DOCKER_CONFIG=makeDockerConfig(readDockerAuths(<dir>))` -> `Docker Compose version v5.2.0` (both).
- [x] 1.8 (re-panel FA-3, and the stale-`.git` hint) Without a tag, a tree with `REVISION` and no
  `.git` refuses any compose step with `up`, `build` or `run` (`checkPinnedUntagged`,
  compose-run.mjs:369, called at :770 before any request); `down`/`logs`/`down -v` still run. When
  `.git` and `REVISION` both exist and HEAD differs, the refusal says the `.git` is probably left
  over and should be removed (:386) instead of "check out <sha>". Tests:
  `a pinned tree (REVISION, no .git) refuses an untagged up, build or run`,
  `with a tag, the tree must be the tagged commit: ...` (hint assertions).
  Evidence: `node --test docker/scripts/compose-run.test.mjs` -> both `✔`, `ℹ fail 0`; before the re-panel both `✖`.

## 2. Compose overlay, static check, Makefile, docs

- [x] 2.1 `docker/compose.stage.yaml` reads `STAGE_WEB_IMAGE`, `STAGE_API_IMAGE`,
  `STAGE_PUBLIC_BASE_URL`, `STAGE_COOKIE_SECURE` with today's defaults; `check-envs.sh` resolves
  stage with and without them (invariant 7, invariant 1 on both). Tests first in
  `test_check_envs.sh`: `a stage COOKIE_SECURE default other than 0 is caught`,
  `a stage api image that ignores STAGE_API_IMAGE is caught`.
  Evidence: `sh docker/scripts/test_check_envs.sh` -> `ok   a stage COOKIE_SECURE default other than 0 is caught`, `ok   a stage api image that ignores STAGE_API_IMAGE is caught`, `test_check_envs: 49 passed, 0 failed`; `sh docker/scripts/check-envs.sh all` -> `check-envs: ok (all)`; on the base: `FAIL a stage COOKIE_SECURE default other than 0 is caught (wanted fail with [invariant 7] stage], got ok)`, `test_check_envs: 47 passed, 2 failed`.
- [x] 2.2 `make-guards.sh stage-git` (40-hex, clean tree, tag = HEAD) and `stage-platforms`;
  Makefile `stage-push` (guards, then bake with `--set *.platform` and `--push`) and `stage-up`
  (pull + `--no-build` with a tag; unchanged without).
  Evidence: `sh docker/scripts/make-guards.sh stage-git abcdef123456` -> `make: refusing: STAGE_IMAGE_TAG must be the full 40-character lowercase hex git SHA` rc=1; dirty worktree -> `make: refusing: working tree is not clean (commit or stash; untracked files count)` rc=1; scratch clone (base + make-guards.sh committed): clean `HEAD` rc=0, `HEAD~1` -> `make: refusing: STAGE_IMAGE_TAG is not HEAD (3c1865f3...)` rc=1; `stage-platforms linux/riscv64` -> `make: refusing: STAGE_PLATFORMS must be linux/amd64, linux/arm64 or both, comma-separated` rc=1; `make -n stage-up STAGE_IMAGE_TAG=<40 a> STAGE_PUBLIC_BASE_URL=https://stage.example.com | tail -1` -> `... compose-run.mjs stage resolved 'compose pull web api' 'compose run --rm migrate' 'compose up -d --no-build' urls`; without -> `... stage resolved 'compose run --rm migrate' 'compose up -d --build' urls`.
- [x] 2.3 README: "Public stage (HTTPS edge)" section, target and environment tables, the stage
  OAuth redirect note, the `stage-push` guard note, why Supabase URLs stay localhost, and (panel)
  tagged = public, the tree-is-the-commit rule, `DOCKER_CONFIG` rules, Access policy as the only
  membership control, `IP_ALLOWLIST` caution, public-host rollback.
  Re-panel: `DOCKER_CONFIG` read with a tag only and never handed to compose (RS1, FA-2), untagged
  starts refused in a pinned tree (FA-3), the rollback SHA must contain this change (FA-1), and
  `IP_ALLOWLIST`/logged IPs untrusted until 3.4 passes both ways (RA-1).
  Evidence: `git diff HEAD --stat -- README.md` -> `1 file changed, 95 insertions(+), 5 deletions(-)`; `grep -n -E 'Public stage \(HTTPS edge\)|A tagged run is a public run|The tree must be the tagged commit|refused in a pinned tree|DOCKER_CONFIG. is read only|decided by the Access policy|Do not set .IP_ALLOWLIST. on a public|Rollback on the public host|previous SHA must' README.md` -> `1577:#### Public stage (HTTPS edge)`, `1606:`, `1609:`, `1612:`, `1617:`, `1640:`, `1644:`, `1649:`, `1651:`.
- [x] 2.4 (panel S3) One `RUN` macro passes `CONFIRM`, `STAGE_IMAGE_TAG`,
  `STAGE_PUBLIC_BASE_URL`, `DOCKER_CONFIG` by name for every target; `RUN_STAGE` and
  `RUN_CONFIRM` removed.
  Evidence: `grep -c 'RUN_CONFIRM\|RUN_STAGE' Makefile` -> `0`; `make -n stage-reset | tail -1` -> `... CONFIRM="${CONFIRM-}" STAGE_IMAGE_TAG="${STAGE_IMAGE_TAG-}" ...`; `make --eval 'zz: ; @echo "CONFIRM=[$${CONFIRM-unset}] TAG=[$${STAGE_IMAGE_TAG-unset}] DC=[$${DOCKER_CONFIG-unset}]"' zz CONFIRM=yes STAGE_IMAGE_TAG=abc DOCKER_CONFIG=/x` -> `CONFIRM=[yes] TAG=[abc] DC=[/x]`; `CONFIRM=yes make --eval ... zz` -> `CONFIRM=[yes]`.
- [x] 2.5 (panel F1, coordinated in `~/spark-infra`) The pinned deploy writes `REVISION` (the full
  commit) into the `git archive` export before the rsync
  (`roles/autologger_env/tasks/sync_pinned.yml`), and `up.yml` asserts a non-empty, well-formed
  public URL for a tagged run; the rsync excludes do not drop `REVISION`.
  Evidence: committed in `~/spark-infra` as `27430a9 autologger_env: pinned deploy writes REVISION (app checks tree == tag), public URL required for tagged runs` (`git show --stat 27430a9` -> `roles/autologger_env/tasks/sync_pinned.yml | 15 ++++++++++++++-`, `roles/autologger_env/tasks/up.yml | 7 ++++---`); excludes `/.git`, `node_modules/`, `.worktrees/`, `server/data/`, `.env.infisical.*`, `.env.openbao.*` (none matches `REVISION`).

- [x] 2.6 (re-panel FA-1, coordinated in `~/spark-infra`, uncommitted there) The deploy no longer
  trusts the deployed tree to enforce the guards: `roles/autologger_env/tasks/up.yml` (pinned)
  greps the tree for `checkStageTree` and refuses before `make` (:37, :45); writes the pull login
  as an inline `config.json` `auth` instead of `docker login` (:82; design A13); after `make`,
  reads the `autologger-stage` api/web containers by compose labels and asserts
  `ghcr.io/kwcantrell/autologger-{api,web}:<tag>`, `COOKIE_SECURE=1`, `PUBLIC_BASE_URL=<url>`
  (:105, :127), else stops the project's containers and fails (:146);
  `sync_pinned.yml` removes a stale `<dest>/.git` before the rsync (:49). Infra README and
  `docs/roles.md` say the deployed/rollback SHA must contain this change
  (`autologger_env_image_ref` / `autologger_images_ref: stage-public-https` until merged).
  Evidence: `ansible-lint` -> `Passed: 0 failure(s), 0 warning(s) in 173 files processed of 208 encountered. Profile 'production' was required, and it passed.`; `yamllint .` rc=0; `ansible-playbook playbooks/autologger.yml --check --limit autologger-stage` (worktree mode) -> `autologger-stage : ok=12 changed=0 unreachable=0 failed=0 skipped=40`; the inspect script against this host's running local stage -> `api autologger-stage-api:local PUBLIC_BASE_URL=http://localhost:8788 COOKIE_SECURE=0` / `web autologger-stage-web:local`; the assert expressions in a scratch play: tagged+public `ok`, local posture / `COOKIE_SECURE=0` / missing api `failed`; the rendered `config.json` -> `{"auths": {"ghcr.io": {"auth": "dTp0b2s="}}}` (0600), which `readDockerAuths` accepts.

## 3. Owner verification (needs GHCR, the tunnel, Access and the stage host)

- [ ] 3.1 **(owner)** Push and pull: on the Spark build host `make stage-push STAGE_IMAGE_TAG=$(git rev-parse HEAD)`;
  on the stage host (tree at that SHA: the pinned deploy writes `REVISION`)
  `make stage-up STAGE_IMAGE_TAG=<sha> STAGE_PUBLIC_BASE_URL=https://stage.<domain>`.
  Check: `docker compose -p autologger-stage images` shows the two `ghcr.io/...:<sha>` images;
  `ss -ltn | grep 8788` shows only `127.0.0.1:8788`.
- [ ] 3.2 **(owner)** Access (panel F3):
  (a) the Access application's policy admits only named identities (emails or a group of them),
  not "any Google account" or "everyone": Zero Trust dashboard -> Access -> Applications -> stage
  -> Policies;
  (b) an unauthenticated `curl -sI https://stage.<domain>/` is answered by Cloudflare Access
  (redirect to the Access login), not by the app; a request that reaches the connector without a
  valid Access JWT for the app's `aud` (for example `curl -sI` with a `CF_Authorization` cookie for
  another application), and a request to a hostname with no ingress rule, gets the connector's
  403 / 404, not the app.
- [ ] 3.3 **(owner)** OAuth and cookie (assumption A9): add
  `https://stage.<domain>/auth/google/callback` to the stage OAuth client; check the Access
  application's cookie `SameSite` is `Lax` or `None` (not `Strict`); sign in through Access
  and Google. Check: browser devtools shows `autologger_stage_sid` with `Secure`, `HttpOnly`,
  `SameSite=Lax`; `/api/profile` returns the user. If it fails, follow the D7 fallback.
- [ ] 3.4 **(owner)** Forwarded headers (assumption A8, re-panel RA-1): through the edge (with an
  Access service token or session), send one request with no `X-Forwarded-For` and one with
  `X-Forwarded-For: 1.2.3.4`. Check both: (a) the client IP the api logs is never `1.2.3.4`, and
  (b) for both requests it equals your real public IP, as Cloudflare reports it in
  `CF-Connecting-IP` (for example from a request to a Cloudflare-proxied echo endpoint, or
  `curl -s https://www.cloudflare.com/cdn-cgi/trace | grep ^ip=` from the same machine). Until (a)
  and (b) both pass, do not set `IP_ALLOWLIST` on the public stage and treat logged client IPs as
  untrusted (D6 fallback).

## 4. Verify

- [ ] 4.1 `scripts/check-change.sh --stage hook` passes (on this stacked branch, with the base set
  to `openbao-secrets`; see the PR note on the "one change per branch" gate).

## 5. Archive

- [ ] 5.1 (panel S1) Archive only after `openbao-secrets` is archived: refuse while
  `openspec/changes/openbao-secrets/` exists (`test ! -e openspec/changes/openbao-secrets || { echo "archive openbao-secrets first" >&2; exit 1; }`);
  then re-diff this change's MODIFIED "Stage behaves as production, with local sign-in" block
  against the then-durable `openspec/specs/local-container-environments/spec.md` requirement
  (only the intended deltas: images/tag, `PUBLIC_BASE_URL`/`COOKIE_SECURE` defaults, the public
  OAuth URI, `TRUST_PROXY` in every mode, the new scenario) and update it if the durable text moved,
  before `/opsx:archive`.
