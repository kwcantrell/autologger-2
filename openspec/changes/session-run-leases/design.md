# Design: session-run-leases (ADR 0021 slice 8b)

## Context

Line numbers are at base `07acaaf8`.

**The three guards**

| Guard | Where | Per-session axis | Process axis | Acquire / release sites |
| --- | --- | --- | --- | --- |
| `aiChatTurns` | `packages/ai-runtime/src/aiChatRegistry.ts:17-58` | `inflightSessions` set | `globalCount` vs `AI_CHAT_MAX_CONCURRENT` (default 2) | `ai.ts:130`/`:175`; `aiV2.ts:235`, released by `runOuterAiTurn` `onFinally` (`aiV2SdkSpawn.ts:527-536`) and the route `finally` `:353-361`; `transcribe.ts:280`/`:355`; `events.ts:525`/`:636` |
| `transcriptGenerationLock` | `packages/transcription/src/transcriptGenerationLock.ts:10-35` | none (implied by the global slot) | one holder `{sessionId, startedAtMs}` | `generateTranscript.ts:86` / `finally` `:191`, after `return await` commits the replace (`:175`) |
| `youtubeImportGuard` | `packages/media-import/src/youtubeImportGuard.ts:47-97` | `inflightSessions` set | `globalCount` vs 2 | `sessions.ts:485` / `finally` `:616-620` |

The transcript lock is reached from two places:
- `POST …/transcript-words/generate` (`transcribe.ts:153-189`);
- the sheets log-import background job (`logImport.ts:51-112`), which runs as
  `userCaller(job.createdByUserId)` and retries once on `in_flight`.

`GET /api/transcript-generation/status` (`transcribe.ts:117-135`) reads the lock's holder and
`started_at`. None of the guards heartbeats, expires or survives the process.

**The 8a lease (as built)**
- **`LeaseStore`** (`leaseStore.ts`):
  - the claim is a conditional upsert on the counting handle (it advances the revision, broadcasts
    `lease.changed` and arms the alarm);
  - the heartbeat is `SessionCore.heartbeatLeaseUncounted` on the raw handle;
  - the release is a conditional delete on the counting handle;
  - `leaseStatus` is hard-coded to `'recording'`;
  - `expireIfStale` deletes expired rows of **every** kind through the counting handle, broadcasts,
    and re-arms at `MIN(expires_at_ms)` across all kinds.
- **The alarm** (`SessionCore.setAlarm`, `SessionHub.armAlarm`) is a single slot that replaces any
  pending timer.
- **The facade** (`SessionHub.ts:235-243`, `:1069-1081`) takes no kind.

## Decisions

### D1. Three run kinds, one migration

`supabase/migrations/20261012000000_session_run_leases.sql` drops and re-adds the named check:

```sql
alter table catalog.session_leases drop constraint session_leases_kind_check;
alter table catalog.session_leases add constraint session_leases_kind_check
  check (kind in ('recording', 'ai-turn', 'transcript-generation', 'youtube-import'));
```

No rows and no policies change. Re-adding the check validates existing rows, which are all
`'recording'`.
- `LeaseKind` becomes `'recording' | RunLeaseKind`, with
  `RunLeaseKind = 'ai-turn' | 'transcript-generation' | 'youtube-import'`.
- `TTL_MS` gains 40 000 for each run kind.
- `RUN_LEASE_RENEW_MS = 10_000`.
- `LeaseStore.TTL_MS` stays a per-kind map.

### D2. Run leases are written on the raw handle, silent

There are two new `LeaseStore` methods. Each is one statement on `SessionCore`'s raw handle, through
new uncounted helpers next to `heartbeatLeaseUncounted`.

