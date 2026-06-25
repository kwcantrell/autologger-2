# Companion relay test coverage — design

**Date:** 2026-06-25
**Status:** Approved (pending spec review)
**Scope:** Test-only. No production-code changes — characterizes current behavior. Reuses the hybrid harness + helpers. Final deferred follow-up sub-project.

## Background

Last of the three deferred sub-projects. Covers the 8 `/api/companion/*` routes and the WebSocket command relay (deferred from earlier specs as needing socket plumbing).

The relay model (`src/routers/companion.ts`):
- **Presence** = short-TTL KV keys `companion:presence:<client_id>` carrying metadata `{ session_id, visible, is_playing, updated }`. `listPresence` keeps entries fresher than 15s; `primarySession` returns the freshest live presence with a session, preferring visible tabs.
- **`requireActiveSession`** resolves `primarySession(AUTH)` then checks the session row exists, else **409**. This selection is **global — not scoped by studio** (the audit's broken-access-control finding).
- **Commands** broadcast over the session DO's hibernatable WebSocket (`broadcastCommand` → `core.broadcastCommand` → `{ type:'command', command }` to every `getWebSockets()`), plus a `companion:last_command` KV record. The `/api/sessions/:id/ws` route (`events.ts:104`) delegates to `getSessionDO(...).fetch(req)`.

## Goals

1. Cover all 8 companion HTTP routes (happy + key branches) via `app.request`.
2. Prove the end-to-end WebSocket command relay (spike-gated).
3. Characterize the global/unscoped `primarySession` selection as current behavior.

## Non-goals

- Real long-poll waiting (`/commands/wait` with `timeout>0` sleeps — tested only at `timeout=0`).
- WS hibernation/eviction; multi-socket fan-out beyond one client.
- Any production-code change; the audit's tenancy finding is characterized, not fixed.

## Architecture

### Helper — `setCompanionPresence` (added to `src/test/helpers.ts`)

```
setCompanionPresence(clientId, sessionId, opts?: { visible?; is_playing? }): Promise<void>
```
Writes `companion:presence:<clientId>` to the `AUTH` KV with metadata `{ session_id, visible: opts.visible ?? true, is_playing: opts.is_playing ?? false, updated: Date.now() }` and `expirationTtl: 60`. Writing the KV directly (rather than via the presence endpoint) keeps tests robust against a presence-endpoint regression. A `seededSessionWithPresence()` convenience (seed studio→show→session, set presence) lives in the test file.

### Part 1 — `src/routers/companion.int.test.ts` (HTTP, `app.request`)

- **presence:** `POST /api/companion/presence` (visible tab + session) → `{ ok:true }`; then `GET /api/companion/state` shows `connected_clients >= 1` and `active_session_id` = that session. `closing:true` → deletes (state no longer lists it).
- **state:** with a seeded session + presence, assert `active_session_id`, a non-null `session` block with `id`/`timecode`/`is_rolling`, and `last_command: null` initially.
- **log:** presence→session whose show has a known category; `POST /api/companion/log` by `category_id` → enriched event (200); a second by `category_label` → 200; **409** with no presence/active session; **400** with an unknown category.
- **transport:** `POST /api/companion/transport` `start` → `{ ok, is_rolling:true, current_take:1 }`; `stop` → `is_rolling:false`; `toggle` flips.
- **command:** `POST /api/companion/command` (`record-start`) → `{ ok, command_id, active_session_id }`; `GET /api/companion/state` then shows `last_command.id === command_id`.
- **categories:** with a show that has categories → `{ session_id, show_id, categories: [...] }`; **409** when the show has no categories (seed a show with `categoriesJson: '[]'`).
- **commands/wait:** `GET /api/companion/commands/wait?timeout=0` → `{ commands: [] }` immediately.
- **ack:** issue a command (capture `command_id`), `POST /api/companion/commands/<id>/ack` `{ client_id, ok:true }` → `{ ok:true }` and `state.last_command.ok === true`; ack with a wrong id → `{ ok:false }`.
- **tenancy characterization:** two presences for sessions in different studios; the visibly-fresher one is selected by `requireActiveSession` regardless of studio — assert the companion action targets it (documents the unscoped selection).

### Part 2 — `src/routers/companion-ws.int.test.ts` (WebSocket, `SELF.fetch`) — SPIKE-GATED

- **Spike (gate):** open a socket — `SELF.fetch('https://example.com/api/sessions/<id>/ws', { headers: { Upgrade: 'websocket' } })` → expect `status 101` + `res.webSocket`; `ws.accept()`. Set presence for `<id>`, `POST /api/companion/command` `record-start`, and assert the socket receives a message whose JSON is `{ type:'command', command:'record-start' }` (await the `message` event with a short timeout).
- If green, add a **`webSocketMessage` round-trip:** a second connected socket; the first sends `{ type:'command', command:'play-toggle' }`; assert the second receives the re-broadcast.
- **Fallback (if WS upgrade can't be driven in pool-workers):** delete this file; in Part 1 assert `POST /api/companion/command` returns 200 + writes `last_command` (delivery uncovered), and log the limitation in the commit. Decision recorded, not silently taken.

## Error handling & edge cases

Asserts the companion 409 (no active session), 400 (unknown category / no categories→409), ack hit/miss, and the global-selection characterization, in addition to happy paths.

## Verification

- `npm run test` green across both projects (current 148 + companion HTTP + WS).
- `npm run typecheck` clean.
- The WS spike passes before the round-trip test is added; otherwise the fallback is taken and noted.

## Risks & rollback

- **WebSocket-in-pool-workers (primary risk)** — `SELF.fetch` WS upgrade + message receipt is the unknown; isolated to the Part-2 spike with the HTTP-only fallback above. Part 1 ships regardless.
- **KV `list`-with-metadata visibility** — `primarySession` relies on `kv.list({ prefix }).keys[].metadata`. Miniflare KV is locally consistent, but the first presence/state test implicitly verifies this; if metadata isn't visible, switch the helper to also store the meta in the value body and adjust (test-only).
- All additions are new files + one helper; revert is clean.

## Versioning

Test-only; no version bump; no new dependencies.
