# Autogenerate after a YouTube playlist import

Tier: 2
Tier reason: raised from 1 by the orchestrator and owner after the panel (risk-tier "pick the
higher"). No path in `lifecycle.high_risk_paths` and no contract change: the browser calls the
existing batch autogenerate, preview and provider-status routes unchanged. But one confirm commits
unattended paid spend on the user's own providers (up to 1000 sessions × 4 steps) that starts
hours later with no second prompt, the change fixes an ordering guarantee (the job starts only
after every import part, design D3) and a no-retry rule for a start whose outcome may be unknown
(design D5).

Panel: tier 2, 2026-11-12: the assumption tester (4 major) and then the failure-and-abuse and
scope-and-simplicity reviewers (6 major), each finding resolved in the artifacts (`panel.md`).

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

5. **Sessions this import brought in count** (owner, 2026-11-12, confirmed). Besides sessions
   this run created and filled, two more qualify: (1) a session an earlier run of this import
   created and left without audio, which this run imports into and completes; (2) on a rerun, this
   import's own remembered session that already has audio from an earlier, interrupted run of this
   import (closed mid-import, or an unknown outcome that landed later), which is skipped as
   "already in system" but qualifies and is then forgotten. Part (2) was proposed by the
   orchestrator after tier-2 panel finding C; the owner briefly reversed both parts the same day
   (be01b3d0), then corrected that as a misread and confirmed both (revert of be01b3d0).
6. **Warn about a live job at confirm** (owner, 2026-11-12, answering design Q2). When Start Import
   opens the confirm, the modal reads the team's jobs (existing
   `GET /api/teams/:teamId/autogenerate-jobs`); if one is `queued` or `running`, the confirm warns
   that autogenerate will not start unless that job has finished by the end of the import. It only
   warns: the user may still start, and the end-of-run `409` line still applies. If the read fails,
   no warning and no block.

Implementation preference (owner): the browser calls the existing HTTP routes; no new route and no
contract change.

## What changes

- **Checkbox and options** in the Batch Import modal, beneath the playlist picker, only when a
  playlist is loaded and the user manages the active team: "Autogenerate after import" (unticked
  by default), and while ticked the step checkboxes and the wiki mode radio, shared with Settings
  through one extracted options component and model (labels, run order, blocked texts, confirm
  wording). The Settings section renders the same component; its behavior does not change.
- **Arming.** The options apply only while the group is shown, ticked and at least one entry is
  checked; hiding the group (new link, failed listing, no playlist) unticks it and resets them.
- **Up-front check.** While armed, the modal asks the existing preview route, over the run's show,
  whether the user could start a job with those steps now (`blocked`). Only that exact `200`
  answer for the current selection blocks Start Import, and Start Import waits while it is pending
  (no stale answer). When the preview cannot answer (a show with no sessions yet, or over 1000), a
  non-blocking warning is derived from the user's provider status (`GET /api/me/providers`, which
  Settings → Advanced already reads). After the confirm the current verdict is checked again.
  Start Import is also disabled while armed with no step, or with more than 1000 videos checked
  (the job's session cap).
- **Runs are not dropped by accident.** While a run is in progress the modal ignores Escape and
  clicks outside it; the Close button still aborts.
- **Confirm.** Start Import with the box ticked reads the team's job list, then opens a themed
  confirm: a warning first when the team has a live job (owner decision 6), the number of checked
  videos, "then autogenerate on up to N sessions, at most N × S runs", the own-provider-accounts
  note and, in auto-accept mode, Settings' wiki warning. Cancel starts nothing.
- **End-of-run start.** The playlist runner reports each session it completes; after the last part
  of Start Import (folder, playlist, logs) the modal previews the job with exactly those
  `session_ids` and starts it with the preview's `sessions` as `expected_sessions`, provided the
  signed-in user is still the one who confirmed. If a session vanished (`404`), it re-scopes once
  to the sessions still listed and logs how many it left out. One progress line reports the result: started (with the session count and a pointer to Settings → Batch
  autogenerate), or why not (no qualifying session, a live job for the team, blocked, refused, or a
  network failure whose outcome is unknown), each pointing to Settings → Batch autogenerate.
- **Docs**: the README "YouTube audio import" section gains a sentence on the checkbox.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `batch-audio-import`: MODIFIED "Batch Import modal layout and actions" (the group's place, the
  narrowed Start Import enable rule while armed, the confirm before the run, the autogenerate start
  after the log part, no Escape/overlay close during a run), written against the text `youtube-playlist-import` synced into `openspec/specs/`
  (archive PR #144); ADDED "YouTube playlist import can autogenerate afterwards" (the checkbox, its options
  and visibility, the up-front check, the confirm, the qualifying sessions, the end-of-run start and
  its progress lines).

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

None. The modal reads `GET /api/me/providers` (api-contract-freeze "Provider credential routes")
through the existing `useProviders` hook and `GET /api/teams/:teamId/autogenerate-jobs` through the
existing `useAutogenerateJobs` hook, and calls `POST /api/teams/:teamId/autogenerate-jobs/preview` and
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
- Base: main 7e6a642d, which has `youtube-playlist-import` (#139) and `batch-autogenerate` (#140)
  merged and archived (#144, `openspec/changes/archive/2026-11-11-*`), their specs synced into
  `openspec/specs/`; the MODIFIED requirement is written against that synced text.
