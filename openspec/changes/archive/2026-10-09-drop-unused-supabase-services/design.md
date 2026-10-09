# Design: drop-unused-supabase-services

## Context

Each stack adds two files through `docker/scripts/compose-env.sh`:
- `docker/supabase-db.yaml`: `db` and `migrate`;
- `docker/supabase-services.yaml`: `auth` (GoTrue), `rest` (PostgREST), `realtime`, `storage`
  and the gateway `supabase-gw`.

The gateway (`docker/supabase-gw.Caddyfile`) is the only service that publishes a Supabase port,
`127.0.0.1:${SUPABASE_PORT}` (dev 8790, stage 8791), through the `edge` network. `rest`,
`realtime` and `storage` join only `db` and `supabase`. `auth` joins `db`, `supabase`,
`auth-egress` (its way out, to Google) and `auth-app` (shared only with the app).

The app uses only two of these:
- Postgres, over `catalog`, as `autologger_app`;
- GoTrue, over `auth-app`, at `http://auth:9999/token?grant_type=id_token`
  (`server/src/auth/gotrue.ts`). The tokens GoTrue returns are discarded; only the user id is kept.

The secrets tooling carries the services' keys:
- `compose-run.mjs` `SUPABASE_KEYS` lists nine interpolation keys, each with a format.
  `checkSupabaseKeys` verifies the `JWT_SECRET`/`ANON_KEY`/`SERVICE_ROLE_KEY` trio.
- `SECRET_SCOPE` names the services each value may appear in, and `checkResolved` expects the
  published-port owners `[app, companion, supabase-gw]` (dev) or `[router, supabase-gw]`.
- `supabase-keys.mjs` creates six random keys plus the two JWTs.
- `check-envs.sh` invariant 16 (`check_supabase`) repeats the same table (`SB_SECRETS`,
  `SB_SCOPE`) and pins every network and service.

GoTrue's three URLs use `SUPABASE_PORT`, because they described the gateway path:
`API_EXTERNAL_URL=http://localhost:${SUPABASE_PORT}/auth/v1`,
`GOTRUE_SITE_URL=http://localhost:${SUPABASE_PORT}`, and
`GOTRUE_JWT_ISSUER=http://localhost:${SUPABASE_PORT}/auth/v1`.

## Assumptions

Each assumption, the command that tests it, and what it showed (2026-10-08, the running dev stack
of `supabase-migration` at `8ee2d5c2`).

1. **Nothing calls the four services.**
   `grep -rnE "rest:3000|realtime:4000|storage:5000|supabase-gw|SUPABASE_PORT|ANON_KEY|SERVICE_ROLE_KEY|/rest/v1|/realtime/v1|/storage/v1|supabase-js|@supabase/" server/src web/src packages/*/src companion/src server/scripts`
   -> no output. No `package.json` depends on a Supabase client.
2. **GoTrue already accepts only Google, and the app can read its settings directly.**
   `docker exec autologger-dev-app node -e "fetch('http://auth:9999/settings')…"` ->
   `{"disable_signup":false,"autoconfirm":false,"anon":false,"email":false,"phone":false,"enabled":["google"]}`.
   So the scenario that read `/auth/v1/settings` through the gateway can read
   `http://auth:9999/settings` from inside `auth-app`.
3. **`compose up` leaves the old containers running, and `--remove-orphans` removes them without
   touching volumes.** A throwaway project (`al-orphan-probe`, `alpine:3.22`) with services `keep`
   and `gone` (with a named volume), then a file with `keep` only:
   - `docker compose up -d` -> `Found orphan containers (al-orphan-probe-gone-1)`, and `gone-1`
     still exists;
   - `docker compose up -d --remove-orphans` -> `Container al-orphan-probe-gone-1 Removed`; the
     volume `al-orphan-probe_gonevol` remains.