- **`claimRunLease(kind, holderId)`.** It runs the same upsert as `claimLease`, including the guard
  `WHERE expires_at_ms <= now OR (same client AND same user)`. A win is `changes === 1`. The same
  call is the **renewal**: the holder re-claims every tick.
  - The holder's own row is extended while it is alive.
  - If the holder's own row lapsed (a database outage or event-loop stall of more than 40 s) and
    nobody took it, the claim re-takes it.
  - The claim is refused only when **another** holder has a live lease.

  This replaces a strict `UPDATE … expires_at_ms > now` renewal, which could never recover after a
  lapse.
- **`releaseRunLease(kind, holderId)`.** It runs `DELETE … WHERE session_id, kind,
  holder_client_id, holder_user_id IS NOT DISTINCT FROM`.

Neither method calls `setAlarm` or `broadcast`. The raw handle does not advance the revision; the
precedents are the 8a heartbeat and `metaSetUncounted`. `kind` is typed `RunLeaseKind`, so the
recording lease can never be written silently.

**`expireIfStale` is narrowed to `kind = 'recording'`** for both the delete and the
`MIN(expires_at_ms)` re-arm. Without that, a run lease's expiry would advance the revision,
broadcast, and pull the single alarm slot. An expired run row stays until the next claim overwrites
it (no sweeper; that is a non-goal).

The facade gains `claimRunLease` and `releaseRunLease`, each `inTxn`. Like every lease write, they
run in a hub write transaction behind the session row lock. The recording methods are unchanged.

**Why not reuse `claimLease(clientId, kind)`?** It advances the revision and broadcasts by design,
because the revision contract is frozen. Separate typed methods make the silent path impossible to
call for recording.

### D3. The lease-hold helper

`packages/session-core/src/runLease.ts`:

```ts
export const SERVER_BOOT_ID: string;           // randomUUID() at module load
export function newRunHolderId(): string;      // `srv:${SERVER_BOOT_ID}:${randomUUID()}`
export interface RunLeaseHold { release(): Promise<void> }   // memoized: every call returns the same promise
export async function holdRunLease(opts: {
  getHub: () => Promise<SessionHubFacade>;     // caller-bound (the request's user)
  kind: RunLeaseKind;
  renewMs?: number;                            // default RUN_LEASE_RENEW_MS; tests inject
  log?: (msg: string, err?: unknown) => void;  // default console.error
}): Promise<RunLeaseHold | null>;              // null = refused
```

- **Claim.** `holdRunLease` claims once through `getHub()`. If the claim is refused, it returns
  `null` and starts no timer. If it throws, the error propagates; every caller places the call so
  that its process slot is released on a throw (D4).
- **Renewal timer.** On a win, `holdRunLease` starts an unref'd `setInterval(renewMs)`. Each tick
  calls `(await getHub()).claimRunLease(...)`.
  - **Re-resolving the hub on every tick** makes idle eviction mid-run harmless (async-session-hub
    D6: no hub reference is held idle). The routes are outside any hub transaction, so the timer
    does not capture a transaction context (verified by the panel).
  - **Ticks never overlap.** A tick is skipped while the previous one is pending.
  - **A refused renewal** (`false`), meaning another holder has a live lease, logs once
    (`run lease lost: <kind> <sessionId>`) and stops the timer. The run continues (owner
    decision 2).
  - **An error** is logged and retried on the next tick.
- **Release.** `release()` stops the timer, waits for any pending tick, then calls
  `releaseRunLease`.
  - It never rejects: errors are logged, because release runs in `finally` blocks whose original
    outcome must win.
  - It is memoized: a second call returns the first call's promise.
- **Hold time vs. lease time.** The timer runs on real time and lease expiry on the Clock port. In
  production both are `Date.now()`. Tests either drive both (the fake clock plus `renewMs` with
  `vi.useFakeTimers`) or check the renewal count only.

### D4. Process slot first, lease second, released in reverse

All three guards use one order (panel: the await-free window, the single-process details, and
defence in depth):

