# web-session-console — delta (event-generate-hardening)

## MODIFIED Requirements

### Requirement: Event feed Auto Generate menu

The event feed Auto Generate control SHALL be a dropdown whose trigger label is
**Auto Generate** (or **Generating…** while a run for this session is pending).
The menu SHALL offer:

1. **Generate All** when the events list response reports
   `has_auto_generated: false`; **Regenerate All** when it reports `true`. The
   label SHALL derive from the server-computed `has_auto_generated` field of
   the events list response — never from scanning loaded rows — so it stays
   truthful for sessions whose auto rows lie beyond any client-side page or
   the server's list clamp. Until the events list response for the session is
   available, the first item SHALL read **Generate All** (the non-destructive
   default; a click in that window POSTs plain generate).
2. **Custom**, which opens a modal.

Generate All SHALL POST generate with no regenerate flag and no selection.
Regenerate All SHALL POST `{ regenerate: true }`. Existing 503 latch,
no-instructions gate, pending/outcome session scoping, and inline error
channels SHALL continue to apply to runs started from the menu.

#### Scenario: Menu flips to Regenerate All after auto events exist

- **WHEN** the session has at least one auto-generated row (reported via
  `has_auto_generated: true`)
- **THEN** the first menu item is labeled Regenerate All

#### Scenario: Auto rows beyond the loaded page still flip the label

- **WHEN** a session's only auto-generated rows lie beyond the rows the feed
  has loaded (e.g. past the 2000-row workspace clamp)
- **THEN** the first menu item is labeled Regenerate All, because the label
  reads the server-computed field rather than the loaded rows

#### Scenario: Loading state defaults to the non-destructive label

- **WHEN** the session's events list response has not yet arrived
- **THEN** the first menu item reads Generate All, and activating it POSTs
  plain generate (no `regenerate` flag)

#### Scenario: Custom opens modal without starting a run

- **WHEN** the operator chooses Custom
- **THEN** a selection modal opens and no generate request is sent until submit
