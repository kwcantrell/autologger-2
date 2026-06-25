# Design: Decompose `SessionDO` into `SessionCore` + domain stores

**Date:** 2026-06-25
**Status:** Approved (design), pending implementation plan
**Scope:** `src/durable/SessionDO.ts` only. The `Catalog` decomposition (already shipped) is untouched.

## Motivation

`SessionDO` is the second god object graphify flagged: one Durable Object class of ~866 LOC
and ~30 RPC methods spanning six unrelated data domains (events, transport, audio segments,
recording lease, transcript words, topics) plus the cross-cutting WebSocket fan-out and alarm
lifecycle. Like `Catalog`, it is hard to reason about and test as one unit. The goal is to
restore cohesion by splitting the method bodies into focused domain stores over a shared core,
**without changing any observable behavior** — SQL, broadcasts, alarm timing, projection
shape, and RPC return types stay byte-identical.

## The DO-specific constraint (why this is not a pure facade)

`SessionDO extends DurableObject<Env>` is a framework class: Cloudflare instantiates it by
name (it is the `wrangler.jsonc` Durable Object binding target), and its RPC methods are
proxied across the isolate boundary by the stub. Two consequences shape the whole design:

1. **The stores must be internal.** Unlike the `Catalog` facade (where `catalog.shows` was
   exposed as a public property), a DO can only expose *flat methods on the class itself*
   over RPC. The domain stores are private implementation detail; `SessionDO` keeps a flat
   delegating RPC surface.
2. **RPC delegates are regular methods, not arrow-property fields.** DO RPC reliably exposes
   prototype methods; arrow-function instance fields are a needless compatibility risk here.
   (This differs from the `Catalog` facade, which used arrow-property delegates.)
3. **Framework hooks stay on the class.** `constructor`, `fetch` (WebSocket upgrade via
   `ctx.acceptWebSocket`), `webSocketMessage`, `webSocketClose`, `webSocketError`, and
   `alarm` are runtime entry points the platform calls on the instance — they cannot move to
   a helper.

## Approach (chosen: A — SessionCore + domain stores)

A `SessionCore` class owns the shared substrate every domain touches plus the two genuinely
cross-domain reads. Six domain stores take the core and hold their domain methods. `SessionDO`
becomes thin: it builds the core + six stores in its constructor, keeps the framework hooks,
and delegates every RPC method to a store. This is the direct Durable-Object-shaped analogue
of the `Catalog` facade + composition pattern already shipped.

Alternatives considered and rejected:
- **B — Free-function modules taking primitives.** Threading the core/primitives through every
  call reads noisier and diverges from the class-based store convention just established.
- **C — Lighter touch (extract only the big three).** Leaves `SessionDO` a ~450-line
  multi-domain class; only a partial cohesion win. The user chose all six domains.

## 1. Target module structure

`src/durable/SessionDO.ts` splits into siblings under `src/durable/`:

