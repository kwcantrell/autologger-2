# Tasks

The first commit on `supabase-1.2b-services` is `openspec/changes/supabase-services/` only,
staged by path. The PR targets `supabase-migration` with the `size-override` label. Commit and
size gates run with `GITHUB_BASE_REF=supabase-migration`.

**Tests.** Committed regression tests don't count toward size:
- `compose-run.test.mjs` and `supabase-keys.test.mjs` (`npm test`);
- `test_check_envs.sh`;
- `test_migrate.sh`;
- the new `docker/supabase/test_gateway.sh`. It runs by hand against a running stack, since CI
  has no docker.

Each task names the test written first and seen failing. Live runs print names, statuses and
counts only, never a value.

## 1. Wrapper: keys, formats, JWT consistency, confinement, ports

- [x] 1.1 Change `compose-run.mjs` (design D4):
  Evidence: tests first: `node --test docker/scripts/compose-run.test.mjs` -> `SyntaxError: … does not provide an export named 'checkSupabaseKeys'` (`ℹ fail 1`); after -> `ℹ tests 43` / `ℹ pass 43` / `ℹ fail 0` (new: each format refuses without printing; swapped, foreign-secret, expired, `alg: none`, duplicate and missing keys refused; under-90-day warning; ANON_KEY in api, POSTGRES_PASSWORD in rest, SERVICE_ROLE_KEY in realtime refused). Sequencing: the port counts and the `urls()` Supabase line need `supabase-gw` in the compose files, so they land and are tested in task 3.3.
  - the seven keys in `COMPOSE_KEYS` and their formats;
  - JWT consistency;
  - `SECRET_SCOPE` replacing `PG_SERVICES`;
  - port counts and `urls()`.

  Tests first:
  1. each format refuses a bad value without printing it;
  2. swapped keys are refused;
  3. a key signed with another secret is refused;
  4. an expired key is refused;
  5. a near-expiry key warns;
  6. `ANON_KEY` in `api`, `POSTGRES_PASSWORD` in `rest`, and `SERVICE_ROLE_KEY` in `realtime`
     are each refused;
  7. a dev config with 2 published ports is refused;
  8. `urls` prints the Supabase line.

  Check: `npm test`.

## 2. Generator

