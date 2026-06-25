# SessionDO Lease/Alarm Correctness + Resource Caps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure a crashed recording-lease holder is always reaped, document the single-alarm-slot invariant, cap audio-upload and event-metadata sizes, and add regression tests for the two previously-untested Durable Object stores.

**Architecture:** Five independent tasks against the `autologger-cf` Worker. The lease fix is one method change in `leaseStore.ts` plus two documentation comments; the caps are a pure guard in the audio router and a Zod `.refine` in the schemas; tests use lightweight in-memory fakes of `SessionCore` (no Miniflare/Workers harness — matching the existing pure-unit-test style).

**Tech Stack:** TypeScript (strict), Cloudflare Workers / Durable Objects, Hono, Zod, Vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-25-sessiondo-lease-alarm-and-caps-design.md`. Excludes audit themes A (multi-tenant access control), D (timecode semantics), E (data integrity) and all LOW/NITPICK items.
- **Branch:** `fix/sessiondo-lease-alarm-caps` (already checked out).
- **No new dependencies.** Use only `hono`, `jose`, `zod`, `vitest` (already in `package.json`).
- **Test runner:** `npm run test` (= `vitest run`). Single file: `npx vitest run <path>`.
- **Type check:** `npm run typecheck` (= `tsc --noEmit`) must stay clean (strict mode; no `Optional`, use `X | null`).
- **Caps (exact values):** `MAX_AUDIO_BYTES = 50 * 1024 * 1024` (50 MB); `MAX_METADATA_BYTES = 8000` (matches the existing `message` length cap).
- **Lease constant:** `LeaseStore.LEASE_STALE_MS = 40_000` (unchanged).
- **Spec correction:** the spec mentions adding the metadata cap to "both the log and event-update schemas." `eventUpdateBodySchema` has **no** `metadata` field — only `logBodySchema` does. The cap applies to `logBodySchema` only.
- **Commit style:** Conventional Commits, matching repo history (`fix(do):`, `test(do):`, `feat(audio):`, `chore(release):`).

---

### Task 1: Lease re-arm + numeric hardening + alarm-slot invariant docs

Fixes the core bug: `expireIfStale()` drops the alarm timer when the lease is still alive, so an early-firing alarm leaves a later-dying holder un-reaped. Also hardens `Number(...)` coercions and documents the single-alarm-slot constraint. Tests are written first (TDD) and include the regression guard.

**Files:**
- Create: `src/durable/leaseStore.test.ts`
- Modify: `src/durable/leaseStore.ts` (whole file rewrite below)
- Modify: `src/durable/SessionDO.ts:150-152` (comment on `alarm()`)
- Modify: `src/durable/sessionCore.ts:201-204` (comment on `setAlarm()`)

**Interfaces:**
- Consumes: `SessionCore` methods used by `LeaseStore` — `metaGet(key: string): string | null`, `metaSet(key, value): void`, `metaDelete(key): void`, `setAlarm(atMs: number): void`, `broadcast(msg: Record<string, unknown>): void`. `Date.now()` is the clock (mockable via vitest fake timers).
- Produces: unchanged public surface — `claimLease(clientId): boolean`, `heartbeatLease(clientId): boolean`, `releaseLease(clientId): void`, `leaseStatus(): {...}`, `expireIfStale(): void`. New private `finiteMs(key): number`.

- [ ] **Step 1: Write the failing test file**

Create `src/durable/leaseStore.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeaseStore } from './leaseStore';
import type { SessionCore } from './sessionCore';

function fakeCore() {
  const meta = new Map<string, string>();
  const alarms: number[] = [];
  const broadcasts: unknown[] = [];
  const core = {
    metaGet: (k: string): string | null => (meta.has(k) ? (meta.get(k) as string) : null),
    metaSet: (k: string, v: string): void => void meta.set(k, v),
    metaDelete: (k: string): void => void meta.delete(k),
    setAlarm: (atMs: number): void => void alarms.push(atMs),
    broadcast: (m: unknown): void => void broadcasts.push(m),
  };
  return { core: core as unknown as SessionCore, meta, alarms, broadcasts };
}

