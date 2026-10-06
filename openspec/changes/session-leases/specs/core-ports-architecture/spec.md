## ADDED Requirements

### Requirement: Recording leases are correct across processes
The recording lease SHALL be correct when several server processes share one database, without
relying on any one process's memory or timer (ADR 0021 slice 8a).

- **The stored expiry is the authority.** Every read of the lease and every claim SHALL judge it by
  its stored expiry against the Clock port, so a lease that no process has freed already reads as
  not alive and can be claimed.
- **Claims decide in the database.** A claim SHALL be one conditional statement, so two claims
  racing from different processes produce exactly one holder, even without the session row lock.
- **Any process frees an expired lease.** Its lease alarm, opening the session, or a takeover
  claim SHALL free it. Freeing SHALL happen once across processes: one row deleted, the revision
  advanced by one, and `lease.changed` broadcast by the process that freed it.
- **No dedicated sweeper.** A lease no process is looking at MAY stay stored after it expires. It
  still reads as not alive.

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
