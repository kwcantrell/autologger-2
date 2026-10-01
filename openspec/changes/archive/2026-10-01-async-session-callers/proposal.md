# Async session-side callers: KV and presence ports async; session routers await the catalog

Tier: 2
Tier reason: changes port contracts (`@autologger/ports` KvStore, PresenceRegistry), touches `server/src/routers/**` (high-risk path) including the session access gate, and moves await points inside documented concurrency windows.

Approved-by: Kalen 2026-10-01

## Why

ADR 0021 slice 3 makes the storage ports async while they still run on SQLite, so that slice 4
can swap in postgres.js without rewriting call sites. The owner chose (2026-10-01):
- **Scope:** catalog, KV and presence. The session hub goes async in slice 7.
- **Order:** top-down in four PRs, because the catalog stores call each other synchronously.

| PR | Change |
|---|---|
| 3a, this change | KV and presence async; session-side routers await the catalog |
| 3b | Teams, admin, profile, shows and auth callers |
| 3c | The async catalog adapter (lock and scoped transaction), not wired in |
| 3d | The stores move to it; the sync port is deleted |

`await` on a value that is still synchronous runs the call immediately. It then yields only to
microtasks that are already queued; no new request can run, because requests arrive on I/O
callbacks. So this change keeps the same behaviour while storage stays synchronous. The real
interleaving starts when storage does I/O (slice 4). This change records every such hazard it
finds, and fixes now the ones that are cheap.

## What Changes

- **KvStore port async** (`packages/ports/src/kvStore.ts`). Every method returns a Promise. The
  adapter awaits its own lazy-expiry delete.
- **PresenceRegistry port async** (`packages/ports/src/presenceRegistry.ts`). The in-memory
  adapter returns resolved Promises.
- **The KV startup purge moves.** It leaves the synchronous `createBindings`
  (`server/src/node/config.ts:45`) and is awaited in `server/src/main.ts` before the server
  listens. A failed purge logs a warning and boot continues, because expiry is still enforced
  lazily on read.
- **Session-side routers await every catalog, KV and presence call**, and the synchronous gate
  helpers become async:
  - `routers/_helpers.ts`: `requireSession`;
  - `aiV2.ts`: `guardAiV2Route`;
  - `exports.ts`: `exportRows`;
  - `companion.ts`: `primarySession`, `requireActiveSession`;
  - `transcribe.ts`: `resolveCatalogSessionTitle`, `requesterCanViewSession`.

  Their callers are in `sessionWs.ts`, `events.ts`, `sessions.ts`, `companion.ts`,
  `transcribe.ts`, `logImport.ts`, `exports.ts`, `audio.ts`, `ai.ts` and `aiV2.ts`.
- **No promise is dropped or misused.** A repo test uses the TypeScript type checker on every
  production file in `server/src`. It fails on:
  - a Promise-typed call that is neither awaited, returned, `void`ed nor otherwise consumed;
  - a Promise used as a condition or negated.

  Biome's `noFloatingPromises` was tried and rejected: it misses calls through port interfaces
  and misused promises, and it panics on three test files. This test catches the gate helpers
  and aliased ports today, and catalog calls once 3d makes them async.
- **Two orderings fixed now** (cheap and right before slice 4):
  - `POST /api/companion/command` stores `last_command` before broadcasting, so a fast Companion
    can't ack a command that isn't stored yet;
  - the transcript-generation in-flight `409` redacts based on the holder that the detail
    actually names, carried on the error. It no longer re-reads the lock after an await, which
    could check membership against a different holder.
- **Package callback types accept Promises.**
  - `packages/transcription`: `resolveSessionTitle` may return a Promise and is awaited.
  - `packages/log-import`: `runSessionLogImport` becomes async and awaits `projectLive`, which
    becomes an expression body at its caller.
- **Await-free windows are preserved.** The event-generation word snapshot
  (`events.ts:463-466`) stays await-free up to the turn registration. The show-categories read
  moves before the snapshot, and validation and error order are unchanged. Design D4 lists every
  window.
- **No HTTP change.** Status codes, bodies, headers and WebSocket frames stay byte-identical, and
  the existing route suites pass without changing expectations.

## Decisions (owner, 2026-10-01)

- Slice 3 covers catalog, KV and presence; the session hub goes async in slice 7.
- Async catalog transactions take a scoped handle under a FIFO lock (lands in 3c and 3d).
- Test seed helpers stay synchronous until slice 4.
- Top-down split. 3a is split again along file lines to stay under 400 lines (AGENTS.md rule 7).

## Non-goals

- No change to `CatalogDb` or to any catalog store (3c and 3d).
- No change to teams, admin, profile, shows, auth routes, the auth middleware or `identity.ts`
  (3b).
- No SessionHub or session-core change (slice 7).
- No new KV operations. The atomic `take` (OAuth state) and the read-modify-write (Companion ack)
  races can't happen while storage is synchronous. The assumption tester confirmed this with
  6,000 concurrent HTTP callbacks and no double-consume. They are on the slice 4 hazard list
  (design D6), and `take` is auth work for the owner to decide.
- No new runtime dependency.

## Impact

- **Code:**
  - `packages/ports`: KV and presence interfaces;
  - `packages/storage/src/kvStore.ts`;
  - `server/src/node/{config,presence}.ts`, `server/src/main.ts`;
  - the session-side routers listed above;
  - `packages/transcription/src/generateTranscript.ts`;
  - `packages/log-import/src/runSessionLogImport.ts`.
- **Specs:** `core-ports-architecture` gains two requirements:
  - "Key/value and presence ports are asynchronous";
  - "Server code never drops or misuses a promise".
- **ADR 0021:** records the slice 3 scope, the 3a-3d split, and the slice 4 hazard list.
