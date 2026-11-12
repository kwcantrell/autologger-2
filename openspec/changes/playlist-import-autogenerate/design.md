# Design

## Context

See proposal.md (Why, owner decisions). Base: main 7e6a642d, where youtube-playlist-import (#139)
and batch-autogenerate (#140) are merged and archived (#144, `openspec/changes/archive/2026-11-11-*`)
and their specs are synced into `openspec/specs/`. The MODIFIED "Batch Import modal layout and
actions" restates the synced `openspec/specs/batch-audio-import/spec.md` text with this change's
additions.

- The playlist import is a browser loop (`web/src/pages/index/batchImport/playlistRunner.ts`,
  `runPlaylistImport`), driven by `BatchImportModal.tsx` Start Import after the folder part and
  before the log part. It returns nothing; it reports whole progress states and logs
  `Completed <name>` at its two success points.
- Batch autogenerate's preview and start routes already accept a `session_ids` scope (added by
  batch-autogenerate for this follow-up). The start requires `expected_sessions`, re-resolves the
  scope in its transaction and refuses with the frozen statuses (batch-autogenerate
  api-contract-freeze delta). The web already has client types, fixtures and hooks for both
  (`web/src/api/hooks/useAutogenerateJobs.ts`).
- Settings → Batch autogenerate (`settings/BatchAutogenerateSection.tsx`) holds the step list,
  labels, wiki mode labels, blocked texts and confirm wording as module-local constants and inline
  JSX.

## Goals / Non-Goals

**Goals:** one end-of-run job over exactly this run's successful playlist imports, started from
the browser over the existing routes, with one confirm up front and every refusal reduced to one
progress line; the step/wiki options shared with Settings rather than copied.

**Non-Goals:** see proposal.md Non-goals. In design terms: no change to `runPlaylistImport`'s
skip/create/import/wait logic or its lines, no server code, no new query keys beyond what the
preview hook already uses.

## Assumptions (each checked on 1902e271; no file outside `openspec/` changed up to 7e6a642d: `git diff --stat 1902e271 7e6a642d -- . ':!openspec'` → empty; command → observed output)

| # | Assumption | Command | Observed |
| --- | --- | --- | --- |
| A1 | A `session_ids` scope is deduplicated and any missing, hidden or inaccessible id answers `404 Session not found` (not a smaller count) | `grep -n "const ids = \[...new Set(scope.sessionIds)\]\|rows.length !== ids.length" packages/catalog/src/autogenerateStore.ts` | `803:  const ids = [...new Set(scope.sessionIds)];` `814:  if (rows.length !== ids.length) return { ok: false, reason: 'session-not-found' };` |
| A2 | The start checks the live job before the count, so a second job answers the live-job `409` even with a correct count; the count check compares the re-resolved scope with `expected_sessions` | `grep -n "if (live) return\|n !== input.expectedSessions" packages/catalog/src/autogenerateStore.ts` | `406: if (live) return { kind: 'live-job', jobId: live.id };` `407: if (n !== input.expectedSessions) return { kind: 'sessions-changed', sessions: n };` |
| A3 | The preview computes `blocked` only after the scope resolves, so a show with no sessions answers `400` with no `blocked` | `grep -n "if (r.sessions.length === 0)\|blocked: await blockedFor" server/src/autogenerate/service.ts` | `141:  if (r.sessions.length === 0)` `165:    blocked: await blockedFor(p, steps),` |
| A4 | The runner has exactly two success points, each logging `Completed <name>` | `grep -n "log(formatCompletedLine(name))" web/src/pages/index/batchImport/playlistRunner.ts` | `186:` (unknown outcome confirmed by a segment) and `261:` (import answered 2xx, fresh or retry) |
| A5 | Preview and start refuse a member (`403`) or outsider (`404`) before the body | `grep -n "await requireTeamRole(c, teamId, OWNER_OR_ADMIN)" server/src/routers/autogenerate.ts` | lines `32`, `41` (preview, start) |
| A6 | The modal's shows are the profile's active team's, and the profile carries the user's role per team | `grep -n "accessibleShows(profile?.active_studio_id)" web/src/pages/index/components/BatchImportModal.tsx; grep -n "teams: TeamMembershipBrief" web/src/api/types.ts` | `63: const shows = showAccessFrom(profile).accessibleShows(profile?.active_studio_id);` `276:  teams: TeamMembershipBrief[];` (`role: TeamRole`) |
| A7 | Both response types the modal will use are already fixture-checked | `grep -n "const check: AutogeneratePreviewResponse\|const started: AutogenerateJobResponse" web/src/api/types.conformance.test.ts` | `960:` and `966:` |
| A8 | `session_ids` is capped at 1000 by the schema | `grep -n "session_ids: z.array" packages/contract/src/autogenerate.ts` | `108: session_ids: z.array(idSchema).min(1).max(AUTOGENERATE_MAX_SESSIONS).optional(),` (`AUTOGENERATE_MAX_SESSIONS = 1000`) |
| A9 | Only importable entries can be checked, so N checked = N importable videos | `grep -n "disabled={disabled \|\| !entry.importable}" web/src/pages/index/components/PlaylistPicker.tsx` | `78: disabled={disabled \|\| !entry.importable}` |
| A10 | No file this change touches is in `lifecycle.high_risk_paths` | python `fnmatch` of the Impact files against `openspec/config.yaml` `high_risk_paths` | `[]` |
| A11 | The themed confirm takes a React node message (Settings already passes one) | `grep -n "message:" web/src/shared/ui/ConfirmDialog.tsx` | `25:  message: ReactNode;` |
| A12 | The log part may itself generate transcripts for sessions it syncs | `grep -n "Transcript required" -A4 openspec/specs/sheets-log-import/spec.md` | "Otherwise it SHALL attempt transcript generation via the existing DeepGram-backed generate path" |
| A13 | `GET /api/me/providers` tells the browser the saved `llm`/`stt` rows, approval and Claude CLI permission, and the web already reads it through a fixture-checked type | `sed -n 80,94p server/src/routers/providers.ts; grep -n "me/providers'" web/src/api/hooks/useProviders.ts; grep -n "const check: ProvidersResponse" web/src/api/types.conformance.test.ts` | `llm: of('llm'), stt: of('stt'), run_features_allowed: runFeatureAllowed(…), claude_cli_allowed: claudeCliAllowed(…)`; `27: queryFn: () => apiFetch<ProvidersResponse>('me/providers')`; `991: const check: ProvidersResponse = providersList;` |
| A14 | The start's LLM check is "no `llm` row → none; keyless row → only `claude-cli` while allowed; else the decrypted key" | `sed -n 65,91p server/src/auth/providerResolve.ts` | `if (row === null) return null; if (row.key === null) { return row.provider === 'claude-cli' && claudeCliAllowed(env.config, user) ? { kind: 'cli' } : null; }` then `decrypt` → `null` on failure |
| A15 | The start's STT check falls back to the deployment's `DEEPGRAM_API_KEY` only with `PROVIDER_DEV_MODE`, which the browser cannot see, and that mode is on only for `NODE_ENV` development or test | `sed -n 20,40p server/src/auth/providerResolve.ts; grep -n PROVIDER_DEV_MODE server/src/node/config.ts` | `if (env.config.PROVIDER_DEV_MODE === true && fallback) { return { apiKey: fallback, … } }`; `248: PROVIDER_DEV_MODE: procEnv.NODE_ENV === 'development' \|\| procEnv.NODE_ENV === 'test',` |
| A17 | The web reads the team's job list through one fixture-checked site | `grep -n "apiFetch<AutogenerateJobListResponse>" web/src/api/hooks/useAutogenerateJobs.ts; grep -n "AutogenerateJobListResponse = autogenerateList" web/src/api/types.conformance.test.ts` | `52: queryFn: () => apiFetch<AutogenerateJobListResponse>(base(teamId)),`; `971: const list: AutogenerateJobListResponse = autogenerateList;` |
| A16 | The blocked order is stt, then llm, then approval | `grep -n "unconfigured-stt\|unconfigured-llm\|not-approved" server/src/autogenerate/service.ts` | `blockedFor`: `return 'unconfigured-stt'`, then `return 'unconfigured-llm'`, then `return 'not-approved'` |

## Decisions

### D1. Browser-side start over the existing routes (owner preference)

The modal, not the server, starts the job, with the user's own session: preview, then start. No
route, no contract delta, and the authorization is exactly the start route's.
*Alternative*: call the exported `startAutogenerateJob` from a server-side import job. Rejected:
the playlist import has no server-side job (youtube-playlist-import Non-goals), and a new route
would be a contract change (tier 2).

### D2. Which sessions qualify: `Completed` lines and this import's own audio-bearing sessions

`runPlaylistImport` gains an optional `onSessionImported(sessionId)` callback, called where it logs
`Completed <name>` (A4) and at one skip point: a name match that is this import's remembered own
session (`findImportSession(playlistImportKey(showId, videoId)) === existing.id`) with segments > 0,
i.e. audio an earlier, interrupted run brought in (the browser closed mid-import, or an unknown
outcome that landed after the wait). There the runner keeps its `Skipped … (already in system)`
line, calls the callback and forgets the key, as it does after a `Completed`, so a third run sees
an ordinary existing session (no repeated wiki runs over it). Nowhere else. The modal collects the ids in an array owned by
that Start Import. A callback, not a return value, so the ids completed before an unexpected
non-abort error in a later entry still count (that error lands in the modal's outer `catch` as
today). Skipped, failed, unconfirmed and still-importing entries never reach the callback.

The retry-into-own-unfinished-session path logs `Completed` too, so it qualifies: this run
attached its audio, and it was never "already in system" (owner decision 5, 2026-11-12, which
closed the former open question Q1). The interrupted-run case extends decision 5 (panel, tier-2
finding C, orchestrator); the owner confirms it at approval (proposal decision 5).

### D3. When: after the last part, unless aborted

The end-of-run start runs after the folder, playlist and log parts, in its own `try` after the
existing parts' `try/catch`, before the `finally` that sets 100%. It runs when the run was not
aborted, even when a part ended with a `Failed` line. After the log part rather than straight after
the playlist part because the log part may itself transcribe the sessions it syncs (A12): starting
earlier would race a job's transcript step against the log import on the same session; after it,
the job's gap-fill sees those transcripts as present.

### D4. Satisfying `expected_sessions`: preview the exact ids, start with its `sessions`

The modal sends `POST …/preview` with `session_ids` = the qualifying ids (unique by construction),
the confirmed steps (run order) and wiki mode; then `POST …/autogenerate-jobs` with the same scope
and `expected_sessions: preview.sessions`. Because an id scope never shrinks silently (A1), the
preview's count equals the id count, and a session deleted between import and start yields the
string-detail `404 Session not found` on preview or start. The `409` "sessions changed" is
therefore not expected for an id scope; if it ever arrives it is a string-detail refusal like the
others (no re-preview loop, unlike Settings, which re-asks because a show scope can change under
the user).

**One re-scope on `404 Session not found`** (panel finding E). One deleted or hidden session would
otherwise sink the whole job. On that answer from the preview or the start, the module calls an
injected `listShowSessionIds()` once: the runner's own fresh read (read the profile, re-align the
active show if another tab changed it, `fetchSessions`, keep `show_id === showId`; existing
`runner.ts` sites). It keeps the qualifying ids still listed, logs how many were dropped, and runs
preview → start once more over the rest. This is a re-scope over a different, smaller set, not a
retry of the same request: the start was refused (`404`, nothing written, A1/A2), so a second
start cannot create a duplicate job. A second `404` ends it with the string-detail line. No other
answer leads to any repeated request.
*Alternative*: skip the preview and send `expected_sessions` = id count. Rejected: the preview is
also the last `blocked` check, and its `max_runs` feeds the progress line, at the cost of one
read-only request.

