# SessionDO Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 866-line `SessionDO` Durable Object god class (`src/durable/SessionDO.ts`) into a shared `SessionCore` + six focused domain stores, with the DO keeping its framework hooks and a flat RPC-delegate surface — zero behavior change.

**Architecture:** `SessionDO extends DurableObject<Env>` stays the framework class Cloudflare instantiates. A `SessionCore` (built once in the constructor) owns the shared substrate — `db`, SQL helpers, WebSocket broadcast/presence, revision, projection, transportRow, meta, setAlarm — and six stores (`EventStore`, `TransportStore`, `AudioStore`, `LeaseStore`, `TranscriptStore`, `TopicStore`) take the core and hold their domain methods. `SessionDO` keeps the lifecycle hooks (`fetch`/`webSocket*`/`alarm`/`constructor`) and delegates every RPC method to a store via regular (prototype) methods.

**Tech Stack:** TypeScript (strict, `verbatimModuleSyntax`, `noUnusedLocals`), Cloudflare Durable Objects (`cloudflare:workers`, embedded SQLite `ctx.storage.sql`, hibernatable WebSockets, alarms), vitest (node env, already configured).

## Global Constraints

- **No behavior change.** SQL statements, broadcast message types, alarm timing (`LEASE_STALE_MS = 40_000`), and all RPC return shapes (`SessionProjection`, `TransportState`, `EventRpc`, `AudioSegmentMeta`, `TranscriptWord`, `Topic`) must stay byte-identical.
- **Blast radius stays in `src/durable/`.** No router, `src/routers/_helpers.ts`, `src/types.ts`, or `wrangler.jsonc` edits. `getSessionDO(c, id)` must still return a `DurableObjectStub<SessionDO>` with the same method surface.
- **DO identity is fixed.** The `DurableObject<Env>` base, the class name `SessionDO`, and the binding stay exactly as-is. Renaming a DO class needs a migration — out of scope.
- **RPC delegates are regular prototype methods**, never arrow-property fields: `addEvent(input) { return this.events.addEvent(input); }`. DO RPC reliably exposes prototype methods; arrow fields are a needless risk.
- **Framework hooks stay on `SessionDO`:** `constructor`, `fetch`, `webSocketMessage`, `webSocketClose`, `webSocketError`, `alarm`.
- **Construct stores in the constructor body, after `super(ctx, env)`** — never in field initializers (a field initializer runs before `super` completes and before `ctx` is usable). Declare `private core!: SessionCore` etc. and assign in the constructor. Arrow-free; `this.core`/`this.<store>` are read at call time inside delegates so ordering among them is safe, but the `new SessionCore(ctx)` call itself must be in the body.
- **`verbatimModuleSyntax: true`** — every type-only import/export uses `import type` / `export type`. **`noUnusedLocals`/`noUnusedParameters: true`** — no unused locals/params (unused class methods are NOT flagged).
- **`cloudflare:workers` only resolves in `workerd`.** Anything imported by a node-vitest test must NOT transitively import `SessionDO.ts`. The store modules and `sessionCore.ts` must never import `cloudflare:workers` (only `SessionDO.ts` does, for the base class). This is why the pure mappers live in store modules, not on the DO class.
- **Move bodies verbatim.** When a step says "move method X (lines A–B)," copy the body exactly and apply ONLY the listed cross-store rewrites. Do not refactor logic.
- **Verify after every task:** `npm run typecheck` AND `npx vitest run` pass before committing.

### Note on test-first feasibility (deviation from spec §7 step 1)
The spec's step 1 ("pure-mapper tests green against current `SessionDO.ts`") is **not achievable** — `SessionDO.ts` imports `cloudflare:workers`, so it cannot be imported in node vitest, and the four mappers are currently private/non-exported inside it. Therefore each mapper is **extracted into its store module first, then unit-tested there** (test-first against the new module: write the test importing the not-yet-created export → it fails → create the module → it passes). Expected values are derived from the current mapper code (which is behavior we are preserving verbatim).

---

## File structure (end state)

- `src/durable/sessionCore.ts` (new) — `SessionCore` + shared types `Row`, `SessionProjection`, `TimecodeCtx`, `TransportState`.
- `src/durable/eventStore.ts` (new) — `EventStore` + exported pure `eventRowToRpc`.
- `src/durable/transportStore.ts` (new) — `TransportStore`.
- `src/durable/audioStore.ts` (new) — `AudioStore` + exported pure `audioRowToMeta` + `AudioSegmentMeta`.
- `src/durable/leaseStore.ts` (new) — `LeaseStore` (+ `LEASE_STALE_MS`).
- `src/durable/transcriptStore.ts` (new) — `TranscriptStore` + exported pure `wordRow` + `TranscriptWord`.
- `src/durable/topicStore.ts` (new) — `TopicStore` + exported pure `topicRow` + `Topic`.
- `src/durable/SessionDO.ts` (slimmed) — framework hooks + flat RPC delegates + public type re-exports.
- Test files: `src/durable/eventStore.test.ts`, `audioStore.test.ts`, `transcriptStore.test.ts`, `topicStore.test.ts`.

---

## Task 1: Extract `SessionCore` (the shared substrate)

Move the cross-cutting glue and the two cross-domain reads into a `SessionCore` the DO builds once. Keep same-named **private delegates** on `SessionDO` so the still-inline domain methods keep compiling until their own extraction task.

**Files:**
- Create: `src/durable/sessionCore.ts`
- Modify: `src/durable/SessionDO.ts`

**Interfaces:**
- Produces: `class SessionCore` with `constructor(private ctx: DurableObjectState)` and: `get db(): SqlStorage`, `initSchema(): void`, `all(query, ...binds): Row[]`, `first(query, ...binds): Row | null`, `broadcast(msg: Record<string, unknown>): void`, `presence(): { browsers: number; companions: number }`, `broadcastCommand(command: string): void`, `bumpRevision(): void`, `revision(): number`, `transportRow(): TransportFields & { current_take: number }`, `projection(): SessionProjection`, `metaGet(key): string | null`, `metaSet(key, value): void`, `metaDelete(key): void`, `setAlarm(atMs: number): void`. Exports types `Row`, `SessionProjection`, `TimecodeCtx`, `TransportState`.

- [ ] **Step 1: Create `src/durable/sessionCore.ts`**

