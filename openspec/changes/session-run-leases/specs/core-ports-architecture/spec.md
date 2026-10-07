## ADDED Requirements

### Requirement: Run single-flight slots are correct across processes
The per-session single-flight checks of the shared AI turn slot (AI chat, AI v2 design, topic
generation, event generation), transcript generation and YouTube import SHALL each be a session
lease, of kind `ai-turn`, `transcript-generation` and `youtube-import` respectively (ADR 0021
slice 8b), so two processes sharing one database never run two of the same kind for one session.

- **Claims decide in the database.** A run lease claim SHALL be one conditional statement that wins
  only on a free or expired row, so two claims racing from different processes produce exactly one
  holder.
- **The holder.** A run lease SHALL be held by the user the request runs as (the job's creator for a
  sheets log-import transcript run) and by a server run id, `srv:<boot id>:<uuid>`, unique per run.
- **The holding process renews it.** A run lease SHALL live 40 s from its claim or last renewal.
  The process that holds it SHALL renew it every 10 s until the run releases it, by re-claiming it
  as the same holder, so a holder whose lease lapsed and was not taken gets it back. A renewal
  refused because another holder has a live lease SHALL be logged, SHALL stop the renewals and
  SHALL NOT stop the run. A failed renewal (an error) SHALL be logged and retried on the next tick.
- **Released on every path, before the response.** Every path that releases the in-process slot
  SHALL first release the lease and then the slot, and a request's response SHALL complete only
  after its lease release. The release SHALL be conditional on the holder, so a lost lease is never
  deleted by its former holder.
- **Silent.** Run leases SHALL be written without advancing the session revision, without
  broadcasting `lease.changed` and without arming the lease alarm. An expired run lease is
  overwritten by the next claim; no process sweeps it.
- **The in-process checks stay, in front of the lease.** The shared AI turn registry
  (`aiChatTurns`, with its per-session single-flight and `AI_CHAT_MAX_CONCURRENT`), the YouTube
  import guard (with its per-session single-flight and ceiling), and transcript generation's one
  run per process SHALL stay in process memory and SHALL be checked first, synchronously, so every
  single-process `409` detail and the event-generation await-free window are unchanged. That
  includes the holder and `started_at` reported by `GET /api/transcript-generation/status`. The
  lease SHALL be claimed after them. A refused claim SHALL free the in-process slot and respond
  `409`: with the feature's session-busy detail for the AI turn and YouTube import, and with the
  generic in-flight detail for transcript generation. A claim that fails with an error SHALL free
  the in-process slot.

#### Scenario: Two processes start an AI turn for one session
- **WHEN** two processes' hubs claim one session's `ai-turn` lease at the same moment for different
  users, for 200 rounds, the winner releasing after each round
- **THEN** each round has exactly one successful claim, and the session revision never changes

#### Scenario: A turn held by another process is refused before any spawn
- **WHEN** another process holds a live `ai-turn` lease for the session and a client sends an AI
  chat, an AI v2 design, a topic generation or an event generation request for that session
- **THEN** each responds `409` with that feature's session-busy detail, and no subprocess is spawned

#### Scenario: A crashed holder's lease is taken over after expiry
- **WHEN** process A claims a session's `youtube-import` lease and stops without releasing it, and
  process B claims it for another user 41 s later
- **THEN** B's claim replaces the stored lease in one write

#### Scenario: A long run keeps its lease
- **WHEN** a run lease is held for 180 s of clock time with renewals every 10 s, and another holder
  claims the same session and kind throughout
- **THEN** the lease is renewed 18 times, is alive throughout, and every competing claim is refused

#### Scenario: A lapsed lease is re-taken by its holder
- **WHEN** a holder's renewals fail with errors for more than 40 s, nobody else claims the lease,
  and a renewal then succeeds
- **THEN** the holder holds the lease again

#### Scenario: A lost lease is not released by its former holder
- **WHEN** a run's renewal is refused because another holder took the expired lease, and the run
  then finishes
- **THEN** the run logs the refusal once and completes, and its release leaves the new holder's
  lease in place

#### Scenario: Back-to-back runs on one session are not refused
- **WHEN** a topic generation run on a session completes, and the client immediately sends another
- **THEN** the second request is not refused with `409`
