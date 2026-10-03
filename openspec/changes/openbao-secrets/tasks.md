# Tasks

The branch `openbao-secrets` is cut from `supabase-migration` in a separate worktree. The PR
targets `supabase-migration`.

**Order (panel finding 8).** The scope was cut after the panel (owner, 2026-10-03: the
database-engine feature moves to a follow-up change). Before any task is ticked:
1. the reduced delta is re-panelled (a `Re-panel` section in `panel.md`);
2. the owner re-approves the reduced artifacts in `proposal.md`;
3. the first commit on the branch is `openspec/changes/openbao-secrets/` only, staged by path
   (AGENTS.md rule 6); code and docs follow in later commits;
4. each task below is then ticked with `Evidence:` (command and a short excerpt of its output).

**Tests.** `docker/scripts/compose-run.test.mjs` and `docker/scripts/supabase-keys.test.mjs` run
under `npm test` against a local HTTPS stand-in for OpenBao (throwaway CA, `127.0.0.1` only) and a
stub `docker`. `docker/scripts/test_check_envs.sh` covers the static check. Each task names the
test written first and seen failing.

**Owner tasks** need OpenBao access or values. The owner runs them (for example `! make dev-up`).
Every owner command prints names, statuses or exit codes only.

## 1. Owner prerequisites (with `~/spark-infra`)

- [ ] 1.1 **(owner)** OpenBao is installed, initialised and unsealed; KV v2 is mounted at `kv`.
  Check: `bao status` shows `Sealed false`; `bao secrets list` shows `kv/` with `version:2`.
- [ ] 1.2 **(owner)** Export every Infisical key into `kv/autologger/dev` and
  `kv/autologger/stage` (`bin/infisical-export`). Check: the sorted key-name lists from Infisical
  and from `bao kv get -format=json kv/autologger/<env> | jq -r '.data.data|keys[]'` are equal.
- [ ] 1.3 **(owner)** Create AppRoles `autologger-dev` and `autologger-stage` with a policy of
  `read` on `kv/data/autologger/<env>` only, `secret_id_bound_cidrs` and `token_bound_cidrs` set
  to the host or VM address, `secret_id_ttl=90d`, `token_ttl=5m`, `token_max_ttl=10m`. Check:
  `bao read auth/approle/role/autologger-dev` (field names and TTLs only) and
  `bao policy read autologger-dev` (one `path "kv/data/autologger/dev"` block, `read` only).
- [ ] 1.4 **(owner)** Render `.env.openbao.dev` and `.env.openbao.stage` (mode 600) with Ansible.
  Check: `stat -c '%a %U' .env.openbao.*` -> `600 <owner>`; key names only via
  `cut -d= -f1 .env.openbao.dev`.

## 2. Static check and compose helpers (wording only)

- [x] 2.1 `check-envs.sh`, `compose-env.sh` and `make-guards.sh` name OpenBao and
  `.env.openbao.*`; the invariant count stays 16 and no compose file is added. Check:
  `sh docker/scripts/test_check_envs.sh` passes unchanged from `supabase-migration`;
  `sh docker/scripts/check-envs.sh all` exits 0; `git diff supabase-migration --
  docker/scripts/test_check_envs.sh` is empty; `grep -c -i infisical docker/scripts/check-envs.sh`
  counts only `infisical-secrets` design citations.
  Evidence: `sh docker/scripts/test_check_envs.sh` -> `test_check_envs: 47 passed, 0 failed`; `sh docker/scripts/check-envs.sh all` -> `check-envs: ok (all)`, exit 0; `git diff supabase-migration...HEAD -- docker/scripts/test_check_envs.sh | wc -l` -> `0` (three-dot: `supabase-migration` has moved to 5f9684e since the branch base e4e36e1); `grep -n -i infisical docker/scripts/check-envs.sh` -> lines 3 and 38 only, both `infisical-secrets D5`/`D2` design citations; header still says `16 invariants`; `git diff --diff-filter=A --name-only supabase-migration...HEAD -- '*.yaml'` -> nothing (no compose file added).

## 3. Wrapper (`compose-run.mjs`)

- [x] 3.1 Credentials file `.env.openbao.<env>`. Tests first: missing file names
  `docker/openbao-credentials.example`; `http://` `BAO_ADDR` refused with no request; mode 644
  refused; missing `BAO_ROLE_ID` named; missing `BAO_CACERT` file named; `BAO_KV_PATH` of
  `kv/autologger/prod` for dev, `kv`, `kv//dev`, `kv/../dev` refused with no request.
  Evidence: `node --test docker/scripts/compose-run.test.mjs` -> `ℹ tests 59`, `ℹ pass 59`, `ℹ fail 0`; suite `credentials file (H7, D1 step 1)`: `missing file names the template`, `http address is refused before any request`, `group/world-readable file is refused, naming the mode`, `a missing key is named`, `a missing or relative CA file is named`, `a KV path for another stack, or with odd segments, is refused before any request (D1)`. Written first in the earlier authoring session.
