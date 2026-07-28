## ADDED Requirements

### Requirement: Admin users page renders team memberships from the frozen response shape

The `/admin/users` page SHALL read each user's team memberships from the `studios` field of
the `GET /api/admin/users` response — an array of `{id, name}` objects — and SHALL NOT depend
on any field the server does not send.

Rendering a user row SHALL NOT throw for any response the endpoint emits. The emitted variants
this covers are: a user with one or more memberships; a user with zero memberships; a membership
whose `name` equals its `id` (the handler's `names[m] ?? m` fallback for an orphaned team); and
a user whose `given_name`/`family_name` are empty strings.

The page's client-side type for a user SHALL match the fields the server actually emits. That
match is verified per the `web-api-response-conformance` capability — this requirement states
*what must be true*, not the mechanism that proves it.

#### Scenario: A user with memberships renders

- **WHEN** the operator loads data and the response contains a user whose `studios` is
  `[{id: "my-crew", name: "My Crew"}]`
- **THEN** the user's row renders with one membership chip
- **AND** the page does not throw and the React root stays mounted

#### Scenario: A user with no memberships renders

- **WHEN** the response contains a user whose `studios` is `[]`
- **THEN** the user's row renders with no membership chips and no error
- **AND** the add-membership control is still offered for that user

#### Scenario: The previously-crashing shape no longer unmounts the page

- **WHEN** the operator clicks "Load data" against a response in the frozen shape that
  contains at least one user
- **THEN** no uncaught `TypeError` is raised
- **AND** the users table is present in the document

#### Scenario: A membership whose name equals its id renders

- **WHEN** a user's `studios` contains `{id: "ghost", name: "ghost"}` — the handler's fallback
  for a team with no catalog entry
- **THEN** the chip renders that value without error

### Requirement: Membership chips are labelled with the team display name

Each membership chip SHALL display the team's human-readable `name` from the response rather
than its slug `id`. The chip's remove control SHALL be addressable by an accessible name of the
form `Remove from <name>`, using the same display name the chip shows, while the request it
issues SHALL be keyed by the team `id`.

#### Scenario: Chip shows the display name

- **WHEN** a user's `studios` contains `{id: "my-crew", name: "My Crew"}`
- **THEN** the chip's visible label is `My Crew`

#### Scenario: Remove control identifies its team by name and acts by id

- **WHEN** a membership chip for `{id: "my-crew", name: "My Crew"}` is rendered
- **THEN** the chip carries a remove control whose accessible name is `Remove from My Crew`
- **AND** activating it issues the membership-removal request for team id `my-crew`

### Requirement: Add-membership control offers only teams the user is not already in

The add-membership control SHALL offer exactly the teams from the response's studio catalog
that are absent from that user's `studios`, compared by team `id`. Membership comparison SHALL
NOT rely on object identity or on comparing an object to a bare id.

#### Scenario: Existing memberships are excluded from the offered set

- **WHEN** the catalog holds `my-crew` and `ymhs`, and the user's `studios` holds `my-crew`
- **THEN** the add-membership control offers `ymhs` only

#### Scenario: A user in every team is offered nothing

- **WHEN** the user's `studios` covers every team in the catalog
- **THEN** the add-membership control offers no teams

### Requirement: Admin users page has regression coverage

The `/admin/users` page SHALL carry automated tests exercising membership rendering, the
offered-teams filter, and the remove-membership request path.

The fixture those tests render SHALL be the response **captured** from the live
`GET /api/admin/users` handler under the `web-api-response-conformance` capability — not a
hand-authored approximation of it. This is the load-bearing clause: a hand-written fixture can
restate the client's own incorrect belief and pass while the page is broken in production, which
is exactly what happened here.

#### Scenario: Admin page tests render the captured response

- **WHEN** the admin-page tests run
- **THEN** the response they render is the captured `GET /api/admin/users` fixture
- **AND** the fixture is the same artifact the conformance check validates the client type
  against
