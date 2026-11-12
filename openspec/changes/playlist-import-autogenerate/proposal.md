# Autogenerate after a YouTube playlist import

Tier: 1
Tier reason: a web-only feature (`web/src/pages/index/**`, `web/src/api/hooks/**`) that calls the
existing, already frozen batch autogenerate routes (preview and start, `session_ids` scope)
unchanged; no route, body, status, migration, server or `packages/contract/**` change, no path in
`lifecycle.high_risk_paths`, and authorization stays the server's (the start route's owner/admin,
approved-user and provider checks); the checkbox's visibility is a convenience, not a gate.

## Why

A YouTube playlist import (change `youtube-playlist-import`, in main) creates dozens or hundreds of
sessions with audio and nothing else. Batch autogenerate (change `batch-autogenerate`, merged in
#140) fills transcripts, events, topics and wiki, but today an owner has to go to Settings
afterwards and pick the show, which also sweeps every other session of that show. Its proposal
("Follow-up: autogenerate after import") assigns the playlist import's "autogenerate after import"
checkbox to a small follow-up change named `playlist-import-autogenerate`, since
`youtube-playlist-import` merged first. This is that change.

## Owner decisions (owner, 2026-11-11; fixed)

1. **One job at the end of the run**, over only the sessions this run created and attached audio
   to (its successful imports). Videos skipped as "already in system" and failed videos are
   excluded. If no session qualifies, no job is started and a progress line says so.
2. **Options under the checkbox**: the Settings section's step checkboxes (Transcripts, Log
   events, Topics, Wiki) and wiki mode, defaulting to all four steps and "Add new pages and
   additions to the wiki". Reuse the Settings section's components and model.
3. **One confirm, up front.** Start Import with the box ticked first shows a themed confirm with
   the run estimate (checked videos × chosen steps, worded like Settings). No second prompt: the
   job starts by itself when the import ends. Every way the start can fail is a progress line; the
   import's own result is never affected. Closing the modal (abort) starts no job.
4. **Owners and admins only.** The checkbox is shown only to an owner or admin of the selected
   show's team (the start route refuses everyone else); members never see it.

Implementation preference (owner): the browser calls the existing HTTP routes; no new route and no
contract change.

## What changes

- **Checkbox and options** in the Batch Import modal, beneath the playlist picker, only when a
  playlist is loaded and the user manages the active team: "Autogenerate after import" (unticked
  by default), and while ticked the step checkboxes and the wiki mode radio, shared with Settings
  through one extracted options component and model (labels, run order, blocked texts, confirm
  wording). The Settings section renders the same component; its behavior does not change.
- **Up-front check.** While ticked, the modal asks the existing preview route, over the run's show,
  whether the user could start a job with those steps now (`blocked`); a blocked reason is shown in
  Settings' words and Start Import is disabled until the user changes the steps or unticks the box.
  Start Import is also disabled while ticked with no step, or with more than 1000 videos checked
  (the job's session cap).
- **Confirm.** Start Import with the box ticked opens a themed confirm: the number of checked
  videos, "then autogenerate on up to N sessions, at most N × S runs", the own-provider-accounts
  note and, in auto-accept mode, Settings' wiki warning. Cancel starts nothing.
- **End-of-run start.** The playlist runner reports each session it completes; after the last part
  of Start Import (folder, playlist, logs) the modal previews the job with exactly those
  `session_ids` and starts it with the preview's `sessions` as `expected_sessions`. One progress
  line reports the result: started (with the session count and a pointer to Settings → Batch
  autogenerate), or why not (no qualifying session, a live job for the team, blocked, refused, or a
  network failure whose outcome is unknown), each pointing to Settings → Batch autogenerate.
- **Docs**: the README "YouTube audio import" section gains a sentence on the checkbox.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `batch-audio-import`: ADDED "YouTube playlist import can autogenerate afterwards" (the checkbox,
  its options and visibility, the up-front check, the confirm, the qualifying sessions, the
  end-of-run start and its progress lines). An ADDED requirement, not a MODIFIED one, so this
  delta does not collide with `youtube-playlist-import`'s still-unarchived MODIFIED "Batch Import
  modal layout and actions".

## Non-goals

- No new route, no change to any route's body, status or wording, no server or contract change,
  no WebSocket message, no server-side import job.
- No autogenerate for the folder (Import Audio) or log parts of Start Import; only playlist
  sessions qualify.
- No retry or queueing when the team already has a live job: the run logs it and the owner starts
  one from Settings later (gap-fill makes that safe).
- No progress or report of the job inside the modal: Settings → Batch autogenerate shows it.
- No change to the Settings section's behavior; only its step and wiki-mode controls move into a
  shared component.
- No member-facing autogenerate, even for shows a member holds a grant on.

## Contract impact

None. The modal calls `POST /api/teams/:teamId/autogenerate-jobs/preview` and
`POST /api/teams/:teamId/autogenerate-jobs` exactly as specified by api-contract-freeze "Batch
autogenerate endpoints" (batch-autogenerate), with the `session_ids` scope that change added for
this purpose. Both client types are already fixture-checked.

## Impact

- `web/src/pages/index/components/BatchImportModal.tsx` (checkbox, options, up-front check,
  confirm, end-of-run start).
- `web/src/pages/index/batchImport/playlistRunner.ts` (reports each completed session id).
- New `web/src/pages/index/batchImport/autogenerateAfterImport.ts` (the end-of-run preview + start
  and its progress line).
- New shared `web/src/pages/index/components/autogenerate/` (options component and model) used by
  the modal and by `settings/BatchAutogenerateSection.tsx`.
- `web/src/api/hooks/useAutogenerateJobs.ts` (the modal's preview use; possibly a plain
  `previewAutogenerateJob` / `startAutogenerateJob` fetch pair shared with the hooks).
- Tests beside each file; `web/src/apiResponseShapes.repo.test.ts` verdicts if a new parse site
  is not covered by an existing fixture assignment.
- README "YouTube audio import".
- Base: main 1902e271, which has both `youtube-playlist-import` (#139) and `batch-autogenerate`
  (#140); both change dirs are still unarchived, so their spec deltas are read from
  `openspec/changes/`.