1. **Take the in-process slot synchronously, exactly as today.** The registries are unchanged:
   `aiChatTurns.tryAcquire(sessionId, max)`, `youtubeImportGuard.tryAcquire(sessionId)` and
   `transcriptGenerationLock.tryAcquire(sessionId)`. They keep their per-session sets and process
   ceilings, so every single-process refusal and its `409` detail is today's.
   - The event-generation await-free window still ends at the synchronous `aiChatTurns.tryAcquire(`
     call (core-ports-architecture "Event-generation word snapshot stays await-free";
     `eventsGenerateWindow.test.ts` is unchanged).
2. **Then claim the run lease, inside the slot's `try`.**
   - A refusal can only come from another process, because this process's own slot already
     excludes itself. A refusal releases the slot and answers:
     - the session-busy detail for the AI turn (each route's own string) and for YouTube
       (`YOUTUBE_IMPORT_SESSION_BUSY_DETAIL`);
     - the generic in-flight detail for transcript generation (`TranscriptGenerateError('in_flight',
       GENERATION_IN_FLIGHT_DETAIL)` with no holder, so the route's redaction gives the generic
       text).
   - A claim that **throws** releases the slot and rethrows, which the route maps as today (500).
     The transcript claim therefore sits inside the existing `try` whose `finally` releases the
     lock.
3. **Release in reverse order.** Await the lease release first, then release the slot. A
   same-process follow-up therefore never finds the slot free while this run's lease is still live,
   and a run followed immediately by another on the same session is never refused.

**The AI turn** uses one server helper, `server/src/routers/_aiSlot.ts`. Each of the four routes
keeps its synchronous registry call, then awaits the helper:

```ts
const proc = aiChatTurns.tryAcquire(sessionId, max);        // step 1, unchanged (window end)
if (!proc.ok) throw busyOrCapacity(proc.reason);            // today's details
const slot = await claimAiLease(c, sessionId, proc);       // step 2
if (slot === null) throw sessionBusy();                     // another process holds it
try { ... } finally { await slot.release(); }               // step 3
```

- `claimAiLease` returns an `AiSlot` with `release: () => Promise<void>`, or `null`. On `null` or
  a throw, it has already released `proc`.
- `AiSlot.release` is memoized and never rejects. It releases the lease, then `proc.release()`.
- Each route `await`s it in its `finally`, so the JSON response or the SSE close comes after the
  lease row is gone.
- aiV2 passes `() => { void slot.release(); }` to `runDesignTurn`'s `onFinally`, so a never-ending
  iterator still frees the slot. The route `finally` awaits the same memoized promise. `void` on a
  memoized never-rejecting promise satisfies `promiseHygiene.repo.test.ts`, and
  `RunDesignTurnOptions.release` stays `() => void`.
- In `events.ts` the await-free window still ends at the literal `aiChatTurns.tryAcquire(`, so the
  source-anchor test is unchanged.

**YouTube** follows the same steps in `sessions.ts`. The `finally` awaits the lease release, then
releases the guard, then removes the temp directory (that order is unchanged).

**Transcript generation.** In `generateTranscriptWords`:
- step 1 is unchanged (`:86`);
- the `try` opens before the claim;
- the `finally` awaits the lease release, then calls `transcriptGenerationLock.release()`, then the
  scratch `rm`.

The release still follows `return await …replace…`, so "release after commit" (S9) holds. The
log-import job needs no change: it already passes a user-bound `getHub`, and it already retries once
on `in_flight`.

### D5. The registries are unchanged

`AiChatTurnRegistry`, `YoutubeImportGuard` and `TranscriptGenerationLock` keep their APIs and
types. The leases are added alongside the in-memory checks, not as a replacement. Within one process
the lease never decides anything; across processes it does. The only new type is `AiSlot`
(`_aiSlot.ts`).

### D6. Tests (test first)

**Store and hub** (`server/src/test/session/`):

- **`runLease.int.test.ts` (new):**
  - claim, re-claim (renew) and release of each run kind: revision unchanged, no `lease.changed`, no
    alarm armed;
  - refused while another holder's lease is live;
  - takeover after expiry, and the holder re-taking its own lapsed row (fake clock);
  - a former holder's release leaves the new holder's row;
  - a refused blank or NUL holder id;
  - `expireIfStale` leaves expired run rows and frees only recording rows;
  - `leaseStatus` ignores run rows.
- **`holdRunLease`:**
  - 180 s under the fake clock and fake timers: 18 renewals, the lease alive throughout, and a
    competing holder's claim refused throughout (the "A long run keeps its lease" scenario);
  - a refused renewal logs once and stops;
  - an error is retried;
  - a renewal after more than 40 s of errors re-takes the row;
  - no overlapping ticks;
  - `release()` is memoized, never rejects, and waits for a pending tick;
  - a refused claim gives `null` and starts no timer;
  - an evicted hub is re-resolved on the next tick.
- **`leaseRace.int.test.ts`:**
  - (f) 200 rounds of two processes claiming `ai-turn` for different users: one winner per round,
    revision unchanged;
  - (g) a dead process's `youtube-import` lease is taken over through process B after expiry, which
    replaces the row (the "A crashed holder's slot frees by expiry" scenario, at store level).

**Database** (`catalogSchema.pg.test.ts`):
- the kind-check snapshot;
- a new describe for the 8b migration: the run kinds insert for the holding user, `x` still fails
  with `23514`, and no row changes.

**Routes.** Each test pre-claims a run lease as another holder, simulating a second process:
- **Files:** `ai.int.test.ts`, `aiV2.int.test.ts`, `transcribe.int.test.ts` (topics and transcript),
  `events.generate.int.test.ts`, `sessions.youtubeImport.int.test.ts`.
- **Busy:** each asserts the session-busy `409` (generic in-flight for transcript) and no spawn or
  provider call, with the process slot free afterwards.
- **Release:** each asserts the lease row is gone **when the response completes** after success,
  error and (where it exists) abort.
- **Back-to-back:** each asserts that an immediate second request on the same session is not `409`.
- **Claim error:** a claim that throws leaves the process slot or lock free.
- **YouTube:** a cross-process holder followed by expiry lets the import run.

**Contract.** The revision scenario (an AI chat turn that calls no write tool, with at least one
renewal, and the revision unchanged) goes in `ai.int.test.ts`. `renewMs` is injectable through
`_aiSlot.ts` for tests.

**Allowed changes to existing tests:**
1. The kind-check snapshot line in `catalogSchema.pg.test.ts`.
2. Hub or `LeaseStore` tests asserting that `expireIfStale` deletes every kind (if any) are narrowed
   to recording.

Any other change to an existing test is a stop: update the artifacts and ask the owner.

### D7. Risks and trade-offs

- **The restart window** (accepted, proposal). A kill mid-run blocks that session's kind for up to
  40 s. The README records it.
- **Renewals during a transaction-heavy turn.** The renewal takes the hub write lock; an AI v2 turn
  writing many dashboard rows delays it by at most one transaction. A 40 s TTL against a 10 s cadence
  leaves 30 s of slack, and a lapsed own row is re-taken (D2).
- **Event-loop stalls of more than 30 s** could let another process take the lease. Today there is
  only one process, so nothing else claims, and the in-process slot still excludes this process's
  own second run. Accepted.
- **RLS.** A `catalog_user` with access could squat a run row by direct SQL, as for recording
  (catalog-database: "RLS alone does not protect a live lease"). `catalog` is not exposed through
  PostgREST (`PGRST_DB_SCHEMAS: public`). Unchanged from 8a.

## Rollback

Revert the code. Run leases are written only by the new code, so rows left behind expire harmlessly.
A down migration restores the `'recording'`-only check after `delete from catalog.session_leases
where kind <> 'recording'`. Ship it as a `docs/templates` rollback note, not a migration file.
