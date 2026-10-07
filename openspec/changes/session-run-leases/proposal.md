# Session run leases: the per-session AI, transcript and YouTube single-flight slots move into `catalog.session_leases`

Tier: 2
Tier reason: a migration widens `session_leases_kind_check` (`supabase/migrations/**`, a high-risk
path), and the change moves three concurrency guards from process memory to a database race decided
by a conditional upsert, with a server-side heartbeat timer. It amends the frozen revision
requirement (`api-contract-freeze`) to say the new lease kinds never count, and gives a
cross-process transcript refusal the generic `409` detail. ADR 0021 slice 8b.

Approved-by: Kalen 2026-10-07

## Why

ADR 0021 makes `catalog.session_leases` the only authority for single-flight work, so that more than
one server process can run. Slice 8a moved the recording lease. Three per-session single-flight
guards still live only in one process's memory:

- **The shared AI turn slot** (`aiChatTurns`, `packages/ai-runtime/src/aiChatRegistry.ts`). It is
  shared by AI chat, AI v2 design, topic generation and event generation. A second process would let
  two turns run for one session.
- **Transcript generation** (`transcriptGenerationLock`, `packages/transcription`). It is one slot
  for the whole process, so "at most one run per session" holds only inside one process.
- **YouTube import** (`youtubeImportGuard`, `packages/media-import`). It uses a per-session set plus
  a process ceiling.

## Owner decisions (owner, 2026-10-07)

1. **Only the per-session check moves to leases.** Each guard's "one run per session" check is now
   also enforced by a lease. After the panel, the in-process check stays in front of the lease as
   defence in depth. There are three new kinds: `ai-turn` (shared by the four AI features),
   `transcript-generation` and `youtube-import`. The process-wide limits stay in memory and count per
   process:
   - `AI_CHAT_MAX_CONCURRENT`;
   - the YouTube ceiling of 2;
   - transcript generation's one run per process, including the holder and `started_at` that
     `GET /api/transcript-generation/status` reports.

   A deployment-wide ceiling is not part of this slice.
2. **The holding process heartbeats.** A held run lease lives 40 s, and the process holding it
   renews it every 10 s. A crashed process's lease is free within about 40 s. If a renewal is
   refused, the process logs it and the run continues.
3. **Silent.** Claiming, renewing, releasing or overwriting a run lease never advances the session
   revision and never broadcasts `lease.changed`. No client reads these kinds.
4. **Holder = the requesting user and a run id.**
   - `holder_user_id` is the user the request runs as. For the sheets log-import job's transcript
     runs, that is the job's creator.
   - `holder_client_id` is a server run id, `srv:<boot id>:<uuid>`, unique per run.

   The 8a row-level security policies apply unchanged.

## What changes

- **Migration.** `session_leases_kind_check` admits `'recording'`, `'ai-turn'`,
  `'transcript-generation'` and `'youtube-import'`. No rows change.
- **`LeaseStore`.** The three new kinds are claimed and released on the raw (non-counting) handle,
  with no revision change, no broadcast and no alarm. A claim wins on a free or expired row, or on
  the holder's own row.
  - **Renewal is a re-claim by the same holder.** A holder whose row lapsed during an outage gets it
    back, unless another process took it.
  - **Recording is unchanged:** the recording lease, its alarm, its status and its revision
    accounting. `expireIfStale` is narrowed to recording rows.
  - **Expired run rows** are overwritten by the next claim and are not swept.
- **A lease-hold helper in session-core.** It claims a run lease through a hub-resolving thunk and
  renews it every 10 s on a timer that re-resolves the hub on each tick, so idle eviction mid-run is
  harmless. `release()` is memoized and never rejects, and it stops the timer.
- **Routes and pipelines (panel-revised).** The in-process guards are unchanged, and the lease is
  added after them:
  1. **Take the in-process slot first**, synchronously, exactly as today. Every single-process
     `409` detail is therefore today's, and the event-generation await-free window is unchanged.
  2. **Then claim the lease.** A refusal can only come from another process. It releases the slot
     and gives the session-busy detail (AI turn, YouTube), or the generic in-flight detail
     (transcript generation). A claim that throws releases the slot and rethrows.
  3. **Release in reverse order:** await the lease release, then free the slot, before the response
     ends. An immediate follow-up on the same session is never refused.

## Not changing

- No HTTP/WS shape, status code or detail string changes. `GET /api/transcript-generation/status`
  still reads the in-process lock.
- No feature spec's single-process behaviour changes. One feature spec is amended:
  transcript-generation "Single-flight generation" gains the cross-process refusal, which gives the
  generic in-flight detail. The others still hold as written, because their registries are
  unchanged: ai-topics-chat, ai-v2-dashboards, topic-generation, auto-event-generation,
  youtube-audio-import and sheets-log-import.
- The recording lease (8a) is untouched.

## Impact

- **Restart window.** A process that crashes or is killed mid-run leaves its run leases for up to
  40 s, and a retry on that session gets `409` until they expire. Today a restart frees them at
  once. Graceful shutdown does not release them. This is accepted, and the README records it.
- **Latency.** Each guarded request makes about two more database round trips (claim and release),
  plus one renewal every 10 s per run. This is measured and recorded, with no stop rule.
- **Code.**
  - `packages/session-core` (leaseStore, sessionCore, SessionHub facade, new lease-hold helper)
  - `packages/transcription/src/generateTranscript.ts`
  - `server/src/routers/{ai,aiV2,transcribe,events,sessions}.ts` and the new `_aiSlot.ts`
  - the new migration and the README

## Non-goals

- Deployment-wide ceilings and a cross-process transcript status: slice 9 (multi-process).
- A sweeper for expired run-lease rows.
- Releasing run leases on graceful shutdown.
- Cancel endpoints.
