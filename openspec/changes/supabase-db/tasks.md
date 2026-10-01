# Tasks

The first commit on `supabase-1.2a-db` is `openspec/changes/supabase-db/` only, staged by path
(AGENTS.md rule 6). The PR targets `supabase-migration`.

**Tests.**
- **Committed regression tests**, which don't count toward the size budget:
  - `docker/scripts/test_check_envs.sh` (the static check);
  - `docker/scripts/compose-run.test.mjs` plus a new `docker/scripts/supabase-keys.test.mjs`
    (`node --test`, both added to the `package.json` `test` script);
  - `docker/supabase/test_migrate.sh`, which runs the runner against a throwaway project. It
    needs docker, so it runs by hand like `test_check_envs.sh`. CI doesn't run docker.
- **Test first.** Each task names the case that is written first and seen failing.

**Real-stack runs.** Tasks that need Infisical values use the real `make` targets. Their output
shows names, statuses and counts only.

**Size.** Measure with `scripts/check-change.sh --only size --base origin/supabase-migration`.

**Fallback split.** If the count passes 400, split into two PRs:
- 1.2a-1: generator and key (group 1);
- 1.2a-2: groups 2 and 3.

## 1. Secret key, wrapper rules, generator

- [x] 1.1 Change `compose-run.mjs` (design D4, D6):
  Evidence: tests first: `node --test --test-timeout=30000 docker/scripts/compose-run.test.mjs` -> `✖ prod refuses compose run and exec…`, `✖ resolved refuses a config where the password value appears…` (`POSTGRES_PASSWORD [not-allowed]`); after the change -> `ℹ tests 40` / `ℹ pass 40` / `ℹ fail 0`.
  - `POSTGRES_PASSWORD` in `COMPOSE_KEYS` for dev, stage and prod;
  - the per-key format table;
  - the prod `run`/`exec` refusal;
  - the value-leak rule in `checkResolved`;
  - the partial `readCreds` option.

  Tests first in `compose-run.test.mjs`:
  1. the key reaches the stub docker's env;
  2. `-e` and a 31-character hex value are refused, naming the key, with no value printed;
  3. `prod 'compose run --rm migrate'` and `prod 'compose exec db psql'` are refused before
     docker;
  4. a resolved config whose `app` label contains the value is refused.

  Check: `npm test` passes.
- [x] 1.2 Write `docker/scripts/supabase-keys.mjs ENV --writer FILE` (design D5). Tests first in
  Evidence: tests first: `node --test docker/scripts/supabase-keys.test.mjs` -> `ℹ pass 2` / `ℹ fail 6` (no generator); after -> `ℹ tests 8` / `ℹ pass 8`; both files together -> `ℹ tests 48` / `ℹ pass 48`. `package.json` `test` now runs both files.
  `supabase-keys.test.mjs`, against the HTTPS stand-in:
  1. an existing key gives `kept POSTGRES_PASSWORD` and no POST;
  2. a missing key gives one batch POST whose value is 32 lowercase hex characters, and no
     output contains it;
  3. the listing's query has `secretPath=/`, `recursive=false`, `includeImports=false` and
     `viewSecretValue=false`;
  4. a 409 or 400 create answer exits non-zero, with no PATCH or retry;
  5. a writer file with mode 0644 is refused before any request;
  6. an `http://` URL is refused;
  7. Node 22.11 is refused.

  Add the test to the `package.json` `test` script. Check: `npm test` passes.