const STALE = LeaseStore.LEASE_STALE_MS; // 40_000

describe('LeaseStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-25T00:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('claimLease on a free lease sets holder/seen, arms the alarm, broadcasts', () => {
    const { core, meta, alarms, broadcasts } = fakeCore();
    const lease = new LeaseStore(core);
    expect(lease.claimLease('c1')).toBe(true);
    expect(meta.get('lease_holder')).toBe('c1');
    expect(meta.get('lease_seen_ms')).toBe(String(Date.now()));
    expect(alarms).toEqual([Date.now() + STALE]);
    expect(broadcasts).toEqual([{ type: 'lease.changed' }]);
  });

  it('claimLease by a different client while alive returns false and mutates nothing', () => {
    const { core, meta } = fakeCore();
    const lease = new LeaseStore(core);
    lease.claimLease('c1');
    expect(lease.claimLease('c2')).toBe(false);
    expect(meta.get('lease_holder')).toBe('c1');
  });

  it('claimLease steals the lease once it is stale', () => {
    const { core, meta } = fakeCore();
    const lease = new LeaseStore(core);
    lease.claimLease('c1');
    vi.advanceTimersByTime(STALE);
    expect(lease.claimLease('c2')).toBe(true);
    expect(meta.get('lease_holder')).toBe('c2');
  });

  it('heartbeatLease re-arms for the holder and rejects a non-holder', () => {
    const { core, alarms } = fakeCore();
    const lease = new LeaseStore(core);
    lease.claimLease('c1');
    alarms.length = 0;
    vi.advanceTimersByTime(10_000);
    expect(lease.heartbeatLease('c1')).toBe(true);
    expect(alarms).toEqual([Date.now() + STALE]);
    expect(lease.heartbeatLease('c2')).toBe(false);
  });

  it('releaseLease clears + broadcasts for the holder, no-ops for others', () => {
    const { core, meta, broadcasts } = fakeCore();
    const lease = new LeaseStore(core);
    lease.claimLease('c1');
    broadcasts.length = 0;
    lease.releaseLease('c2');
    expect(meta.has('lease_holder')).toBe(true);
    lease.releaseLease('c1');
    expect(meta.has('lease_holder')).toBe(false);
    expect(broadcasts).toEqual([{ type: 'lease.changed' }]);
  });

  it('expireIfStale frees a stale lease and does NOT re-arm', () => {
    const { core, meta, alarms, broadcasts } = fakeCore();
    const lease = new LeaseStore(core);
    lease.claimLease('c1');
    alarms.length = 0;
    broadcasts.length = 0;
    vi.advanceTimersByTime(STALE);
    lease.expireIfStale();
    expect(meta.has('lease_holder')).toBe(false);
    expect(broadcasts).toEqual([{ type: 'lease.changed' }]);
    expect(alarms).toEqual([]);
  });

  // Regression guard for the core fix:
  it('expireIfStale re-arms (does NOT free) when the lease is still alive', () => {
    const { core, meta, alarms, broadcasts } = fakeCore();
    const lease = new LeaseStore(core);
    lease.claimLease('c1');
    const seen = Number(meta.get('lease_seen_ms'));
    alarms.length = 0;
    broadcasts.length = 0;
    vi.advanceTimersByTime(10_000); // still < STALE
    lease.expireIfStale();
    expect(meta.get('lease_holder')).toBe('c1');
    expect(broadcasts).toEqual([]);
    expect(alarms).toEqual([seen + STALE]);
  });

  it('treats a non-numeric lease_seen_ms as 0 (stale), not NaN (alive forever)', () => {
    const { core, meta } = fakeCore();
    const lease = new LeaseStore(core);
    meta.set('lease_holder', 'c1');
    meta.set('lease_seen_ms', 'x');
    lease.expireIfStale();
    expect(meta.has('lease_holder')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify the two new-behavior cases fail**

Run: `npx vitest run src/durable/leaseStore.test.ts`
Expected: FAIL — "expireIfStale re-arms ... when still alive" fails (current code returns without calling `setAlarm`, so `alarms` is `[]`), and "treats a non-numeric lease_seen_ms as 0" fails (current `Number(metaGet ?? 0)` yields `NaN` for `'x'`, so the lease is not freed). The other six cases pass.

- [ ] **Step 3: Rewrite `leaseStore.ts` with `finiteMs` + re-arm**

Replace the entire contents of `src/durable/leaseStore.ts`:

```ts
// Recording-lease domain — a single-holder lease in the meta table with
// heartbeat + alarm-driven staleness expiry. Moved verbatim out of SessionDO.ts.

import type { SessionCore } from './sessionCore';

export class LeaseStore {
  // Heartbeats older than this free the recording lease (AUDIO_RECORDING_LEASE_STALE_SEC).
  static readonly LEASE_STALE_MS = 40_000;

  constructor(private core: SessionCore) {}

  // A missing or non-numeric meta value coerces to 0 (→ treated as stale),
  // never NaN — a NaN comparison would make a stale lease look alive forever.
  private finiteMs(key: string): number {
    const n = Number(this.core.metaGet(key));
    return Number.isFinite(n) ? n : 0;
  }

  claimLease(clientId: string): boolean {
    const cid = clientId.trim();
    if (!cid) return false;
    const now = Date.now();
    const holder = this.core.metaGet('lease_holder');
    const seen = this.finiteMs('lease_seen_ms');
    if (holder === null || holder === cid || now - seen >= LeaseStore.LEASE_STALE_MS) {
      this.core.metaSet('lease_holder', cid);
      this.core.metaSet('lease_seen_ms', String(now));
      this.core.setAlarm(now + LeaseStore.LEASE_STALE_MS);
      this.core.broadcast({ type: 'lease.changed' });
      return true;
    }
    return false;
  }

  heartbeatLease(clientId: string): boolean {
    const cid = clientId.trim();
    if (!cid) return false;
    if (this.core.metaGet('lease_holder') !== cid) return false;
    const now = Date.now();
    this.core.metaSet('lease_seen_ms', String(now));
    this.core.setAlarm(now + LeaseStore.LEASE_STALE_MS);
    return true;
  }

  releaseLease(clientId: string): void {
    const cid = clientId.trim();
    if (!cid) return;
    if (this.core.metaGet('lease_holder') !== cid) return;
    this.core.metaDelete('lease_holder');
    this.core.metaDelete('lease_seen_ms');
    this.core.broadcast({ type: 'lease.changed' });
  }

  leaseStatus(): {
    holder_client_id: string | null;
    lease_alive: boolean;
    lease_age_sec: number | null;
  } {
    const holder = this.core.metaGet('lease_holder');
    if (holder === null) return { holder_client_id: null, lease_alive: false, lease_age_sec: null };
    const seen = this.finiteMs('lease_seen_ms');
    const age = Math.max(0, (Date.now() - seen) / 1000);
    return {
      holder_client_id: holder,
      lease_alive: age < LeaseStore.LEASE_STALE_MS / 1000,
      lease_age_sec: age,
    };
  }

  /** The former SessionDO.alarm body: free the lease if its heartbeat went
   * stale, otherwise re-arm the alarm so a later death is still reaped. The DO
   * has a single alarm slot fired once — never return without re-scheduling
   * while a holder is still alive, or an early-firing alarm leaks the lease. */
  expireIfStale(): void {
    const holder = this.core.metaGet('lease_holder');
    if (holder === null) return;
    const seen = this.finiteMs('lease_seen_ms');
    if (Date.now() - seen >= LeaseStore.LEASE_STALE_MS) {
      this.core.metaDelete('lease_holder');
      this.core.metaDelete('lease_seen_ms');
      this.core.broadcast({ type: 'lease.changed' });
    } else {
      this.core.setAlarm(seen + LeaseStore.LEASE_STALE_MS);
    }
  }
}
```

- [ ] **Step 4: Add the single-alarm-slot invariant comment in `SessionDO.ts`**

In `src/durable/SessionDO.ts`, replace the `alarm()` method (currently at lines 150-152):

```ts
  // Single alarm reconciliation point. The DO has exactly one alarm slot, fired
  // once; today the recording lease is the sole consumer. Any future scheduled
  // timer MUST route through here (and re-arm to the earliest pending wake) —
  // never call ctx.storage.setAlarm independently, or it clobbers lease expiry.
  override async alarm(): Promise<void> {
    this.lease.expireIfStale();
  }
```

- [ ] **Step 5: Add the replace-semantics note on `sessionCore.setAlarm()`**

In `src/durable/sessionCore.ts`, replace the `setAlarm` method (currently at lines 201-204):

```ts
  /** Wraps ctx.storage.setAlarm so lease logic never touches ctx directly.
   * NOTE: setAlarm REPLACES any pending alarm (one slot per DO). The recording
   * lease is the sole consumer today; a second consumer must coordinate through
   * SessionDO.alarm() rather than calling this independently. */
  setAlarm(atMs: number): void {
    void this.ctx.storage.setAlarm(atMs);
  }
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/durable/leaseStore.test.ts && npm run typecheck`
Expected: all 8 lease tests PASS; `tsc --noEmit` reports no errors.

- [ ] **Step 7: Commit**

```bash
git add src/durable/leaseStore.ts src/durable/leaseStore.test.ts src/durable/SessionDO.ts src/durable/sessionCore.ts
git commit -m "fix(do): re-arm lease alarm when holder still alive; harden coercion + document single-alarm-slot invariant"
```

---

### Task 2: transportStore characterization tests

The other previously-untested store. No production change — these tests lock in current transport behavior (start/stop transitions, elapsed-frame accumulation, status counts) so a future refactor can't silently regress it.

**Files:**
- Create: `src/durable/transportStore.test.ts`

**Interfaces:**
- Consumes: `TransportStore` constructor `(core: SessionCore)`; methods `startTake(ctx)`, `stopTake(ctx)`, `stopTakeWithDuration({durationS, ctx})`, `statusLive(ctx)`. `TimecodeCtx = { frameRate: number; startOffsetFrames: number }`. The store reads `core.transportRow()` (returns `{ is_rolling: boolean; current_take: number; roll_started_at_utc: string | null; elapsed_frames: number }`), writes via `core.db.exec(sql, ...args)`, and calls `core.broadcast`, `core.projection`, `core.first`, `core.revision`.
- Produces: nothing consumed downstream (test-only).

- [ ] **Step 1: Write the characterization test file**

Create `src/durable/transportStore.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionCore, TimecodeCtx } from './sessionCore';
import { TransportStore } from './transportStore';

interface TRow {
  is_rolling: boolean;
  current_take: number;
  roll_started_at_utc: string | null;
  elapsed_frames: number;
}

function fakeCore(initial: Partial<TRow> = {}) {
  const row: TRow = {
    is_rolling: false,
    current_take: 0,
    roll_started_at_utc: null,
    elapsed_frames: 0,
    ...initial,
  };
  const broadcasts: unknown[] = [];
  const core = {
    get db() {
      return {
        exec: (sql: string, ...args: unknown[]): unknown => {
          if (sql.includes('is_rolling = 1')) {
            row.is_rolling = true;
            row.current_take = args[0] as number;
            row.roll_started_at_utc = args[1] as string;
          } else if (sql.includes('is_rolling = 0')) {
            row.is_rolling = false;
            row.roll_started_at_utc = null;
            row.elapsed_frames = args[0] as number;
          }
          return undefined;
        },
      };
    },
    transportRow: (): TRow => ({ ...row }),
    broadcast: (m: unknown): void => void broadcasts.push(m),
    projection: () => ({
      event_count: 0,
      max_timecode_total_frames: null,
      is_rolling: row.is_rolling,
      current_take: row.current_take,
      transport_elapsed_frames: row.elapsed_frames,
      roll_started_at_utc: row.roll_started_at_utc,
    }),
    first: (sql: string): { c: number } => (sql.includes("!= 'internal'") ? { c: 2 } : { c: 3 }),
    revision: (): number => 7,
  };
  return { core: core as unknown as SessionCore, row, broadcasts };
}

const CTX: TimecodeCtx = { frameRate: 30, startOffsetFrames: 0 };

describe('TransportStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-25T00:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('startTake on an idle transport rolls, increments take, broadcasts', () => {
    const { core, row, broadcasts } = fakeCore();
    const store = new TransportStore(core);
    const { state } = store.startTake(CTX);
    expect(state.started).toBe(true);
    expect(row.is_rolling).toBe(true);
    expect(row.current_take).toBe(1);
    expect(broadcasts).toEqual([{ type: 'transport.changed', is_rolling: true, current_take: 1 }]);
  });

  it('startTake while already rolling is a no-op (started=false, take unchanged)', () => {
    const { core, row } = fakeCore({ is_rolling: true, current_take: 4 });
    const store = new TransportStore(core);
    const { state } = store.startTake(CTX);
    expect(state.started).toBe(false);
    expect(row.current_take).toBe(4);
  });

  it('stopTake accumulates elapsed_frames = trunc(seconds * frameRate)', () => {
    const { core, row } = fakeCore({
      is_rolling: true,
      current_take: 1,
      roll_started_at_utc: '2026-06-25T00:00:00.000Z',
      elapsed_frames: 0,
    });
    const store = new TransportStore(core);
    vi.setSystemTime(new Date('2026-06-25T00:00:05.000Z')); // 5s @ 30fps = 150 frames
    const { state } = store.stopTake(CTX);
    expect(state.stopped).toBe(true);
    expect(row.is_rolling).toBe(false);
    expect(row.roll_started_at_utc).toBe(null);
    expect(row.elapsed_frames).toBe(150);
  });

  it('stopTake while idle is a no-op (stopped=false)', () => {
    const { core } = fakeCore({ is_rolling: false });
    const store = new TransportStore(core);
    const { state } = store.stopTake(CTX);
    expect(state.stopped).toBe(false);
  });

  it('stopTakeWithDuration adds trunc(durationS * frameRate) to elapsed_frames', () => {
    const { core, row } = fakeCore({ is_rolling: true, elapsed_frames: 10 });
    const store = new TransportStore(core);
    store.stopTakeWithDuration({ durationS: 2, ctx: CTX }); // 2s @ 30fps = 60
    expect(row.elapsed_frames).toBe(70);
    expect(row.is_rolling).toBe(false);
  });

  it('statusLive reports event counts and revision', () => {
    const { core } = fakeCore({ is_rolling: true, current_take: 3 });
    const store = new TransportStore(core);
    const s = store.statusLive(CTX);
    expect(s.is_rolling).toBe(true);
    expect(s.current_take).toBe(3);
    expect(s.event_count).toBe(3);
    expect(s.logged_event_count).toBe(2);
    expect(s.events_stream_revision).toBe(7);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run src/durable/transportStore.test.ts`
Expected: all 6 PASS against the current `transportStore.ts` (characterization — no production change). If the `stopTake` frame math case fails, the fallback in the spec applies: extract the `trunc((Date.now() - started)/1000 * frameRate)` arithmetic into an exported pure helper and test that directly. Do NOT change transport behavior.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/durable/transportStore.test.ts
git commit -m "test(do): characterization tests for transportStore start/stop/status"
```

---

### Task 3: Audio upload size cap

Bound the request body before and after buffering so a large or lying-`Content-Length` upload cannot exhaust the isolate's 128 MB memory. A pure guard function makes the 413 logic unit-testable without a Workers harness.

**Files:**
- Create: `src/routers/audio.test.ts`
- Modify: `src/routers/audio.ts` (add constant + guard helper; call it in the POST handler at lines 38-63)

**Interfaces:**
- Consumes: `ApiError` from `./_helpers` (constructor `(status: number, detail: string)`).
- Produces: `export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;` and `export function enforceAudioByteLimit(bytes: number | null): void` (throws `ApiError(413, ...)` when `bytes` is a finite number greater than the cap; no-op for `null` or `NaN`).

- [ ] **Step 1: Write the failing test**

Create `src/routers/audio.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ApiError } from './_helpers';
import { MAX_AUDIO_BYTES, enforceAudioByteLimit } from './audio';

describe('enforceAudioByteLimit', () => {
  it('does nothing for null (unknown length)', () => {
    expect(() => enforceAudioByteLimit(null)).not.toThrow();
  });

  it('does nothing at or below the cap', () => {
    expect(() => enforceAudioByteLimit(MAX_AUDIO_BYTES)).not.toThrow();
    expect(() => enforceAudioByteLimit(1024)).not.toThrow();
  });

  it('throws ApiError(413) above the cap', () => {
    try {
      enforceAudioByteLimit(MAX_AUDIO_BYTES + 1);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(413);
    }
  });

  it('does nothing for NaN (garbage Content-Length falls through to the post-read check)', () => {
    expect(() => enforceAudioByteLimit(Number('not-a-number'))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/routers/audio.test.ts`
Expected: FAIL — `MAX_AUDIO_BYTES` / `enforceAudioByteLimit` are not exported from `./audio`.

- [ ] **Step 3: Add the constant + guard and wire it into the handler**

In `src/routers/audio.ts`, add after the `segmentApiDict` function (after line 26):

```ts
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // 50 MB — bound the buffered upload.

/** Reject an over-cap upload with 413. No-op for unknown (null) or NaN sizes;
 * the post-read byteLength check is the backstop when Content-Length is absent. */
export function enforceAudioByteLimit(bytes: number | null): void {
  if (bytes !== null && Number.isFinite(bytes) && bytes > MAX_AUDIO_BYTES) {
    throw new ApiError(413, `Audio payload exceeds the ${MAX_AUDIO_BYTES}-byte limit.`);
  }
}
```

Then in the POST `/audio/segments` handler, change the body-read block (currently lines 40-42) from:

```ts
  await requireSession(c, sessionId);
  const payload = await c.req.arrayBuffer();
  if (payload.byteLength === 0) throw new ApiError(400, 'Audio payload is empty.');
```

to:

```ts
  await requireSession(c, sessionId);
  const declared = c.req.header('content-length');
  enforceAudioByteLimit(declared !== undefined ? Number(declared) : null);
  const payload = await c.req.arrayBuffer();
  if (payload.byteLength === 0) throw new ApiError(400, 'Audio payload is empty.');
  enforceAudioByteLimit(payload.byteLength);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/routers/audio.test.ts && npm run typecheck`
Expected: all 4 PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/routers/audio.ts src/routers/audio.test.ts
git commit -m "feat(audio): cap segment upload at 50MB (413 on over-cap body)"
```

---

### Task 4: Event metadata size cap

Bound the user-supplied `metadata` object on the log endpoint so a client cannot stuff megabytes of arbitrary JSON into Durable Object SQLite per event. Surfaces through the existing Zod → 422 handler.

**Files:**
- Create: `src/schemas.test.ts`
- Modify: `src/schemas.ts:47-52` (`logBodySchema.metadata`; add `MAX_METADATA_BYTES` constant)

**Interfaces:**
- Consumes: `z` from `zod` (already imported).
- Produces: `export const MAX_METADATA_BYTES = 8000;` and an updated `logBodySchema` whose `metadata` rejects values whose `JSON.stringify(...).length` exceeds the cap.

- [ ] **Step 1: Write the failing test**

Create `src/schemas.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MAX_METADATA_BYTES, logBodySchema } from './schemas';

describe('logBodySchema.metadata cap', () => {
  it('accepts a normal small metadata object', () => {
    const r = logBodySchema.safeParse({ category: 'cam', message: 'hi', metadata: { take: 1 } });
    expect(r.success).toBe(true);
  });

  it('defaults metadata to {} when absent', () => {
    const r = logBodySchema.safeParse({ category: 'cam', message: 'hi' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.metadata).toEqual({});
  });

  it('rejects metadata that serializes beyond the cap', () => {
    const big = { blob: 'x'.repeat(MAX_METADATA_BYTES + 100) };
    const r = logBodySchema.safeParse({ category: 'cam', message: 'hi', metadata: big });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/schemas.test.ts`
Expected: FAIL — `MAX_METADATA_BYTES` is not exported, and the over-cap case currently parses successfully.

- [ ] **Step 3: Add the constant + `.refine`**

In `src/schemas.ts`, add the constant just below the `import { z } from 'zod';` line (after line 6):

```ts
export const MAX_METADATA_BYTES = 8000; // matches the message length cap.
```

Then change the `logBodySchema` (currently lines 47-52) from:

```ts
export const logBodySchema = z.object({
  category: z.string().min(1).max(200),
  message: z.string().min(1).max(8000),
  metadata: z.record(z.unknown()).default({}),
  marked_at_utc: z.string().nullish(),
});
```

to:

```ts
export const logBodySchema = z.object({
  category: z.string().min(1).max(200),
  message: z.string().min(1).max(8000),
  metadata: z
    .record(z.unknown())
    .default({})
    .refine((v) => JSON.stringify(v).length <= MAX_METADATA_BYTES, {
      message: `metadata exceeds ${MAX_METADATA_BYTES} serialized bytes`,
    }),
  marked_at_utc: z.string().nullish(),
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/schemas.test.ts && npm run typecheck`
Expected: all 3 PASS; typecheck clean (the inferred `LogBody` type is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/schemas.ts src/schemas.test.ts
git commit -m "feat(events): cap log metadata at 8000 serialized bytes"
```

---

### Task 5: Version bump + full verification

**Files:**
- Modify: `package.json:3` (`"version": "0.3.0"` → `"0.3.1"`)

**Interfaces:** none.

- [ ] **Step 1: Bump the version**

In `package.json`, change line 3 from `"version": "0.3.0",` to `"version": "0.3.1",`.

- [ ] **Step 2: Run the full suite + typecheck**

Run: `npm run test && npm run typecheck`
Expected: the entire vitest suite passes (existing pure-mapper tests plus the four new files: `leaseStore.test.ts`, `transportStore.test.ts`, `audio.test.ts`, `schemas.test.ts`); `tsc --noEmit` reports no errors.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(release): 0.3.1 — lease alarm fix + upload/metadata caps"
```

---

## Self-Review

**Spec coverage:**
- Change 1 (lease re-arm + numeric hardening) → Task 1, steps 1-3.
- Change 2 (single-alarm-slot invariant docs, no reconciler) → Task 1, steps 4-5.
- Change 3 (audio cap) → Task 3; (event metadata cap) → Task 4. *Spec said "log and event-update schemas"; corrected to log-only in Global Constraints — `eventUpdateBodySchema` has no metadata field.*
- Change 4 (leaseStore tests incl. regression guard) → Task 1; (transportStore tests) → Task 2.
- Verification + versioning → Task 5.

**Placeholder scan:** No TBD/TODO/"add error handling"/"similar to Task N" — every code step shows complete code.

**Type consistency:** `enforceAudioByteLimit(bytes: number | null)`, `MAX_AUDIO_BYTES`, `MAX_METADATA_BYTES`, `finiteMs(key): number`, and the `SessionCore`/`TransportStore`/`TimecodeCtx` signatures used in the fakes match the real definitions read from `sessionCore.ts`, `leaseStore.ts`, `transportStore.ts`, and `_helpers.ts`. `ApiError(status, detail)` two-arg constructor matches `_helpers.ts:10-18`.