- [x] 2.1 Extend `supabase-keys.mjs` (design D5). Tests first:
  Evidence: tests first: `node --test docker/scripts/supabase-keys.test.mjs` -> `✖ existing keys are kept…`, `✖ all missing keys are created in one batch…`, `✖ a partial JWT trio is refused…` (`ℹ pass 6` / `ℹ fail 3`); after -> `ℹ tests 9` / `ℹ pass 9` / `ℹ fail 0` (one batch POST; each value in its format; ANON/SERVICE keys verify by HMAC against the batch's JWT_SECRET with role, `iss: supabase`, `exp - iat = 5y`; partial trios refused with no batch; no value in the output).
  1. a fresh environment gets all missing keys in exactly one batch POST, each in its format;
  2. `ANON_KEY` and `SERVICE_ROLE_KEY` verify against the generated `JWT_SECRET`, with the right
     `role`, `iss`, and a 5-year `exp`;
  3. a partial trio is refused before any POST, naming the keys;
  4. existing keys are kept;
  5. no value appears in the output.

  Check: `npm test`.
- [x] 2.2 Run the generator for dev and stage with the bootstrap identity, and set
  Evidence: `node docker/scripts/supabase-keys.mjs {dev,stage} --writer ~/.infisical-bootstrap` -> `kept POSTGRES_PASSWORD`, `created SUPABASE_ROLES_PASSWORD`, `created JWT_SECRET`, `created SECRET_KEY_BASE`, `created REALTIME_DB_ENC_KEY`, `created ANON_KEY`, `created SERVICE_ROLE_KEY`, rc=0 (both); scratch `set-port.mjs` -> `dev SUPABASE_PORT 8790 -> 200`, `stage SUPABASE_PORT 8791 -> 200`; rerun -> `7 kept` (both); `compose-run.mjs {dev,stage} resolved` -> rc=0 (formats and the JWT consistency check pass on the real values).
  `SUPABASE_PORT` (dev 8790, stage 8791) with a scratch script that prints statuses only.
  - Check: `created` for each new key, and `kept POSTGRES_PASSWORD`. A rerun prints only `kept`.
    `compose-run.mjs {dev,stage} resolved` exits 0.
- [x] 2.3 Update `docs/infisical-secrets.md` (the keys, formats, scopes, generator and prod
  Evidence: `grep -c` per key in docs/infisical-secrets.md -> POSTGRES_PASSWORD 1, SUPABASE_ROLES_PASSWORD 1, JWT_SECRET 5, ANON_KEY 2, SERVICE_ROLE_KEY 2, SECRET_KEY_BASE 1, REALTIME_DB_ENC_KEY 1, SUPABASE_PORT 4 (the "Supabase keys" table: format and services; generator; cutover-only prod; rotation pointer; break-glass); `grep -c 'untrusted data' docs/security.md` -> 1 (ASI06 row).
  ordering) and `docs/security.md` (container logs are untrusted data).
  - Check: `grep` each key name.

## 3. Services, networks, gateway, checks

- [x] 3.1 Add the `test_check_envs.sh` cases first (design D7) and see them fail. Then implement
  Evidence: cases first: `sh docker/scripts/test_check_envs.sh` -> `test_check_envs: 0 passed, 27 failed` (the old check couldn't resolve the new files); after -> `check-envs: ok (all)` and `test_check_envs: 27 passed, 0 failed` (new: superuser password in rest, gateway on db, rest on edge, non-internal supabase, unpinned auth, storage port, edge subnet drift, anon key in api -> invariant 16; gateway Caddyfile and init SQL binds outside their service -> invariant 4).
  `check-envs.sh`.
  - Check: every case passes, naming its invariant, and `make check` passes.
- [x] 3.2 Write:
  Evidence: `make dev-down`; `docker volume rm autologger-dev_supabase-db autologger-dev_supabase-db-config`; `make dev-up` (after the owner stopped a vLLM container holding :8000, and after changing storage's healthcheck to `127.0.0.1`, since it listens on IPv4 only) -> `0 applied`, `Supabase:       http://localhost:8790`; every dev container `(healthy)`. `dev-data` CreatedAt `2026-09-30T20:08:17-07:00` before and after. Over the `db` network: `authenticator`/`supabase_auth_admin`/`supabase_storage_admin` with the roles password -> `login OK`; `supabase_admin` with it -> `login FAILED`; `authenticator` with the superuser password -> `login FAILED`. `up -d --force-recreate auth rest realtime storage` -> all `(healthy)`; `auth user=supabase`, `rest user=1000`, `realtime user=65534:65534`, `storage user=` (root), all `capadd=null capdrop=["ALL"]`. Wrapper port counts and `Supabase:` URL (moved from 1.1): `compose-run.test.mjs` red first (`✖ dev needs app, Companion and the gateway…`, `✖ resolved passes and urls…`), then both files `ℹ tests 53` / `ℹ pass 53`.
  - `docker/supabase-services.yaml` (four services);
  - the `supabase` and `edge` networks in the three base files;
  - the init SQL and its `db` mounts, and `SUPABASE_ROLES_PASSWORD` on `db`;
  - the `compose-env.sh` `-f` (design D1, D2, D6).

  Then the one-time step on dev: `make dev-down`, `docker volume rm autologger-dev_supabase-db
  autologger-dev_supabase-db-config`, then `make dev-up`. Checks:
  - every service is healthy;
  - the app's `dev-data` volume CreatedAt is unchanged;
  - over the `db` network, the service roles log in with `SUPABASE_ROLES_PASSWORD`, and
    `supabase_admin` fails with it;
  - each service is still healthy after `up --force-recreate`.
- [x] 3.3 Write `docker/supabase/test_gateway.sh` first (design D7) and see it fail against a
  Evidence: test first, against the placeholder gateway (`respond 200`): `sh docker/supabase/test_gateway.sh dev` -> `test_gateway (dev): 14 passed, 31 failed` (the 14 include the real host-unreachability cases). With `docker/supabase-gw.Caddyfile` (`caddy validate` -> `Valid configuration`; gateway `healthy`) -> `test_gateway (dev): 45 passed, 0 failed`, e.g. `ok   evil Host refused (403)`, `ok   foreign Origin refused (403)`, `ok   rest root trick /rest/v1/%2F with the anon key (403)`, `ok   realtime tenant API /realtime/v1/api/%2Ftenants with the service key (403)`, `ok   a client token is passed through (anon apikey, service bearer) (200)`, `ok   an empty Authorization is treated as absent (service apikey) (200)`, `ok   realtime broadcast with the anon key (202)`, `ok   realtime websocket join with the anon key (ok)`, `ok   storage upload with the service key (200)`, `ok   host to rest directly (unreachable)`, `ok   rest down gives 502 through the gateway (502)`, `ok   API keys in the gateway log (0)`. One expectation was corrected: GoTrue itself answers 403 (not 401) to the anon key on its admin API, so the case checks that auth refuses it.
  gateway that only answers 200. Then write `docker/supabase-gw.Caddyfile` and the `supabase-gw`
  service.
  - Check: `sh docker/supabase/test_gateway.sh dev` passes every case, including the host
    unreachability case, the `502` log-count case, and the storage upload.
- [x] 3.4 Run a supabase-js smoke script (scratch, `@supabase/supabase-js` in a temp dir) against
  Evidence: scratch `smoke.mjs` with `@supabase/supabase-js` 2.117.2 against `http://localhost:8790` -> `rest: 404 PGRST205`, `storage: buckets=[]`, `signup: 422 signup_disabled`, `realtime: SUBSCRIBED send=ok`. Then the 7 secret values (piped from the containers' env, never printed) counted with `grep -cF` in every `autologger-dev-*` container's logs -> 0 for each of 10 containers, `total 0`.
  dev. It checks:
  - `from('x').select()` gives `PGRST205`, not 401;
  - `storage.listBuckets()` gives `[]`;
  - a realtime channel subscribes, and a broadcast is accepted;
  - `auth.signUp` gives `signup_disabled`.

  Afterwards, every secret value's count in every container's logs is 0.
- [x] 3.5 Stage: the same one-time step for `autologger-stage`, then `make stage-up` and
  Evidence: `make stage-down`; `docker volume rm autologger-stage_supabase-db autologger-stage_supabase-db-config`; `make stage-up` -> `0 applied`, `Supabase:       http://localhost:8791`, every stage container `(healthy)`; `autologger-stage_autologger-data`/`-home` CreatedAt `2026-09-30T17:19:56-07:00` before and after; `sh docker/supabase/test_gateway.sh stage` -> `test_gateway (stage): 45 passed, 0 failed` (incl. `other environment's Host refused`); subnets dev db .31/supabase .32/edge .33, stage .22/.23/.24, db and supabase `internal=true`; `sh docker/scripts/check-envs.sh prod` -> `check-envs: ok (prod)`.
  `test_gateway.sh stage`.
  - Check: stage is healthy beside dev; the six new subnets are distinct; dev's gateway never
    answers with stage's services; `sh docker/scripts/check-envs.sh prod` passes; stage's api
    data volume is unchanged.

## 4. Commands and docs

- [x] 4.1 Makefile help text (the reset and init note) and the README make-target table (not
  Evidence: `make help` -> `dev-up … (app, gate, Companion, Supabase) and migrate`, `dev-reset  DESTROY dev volumes, incl. Postgres and Supabase storage (needs CONFIRM=yes)`, and the same for stage; README make-target rows 1417/1422/1424/1427 updated (the endpoint table is untouched); `make dev-up` tail -> `dev app:        http://127.0.0.1:8787` … `Supabase:       http://localhost:8790   (API gateway: /auth/v1, /rest/v1, /realtime/v1, /storage/v1)`.
  the frozen endpoint table); `urls` on `make dev-up`.
  - Check: `make help` and the `dev-up` tail.
- [x] 4.2 `docs/supabase.md` covers:
  Evidence: docs/supabase.md rewritten (layout, network table, roles, gateway route table, commands, the Postgres-only re-init, migration rules, rotation and recovery, residual risks); ADR 0021 1.2b text updated. Commands run on dev: `echo 'select 1 as ok;' | make dev-psql` -> `1`; `make dev-migrate` -> `0 applied`; re-init exercised in 3.2/3.5; `test_gateway.sh dev` -> 45/45. Roles-password rotation per the doc (scratch `rotate-roles.mjs`: Infisical `PATCH 200`, `ALTER ROLE` x3 as `supabase_admin` -> `rc 0 stderr-clean`, then `make dev-up`) -> `test_gateway (dev): 45 passed, 0 failed`. JWT trio rotation per the doc (delete the three in Infisical -> `delete trio 200`; generator -> `created JWT_SECRET`, `created ANON_KEY`, `created SERVICE_ROLE_KEY`; `make dev-up`) -> gateway test 45/45 and smoke `rest: 404 PGRST205`, `storage: buckets=[]`, `signup: 422 signup_disabled`, `realtime: SUBSCRIBED send=ok`. (A first delete attempt returned 500 because the scratch helper sent no Content-Length; Infisical's log: `Body cannot be empty when content-type is set to 'application/json'`.)
  - the services;
  - the gateway route table;
  - the networks;
  - the keys and their scopes;
  - the one-time Postgres re-initialisation, and when it's needed;
  - rotation and recovery: `SUPABASE_ROLES_PASSWORD` via `ALTER ROLE` as `supabase_admin`, the
    JWT trio together, and a partial generator write;
  - storage disk use;
  - residual risks.

  ADR 0021's slice list: 1.2b covers four services, Studio and meta are deferred, and the
  gateway is the only Supabase port.
  - Check: every command in the doc runs on dev.

## 5. Verify

- [x] 5.1 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`.
  Evidence: `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook` -> every gate `PASS` (incl. `PASS  evidence         every ticked task cites evidence`, `PASS  commands         ran ['typecheck', 'test']`) except `WARN  size             561 changed lines > budget 400`, which the owner pre-approved as `size-override` (proposal Decisions).
  - Check: green, apart from `size` under `size-override`.
- [x] 5.2 Do the consistency read, appended to `panel.md`.
  Evidence: `git diff f226ca6 -- openspec/changes/supabase-services/` -> `tasks.md | 36 +++…` only (ticks and evidence), so no scope change; `panel.md` `## Consistency read 2026-09-30`, 5 minor items, all resolved.
- [ ] 5.3 Archive with `/opsx:archive supabase-services`.
  - Check: `openspec validate --all --strict`.

## Owner-owed (not tracked as tasks; at cutover)

- O.1 On the deploy host, after `main` has this change: run the generator for prod, set
  `SUPABASE_PORT`, then `make prod-check`.
