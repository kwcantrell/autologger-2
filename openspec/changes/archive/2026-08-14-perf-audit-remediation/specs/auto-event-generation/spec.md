# auto-event-generation — delta

## MODIFIED Requirements

### Requirement: Per-button generation instructions persist on the show
Each event button (a show `categories[*]` entry) of type BUTTON, DROPDOWN, or TEXT
SHALL carry an optional `auto_instruction` string field (trimmed; ≤ 2000 chars;
absent/empty means no button-level instruction). Each DROPDOWN option (a
`dropdown_options[*]` entry) SHALL likewise carry an optional `auto_instruction`
(same bounds). ON_OFF buttons SHALL NOT carry the field (a value arriving on one is
dropped by normalization, not an error). The fields SHALL persist through the existing
show-update path (profile update `show_updates[*].categories`) — including through the
server's category normalization, which today rebuilds categories/options from fixed
field sets and would silently strip unknown keys — and SHALL round-trip verbatim on the
show reads that carry categories.

The write path is unchanged: instructions are still saved via `PUT /api/profile`
`show_updates[*].categories`. The **read** path is not `GET /api/profile`:
`perf-audit-remediation` slimmed profile `shows[]` to `{id, studio_id, name, show_code,
title_suffix}`, so profile carries no `categories` and therefore no `auto_instruction` at
all. The full show configuration — categories, options, and their instructions — SHALL be
read from `GET /api/shows?studio_id=…` and `GET /api/shows/:showId`, both of which emit the
full show serializer. The session-scoped `GET …/show-categories` route is untouched by that
slimming.

Bound violations SHALL be rejected with the same validation-error
mechanics as other category-field violations (the existing 200-char label checks in
category normalization). The session `GET …/show-categories` response SHALL carry one
additive top-level boolean, `auto_instructions_present` (true iff any category of the
session's show is instruction-bearing) — the shared category projection itself is NOT
extended. These additive shape changes are authorized by this delta. The Companion
`categories` response SHALL NOT change.

#### Scenario: Instruction round-trips through settings save
- **WHEN** a user saves a button with `auto_instruction` "log every time someone says
  'slate'" and a dropdown option with its own `auto_instruction` via `PUT /api/profile`
  `show_updates[*].categories`
- **THEN** a subsequent read of `GET /api/shows?studio_id=…` or `GET /api/shows/:showId`
  returns both fields verbatim on that show's category and option entries

#### Scenario: Profile carries no instruction fields to round-trip
- **WHEN** a client reads `GET /api/profile` after saving instructions
- **THEN** the `shows[]` entries carry no `categories` and therefore no
  `auto_instruction` — profile is not the read path for instructions, and its absence there
  is not a persistence failure

#### Scenario: Over-long instruction is rejected
- **WHEN** a show update carries an `auto_instruction` longer than 2000 chars
- **THEN** the update is rejected with the same validation error mechanics as an
  over-long category label, and nothing is persisted

#### Scenario: Feed client learns instruction presence; Companion unchanged
- **WHEN** a session's show has at least one instruction-bearing button
- **THEN** `GET …/show-categories` returns `auto_instructions_present: true`, its
  `categories` entries carry no instruction fields, and the Companion categories
  response is byte-shape identical to today
