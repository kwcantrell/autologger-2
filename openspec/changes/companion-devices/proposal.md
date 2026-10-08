# Companion devices: per-device credentials that act as their user, and presence shared by every process

Tier: 2
Tier reason:
- it replaces the Companion's authentication (`API_TOKEN`, a shared secret acting as a system
  caller) with per-device tokens that act as a user; this is auth and secrets work, so the owner
  owns the design;
- a migration adds two tables with row-level security (`supabase/migrations/**`);
- the frozen contract changes: `/api/companion/*` authentication, a stale `API_TOKEN` gets 401,
  device callers get 403 on presence, and three new device-management routes;
- it touches `server/src/routers/**`.

ADR 0021 slice 9d.

Approved-by: Kalen 2026-10-08 (reapproved)

## Why

ADR 0021 slice 9 makes several server processes correct. Two Companion pieces are still
single-process or unbound:

- **Presence lives in one process's memory** (`server/src/node/presence.ts`, a Map with 15 s
  freshness). With two processes, a browser heartbeat on A and a Companion poll on B make B answer
  `409 No active session`. Heartbeats spread across processes make each process pick a different
  session.
- **`API_TOKEN` is one shared secret.** On `/api/companion/*` it runs as the reviewed system task
  `companion-token`, for any session in any team:
  - `primarySession` picks the freshest presence across all teams;
  - `companion:last_command` is one global key;
  - rotating the token means editing every install.

  ADR 0021 (slice 5a, decision 6 of slice 6) left "a real device credential" to slice 9.

## Owner decisions (owner, 2026-10-08)

1. **Per-device tokens.** Each Companion device gets its own random token.
   - The token is shown once; only its sha256 is stored.
   - The device acts as the user who created it, so that user's normal show access applies.
   - Each device can be revoked on its own.
2. **A device follows its owner's browsers.** Its active session is the freshest visible presence
   posted by its own user.
3. **Presence moves to a table**, `catalog.companion_presence`, shared by every process.
4. **`API_TOKEN` is retired**, and a stale Bearer gets `401`. Devices are issued and revoked through
   cookie-only endpoints and a "Companion devices" section in Settings.
5. **Each user manages only their own devices**, at most 10.
6. **The last command is per device**, with unchanged response shapes.
7. (At plan approval) **Device callers get `403` on presence.** Presence comes from browsers; the
   Companion module never posts it.
8. (After the panel) **Devices expire after 90 idle days**; any use renews them. Creating and
   revoking devices write audit log lines (user and device ids, never the token).
9. (After the panel) **A cookie caller's `/state` uses only their own presence rows**, the same rule
   as a device. This is a change for cookie readers of `/state`, who used to see the global pick
   masked to their access; the browser never reads `/state`.
10. (After the panel) **One system store holds devices.** `companion_devices` is system-only, like
    `kv`; every management statement is scoped by the caller's user id in SQL.

## What changes

- **Migration** `20261015000000_companion_devices.sql`:
  - `catalog.companion_devices`, the user's devices and their token hashes;
  - `catalog.companion_presence`, one row per browser tab.
- **Device authentication.**
  - On `/api/companion/*` only, a `Bearer` token is hashed and looked up. A live device on an
    enabled user makes the request that user's, marked as a device call.
  - Anything else gets the existing `401 {"detail":"Login required."}`.
  - Tokens are still refused everywhere else, including the session WebSocket.
  - `API_TOKEN` is no longer read.
- **Companion routes run as the device's user.**
  - The `companion-token` system caller is deleted.
  - The active session comes from the caller's own presence rows, for a device and for a cookie
    caller (decision 9). Presence rows are owned: another user can't move or delete a live row.
  - `last_command` and `ack` use the device's own key.
  - Device callers get `403` on `POST /api/companion/presence`.
- **Presence port on Postgres.** The existing async port gains `user_id`. Rows older than 60 s are
  deleted by the 9c lease sweeper.
- **Device management:** `GET`, `POST /api/companion-devices` and `DELETE
  /api/companion-devices/:id`. They are cookie-only and live outside `/api/companion/`, so a device
  token can never manage devices.
- **Web:** a "Companion devices" section in Settings. It lists your devices, adds one (the token is
  shown once, with copy) and revokes one.
- **Companion module:**
  - the token moves to a `secret-text` field, and an upgrade script moves an existing token into
    secrets;
  - a 401 tells the operator to create a device token;
  - the five endpoint paths and the Bearer header are unchanged, so proxy bypass rules don't change.
- **Docs:** README (endpoint table, Companion setup, the `API_TOKEN` rows), `docs/openbao-secrets.md`,
  the env examples and ADR 0021. `API_TOKEN` stays on `docker/secrets-env.yaml`, marked ignored,
  because the allowlist refuses a whole OpenBao secret that holds an unlisted key.

## Not changing

- The five Companion endpoints' paths, bodies and response shapes; the `409` "No active session"
  detail; `commands/wait`.
- Command delivery to browsers (9a frame bus) and the browser presence heartbeat cadence.
- The session WebSocket. A Companion still never joins it.
- Realtime (ADR 0023) stays deferred.

## Impact

- **Operators must re-pair.** Every Companion install needs a device token from Settings after
  deploy, and the old `API_TOKEN` stops working at once. On dev, the owner pastes one token into
  the dev Companion connection.
- **Behavior for multi-user teams:** a Companion now drives only sessions its user's browsers have
  open, and only sessions that user can access.
- **Load:** one indexed lookup per Companion request (about one per second per device), one
  presence upsert per browser heartbeat (5–10 s per tab), and a throttled `last_used_at` update.
- **Code:**
  - `server/src/{middleware/auth,auth/identity,routers/companion,node/config,startupPurge}.ts` and a
    new `server/src/routers/companionDevices.ts`;
  - `packages/ports` (presence meta, device store port) and `packages/storage` (Postgres presence
    and devices);
  - `web/src/pages/index/components/settings/*` and new hooks;
  - `companion/src/*` and `companion/companion/HELP.md`;
  - the migration, README, ADR 0021, the env docs and `docker/secrets-env.yaml`.

## Non-goals

- Realtime for Companion, and refresh tokens (ADR 0023's GoTrue-per-device option).
- Admin management of other users' devices.
- Per-device scoping narrower than the user's access (for example one show only).
- Blobs (slice 10) and the topology change.