| File | Owns | Constructor dep |
|---|---|---|
| `sessionCore.ts` — `SessionCore` | `db` getter (`ctx.storage.sql`), `initSchema()`, `all()`/`first()` SQL helpers, `broadcast()`/`presence()`/`broadcastCommand()`, `bumpRevision()`/`revision()`, `transportRow()`, `projection()`, `metaGet`/`metaSet`/`metaDelete`, `setAlarm()`. Plus shared types `Row`, `SessionProjection`, `TimecodeCtx`, `TransportState`. | `ctx: DurableObjectState` |
| `eventStore.ts` — `EventStore` | `addEvent`, `listEvents`, `getEvent`, `exportEvents`, `updateEvent`, `deleteEvent`, `maybeRelinkOrphans`; exported pure `eventRowToRpc(r): EventRpc` | `core: SessionCore` |
| `transportStore.ts` — `TransportStore` | `transportSnapshot`, `startTake`, `stopTake`, `stopTakeWithDuration`, `statusLive`; private `transportStateDict` | `core` |
| `audioStore.ts` — `AudioStore` | `addAudioSegment`, `listAudioSegments`, `deleteAudioSegment`, `getAudioSegmentKey`, `setAudioSegmentWaveform`, `syncAudioFromR2`; exported pure `audioRowToMeta(r): AudioSegmentMeta`; `AudioSegmentMeta` interface | `core` |
| `leaseStore.ts` — `LeaseStore` | `claimLease`, `heartbeatLease`, `releaseLease`, `leaseStatus`, `expireIfStale()` (the `alarm` body); `LEASE_STALE_MS` constant | `core` |
| `transcriptStore.ts` — `TranscriptStore` | `listTranscriptWords`, `insertTranscriptWord`, `updateTranscriptWord`, `deleteTranscriptWord`; exported pure `wordRow(r): TranscriptWord`; `TranscriptWord` interface | `core` |
| `topicStore.ts` — `TopicStore` | `listTopics`, `insertTopic`, `updateTopic`, `deleteTopic`; exported pure `topicRow(r): Topic`; `Topic` interface | `core` |
| `SessionDO.ts` — slimmed DO | framework hooks (`constructor`, `fetch`, `webSocket*`, `alarm`) + flat RPC delegates + `ensure`/`presence`/`broadcastCommand`; re-exports the public types | the core + six stores |

The four row-mappers (`eventRowToRpc`, `audioRowToMeta`, `wordRow`, `topicRow`) become
**exported pure functions** — they take a `Row` and return a typed object with no `this`/`db`
dependency. They are the unit-testable surface.

### Type re-exports
`SessionProjection`, `TransportState`, `AudioSegmentMeta`, `TranscriptWord`, and `Topic` are
currently exported from `SessionDO.ts` and imported elsewhere. To avoid a facade↔store import
cycle and keep existing importers working, the shared types (`Row`, `SessionProjection`,
`TimecodeCtx`, `TransportState`) live in `sessionCore.ts`; the per-domain types live with
their store; and `SessionDO.ts` re-exports all the public ones via `export type { ... }`.

## 2. SessionCore — the shared substrate

`SessionCore` homes exactly the glue multiple domains touch, plus the two genuinely
**cross-domain reads**:
- `transportRow()` — Transport owns the `session_transport` row, but Events' `addEvent` needs
  it to stamp the event timecode. Centralizing it in the core keeps Events from depending on
  TransportStore.
- `projection()` — aggregates `events` count + `session_transport` state into the
  `SessionProjection` returned by nearly every mutation.

`SessionCore` takes `ctx`, exposes `db` via `ctx.storage.sql`, and wraps `ctx.getWebSockets()`
(broadcast/presence) and `ctx.storage.setAlarm()` so the stores never touch `ctx` directly.
`statusLive` stays in `TransportStore` (it is mostly transport state plus two event counts,
read through the shared `core.first()` helper).

## 3. SessionDO — framework hooks + delegation

`SessionDO` keeps:
- `constructor(ctx, env)`: `super(ctx, env)`, then (in the constructor body, after `super`)
  `this.core = new SessionCore(ctx); this.core.initSchema();` and construct the six stores
  with `this.core`. Fields are declared without initializers and assigned in the constructor
  (the same ordering discipline used for `Catalog`: never reference `ctx`/the core in a field
  initializer).
- `fetch(request)`: the WebSocket upgrade — uses `this.ctx.acceptWebSocket(...)` directly,
  unchanged.
- `webSocketMessage`: parses, relays `{type:'command'}` via `this.core.broadcastCommand(...)`.
- `webSocketClose`, `webSocketError`: unchanged (pure `ctx`/socket handling).
- `alarm()`: delegates to `this.lease.expireIfStale()`.
- `ensure()` → `this.core.projection()`, `presence()` → `this.core.presence()`,
  `broadcastCommand(c)` → `this.core.broadcastCommand(c)`.
- Every other RPC method: a one-line **regular-method** delegate to the owning store, e.g.
  `addEvent(input) { return this.events.addEvent(input); }`.

## 4. Data flow & the single-writer invariant