4. **`down -v` doesn't delete a volume the files no longer declare, and leftover networks stay.**
   The same probe: after `docker compose down -v`, `al-orphan-probe_gonevol` is still listed. A
   network only the removed service joined (`al-orphan-probe_n2`) survives both
   `up --remove-orphans` and `down`. So after this change `make dev-reset` no longer deletes the
   `supabase-storage` volume, and the `supabase` and `edge` networks of a stack that ran the old
   services stay until removed by hand. The README's cleanup note covers all three.
5. **`compose config` drops a declared network that no service joins.** A file declaring `n1`
   (joined) and `edge` (not joined): `docker compose config --format json | jq -c '.networks|keys'`
   -> `["n1"]`. So invariant 16 can only see a `supabase` or `edge` network that some service
   joins; a test case for it must join one.
6. **The leftovers exist on dev.** `docker volume ls` -> `autologger-dev_supabase-storage`.
   `psql -U postgres -Atc "select nspname from pg_namespace where nspname in ('_realtime','storage','realtime')"`
   -> `_realtime`, `realtime`, `storage`, and `storage` holds 10 tables. The image creates the
   `realtime` and `storage` schemas itself; `_realtime` comes from `realtime.sql` and realtime's
   migrations, and most `storage` tables from storage-api's migrations.
7. **The host can already reach GoTrue at its `auth-egress` address.** `auth-egress` is not
   internal, so the host has an address on that bridge. `curl http://172.28.35.2:9999/health` from
   the host -> `200`; the `auth-app` (172.28.36.1), `db` and `supabase` addresses -> no
   connection. This is true today and this change doesn't alter it. With the gateway gone, the
   host's reach into GoTrue is that address only. See Risks.
8. **GoTrue's id_token grant doesn't depend on its external URLs.** The grant checks the Google ID
   token's signature and audience (`GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID`). `API_EXTERNAL_URL` builds
   redirect and callback links for flows the app never uses, and `GOTRUE_JWT_ISSUER` only sets
   the `iss` of the tokens the server discards. Not testable without a Google ID token: task 6.1's
   live sign-in by the owner tests it, and task 3.2 records `/settings` after the change.

## Decisions

### D1. Services and files

- **`docker/supabase-services.yaml`** keeps only `auth`. The `rest`, `realtime`, `storage` and
  `supabase-gw` services go, and so does the top-level `volumes: supabase-storage:`. The `x-svc`
  anchor loses its `networks` default; `auth` sets `networks: [db, auth-egress, auth-app]`. The
  header comment describes invariant 16 as D4 states it.
