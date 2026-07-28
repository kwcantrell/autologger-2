# Delta: api-contract-freeze — code-health-tail

One documentation-of-frozen-behavior delta. No observable behavior changes: this pins
an existing, reachable frozen edge in the baseline spec so it cannot later be removed
as apparent dead code.

## ADDED Requirements

### Requirement: Event update strips UI snapshots for profile-defined internal category

`PUT /api/sessions/:sessionId/events/:eventId` SHALL reject (`400`) any category that
is not defined in the studio profile, and — when the studio profile defines a category
whose id case-insensitively equals `internal` — SHALL strip category UI snapshots from
the event metadata before persisting, exactly as it does today. This asymmetry with
event creation (POST admits the built-in `internal` category even when the profile does
not define it; PUT requires profile membership first) is deliberate, frozen behavior.
The snapshot-stripping branch is reachable (a studio profile MAY define a category with
id `internal` — category-id validation reserves no ids) and MUST NOT be removed as dead
code.

#### Scenario: Profile-defined internal category strips snapshots on update

- **WHEN** a studio profile defines a category with id `internal` (any letter case) and
  a client PUTs an event update carrying that category
- **THEN** the update is accepted and category UI snapshots are stripped from the
  event's metadata, matching current published behavior

#### Scenario: Non-profile category still rejected on update

- **WHEN** a client PUTs an event update whose category is not defined in the studio
  profile (including `internal` when the profile does not define it)
- **THEN** the response is the existing `400`, unchanged
