# Shared request state: log-import jobs, AI v2 answers and AI chat resume work on any server process

Tier: 2
Tier reason: this changes frozen HTTP contracts (`api-contract-freeze` log-import job endpoints)
and an auth-related binding (AI chat resume is tightened to the user). It moves concurrency-
sensitive request state (a blocking question round trip) into the database, across
`packages/ai-runtime`, `packages/log-import` and `server/src/routers/**`. ADR 0021 slice 9b.

Approved-by: Kalen 2026-10-07
## Why

Slice 9a made session frames reach every server process. Three kinds of per-request state still
live only in the memory of the process that created them. With more than one process, a request
that lands elsewhere fails:

- **Log-import jobs** (`packages/log-import/src/jobStore.ts`) are a process-global Map. A poll of
  `GET /api/log-import/:jobId` served by another process gets `404 Log import job not found.`. A
  job whose process dies vanishes, with no record that it existed.
- **AI v2 design questions** (`aiV2PendingQuestions`) are held by the process running the turn.
  An answer posted to another process gets `404`, and the turn blocks until it times out.
- **AI chat resume** (`issuedClaudeSessionIds` in `server/src/routers/ai.ts`) is a Map from
  `claude_session_id` to session. Another process rejects a valid resume with `422`. The map is
  also keyed by session only, so any co-member of a session can resume another user's chat.

## Owner decisions (owner, 2026-10-07)

1. **Log-import jobs are a kv record with a heartbeat.** The job's status, lines and error are
   stored as a JSON record in `catalog.kv`, so every process can answer `GET`. The running
   process refreshes a heartbeat. A job whose heartbeat is more than 60 s old is reported
   `failed` with the error `The server running this import stopped.`. A terminal job expires one
   hour after it finishes. The in-memory map and its 200-entry cap go away.
2. **AI v2 answers use a kv row that the turn's process polls.**
   - Registering a question writes a kv row holding the question's owner, its question count and
     an expiry at the turn's deadline plus 5 s, before the question is sent.
   - The answer route, on any process, validates against the row and records the answer with an
     atomic compare-and-swap, so it keeps today's exact `200` or `404`.
   - The process running the turn checks its pending rows every 500 ms.
   - No frame-bus change.
3. **AI chat resume is bound to the session and the user.** The binding moves to kv as
   `{sessionId, userId}`. Another user of the same session gets today's `422`, which closes the
   co-member hole the way AI v2 already does.
4. **Missing CLI files fail cleanly.** If the CLI's conversation file for a bound id is not on
   this process's disk (a process in another container), the request gets the same `422`, never
   a CLI error. Whether replicas share the CLI home volume is decided in the topology slice.

## What changes

- **Log-import.** `jobStore.ts` is rewritten over the `KvStore` port:
  - key `log-import-job:<id>`;
  - one JSON value `{status, lines, error, createdAtMs, finishedAtMs, createdByUserId,
    heartbeatMs}`;
  - a 2 h expiry while running, refreshed by a 10 s heartbeat, and 1 h after finishing;
  - all of a job's writes queued in order and compare-and-swapped (`KvStore.replaceIf` gains an
    optional new expiry).

  A stale running job is switched to `failed`, which is final; the runner stops if it finds its
  record changed. The job store and the AI v2 question registry become per-binding ports, no
  longer process-wide singletons.

  `GET` reads kv on any process. The response shape is unchanged.
- **AI v2 questions.**
  - `aiV2PendingQuestions` keeps the local resolver and the original input, and adds a kv row per
    question: key `ai-v2-question:` plus the JSON-encoded `[sessionId, turnId, requestId]`, value
    `{state:'pending', principalUserId, questionCount}`, expiring at the turn's deadline plus 5 s,
    stored before the question is sent.
  - `resolveAnswer` on any process reads the row, checks the principal and count, and swaps
    `pending` for `{state:'answered', answers}`.
  - The turn's process polls its own rows, `take`s an answered one and resolves. Abandon deletes
    the rows.
- **AI chat resume.** kv key `ai-chat-resume:<claudeSessionId>` holds `{sessionId, userId}` with a
  7-day expiry. A resume is accepted only when both match and the CLI's conversation file exists at
  the exact path the CLI reads under this process's CLI home. Otherwise it gets `422`.
- **Contract and docs.** The log-import specs and README drop "in-process memory, capped at 200"
  and gain the stale-job failure.

## Not changing

- Every request and response shape and every detail string, except the new stale-job error.
- The AI v2 answer contract: `200 {ok:true}`, or the same masked `404`.
- The design-turn timeout and abandon behaviour.
- The frame bus.
- Companion presence (9d) and the deployment-wide AI concurrency ceiling (9c).

## Impact

- **Behaviour.**
  - A co-member can no longer resume another user's AI chat.
  - Resume ids expire after 7 days. Today they last until the process restarts.
  - A log-import job whose process died now reads as `failed` instead of `404`.
  - An AI v2 answer reaches the turn up to 500 ms later than today.
- **Latency.** Each log-import progress line and each heartbeat is a kv write. AI v2 polling is
  one kv read every 500 ms per pending question. Measured and recorded, with no stop rule.
- **Code:**
  - `packages/log-import/src/jobStore.ts`
  - `packages/ai-runtime/src/aiV2PendingQuestions.ts`
  - `server/src/routers/{logImport,ai,aiV2}.ts`
  - `server/src/node/config.ts`
  - `web/src/pages/index/components/BatchImportModal.tsx`: drop the misleading "API route
    missing" hint on a job `404`
  - spec deltas also for `core-ports-architecture` (the Clock port list and the removed size cap)
    and `package-architecture` (shared request state is not a process-wide singleton)
  - README

## Non-goals

- Companion presence (9d).
- Deployment-wide ceilings, transcript status and lease sweepers (9c).
- Sharing the CLI home volume between replicas (topology).
- Resuming a log-import job on another process.
