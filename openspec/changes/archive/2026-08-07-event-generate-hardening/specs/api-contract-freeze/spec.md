# api-contract-freeze — delta (event-generate-hardening)

## MODIFIED Requirements

### Requirement: events/generate optional body and deleted count

`POST /api/sessions/:sessionId/events/generate` SHALL accept an optional JSON
object body with:

- `regenerate` — optional boolean (default false)
- `selection` — optional array of objects `{ category_id: string,
  option_label?: string | null }`, bounded: at most 500 entries,
  `category_id` ≤ 200 characters, `option_label` ≤ 200 characters

Malformed bodies SHALL yield `400`, including bound violations. Combining
`regenerate: true` with a non-empty `selection` SHALL yield `400`. Success
response SHALL remain JSON `{ created: number, cap_hit: boolean }` and SHALL
include `deleted: number` when the request regenerated. When `regenerate` is
false/absent, `deleted` MAY be omitted. The regenerate delete
is **after-success**: prior auto rows are snapshotted by id pre-spawn, stay
readable (and keep appearing in `GET …/events`) for the whole run, and are
deleted in one transaction — emitting one existing `event.changed` broadcast
when at least one row was removed, and none otherwise — only after the CLI
turn succeeds **with at least one created event**, and before the
`200` is built; a `502` run deletes nothing, and a successful zero-created
regenerate deletes nothing and responds
`200 { created: 0, cap_hit: false, deleted: 0 }`. Existing status codes and
guard-ladder details for unconfigured / busy / no-transcript / etc. remain as
previously frozen unless superseded by the `auto-event-generation` delta.

#### Scenario: Absent body preserves Generate All

- **WHEN** a client POSTs generate with an empty body
- **THEN** behavior matches prior Generate All (no delete; full instruction set)
  and a `200` success body includes `created` and `cap_hit`

#### Scenario: Regenerate success includes deleted

- **WHEN** a client POSTs `{ "regenerate": true }` and the run succeeds
- **THEN** the `200` body includes `deleted` as a non-negative integer plus
  `created` and `cap_hit`

#### Scenario: Zero-created regenerate success deletes nothing

- **WHEN** a client POSTs `{ "regenerate": true }` and the CLI turn succeeds
  without creating any event
- **THEN** the response is `200 { created: 0, cap_hit: false, deleted: 0 }`
  and a subsequent `GET …/events` still returns the prior auto rows

#### Scenario: Regenerate failure leaves the contract surface truthful

- **WHEN** a client POSTs `{ "regenerate": true }` and the CLI turn fails
- **THEN** the response is the fixed opaque `502 {detail}`, no `event.changed`
  broadcasts were emitted beyond those of the run's own inserts, and a
  subsequent `GET …/events` still returns the prior auto rows

## ADDED Requirements

### Requirement: Events list has_auto_generated field

`GET /api/sessions/:sessionId/events` SHALL include `has_auto_generated`
(boolean) in its response envelope alongside the existing fields
(`events`, `total`, `logged_event_count`, `offset`, `limit`). The value SHALL
be computed over the **whole session's** events — not the returned page — and
SHALL be true exactly when at least one event's metadata carries
`auto_generated === true` (the same predicate the regenerate pre-spawn
snapshot uses).
The field is additive: no existing field's shape, order dependence, or
semantics changes.

#### Scenario: Auto rows beyond the returned page are reported

- **WHEN** a session's only auto-generated events lie outside the requested
  `limit`/`offset` window
- **THEN** the events list response carries `has_auto_generated: true`

#### Scenario: No auto rows

- **WHEN** a session has no event whose metadata carries
  `auto_generated === true`
- **THEN** the events list response carries `has_auto_generated: false`
