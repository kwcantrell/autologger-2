# SessionDO lease/alarm correctness + resource caps — design

**Date:** 2026-06-25
**Status:** Approved (pending spec review)
**Scope:** Bugfix + hardening. No API, schema, or data-model change.

## Background

A graphify-guided audit of the `autologger-cf` Worker (Hono + D1 + KV + R2 + the
`SessionDO` Durable Object) surfaced five themes of findings. The recent
`SessionDO` → store-extraction refactor was verified **faithful** (no revision
bump or broadcast was dropped in the move); the issues below are pre-existing
behaviour carried through unchanged, plus a coverage gap in exactly the two
stores that were the riskiest to extract.

This spec takes forward **two** of the five themes:

- **Theme B — Durable Object lease/alarm correctness** (+ tests for the two
  untested stores).
- **Theme C — resource/abuse caps.**

The following are **explicitly out of scope** for this unit of work and remain
tracked as audit findings for a later pass:

- **Theme A — multi-tenant access control** (companion tenancy scoping, orphan-
  session studio fallback, IP-allowlist fail-open). Real-world severity depends
  on deployment posture (multi-studio + `REQUIRE_LOGIN`), which is a separate
  decision.
- **Theme D — timecode semantics** (drop-frame separator over non-drop-frame
  math; `frame_rate` accepting arbitrary floats). May be a faithful port of the
  Python origin's behaviour; needs an intended-behaviour decision first.
- **Theme E — data integrity** (non-atomic session create / episode bump;
  dead `episode_date` column).
- LOW/NITPICK items (audio ordinal > 9999 regex, `SESSION_DAYS` accepting
  negative/zero, OAuth/Zod error-message leakage).

## Goals

1. A crashed/disconnected recording-lease holder is **always** eventually reaped,
   even if the staleness alarm fires early.
2. The single-alarm-slot assumption is documented so a future second alarm
   consumer cannot silently clobber the lease without noticing.
3. Audio uploads and event metadata cannot exhaust Durable Object / isolate
   resources.
4. The two previously-untested stores (`leaseStore`, `transportStore`) gain
   focused regression tests, including a guard for goal #1.

## Non-goals

- A general-purpose alarm scheduler / timer reconciler (YAGNI: the lease is the
  only alarm consumer today).
- Streaming audio uploads to R2 (the current buffer-then-put flow with metadata
  rollback is retained; only a size bound is added).
- Any change to the wire format of transport/lease/audio/event payloads.

## Changes

### Change 1 — Lease re-arm on a live lease (`src/durable/leaseStore.ts`)

**Problem.** `expireIfStale()` (the body `SessionDO.alarm()` delegates to) frees
the lease when stale, otherwise returns having done nothing — **dropping the
timer**. A Durable Object has exactly one alarm slot, fired once. If that alarm
fires while the holder is still alive (clock skew, or a future second alarm
consumer re-arming the slot earlier), `expireIfStale` returns without scheduling
a new alarm. If the holder then dies, the lease is never reaped and blocks every
other client from claiming the recording lease for the session's lifetime.

**Fix.** When the holder is still alive, re-arm the alarm to `seen + STALE`
instead of returning:

```ts
expireIfStale(): void {
  const holder = this.core.metaGet('lease_holder');
  if (holder === null) return;
  const seen = this.finiteMs('lease_seen_ms');
  if (Date.now() - seen >= LeaseStore.LEASE_STALE_MS) {
    this.core.metaDelete('lease_holder');
    this.core.metaDelete('lease_seen_ms');
    this.core.broadcast({ type: 'lease.changed' });
  } else {
    // Still alive — re-arm so a later death is still reaped; never drop the timer.
    this.core.setAlarm(seen + LeaseStore.LEASE_STALE_MS);
  }
}
```

This makes the alarm self-perpetuating until the lease is genuinely free.

**Numeric hardening.** Replace the three `Number(this.core.metaGet(key) ?? 0)`
sites (`claimLease`, `leaseStatus`, `expireIfStale`) with a small helper that
coerces a missing/non-finite value to `0`:

```ts
private finiteMs(key: string): number {
  const n = Number(this.core.metaGet(key));
  return Number.isFinite(n) ? n : 0;
}
```

(`Number(null)` is `0` and `Number('')` is `0`, but `Number('x')` is `NaN`, and a
`NaN` comparison silently makes a stale lease look alive forever. Defensive, but
cheap and removes the foot-gun.)

### Change 2 — Document the single-alarm-slot invariant

No reconciler is built. Add a one-line comment at the two seams so the
constraint is visible to whoever adds a second timer:

- `src/durable/SessionDO.ts` `alarm()` — note this is the single alarm
  reconciliation point; any new scheduled timer must route through here and
  re-arm to the earliest pending wake, not call `setAlarm` directly.