Per request the runtime calls a `SessionDO` RPC method → it delegates to a store → the store
calls `this.core.db.exec(...)` / `this.core.broadcast(...)` / `this.core.projection()`.
Concurrency is unchanged: still one DO instance, single-threaded, operating on the same
`ctx.storage.sql`. The six stores share one `SessionCore` built once in the constructor;
moving method bodies into them introduces no new writer. The single-writer invariant is a
property of the DO runtime, not of the class layout — so this refactor is behavior-preserving
in the same way the `Catalog` one was.

## 5. Safety net

- **Automated unit tests (vitest, node env):** characterization tests for the four pure
  mappers (`eventRowToRpc`, `audioRowToMeta`, `wordRow`, `topicRow`) against representative
  rows, written green **before** the mappers move. These import only the store modules, which
  import `timecode`/`studio`/shared types — never `cloudflare:workers` — so they run in plain
  node vitest.
- **DO-class surface smoke test is NOT feasible in plain vitest.** `SessionDO.ts` imports
  `cloudflare:workers` (the `DurableObject` base), which only resolves inside `workerd`.
  Constructing the DO or asserting its RPC surface in node would require
  `@cloudflare/vitest-pool-workers`, which is explicitly out of scope for this refactor.
- **Substitute: live-worker smoke.** Boot `wrangler dev` (local D1 + DO) and exercise the
  session/event/transport/audio/lease/transcript/topic endpoints, confirming the real RPC
  surface works through real routers. This is the same verification used to validate phase 3,
  and is stronger than a `typeof` surface check.
- `tsc --noEmit` clean and the existing test suite stays green throughout.

## 6. Error handling & scope guards

- **Behavior-identical.** SQL statements, broadcast messages/types, alarm timing
  (`LEASE_STALE_MS`), `projection`/`statusLive`/`TransportState` shapes, and all RPC return
  types are unchanged. No router, `src/routers/_helpers.ts`, `src/types.ts`, or
  `wrangler.jsonc` edits — `getSessionDO(c, id)` still returns a
  `DurableObjectStub<SessionDO>` with the same method surface.
- **The DO identity is fixed.** The `DurableObject<Env>` base, the class name `SessionDO`, and
  the binding stay exactly as-is — renaming a DO class requires a migration and is explicitly
  out of scope.
- **YAGNI:** no schema/migration changes, no new behavior, no router migration to per-store
  access (impossible over RPC anyway).

## 7. Sequencing (basis for the implementation plan)

Each step keeps the worker compiling and behavior-identical, so work can stop between any two.

1. Add pure-mapper characterization tests (green against current `SessionDO.ts`).
2. Extract `SessionCore` (schema, `db`, SQL helpers, WS broadcast/presence, revision,
   projection, transportRow, meta, setAlarm); `SessionDO` builds it in the constructor and
   delegates the cross-cutting bits; `tsc` green.
3. Extract `EventStore` (+ exported `eventRowToRpc`); delegate; re-point mapper tests.
4. Extract `TransportStore`; delegate.
5. Extract `AudioStore` (+ `audioRowToMeta`, `AudioSegmentMeta`); delegate.
6. Extract `LeaseStore`; wire `alarm()` → `expireIfStale()`; delegate.
7. Extract `TranscriptStore` and `TopicStore` (+ `wordRow`/`topicRow`); delegate.
8. Slim `SessionDO` to hooks + flat delegates; re-export public types; run `tsc` + vitest +
   live-worker smoke; bump `version` in `package.json` (0.2.0 → 0.3.0).

## Acceptance criteria

- `SessionDO`'s RPC surface (every router-called method) and framework hooks are unchanged;
  no router/middleware/types/wrangler file is edited.
- `src/durable/SessionDO.ts` is reduced to framework hooks + flat delegates + type re-exports;
  six new store files + `sessionCore.ts` each hold one concern.
- `tsc --noEmit` passes; `vitest run` passes (existing tests + the four new mapper tests).
- Live-worker smoke: session create/status, event add/list, transport start/stop, audio
  segments list, lease claim/status, transcript + topic list all succeed against `wrangler dev`.
- `version` bumped in the worker's `package.json` to `0.3.0`.
