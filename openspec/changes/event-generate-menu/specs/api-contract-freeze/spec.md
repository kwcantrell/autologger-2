## ADDED Requirements

### Requirement: events/generate optional body and deleted count

`POST /api/sessions/:sessionId/events/generate` SHALL accept an optional JSON
object body with:

- `regenerate` — optional boolean (default false)
- `selection` — optional array of objects `{ category_id: string,
  option_label?: string | null }`

Malformed bodies SHALL yield `400`. Combining `regenerate: true` with a
non-empty `selection` SHALL yield `400`. Success response SHALL remain JSON
`{ created: number, cap_hit: boolean }` and SHALL include `deleted: number`
when the request regenerated (auto rows were cleared before generate). When
`regenerate` is false/absent, `deleted` MAY be omitted. Existing status codes
and guard-ladder details for unconfigured / busy / no-transcript / etc. remain
as previously frozen unless superseded by the `auto-event-generation` delta.

#### Scenario: Absent body preserves Generate All

- **WHEN** a client POSTs generate with an empty body
- **THEN** behavior matches prior Generate All (no delete; full instruction set)
  and a `200` success body includes `created` and `cap_hit`

#### Scenario: Regenerate success includes deleted

- **WHEN** a client POSTs `{ "regenerate": true }` and the run succeeds
- **THEN** the `200` body includes `deleted` as a non-negative integer plus
  `created` and `cap_hit`