### D5. Failure handling: lines, never a throw, never a retry

A new module `batchImport/autogenerateAfterImport.ts` exports
`startAutogenerateAfterImport({teamId, sessionIds, steps, wikiMode, confirmedUserId, readProfile,
listShowSessionIds, signal}): Promise<string[]>` returning its progress lines (one, or the
re-scope line plus one; empty only on abort). It first reads the profile and stops with the
different-user line when `auth.user.id` differs from `confirmedUserId` (D12). It never throws except `AbortError`; the
modal appends the line. Mapping (spec table):

| Where | Answer | Line | Why |
| --- | --- | --- | --- |
| before | no qualifying id | not started: no video was imported by this import | owner decision 1 |
| before | profile read: another user | not started: you are signed in as a different user… | D12 |
| before | profile read fails | not started: the request failed + Settings pointer | |
| preview/start | `404 Session not found`, first time | re-scope line, then preview → start once more (D4) | finding E |
| preview | `200`, `blocked` set | not started: Settings' blocked text | same words as Settings (shared model) |
| preview | `400`/`403`/`404` string detail (a `404` after the re-scope, or `Team not found`) | not started: `<detail>` + Settings pointer | e.g. `Admin role required.` (role lost mid-run) |
| preview | `422`, other JSON, ≥500, network | not started: the request failed + Settings pointer | preview writes nothing, so the outcome is certain |
| start | `201` | started for N sessions (at most M runs); Settings pointer | |
| start | `409` with `job_id` | a batch job is already running for this team; start one for this show in Settings when it ends | owner decision 3; gap-fill makes a later show-wide job safe |
| start | `400`/`403`/`404`/`409` sessions-changed/`503` string detail | not started: `<detail>` + Settings pointer | `403` not approved and `503` unconfigured carry their own instructions |
| start | `422`/other JSON below 500 | not started: the request failed + Settings pointer | |
| start | ≥500 or no JSON (network, proxy timeout) | may have started; check Settings before starting it again | the transaction may have committed |
| any | abort | no line, no further request | owner decision 3 |