- [x] 3.2 AppRole login and KV read. Tests first: the stand-in sees exactly login, read, revoke;
  the login body carries `role_id`/`secret_id`; the read carries `X-Vault-Token` and the path
  `/v1/kv/data/autologger/dev`; a login `400` with `errors` prints `HTTP 400: <message>` and sends
  no read; a login without `auth.client_token` sends no read.
  Evidence: `node --test docker/scripts/compose-run.test.mjs` -> `ℹ pass 59`, `ℹ fail 0`; `logs in once, reads the KV path, revokes the token, and spawns docker with only the clean env`, `login 400 prints only the status and errors; no read, nothing to revoke`, `login JSON without a string client_token is refused; no read`.
- [x] 3.3 Revoke. Tests first: revoke-self is sent after a successful read and after a failed read
  (`403`), before any docker call; a failing revoke prints a warning and the steps still run; the
  token never appears in the stub docker's env or argv.
  Evidence: `node --test docker/scripts/compose-run.test.mjs` -> `ℹ pass 59`, `ℹ fail 0`; `a failed revoke only warns; the token expires with its TTL`, `a refused read still revokes the token, and prints the status only`, `logs in once, reads the KV path, revokes the token, and spawns docker with only the clean env` (token absent from the stub docker env/argv).
- [x] 3.4 Validation of `data.data`. Tests first: non-string values (number, object, null), NUL,
  `__proto__`, `LD_PRELOAD`, any `BAO_*` name, empty object, missing `data` are each refused
  without printing values. The compose keys per environment equal `supabase-migration`'s.
  Evidence: `node --test docker/scripts/compose-run.test.mjs` -> `ℹ pass 59`, `ℹ fail 0`; `refuses non-string values, NUL, bad identifiers, an empty or missing data object`, `refuses __proto__ and constructor without polluting anything`, `no environment allows a BAO_* name`, `refuses names outside the allowed set, printing names not values`; `diff` of the `COMPOSE_KEYS` and `allowedNames` blocks against `git show supabase-migration:docker/scripts/compose-run.mjs` -> `COMPOSE_KEYS identical`, `allowedNames identical`.
