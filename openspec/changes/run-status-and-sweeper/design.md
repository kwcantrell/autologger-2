# Design: run-status-and-sweeper (ADR 0021 slice 9c)

## Context

Line numbers are at base `bb43ede7`.

**The ceilings**

| Bound | Where | Limit | Refusal |
| --- | --- | --- | --- |
| AI turns | `packages/ai-runtime/src/aiChatRegistry.ts:17-58`: `inflightSessions` plus `globalCount` | `AI_CHAT_MAX_CONCURRENT` (`server/src/env.ts:126-129`, default 2) | `at-capacity`, which gives `AT_CAPACITY_DETAIL` in `ai.ts:76`, `aiV2.ts:103`, `transcribe.ts:255` and `events.ts:289` |
| YouTube | `packages/media-import/src/youtubeImportGuard.ts:45-97`: set plus count | `YOUTUBE_IMPORT_MAX_CONCURRENT = 2` | `null`, which gives `YOUTUBE_IMPORT_AT_CAPACITY_DETAIL` (`sessions.ts:326-328`) |
| Transcript | `packages/transcription/src/transcriptGenerationLock.ts:10-35`: one holder | 1 per process | `in_flight` with the holder-named detail (`generateTranscript.ts:92-103`) |

Each route takes the in-process slot first and then the run lease (8b, `server/src/routers/_aiSlot.ts`,
`sessions.ts:485-643`, `generateTranscript.ts:114-121`). The lease is per session and the ceilings
are per process.

**The status.** `GET /api/transcript-generation/status` (`transcribe.ts:118-136`):
- reads `transcriptGenerationLock.getLock()`;
- answers `{in_flight:false}`, or `{in_flight:true, session_id, session_title, started_at}`;
- nulls the two identifiers unless `canAccessSession`.

The web (`TranscribeFeed.tsx:281-301`) latches the generate button when the status names the page's
own session, and shows `TranscriptGenerationLockBanner` for any busy status.

**Expiry**
- `catalog.session_leases` (`20261011000000`, `20261012000000`) stores Clock-epoch `expires_at_ms`.
- The run kinds are written silently on the raw handle (`sessionCore.ts:537-579`). An expired run
  row stays until the next claim overwrites it.
- Recording rows are freed by `LeaseStore.expireIfStale` (`leaseStore.ts:170-186`, counting handle:
  revision plus `lease.changed`). It runs at hub open (`SessionHub.ts:559-576`) and from the alarm of
  the process that claimed or heartbeated (`:690-732`).
- The only periodic cleanup today is the kv purge (`server/src/startupPurge.ts:23-38`, every 10 min,
  every process).

`createBindings` (`server/src/node/config.ts:42-160`) checks env before taking the `DATA_DIR` lock
(`FRAME_BUS_SECRET`, `:61-62`). `catalogDb.bindSystem(reason)` gives a system-role handle (RLS
`catalog_system` allow-all on `session_leases`).

## Decisions

### D1. `AI_PROVIDER` (owner decision 2)

- **The parser.** `server/src/env.ts` gains `parseAiProvider(raw): 'claude_cli'`. Unset or blank
  gives `'claude_cli'`. Any other value throws
  `AI_PROVIDER must be one of: claude_cli (got "<value>")`. The value is echoed; it is not a secret.
- **Where it runs.** `createBindings` calls it next to the `FRAME_BUS_SECRET` check, before the
  `DATA_DIR` lock, so a refusal holds nothing. `Config` carries `AI_PROVIDER`.
- **Ceilings.** Today no code path reads a ceiling, so D2 deletes them rather than gating dormant
  code. No `runCeilingsEnabled` switch is added (panel: dead code); the providers change adds the
  switch with the ceiling it gates.
- **Removal.** `AI_CHAT_MAX_CONCURRENT` leaves `packages/ports/src/config.ts`, `env.ts`
  (`aiChatMaxConcurrent`), `config.ts` and `server/.env.example`. A stale value in a process env is
  ignored.
