# event-generate-hardening — proposal

## Why

The PR#4 review recorded three `events/generate` residuals whose fixes are contract
changes and were therefore deliberately NOT fixed in the review's fix waves:

1. **Untruthful Regenerate labeling on long sessions.** The web derives the
   Generate All ↔ Regenerate All menu label by scanning the workspace-wide events
   query, which the server clamps to 2000 rows (oldest-first). A session whose only
   `auto_generated` rows sit beyond the first 2000 shows **Generate All** — and a
   click silently re-appends instead of offering the destructive-confirm regenerate
   path the operator expects.
2. **Regenerate loses data on a failed run.** `regenerate: true` bulk-deletes the
   prior auto rows *before* the CLI spawns; a failed or crashed run leaves the
   session with the old set gone and only whatever partial new rows landed. This
   inverts the repo's own crash-safe-swap precedent (`topics/generate` never touches
   the prior set until the fresh one exists) — recorded as a roadmap item at the
   event-generate-menu gate.
3. **Unbounded request strings.** The generate body's `selection` array, its
   `category_id`, and `option_label` strings have no length bounds — a request can
   carry arbitrarily large payloads through zod into snapshot filtering. Bounds were
   deliberately not added in the fix waves because new 400s are a contract change.

## What Changes

- **`GET /api/sessions/:sessionId/events` response gains `has_auto_generated`**
  (boolean, server-computed over the whole session, not the returned page). The web
  Auto Generate menu label derives from this field instead of scanning loaded rows —
  truthful at any session size. Additive field; existing consumers unaffected.
- **`POST …/events/generate` with `regenerate: true` becomes delete-after-success:**
  the prior auto rows' ids are snapshotted pre-spawn, *excluded from the run's
  existing-events enumeration* (so the model regenerates rather than "dedups"
  against doomed rows), and deleted transactionally only after the CLI turn
  succeeds **and creates at least one event** — before the 200 is built. A clean
  run that creates nothing keeps the prior set
  (`200 {created: 0, cap_hit: false, deleted: 0}`). A failed run (502) leaves the
  prior set
  intact (plus any partial new rows, matching the existing append-failure
  semantics); a subsequent regenerate cleans both up. `deleted` keeps its meaning
  (count of prior-set rows removed) but now reflects the post-success delete.
  **BREAKING (observable timing):** mid-run readers now see the old rows until
  success; the pre-run delete broadcast disappears in favor of one post-success
  delete broadcast.
- **Generate body bounds:** `selection` array length, `category_id` length, and
  `option_label` length gain zod maxima; violations return the existing malformed
  `400 {detail}`. Values chosen in design (aligned with sibling schema bounds).
  These harden the post-parse path only — body-size limiting stays out of scope.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `api-contract-freeze`: MODIFIED "events/generate optional body and deleted count"
  (bounds → 400; delete-after-success timing/broadcast semantics); ADDED requirement
  for the events list `has_auto_generated` field.
- `auto-event-generation`: MODIFIED "Optional generate body for regenerate and
  selection" (bounds; delete-after-success ordering; enumeration exclusion; failure
  semantics).
- `web-session-console`: MODIFIED "Event feed Auto Generate menu" (label source
  becomes the server-computed `has_auto_generated`, truthful beyond the 2000-row
  clamp).

## Contract impact

All three items are observable HTTP contract changes — that is the point of this
change; each is authorized by the delta specs above. Specifically: one additive
response field on the events list; new 400-producing bounds on an existing body;
changed regenerate delete timing (broadcast ordering + mid-run read visibility +
failure-path persistence). No WS message *shapes* change (the delete still emits the
existing `event.changed`); only when the delete's broadcast fires moves.

## Non-Goals

- No change to Generate All / Custom (non-regenerate) behavior — append semantics,
  cap, prompt shape, and success shape stay byte-identical.
- No pagination redesign and no raising of the 2000-row events clamp.
- No retroactive cleanup of duplicate rows from historic failed regenerates.
- No new WS message types and no SSE surface.
- No web redesign of the Auto Generate menu beyond its label's data source and the
  regenerate confirm-dialog copy (which must stop claiming delete-before).
- The other recorded residuals (ytImportPending Stop tile, RecentSessionsList
  polling) stay out of scope.

## Impact

- `server/src/schemas.ts` (bounds), `server/src/routers/events.ts` (route flow,
  enumeration exclusion, delete-after-success, events list envelope),
  `server/src/session/SessionHub.ts` + `server/src/session/eventStore.ts` (id-set
  delete RPC, has_auto_generated computation), server int/unit tests.
- `web/src/api/types.ts` (`EventsResponse.has_auto_generated`),
  `web/src/pages/index/components/EventLogSheet.tsx` (label source), web tests.
- `README.md` endpoint table rows for `…/events` and `…/events/generate`.
- No companion/ impact (it does not consume these routes' changed fields).
