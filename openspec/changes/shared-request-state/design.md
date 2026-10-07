# Design: shared-request-state (ADR 0021 slice 9b)

## Context

Line numbers are at base `9cfa042d`.

**Log-import**
- `packages/log-import/src/jobStore.ts` keeps a `globalThis` Map. A job record has `id`, `status`
  (`queued|running|completed|failed`), `lines`, `error`, `createdAtMs`, `finishedAtMs` and
  `createdByUserId`. A terminal job is kept for 1 h, and the map holds at most 200 jobs.
- `server/src/routers/logImport.ts:128-260`: the POST creates a job and runs it in a detached
  async block on this process.
- `:262-276`: the GET is creator-scoped and answers a uniform 404.
- The web polls every 500 ms (`web/src/pages/index/batchImport/logImportClient.ts`).
- `BatchImportModal.tsx` turns a job 404 into "API route missing — restart the Node server…".

**AI v2 questions**
- `packages/ai-runtime/src/aiV2PendingQuestions.ts` holds one entry per question, keyed by
  `[sessionId, turnId, requestId]`.
  - Each entry holds `principalUserId`, `originalInput` and the Promise resolver that the SDK's
    `canUseTool` waits on.
  - `resolveAnswer` checks the principal and the answer count, deletes the entry and resolves it.
  - `abandonTurn` denies the turn's pending questions.
- `server/src/routers/aiV2.ts:213-372` is the design SSE stream. `:389-436` is the answer route:
  `200 {ok:true}`, or `404 ANSWER_NOT_FOUND_DETAIL`.

**AI chat resume**
- `server/src/routers/ai.ts:84-94,177-179`: `issuedClaudeSessionIds: Map<claudeId, sessionId>`, with
  no expiry, keyed by session only. A foreign id gets `422 FOREIGN_CLAUDE_SESSION_ID_DETAIL`
  before any spawn.
- The CLI runs with `cwd = stableSessionCwd(sessionId)` (`aiChatRunner.ts:181-197`) and `HOME` from
  the server. It stores the conversation as `$HOME/.claude/projects/<encoded cwd>/<id>.jsonl`. In
  the container, `$HOME` is the `autologger-home` volume.

**kv** (`packages/storage/src/kvStore.ts`, `catalog.kv(key, value, expires_at)`)
- `get` treats an expired row as absent.
- `put(key, value, {expirationTtl})` writes the row.
- `take` is an atomic delete-and-return.
- `replaceIf(key, expected, next)` is an atomic compare-and-swap on a row that hasn't expired, and
  keeps its expiry.
- `delete` removes the row.
- Expired rows are purged every 10 min.
- `packages/log-import` and `packages/ai-runtime` may already import `@autologger/ports`, where
  the `KvStore` port lives.

## Decisions

### D1. Log-import job records in kv (owner decision 1; panel-revised)

- **The record.**
  - Key: `log-import-job:<uuid>`.
  - Value: `{v:1, status, lines, error, createdAtMs, finishedAtMs, createdByUserId, heartbeatMs,
    seq}`.
- **API.** `jobStore.ts` becomes `createLogImportJobStore(kv, clock)`, returning `{create, get,
  appendLine, setStatus, heartbeat}`. It is built per server binding (`config.ts`) and reached
  through `c.env.ports.logImportJobs`. The `globalThis` map, the 200 cap and `clearLogImportJobs`
  are removed.
- **One queue per job.** Every write for a job (`appendLine`, `setStatus`, `heartbeat`) is put on
  a per-job promise chain, so writes run one at a time in issue order (panel: out-of-order puts lost
  a terminal status in 127 of 200 simulated runs).
  - Each write is one atomic `replaceIf(key, lastWritten, next, {expirationTtl})` with `seq + 1`.
    The job's first write is a plain `put`.
  - Expiry: 2 h while queued or running, refreshed by each write, and 1 h once terminal.
  - **`KvStore.replaceIf` gains an optional `{expirationTtl}`.** It sets the new expiry in the same
    conditional `UPDATE`, and without the option the expiry is kept, as today. This touches the port
    (`packages/ports`), the Postgres store and its pg test. The existing caller
    (`companion:last_command`) is unchanged.
  - A mismatch means another writer changed the record.
  - On a mismatch, the runner stops importing. It appends nothing more, and its loop checks a
    `lost` flag before each sheet. The only other writer is a stale-failure CAS from a poll.
  - The job's `finally` awaits the chain before it stops the 10 s heartbeat timer.