- [x] 1.3 Run the generator for dev and stage.
  Evidence: `node docker/scripts/supabase-keys.mjs dev --writer .env.infisical.dev` -> `creating POSTGRES_PASSWORD failed: Infisical answered HTTP 403: You are not allowed to create on secrets (not retried)`, rc=1; with `--writer ~/.infisical-bootstrap`: dev and stage -> `created POSTGRES_PASSWORD` rc=0; rerun -> `kept POSTGRES_PASSWORD` rc=0 (both); `compose-run.mjs {dev,stage} resolved` under `env -i` -> rc=0 (the key passes the format check).
  1. While dev still lacks the key, show that the `viewer` identity can't write: run
     `supabase-keys.mjs dev --writer .env.infisical.dev`. Expect the create to fail with HTTP
     403, exit non-zero, and leave no key.
  2. Run it for dev and stage with `--writer ~/.infisical-bootstrap`. Check: the output is
     `created POSTGRES_PASSWORD` per environment.
  3. Run it again. Check: it prints `kept POSTGRES_PASSWORD`.
- [x] 1.4 Update `docs/infisical-secrets.md`:
  Evidence: `grep -n POSTGRES_PASSWORD docs/infisical-secrets.md` -> lines 66-68 (compose keys table), 88 (`### POSTGRES_PASSWORD (Supabase Postgres)`: placement, format, generator, cutover-only prod, rotation pointer), 164 (break-glass).
  - the key, which reaches `db`/`migrate` only, and its format;
  - the generator command;
  - the cutover-only prod ordering;
  - the break-glass note.

  Check: `grep -n POSTGRES_PASSWORD docs/infisical-secrets.md`.

## 2. The `db` service in every stack

- [x] 2.1 Add the invariant 16 and invariant 4 cases to `test_check_envs.sh` (design D7), test
  Evidence: cases first, against the old check: `sh docker/scripts/test_check_envs.sh` -> `test_check_envs: 0 passed, 17 failed` (the clean tree too: the old check had no db/migrate or sentinel); after implementing -> `check-envs: ok (all)` and 17 lines `ok   …` (e.g. `ok   companion joined to the db network is caught`, `ok   the password in a prod api label is caught`, `ok   the migrations directory mounted outside migrate is caught`), `test_check_envs: 17 passed, 0 failed`.
  first, and watch them fail. Then implement in `check-envs.sh`:
  - `--profile '*'`;
  - the dev service set;
  - the sentinel placeholder;
  - the `ALLOW` additions;
  - invariant 16.

  Check: `bash docker/scripts/test_check_envs.sh` passes, with each case naming its invariant.
- [x] 2.2 Write `docker/supabase-db.yaml` (`db`, both volumes), the `db` network in the three base
  Evidence: `make dev-up` -> `Container autologger-dev-db-1 Started`; `docker inspect` -> `health=healthy ports={"5432/tcp":null} caps=["CAP_DAC_READ_SEARCH","CAP_SETGID","CAP_SETUID"]`; `docker network inspect autologger-dev_db` -> `internal=true subnet=172.28.31.0/24 opts={…gateway_mode_ipv4:isolated…ipv6:isolated}`; host `echo > /dev/tcp/172.28.31.1/5432` -> `HOST_CANNOT_CONNECT`, `ip addr | grep -c 172.28.31` -> `0`; password count in `docker logs` (value piped from `printenv`, never printed) -> `0`. A7 cap set `[DAC_READ_SEARCH, SETUID, SETGID]`: empty volume healthy; `compose stop db`/`start db` -> `restart: status=running health=healthy`; `up -d --force-recreate db` -> `recreate: status=running health=healthy`, `init-scripts` lines after recreate -> `0`; volumes `autologger-dev_supabase-db`, `autologger-dev_supabase-db-config`. `make check` -> `check-envs: ok (all)`.
  files (internal, gateway isolation, pinned subnet), and the extra `-f` in `compose-env.sh`
  (design D1, D2).
  - Choose `cap_add` by testing an empty volume, `make dev-down && make dev-up`, and a
    `--force-recreate` (A7). Record the set and the three results.
  - Checks:
    - `make check` passes;
    - `make dev-up` gives `db` healthy;
    - `docker inspect` shows no port bindings for `db` and `Internal: true`;
    - `bash -c 'echo > /dev/tcp/<db-ip>/5432'` from the host fails;
    - `docker logs` of `db` with `grep -cF` of the password value gives 0. Run this inside the
      wrapper's child, so the value is never printed.
