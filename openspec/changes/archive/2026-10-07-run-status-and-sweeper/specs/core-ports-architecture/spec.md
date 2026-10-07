## MODIFIED Requirements

### Requirement: Wall-clock time is read through a single Clock port

Every decision-making time read SHALL obtain the current time from a single injected
synchronous `Clock` port rather than calling `Date.now()` directly — covering
recording-lease staleness/expiry and alarm scheduling, session live-timecode derivation,
key/value TTL expiry (login sessions, OAuth CSRF), Companion presence freshness, the
identity JWKS cache TTL, the log-import job store's expiries, finished-at stamping and
heartbeat staleness (ADR 0021 slice 9b), the AI v2 pending-question deadline, the AI chat
resume binding's expiry, and the AI runtime's process-group kill-ladder deadline. The lease **alarm
scheduler and the clock SHALL share one time base**, so an alarm scheduled from clock time
and an expiry check reading clock time cannot diverge (no real-`setTimeout`-vs-fake-clock
skew).

A time read that falls **outside every class enumerated above**, and on which no control
flow, expiry decision, ordering, or persisted state depends, is not a decision-making read
and **need not** be converted to the port. Such a value MAY be rendered in a message or
serialized into a response field. Establishing that a read is of this kind SHALL require
reading every consumer of the value, not only its producer, and each such read SHALL be
**named in the delta of the change that establishes it** — recording the reasoning only in a
design document does not survive archive. This exemption never narrows the enumeration
above: a read that serves live-timecode derivation, lease or TTL expiry, freshness, or alarm
scheduling remains covered even where its computed result is only serialized.

`transcriptGenerationLock.tryAcquire`'s `startedAtMs` (one entry per session since
run-status-and-sweeper D3) is such a read: the in-process entry never expires by time and is
cleared in a `finally`, nothing branches on the value, and it is only rendered in the same-process
`409` detail. A run lease's `started_at_ms` is not such a read: it orders the runs that
`GET /api/transcript-generation/status` chooses between, so a run-lease claim SHALL take it from
the Clock port, as it takes the lease's expiry (run-status-and-sweeper D4).

**One** `Date.now()` site is a known standing exception: `SessionHub`'s `DEFAULT_CLOCK`
fallback in package production code, which never fires on the production path and is
deliberately local so the hub does not depend on the composition root. The AI runtime's
process-group kill ladder — previously recorded here as a second standing exception, owned by
the change that packages the AI runtime — is **discharged by that change** and is no longer an
exception.

**A `Clock` injected into a path that must not throw SHALL be a required parameter, not an
optional field on an options object.** The kill ladder's entry point is documented as never
throwing, and it is awaited inside `finally` blocks whose *remaining* statements release a
concurrency slot, abandon pending questions, dispose an MCP turn token, and delete a directory
holding copied operator credentials. A throw there leaks a slot for the process lifetime,
leaves a turn token valid, orphans a process group, and escapes as a `500` on an otherwise
successful request. An optional clock makes a missed construction site typecheck; a required
one makes it a compile error. The entry point SHALL remain total.

Where a `Clock` is injected into a loop that also **sleeps**, the sleep SHALL be controlled by
the same test-time mechanism as the clock. `Clock` exposes `now()` only, so a polling loop
whose deadline reads an injected clock while its sleep uses a real timer will, under a fake
clock that never advances, spin forever rather than fail — converting a would-be assertion
failure into a hung suite, in **existing** tests as well as new ones. Injecting a clock into
such a loop without also controlling its sleep is half a seam and SHALL NOT be described as
complete.

#### Scenario: A named exemption is recorded where it survives
- **WHEN** a change declines to convert a time read on the grounds above
- **THEN** the delta spec names the read and the property that exempts it, so a later reader inspecting the durable baseline can distinguish an examined exemption from an overlooked violation

#### Scenario: Lease expiry is deterministic through the hub
- **WHEN** a test claims a lease, advances a fake clock past the stale threshold, and triggers expiry through the hub
- **THEN** the lease is freed without any real time passing, and the alarm neither busy-refires nor fails to fire

#### Scenario: TTL and freshness are testable without real elapsed time
- **WHEN** a test advances a fake clock past a KV entry's TTL (or the presence freshness window, or the JWKS cache TTL)
- **THEN** the entry is treated as expired/stale without any real time passing

