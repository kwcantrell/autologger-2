# Tasks

**Branch and commits**
- The first commit on `drop-unused-supabase-services` holds only `openspec/changes/drop-unused-supabase-services/`.
- The PR targets `supabase-migration`.
- The gates run with `GITHUB_BASE_REF=supabase-migration`.

**Logs and test-first**
- Logs live under the session scratchpad as `dus-<task>-<red|green>.log`, and each `Evidence:` line names its log.
- Each "test first" item is red before its change, or records why it already passes.
- A task's text and its `Evidence:` lines stay in one block with no blank line.

**Commands**
- Tooling tests: `node --test docker/scripts/compose-run.test.mjs docker/scripts/supabase-keys.test.mjs`.
- Compose invariants: `sh docker/scripts/check-envs.sh` and `sh docker/scripts/test_check_envs.sh`.
- Typecheck: `npm run typecheck`. Server unit suite: `cd server && npx vitest run --project unit`.
- Specs: `~/.local/bin/openspec validate --all --strict`.
- No server, web or package code changes, so no DB test runs locally. The full integration and pg suites run in CI on the PR (ADR 0026).

**Changing tests.** Changing an existing test is allowed only for the categories in design D8. Anything else is a stop: update the artifacts and ask the owner.

## 1. Baselines

- [x] 1.1 On the base, record: `node --test docker/scripts/compose-run.test.mjs docker/scripts/supabase-keys.test.mjs` (pass and fail counts), `sh docker/scripts/check-envs.sh` (`check-envs: ok (all)`), `sh docker/scripts/test_check_envs.sh` (passed and failed counts), the server unit suite and `npm run typecheck`. The DB-suite baseline is the slice 10 CI run, PR #101 run 37829084541: server pg and integration 1445 passed, 1 skipped; storage pg 109. List every existing test that D8 categories 1 and 2 may touch with `grep -n "ANON_KEY\|SERVICE_ROLE_KEY\|SECRET_KEY_BASE\|REALTIME_DB_ENC_KEY\|SUPABASE_PORT\|supabase-gw\|checkSupabaseKeys\|realtime\|storage\|rest\b\|edge\|TRIO\|JWT_SECRET" docker/scripts/compose-run.test.mjs docker/scripts/supabase-keys.test.mjs docker/scripts/test_check_envs.sh`, and classify each hit by category or as unchanged.
  - Evidence: `node --test docker/scripts/compose-run.test.mjs docker/scripts/supabase-keys.test.mjs` -> `ℹ tests 86` `ℹ pass 86` `ℹ fail 0` (dus-1.1-tooling-red.log).
  - Evidence: `sh docker/scripts/check-envs.sh` -> `check-envs: ok (all)` (dus-1.1-checkenvs-red.log); `sh docker/scripts/test_check_envs.sh` -> `test_check_envs: 59 passed, 0 failed` (dus-1.1-testcheckenvs-red.log).
  - Evidence: `cd server && npx vitest run --project unit` -> `Test Files  33 passed | 2 skipped (35)`, `Tests  360 passed | 3 skipped (363)` (dus-1.1-unit-red.log); `npm run typecheck` -> exit 0 (dus-1.1-typecheck-red.log). DB baseline: PR #101 run 37829084541 (server pg and integration 1445 passed, 1 skipped; storage pg 109).
  - Evidence: the grep hits, classified. compose-run.test.mjs: 26 `checkSupabaseKeys` import, 41-50 `sbSecrets` fixture, 515 child-env names, 657 and 691 `supabase-gw` port fixtures, 725-744 format test retired rows, 747-765 trio test (deleted), 768-771 scope test fixtures, 785-788 port owners: category 1. 704-705 (`rest` as a fixture service for the `APP_DB_PASSWORD` refusal) and 1069 (`HTTPS edge` text): unchanged. supabase-keys.test.mjs: 22-31 key list and formats, 205-209 JWT checks of the merged-keys case, 249-254 partial-trio case (deleted): category 1. test_check_envs.sh: 111-113 `pwrest`, 131-133 `storageport`, 144 `gwbind`, 152-154 `apprest`, 165-166 `restcat`, 194-195 `restegress`, 202-203 `restauthapp` retargeted (plus `authnoapp` 217-219, which the grep pattern misses); 116 `gwdb`, 119-121 `restedge`, 135-137 `edgesubnet` dropped (plus `sbinternal` 123-125, also missed by the grep): category 2; 140 `anonapi` unchanged (now caught by the retired-key sentinel).

