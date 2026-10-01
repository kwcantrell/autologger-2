# Design: async-session-callers

## Context

Today the storage ports are synchronous on better-sqlite3: `CatalogDb`, `KvStore` and
`PresenceRegistry` in `packages/ports/src/*`. ADR 0021 slice 3 makes them async in four PRs,
converting top-down:
1. **3a (this change):** KV and presence, and the session-side callers.
2. **3b:** the remaining callers.
3. **3c:** the async catalog adapter.
4. **3d:** the stores.

## D1. What an `await` on synchronous storage changes

`await f()` evaluates `f()` synchronously, then suspends until the microtask queue drains to the
continuation.
- While storage is synchronous, the promise is already resolved, so only microtasks that were
  queued before it can run in the yield: continuations of other in-flight handlers.
- A new request can't run there, because it arrives on an I/O callback, a macrotask.
- The assumption tester checked this. 2,000 × 3 concurrent HTTP OAuth callbacks gave no
  double-consume. An in-process `Promise.all` of two get-then-delete sequences did
  double-consume.

So 3a changes nothing observable. The interleaving hazards are real only once storage does I/O
(slice 4). This change lists them (D6), fixes the cheap ones (D5), and adds the check (D3) that
keeps later slices from silently dropping a promise.

## D2. Port shapes

```ts
export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  purgeExpired(): Promise<void>;
}
export interface PresenceRegistry {
  upsert(clientId: string, meta: PresenceMeta): Promise<void>;
  remove(clientId: string): Promise<void>;
  list(): Promise<PresenceMeta[]>;
}
```

**Adapters.** They are `async` methods around the same statements. The KV adapter's lazy-expiry
path awaits its own `delete`, so no promise floats inside the adapter. Presence stays an
in-memory Map; slice 9 replaces it with Realtime Presence.

**Startup purge.** `purgeExpired` moves from `createBindings` to `main.ts`, where it is awaited
after `createBindings` and before the frontend prepares and the server listens.
- **Failure:** for example `SQLITE_BUSY` from an external backup holding the write lock. It logs
  a warning naming the error class and boot continues. It's hygiene: `get` still enforces expiry
  lazily, and failing boot over it would turn a backup overlap into an outage.
- **Tests:** `createBindings` no longer purges. A test stubs a failing purge and checks the boot
  helper resolves and logs.

## D3. No dropped or misused promises: a type-checked repo test

**The check.** `server/src/promiseHygiene.repo.test.ts` builds a TypeScript `Program` from
`server/tsconfig.json` and walks every non-test source file under `server/src`. It reports
`file:line` for:
1. **A dropped promise:** an expression statement whose expression type is Promise-like (has a
   callable `then`), unless it is `await`ed, `void`ed or returned.
2. **A misused promise:** a Promise-like value used as an `if`/`while`/ternary condition, an
   operand of `!`, `&&` or `||` in a condition, or as a template or JSON field value. The JSON
   case covers `c.json({ x: promise })`, which tsc accepts.

In-memory source fixtures run through the same checker prove it detects:
- a dropped gate call;
- a dropped aliased `presence.list()`;
- `!asyncFn()`;
- a dropped method call through a port interface.

**Why not Biome.** Biome 2.5.3 `nursery/noFloatingPromises` was tried on a probe file. It flagged
local and imported async functions. It missed `kv.put(...)` and `c.env.ports.kv.delete(...)`
through the `@autologger/ports` interfaces, and `!promise`. It also panicked
(`internalError/panic`) on three existing test files. typescript-eslint would work but adds a
dependency and a second linter.

**Scope.** All of `server/src` production code, not only the files this change touches. The
check holds across the tree after 3a and keeps holding as 3b to 3d convert more calls. In 3d the
catalog methods return Promises, and the same test then covers every catalog call, including
void-returning writes such as `projectSessionLive`. Existing violations found on the first run
(Biome flagged `main.ts:130`) are fixed here, or listed in the test with a reason. The aim is an
empty list.

## D4. Await-free windows and check-then-act sequences in the touched files

