## MODIFIED Requirements

### Requirement: Wall-clock time is read through a single Clock port

Every decision-making time read SHALL obtain the current time from a single injected
synchronous `Clock` port rather than calling `Date.now()` directly — covering
recording-lease staleness/expiry and alarm scheduling, session live-timecode derivation,
key/value TTL expiry (login sessions, OAuth CSRF), Companion presence freshness, the
identity JWKS cache TTL, and the log-import job store's terminal-job TTL and finished-at
stamping. The lease **alarm scheduler and the clock SHALL share one time
base**, so an alarm scheduled from clock time and an expiry check reading clock time cannot
diverge (no real-`setTimeout`-vs-fake-clock skew).

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

Two `Date.now()` sites are **known standing exceptions**, neither created nor closed by this
change: one in package production code — `SessionHub`'s `DEFAULT_CLOCK` fallback, which never
fires on the production path and is deliberately local so the hub does not depend on the
composition root — and one in the app — the AI runtime's process-group kill ladder
(`server/src/ai-runtime/processGroupKill.ts`), whose polling deadline is control-flow-bearing
and therefore *not* exemptible — it is owned by the change that packages the AI runtime, which
must give it a Clock port before it can ship in a package.

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
- **WHEN** the server source **and the workspace packages under `packages/`** are inspected for direct `Date.now()` calls in staleness, TTL, expiry, freshness, alarm-scheduling, or live-timecode logic
- **THEN** none remain; those paths read the injected `Clock` (the `systemClock` implementation, which lives with the composition root, is the sole sanctioned `Date.now()` site **for decision-making reads**; the standing exceptions named in this requirement are the only others)

#### Scenario: Job lifecycle expiry is testable without real elapsed time
- **WHEN** a test creates log-import jobs through the injected clock, drives some to a terminal status, advances the clock past the terminal-job TTL, and then reads a job back
- **THEN** the expired terminal jobs are pruned and the jobs that are still queued or running survive, without any real time passing

#### Scenario: Size-cap eviction is unchanged and reads no time
- **WHEN** the job store exceeds its size cap
- **THEN** eviction removes terminal jobs in map insertion order and never a queued or running job — behavior that depends on no time value and is exercised by exceeding the cap rather than by advancing a clock

#### Scenario: Job status observed through the app is unchanged
- **WHEN** a log-import job is created, progresses, and reaches a terminal status through the real app after the clock is injected
- **THEN** the status endpoint's JSON shape, status codes, and creator-scoping behavior are identical to before the change, and no job time value is observable on the wire (`systemClock` reads the same source the direct call did)
