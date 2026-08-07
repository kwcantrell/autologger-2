# event-metadata-reserved-keys — proposal

## Why

`POST /api/sessions/:sessionId/events` accepts arbitrary client metadata
(`z.record(z.unknown())`, size-capped only), so any client can stamp
`auto_generated: true` — flipping the Auto Generate menu to Regenerate All and
marking its rows for deletion by the next regenerate's snapshot sweep. Recorded
as a residual by the PR#4 review and again at the event-generate-hardening
panel; the owner elected to close it.

## What Changes

- The events POST SHALL **strip the reserved auto-generation keys**
  (`auto_generated`, `auto_generate_run_id`) from client-supplied metadata
  before storage — silently, no new 400 (the `session-title-suffix` D8
  ignore/strip precedent). Server-side writers are unaffected: the `create_event`
  MCP tool merges the keys after validation, and the sheets importer writes via
  the hub, not this route.
- No other route changes: the PUT body carries no metadata field (cannot spoof),
  and no WS write path exists.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `api-contract-freeze`: ADDED requirement — events POST reserved-metadata-key
  stripping (observable: stored/echoed metadata differs from what a stamping
  client sent).
- `auto-event-generation`: ADDED requirement — auto-generation attribution
  metadata is server-authoritative (only the generation run writes it).

## Contract impact

One observable change, authorized here: a client POSTing metadata containing the
reserved keys gets them stripped from the stored row (and from every subsequent
read). All other metadata keys pass through unchanged — except the existing
category-UI-snapshot keys, which the snapshot merge continues to overwrite as
today; the size cap is unchanged; no status-code changes.

## Non-Goals

- No general metadata schema/allowlist (client metadata stays free-form).
- No retroactive cleanup of already-stamped client rows (the next regenerate
  sweeps them by design).
- No PUT/WS surface changes.
- No change to the size cap or to server-side metadata writers.

## Impact

- `server/src/routers/events.ts` (POST handler strip), possibly a shared
  constant for the reserved keys next to the predicate; int/unit tests.
- No web/companion changes (no in-repo client sends non-empty metadata:
  verified — the only sender is `useRecoveryStopWarning` with `{}`).
- README events row note.