| Site | Invariant | Storage call inside? | Action in 3a |
|---|---|---|---|
| `events.ts:463-506` generate: word snapshot to `tryAcquire` | No interleaving | **Yes**, `getSessionShowCategories` at :477 | Hoist the read above the snapshot. Checks keep their order. A source-inspection test asserts no `await`/`catalog.` in the window. |
| `events.ts:519-521` prologue `exportEvents` | One hub read, three uses | No | None |
| `events.ts:618-631` finally: release, then mirror | Release before the mirror | Mirror is the last statement | Comment updated. Re-audit in 3d (D6). |
| `transcribe.ts:254` topic-generation word list captured once | Snapshot before any await | `requireSession` precedes it | None; recorded |
| `transcribe.ts:164-185` in-flight 409 redaction | Redact by the holder named in the detail | `resolveSessionTitle` now awaited inside, then the lock is re-read in the catch | **Fixed** (D5) |
| `companion.ts` `/command`: broadcast, then store | Ack finds the stored command | KV `put` after broadcast | **Fixed** (D5) |
| `companion.ts` `/ack` get, then put | Read-modify-write | KV get/put | Slice 4 (D6) |
| `companion.ts` `/state` reads presence twice (:118, :119) | One snapshot | Presence | One `list()` reused for both values (cosmetic, 2 lines) |
| `sessions.ts:529-549` rolling re-check, then anchor | Check-then-act | No | None |
| `sessions.ts` youtube import "synchronous hub RPC" scenarios | Hub RPCs stay sync | No (hub untouched) | None; recorded |
| `sessions.ts:123-132` list reads, then writes the active show | Read-then-write | Catalog | Slice 4 (D6) |
| `sessions.ts:153-177` create: show check, then insert | Check-then-act | Catalog | Slice 4 (D6) |
| `aiMcpServer.ts` `create_event` await-free | Cap check to insert | No catalog call (not touched) | None; recorded |
| Every `requireSession`/`guardAiV2Route`, then action | Authorisation, then act | Catalog | Accepted. The check and the act were never atomic; RLS replaces this in slice 6. |

## D5. Fixes made now

- **`/command` stores before broadcasting.** It builds `last`, awaits `kv.put`, then
  `broadcastCommand`. If the broadcast throws, the stored command stays `ok:false,
  delivered_to:null`, which is the truthful state, and the route errors as it would today. The
  response is unchanged.
- **The in-flight 409 is redacted by the named holder.** `TranscriptGenerateError('in_flight')`
  carries `holderSessionId`, the id its detail was built from. The route checks membership
  against that id instead of re-reading the lock. If the field is absent (other codes), nothing
  changes. The response shape is unchanged. The existing redaction tests must pass unchanged, and
  a unit test covers the field.
- **`logImport.ts` `projectLive`** becomes an expression-bodied callback that returns the
  catalog call, so it's awaitable in 3d.

## D6. Slice 4 hazard list (recorded in ADR 0021; nothing to do in 3a)

These matter once storage does I/O:
1. **OAuth state** (`identity.ts:41-46`): get, then delete. Needs an atomic take
   (`DELETE … RETURNING`). Auth, so the owner decides.
2. **Companion `/ack`:** read-modify-write of `last_command`. Needs one conditional
   `UPDATE … WHERE id = $1`.
3. **Projection mirror order:** `projectSessionLive` after hub writes (`events.ts:241,631,687`;
   companion `/log` and `/transport`). Concurrent writers can commit an older projection last.
   Guard on a monotonic `events_stream_revision`.
4. **`events.ts` finally:** release, then mirror becomes release, then I/O. Re-audit.
5. **`sessions.ts` active-show read-then-write and show-check-then-create.** Use transactions or
   constraints.
6. **`logImport.ts`** uses the request's `c.get('catalog')` inside the detached import job
   (:117, :160). It needs a non-request handle when the catalog becomes request-scoped (3c/3d,
   slice 6).
7. **Hubs held across awaits:** the rule from `aiMcpServer.ts:23` ("resolve the hub at call time,
   never hold it across an await") applies to every router once catalog calls yield. 3a adds
   no hub-across-await. 3d re-checks.

## D7. Size

The assumption tester's mechanical simulation of the await and call edits counted 196 lines.
With the ports, adapters, helpers, the two fixes, the hoist, the package callbacks and reflow,
the estimate is 330-390. `take` and `update` were cut from 3a to stay inside 400. It is measured
with `check-change.sh --only size` before review. If it is over, `events.ts` and `sessions.ts`
move to a follow-up PR, split by file.