```ts
// SessionCore — the shared substrate every SessionDO domain store builds on:
// the embedded-SQLite handle + helpers, the hibernatable WebSocket fan-out,
// the events_stream_revision counter, the D1 projection, the transport row,
// and meta key/value + alarm scheduling. Holds the two cross-domain reads
// (transportRow, projection) so the domain stores never depend on each other.
// Never imports `cloudflare:workers` — only SessionDO.ts does.

import { type TransportFields } from '../timecode';

export type Row = Record<string, SqlStorageValue>;

/** Live fields the Worker mirrors onto the D1 sessions row for cheap listing. */
export interface SessionProjection {
  event_count: number;
  max_timecode_total_frames: number | null;
  is_rolling: boolean;
  current_take: number;
  transport_elapsed_frames: number;
  roll_started_at_utc: string | null;
}

export interface TimecodeCtx {
  frameRate: number;
  startOffsetFrames: number;
}

/** Concrete (RPC-serializable) transport snapshot; `started`/`stopped` flag a no-op vs change. */
export interface TransportState {
  is_rolling: boolean;
  current_take: number;
  roll_started_at_utc: string | null;
  elapsed_frames: number;
  timecode: string;
  timecode_total_frames: number;
  started?: boolean;
  stopped?: boolean;
}

export class SessionCore {
  constructor(private ctx: DurableObjectState) {}

  get db(): SqlStorage {
    return this.ctx.storage.sql;
  }

  // Move verbatim from SessionDO.ts:
  //   initSchema  (lines 64–121)   — the full CREATE TABLE block
  // Then add the rest below by moving these bodies verbatim (they reference only
  // this.db / this.ctx / each other — no cross-store edits):
  //   all              (202–204)
  //   first            (206–209)
  //   transportRow     (211–219)   — return type `TransportFields & { current_take: number }`
  //   bumpRevision     (221–225)
  //   revision         (227–230)
  //   projection       (232–244)
  //   broadcast        (143–152)   — uses this.ctx.getWebSockets()
  //   presence         (155–164)
  //   broadcastCommand (167–169)
  //   metaGet          (527–530)
  //   metaSet          (532–538)
  //   metaDelete       (540–542)

  /** Wraps ctx.storage.setAlarm so lease logic never touches ctx directly. */
  setAlarm(atMs: number): void {
    void this.ctx.storage.setAlarm(atMs);
  }
}
```
Move each listed body verbatim. `all`/`first`/`transportRow`/`bumpRevision`/`revision`/`projection`/`metaGet`/`metaSet`/`metaDelete`/`broadcast`/`presence`/`broadcastCommand` were `private` in `SessionDO`; make them **public** here (the stores call them). `initSchema` becomes public (the DO constructor calls it).

- [ ] **Step 2: Update `src/durable/SessionDO.ts` — build the core, delegate the substrate**