A `409` is told apart by its body: `job_id` (live job) versus `sessions` (changed), as Settings
does. After a `201` (and after an unknown start) the modal invalidates
`autogenerateKeys.all(teamId)` so Settings shows the job.

### D6. Up-front check: only the exact preview blocks (panel finding 1, tier-2 finding A)

While autogenerate is armed (a step ticked, no run in progress), the modal runs the existing
`useAutogeneratePreview(teamId, {show_ids: [showId], steps, wiki_mode}, enabled)` hook with the same
400 ms debounce as Settings (`useDebounced`, D8). A `200` is exact: its `blocked` is the server's
own rule, and only that hard-disables Start Import.

**No stale verdict.** The hook keeps the previous answer as placeholder data (`keepPreviousData`),
which Settings uses to avoid flicker. The modal ignores it: the verdict counts only when the query
is not `isPlaceholderData` and its key equals the current (debounced and live) body. While the
debounce or the request is pending, the verdict is "pending" and Start Import is disabled
("Checking your providers…"), so a click can never ride on an answer for other steps.

**Empty or oversized show.** The preview resolves the scope before it computes `blocked` (A3), so
a show with no sessions yet answers `400`. The modal then reads `GET /api/me/providers` (existing
`useProviders`, A13) and `blockedFromProviders(steps, providers)` (pure, `autogenerateModel.ts`)
mirrors `blockedFor`'s order (A16) and `resolveLlmRoute` (A14). Its result is only a **warning**
with "Your providers are checked again when the import ends.": it guesses, and it guesses wrong in
two known cases (an undecryptable saved key; the dev-only `PROVIDER_DEV_MODE` Deepgram fallback,
A15), so it must not stop a legitimate import. The end-of-run preview is the authority there.