- **The secrets allowlist (panel).** `docker/scripts/compose-run.mjs` refuses a whole OpenBao secret
  holding a key that `docker/secrets-env.yaml` does not list. So:
  - `AI_PROVIDER` is added to `docker/secrets-env.yaml`, so a stack can set it;
  - `AI_CHAT_MAX_CONCURRENT` stays listed, commented "ignored since 9c; remove after every OpenBao
    secret drops it", so stacks whose secret still holds it keep starting. Its removal is a later
    tier 0 change.

### D2. No ceilings (owner decision 2)

- **`AiChatTurnRegistry`.**
  - `tryAcquire(sessionId)` drops the `maxConcurrent` parameter and `globalCount`.
  - `AiChatAcquireResult`'s failure is `{ok:false, reason:'session-busy'}`.
  - `activeCount` stays for tests, counting the set's size.
- **`YoutubeImportGuard`.**
  - `tryAcquire(sessionId)` drops `maxConcurrent`.
  - `YOUTUBE_IMPORT_MAX_CONCURRENT` is deleted.
  - `isSessionInFlight` stays.
- **The routes.**
  - The four AI routes drop the `at-capacity` branch and `AT_CAPACITY_DETAIL`.
  - `sessions.ts` drops `YOUTUBE_IMPORT_AT_CAPACITY_DETAIL`. Every guard refusal there is
    session-busy.
- **Order.** 8b's order is unchanged: the in-process session check, then the lease; release the
  lease, then the slot.

### D3. Transcript generation per session (owner decisions 2, 4)

- **The registry.** `transcriptGenerationLock.ts` becomes `TranscriptGenerationRuns`, an in-process
  `Map<sessionId, startedAtMs>`:
  - `tryAcquire(sessionId, nowMs)` refuses only the same session;
  - `startedAt(sessionId)`;
  - `release(sessionId)`;
  - `reset()`.

  The singleton keeps its name, `transcriptGenerationLock`, so imports don't churn.
  `generationInFlightDetail` is unchanged.
- **`generateTranscript.ts`.**
  - **In-process refusal** (same session, this process): the holder-named detail for
    `deps.sessionId` with the in-process `startedAt`.
  - **Lease refusal** (same session, another process): read
    `(await deps.getHub()).runLeaseStartedAt('transcript-generation')`.
    - When it is non-null, the holder-named detail with that time.
    - Otherwise (the row expired or was released in between, or was written by pre-9c code with a
      null `started_at_ms`), `GENERATION_IN_FLIGHT_DETAIL`.
    - Either way, `holderSessionId = deps.sessionId`.
  - **Redaction.** The route's `canAccessSession` redaction is unchanged. The holder is now always
    the requested session, so a caller who passed the route's own access check sees it.
  - **Release.** `finally` releases the lease, then `release(deps.sessionId)`.
