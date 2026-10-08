# Design: companion-devices (ADR 0021 slice 9d)

## Context

Line numbers are at base `4986cdc1`.

**Auth.** `authContext` (`server/src/middleware/auth.ts:15-47`):
- It resolves a cookie user through `system('auth-resolve')`.
- It sets `apiTokenAuth` when the path starts `/api/companion/` and the Bearer equals `API_TOKEN`
  (`identity.ts:97-110`, `timingSafeEqual`).
- The 401 gate passes a token-only request with `user = null` and an unbound catalog.
- `apiTokenAuth` is read by the gate and by the AI v2 principal-less refusal (`aiV2.ts:150-160`),
  which is unreachable today.

**Companion routes** (`server/src/routers/companion.ts`):
- A token-only caller gets `catalog.system('companion-token')` and `systemCaller('companion-token')`
  (`:94-104`). `callerMaySee` is always true for it (`:120-123`).
- `primarySession` (`:79-87`) picks the visible-then-freshest presence across all teams.
- `requireActiveSession` (`:129-138`) gives the frozen `409` "No active session — open AutoLogger in
  a browser and open a session."
- `companion:last_command` is one global kv key (`:75`). `/command` writes it before broadcasting.
  `ack` uses a `replaceIf` (`:324-345`).
- `POST /presence` (`:140-167`) checks session access for a cookie caller, and no access for a
  token-only one.

**Presence:**
- The port is `packages/ports/src/presenceRegistry.ts`: `upsert`, `remove`, `list`, all async.
- `server/src/node/presence.ts` implements it with a Map and `PRESENCE_FRESH_MS = 15_000`. One is
  built per process in `node/config.ts:133`.
- The web posts every 5 s while visible and every 10 s while hidden, plus a `closing` beacon
  (`web/src/api/hooks/useCompanionPresence.ts`).

**Module** (`companion/`):
- It calls `state`, `categories`, `log`, `transport` and `command` with `Authorization: Bearer
  <token>`.
- The token is a plain `textinput` config field (`src/config.ts`). `UpgradeScripts = []`.
- A 401 sets `BadConfig "Check API token / login"`.
- `@companion-module/base` 1.14 supports `secret-text` fields (values go to the secrets store) and
  upgrade scripts that return `updatedSecrets`.

**Schema conventions.** Catalog ids are `text collate "C"`, timestamps are `*_utc` text, and Clock
times are `bigint` ms. `catalog.users.disabled_at_utc` marks a disabled user.

## Decisions

### D1. Tables (owner decisions 1, 3, 5)

Migration `supabase/migrations/20261015000000_companion_devices.sql`:

```sql
create table catalog.companion_devices (
  id text collate "C" primary key,                       -- uuid string
  user_id text collate "C" not null references catalog.users(id) on delete cascade,
  name text collate "C" not null check (char_length(name) between 1 and 80),
  token_hash text collate "C" not null unique,           -- hex sha256 of the token
  created_at_utc text collate "C" not null,
  last_used_at_utc text collate "C"
);
create index idx_companion_devices_user on catalog.companion_devices (user_id);

create table catalog.companion_presence (
  client_id text collate "C" primary key check (char_length(client_id) between 1 and 256),
  user_id text collate "C" not null references catalog.users(id) on delete cascade,
  session_id text collate "C" references catalog.sessions(id) on delete set null,
  visible boolean not null,
  is_playing boolean not null,
  updated_at_ms bigint not null
);
create index idx_companion_presence_user on catalog.companion_presence (user_id, updated_at_ms);
```

**RLS and grants**, following the existing catalog policy migrations (the `kv` pattern):
- `companion_devices`: `catalog_system` only; privileges revoked from `catalog_user` (owner, after
  the panel: one system store serves both the token lookup and the management routes, and every
  statement is scoped by `user_id` in SQL, D5).
- `companion_presence`: `catalog_system` only. Privileges are revoked from `catalog_user`, so a user
  `SELECT` gets `42501`. The server writes the table for a cookie caller after the access check, so a
  user grant would only widen what a user can see.