#### Scenario: No decision-making Date.now() remains
- **WHEN** the server source **and the workspace packages under `packages/`** are inspected for direct `Date.now()` calls in staleness, TTL, expiry, freshness, alarm-scheduling, live-timecode, or process-kill-deadline logic
- **THEN** none remain; those paths read the injected `Clock` (the `systemClock` implementation, which lives with the composition root, is the sole sanctioned `Date.now()` site **for decision-making reads**; `SessionHub`'s `DEFAULT_CLOCK` is the only other)

#### Scenario: The kill ladder's deadline is deterministic and its sleep is controlled
- **WHEN** a test drives the process-group kill ladder against a group that does not exit, with both the injected clock and the poll's sleep under test control
- **THEN** the SIGTERM→SIGKILL escalation occurs exactly when the injected clock passes the grace deadline, without real elapsed time, and the test terminates rather than hanging

#### Scenario: Existing ladder tests survive the injection
- **WHEN** the pre-existing kill-ladder tests that drive a genuinely live process group are run after the clock is injected
- **THEN** each terminates and asserts the same escalation behavior as before — a mechanical substitution of a frozen fake clock that leaves the poll's real timer in place is not an acceptable conversion, and any test-scoped timer control is scoped so that helpers awaited *before* the code under test are not themselves stalled

#### Scenario: The kill ladder entry point remains total
- **WHEN** the process-group kill entry point and its callers are inspected after the clock is threaded
- **THEN** the clock is a required parameter at every level rather than an optional options field, the entry point has gained no path that throws, and the `finally` blocks that await it still run their remaining cleanup statements

#### Scenario: Job lifecycle expiry is testable without real elapsed time
- **WHEN** a test creates log-import jobs through the injected clock, drives some to a terminal status, advances the clock past the terminal-job TTL, and then reads a job back
- **THEN** the expired terminal jobs are pruned and the jobs that are still queued or running survive, without any real time passing

#### Scenario: Size-cap eviction is unchanged and reads no time
- **WHEN** many log-import jobs exist (the in-memory store and its size cap were removed in ADR
  0021 slice 9b; jobs live in the key-value store)
- **THEN** no job is evicted by count: a job leaves only when its key-value expiry passes, judged
  by the Clock port

#### Scenario: Job status observed through the app is unchanged
- **WHEN** a log-import job is created, progresses, and reaches a terminal status through the real app after the clock is injected
- **THEN** the status endpoint's JSON shape, status codes, and creator-scoping behavior are identical to before the change, and no job time value is observable on the wire (`systemClock` reads the same source the direct call did)

#### Scenario: A stale job is judged by the Clock port
- **WHEN** a test starts a log-import job through the injected clock, stops its heartbeat, and
  advances the clock 61 s
- **THEN** a read of the job reports it `failed` with error `The server running this import stopped.`

### Requirement: Recording leases are correct across processes
The recording lease SHALL be correct when several server processes share one database, without
relying on any one process's memory or timer (ADR 0021 slice 8a).

- **The stored expiry is the authority.** Every read of the lease and every claim SHALL judge it by
  its stored expiry against the Clock port, so a lease that no process has freed already reads as
  not alive and can be claimed.
- **Claims decide in the database.** A claim SHALL be one conditional statement, so two claims
  racing from different processes produce exactly one holder, even without the session row lock.
- **Any process frees an expired lease.** Its lease alarm, opening the session, a takeover
  claim, or the lease sweeper SHALL free it. Freeing SHALL happen once across processes: one row deleted, the revision
  advanced by one, and `lease.changed` broadcast by the process that freed it.
- **The sweeper bounds how long an expired lease stays.** A lease no process is looking at MAY
  stay stored after it expires, and still reads as not alive, until a lease sweeper tick in any
  process frees it, within about one sweep interval of its expiry (run-status-and-sweeper D6; see
  Expired leases are swept by every process).

#### Scenario: Two processes claiming give one holder
- **WHEN** two processes' hubs claim one session's lease at the same moment for different users,
  for 200 rounds, the winner releasing after each round
- **THEN** each round has exactly one successful claim, and the revision advances by exactly two
  per round

#### Scenario: A lease whose process stopped is freed by another
- **WHEN** process A claims the lease and stops without releasing it, the lease expires, a client
  reads the status through process B, and another user then claims through B
- **THEN** the status reports the lease not alive, and the claim succeeds and replaces the stored
  lease in one write

#### Scenario: Two alarms free a lease once
- **WHEN** both processes have their lease alarm armed for the same expiry and both fire
- **THEN** the lease row is deleted once, the revision advances by one, and one `lease.changed` is
  sent in total

#### Scenario: Heartbeats through another process keep the lease
- **WHEN** process A heartbeats every 8 s while process B's alarm fires repeatedly with B's clock
  500 ms ahead
- **THEN** B never frees the lease

#### Scenario: A crashed recorder's lease is freed without anyone opening the session
- **WHEN** process A claims the lease and stops without releasing it, no process opens the session,
  a client's socket on process B watches the session, and the lease expires
- **THEN** within one sweep interval after the expiry a sweeper tick frees it, the revision advances
  by one, and B's socket receives `lease.changed`

### Requirement: Run single-flight slots are correct across processes
The per-session single-flight checks of the shared AI turn slot (AI chat, AI v2 design, topic
generation, event generation), transcript generation and YouTube import SHALL each be a session
lease, of kind `ai-turn`, `transcript-generation` and `youtube-import` respectively (ADR 0021
slice 8b), so two processes sharing one database never run two of the same kind for one session.

- **Claims decide in the database.** A run lease claim SHALL be one conditional statement that wins
  only on a free or expired row, so two claims racing from different processes produce exactly one
  holder.
- **The start time.** A run lease claim SHALL set `started_at_ms` to the claim's Clock time when
  it inserts the row or takes over another holder's row, and SHALL keep it when the same holder
  renews (run-status-and-sweeper D4).
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
  overwritten by the next claim, or deleted silently by the lease sweeper, whichever comes first
  (run-status-and-sweeper D6).
- **The in-process checks stay, in front of the lease.** The shared AI turn registry
  (`aiChatTurns`), the YouTube import guard and transcript generation's run registry
  (`transcriptGenerationLock`) SHALL each be an in-process per-session set with no count and no
  ceiling (run-status-and-sweeper D2, D3). They SHALL stay in process memory and SHALL be checked
  first, synchronously, so every single-process session-busy `409` detail and the event-generation
  await-free window are unchanged. The lease SHALL be claimed after them. A refused claim SHALL
  free the in-process slot and respond `409`: with the feature's session-busy detail for the AI
  turn and YouTube import, and for transcript generation with the holder-named detail carrying the
  live lease's `started_at_ms`, or the generic in-flight detail when that lease is no longer live
  or has no start time. A claim that fails with an error SHALL free the in-process slot.
- **No run ceiling on `claude_cli`.** On `AI_PROVIDER=claude_cli` no process-wide or
  deployment-wide ceiling SHALL bound any run kind. A future deployment-wide ceiling SHALL be a
  count of the kind's live run leases, taken under a per-kind transaction advisory lock on a new
  claim and skipped on renewal; it is deferred to the change that adds other providers.

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

#### Scenario: Runs of one kind on different sessions are not capped
- **WHEN** `AI_PROVIDER` is `claude_cli` and five processes sharing one database each start an AI
  turn, a YouTube import and a transcript generation run on their own distinct sessions at once
- **THEN** every run claims its lease and none is refused with `409`

#### Scenario: A renewal keeps the run's start time
- **WHEN** a run lease is claimed at clock time T, renewed by its holder six times, then expires and
  is taken over by another holder at clock time U
- **THEN** its `started_at_ms` is T through every renewal, and U after the takeover

## ADDED Requirements

### Requirement: Expired leases are swept by every process
Every server process SHALL run a lease sweeper that removes expired session leases
(run-status-and-sweeper D6). It SHALL be idempotent across processes, with no election, like the
key-value purge.

- **Schedule.** The sweeper SHALL tick every 60 s on an unref'd timer, started after the server
  binds its other periodic tasks and cleared on shutdown. Its first tick SHALL come one interval
  after start, so it never delays `listen()`. Ticks SHALL never overlap.
- **Run kinds.** Each tick SHALL delete every expired run lease (the kinds `ai-turn`, `transcript-generation` and `youtube-import`, named in an allow-list, so a kind added later is never swept by default) in one
  system-role statement. The deletion SHALL be silent: no revision change, no frame.
- **Recording leases.** Each tick SHALL then list up to 100 sessions with an expired `recording`
  lease, oldest expiry first, and free each one in turn by opening the session as a system caller
  and running the lease's expiry check through the session hub's write path, so the revision
  advances once and `lease.changed` reaches every process. The rest wait for later ticks.
- **Warn-only.** A failure on one session SHALL be logged as a warning and SHALL NOT stop the tick;
  a failed tick SHALL be logged as one warning and SHALL NOT stop the timer.
- **Reads through a port.** The sweeper and `GET /api/transcript-generation/status` SHALL reach
  `catalog.session_leases` across sessions through a `LeaseDirectory` port bound to the catalog's
  system role, so row-level security does not hide any team's rows.

#### Scenario: Two processes sweep the same rows
- **WHEN** processes A and B tick at the same moment over the same expired run leases and the same
  expired recording lease
- **THEN** each expired run row is deleted once, the recording lease is freed once, the session's
  revision advances by one, and one `lease.changed` is sent in total

#### Scenario: Live leases are untouched
- **WHEN** a tick runs while a session holds a live run lease and a live recording lease
- **THEN** both rows are unchanged

#### Scenario: One failing session does not stop the tick
- **WHEN** freeing the expired recording lease of the first of two listed sessions fails
- **THEN** the sweeper logs a warning naming that session and still frees the second session's lease

#### Scenario: Ticks never overlap
- **WHEN** a tick is still running when the next interval elapses
- **THEN** no second tick starts until the first finishes