## 2. Secrets tooling (design D3)

- [ ] 2.1 Test first in `docker/scripts/compose-run.test.mjs`: the retired keys (`ANON_KEY` as `not-a-jwt`, `SECRET_KEY_BASE` too short, `REALTIME_DB_ENC_KEY` too long, `SERVICE_ROLE_KEY`, `SUPABASE_PORT` as `80`) are accepted by `validateSecrets(…, allowedNames(env))`; `retiredKeyWarning` names exactly the ones present, sorted, and no value, and returns nothing when none is present; a dev run through the fake-compose harness has none of them in the child environment (the child-environment names list loses them: D8 category 1) and prints the warning once. Red, then add `RETIRED_KEYS`, drop their `KEY_FORMAT` entries, filter them out of the child environment, and print the warning. Green.
- [ ] 2.2 Test first in `docker/scripts/compose-run.test.mjs`: an `ANON_KEY` signed with another secret is not refused (`checkSupabaseKeys` is gone, its trio test deleted: D8 category 1); `checkResolved` refuses `JWT_SECRET` in a `rest` or `storage` fixture service, `POSTGRES_PASSWORD` in `realtime`, and `SUPABASE_ROLES_PASSWORD` in `rest`; a dev config whose owners are `app`, `companion` and `supabase-gw` is refused as not the expected set, and `app`, `companion` alone pass; stage and prod with `router` alone pass, and with a `supabase-gw` port are refused; `urls` prints no `Supabase:` line. Existing fixtures with `realtime`, `storage` and `supabase-gw` are updated (D8 category 1). Red, then set `SUPABASE_KEYS`, `SECRET_SCOPE` and the owner lists from D3, delete `checkSupabaseKeys` and its call, and drop the `urls` line. Green, plus `npm run typecheck`.
- [ ] 2.3 Test first in `docker/scripts/supabase-keys.test.mjs`: an empty path gets exactly `POSTGRES_PASSWORD`, `SUPABASE_ROLES_PASSWORD`, `APP_DB_PASSWORD` and `JWT_SECRET`, each in its format; a path with `JWT_SECRET` and no `ANON_KEY` is not refused and writes nothing new; a path holding the four keys and the five retired keys reports the four as kept, names no retired key, and sends no write; a path missing only `JWT_SECRET` creates only it. The merged-keys case and the existing-stack case lose the JWTs, and the partial-trio case is deleted (D8 category 1). Red, then cut `KEYS`, `TRIO`, `apiKey()` and the trio refusal. Green.

## 3. Compose, GoTrue and invariants (design D1, D2, D4)

- [ ] 3.1 Test first in `docker/scripts/test_check_envs.sh`, the new cases of design D4: a `rest` service added back (digest-pinned, no port, on `db`) fails invariant 16, and in dev also invariant 6; a `supabase-gw` service added back fails invariant 16; `auth` joined to a new `supabase` network fails invariant 16; a service joined to a new `edge` network fails invariant 16; `${SERVICE_ROLE_KEY}` in an `auth` label fails invariant 16. Record each as red on the base (the base tree still defines `rest` and `supabase-gw`, so the re-add cases that expect a fail may already fail for another reason: record which).
- [ ] 3.2 Make the change in one step, so `check-envs.sh` passes on the clean tree:
  - `docker/supabase-services.yaml` keeps only `auth`, with `networks: [db, auth-egress, auth-app]` and the three literal URLs of D2; the `supabase-storage` volume goes;
  - `docker/supabase-db.yaml` drops the `jwt.sql` and `realtime.sql` mounts and `JWT_EXP`; `roles.sql` keeps only the `supabase_auth_admin` line;
  - delete `docker/supabase-gw.Caddyfile`, `docker/supabase/test_gateway.sh`, `docker/supabase/init/jwt.sql` and `docker/supabase/init/realtime.sql`;
  - `compose.yaml`, `docker/compose.dev.yaml` and `docker/compose.stage.yaml` drop the `supabase` and `edge` networks; the comment in `docker/scripts/compose-env.sh` names `auth` only;
  - `docker/scripts/check-envs.sh` as design D4 (sentinels, `check_supabase`, invariants 2, 3, 4 and 6, comments);
  - `docker/scripts/test_check_envs.sh`: the dropped and retargeted cases of D4 (D8 category 2).
  Green: `sh docker/scripts/check-envs.sh` -> `check-envs: ok (all)`, `sh docker/scripts/test_check_envs.sh` with no failures and the 3.1 cases passing, and the 2.x tooling tests still green. Also `grep -rn "supabase-gw\|SUPABASE_PORT\|realtime\|rest:3000\|storage:5000" compose.yaml docker/*.yaml docker/supabase docker/scripts/compose-env.sh` finds nothing.