- Both tables: `anon`, `authenticated` and `public` get no privileges, mirroring `session_leases`.

**Rollback:** drop both tables after reverting the code. Re-enabling `API_TOKEN` is a revert.

### D2. Device authentication (owner decisions 1, 4)

**Token format.** `ald_` followed by base64url of 32 random bytes. Only
`sha256(token)` as hex is stored.

**`authContext` on `/api/companion/*`:**
- **Bearer header present:** the device path decides, and the cookie is ignored. The module never
  has a cookie, and this keeps one source of identity per request.
  1. Hash the token.
  2. Look it up through `CompanionDeviceStore` (`packages/storage`, on `bindSystem('companion-device')`,
     wired as `Bindings.ports.companionDevices`; not a catalog facade store, owner after the panel):
     ```sql
     SELECT d.id, u.* FROM companion_devices d JOIN users u ON u.id = d.user_id
      WHERE d.token_hash = $1 AND u.disabled_at_utc IS NULL
       AND coalesce(d.last_used_at_utc, d.created_at_utc) > $now_minus_90_days
     ```
     **Idle expiry (owner, after the panel):** a device unused for 90 days no longer
     authenticates; any use renews it through `last_used_at_utc`. An expired device stays listed
     (with its last use) until the user revokes it.
  3. A hit sets `user` to that user, `catalog` to `sys.forUser(user.id)`, and `companionDevice` to
     `{id}`.
  4. A miss gets `401 {"detail":"Login required."}`.
- **No Bearer:** today's cookie path.

**Elsewhere.** Outside `/api/companion/*` the Bearer is ignored, as today, so a device token is
never a credential for any other route or for the session WebSocket.

**`last_used_at_utc`** is set by a conditional update, at most once a minute per device:
`UPDATE … SET last_used_at_utc = $now WHERE id = $1 AND (last_used_at_utc IS NULL OR
last_used_at_utc < $now_minus_60s)`. It runs fire-and-forget after the lookup; a failure only
warns. Because it also renews the idle expiry, a failure costs at most one minute of idle time.

**Audit lines.** Creating and revoking a device, and a device's first use after creation, write
one server log line each with the user id and device id, never the token or its hash.

**`API_TOKEN` is no longer read:**
- `apiTokenConfigured`, `requestHasValidApiToken` and `Config.API_TOKEN` are removed.
- The `apiTokenAuth` context flag becomes `companionDevice: {id} | null`.
- The AI v2 principal-less refusal is removed: a device call now has a user, and AI v2 routes are
  outside `/api/companion/`.
- `docker/secrets-env.yaml` keeps `API_TOKEN:`, commented as ignored since 9d and to be removed
  after every OpenBao secret drops it, because `compose-run` refuses a whole secret that holds an
  unlisted key (9c finding).

### D3. Companion routes run as the device's user (owner decisions 2, 6, 7)

- **Callers.** `companionCatalog` and `companionHub` are deleted. Every Companion route uses the
  request's `catalog` and `sessionCaller(c)`. `callerMaySee` is `canAccessSession`, and the
  `companion-token` system reason goes away.
- **The active session** (`primarySession(presences, scope)`):
  - **Device caller:** rows where `user_id = device user`, visible first, then freshest.
  - **Cookie caller:** the same rule over the caller's own rows (owner, after the panel). The only
    cookie caller in production is the browser, which never reads `/state`; this is a stated change
    for any other cookie reader, which used to see the global pick masked to their access.

  The chosen session is still checked with `canAccessSession` (a user who lost access to a session
  their own tab still names gets the masked `409`). `requireActiveSession` is unchanged otherwise,
  including the `409` detail.
- **`connected_clients` and `is_playing`.** `/state`'s `connected_clients` counts the caller's own fresh
  presence rows (device or cookie). `session.is_playing` is
  any in-scope presence on that session with `is_playing`.