- `src/durable/sessionCore.ts` `setAlarm()` — note that `ctx.storage.setAlarm`
  *replaces* any pending alarm; today the recording lease is the sole consumer.

### Change 3 — Resource caps (Theme C)

**Audio upload** — `src/routers/audio.ts`, POST `/audio/segments`:

- Introduce `const MAX_AUDIO_BYTES = 50 * 1024 * 1024;` (50 MB).
- Before reading the body, if `Content-Length` is present and exceeds the cap,
  throw `ApiError(413, ...)` early (avoids buffering the body at all).
- After `await c.req.arrayBuffer()`, if `payload.byteLength > MAX_AUDIO_BYTES`,
  throw `ApiError(413, ...)` (the header can be absent or lie).
- The existing empty-check and R2-rollback flow are unchanged.

**Event metadata** — `src/schemas.ts`:

- Introduce `const MAX_METADATA_BYTES = 8000;` (matches the existing `message`
  length cap).
- Add a `.refine` to the `metadata` field on both the log-body schema and the
  event-update schema rejecting `JSON.stringify(value).length > MAX_METADATA_BYTES`
  with a clear message. This surfaces through the existing Zod → 422 handler in
  `src/index.ts`; no new error path.

### Change 4 — Tests

Follow the existing pure-unit-test style (`*.test.ts` next to the store, vitest).
Both new suites use a lightweight in-memory fake `SessionCore` rather than a full
Workers/Miniflare harness.

**`src/durable/leaseStore.test.ts`** — fake core = an in-memory `Map` for
`meta*`, plus arrays recording `setAlarm(atMs)` and `broadcast(msg)` calls. Drive
time with `vi.useFakeTimers()` / `vi.setSystemTime()`:

- `claimLease` on a free lease sets `lease_holder`/`lease_seen_ms`, calls
  `setAlarm(now + STALE)`, broadcasts `lease.changed`, returns `true`.
- `claimLease` by a different client while alive returns `false` and mutates
  nothing.
- `claimLease` succeeds (steal) once `now - seen >= STALE`.
- `heartbeatLease` by the holder re-arms `setAlarm` and returns `true`; by a
  non-holder returns `false`.
- `releaseLease` by the holder clears meta + broadcasts; by a non-holder is a
  no-op.
- **Regression guard for Change 1:** `expireIfStale` with a stale holder frees +
  broadcasts; `expireIfStale` with a *live* holder frees nothing and calls
  `setAlarm(seen + STALE)` exactly once.
- `finiteMs` hardening: a garbage `lease_seen_ms` (e.g. `'x'`) is treated as `0`
  (→ stale), not `NaN` (→ wrongly alive).

**`src/durable/transportStore.test.ts`** — heavier fake core: an in-memory
mutable transport row exposed via `transportRow()`, a `db.exec` stub that pattern-
matches the store's `UPDATE session_transport ...` statements to mutate that row,
plus `broadcast`/`projection`/`first`/`revision` stubs. With `vi.useFakeTimers()`:

- `startTake` on an idle transport flips `is_rolling`, increments `current_take`,
  sets `roll_started_at_utc`, broadcasts `transport.changed`, returns
  `started: true`; a second `startTake` while rolling returns `started: false`
  and does not double-increment.
- `stopTake` accumulates `elapsed_frames` by
  `trunc((now - roll_started) / 1000 * frameRate)` for a known start time and
  fake clock, clears `roll_started_at_utc`, returns `stopped: true`; `stopTake`
  while idle returns `stopped: false`.
- `stopTakeWithDuration` adds `trunc(durationS * frameRate)` to `elapsed_frames`.
- `statusLive` reports `event_count`/`logged_event_count`/`events_stream_revision`
  from the stubbed `first`/`revision`.

If the `db.exec` pattern-matching fake proves too brittle during implementation,
fall back to extracting the pure elapsed-frames arithmetic into a tested helper;
decide during the plan step.

## Verification

- `npm run test` (vitest) green, including the two new suites.
- `npm run typecheck` (`tsc --noEmit`) clean.
- Manual reasoning check: trace an early-firing alarm on a live lease through the
  new `expireIfStale` and confirm a fresh `setAlarm` is scheduled.

## Versioning

Bump `package.json` `version` `0.3.0` → `0.3.1`. This subdirectory has no
`CHANGELOG.md` or README version string, so no further version surfaces need
updating; if one is added later this entry is "Fixed: lease never reaped after an
early-firing alarm; Added: audio-upload and event-metadata size caps, and
`leaseStore`/`transportStore` tests."

## Risks & rollback

- All changes are additive guards or a single behavioural fix in one method; the
  blast radius is the `SessionDO` lease path and two request validators. Each
  change is independently revertable.
- The 50 MB / 8 KB caps are constants; if a real recording legitimately exceeds
  them, raising the constant is a one-line change. 8 KB matches the existing
  message cap, so it is consistent with current limits rather than newly
  restrictive.
