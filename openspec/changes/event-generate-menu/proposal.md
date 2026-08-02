# event-generate-menu — proposal

## Why

The event feed’s Auto Generate control is a single click that always appends a
full-show run. Operators need (1) a clear **Regenerate All** path that replaces
prior auto rows, and (2) a **Custom** path that runs only selected
instruction-bearing buttons/options — without deleting. The filter popover’s
selected-state highlight is also harder to scan than checkmarks.

## What Changes

- **Auto Generate menu** on the event feed: trigger stays labeled **Auto
  Generate**; menu items are **Generate All** or **Regenerate All** (depending
  on whether the session already has any `auto_generated` events) and **Custom**.
- **Regenerate All**: server deletes all session events with
  `metadata.auto_generated === true`, then runs the existing generate pipeline
  over the full instruction-bearing set (atomic with the run after guards +
  slot acquire).
- **Custom**: modal to select instruction-bearing **button-level** and
  **per-dropdown-option** instructions; POST generate with a `selection` body;
  **never deletes**.
- **API**: optional JSON body on `POST …/events/generate`
  (`regenerate`, `selection`); response may include `deleted` when regenerating.
- **Filter popover**: checkmarks for selected categories (no selected tint).

## Capabilities

### New Capabilities

- (none — extends existing auto-generate + console surfaces)

### Modified Capabilities

- `auto-event-generation`: authorize regenerate-via-delete and selection-filtered
  runs; relax pure append-only for the regenerate path only.
- `api-contract-freeze`: optional generate body + optional `deleted` on response.
- `web-session-console`: Auto Generate dropdown, Custom modal, filter checkmarks.

## Impact

- **Server**: generate route body parsing, bulk auto-delete hub helper, selection
  filter on snapshot/prompt, tests, README if body is documented.
- **Web**: `EventLogSheet` menu + Custom modal, `useGenerateEvents` body, filter
  UI, tests.
- **Contract**: yes — generate request/response and regenerate delete semantics.
- **DB**: no schema change.

## Non-Goals

- Client-side delete-then-generate for Regenerate All.
- Custom regenerate/delete of a subset.
- Deleting manual (non-auto) events.
- Changing Generate All / Custom append + model-dedup behavior.
- Bundling `session-title-suffix` apply in this change.