- **Stale jobs are final.** `get` reads the record. If its status is `queued` or `running` and
  `now - heartbeatMs > 60 s`, it switches the record to `failed` with error `The server running this
  import stopped.` using `replaceIf`, and returns that. A runner that later wakes finds the record
  changed and stops. "Failed" is therefore final for both the web poller and the runner, and no
  "recovery" exists.
- **Errors never escape.** Every kv call on the runner path (the detached job, the heartbeat
  timer, `onProgress`, the `catch` and the `finally`) is awaited inside the chain, and the chain
  catches and logs a rejection. A failed write is retried once at the next step. If the store is
  down for good, the job's status goes stale, and a poll reports it failed once the store is back.
  `onProgress` stays `(line) => void` and enqueues.
- **Route.** The GET only adds `await`. The creator check and the uniform 404 are unchanged.
- **Web.** The 404 hint in `BatchImportModal.tsx` becomes "The import job was not found. It may have
  expired; start the import again." The status shape is unchanged.

### D2. AI v2 pending questions in kv, polled by the turn's process (owner decision 2; panel-revised)

- **A per-binding port.** The registry is built per server binding at the composition root and
  reached through `c.env.ports.aiV2Questions`. The module singleton is removed (panel: two test apps
  sharing one registry would never exercise kv). `buildPendingQuestionOnQuestion` takes the
  registry as a parameter.
- **The row.**
  - Key: `ai-v2-question:` + `JSON.stringify([sessionId, turnId, requestId])`, which keeps today's
    collision-free key encoding.
  - Value: `{v:1, state:'pending', principalUserId, questionCount}`.
  - Expiry: the turn's deadline (turn start plus its timeout) plus 5 s. The turn's start is passed
    when the turn registers.
- **Register.**
  1. `await kv.put(row)`.
  2. Only then add the local entry, start or extend the poller, and call `emitQuestion`.

  If the `put` throws, the question is denied to the agent, is not emitted, and the error is
  logged.
- **Polling.** One 500 ms unref'd poller per turn runs while the turn has pending questions. Each
  tick reads each of its rows:
  - **`answered`:** the tick `take`s the row, builds the permission result from the local
    `originalInput` and the stored answers, and resolves.
  - **missing (expired or deleted):** the tick denies, as abandoned.
  - **a read that throws:** the tick logs it and retries next tick; it is never treated as missing.

  The tick body is one awaited async function with its own catch, and the poller stops on the turn's
  `finally`.
- **Answering.** `resolveAnswer(key, answeringUserId, answers)` runs on any process:
  1. `get` the row. If it is missing or its state isn't `'pending'`, return `'not-found'`.
  2. Check that the principal matches and that `answers.length === questionCount`. If not, return
     `'not-found'`.
  3. `replaceIf(row, {…, state:'answered', answers})`. If it lost the race, return `'not-found'`.
  4. Return `'accepted'`.

  A kv error answers `500`, which the route maps as it does today.
- **Abandon.** `abandonTurn` stays `() => void` for `aiV2SdkSpawn`. It denies the local entries at
  once and deletes their rows fire-and-forget, with a catch that logs. If deleting fails, the rows
  expire at the deadline.
- **Crash.** If the turn's process dies, its rows expire at the deadline plus 5 s. An answer before
  then gets `200` with no effect. The spec names this one exception to "a late answer is rejected".
  The client's SSE stream ended with the process, so the client knows the turn is gone.

### D3. AI chat resume binding in kv, per session and user (owner decisions 3, 4; panel-revised)

- **The binding.** Key `ai-chat-resume:<claudeSessionId>`, value `{v:1, sessionId, userId}`,
  written after a turn's `done` with a 7-day expiry. A write error is logged and does not fail the
  turn; the next resume then gets `422`.
- **Accepting a resume.** All of the following must hold:
  - `claude_session_id` matches `/^[A-Za-z0-9-]{1,64}$/`. This is checked first, before any key or
    path is built.
  - the row's `sessionId` and `userId` equal the request's session and signed-in user.
  - the file `<cliHome>/.claude/projects/<encodeCwd(stableSessionCwd(sessionId))>/<id>.jsonl`
    exists, where `encodeCwd` replaces every character outside `[A-Za-z0-9]` with `-`, as the CLI
    does. This is one `stat` of the exact path the CLI will read (panel), so a shared home with a
    different `TMPDIR` still fails cleanly.

  Anything else gets the existing `422 FOREIGN_CLAUDE_SESSION_ID_DETAIL`, before any spawn.