- [x] 3.5 Deleted or destroyed current version (panel finding 6). Tests first, in
  `compose-run.test.mjs`: `validateSecrets` refuses a past or unparseable `deletion_time`
  (naming `bao kv undelete` and `bao kv rollback`) and `destroyed: true` (naming only
  `bao kv rollback`), also with `data.data: null`, and accepts a future `deletion_time`
  (`delete_version_after`); the stand-in answering the read with `404` plus `data.metadata`
  makes the wrapper exit non-zero naming `is deleted` and `bao kv undelete`, still revoke the
  token, and run no docker. The mock metadata uses `deletion_time` (KV v2's field), not
  `deleted_time`.
  Evidence: `node --test docker/scripts/compose-run.test.mjs` -> `ℹ pass 59`, `ℹ fail 0`; `refuses a deleted or destroyed current version (KV v2 field deletion_time)` (also asserts a future `deletion_time` is accepted) and `a soft-deleted current version (404 with metadata) is refused naming undelete, after revoking`. In the earlier session these were seen failing first: 2 of 58 compose-run tests before the finding-6 fix, and 3 of 73 (both suites) before the future-`deletion_time` fix.
- [x] 3.6 `checkResolved` and the `urls` step equal `supabase-migration`'s apart from OpenBao
  wording: every published port on `127.0.0.1`, `db` publishes nothing, no Postgres line. Check:
  `git diff supabase-migration -- docker/scripts/compose-run.mjs` shows no change inside
  `checkResolved` or `urls` other than message text.
  Evidence: `git diff -U0 supabase-migration...HEAD -- docker/scripts/compose-run.mjs` -> one hunk inside `checkResolved` (`@@ -410 +499 @@`), the 8080 refusal text `pick another in Infisical ${env}` -> `pick another in the OpenBao ${env} secret`; no hunk inside `urls` (lines 510-530); `resolved passes and urls prints the OpenBao DEV_PORT` passes in the 3.7 run.
- [x] 3.7 All existing wrapper tests pass with the stand-in rewritten for OpenBao (H1-H12 rows).
  Evidence: `node --test docker/scripts/compose-run.test.mjs` -> `ℹ tests 59`, `ℹ suites 12`, `ℹ pass 59`, `ℹ fail 0` (credentials, TLS and HTTP, H4, validation, start-up, success path, guard steps, Postgres, APP_DB_PASSWORD, Supabase keys, ports, sign-in suites all green against the OpenBao stand-in).

## 4. Generator (`supabase-keys.mjs`)

- [x] 4.1 Token source. Tests first: no `--writer` and no `BAO_TOKEN` refused before any request;
  a writer file at mode 644 refused; `BAO_TOKEN=` line and raw-token file both accepted; the token
  never printed.
  Evidence: `node --test docker/scripts/supabase-keys.test.mjs` -> `ℹ tests 14`, `ℹ pass 14`, `ℹ fail 0`; `the token can come from BAO_TOKEN, or from a writer file holding the token alone` (also: no `--writer` and no `BAO_TOKEN` exits non-zero naming `BAO_TOKEN`), `a writer file readable by others is refused before any request`.
- [x] 4.2 Read then write. Tests first: all keys present -> only a GET, every key `kept`; some
  missing -> one `PATCH` with `content-type: application/merge-patch+json`, `options.cas` equal to
  the read version, only the missing keys; `404` with no metadata on read -> one `POST` with
  `cas: 0`.
  Evidence: `node --test docker/scripts/supabase-keys.test.mjs` -> `ℹ pass 14`, `ℹ fail 0`; `existing keys are kept: no write request, and no value is printed`, `missing keys are merged in one check-and-set PATCH, each in its format, and never printed` (asserts `application/merge-patch+json`), `a path that does not exist yet gets a create-only POST (cas 0)`.
- [x] 4.3 Rejected write. Tests first: a `400` (cas mismatch) or `403` on the write exits non-zero
  naming the status, with exactly one write request and no retry; a partial JWT trio is refused
  with no write.
  Evidence: `node --test docker/scripts/supabase-keys.test.mjs` -> `ℹ pass 14`, `ℹ fail 0`; `a rejected write exits non-zero with no retry`, `a partial JWT trio is refused before any write, naming the missing keys`.
- [x] 4.4 Deleted or destroyed current version (panel finding 6). Test first, in
  `supabase-keys.test.mjs`: a read answering `404` with a past `deletion_time`, `404` with
  `destroyed: true`, `404` carrying only `metadata.version`, and `200` with a past or
  unparseable `deletion_time` or `destroyed: true` each exit non-zero, send no `PATCH` or `POST`,
  print no `created` line and no value; deleted ones name `bao kv undelete` and
  `bao kv rollback`, destroyed ones only `bao kv rollback`. A `200` with a future
  `deletion_time` is written normally (one `PATCH`, existing keys `kept`).
  Evidence: `node --test docker/scripts/supabase-keys.test.mjs` -> `ℹ pass 14`, `ℹ fail 0`; `a soft-deleted or destroyed current version is refused, with no write`, `a live version with a future deletion_time (delete_version_after) is written normally`. In the earlier session the deleted-version test was seen failing first (1 of 13 before the finding-6 fix).

## 5. Makefile

- [x] 5.1 Makefile comments and help name OpenBao; `dev-psql` is exactly `supabase-migration`'s
  target and no `stage-psql` exists. Check: `git diff supabase-migration -- Makefile` touches
  comments and help strings only; `make help` lists `dev-psql` and no `stage-psql`;
  `grep -ci infisical Makefile` -> `0`.
  Evidence: `git diff supabase-migration...HEAD --stat -- Makefile` -> `1 file changed, 5 insertions(+), 5 deletions(-)`, all in comments and `##` help strings (header comments, `prod-check`/`prod-pull`/`prod-up` help); `make help | grep psql` -> `dev-psql           psql in the dev Postgres (no history file)` only; `grep -ci infisical Makefile` -> `0`.

## 6. Rename, docs, ADR and specs

- [x] 6.1 `docker/infisical-credentials.example` -> `docker/openbao-credentials.example`;
  `.gitignore` still ignores `.env.openbao.*` (`.env.*`). Check:
  `git check-ignore .env.openbao.dev .env.openbao.prod` lists both;
  `git check-ignore docker/openbao-credentials.example` lists nothing.
  Evidence: `git check-ignore .env.openbao.dev .env.openbao.prod` -> `.env.openbao.dev`, `.env.openbao.prod`; `git check-ignore docker/openbao-credentials.example` -> nothing, exit 1; `git log --follow --name-status -- docker/openbao-credentials.example` -> `R100 docker/infisical-credentials.example docker/openbao-credentials.example` (9583a91), then `M` (2f712b1).
- [x] 6.2 Docs: `docs/openbao-secrets.md` (no database-engine section; AppRole policy `read` on
  `kv/data/autologger/<env>` only; the deleted-version refusal), README, `docs/supabase.md`,
  `docs/security.md`, `.cursor/rules/restart-server-yourself.mdc`, `server/.env.example`,
  `server/scripts/capture-deepgram-fixture.mjs`, `server/src/bootGuard.ts` messages, compose
  comments. Check: `git grep -il infisical -- ':!openspec/changes/archive' ':!docs/decisions'`
  lists only intended leftovers (`infisical-secrets` design citations and the two scenario titles
  of the post-archive rename below); `grep -rn -i 'BAO_DB_BIND\|bao-db\|bao-psql\|database/creds' .` outside
  `openspec/changes/archive` hits only the Non-goal text and the panel.
  Evidence: `git grep -n -i infisical -- ':!openspec' ':!docs/decisions' | grep -vi infisical-secrets` -> nothing (outside openspec only `infisical-secrets` citations remain); under openspec the hits are this change's own artifacts and `openspec/specs/` (synced on archive, incl. the two scenario titles); `grep -rn -i 'BAO_DB_BIND\|bao-db\|bao-psql\|database/creds' . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=archive` -> only `design.md:42` and `proposal.md:97` (Non-goal/follow-up), `panel.md` and this file.
- [x] 6.3 ADR 0025 (`docs/decisions/0025-openbao-replaces-infisical.md`) supersedes ADR 0021's
  "Secrets live in a shared Infisical instance" bullet (panel finding 7); ADR 0021's body is
  unchanged. Check: `git diff supabase-migration --stat -- docs/decisions` lists only the new file.
  Evidence: `git diff supabase-migration...HEAD --stat -- docs/decisions` -> `docs/decisions/0025-openbao-replaces-infisical.md | 57 +++` only, `1 file changed` (ADR 0021 untouched; a two-dot diff also shows 0021 because `supabase-migration` moved to 5f9684e after the base e4e36e1).
- [x] 6.4 `openspec validate openbao-secrets --strict` and `scripts/check-change.sh --stage hook`
  pass.
  Evidence: `npx openspec validate openbao-secrets --strict` -> `Change 'openbao-secrets' is valid`; `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook` -> exit 0: `PASS  openspec`, `PASS  change  tier 2`, `PASS  evidence`, `PASS  commands  ran ['typecheck', 'test']`.

## 7. Verification against the real OpenBao (owner-run)

- [ ] 7.1 **(owner)** On the host, `make dev-check` then `make dev-restart` against
  `https://192.168.0.100:8200`. Check: exit 0, the stack is healthy, no value printed.
- [ ] 7.2 **(owner)** Isolation and API behaviour: dev AppRole reading `kv/autologger/stage`
  gets `HTTP 403`; an AppRole login from outside the bound CIDR is refused; revoke-self answers
  `204` (A2); a stale `cas` PATCH is refused (A1); a soft-deleted scratch path reads as `404` with
  `metadata.deletion_time` (A3), and `supabase-keys.mjs` against it refuses with no write.
- [ ] 7.3 **(owner)** `make dev-psql` opens psql in the dev `db` through the wrapper (unchanged
  behaviour, now with OpenBao secrets).
- [ ] 7.4 **(owner)** Stage on its VM: `make stage-up` healthy; `docker/supabase/test_gateway.sh`
  passes.

## Owner-owed after merge

- After archive, rename the scenario titles "Unnamed Infisical secrets stay out of the container"
  and "Posture cannot be flipped from Infisical" in `openspec/specs/` to say OpenBao (OpenSpec
  1.13.2 refuses dropping a scenario name inside a MODIFIED block, so the delta keeps them).
  Check: `grep -rn 'Scenario:.*Infisical' openspec/specs` -> nothing. (No checkbox: it can only
  happen after merge, so the tasks gate ignores it, as in fix-dependency-vulns.)
- Delete `.env.infisical.*` on every host after the soak; decommission Infisical
  (`~/spark-infra` `decommission-host.yml`).
- Create the prod AppRole and `kv/autologger/prod` before the ADR 0021 cutover.
- Open the follow-up change for dynamic Postgres credentials (Postgres TLS verify-full with the
  internal CA, no host route for `db`, dev/stage only, no `database/creds` on stack AppRoles).
