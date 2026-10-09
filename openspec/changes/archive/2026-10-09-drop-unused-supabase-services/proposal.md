# Drop the unused Supabase services: PostgREST, Realtime, Storage and the gateway

Tier: 2
Tier reason:
- it changes the deployment topology of every stack: four services, two networks, one published
  port and a volume go, and the compose invariants in `docker/scripts/check-envs.sh` change;
- it changes the secrets tooling (`docker/scripts/compose-run.mjs`, `docker/scripts/supabase-keys.mjs`):
  five keys are retired, and the per-secret service scope shrinks;
- it changes GoTrue's configuration, which is the sign-in path (`auth`);
- it amends ADR 0021 (slice 10, item 3) and ADR 0023's status.

The HTTP/WS contract doesn't change. No server, web or Companion code changes.

ADR 0021 slice 10, owner decision 3: the follow-up change for the unused Supabase services.

Approved-by: Kalen 2026-10-08

## Why

Every stack (dev, stage, prod) defines `rest`, `realtime`, `storage` and `supabase-gw` in
`docker/supabase-services.yaml`. Nothing calls any of them:

- The server talks to Postgres directly, over the two-member `catalog` network. It talks to GoTrue
  at `http://auth:9999` (`server/src/auth/gotrue.ts:6`), over the two-member `auth-app` network,
  with no Supabase key.
- The web bundle and the Companion module use no Supabase URL.
  `grep -rnE "rest:3000|realtime:4000|storage:5000|supabase-gw|SUPABASE_PORT|ANON_KEY|SERVICE_ROLE_KEY|/rest/v1|/realtime/v1|/storage/v1|@supabase/" server/src web/src packages/*/src companion/src server/scripts`
  finds nothing.
