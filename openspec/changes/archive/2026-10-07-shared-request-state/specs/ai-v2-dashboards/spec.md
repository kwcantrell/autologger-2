## MODIFIED Requirements

### Requirement: Design question round trip
During a design turn the agent MAY ask the requesting user a question. A question SHALL be
delivered only to the client that initiated that turn and SHALL NOT be broadcast to other clients
attached to the session.

Answers SHALL be submitted to a dedicated endpoint which SHALL evaluate the same guard chain as
the design endpoint, masking an inaccessible session as `404`. An answer SHALL be accepted only
when its identifiers belong to a question currently pending for that session and that turn **and
the answering principal is the same principal that initiated the turn** — access to the session
alone SHALL NOT authorize answering another user's question, because an answer determines what is
built and stored. Turn and request identifiers SHALL be generated with at least 128 bits of
entropy, so that guessing is not the operative defense. Authentication mechanisms that do not
identify an individual principal SHALL NOT be accepted on these routes.

An answer for a turn that is no longer in flight SHALL be rejected without effect, and a pending
entry SHALL be deleted when its turn ends by any path, so it cannot be resolved late.

A pending question SHALL be recorded in the catalog's key-value store (its owner, its question
count, and an expiry at the turn's deadline: the turn's start plus its timeout, plus 5 s), so the
answer endpoint on any server process sharing the database can validate and accept it (ADR 0021
slice 9b). The record SHALL be stored before the question is delivered to the client; a question
whose record cannot be stored SHALL be denied to the agent and SHALL NOT be delivered. Accepting
an answer SHALL be one atomic compare-and-swap on that record, so of two concurrent answers to one
question exactly one is accepted. The process running the turn SHALL pick up an accepted answer
within one second. One exception to rejecting late answers is accepted: when the process running
the turn stops without ending it, an answer posted before the turn's deadline is accepted with
`200` and has no effect, because no process remains to delete the record.

An unanswered question SHALL NOT hold a turn open indefinitely. When the requesting client
disconnects or the turn times out, the pending question SHALL be abandoned, the turn SHALL end,
its child process SHALL be terminated, and its concurrency slot SHALL be released.

#### Scenario: A question reaches only the asking client
- **WHEN** a design turn asks a question and other clients are attached to the session
- **THEN** only the client that initiated the turn receives it

#### Scenario: A foreign answer is rejected
- **WHEN** an answer carries a turn or request identifier belonging to a different session or turn
- **THEN** it is rejected and the pending question remains unanswered

#### Scenario: A co-member cannot answer another user's question
- **WHEN** a different authenticated user with access to the same session submits an otherwise
  valid answer to a question pending for another user's turn
- **THEN** it is rejected and the question remains pending

#### Scenario: A late answer is rejected
- **WHEN** an answer arrives for a turn that has already ended
- **THEN** it is rejected without effect

#### Scenario: An abandoned question does not wedge the session
- **WHEN** a question is pending and the requesting client disconnects
- **THEN** the turn ends, its child is terminated, and its concurrency slot is released

#### Scenario: An answer through another process reaches the turn
- **WHEN** a design turn runs through process A, asks a question, and its initiator posts the
  answer through process B
- **THEN** B responds `200 { ok: true }` and the turn on A continues with that answer within one
  second

#### Scenario: Two answers to one question accept one
- **WHEN** the initiator posts two answers to the same pending question at once, through two
  processes
- **THEN** exactly one is accepted with `200`, and the other gets the masked `404`
