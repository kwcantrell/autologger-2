## MODIFIED Requirements

### Requirement: Session sockets close when access is lost
When a grant revoke, a member removal, a leave, a demotion to `member` (team plane or support
plane) or a support-plane membership delete commits, the server SHALL close every
`/api/sessions/:id/ws` socket the affected user holds, in any server process sharing the
database (ADR 0021 slice 9a), on a session that user can no longer access, with close code `4403` (owner decision E, 2026-10-02). No other message is sent
on these sockets. A reconnect is refused like any upgrade for a session the caller cannot access
(the masked `404`). Sockets of other users, and the affected user's sockets on sessions they can
still access, SHALL stay open. This is new WebSocket emission semantics, authorized here.

#### Scenario: A revoked member's socket closes
- **WHEN** member M has a socket open on a session of show S and an admin revokes M's grant for S
- **THEN** M's socket closes with code `4403`, and M's next upgrade for that session is refused

#### Scenario: Other sockets stay open
- **WHEN** the same revoke commits while another member granted S and an admin have sockets open on
  that session
- **THEN** both stay open and keep receiving broadcasts

#### Scenario: A socket on another process closes
- **WHEN** member M has a socket open on a session of show S through process B, and an admin
  revokes M's grant for S through process A
- **THEN** M's socket on B closes with code `4403`

## ADDED Requirements

### Requirement: Session sockets close after live updates were interrupted
A server process's connection for receiving session frames can drop (ADR 0021 slice 9a). While it
is down, sockets attached to that process receive no frames. When the connection is
re-established after a loss, the process SHALL close every `/api/sessions/:id/ws` socket attached
to it at that moment with close code `1012`, once per loss, and SHALL send no other message on
those sockets. Frames committed while the connection was down are not replayed. A client recovers
them by reconnecting, which reads the current state as on any open, and the reconnect is admitted
as usual. This is new WebSocket emission semantics, authorized here.

#### Scenario: Sockets close when the frame connection comes back
- **WHEN** a browser has a socket open through process B, B's frame connection drops, and B
  re-establishes it
- **THEN** the socket closes with code `1012` once, and the browser's reconnect is admitted

#### Scenario: Frames resume after the reconnect
- **WHEN** the browser has reconnected to B after that close, and a write then commits through
  process A
- **THEN** the browser's socket on B receives that write's frame