- Realtime was replaced by the 9a session frame bus (ADR 0021 slice 9, ADR 0023's status note).
- Audio stayed on a filesystem volume (slice 10, `shared-blob-volume`).

They still cost:
- four containers per stack;
- five secrets: `ANON_KEY`, `SERVICE_ROLE_KEY`, `SECRET_KEY_BASE`, `REALTIME_DB_ENC_KEY`,
  `SUPABASE_PORT`;
- two networks (`supabase`, `edge`) and one published port per stack;
- the `supabase-storage` volume;
- three init SQL statements, the gateway's Caddyfile and its test script;
- a large share of invariant 16, the docs and the specs.

Realtime also holds the superuser password (`docs/supabase.md` "Residual risks"), so removing it
narrows who holds `POSTGRES_PASSWORD` to `db` and `migrate`.

## Owner decisions (owner, 2026-10-08)

1. **GoTrue stays.** More sign-in methods are planned, starting with username and password, and
   GoTrue provides them. It keeps `JWT_SECRET`, `SUPABASE_ROLES_PASSWORD`, and its `auth-egress`
   and `auth-app` networks.
2. **Retired keys are accepted and ignored.** The tooling no longer requires the five keys, passes
   them to no container, and warns that they can be removed from OpenBao. The shared dev secret
   (`kv/autologger/dev`) also feeds `~/autologger-ui` (`byo-ai-providers`), whose branch still runs
   the old stack. This follows the `API_TOKEN` precedent (ADR 0021 slice 9d).
3. **Leftovers stay, with cleanup documented.** On dev and stage:
   - the `<project>_supabase-storage` volume;
   - the `_realtime` schema;
   - storage-api's tables in the `storage` schema.

   Prod never ran these services. The change destroys nothing.

## What changes

- **Compose (design D1):**
  - `docker/supabase-services.yaml` keeps only `auth`. The `rest`, `realtime`, `storage` and
    `supabase-gw` services and the `supabase-storage` volume declaration go.
  - `auth`'s networks become `[db, auth-egress, auth-app]`.
  - `compose.yaml`, `docker/compose.dev.yaml` and `docker/compose.stage.yaml` drop the `supabase`
    and `edge` networks.
  - Deleted: `docker/supabase-gw.Caddyfile`, `docker/supabase/test_gateway.sh`,
    `docker/supabase/init/realtime.sql` and `docker/supabase/init/jwt.sql`.
  - `docker/supabase-db.yaml` drops their two mounts and `JWT_EXP`.
  - `docker/supabase/init/roles.sql` keeps only the `supabase_auth_admin` line.
- **GoTrue's URLs (design D2):** `API_EXTERNAL_URL`, `GOTRUE_SITE_URL` and `GOTRUE_JWT_ISSUER`
  become the literal `http://auth:9999`, with no `SUPABASE_PORT`. No browser reaches GoTrue, and
  the server discards the tokens GoTrue issues.
- **Secrets tooling (design D3):**
  - `compose-run.mjs`:
    - the Supabase keys become `POSTGRES_PASSWORD`, `SUPABASE_ROLES_PASSWORD`, `APP_DB_PASSWORD`
      and `JWT_SECRET`;
    - a new `RETIRED_KEYS` list: accepted, not format-checked, never passed to compose, and named
      once in a warning;
    - the anon/service-role check goes;
    - the secret scope shrinks;
    - the published-port owners become dev `app`, `companion` and stage/prod `router`;
    - `urls` drops the Supabase line.
  - `supabase-keys.mjs` creates only the four keys.
- **Compose invariants (design D4):** invariant 16 covers `db`, `migrate` and `auth`. It fails a
  stack with any of the four removed services, or with a `supabase` or `edge` network. The dev
  service set and the dev bind allowlist shrink.
- **Orphans (design D5):** every `compose up` step in the Makefile (`dev-up`, both forms of
  `stage-up`, `prod-up`) passes `--remove-orphans`, so the old four containers are removed on the
  next `up`. Removing a container deletes no volume.
- **Docs (design D6):** `docs/supabase.md`, `docs/openbao-secrets.md`, `docs/security.md`, the
  README (with a leftovers cleanup note), ADR 0021 and ADR 0023.

## Out of scope (non-goals)

- GoTrue itself: its sign-in rules, its `auth-egress` reach and its revisit list (ADR 0021 slice 5a)
  are unchanged. The username-and-password sign-in is a later change.
- Deleting the leftovers (owner decision 3). The README gives the commands; the owner runs them
  once no checkout runs the old stack.
- Removing the retired keys from any OpenBao secret. The owner does that when `autologger-ui` has
  rebased.
- Dropping the Supabase API roles (`anon`, `authenticated`, `service_role`, `authenticator`) or the
  `storage`/`realtime` schemas from the Postgres image. They come with the image, and the
  `catalog-database` pg tests that check them stay.
- Studio, postgres-meta, or any other Supabase service.
- The catalog, the server, the web, the Companion module and the HTTP/WS contract.

## Capabilities

- `local-container-environments`:
  - MODIFIED: "Makefile entry points per environment" (URLs, `--remove-orphans`, reset text),
    "Dev environment runs the hot-reload single process with every integration" (a renamed
    cross-reference), "Dev app binds loopback behind a Host/Origin gate" (gate ports), "Dev
    isolates data and secrets, sharing only the operator's Claude login" (bind exceptions), "Stage
    coexists with prod; dev is disjoint by construction" (networks, volumes, `SUPABASE_PORT`),
    "Stage can run pushed images behind a public HTTPS edge" (`--remove-orphans`, GoTrue's URLs).
  - REMOVED, then ADDED under new titles because scenario titles would become false: "Static
    invariant check", "Supabase secret generator", "Secrets come from OpenBao, one KV path per
    stack".
  - REMOVED: "Supabase gateway routes and key checks". Its Google-only rules move to a new
    requirement, "GoTrue accepts only Google sign-in".
- `container-deployment`: REMOVED "Compose topology is loopback-published, segmented, and
  operable" and re-ADDED as "Compose topology publishes only the router, segmented, and operable"
  (services, host exposure, segmentation, volumes, secret scope, three scenario bodies; the
  scenario "Only the router is reachable from the host" becomes "Only the router publishes a host
  port", panel).
- `catalog-database`: MODIFIED "The catalog is not exposed through the Supabase API roles"
  (wording only).

## Impact

- **Compose:** `docker/supabase-services.yaml`, `docker/supabase-db.yaml`, `docker/supabase/init/*`,
  `compose.yaml`, `docker/compose.dev.yaml`, `docker/compose.stage.yaml`, the `Makefile`, and the
  comment in `docker/scripts/compose-env.sh`.
- **Deleted:** `docker/supabase-gw.Caddyfile`, `docker/supabase/test_gateway.sh`,
  `docker/supabase/init/realtime.sql`, `docker/supabase/init/jwt.sql`.
- **Secrets tooling:** `docker/scripts/compose-run.mjs`, `docker/scripts/supabase-keys.mjs`, and
  their tests.
- **Invariants:** `docker/scripts/check-envs.sh` and `docker/scripts/test_check_envs.sh`.
- **Docs:** `docs/supabase.md`, `docs/openbao-secrets.md`, `docs/security.md`, `README.md`,
  `docs/decisions/0021-migrate-to-self-hosted-supabase.md`, `docs/decisions/0023-companion-realtime.md`.
- **The shared dev stack:** after the live check, dev runs without the four services. The paused
  `~/autologger-ui` checkout brings them back on its next `make dev-up`, until it rebases.
- **No server code changes,** so the DB suites must stay at the slice 10 counts (PR #101, run
  37829084541: server pg and integration 1445 passed, 1 skipped; storage pg 109).
