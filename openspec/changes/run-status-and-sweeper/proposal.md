# Run status and sweeper: no run ceilings on `claude_cli`, transcript status from the lease, expired leases swept

Tier: 2
Tier reason:
- a migration adds `session_leases.started_at_ms` (`supabase/migrations/**`, a high-risk path);
- the change amends frozen HTTP contracts (`api-contract-freeze`): the at-capacity `409`s go, a
  transcript generation on one session no longer refuses another session, and
  `GET /api/transcript-generation/status` reports the whole deployment;
- it removes three concurrency bounds and adds a periodic multi-process sweeper;
- it adds an authorization rule (an email allowlist for run features), which is auth work: the
  owner owns its design;
- it touches `server/src/routers/**`.

ADR 0021 slice 9c.

Approved-by: Kalen 2026-10-07

## Why

ADR 0021 slice 9 makes several server processes correct. 8b moved each "one run per session" check
to a run lease in `catalog.session_leases`. Three things still live in one process's memory or are
never cleaned up:

- **The process ceilings.** They count per process, so N processes allow N times the limit:
  - the shared AI turn limit, `AI_CHAT_MAX_CONCURRENT` (default 2, shared by AI chat, AI v2, topic
    generation and event generation);
  - the YouTube import limit of 2;
  - transcript generation's one run per process.
- **The transcript generation status.** `GET /api/transcript-generation/status` reads the
  in-process `transcriptGenerationLock`. A run on another process reads as idle.
- **Expired lease rows.**
  - An expired run-lease row is never deleted; the next claim overwrites it.
  - An expired recording lease is freed only by the alarm of the process that holds it, or when some
    process opens that session. A crashed recorder's lease therefore shows as held to every watching
    client until someone opens the session.

## Owner decisions (owner, 2026-10-07)

1. **The deployment-wide ceiling will be a count of live run leases.** A new claim takes a per-kind
   transaction advisory lock, counts the kind's live rows, and inserts only below the limit;
   renewals skip the count. It is **deferred to the providers change**. This change records the
   mechanism and builds no ceiling.
2. **A new `AI_PROVIDER` setting, and no limits on `claude_cli`.**
   - `AI_PROVIDER` defaults to `claude_cli`, today the only accepted value. Other providers come
     later.
   - `claude_cli` is the owner's development setup ("there are no limits because that is a dev"),
     so on it **all three ceilings are off, both in process and deployment-wide**: AI turns,
     YouTube imports and transcript generation.
   - The per-session single-flight (one run per session per kind, the session-busy `409`) always
     stays.
3. **The sweeper runs in every process and is idempotent**, like the kv purge. There is no
   election.
4. **The transcript status comes from the lease row plus a new `started_at_ms`.** Several sessions
   can now generate at once. The status names the **earliest-started live run**, with today's body
   shape and redaction.

5. **Only approved users may start these runs** (owner, after the panel's denial-of-service
   finding). With no ceilings, the bound is who may start a run: the owner's email, plus anyone the
   owner grants.
   - The bootstrap owner is always approved. The grant is an env email allowlist,
     `RUN_FEATURE_EMAILS`, which adds users. The owner grants by adding an email in OpenBao and
     restarting.
   - Anyone else gets a frozen `403 {detail}`.
   - The server enforces this; the web is unchanged and shows the detail on click.
   - A log-import job whose creator lacks access skips transcript generation, with a progress line.

## What changes

- **`AI_PROVIDER`.**
  - Parsed at boot. Unset or blank means `claude_cli`. Any other value refuses to boot and names the
    accepted values.
  - `AI_CHAT_MAX_CONCURRENT` is no longer read, and is removed from the config port and the env
    examples.
  - `docker/secrets-env.yaml` allows `AI_PROVIDER`. It keeps `AI_CHAT_MAX_CONCURRENT`, marked
    ignored, because the allowlist refuses a whole OpenBao secret that holds an unlisted key.
- **No ceilings.**
  - `aiChatTurns` and `youtubeImportGuard` keep only their per-session set: the in-process session
    check that sits in front of the lease (8b).
  - The global counts, the `at-capacity` result, `YOUTUBE_IMPORT_MAX_CONCURRENT` and the two
    at-capacity `409` detail strings are deleted.
  - Session-busy `409`s are unchanged.
- **Transcript generation is per session.**
  - `transcriptGenerationLock` (one slot per process) becomes an in-process per-session set.
  - Two sessions can generate at once. A second run on the same session is refused, in process or
    by its lease.
  - Either refusal now names the session and its start time, with today's holder-named detail. The
    lease refusal reads `started_at_ms` from the live row, and falls back to today's generic detail
    if the row is gone.
  - The route's redaction is unchanged.
