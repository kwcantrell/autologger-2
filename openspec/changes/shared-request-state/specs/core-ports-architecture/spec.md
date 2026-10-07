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

`transcriptGenerationLock.tryAcquire`'s `startedAtMs` is such a read: the lock never expires
by time and is cleared in a `finally`, nothing branches on the value, and it is serialized
as the frozen `started_at` field — which makes converting it a contract risk taken for no
requirement.

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