**Re-check after the confirm.** The confirm is a modal await; the preview can refresh while it is
open (refocus). After it resolves `true`, the modal reads the current verdict again and runs
nothing if it is now a block (or pending for a changed selection, which cannot happen while the
confirm holds focus, but is treated the same).

*Alternatives*: (a) a hard block from the provider status: rejected (false blocks, finding A);
(b) a new "can I start" route, or `blocked` before the scope in the preview: contract changes the
owner asked to avoid; (c) the preview over some other show: may be empty too, and reads sessions
the run never touches.

### D7. Visibility from the profile's role in the active team

`profile.auth.user.teams.find(t => t.id === profile.active_studio_id)?.role` in `{owner, admin}`
(A6). The run's team is that id, captured at Start Import (the runner already pins `runStudio`).
Hidden is a convenience; the routes refuse a member regardless (A5).

### D8. Shared options component and model

Move from `BatchAutogenerateSection.tsx` into `web/src/pages/index/components/autogenerate/`:
`autogenerateModel.ts` (`AUTOGENERATE_STEPS` with labels in run order, `stepLabel`, the wiki mode
labels, `BLOCKED_TEXT`, `orderedSteps`, `maxRuns`, `useDebounced`, and the new
`blockedFromProviders`) and `AutogenerateOptions.tsx` (the Steps
checkbox group and the Wiki output radio group, controlled, with an `idPrefix` so the modal and
Settings never share element ids, and a `disabled` prop), plus `AutogenerateConfirmMessage` (the
Settings confirm body, with an optional lead sentence so the modal can put its import sentence
first). Settings renders them with unchanged output; its existing test file must stay green
unchanged except for imports.

**Fetch functions** (finding F). `useAutogenerateJobs.ts` gains plain exported
`previewAutogenerateJob(teamId, body, signal?)` and `startAutogenerateJob(teamId, body, signal?)`,
which hold the existing `apiFetch<AutogeneratePreviewResponse>` and
`apiFetch<AutogenerateJobResponse>` calls; `useAutogeneratePreview`'s `queryFn` and
`useStartAutogenerateJob`'s `mutationFn` call them, and so does `autogenerateAfterImport.ts`. The
response-consuming sites stay where they are (same file, same types, both fixture-checked, A7), so
the end-of-run start adds none; task 3.3 records the guard's output, and a verdict entry only if
the guard keys the moved calls as new sites.

