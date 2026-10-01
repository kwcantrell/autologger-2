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

- [ ] 1.1 Change `compose-run.mjs` (design D4):
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

- [ ] 2.1 Extend `supabase-keys.mjs` (design D5). Tests first:
  1. a fresh environment gets all missing keys in exactly one batch POST, each in its format;
  2. `ANON_KEY` and `SERVICE_ROLE_KEY` verify against the generated `JWT_SECRET`, with the right
     `role`, `iss`, and a 5-year `exp`;
  3. a partial trio is refused before any POST, naming the keys;
  4. existing keys are kept;
  5. no value appears in the output.

  Check: `npm test`.
- [ ] 2.2 Run the generator for dev and stage with the bootstrap identity, and set
  `SUPABASE_PORT` (dev 8790, stage 8791) with a scratch script that prints statuses only.
  - Check: `created` for each new key, and `kept POSTGRES_PASSWORD`. A rerun prints only `kept`.
    `compose-run.mjs {dev,stage} resolved` exits 0.
- [ ] 2.3 Update `docs/infisical-secrets.md` (the keys, formats, scopes, generator and prod
  ordering) and `docs/security.md` (container logs are untrusted data).
  - Check: `grep` each key name.

## 3. Services, networks, gateway, checks

- [ ] 3.1 Add the `test_check_envs.sh` cases first (design D7) and see them fail. Then implement
  `check-envs.sh`.
  - Check: every case passes, naming its invariant, and `make check` passes.
- [ ] 3.2 Write:
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
- [ ] 3.3 Write `docker/supabase/test_gateway.sh` first (design D7) and see it fail against a
  gateway that only answers 200. Then write `docker/supabase-gw.Caddyfile` and the `supabase-gw`
  service.
  - Check: `sh docker/supabase/test_gateway.sh dev` passes every case, including the host
    unreachability case, the `502` log-count case, and the storage upload.
- [ ] 3.4 Run a supabase-js smoke script (scratch, `@supabase/supabase-js` in a temp dir) against
  dev. It checks:
  - `from('x').select()` gives `PGRST205`, not 401;
  - `storage.listBuckets()` gives `[]`;
  - a realtime channel subscribes, and a broadcast is accepted;
  - `auth.signUp` gives `signup_disabled`.

  Afterwards, every secret value's count in every container's logs is 0.
- [ ] 3.5 Stage: the same one-time step for `autologger-stage`, then `make stage-up` and
  `test_gateway.sh stage`.
  - Check: stage is healthy beside dev; the six new subnets are distinct; dev's gateway never
    answers with stage's services; `sh docker/scripts/check-envs.sh prod` passes; stage's api
    data volume is unchanged.

## 4. Commands and docs

- [ ] 4.1 Makefile help text (the reset and init note) and the README make-target table (not
  the frozen endpoint table); `urls` on `make dev-up`.
  - Check: `make help` and the `dev-up` tail.
- [ ] 4.2 `docs/supabase.md` covers:
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

- [ ] 5.1 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`.
  - Check: green, apart from `size` under `size-override`.
- [ ] 5.2 Do the consistency read, appended to `panel.md`.
- [ ] 5.3 Archive with `/opsx:archive supabase-services`.
  - Check: `openspec validate --all --strict`.

## Owner-owed (not tracked as tasks; at cutover)

- O.1 On the deploy host, after `main` has this change: run the generator for prod, set
  `SUPABASE_PORT`, then `make prod-check`.