1. Add the import (value import — `SessionCore` is constructed; types via `import type`):
```ts
import { SessionCore } from './sessionCore';
import type { Row, SessionProjection, TimecodeCtx, TransportState } from './sessionCore';
```
2. DELETE from `SessionDO.ts` the now-moved local type declarations: `type Row` (line 25), `interface SessionProjection` (27–35), `interface TimecodeCtx` (37–40), `interface TransportState` (42–52). Re-export the public ones so existing importers keep working:
```ts
export type { SessionProjection, TransportState } from './sessionCore';
```
3. Replace the class field/constructor head. Change:
```ts
export class SessionDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initSchema();
  }

  private get db(): SqlStorage {
    return this.ctx.storage.sql;
  }
```
to:
```ts
export class SessionDO extends DurableObject<Env> {
  private core!: SessionCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new SessionCore(ctx);
    this.core.initSchema();
  }
```
4. DELETE the moved bodies from `SessionDO`: `initSchema` (64–121), `broadcast` (143–152), `presence` (155–164), `broadcastCommand` (167–169), `all` (202–204), `first` (206–209), `transportRow` (211–219), `bumpRevision` (221–225), `revision` (227–230), `projection` (232–244), `metaGet` (527–530), `metaSet` (532–538), `metaDelete` (540–542).
5. Add **private substrate delegates** (kept until the domains that use them are extracted in Tasks 2–7; Task 8 removes the leftovers). Place them right after the constructor:
```ts
  // --- substrate delegates (temporary shim; removed in Task 8) ---
  private get db(): SqlStorage {
    return this.core.db;
  }
  private all(query: string, ...binds: SqlStorageValue[]): Row[] {
    return this.core.all(query, ...binds);
  }
  private first(query: string, ...binds: SqlStorageValue[]): Row | null {
    return this.core.first(query, ...binds);
  }
  private transportRow() {
    return this.core.transportRow();
  }
  private bumpRevision(): void {
    this.core.bumpRevision();
  }
  private revision(): number {
    return this.core.revision();
  }
  private projection(): SessionProjection {
    return this.core.projection();
  }
  private broadcast(msg: Record<string, unknown>): void {
    this.core.broadcast(msg);
  }
  private metaGet(key: string): string | null {
    return this.core.metaGet(key);
  }
  private metaSet(key: string, value: string): void {
    this.core.metaSet(key, value);
  }
  private metaDelete(key: string): void {
    this.core.metaDelete(key);
  }
```
6. Update the public lifecycle/relay methods to use the core:
   - `webSocketMessage` body: `this.broadcastCommand(p.command)` → `this.core.broadcastCommand(p.command)`.
   - `broadcastCommand` public RPC method body → `this.core.broadcastCommand(command)`.
   - `presence` public RPC method body → `return this.core.presence();`.
   - `ensure` (265–267) body → `return this.core.projection();`.
   - In `claimLease`/`heartbeatLease` (still inline), `void this.ctx.storage.setAlarm(...)` → `this.core.setAlarm(...)`.
   (All other still-inline domain methods keep calling `this.db`/`this.broadcast`/etc. via the private delegates above — leave them.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors. `tsc` will flag any missed reference (e.g., a leftover `this.initSchema()` or a substrate method you forgot to delegate) — fix each.

- [ ] **Step 4: Existing tests still green**

Run: `npx vitest run`
Expected: PASS (the 6 existing Catalog-era tests; nothing here adds tests yet — `SessionCore` is SQL/ctx-bound and is covered by the live-worker smoke in Task 8).

- [ ] **Step 5: Commit**

```bash
git add src/durable/sessionCore.ts src/durable/SessionDO.ts
git commit -m "refactor(do): extract SessionCore substrate from SessionDO"
```

---

## Task 2: Extract `EventStore` (+ pure `eventRowToRpc`)

**Files:**
- Create: `src/durable/eventStore.ts`
- Test: `src/durable/eventStore.test.ts`
- Modify: `src/durable/SessionDO.ts`

**Interfaces:**
- Produces: exported `function eventRowToRpc(r: Row): EventRpc`; `class EventStore` with `constructor(private core: SessionCore)` and methods `addEvent`, `listEvents`, `getEvent`, `exportEvents`, `updateEvent`, `deleteEvent`, `maybeRelinkOrphans` (same signatures as the current `SessionDO` methods).
- Consumes: `SessionCore`, `Row` from `./sessionCore`; `EventRpc`, `UI_SNAPSHOT_COLOR_KEY`, `UI_SNAPSHOT_LABEL_KEY` from `../studio`; `formatSmpte`, `fromTotalFrames`, `isoZ`, `parseUtcMs`, `timecodeForMark`, `toTotalFrames` from `../timecode`.

- [ ] **Step 1: Write the failing test for `eventRowToRpc`**

Create `src/durable/eventStore.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { formatSmpte, fromTotalFrames } from '../timecode';
import { eventRowToRpc } from './eventStore';

describe('eventRowToRpc', () => {
  it('maps a row with a timecode', () => {
    const r = {
      id: 'e1',
      wall_time_utc: '2026-06-25T00:00:00.000Z',
      frame_rate: 24,
      timecode_total_frames: 48,
      category: 'note',
      message: 'hi',
      metadata_json: '{"a":1}',
    };
    expect(eventRowToRpc(r)).toEqual({
      event_id: 'e1',
      wall_time_utc: '2026-06-25T00:00:00.000Z',
      timecode: formatSmpte(fromTotalFrames(48, 24)),
      frame_rate: 24,
      timecode_total_frames: 48,
      category: 'note',
      message: 'hi',
      metadata_json: '{"a":1}',
    });
  });

  it('nulls timecode fields when timecode_total_frames is absent, defaults metadata', () => {
    const r = {
      id: 'e2',
      wall_time_utc: '2026-06-25T00:00:01.000Z',
      frame_rate: 24,
      timecode_total_frames: null,
      category: 'internal',
      message: 'rec start',
      metadata_json: null,
    };
    expect(eventRowToRpc(r)).toEqual({
      event_id: 'e2',
      wall_time_utc: '2026-06-25T00:00:01.000Z',
      timecode: null,
      frame_rate: null,
      timecode_total_frames: null,
      category: 'internal',
      message: 'rec start',
      metadata_json: '{}',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/durable/eventStore.test.ts`
Expected: FAIL — `Failed to resolve import "./eventStore"` (module doesn't exist yet).

- [ ] **Step 3: Create `src/durable/eventStore.ts`**

```ts
// Event log domain — events table CRUD, the export feed, and the one-shot
// orphan-relink pass. Moved verbatim out of SessionDO.ts.

import { type EventRpc, UI_SNAPSHOT_COLOR_KEY, UI_SNAPSHOT_LABEL_KEY } from '../studio';
import {
  formatSmpte,
  fromTotalFrames,
  isoZ,
  parseUtcMs,
  timecodeForMark,
  toTotalFrames,
} from '../timecode';
import type { SessionCore, Row, SessionProjection, TimecodeCtx } from './sessionCore';

/** rowToRpc — pure events-row → RPC mapper (was SessionDO.rowToRpc, lines 246–260). */
export function eventRowToRpc(r: Row): EventRpc {
  const tf = r.timecode_total_frames;
  const fr = Number(r.frame_rate);
  const hasTf = tf !== null && tf !== undefined;
  return {
    event_id: String(r.id),
    wall_time_utc: String(r.wall_time_utc),
    timecode: hasTf ? formatSmpte(fromTotalFrames(Number(tf), fr)) : null,
    frame_rate: hasTf ? fr : null,
    timecode_total_frames: hasTf ? Number(tf) : null,
    category: String(r.category),
    message: String(r.message),
    metadata_json: String(r.metadata_json ?? '{}'),
  };
}

export class EventStore {
  constructor(private core: SessionCore) {}

  // Move verbatim from SessionDO.ts, THEN apply the rewrites in Step 4:
  //   addEvent            (271–301)
  //   listEvents          (303–325)
  //   getEvent            (327–330)
  //   exportEvents        (333–335)
  //   updateEvent         (337–361)
  //   deleteEvent         (363–371)
  //   maybeRelinkOrphans  (376–421)
}
```

- [ ] **Step 4: Apply the cross-store rewrites inside the moved bodies**

In every moved method, rewrite substrate calls to go through the core, and the mapper to the module function:
- `this.db` → `this.core.db`
- `this.first(` → `this.core.first(`
- `this.all(` → `this.core.all(`
- `this.bumpRevision()` → `this.core.bumpRevision()`
- `this.revision()` → `this.core.revision()`
- `this.broadcast(` → `this.core.broadcast(`
- `this.projection()` → `this.core.projection()`
- `this.transportRow()` → `this.core.transportRow()`
- `this.rowToRpc(` → `eventRowToRpc(` (module function, not `this.`)

(`addEvent` uses `transportRow`, `timecodeForMark`, `toTotalFrames`, `isoZ`, `parseUtcMs`; `maybeRelinkOrphans` uses the `UI_SNAPSHOT_*` keys — all imported above.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/durable/eventStore.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Update `src/durable/SessionDO.ts` — construct, delegate, remove moved code**

1. Add imports:
```ts
import { EventStore } from './eventStore';
```
2. DELETE from `SessionDO`: the private `rowToRpc` method (246–260) and the seven event methods (`addEvent` 271–301, `listEvents` 303–325, `getEvent` 327–330, `exportEvents` 333–335, `updateEvent` 337–361, `deleteEvent` 363–371, `maybeRelinkOrphans` 376–421).
3. Add the field + construct it in the constructor (after `this.core` is built):
```ts
  private events!: EventStore;
```
```ts
    this.core.initSchema();
    this.events = new EventStore(this.core);
```
4. Add the flat RPC delegates (regular methods), e.g. after the substrate delegates:
```ts
  // --- event delegates ---
  addEvent(input: Parameters<EventStore['addEvent']>[0]) {
    return this.events.addEvent(input);
  }
  listEvents(input: Parameters<EventStore['listEvents']>[0]) {
    return this.events.listEvents(input);
  }
  getEvent(eventId: string) {
    return this.events.getEvent(eventId);
  }
  exportEvents() {
    return this.events.exportEvents();
  }
  updateEvent(input: Parameters<EventStore['updateEvent']>[0]) {
    return this.events.updateEvent(input);
  }
  deleteEvent(eventId: string) {
    return this.events.deleteEvent(eventId);
  }
  maybeRelinkOrphans(input: Parameters<EventStore['maybeRelinkOrphans']>[0]) {
    return this.events.maybeRelinkOrphans(input);
  }
```

- [ ] **Step 7: Typecheck + full test run**

Run: `npm run typecheck` → no errors.
Run: `npx vitest run` → PASS (existing 6 + 2 new).

- [ ] **Step 8: Commit**

```bash
git add src/durable/eventStore.ts src/durable/eventStore.test.ts src/durable/SessionDO.ts
git commit -m "refactor(do): extract EventStore + pure eventRowToRpc"
```

---

## Task 3: Extract `TransportStore`

No pure mapper (timecode formatting is already in `../timecode`), so no new unit test — verified by `tsc` + the Task 8 live smoke.

**Files:**
- Create: `src/durable/transportStore.ts`
- Modify: `src/durable/SessionDO.ts`

**Interfaces:**
- Produces: `class TransportStore` with `constructor(private core: SessionCore)` and methods `transportSnapshot(ctx: TimecodeCtx): TransportState`, `startTake(ctx): { state: TransportState; projection: SessionProjection }`, `stopTake(ctx): { state: TransportState; projection: SessionProjection }`, `stopTakeWithDuration(input: { durationS: number; ctx: TimecodeCtx }): SessionProjection`, `statusLive(ctx): {...}` (same shape as current); private `transportStateDict`.
- Consumes: `SessionCore`, `TimecodeCtx`, `TransportState`, `SessionProjection` from `./sessionCore`; `formatSmpte`, `isoZ`, `parseUtcMs`, `toTotalFrames`, `transportTimecode` from `../timecode`.

- [ ] **Step 1: Create `src/durable/transportStore.ts`**

```ts
// Transport domain — the single session_transport row: rolling state, take
// counter, elapsed frames, and the live timecode snapshot. Moved verbatim out
// of SessionDO.ts.

import { formatSmpte, isoZ, parseUtcMs, toTotalFrames, transportTimecode } from '../timecode';
import type {
  SessionCore,
  SessionProjection,
  TimecodeCtx,
  TransportState,
} from './sessionCore';

export class TransportStore {
  constructor(private core: SessionCore) {}

  // Move verbatim from SessionDO.ts, THEN apply the Step 2 rewrites:
  //   transportStateDict (private)  (425–436)
  //   transportSnapshot             (438–440)
  //   startTake                     (442–459)
  //   stopTake                      (461–484)
  //   stopTakeWithDuration          (487–495)
  //   statusLive                    (499–523)
}
```

- [ ] **Step 2: Apply the cross-store rewrites inside the moved bodies**

- `this.transportRow()` → `this.core.transportRow()`
- `this.db` → `this.core.db`
- `this.broadcast(` → `this.core.broadcast(`
- `this.projection()` → `this.core.projection()`
- `this.first(` → `this.core.first(`
- `this.revision()` → `this.core.revision()`
- `this.transportStateDict(` → unchanged (intra-store private)

(`transportStateDict` uses `transportTimecode`, `formatSmpte`, `toTotalFrames`; `startTake`/`stopTake` use `isoZ`/`parseUtcMs`; `statusLive` reads the two event counts via `this.core.first(...)`.)

- [ ] **Step 3: Update `src/durable/SessionDO.ts`**

1. `import { TransportStore } from './transportStore';`
2. DELETE the six transport methods (`transportStateDict` 425–436, `transportSnapshot` 438–440, `startTake` 442–459, `stopTake` 461–484, `stopTakeWithDuration` 487–495, `statusLive` 499–523).
3. Add field + construct (after `this.events`):
```ts
  private transport!: TransportStore;
```
```ts
    this.transport = new TransportStore(this.core);
```
4. Add delegates:
```ts
  // --- transport delegates ---
  transportSnapshot(ctx: TimecodeCtx) {
    return this.transport.transportSnapshot(ctx);
  }
  startTake(ctx: TimecodeCtx) {
    return this.transport.startTake(ctx);
  }
  stopTake(ctx: TimecodeCtx) {
    return this.transport.stopTake(ctx);
  }
  stopTakeWithDuration(input: Parameters<TransportStore['stopTakeWithDuration']>[0]) {
    return this.transport.stopTakeWithDuration(input);
  }
  statusLive(ctx: TimecodeCtx) {
    return this.transport.statusLive(ctx);
  }
```

- [ ] **Step 4: Typecheck + tests**

Run: `npm run typecheck` → no errors.
Run: `npx vitest run` → PASS (8).

- [ ] **Step 5: Commit**

```bash
git add src/durable/transportStore.ts src/durable/SessionDO.ts
git commit -m "refactor(do): extract TransportStore"
```

---

## Task 4: Extract `AudioStore` (+ pure `audioRowToMeta`)

**Files:**
- Create: `src/durable/audioStore.ts`
- Test: `src/durable/audioStore.test.ts`
- Modify: `src/durable/SessionDO.ts`

**Interfaces:**
- Produces: exported `interface AudioSegmentMeta`; exported `function audioRowToMeta(r: Row): AudioSegmentMeta`; `class AudioStore` with `constructor(private core: SessionCore)` and methods `addAudioSegment`, `listAudioSegments`, `deleteAudioSegment`, `getAudioSegmentKey`, `setAudioSegmentWaveform`, `syncAudioFromR2`.
- Consumes: `SessionCore`, `Row` from `./sessionCore`; `isoZ` from `../timecode`.

- [ ] **Step 1: Write the failing test for `audioRowToMeta`**

Create `src/durable/audioStore.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { audioRowToMeta } from './audioStore';

describe('audioRowToMeta', () => {
  it('maps a full segment row incl. parsed waveform peaks', () => {
    const r = {
      id: 's1',
      ordinal: 3,
      started_at_utc: '2026-06-25T00:00:00.000Z',
      ended_at_utc: '2026-06-25T00:00:05.000Z',
      mime_type: 'audio/webm',
      r2_key: 'audio/sess/0003_s1.webm',
      recording_ordinal: 2,
      waveform_peaks_json: '[0.1,0.2,0.3]',
      waveform_db_floor: -48,
    };
    expect(audioRowToMeta(r)).toEqual({
      id: 's1',
      ordinal: 3,
      started_at_utc: '2026-06-25T00:00:00.000Z',
      ended_at_utc: '2026-06-25T00:00:05.000Z',
      mime_type: 'audio/webm',
      r2_key: 'audio/sess/0003_s1.webm',
      recording_ordinal: 2,
      waveform_peaks: [0.1, 0.2, 0.3],
      waveform_db_floor: -48,
    });
  });

  it('nulls peaks on bad JSON and nulls absent recording_ordinal/floor', () => {
    const r = {
      id: 's2',
      ordinal: 1,
      started_at_utc: null,
      ended_at_utc: null,
      mime_type: 'audio/ogg',
      r2_key: 'audio/sess/0001_s2.ogg',
      recording_ordinal: null,
      waveform_peaks_json: 'not json',
      waveform_db_floor: null,
    };
    expect(audioRowToMeta(r)).toEqual({
      id: 's2',
      ordinal: 1,
      started_at_utc: null,
      ended_at_utc: null,
      mime_type: 'audio/ogg',
      r2_key: 'audio/sess/0001_s2.ogg',
      recording_ordinal: null,
      waveform_peaks: null,
      waveform_db_floor: null,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/durable/audioStore.test.ts`
Expected: FAIL — cannot resolve `./audioStore`.

- [ ] **Step 3: Create `src/durable/audioStore.ts`**

```ts
// Audio-segment metadata domain — rows in session_audio_segments; the audio
// bytes themselves live in R2 (the Worker owns the binding). Moved verbatim out
// of SessionDO.ts.

import { isoZ } from '../timecode';
import type { SessionCore, Row } from './sessionCore';

export interface AudioSegmentMeta {
  id: string;
  ordinal: number;
  started_at_utc: string | null;
  ended_at_utc: string | null;
  mime_type: string;
  r2_key: string;
  recording_ordinal: number | null;
  waveform_peaks: number[] | null;
  waveform_db_floor: number | null;
}

/** audioRowToMeta — pure segment-row → meta mapper (was SessionDO.audioRowToMeta, 664–688). */
export function audioRowToMeta(r: Row): AudioSegmentMeta {
  // ... move verbatim from SessionDO.ts lines 664–688 (body only) ...
}

export class AudioStore {
  constructor(private core: SessionCore) {}

  // Move verbatim from SessionDO.ts, THEN apply Step 4 rewrites:
  //   addAudioSegment        (610–657)
  //   listAudioSegments      (659–662)
  //   deleteAudioSegment     (690–692)
  //   getAudioSegmentKey     (694–700)
  //   setAudioSegmentWaveform(702–712)
  //   syncAudioFromR2        (715–751)
}
```
Move the `audioRowToMeta` body (lines 664–688) into the exported function (it takes `r: Row`, references no `this`). Move the six methods into the class.

- [ ] **Step 4: Apply the cross-store rewrites inside the moved methods**

- `this.db` → `this.core.db`
- `this.first(` → `this.core.first(`
- `this.all(` → `this.core.all(`
- `this.broadcast(` → `this.core.broadcast(`
- `this.audioRowToMeta(` → `audioRowToMeta(` (module function)

(`addAudioSegment`/`syncAudioFromR2` use `isoZ`; `listAudioSegments` maps via `audioRowToMeta`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/durable/audioStore.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Update `src/durable/SessionDO.ts`**

1. `import { AudioStore } from './audioStore';`
2. DELETE the moved code: `addAudioSegment` (610–657), `listAudioSegments` (659–662), private `audioRowToMeta` (664–688), `deleteAudioSegment` (690–692), `getAudioSegmentKey` (694–700), `setAudioSegmentWaveform` (702–712), `syncAudioFromR2` (715–751), and the bottom `interface AudioSegmentMeta` (915–925).
3. Re-export the type for any external importers: add near the other re-exports:
```ts
export type { AudioSegmentMeta } from './audioStore';
```
4. Add field + construct (after `this.transport`):
```ts
  private audio!: AudioStore;
```
```ts
    this.audio = new AudioStore(this.core);
```
5. Add delegates:
```ts
  // --- audio delegates ---
  addAudioSegment(input: Parameters<AudioStore['addAudioSegment']>[0]) {
    return this.audio.addAudioSegment(input);
  }
  listAudioSegments() {
    return this.audio.listAudioSegments();
  }
  deleteAudioSegment(segmentId: string) {
    return this.audio.deleteAudioSegment(segmentId);
  }
  getAudioSegmentKey(segmentId: string) {
    return this.audio.getAudioSegmentKey(segmentId);
  }
  setAudioSegmentWaveform(input: Parameters<AudioStore['setAudioSegmentWaveform']>[0]) {
    return this.audio.setAudioSegmentWaveform(input);
  }
  syncAudioFromR2(known: Parameters<AudioStore['syncAudioFromR2']>[0]) {
    return this.audio.syncAudioFromR2(known);
  }
```

- [ ] **Step 7: Typecheck + tests**

Run: `npm run typecheck` → no errors.
Run: `npx vitest run` → PASS (10).

- [ ] **Step 8: Commit**

```bash
git add src/durable/audioStore.ts src/durable/audioStore.test.ts src/durable/SessionDO.ts
git commit -m "refactor(do): extract AudioStore + pure audioRowToMeta"
```

---

## Task 5: Extract `LeaseStore` (+ wire `alarm`)

The recording lease lives in `meta` and auto-expires via the DO alarm. The `alarm()` hook stays on `SessionDO` and delegates to `LeaseStore.expireIfStale()`. No pure mapper.

**Files:**
- Create: `src/durable/leaseStore.ts`
- Modify: `src/durable/SessionDO.ts`

**Interfaces:**
- Produces: `class LeaseStore` with `constructor(private core: SessionCore)` and methods `claimLease(clientId: string): boolean`, `heartbeatLease(clientId: string): boolean`, `releaseLease(clientId: string): void`, `leaseStatus(): { holder_client_id: string | null; lease_alive: boolean; lease_age_sec: number | null }`, `expireIfStale(): void` (the former `alarm` body). Holds `static readonly LEASE_STALE_MS = 40_000`.
- Consumes: `SessionCore` from `./sessionCore`.

- [ ] **Step 1: Create `src/durable/leaseStore.ts`**

```ts
// Recording-lease domain — a single-holder lease in the meta table with
// heartbeat + alarm-driven staleness expiry. Moved verbatim out of SessionDO.ts.

import type { SessionCore } from './sessionCore';

export class LeaseStore {
  // Heartbeats older than this free the lease (AUDIO_RECORDING_LEASE_STALE_SEC).
  static readonly LEASE_STALE_MS = 40_000;

  constructor(private core: SessionCore) {}

  // Move verbatim from SessionDO.ts, THEN apply Step 2 rewrites:
  //   claimLease     (546–560)
  //   heartbeatLease (562–570)
  //   releaseLease   (572–579)
  //   leaseStatus    (581–595)

  /** The former SessionDO.alarm body (597–606): free the lease if its heartbeat went stale. */
  expireIfStale(): void {
    // ... move verbatim from SessionDO.ts lines 598–605 (the body of alarm),
    //     applying the Step 2 rewrites ...
  }
}
```

- [ ] **Step 2: Apply the rewrites inside the moved bodies**

- `this.metaGet(` → `this.core.metaGet(`
- `this.metaSet(` → `this.core.metaSet(`
- `this.metaDelete(` → `this.core.metaDelete(`
- `this.broadcast(` → `this.core.broadcast(`
- `void this.ctx.storage.setAlarm(now + SessionDO.LEASE_STALE_MS)` → `this.core.setAlarm(now + LeaseStore.LEASE_STALE_MS)`
- every other `SessionDO.LEASE_STALE_MS` → `LeaseStore.LEASE_STALE_MS`

(`expireIfStale` is the body of the old `alarm()`: read `lease_holder`; if null return; if `Date.now() - lease_seen_ms >= LeaseStore.LEASE_STALE_MS`, `metaDelete` both keys and `broadcast({ type: 'lease.changed' })`.)

- [ ] **Step 3: Update `src/durable/SessionDO.ts`**

1. `import { LeaseStore } from './leaseStore';`
2. DELETE: the `private static readonly LEASE_STALE_MS = 40_000;` field (line 124), the four lease methods (`claimLease` 546–560, `heartbeatLease` 562–570, `releaseLease` 572–579, `leaseStatus` 581–595), and the whole `alarm()` override body (597–606).
3. Add field + construct (after `this.audio`):
```ts
  private lease!: LeaseStore;
```
```ts
    this.lease = new LeaseStore(this.core);
```
4. Re-add `alarm` as a thin override delegating to the store:
```ts
  override async alarm(): Promise<void> {
    this.lease.expireIfStale();
  }
```
5. Add lease delegates:
```ts
  // --- lease delegates ---
  claimLease(clientId: string) {
    return this.lease.claimLease(clientId);
  }
  heartbeatLease(clientId: string) {
    return this.lease.heartbeatLease(clientId);
  }
  releaseLease(clientId: string) {
    return this.lease.releaseLease(clientId);
  }
  leaseStatus() {
    return this.lease.leaseStatus();
  }
```

- [ ] **Step 4: Typecheck + tests**

Run: `npm run typecheck` → no errors.
Run: `npx vitest run` → PASS (10).

- [ ] **Step 5: Commit**

```bash
git add src/durable/leaseStore.ts src/durable/SessionDO.ts
git commit -m "refactor(do): extract LeaseStore + delegate alarm expiry"
```

---

## Task 6: Extract `TranscriptStore` (+ pure `wordRow`)

**Files:**
- Create: `src/durable/transcriptStore.ts`
- Test: `src/durable/transcriptStore.test.ts`
- Modify: `src/durable/SessionDO.ts`

**Interfaces:**
- Produces: exported `interface TranscriptWord`; exported `function wordRow(r: Row): TranscriptWord`; `class TranscriptStore` with `constructor(private core: SessionCore)` and methods `listTranscriptWords`, `insertTranscriptWord`, `updateTranscriptWord`, `deleteTranscriptWord`.
- Consumes: `SessionCore`, `Row` from `./sessionCore`; `isoZ` from `../timecode`.

- [ ] **Step 1: Write the failing test for `wordRow`**

Create `src/durable/transcriptStore.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { wordRow } from './transcriptStore';

describe('wordRow', () => {
  it('maps a full transcript-word row', () => {
    const r = {
      id: 'w1',
      session_time: '00:00:01',
      speaker: 'A',
      word: 'hello',
      start_sec: 1.5,
      end_sec: 2,
      ordinal: 4,
      created_at_utc: '2026-06-25T00:00:00.000Z',
    };
    expect(wordRow(r)).toEqual({
      id: 'w1',
      session_time: '00:00:01',
      speaker: 'A',
      word: 'hello',
      start_sec: 1.5,
      end_sec: 2,
      ordinal: 4,
      created_at_utc: '2026-06-25T00:00:00.000Z',
    });
  });

  it('applies defaults for missing fields', () => {
    expect(wordRow({ id: 'w2', ordinal: 0 })).toEqual({
      id: 'w2',
      session_time: '',
      speaker: '',
      word: '',
      start_sec: 0,
      end_sec: 0,
      ordinal: 0,
      created_at_utc: '',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/durable/transcriptStore.test.ts`
Expected: FAIL — cannot resolve `./transcriptStore`.

- [ ] **Step 3: Create `src/durable/transcriptStore.ts`**

```ts
// Transcript-words domain — manual CRUD over session_transcript_words
// (generation is stubbed in the router). Moved verbatim out of SessionDO.ts.

import { isoZ } from '../timecode';
import type { SessionCore, Row } from './sessionCore';

export interface TranscriptWord {
  id: string;
  session_time: string;
  speaker: string;
  word: string;
  start_sec: number;
  end_sec: number;
  ordinal: number;
  created_at_utc: string;
}

/** wordRow — pure row → TranscriptWord mapper (was the module fn at 890–901). */
export function wordRow(r: Row): TranscriptWord {
  // ... move verbatim from SessionDO.ts lines 891–900 (body) ...
}

export class TranscriptStore {
  constructor(private core: SessionCore) {}

  // Move verbatim from SessionDO.ts, THEN apply Step 4 rewrites:
  //   listTranscriptWords   (755–757)
  //   insertTranscriptWord  (759–780)
  //   updateTranscriptWord  (782–806)
  //   deleteTranscriptWord  (808–811)
}
```
Move the `wordRow` body (891–900) into the exported function and the four methods into the class.

- [ ] **Step 4: Apply the rewrites inside the moved methods**

- `this.db` → `this.core.db`
- `this.first(` → `this.core.first(`
- `this.all(` → `this.core.all(`
- `wordRow(` calls stay as-is (now the module function in this file)

(`insertTranscriptWord` uses `isoZ`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/durable/transcriptStore.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Update `src/durable/SessionDO.ts`**

1. `import { TranscriptStore } from './transcriptStore';`
2. DELETE: the four transcript methods (755–811), the bottom `interface TranscriptWord` (869–878), and the module `function wordRow` (890–901).
3. Re-export the type:
```ts
export type { TranscriptWord } from './transcriptStore';
```
4. Add field + construct (after `this.lease`):
```ts
  private transcript!: TranscriptStore;
```
```ts
    this.transcript = new TranscriptStore(this.core);
```
5. Add delegates:
```ts
  // --- transcript delegates ---
  listTranscriptWords() {
    return this.transcript.listTranscriptWords();
  }
  insertTranscriptWord(data: Parameters<TranscriptStore['insertTranscriptWord']>[0]) {
    return this.transcript.insertTranscriptWord(data);
  }
  updateTranscriptWord(
    wordId: string,
    patch: Parameters<TranscriptStore['updateTranscriptWord']>[1],
  ) {
    return this.transcript.updateTranscriptWord(wordId, patch);
  }
  deleteTranscriptWord(wordId: string) {
    return this.transcript.deleteTranscriptWord(wordId);
  }
```

- [ ] **Step 7: Typecheck + tests**

Run: `npm run typecheck` → no errors.
Run: `npx vitest run` → PASS (12).

- [ ] **Step 8: Commit**

```bash
git add src/durable/transcriptStore.ts src/durable/transcriptStore.test.ts src/durable/SessionDO.ts
git commit -m "refactor(do): extract TranscriptStore + pure wordRow"
```

---

## Task 7: Extract `TopicStore` (+ pure `topicRow`)

**Files:**
- Create: `src/durable/topicStore.ts`
- Test: `src/durable/topicStore.test.ts`
- Modify: `src/durable/SessionDO.ts`

**Interfaces:**
- Produces: exported `interface Topic`; exported `function topicRow(r: Row): Topic`; `class TopicStore` with `constructor(private core: SessionCore)` and methods `listTopics`, `insertTopic`, `updateTopic`, `deleteTopic`.
- Consumes: `SessionCore`, `Row` from `./sessionCore`; `isoZ` from `../timecode`.

- [ ] **Step 1: Write the failing test for `topicRow`**

Create `src/durable/topicStore.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { topicRow } from './topicStore';

describe('topicRow', () => {
  it('maps a full topic row', () => {
    const r = {
      id: 't1',
      session_time: '00:01:00',
      duration_sec: 30,
      topic_level: 2,
      summary: 'intro',
      ordinal: 1,
      created_at_utc: '2026-06-25T00:00:00.000Z',
    };
    expect(topicRow(r)).toEqual({
      id: 't1',
      session_time: '00:01:00',
      duration_sec: 30,
      topic_level: 2,
      summary: 'intro',
      ordinal: 1,
      created_at_utc: '2026-06-25T00:00:00.000Z',
    });
  });

  it('applies defaults for missing fields (topic_level defaults to 1)', () => {
    expect(topicRow({ id: 't2', ordinal: 0 })).toEqual({
      id: 't2',
      session_time: '',
      duration_sec: 0,
      topic_level: 1,
      summary: '',
      ordinal: 0,
      created_at_utc: '',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/durable/topicStore.test.ts`
Expected: FAIL — cannot resolve `./topicStore`.

- [ ] **Step 3: Create `src/durable/topicStore.ts`**

```ts
// Topics domain — manual CRUD over session_topics. Moved verbatim out of
// SessionDO.ts.

import { isoZ } from '../timecode';
import type { SessionCore, Row } from './sessionCore';

export interface Topic {
  id: string;
  session_time: string;
  duration_sec: number;
  topic_level: number;
  summary: string;
  ordinal: number;
  created_at_utc: string;
}

/** topicRow — pure row → Topic mapper (was the module fn at 903–913). */
export function topicRow(r: Row): Topic {
  // ... move verbatim from SessionDO.ts lines 904–912 (body) ...
}

export class TopicStore {
  constructor(private core: SessionCore) {}

  // Move verbatim from SessionDO.ts, THEN apply Step 4 rewrites:
  //   listTopics   (815–817)
  //   insertTopic  (819–841)
  //   updateTopic  (843–861)
  //   deleteTopic  (863–866)
}
```

- [ ] **Step 4: Apply the rewrites inside the moved methods**

- `this.db` → `this.core.db`
- `this.first(` → `this.core.first(`
- `this.all(` → `this.core.all(`
- `topicRow(` calls stay as-is (module function in this file)

(`insertTopic` uses `isoZ`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/durable/topicStore.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Update `src/durable/SessionDO.ts`**

1. `import { TopicStore } from './topicStore';`
2. DELETE: the four topic methods (815–866), the bottom `interface Topic` (880–888), and the module `function topicRow` (903–913).
3. Re-export the type:
```ts
export type { Topic } from './topicStore';
```
4. Add field + construct (after `this.transcript`):
```ts
  private topics!: TopicStore;
```
```ts
    this.topics = new TopicStore(this.core);
```
5. Add delegates:
```ts
  // --- topic delegates ---
  listTopics() {
    return this.topics.listTopics();
  }
  insertTopic(data: Parameters<TopicStore['insertTopic']>[0]) {
    return this.topics.insertTopic(data);
  }
  updateTopic(topicId: string, patch: Parameters<TopicStore['updateTopic']>[1]) {
    return this.topics.updateTopic(topicId, patch);
  }
  deleteTopic(topicId: string) {
    return this.topics.deleteTopic(topicId);
  }
```

- [ ] **Step 7: Typecheck + tests**

Run: `npm run typecheck` → no errors.
Run: `npx vitest run` → PASS (14).

- [ ] **Step 8: Commit**

```bash
git add src/durable/topicStore.ts src/durable/topicStore.test.ts src/durable/SessionDO.ts
git commit -m "refactor(do): extract TopicStore + pure topicRow"
```

---

## Task 8: Finalize `SessionDO` — trim shim, verify, version bump

`SessionDO` is now framework hooks + flat delegates. Remove the now-dead substrate shim, do the full verification (incl. the live-worker smoke that substitutes for the infeasible in-process DO test), and bump the version.

**Files:**
- Modify: `src/durable/SessionDO.ts`
- Modify: `package.json`

- [ ] **Step 1: Remove the now-unused private substrate delegates**

After Tasks 2–7, nothing in `SessionDO` calls the Task-1 substrate shim anymore (every domain method that used `this.db`/`this.first`/etc. has moved out). DELETE these private members added in Task 1 Step 2.5: `get db`, `all`, `first`, `transportRow`, `bumpRevision`, `revision`, `projection`, `broadcast`, `metaGet`, `metaSet`, `metaDelete`. `tsc`'s `noUnusedLocals` does not flag unused methods, so confirm by inspection that no `this.<name>(` reference to them remains (grep), then remove.

Run: `grep -nE "this\.(db|all|first|transportRow|bumpRevision|revision|projection|broadcast|metaGet|metaSet|metaDelete)\b" src/durable/SessionDO.ts`
Expected: no matches (if any remain, that method still belongs inline — investigate before deleting).

- [ ] **Step 2: Confirm the final `SessionDO` shape**

Open `src/durable/SessionDO.ts` and verify the class body contains ONLY:
- field declarations `private core!: SessionCore; private events!: EventStore; ...` (all six stores)
- the `constructor` (super + build core + `initSchema` + build six stores)
- the framework hooks: `fetch`, `webSocketMessage` (→ `this.core.broadcastCommand`), `webSocketClose`, `webSocketError`, `alarm` (→ `this.lease.expireIfStale()`)
- `ensure()` (→ `this.core.projection()`), `presence()` (→ `this.core.presence()`), `broadcastCommand()` (→ `this.core.broadcastCommand()`)
- the flat RPC delegates for events/transport/audio/lease/transcript/topics

No SQL, no business logic, no domain method bodies remain. Update the top-of-file comment to:
```ts
// SessionDO — one Durable Object per session. Thin framework shell: holds the
// lifecycle hooks (fetch/webSocket*/alarm) and a flat RPC surface that delegates
// to the domain stores (event/transport/audio/lease/transcript/topic) over a
// shared SessionCore. The single-writer invariant is unchanged — one DO instance,
// one ctx.storage.sql. Type re-exports keep the Worker's importers stable.
```

- [ ] **Step 3: Full typecheck + unit tests**

Run: `npm run typecheck` → no errors.
Run: `npx vitest run` → PASS (14: existing 6 + eventStore 2 + audioStore 2 + transcriptStore 2 + topicStore 2).

- [ ] **Step 4: Live-worker smoke (substitutes for the infeasible in-process DO surface test)**

Apply migrations and boot the worker:
```bash
npm run migrate:local
npm run dev   # serves http://127.0.0.1:8787 ; stop with: pkill -f "wrangler dev"
```
Then exercise the DO-backed surface (a session id from `GET /api/sessions`, or create one):
```bash
B=http://127.0.0.1:8787
SID=$(curl -s -X POST "$B/api/sessions" -H 'content-type: application/json' \
  -d '{"show_id":"show-autolog-test","episode":"9","frame_rate":24,"start_offset_frames":0}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
curl -s -o /dev/null -w "status %{http_code}\n"   "$B/api/sessions/$SID/status"
curl -s -o /dev/null -w "events %{http_code}\n"   "$B/api/sessions/$SID/events"
curl -s -o /dev/null -w "transport %{http_code}\n" -X POST "$B/api/sessions/$SID/transport/start"
curl -s -o /dev/null -w "audio %{http_code}\n"    "$B/api/sessions/$SID/audio/segments"
curl -s -o /dev/null -w "words %{http_code}\n"    "$B/api/sessions/$SID/transcript/words"
curl -s -o /dev/null -w "topics %{http_code}\n"   "$B/api/sessions/$SID/topics"
curl -s -o /dev/null -w "delete %{http_code}\n" -X DELETE "$B/api/sessions/$SID"
```
Expected: every line `200` (the exact transcript/topics/event sub-paths may differ — confirm the registered routes in the routers if a 404 appears; a 404 from a *wrong test URL* is fine, a 500 is not). Scan the dev log for errors:
```bash
grep -iE "error|exception|TypeError" /tmp/wrangler-dev.log || echo "(no errors)"
```
Then stop the worker (`pkill -f "wrangler dev"`).

- [ ] **Step 5: Bump the worker version**

In `package.json`, bump `"version"` from `"0.2.0"` to `"0.3.0"`.

- [ ] **Step 6: Commit**

```bash
git add src/durable/SessionDO.ts package.json
git commit -m "refactor(do): finalize SessionDO shell; trim substrate shim; bump to 0.3.0"
```

---

## Final state checklist

- `src/durable/SessionDO.ts` is a thin framework shell (hooks + flat delegates + type re-exports); no SQL/business logic remains.
- `sessionCore.ts` + six store files each own one concern; the four pure mappers are exported and unit-tested.
- `new Catalog`-style invariants hold: `getSessionDO(c, id)` still returns `DurableObjectStub<SessionDO>` with the same surface; no router/middleware/types/wrangler edits; the DO class name + binding unchanged.
- `npm run typecheck` passes; `npx vitest run` passes (14 tests).
- Live-worker smoke: session status/events/transport/audio/transcript/topics all succeed.
- `package.json` version bumped to `0.3.0`.