## 4. Orphan containers (design D5)

- [ ] 4.1 Test first in `docker/scripts/compose-run.test.mjs`: read the `Makefile` and assert that it holds exactly four quoted `'compose up …'` steps (`dev-up`, both `STAGE_UP_STEPS`, `prod-up`) and five `'compose down …'` steps (`dev-down`, `dev-reset`, `stage-down`, `stage-reset`, `prod-down`), and that each holds `--remove-orphans`; `checkStagePlan` still accepts the tagged `'compose up -d --no-build --remove-orphans'`. Red, then add `--remove-orphans` to the nine steps and update the `dev-up`, `dev-reset` and `stage-reset` help text (no "Supabase", no "Supabase storage"). Green, plus `make help` shows the new text.

## 5. Docs (design D6)

- [ ] 5.1 `docs/supabase.md` rewritten as design D6 (layout, networks, volumes, roles, GoTrue, commands, init SQL, rotation, residual risks with the `auth-egress` reach and the retired `SERVICE_ROLE_KEY` staying a GoTrue admin credential until `JWT_SECRET` is rotated, that rotation ordered after no checkout runs the old stack and the retired keys are removed).
- [ ] 5.2 `docs/openbao-secrets.md`: the four-key table, the generator text, and the "Retired keys" note with the removal command, followed by the `JWT_SECRET` rotation (design Risks).
- [ ] 5.3 `docs/security.md`: the ASI06 row, the frame-bus paragraph and the PUBLIC `CONNECT`/`TEMP` note.
- [ ] 5.4 README: the make table rows, the stage URL bullet, the testing paragraph's `test_gateway.sh` mention, the connections note, and the new leftovers cleanup note (`docker volume rm <project>_supabase-storage`, `docker network rm <project>_supabase <project>_edge`, the optional `_realtime`, storage-table and role-password steps, and the `autologger-ui` warning).
- [ ] 5.5 ADR 0021 (slice 10 item 3 done, GoTrue kept for password sign-in, Realtime and Storage gone, retired keys ignored, leftovers documented) and ADR 0023 (a status note: the Realtime service was removed). Then `~/.local/bin/openspec validate --all --strict`, and `grep -rn "supabase-gw\|test_gateway\|SUPABASE_PORT\|ANON_KEY\|SERVICE_ROLE_KEY" README.md docs/supabase.md docs/openbao-secrets.md docs/security.md` shows only the retired-keys and leftovers notes.

## 6. Verify

- [ ] 6.1 Live dev check (heads-up: the shared dev stack then runs without the four services; the paused `~/autologger-ui` checkout brings them back on its next `make dev-up` until it rebases):
  - `make dev-up` prints the retired-keys warning, naming the five keys and no value;
  - `docker ps -a --filter label=com.docker.compose.project=autologger-dev --format '{{.Names}}'` shows no `rest`, `realtime`, `storage` or `supabase-gw` container, and `auth` and `db` are healthy;
  - `docker ps --format '{{.Names}} {{.Ports}}'` shows `127.0.0.1` ports only on `autologger-dev-app` and `autologger-dev-companion`;
  - `docker volume ls` still lists `autologger-dev_supabase-storage`, `autologger-dev_supabase-db` and `autologger-dev_supabase-db-config`;
  - `docker exec autologger-dev-auth-1 env` shows `API_EXTERNAL_URL`, `GOTRUE_SITE_URL` and `GOTRUE_JWT_ISSUER` as `http://auth:9999`;
  - from the app container, `fetch('http://auth:9999/settings')` reports sign-up on, `google` the only enabled provider, email, phone and anonymous off, auto-confirm off;
  - the owner signs in with Google through the browser at `http://localhost:8787/`, and `/api/profile` reports the owner (the real GoTrue path; design assumption 8).
- [ ] 6.2 CI on the PR: the integration and pg suites are green, with counts against the slice 10 baseline (PR #101 run 37829084541: server pg and integration 1445 passed, 1 skipped; storage pg 109). No server code changed, so the counts must match.
- [ ] 6.3 `scripts/check-change.sh` with all gates, then a consistency read by a fresh subagent across the artifacts, the code and the docs. Each finding is fixed or reported to the owner.