- **Facade.** `SessionHubFacade.runLeaseStartedAt(kind)` is a read under the caller (RLS: the caller
  can read the session's leases). It returns the live row's `started_at_ms` when
  `expires_at_ms > now`, else null.
- **Log-import.** `ensureTimedTranscript` keeps its single `in_flight` retry.

### D4. `started_at_ms` (owner decision 4)

- **Migration** `supabase/migrations/20261014000000_session_lease_started_at.sql`:
  `alter table catalog.session_leases add column started_at_ms bigint`.
  - It is nullable, with no default and no backfill. Pre-existing rows keep null.
  - No policy changes: RLS is row-level, and the new column follows the row's policies.
- **`claimLeaseUncounted`** (`sessionCore.ts:537`) inserts `started_at_ms = nowMs`. Its `DO UPDATE`
  sets:
  ```sql
  started_at_ms = CASE WHEN session_leases.holder_client_id = excluded.holder_client_id
                        AND session_leases.holder_user_id IS NOT DISTINCT FROM excluded.holder_user_id
                       THEN session_leases.started_at_ms ELSE excluded.started_at_ms END
  ```
  A renewal by the same holder keeps it; a takeover of an expired row resets it.
- **Recording claims** (`LeaseStore.claimLease`) don't name the column, so recording rows keep null.
- **Rollback:** `alter table catalog.session_leases drop column started_at_ms`, after reverting the
  code. This is a documented step, not a migration file.

### D5. The status from the lease (owner decision 4)

- **New port `LeaseDirectory`** (`packages/ports`), implemented in `packages/storage` on
  `catalogDb.bindSystem('lease-directory')`:
  - `earliestLiveRun(kind, nowMs): Promise<{sessionId, startedAtMs} | null>`:
    ```sql
    SELECT session_id, started_at_ms FROM session_leases
     WHERE kind = $1 AND expires_at_ms > $2 AND started_at_ms IS NOT NULL
     ORDER BY started_at_ms, session_id LIMIT 1
    ```
  - `deleteExpiredRunLeases(nowMs): Promise<number>`:
    `DELETE … WHERE kind IN ('ai-turn','transcript-generation','youtube-import') AND expires_at_ms <= $1`.
    An allow-list of the run kinds (panel), so a future kind is never swept silently; a test pins
    that a recording row and the allow-list match `RunLeaseKind`.
  - `expiredRecordingSessions(nowMs, limit): Promise<string[]>`:
    `SELECT session_id … WHERE kind = 'recording' AND expires_at_ms <= $1 ORDER BY expires_at_ms LIMIT $2`.
  - `Bindings.ports.leases` carries it.
- **The route.**
  - It calls `c.env.ports.leases.earliestLiveRun('transcript-generation', clock.now())`. Null
    answers `{in_flight:false}`.
  - Otherwise it answers today's body. `canAccessSession` decides `session_id` and `session_title`,
    and `started_at` is the ISO time of `startedAtMs`.
  - Pre-9c rows with a null `started_at_ms` are invisible to the status until their next renewal,
    which keeps them. **Accepted:** pre-9c code never wrote these rows in production (single
    process, and the 8b rows exist only on dev).
- **Order.** `ORDER BY started_at_ms, session_id` makes the earliest run deterministic.

### D6. The lease sweeper (owner decision 3)

- **`startLeaseSweeper({leases, sessions, clock, warn, intervalMs = 60_000, batch = 100})`** in
  `server/src/startupPurge.ts`:
  - it returns the timer, unref'd;
  - `main.ts` starts it after `startPeriodicPurge` and clears it in the shutdown handler next to
    `purgeTimer`.
- **Each tick**, with ticks never overlapping (a busy flag, as in `holdRunLease`):
  1. `deleteExpiredRunLeases(now)`: silent. Run kinds have no client, revision or frame.
  2. `expiredRecordingSessions(now, batch)`. For each session id, one at a time:
     `(await sessions.get(id)).as(systemCaller('session-lease-sweep')).expireStaleLeases()`.
     - The new facade method `expireStaleLeases()` runs `s.lease.expireIfStale()` as a write
       transaction through the hub lock. That path gives the revision bump, `lease.changed` across
       processes (9a) and the alarm re-arm.
     - It works whether the hub was just opened (open already ran it, so this deletes nothing) or
       was already cached here.
  - A failure on one session warns and moves on. A failed tick warns once.
- **Idempotent.** Two processes deleting the same expired rows: the second deletes nothing.
  `expireIfStale` is already safe when several processes run it (`leaseStore.ts:167`). Hubs opened
  by the sweeper are evicted by the existing idle sweeper.
- **No sweep at boot.** The first tick is 60 s after start, so it never delays `listen()`.

- **Reviewed system reasons (panel).** `bindSystem('lease-directory')` (storage) and
  `systemCaller('session-lease-sweep')` (server) are new reviewed reasons. They are added to the
  `server/src/catalogSystem.repo.test.ts` ALLOWLIST (D7 category 4); owner approval of this design
  approves the two entries.

### D7. Tests (test first)

**Changing existing tests.** It is allowed only in these categories. Anything else is a stop.
1. **Tests whose premise D2 or D3 removes are deleted or rewritten as same-session cases.** Task
   1.1 lists each one for the owner. Known (panel):
   - the AI at-capacity cases in `ai.int`, `aiV2.int` and `events.generate.int`;
   - the YouTube global-ceiling cases in `sessions.youtubeImport.int` and
     `youtubeImportGuard.test`;
   - in `transcribe.int`: the "a second run is rejected" case (`:974`), the four cross-session
     "409 concurrent: … redacted/enriched" cases (`:1026`, `:1050`, `:1080`, `:1099`), the
     cross-session instanceof pin (`:1185`), and the lease case expecting the generic detail
     (`:1498`), which now gets the holder-named detail because `holdAsAnotherProcess` writes
     `started_at_ms`;
   - `packages/transcription/src/generateTranscript.inflight.test.ts` (cross-session holder);
   - `packages/transcription/src/transcriptGenerationLock.test.ts` (one global slot, `getLock`).
2. **Call sites of changed or removed APIs.**
   - `tryAcquire(sessionId, max)` becomes `tryAcquire(sessionId)`.
   - `transcriptGenerationLock.release()` becomes `release(sessionId)`.
   - `getLock()` is removed, together with the unused `isTranscriptGenerationInFlight`. Its test
     reads (`transcribe.int` `:1021`, `:1506`, `:1545-1613`; `generateTranscript.remap.int:89`)
     become `startedAt(sessionId)`, or a lease read.
   - The status tests seed a lease row instead of the in-process lock.
   - Full `Config` literals drop `AI_CHAT_MAX_CONCURRENT` and add `AI_PROVIDER`.
   - Test process environments handed to `createBindings` or `checkBootEnv` supply the variables
     boot now validates, `AI_PROVIDER` (and, from task 7.1, `RUN_FEATURE_EMAILS`), with a valid
     value. The case that found this is `server/src/node/config.test.ts` "AI_V2_CREDENTIAL_SOURCE_PATH
     has NO environment override (ruling E6)": its proxy env answers `'/etc/attacker'` for every
     unset key, so it gains `AI_PROVIDER: 'claude_cli'` in its base env. What it asserts is
     unchanged (amended in task 2.1, owner 2026-10-07).
3. **The new column in row assertions.** The `catalogSchema.pg` column snapshot gains
   `started_at_ms`. Whole-row `session_leases` assertions (`leaseStore.int`, `runLease.int`, and
   any other `rawRows(…, 'session_leases')` user) gain `started_at_ms`: `null` for recording, the
   claim time for run rows.
4. **The reviewed system-reason ALLOWLIST** (`catalogSystem.repo.test.ts`) gains the two D6 reasons.
5. **Approved-user setup (D9, re-panel).** Seeded users keep running the six routes as approved
   users:
   - `seedUser` (and so `seedAccessMatrix` and `seedAdminOf`) defaults its email to the fixed
     `seeded-user@example.com`. `catalog.users.email` is not unique (`idx_users_email` only), and
     login is by Google subject;
   - `resetTestEnv` (`server/src/test/harness.ts`), the second-process env in
     `server/src/test/session/busProcesses.ts`, and the test sites that call `createBindings`
     directly set `RUN_FEATURE_EMAILS=seeded-user@example.com,default-user@example.com`;
   - a test that relied on distinct default emails passes explicit ones;
   - negative cases seed a user with an explicit, non-approved email.

   The harness's `BOOTSTRAP_OWNER_EMAIL` stays an address no suite signs in with
   (owner-bootstrap D13).

**New tests**
- **Unit:**
  - `parseAiProvider`, and `createBindings` refusing an unknown `AI_PROVIDER` before the lock;
  - the registry and guard with no global cap (three different sessions all acquire);
  - `TranscriptGenerationRuns` per session;
  - `startLeaseSweeper` with a fake clock and fake ports: interval, no overlap, warn-only, per-session
    failure isolation.
- **pg (storage and session):**
  - `started_at_ms` is set on claim, kept on renewal and reset on takeover;
  - `earliestLiveRun` ordering and the expiry filter;
  - `deleteExpiredRunLeases` deletes only expired run rows and never advances a revision;
  - `expiredRecordingSessions`;
  - `runLeaseStartedAt`;
  - `expireStaleLeases` advances the revision once and broadcasts `lease.changed`.
- **Integration:**
  - two sessions generate concurrently (both `200`);
  - same-session in-process and lease refusals give the holder-named `409` with `started_at`;
  - the status names the earliest run across two apps sharing the database, redacted for a
    non-member;
  - four AI requests on four sessions with no at-capacity `409`;
  - three YouTube imports on three sessions all admitted;
  - a sweeper tick on app B frees an expired recording lease claimed on app A and delivers
    `lease.changed` to A's socket.

### D8. Latency

Recorded, with no stop rule:
- the status route against the lease read;
- one sweeper tick with 0 rows and with 50 expired run rows.

### D9. Approved users for run features (owner decision 5)

- **The list.** `server/src/env.ts` gains `runFeatureEmails(env): string[]`:
  - `[bootstrapOwnerEmail(env)]` plus the entries of `RUN_FEATURE_EMAILS` (split on commas, each
    trimmed, blanks dropped, ASCII-normalized with `asciiEmailNorm`, duplicates dropped);
  - so the bootstrap owner is always approved (re-panel: a grant must never lock the owner out),
    and unset, blank or all-blank (`","`) means the owner alone;
  - a non-ASCII entry refuses boot in `bootGuard.ts`, as `BOOTSTRAP_OWNER_EMAIL` already does;
  - the boot log prints the count and the masked forms (`maskBootstrapOwnerEmail`), never the
    addresses.

  `Config` carries `RUN_FEATURE_EMAILS`. `docker/secrets-env.yaml` and `server/.env.example` list
  it.
- **The match.** `runFeatureAllowed(env, user)` is true when `bootstrapEmailMatch(user.email, e)`
  is `true` for some entry. That gives the same exact-ASCII rule, and a non-ASCII token email never
  matches.
- **The guard.** `requireRunFeature(c)` lives in `server/src/routers/_helpers.ts` and throws
  `ApiError(403, RUN_FEATURE_FORBIDDEN_DETAIL)`. The detail is
  `This feature is limited to approved users on this server.`
- **Where it runs.** On the six routes (proposal), immediately after the route's existing
  configuration `503`, and before the in-process slot, the lease and any spawn. On AI v2 design it
  comes after both the configuration and the agent-credentials `503`s: it is called in the route
  after `guardAiV2Route`, never inside it, because the answer route shares that prologue and is
  not gated. Everything earlier
  in each route's frozen order keeps its place: 401, the session-access 404, the AI v2 guard
  prologue, and events/generate's body `400`, which today comes before its `503`. Later checks
  (other 400s and 422s, and the 409s) follow the 403.
  - A user without access on an unconfigured server still sees the 503, so the feature reads as
    off.
- **Log-import.** The POST computes `runFeatureAllowed` for the creator and stores it on the job's
  in-memory runner input; it is not persisted, since the job runs on this process.
  `ensureTimedTranscript` skips generation when it is false, and appends the progress line
  `Skipped transcript generation: limited to approved users on this server.` The session counts as
  failed, as an `in_flight` that fails twice does today.
- **Not gated:**
  - the AI v2 answer route (it answers a turn that an approved user started, and stays
    principal-bound);
  - reads, such as the status route, transcripts and topics;
  - recording and every non-run feature.
- **Tests (test first):**
  - unit tests for `runFeatureEmails` (unset gives the bootstrap owner; comma list; blanks; case
    folding) and the `bootGuard` non-ASCII refusal;
  - integration, per route: a non-approved member gets `403` with the detail, and no slot, lease or
    spawn (the fixture CLI is never invoked and no lease row exists);
  - an approved user is admitted;
  - an unconfigured feature gives `503` to a non-approved user;
  - a log-import job by a non-approved creator records the skip line and claims no
    `transcript-generation` lease.

  Existing route tests run as seeded users who must be approved. D7 category 5 sets that up in the
  harness; the bootstrap owner is never reused (owner-bootstrap D13).

## Risks

- **The email allowlist is the only bound** on runs (decision 5). A wrong entry grants
  everything; the boot log's masked count makes the list visible without printing it.

- **Unbounded spend on `claude_cli`.** This is decision 2, accepted by the owner. The README and the
  ADR say the limits come back with the providers change.
- **The status names another session's run** while the page's own session is also generating. The
  button doesn't latch, and a click gets the holder-named `409`. Flagged in the proposal for the
  owner.
- **A large backlog of expired recording rows.** The sweeper takes 100 per tick, and the rest wait
  for later ticks. The batch size bounds the hub opens per tick.
- **Several processes open the same hub to sweep it.** Each process's `expireIfStale` is a
  conditional delete, so only one bumps the revision.

## Rollback

1. Revert the code. 8b's leases keep working without `started_at_ms`.
2. Then drop the column (D4).

The ceilings come back with the revert. Nothing else is stored.
