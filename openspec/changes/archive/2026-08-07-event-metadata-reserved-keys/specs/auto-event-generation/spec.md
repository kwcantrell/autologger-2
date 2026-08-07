# auto-event-generation — delta (event-metadata-reserved-keys)

## ADDED Requirements

### Requirement: Auto-generation attribution metadata is server-authoritative

The `auto_generated` and `auto_generate_run_id` metadata keys SHALL be
introduced only by the generation run itself (the `create_event` tool's
server-side merge). The events POST SHALL strip them from client input (see
the `api-contract-freeze` delta), so the auto predicate — and everything
derived from it (`has_auto_generated`, the Regenerate label, the regenerate
snapshot sweep) — reflects only server-attributed rows going forward.
Carrying existing stored attribution through an update is preservation, not
writing: `PUT …/events/:eventId` accepts no client metadata field and
re-persists the row's existing metadata, so an edited auto-generated row
SHALL retain its reserved keys unchanged (and remains subject to a later
regenerate sweep). Rows
stamped by clients before this change are NOT retroactively cleaned; a
regenerate's snapshot sweep still removes any predicate-matching row.

#### Scenario: Client cannot flip the Regenerate label

- **WHEN** a client POSTs an event stamping `auto_generated: true` and no
  other predicate-matching rows exist in the session
- **THEN** the stored row does not match the auto predicate and the events
  list response reports `has_auto_generated: false`

#### Scenario: Editing an auto row preserves its attribution

- **WHEN** a client PUTs an edit to a generation-created event
- **THEN** the stored row still matches the auto predicate and remains
  subject to a later regenerate sweep