- **`docker/supabase-db.yaml`:**
  - drops the `jwt.sql` and `realtime.sql` mounts and `JWT_EXP` (only `jwt.sql` read it, for
    PostgREST's `app.settings.jwt_exp`);
  - keeps the `roles.sql` mount and `SUPABASE_ROLES_PASSWORD`.
- **`docker/supabase/init/roles.sql`** keeps only `ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';`.
  On a fresh database, `authenticator` and `supabase_storage_admin` then keep the image's default,
  which sets no password, so they can't log in over the network.
- **Deleted:** `docker/supabase/init/jwt.sql`, `docker/supabase/init/realtime.sql`,
  `docker/supabase-gw.Caddyfile`, `docker/supabase/test_gateway.sh`.
- **Init SQL runs only on an empty data volume.** Existing dev and stage databases keep their
  settings, the `_realtime` schema, the storage tables, and the old role passwords. Nothing here
  re-initialises a database.
- **Networks.** `compose.yaml` and `docker/compose.dev.yaml` drop the `supabase` and `edge`
  declarations and their comments; `docker/compose.stage.yaml` drops their two `ipam: !override`
  entries. Every other subnet stays where it is.
- **`docker/scripts/compose-env.sh`:** only its comment changes (`auth` instead of the five
  services).

### D2. GoTrue's URLs

In `auth`'s environment:
- `API_EXTERNAL_URL: http://auth:9999`
- `GOTRUE_SITE_URL: http://auth:9999`
- `GOTRUE_JWT_ISSUER: http://auth:9999`

They are literals, so `auth` reads no `SUPABASE_PORT`. Every other GoTrue variable is unchanged:
Google only, sign-up on, email, phone and anonymous sign-in off, auto-confirm off, no redirect
allow-list. Assumption 8 is why these values are safe; task 6.1 proves it with a real sign-in.

### D3. Secrets tooling

**`docker/scripts/compose-run.mjs`:**
- `SUPABASE_KEYS` becomes `['POSTGRES_PASSWORD', 'SUPABASE_ROLES_PASSWORD', 'APP_DB_PASSWORD', 'JWT_SECRET']`.
  The compose files require them through their `${…:?}` guards, as today.
- New `RETIRED_KEYS = ['ANON_KEY', 'SERVICE_ROLE_KEY', 'SECRET_KEY_BASE', 'REALTIME_DB_ENC_KEY', 'SUPABASE_PORT']`:
  - `allowedNames(env)` includes them, so a secret that holds them isn't refused;
  - `KEY_FORMAT` loses their entries, so their values are never format-checked. The checks every
    key gets (a valid name, a string, no NUL) still apply, as for `API_TOKEN`;
  - the child environment is built from the secrets without them, so compose and every container
    never see them;
  - when any is present, one line goes to stderr, with names only:
    `compose-run: warning: the OpenBao <env> secret holds retired keys <names>; nothing reads them, and they can be removed once no checkout runs the old Supabase services (docs/openbao-secrets.md)`.
    An exported `retiredKeyWarning(secrets, env)` returns that line, or nothing.
- `checkSupabaseKeys` is deleted, along with its call and the `node:crypto` imports it alone
  used. Its only job was the anon/service-role trio. `JWT_SECRET` keeps its `KEY_FORMAT` check.
- `SECRET_SCOPE`:

  | Key | Services |
  | --- | --- |
  | `POSTGRES_PASSWORD` | `db`, `migrate` |
  | `APP_DB_PASSWORD` | dev `app`, `migrate`; stage and prod `api`, `migrate` (unchanged) |
  | `SUPABASE_ROLES_PASSWORD` | `db`, `auth` |
  | `JWT_SECRET` | `auth` |

- `checkResolved`'s expected published-port owners: dev `['app', 'companion']`, stage and prod
  `['router']`. The rest of the port checks don't change.
- `urls()` drops the `Supabase:` line and the `supabase-gw` lookup.

**`docker/scripts/supabase-keys.mjs`:**
- `KEYS` holds `POSTGRES_PASSWORD`, `SUPABASE_ROLES_PASSWORD`, `APP_DB_PASSWORD` and `JWT_SECRET`.
- `TRIO`, `apiKey()`, the partial-trio refusal and the JWT creation go, with the `createHmac`
  import.
- It reports `kept` or `created` for its four keys only. It never reads, reports, writes or
  deletes a retired key; the merge-patch write leaves them in place.
- The header comment and the usage text are unchanged apart from the key list.

### D4. Compose invariants (`docker/scripts/check-envs.sh`)

- **Sentinels:**
  - `SB_SECRETS` becomes the four keys of D3, and `SB_SCOPE` the table of D3.
  - New `SB_RETIRED` holds the five retired keys, each with a sentinel value and no allowed
    service. A sentinel found in any service fails invariant 16, so a compose edit that references
    a retired key again is caught. The plan only shrank the table; this extends it for no new
    file.
  - The `SUPABASE_PORT=18790` line goes; `SUPABASE_PORT` gets a sentinel like the others.
- **`check_supabase` (invariant 16)** takes `db`, `catalog`, `auth-egress` and `auth-app`
  subnets. It fails when:
  - `db` or `migrate` is missing or publishes a port; `migrate` joins any network but `db`; `db`
    joins any but `db` and `catalog` (unchanged);
  - the `catalog` members aren't exactly `db` and the app (unchanged);
  - a service shares the namespace of `db`, `migrate`, `auth` or the app, other than `app-gate`
    in dev;
  - `auth` is missing, publishes a port, or its networks aren't exactly `auth-app`,
    `auth-egress` and `db`;
  - a service other than `db`, `migrate` and `auth` joins `db`;
  - **new:** a service named `rest`, `realtime`, `storage` or `supabase-gw` exists, or the
    resolved config has a `supabase` or `edge` network (which, by assumption 5, means a service
    joins one);
  - `auth-egress` or `auth-app` membership, or stage and prod `api`'s networks, are wrong
    (unchanged);
  - `db`, `catalog` or `auth-app` isn't internal, host-isolated and on its pinned subnet, or
    `auth-egress` isn't on its pinned subnet;
  - the image of `db`, `migrate` or `auth` isn't pinned by `@sha256:`;
  - a secret's sentinel appears outside its services (the four keys), or a retired key's sentinel
    appears in any service.
- **Published ports (invariants 2 and 3):** dev owners are exactly `app` and `companion`; the
  raw-mapping check and the distinct-ports check drop `supabase-gw`. Stage's owner is exactly
  `router`.
- **Dev service set (invariant 6):** exactly `app`, `app-gate`, `auth`, `companion`,
  `companion-gate`, `db`, `migrate`.
- **Dev binds (invariant 4):** `ALLOW` loses `docker/supabase-gw\\.Caddyfile`, and the
  "mounted only into" check keeps only the init SQL into `db`. The messages change to match.
- **The header comments** of `check-envs.sh` and the invariant 16 block describe the new set.

**`docker/scripts/test_check_envs.sh`** (D8 category 2):
- **Dropped,** because their target no longer exists: `gwdb` (gateway on `db`), `restedge` (rest on
  `edge`), `sbinternal` (a non-internal `supabase` network), `edgesubnet` (`edge` off its subnet).
- **Retargeted to a service that still exists:**
  - `pwrest` -> `POSTGRES_PASSWORD` in `auth`;
  - `apprest` -> `APP_DB_PASSWORD` in `auth`;
  - `storageport` -> `auth` publishing a port;
  - `restcat` -> `auth` on `catalog`;
  - `restegress` -> `db` on `auth-egress`;
  - `restauthapp` -> `db` on `auth-app`;
  - `authnoapp` -> its `sed` pattern matches the new `[db, auth-egress, auth-app]` line;
  - `gwbind` -> `docker/Caddyfile` bound into the dev app fails invariant 4 (a docker file
    outside the allowlist);
  - `anonapi` stays and is caught by the retired-key sentinel.
- **New cases:**
  - a `rest` service added back, digest-pinned with no port, on `db`, fails invariant 16;
  - a `supabase-gw` service added back fails invariants 16 and 3 (dev);
  - `auth` joined to a new `supabase` network fails invariant 16;
  - a service joined to a new `edge` network fails invariant 16;
  - `${SERVICE_ROLE_KEY}` in an `auth` label fails invariant 16;
  - a `rest` service added to the dev project also fails invariant 6 (the dev service set). No
    existing case covers the service set.

### D5. Orphan containers

- After D1, `compose up` leaves the old four containers running (assumption 3). The Makefile's
  `compose up` steps gain `--remove-orphans`:
  - `dev-up`: `'compose up -d --build --remove-orphans'`;
  - `STAGE_UP_STEPS`, both forms: `'compose up -d --build --remove-orphans'` and
    `'compose up -d --no-build --remove-orphans'`. `checkStagePlan` still sees `--no-build`;
  - `prod-up`: `'compose up -d --remove-orphans'`;
  - every `compose down` step as well (panel): `dev-down`, `stage-down`, `prod-down`
    (`'compose down --remove-orphans'`) and both resets (`'compose down -v --remove-orphans'`).
    Without it, a reset leaves containers that the other checkout started (Realtime holds the
    superuser password) running against the fresh database that the next `compose run --rm migrate`
    creates, until the following `up` removes them.
- Removing a container deletes no volume (assumption 3). Leftover networks stay (assumption 4).
- `compose run --rm migrate` keeps printing the orphan warning until the following `up` removes
  them, which is harmless.
- **The check:** a new case in `docker/scripts/compose-run.test.mjs` reads the `Makefile` and
  asserts that every quoted `'compose up …'` and `'compose down …'` step holds `--remove-orphans`,
  and that there are four `up` and five `down` steps.
- The help text of `dev-up`, `dev-reset` and `stage-reset` drops "Supabase" and "Supabase
  storage". The reset targets still run `compose down -v`, which no longer reaches the leftover
  storage volume (assumption 4).

### D6. Docs

- **`docs/supabase.md`:** rewritten around `db`, `migrate` and `auth`:
  - Layout: the two compose files, no gateway;
  - the network table without `supabase` and `edge`, with `db` holding `db`, `migrate`, `auth`;
  - volumes: the two Postgres volumes;
  - the roles table: the `authenticator` and `supabase_storage_admin` rows go, and
    `POSTGRES_PASSWORD` is used by `db` and `migrate` only;
  - "The gateway" becomes "GoTrue": the Google-only rules, the internal URL, and how to read
    `/settings` from the app container;
  - Commands, and the init SQL section (one file, `roles.sql`);
  - Rotation: the trio, `SECRET_KEY_BASE` and `REALTIME_DB_ENC_KEY` entries go. `JWT_SECRET` is
    rotated alone only once no checkout runs the old stack and the retired keys are removed (until
    then an older `compose-run.mjs` refuses a `JWT_SECRET` its stored anon and service-role keys
    don't verify against), and rotating it is also what retires the old `SERVICE_ROLE_KEY` as a
    GoTrue admin credential (see Risks), and `SUPABASE_ROLES_PASSWORD` only needs `\password supabase_auth_admin`;
  - Residual risks: the Realtime and shared-network items go. A new item: the host reaches GoTrue
    at its `auth-egress` address (assumption 7).
- **`docs/openbao-secrets.md`:** the key table holds the four keys with their services; the
  generator text loses the trio and `SUPABASE_PORT`; a "Retired keys" note lists the five keys,
  says the tooling accepts and ignores them with a warning, and gives the removal command
  (`bao kv patch` with `null` values, or the UI) for when no checkout runs the old stack.
- **`docs/security.md`:** the ASI06 row names GoTrue's logs instead of "the Supabase services";
  the frame-bus paragraph's "a Supabase service role" becomes "a Supabase role login"; the PUBLIC
  `CONNECT`/`TEMP` note names GoTrue.
- **README:**
  - the make table rows for `dev-up`, `stage-up`, `dev-reset` and `stage-reset`;
  - the stage URL bullet (GoTrue's internal URLs; no gateway or storage URL);
  - the testing paragraph's `test_gateway.sh` mention;
  - the connections note (shared with GoTrue and `migrate`);
  - a "Removing the old Supabase services' leftovers" note with
    `docker volume rm <project>_supabase-storage`, `docker network rm <project>_supabase <project>_edge`,
    and, optionally, `DROP SCHEMA _realtime CASCADE` and the storage tables, to run once no
    checkout runs the old stack. It warns that `autologger-ui` still does.
- **ADR 0021:** slice 10 item 3 is done: Realtime, Storage, PostgREST and the gateway are gone,
  GoTrue stays for the planned username-and-password sign-in, the retired keys are ignored, and
  the leftovers stay documented.
- **ADR 0023:** a status note: the Realtime service was removed (owner, 2026-10-08); adopting
  Realtime later means adding the service back.

### D7. Spec deltas

- **`local-container-environments`:**
  - MODIFIED:
    - "Makefile entry points per environment": the URLs, `--remove-orphans`, the reset text;
    - "Dev environment runs the hot-reload single process with every integration": the renamed
      secrets requirement in its cross-reference;
    - "Dev app binds loopback behind a Host/Origin gate": the gate ports;
    - "Dev isolates data and secrets, sharing only the operator's Claude login": the bind
      exceptions;
    - "Stage coexists with prod; dev is disjoint by construction": networks, volumes,
      `SUPABASE_PORT`;
    - "Stage can run pushed images behind a public HTTPS edge": `--remove-orphans` and GoTrue's
      URLs.
  - REMOVED and ADDED under a new title, because a scenario title would become false:
    - "Static invariant check" -> "Static invariant check of the compose projects". "The gateway
      on the db network is caught" and "A host-reachable supabase network is caught" give way to
      "A retired Supabase service is caught", "A supabase or edge network is caught" and "A
      retired key in a compose file is caught". The other scenarios keep their titles, retargeted
      from `rest` to services that remain.
    - "Supabase secret generator" -> "Database and GoTrue secret generator". The trio scenarios
      give way to "The JWT secret is created alone" and "Retired keys are left alone".
    - "Secrets come from OpenBao, one KV path per stack" -> "Secrets come from one OpenBao KV path
      per stack, retired keys ignored". "Swapped Supabase API keys are refused" gives way to
      "Retired Supabase keys are accepted and not passed on".
  - REMOVED: "Supabase gateway routes and key checks". Its GoTrue part moves to the new "GoTrue
    accepts only Google sign-in", checked inside `auth-app` against `http://auth:9999/settings`.
- **`container-deployment`**: "Compose topology is loopback-published, segmented, and operable"
  is REMOVED and re-ADDED as "Compose topology publishes only the router, segmented, and
  operable" (panel): the service list, host exposure (with the `auth-egress` residual stated),
  segmentation, volumes, secret scope, and the bodies of three scenarios. Its scenario "Only the
  router is reachable from the host" would be false (the host reaches GoTrue on `auth-egress`,
  assumption 7), so it becomes "Only the router publishes a host port"; the other titles stay.
- **`catalog-database`**, "The catalog is not exposed through the Supabase API roles": wording
  only. The roles still exist in the image, and the pg tests stay.

### D8. Tests

Write the test first. Existing tests change only in these categories:

1. **compose-run and supabase-keys tests on the removed keys, the trio, the gateway and `urls`.**
   - In `docker/scripts/compose-run.test.mjs`: the `sbSecrets()` fixture, the child-environment
     names list (no retired key), the trio test (deleted with `checkSupabaseKeys`), the format test's
     retired rows, the scope test's `realtime`/`storage`/`supabase-gw` fixtures, and the `supabase-gw`
     port owners in the port tests.
   - In `docker/scripts/supabase-keys.test.mjs`: the merged-keys case, the partial-trio case
     (deleted), and the `app password for an existing stack` case's key set.
2. **check-envs and test_check_envs cases on the removed services** (D4's lists).
3. **No server, web, Companion or package test changes.** The DB suites must keep the slice 10
   counts.

New tests:
- **compose-run:**
  - the retired keys, with values that would fail the old formats, are accepted; one warning
    names exactly the ones present and no value; none reaches the child environment;
  - an `ANON_KEY` signed with another secret is no longer refused;
  - `JWT_SECRET` in `rest` or `storage` (a fixture service) is refused by the scope check;
    `POSTGRES_PASSWORD` in `realtime` is refused;
  - a dev config with a published `supabase-gw` port is refused as not the expected set;
  - `urls` prints no `Supabase:` line;
  - the Makefile's `compose up` steps all carry `--remove-orphans` (D5).
- **supabase-keys:**
  - an empty path gets exactly the four keys;
  - a path holding `JWT_SECRET` and no `ANON_KEY` is not refused and writes nothing new;
  - a path holding the retired keys reports none of them and sends no write when the four exist.
- **check-envs:** D4's new cases.

## Risks

- **The host reaches GoTrue** at its `auth-egress` address (assumption 7). This is true today:
  `auth-egress` must route to the internet, so it can't be host-isolated. Before, the host could
  also use the gateway's `/auth/v1` with the anon key; now it reaches GoTrue's API directly,
  without a key. What that allows: reading `/settings` and `/health`, and the id_token grant with
  a valid Google ID token for this client, the same exchange the app makes. Sign-up by email,
  phone or anonymously is off. GoTrue's admin API needs a `service_role` JWT signed with
  `JWT_SECRET` (`curl http://172.28.35.2:9999/admin/users` from the host -> `401`). **The retired
  `SERVICE_ROLE_KEY` is such a JWT** (5-year expiry, signed with the `JWT_SECRET` this change keeps):
  it stays in OpenBao (owner decision 2) and in the other checkout's old containers, so until
  `JWT_SECRET` is rotated it remains a GoTrue admin credential, now usable directly against
  `auth`'s `auth-egress` address instead of through the gateway. The reach is not new (the gateway
  gave the same reach with the same key); the follow-up is ordered: once no checkout runs the old
  stack, remove the retired keys and then rotate `JWT_SECRET` (docs D6, `docs/supabase.md`
  "Residual risks" and `docs/openbao-secrets.md` "Retired keys" say so). The ADR 0021 revisit list already carries "an egress
  allowlist for GoTrue". `docs/supabase.md` "Residual risks" records this.
- **The shared dev stack flips.** After the live check, `kv/autologger/dev`'s stack runs without
  the four services. The paused `~/autologger-ui` checkout recreates them on its next
  `make dev-up` (its own files still declare them, and the retired keys are still in OpenBao),
  and this checkout's next `make dev-up` removes them again. Both work; each `up` just recreates or
  removes four containers.
- **Old passwords stay on old databases.** On dev and stage, `authenticator` and
  `supabase_storage_admin` keep `SUPABASE_ROLES_PASSWORD`. Only `db`, `migrate` and `auth` share
  the `db` network now, and `auth` holds that password anyway, so nothing new can use them. The
  README cleanup note gives `ALTER ROLE … PASSWORD NULL` as an optional step.
- **A reset no longer deletes the storage volume** (assumption 4). The README cleanup note and
  the reset help text say so.
- **GoTrue's URLs** (assumption 8): if the id_token grant did depend on them, sign-in would fail
  with `identity_unavailable`. The live check catches that before merge, and Rollback restores the
  old values.

## Rollback

1. Revert the change's commits and run `make dev-up` (or `stage-up`). The old compose files bring
   the four services back. They reuse the leftovers: the `supabase-storage` volume, `_realtime`,
   and the storage tables.
2. That needs the retired keys to still be in the stack's OpenBao secret. Owner decision 2 keeps
   them there, and the docs say to remove them only once no checkout runs the old stack. If they
   were removed (or the secret was first created after this change, holding `JWT_SECRET` alone):
   - delete `JWT_SECRET` from the secret too, because the old generator and the old
     `compose-run.mjs` refuse a partial `JWT_SECRET`/`ANON_KEY`/`SERVICE_ROLE_KEY` trio, then run the
     old `supabase-keys.mjs` from the reverted tree, which creates the three together, plus
     `SECRET_KEY_BASE` and `REALTIME_DB_ENC_KEY`;
   - set `SUPABASE_PORT` by hand (`bao kv patch … SUPABASE_PORT=8790`; the old generator never
     creates it);
   - GoTrue's tokens are discarded by the server, so a new `JWT_SECRET` costs nothing.
3. A database first created after this change misses what the deleted init SQL did. Before the
   reverted stack starts, run with `make dev-psql` (all in git history):
   - the `realtime.sql` and `jwt.sql` statements (`_realtime` schema, `app.settings.jwt_exp`);
   - the two dropped `roles.sql` lines, setting `SUPABASE_ROLES_PASSWORD` on `authenticator` and
     `supabase_storage_admin`; without them `rest` and `storage` can't log in, and `supabase-gw`,
     which waits for both to be healthy, never starts.

   Existing dev and stage databases already have all of these.