- **Last command:**
  - The key is `companion:last_command:<device id>`.
  - `/command` stores it there before broadcasting; it is unchanged otherwise. A cookie caller's
    command is delivered but recorded under no key, matching its `null` `last_command`.
  - `/state`'s `last_command` reads the caller's device key. A cookie caller has no device, so
    `null`.
  - `ack` matches the command id within the caller's device key; a cookie caller gets `{ok:false}`.
  - The old global key is ignored; a later kv purge does not apply to it because it has no TTL, so
    the migration deletes it: `delete from catalog.kv where key = 'companion:last_command'`.
- **Presence POST.**
  - A device caller gets `403 {"detail":"Presence is posted by the AutoLogger browser app, not by a
    Companion device."}` first, before body validation, the NUL 400 or any write.
  - A cookie caller keeps the existing checks: `requireSession` for a non-empty `session_id`, the
    NUL 400 and `closing`. New (panel): a `client_id` that is blank after trimming or holds a NUL
    gets `400` before any write (it would otherwise reach the table's check and answer 500). An
    absent, null or blank `session_id` is stored as SQL `NULL` (the FK refuses `''`).
  - **Ownership (panel).** A row belongs to the user who first wrote it. An upsert for a
    `client_id` another user owns changes nothing and still answers `200 {ok:true}` (no oracle);
    `closing` deletes only the caller's own row. A tab's client id is not secret (it is the
    recording lease holder id other users can read), so this keeps one user from moving or
    deleting another's presence.
- **Frozen shapes** of `state`, `log`, `transport`, `command`, `categories`, `commands/wait` and
  `ack` are unchanged.

### D4. Presence on Postgres (owner decision 3)

- **Port** (`packages/ports/src/presenceRegistry.ts`):
  - `PresenceMeta` gains `user_id: string`;
  - the port is `upsert(clientId, meta)`, `remove(clientId, userId)`, `list(userId)` returning
    `{client_id, ...PresenceMeta}` rows, and `deleteOlderThan(cutoffMs)`;
  - freshness stays with the implementation: `updated > now - 15 s`;
  - `PRESENCE_FRESH_MS` moves to the port module as a constant.
- **`PostgresPresence`** (`packages/storage/src/presence.ts`) on `bindSystem('companion-presence')`:
  - `upsert` is `INSERT … ON CONFLICT (client_id) DO UPDATE … WHERE companion_presence.user_id =
    excluded.user_id OR companion_presence.updated_at_ms < $now - PRESENCE_FRESH_MS` (ownership,
    D3): another user's row is taken over only once it is stale, so a tab reused after signing in
    as someone else recovers within 15 s, and a live row can never be moved;
  - `remove(clientId, userId)` is a `DELETE` by `client_id` and `user_id`;
  - `list(userId)` is `SELECT … WHERE user_id = $1 AND updated_at_ms >= now - 15000` (inclusive at
    the edge, as today's registry);
  - `deleteOlderThan(cutoffMs)` serves the sweeper.

  Times come from the Clock port. `node/config.ts` wires it in place of the Map registry, and
  `server/src/node/presence.ts` is deleted.
- **Sweeping.** `sweepLeasesOnce` (9c) runs `presence.deleteOlderThan(now - 60_000)` as its first
  step, before the expired-recording listing whose failure ends the tick early. It is warn-only like
  the other steps.
- **Session deletion** sets `session_id` null (FK), and that row then picks nothing.

### D5. Device management routes (owner decisions 4, 5)

A new `server/src/routers/companionDevices.ts`:
- **Store.** All three routes use `ports.companionDevices` (the system store, D2) with the caller's
  user id in every statement: list `WHERE user_id = $caller`, delete `WHERE id = $1 AND user_id =
  $caller`, create inserts `user_id = $caller`. There is no user RLS on the table, so these
  predicates are the only isolation; integration tests pin each one.
- **Cookie only.** A request with `companionDevice` set never reaches these routes, because device
  auth only runs on `/api/companion/*` and these paths are `/api/companion-devices`. They require a
  user (the existing login gate).
- **`GET /api/companion-devices`** returns `200 {devices:[{id, name, created_at, last_used_at, expired}]}`
  (`expired` is true past the 90-day idle window)
  for the caller's devices, newest first. `last_used_at` may be null. `token_hash` is never
  returned.
- **`POST /api/companion-devices {name}`**:
  - `name` is trimmed, 1..80 characters, with no NUL. An invalid name gets `422` (zod) or the
    existing NUL `400`.
  - The 11th device gets `409 {"detail":"You already have 10 Companion devices; revoke one
    first."}`.
  - The count and the insert run in one transaction under `pg_advisory_xact_lock` keyed on the user
    id, so two concurrent creates can't make 11.
  - It returns `201 {id, name, created_at, token}`. `token` appears only here.
- **`DELETE /api/companion-devices/:id`** returns `204`. An unknown id or another user's id gets
  `404 {"detail":"Companion device not found."}` (the owner predicate matches nothing).
- **Contract.** The routes are added to `packages/contract` schemas and to the README endpoint
  table.

### D6. The web Settings section (owner decision 4)

- **Component.** `CompanionDevicesSection.tsx` in `web/src/pages/index/components/settings/`,
  registered in `sections.ts` / `SettingsSections.tsx` next to Account. It uses the existing
  `settingsParts` and the shadcn wrappers.
- **The list** shows name, created, and last used (or "Never"), and marks a device "Expired" past
  the 90-day idle window.
- **Add device:** a name input and an Add button.
  - On success a dialog shows the token in a read-only field, with Copy and the line "Copy this
    token now. It won't be shown again."
  - Closing the dialog drops the token from memory (component state only, never cached in the query
    client).
- **Revoke** goes through a confirm dialog, then `DELETE`, then the list is invalidated.
- **Hooks:** `useCompanionDevices`, `useCreateCompanionDevice` and `useRevokeCompanionDevice` in
  `web/src/api/hooks/`, following the existing TanStack Query conventions. Errors show `{detail}`.
- **Types** go in `web/src/api/types.ts`, plus the response-shape conformance tests the repo uses.

### D7. The Companion module (owner decision 4)

- **`config.ts`.**
  - `token` becomes `{type: 'secret-text', id: 'token', label: 'Device token (required)'}`.
  - The instance type becomes `InstanceBase<ModuleConfig, ModuleSecrets>`.
  - `init` and `configUpdated` read `secrets.token`.
- **`upgrades.ts`.** One upgrade script: if `config.token` is a non-empty string and
  `secrets?.token` is empty, it returns `updatedSecrets: {token}` and `updatedConfig` without
  `token`. It is a no-op otherwise.
- **401 status:** `BadConfig "Device token invalid or revoked: create one in AutoLogger Settings →
  Companion devices"`.
- **`HELP.md`** describes getting a device token. The module version is bumped per the repo's
  packaging rules.

### D8. Docs and env

- **README:**
  - the endpoint table (the three new routes; the Companion row's auth and its 403 on presence);
  - the Companion setup, dev Companion and module sections (device token from Settings; re-pairing
    after deploy);
  - the `API_TOKEN` rows become a note that it is ignored since 9d;
  - the "token-only Companion calls" bullets.
- **`docs/openbao-secrets.md`:** `API_TOKEN` is no longer required; leave or delete it.
- **`docker/.env*.example`:** remove `API_TOKEN`, with a comment pointing to Settings.
- **ADR 0021:** §5a and §6 decision 6 notes, and §9's 9d entry for what shipped.

### D9. Tests (test first)

**Changing existing tests is allowed only in these categories.** Anything else is a stop.
1. **Bearer setup.** Tests that authenticate with `COMPANION_BEARER` / `API_TOKEN` (whatever task
   1.1's grep finds, including `companion-ws.int`) switch to a device token from a new
   `seedCompanionDevice(user)` helper. Their assertions on scope, status codes and shapes stay.
2. **Presence helpers.** `setCompanionPresence` and the direct `presence.upsert` calls pass a
   `user_id`. `server/src/node/presence.test.ts` is replaced by storage pg tests of the same cases.
3. **Changed premises:**
   - the global-pick test ("selects the visibly-fresher session regardless of studio") is rewritten
     as per-user selection;
   - token-only "any session" cases (the show-grants D10 block and `catalogBinding`'s
     `system:companion-token`) become device-as-user access cases;
   - the AI v2 principal-less refusal test is deleted with the code.
4. **The `catalogSystem.repo.test.ts` ALLOWLIST:** `companion-token` goes; `companion-device` and
   `companion-presence` come in.
5. **Snapshots:** the `catalogSchema.pg` table and column snapshots gain the two tables.
6. **Config literals** drop `API_TOKEN`.
7. **Bearer presence posts become cookie posts.** Tests that POST presence with the bearer
   (`companion.int` "POST presence with closing:true removes it", `nulText.int` presence cases)
   move to a cookie caller, since a device now gets 403 there.
8. **Policy assertions.** `catalogPolicies.pg.test.ts` (the user-policy count and the
   `table !== 'kv'` rule) and `catalogSchema.pg.test.ts` (`relname !== 'kv'`) gain the two
   system-only tables as exceptions next to `kv`.
9. **Deleted API.** Unit tests of the deleted `requestHasValidApiToken` (`identity.test.ts`) are
   deleted; the `aiV2.int` "API_TOKEN is inert" block becomes "a device token is inert" with the
   same assertions; `_helpers.test.ts` follows the `apiTokenAuth` → `companionDevice` rename;
   `leaseSweeper.int` passes the new presence dependency to `sweepLeasesOnce`.
10. **Settings tab list.** `SettingsView.test.tsx`'s exact section list gains "Companion devices".
11. **Package boundaries.** `server/src/packageBoundaries.repo.test.ts` entries that pin
   `server/src/node/presence.ts` are removed with the file. New storage modules are added where the
   test lists modules.
12. **`docker/scripts/test_router.sh`** stops reading `API_TOKEN` from the api container. The
   operator supplies a device token created in that stack's Settings, kept only in the script's
   environment (for example `COMPANION_DEVICE_TOKEN=… sh docker/scripts/test_router.sh stage`).

Task 1.1 lists each touched test for the owner.

**New tests:**
- **Unit:**
  - token generation and hashing (prefix, length, base64url);
  - the module upgrade script (moves, no-op, already-moved);
  - the module reading `secrets.token`;
  - the web section (list, add shows token once with copy, revoke confirm, error detail).
- **pg:**
  - both tables are invisible to `catalog_user` (select, insert, delete give `42501`); the store's `user_id` predicates are pinned by the D5 integration tests;
  - the cap under two concurrent creates;
  - presence freshness, upsert changing user, and the sweep of rows older than 60 s.
- **Integration:**
  - **Device auth:**
    - a device token passes on all five Companion routes;
    - it gets 401 on `/api/sessions`, `/api/admin`, AI v2 and `/auth/logout`;
    - the WS upgrade is refused;
    - encoded spellings are refused, mirroring `apiToken.int`;
    - an unknown token, a revoked device and a disabled user get 401;
    - the old `API_TOKEN` value gets 401.
  - **Device as user:**
    - it follows only its user's presence;
    - a session its user lost access to gives a masked 409;
    - `last_command` and `ack` are per device;
    - presence POST gives 403.
  - **Two processes:** presence posted on app A, `/state` with the device on app B names the
    session.
  - **Management:** create, list, delete; the cap 409; another user's 404; the token appears only in
    the POST response, and only its sha256 is stored.

### D10. Latency

Recorded, with no stop rule:
- device auth lookup (median over 300);
- presence upsert and list (median over 300).

## Risks

- **Re-pairing on deploy.** Every Companion install stops working until it gets a device token.
  This is accepted (decision 4) and called out in the README.
- **Token theft.** A device token acts as its user on the Companion routes only: log, transport and
  commands on sessions that user can access. Revoke is immediate (looked up per request). Tokens
  are 256-bit, and only the sha256 is stored, so a database read doesn't yield usable tokens.
- **Presence write rate.** About one write per browser tab every 5–10 s. Rows are small, and the
  primary key is the client id.

## Rollback

1. Revert the code. `API_TOKEN` works again once it is set in the env.
2. Then drop the two tables. Device tokens are lost, which is harmless after the revert.