- [x] 2.3 Bring up stage beside the running dev stack.
  Evidence: `make stage-up` with dev up -> `Container autologger-stage-db-1 Started`, `stage db health=healthy ports={"5432/tcp":null}`; `autologger-dev_db internal=true 172.28.31.0/24`, `autologger-stage_db internal=true 172.28.22.0/24`; from stage db `pg_isready -h 172.28.31.1` -> `no response` (rc=2); `sh docker/scripts/check-envs.sh prod` -> `check-envs: ok (prod)`.
  - Check: `make stage-up` is healthy, and `docker network inspect` shows the .31 and .22 `db`
    subnets.
  - Prod is checked statically only: `sh docker/scripts/check-envs.sh prod` passes.
    `make prod-check` waits for cutover (O.1).

## 3. The migrations runner

- [ ] 3.1 Write `docker/supabase/test_migrate.sh` first. It runs against a throwaway project
  (`alg-migrate-test`, its own volume and network, removed on exit) with a fixture directory per
  case. The cases:
  1. an empty directory gives exit 0 and creates the table;
  2. two files apply in order, and a rerun gives `0 applied`;
  3. a good statement followed by a bad one exits non-zero naming the file, leaves neither the
     table nor a record, and doesn't apply a later file;
  4. `add_table.sql`, a duplicate version, a `COMMIT;` line, a `\set ON_ERROR_STOP off` line and
     a subdirectory are each refused before connecting;
  5. two runners started together with one new file give one record and both exit 0;
  6. a file with `'`, `$$` and `:foo` is recorded byte-for-byte (A14).

  See it fail (no runner yet).
- [ ] 3.2 Implement `docker/supabase/migrate.sh` and the `migrate` service (design D3).
  - Check: `sh docker/supabase/test_migrate.sh` passes all cases.
- [ ] 3.3 Add `supabase/migrations/.gitkeep` and the Makefile changes (design D6): migrate-on-up,
  `dev-migrate`, `dev-psql`, and the reset help text. Checks:
  - `make dev-down && make dev-migrate` waits for `db` to be healthy and prints `0 applied`;
  - with a scratch failing file, `make dev-migrate` exits non-zero naming it. Remove the file
    afterwards;
  - `make dev-reset` without `CONFIRM` refuses;
  - `make dev-reset CONFIRM=yes && make dev-up` recreates an empty `db`, and both
    `autologger-dev_supabase-db*` volumes are new;
  - `grep -nE 'prod.*(migrate|psql)' Makefile` is empty.
- [ ] 3.4 Write `docs/supabase.md`, and update the README Makefile table and the ADR 0021 slice
  list (the 1.2a/1.2b split and the 1.2b decisions). `docs/supabase.md` covers:
  - the layout;
  - that the two volumes are a unit;
  - the migration naming and content rules;
  - what can't run in a transaction;
  - out-of-order and edited files;
  - that a reset wipes Postgres;
  - the rotation procedure (`\password` over `dev-psql`, then Infisical), which must be tested
    on dev.

  Check: every command in the doc runs as written on dev.

## 4. Verify

- [ ] 4.1 Run `scripts/check-change.sh --stage hook --base origin/supabase-migration`.
  - Check: it is green, and size is 400 or under.
- [ ] 4.2 Do the tier 2 consistency read, appended to `panel.md`.
- [ ] 4.3 Archive with `/opsx:archive supabase-db`, which syncs the specs.
  - Check: `openspec validate --all --strict` passes.

## Owner-owed

- [ ] O.1 At cutover, after `main` contains this change, on the deploy host:
  `node docker/scripts/supabase-keys.mjs prod --writer <owner writer creds>`, then
  `make prod-check`. This is a step in the slice 11 cutover runbook, not before it.