- **The encoding** is pinned by a unit test against a real path observed from CLI 2.1.292
  (`/tmp/…/cwd/abc` becomes `-tmp-…-cwd-abc`), and the live check (5.3) confirms it with the image's
  CLI (2.1.284).
- **The CLI home** is the `HOME` the spawn passes (`buildAiChatChildEnv`), overridable for tests.
- **Content.** The binding holds identifiers only, so "Ephemeral chat history" still holds.

### D4. Tests (test first)

**kv fakes.** No kv test double exists, and the packages may not import `@autologger/storage`. So
`packages/log-import` and `packages/ai-runtime` each get a small in-package `MemoryKv` test helper
copying `get`/`put`/`take`/`replaceIf`/`delete` and expiry exactly. The server integration tests
then repeat the key cases on the real Postgres kv.

- **`jobStore.test.ts`:**
  - create, append, status and heartbeat;
  - writes queued in issue order, using a fake whose `put` can be delayed: a delayed heartbeat never
    overwrites a later terminal status;
  - the expiry while running and after finishing;
  - a heartbeating job readable past 2 h;
  - a stale job switched to failed after 61 s, and the runner stopping when it finds the record
    changed;
  - a throwing kv never rejecting out of the runner;
  - a record written by one store instance read through another.
- **`logImport.int.test.ts`** (new cases):
  - a GET through a second app returns the job;
  - a job whose runner stopped reads as failed after 61 s;
  - the creator-scoped 404 is unchanged.
- **`aiV2PendingQuestions.test.ts`:**
  - the row is stored before emit, and a failed `put` denies without emitting;
  - an answer through a second registry instance over the same kv resolves the first one's turn on
    its next poll;
  - a wrong principal or count gets `'not-found'`;
  - of two concurrent answers, exactly one is accepted;
  - a poll whose read throws retries rather than denying;
  - abandon denies, and a failed delete is only logged;
  - a vanished row is denied.
- **`aiV2.int.test.ts`** (two apps):
  - an answer through B reaches the turn on A within 1 s, and B's registry never held a local
    entry;
  - two concurrent answers accept one.
- **`ai.int.test.ts`:**
  - a co-member's resume gets 422;
  - a resume through a second app sharing the CLI home works;
  - a file present under another project directory but not the exact one gets 422;
  - a path-shaped id gets 422 with no filesystem access;
  - an expired binding gets 422.
- **`aiChatRunner` unit test:** `encodeCwd` against the observed CLI path.
- **Web:** the `BatchImportModal` test for the new 404 text.

**Allowed changes to existing tests:**
1. Tests that use the synchronous `jobStore` functions or `clearLogImportJobs` move to the
   per-binding async store. This covers `logImport.int`, `sessionHub.interleave.int`,
   `callers.int`, `apiResponseFixtures.int` and `jobStore.test`.
2. Tests that pre-seed or reset `issuedClaudeSessionIds` or the pending-question singleton move to
   the kv-backed per-binding equivalents. That includes seeding a conversation file and overriding
   the CLI home in tests that expect a resume to be accepted, such as `ai.int.test.ts:492`, whose
   fake CLI writes no conversation file.
3. The `BatchImportModal` 404-hint assertion follows the new text.
4. (Owner, 2026-10-07, during 3.1.) The registry's own unit tests in
   `packages/ai-runtime/src/aiV2PendingQuestions.test.ts` (the 16 cases that build a registry and
   call `register`, `resolveAnswer`, `abandonTurn`, `size` or `has`) change shape with the same
   assertions: they build the registry over the in-package `MemoryKv` and a clock, await the now
   async calls, and expect `'accepted'` where they expected `'ok'`.

Any other change is a stop.

### D5. Latency

A one-off bench, not committed:
- a log-import `appendLine` round trip;
- the median and p95 time from an answer's `200` to the turn's resolution with the 500 ms poller,
  measured through two apps on the test database.

Recorded; no stop rule.

## Risks

- **kv write volume:** each log-import line and each 10 s heartbeat, at today's few jobs per day.
- **The poller:** at most one kv read per pending question every 500 ms, only while a question is
  pending.
- **A 7-day resume expiry versus today's "until restart".** A longer conversation must start fresh
  after 7 days.

## Rollback

Revert the code. kv rows of the three prefixes expire on their own. No migration.