### D9. Confirm wording and estimate

N = checked entries (all importable, A9), S = ticked steps:
`Import N videos, then autogenerate on up to N sessions, at most N×S runs.` "Up to", because
skipped and failed videos drop out; N×S matches Settings' `max_runs = sessions × steps`. Then
"Only videos this import brings in are included." (D2), the own-accounts sentence and the auto-accept
warning from the shared confirm body. The 1000-entry ceiling (A8) disables Start Import up front
instead of failing at the end.

### D10. Live-job warning at confirm (owner decision 6)

On Start Import with the box ticked, the modal awaits `refetch()` of the existing
`useAutogenerateJobs(teamId, enabled, false)` query (the same hook, query key and `GET
/api/teams/:teamId/autogenerate-jobs` the Settings section uses; type `AutogenerateJobListResponse`,
fixture `autogenerateList`, A17), then opens the confirm. A `queued` or `running` job in that list
puts the warning first; any error or a missing answer means no warning. A refetch at that moment
rather than a cached read, because the warning is about "now"; the query is enabled only while
autogenerate is armed (D11), so a member never sends it. It only warns: a job that ends during the import is the
normal case for a long playlist, and the end-of-run `409` line (D5) covers the rest.
*Alternative*: block Start Import while a job is live. Rejected by the owner (warn only).

### D11. Group state and arming (tier-2 finding B)

The checkbox and options live in modal state keyed to the loaded listing: whenever `playlist`
becomes null (a new link starts loading, a listing fails) the modal resets them to defaults, and
closing the modal unmounts it. `armed = groupShown && ticked && playlistSelection.indexes.length > 0`.
Only `armed` narrows Start Import, triggers the up-front check and the confirm, and makes the run
collect ids; a ticked box with no checked entry behaves as unticked, so a folder-only or logs-only
run is never blocked or prompted by a hidden or empty playlist choice.

### D12. The run belongs to the user who confirmed (tier-2 finding D)

At the confirm the modal records `profile.auth.user.id`. The run may last hours, and sign-out
and sign-in as another user in the same browser keeps the modal mounted. Before any autogenerate
request the module reads `GET /api/profile` (existing `ProfilePayload` site) and compares; a
different user gets the different-user line and no request, so one person's confirm never spends
another person's providers. A failed read is "the request failed".

### D13. A run is not interrupted by a stray Escape or click (tier-2 finding C)

Closing aborts the run (batch-audio-import "Progress reporting"), and before this change an
accidental overlay click or Escape during an hours-long run silently lost both the remaining
entries and the end-of-run job. While `isImporting`, the modal passes `closeOnOverlayClick={false}`
to the shared `Dialog` (which prevents pointer-down/interact-outside on desktop and makes the
mobile drawer non-dismissible) and its `onOpenChange(false)` handler ignores the request (the
Escape path on desktop). The explicit Close button still calls `handleClose`, which aborts as
today. With D2's interrupted-run rule, a deliberate close followed by a rerun still gets the
videos that finished on the server into the next run's job.

## Risks / Trade-offs

- [The team gets a live job while the import runs, so the end-of-run start answers `409`] → one
  line pointing to Settings; the import is unaffected; a later show-wide job gap-fills the same
  sessions. No queueing (Non-goal).
- [The user closes the modal right after the start was sent] → the job may exist; the modal is
  gone, so no line. Settings lists it. Documented in the spec's abort rule.
- [The up-front check is pending for a slow preview, so Start Import waits] → bounded by the
  preview's latency; a failed preview falls through to the non-blocking provider warning.
- [The re-scope's session list misses sessions because the active show was switched elsewhere] →
  the re-read re-aligns the active show first, as the playlist runner does before every entry.
- [The up-front check passes but the end-of-run start is blocked (key removed mid-run, or a
  residual of D6)] → the end-of-run preview's `blocked` or the start's `503`/`403` becomes one
  line; the confirm says providers are checked again when the import ends.
- [Spend on the user's provider accounts for up to 1000 × 4 runs] → the same bound and confirm as
  Settings; the confirm states the maximum and the own-accounts note.
- [Long imports: the job starts only after hours of importing] → by design (one job, owner decision
  1); the modal must stay open, as the import already requires.
- [Extracting the Settings controls changes Settings by accident] → its test file runs unchanged
  (task 1.2).

## Migration Plan

Web-only; ships with the next web build. Rollback: revert the commit. Jobs already started are
ordinary batch jobs, managed in Settings.

## Open Questions

None. Q1 was closed by owner decision 5 and Q2 by owner decision 6 (both 2026-11-12).