- **`session_leases.started_at_ms`.**
  - A nullable `bigint`.
  - A run-lease claim sets it on insert or takeover and keeps it on renewal by the same holder.
  - Recording leases leave it null.
- **Status from the lease.** `GET /api/transcript-generation/status` reads the earliest-started live
  `transcript-generation` row of the whole deployment, through a system read, so RLS doesn't hide
  other teams' runs. The body shape, the null redaction and the fixtures are unchanged.
- **The lease sweeper.** Every process runs it every 60 s. It is unref'd and warn-only, started in
  `main.ts` and stopped on shutdown. Each tick does two things:
  1. One system `DELETE` of expired rows of the three run kinds, named in an allow-list. It is silent: no revision change and no frame.
  2. For each session with an expired `recording` row, open the session's hub as a system caller.
     Opening already runs `expireIfStale`, which advances the revision and sends `lease.changed` to
     every process over the 9a frame bus.
- **Approved users** (decision 5). Six routes refuse with `403 {detail}`, immediately after each
  route's configuration `503` and before any slot, lease or spawn:
  - `POST …/ai/chat`;
  - `POST …/ai/v2/design`;
  - `POST …/topics/generate`;
  - `POST …/events/generate`;
  - `POST …/youtube-import`;
  - `POST …/transcript-words/generate`.

  The detail is `This feature is limited to approved users on this server.` The check matches the
  user's verified login email against `BOOTSTRAP_OWNER_EMAIL` plus the `RUN_FEATURE_EMAILS` entries,
  using the bootstrap-owner match (ASCII-normalized, exact). For AI v2 design the check comes after
  both of its 503s, outside the guard prologue it shares with the answer route. Log-import jobs record the creator's access
  at creation; a job without it skips transcript generation for sessions that have no words.
- **ADR 0021** §8b/§9 records decisions 1–4. The README's run-lease and AI-limit paragraphs change.

## Not changing

- The session-busy `409`s, their detail strings, and the run-lease claim, renewal and release (8b).
- The recording lease's claim, heartbeat, status, alarm and revision accounting (8a).
- Per-turn budgets: the CLI `--max-budget-usd` and the AI v2 `maxBudgetUsd`.
- The web client. The status body shape is unchanged.
- Log-import's retry on `in_flight`. It now only meets same-session runs.

## Impact

- **Who can spend.** Only approved users (decision 5) can start the runs below. The bound is
  the owner's trust in those users, not a number.
- **Spend.** On `claude_cli`, any number of AI turns, YouTube imports and Deepgram transcript runs
  can run at once, one per session per kind. The owner accepts this for development. The providers
  change brings the ceiling back.
- **The status names one run.** The web latches the generate button only when the status names the
  page's own session (`TranscribeFeed.tsx:281`). When an earlier run on another session is the one
  named, the page shows that run's banner. A generate click on a session that is already running
  gets the holder-named `409`, which the page already displays. **The owner should confirm this at
  approval.**
- **Crash window.** Unchanged from 8b: a dead process's run leases block that session's kind for up
  to 40 s. The sweeper deletes the rows within about 60 s of expiry; it does not shorten the window.
- **Load.** Each process makes 2 statements a minute, plus one hub open per session with an expired
  recording lease.
- **Code.**
  - `server/src/{env,bootOrder,main,startupPurge}.ts`, `server/src/node/config.ts` and
    `server/src/routers/{ai,aiV2,transcribe,events,sessions,_aiSlot}.ts`
  - `packages/ai-runtime/src/aiChatRegistry.ts`, `packages/media-import/src/youtubeImportGuard.ts`
    and `packages/transcription/src/{transcriptGenerationLock,generateTranscript}.ts`
  - `server/src/{bootGuard}.ts`, `server/src/routers/{_helpers,logImport}.ts` and
    `server/src/test/{harness,helpers}.ts` (approved users)
  - `packages/session-core/src/{sessionCore,leaseStore,SessionHub}.ts`, `packages/storage` (the
    system lease reads) and `packages/ports/src/config.ts`
  - the migration, the README, `server/.env.example`, `docker/.env{,.dev,.stage}.example`,
    `docker/secrets-env.yaml`, `docs/openbao-secrets.md` and ADR 0021

## Non-goals

- The deployment-wide ceiling itself (decision 1; the providers change).
- Other AI providers.
- Releasing run leases on graceful shutdown.
- Companion presence and the device credential (9d).
- Blobs (slice 10) and the topology (replicas, load balancing).
