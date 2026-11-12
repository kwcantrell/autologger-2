# Tasks

The first commit on `playlist-import-autogenerate` holds only
`openspec/changes/playlist-import-autogenerate/` (the approved artifacts and `panel.md`). Base:
main 7e6a642d (after archive PR #144, task 0.1). The PR targets `main`. Tier 2: the
artifacts get the three-reviewer panel before approval, and task 5.3 adds the consistency read.

Logs: keep every test and gate run under the session scratchpad as `pia-<task>-<red|green>.log`
and name the log in each `Evidence:` line. Each "test first" item is red before its change (record
the failure line) and green after; if a new test already passes, record that and why.

Web tests: `cd web && npx vitest run <files>`. Gates run through `scripts/check-change.sh`.

## 0. Rebase onto the synced specs

- [x] 0.1 After archive PR #144 (youtube-playlist-import and batch-autogenerate synced into
  `openspec/specs/`) merged: rebase this branch onto main, then run
  `openspec validate --all --strict` and
  `openspec show batch-audio-import --type spec | grep -n "A playlist alone enables Start Import"`.
  If the synced "Batch Import modal layout and actions" differed from the text this delta restates
  (youtube-playlist-import's MODIFIED), stop, update the delta, and re-panel it. Verify: validate
  says every item is valid and the grep finds the scenario in the synced spec.
  Evidence: 2026-11-12, `git rebase origin/main` -> `Successfully rebased and updated refs/heads/playlist-import-autogenerate` onto 7e6a642d; `openspec validate --all --strict` -> `Totals: 34 passed, 0 failed (34 items)`; the grep -> `51:#### Scenario: A playlist alone enables Start Import`; the synced requirement text (`openspec/specs/batch-audio-import/spec.md:28`) is the one this delta restates, unchanged apart from this change's additions.

## 1. Shared autogenerate options (design D8)

- [x] 1.1 Test first, new `web/src/pages/index/components/autogenerate/AutogenerateOptions.test.tsx`
  and `autogenerateModel.test.ts`: the four steps in run order with Settings' labels, all ticked
  by default by the caller's initial state; toggling a step calls back with the new set; the wiki
  radio is disabled without Wiki; `idPrefix` makes every id unique (two instances in one tree have
  no duplicate id); `disabled` disables every control; `BLOCKED_TEXT` holds the three Settings
  texts verbatim; `maxRuns(n, steps)` = n × steps; `blockedFromProviders(steps, providers)`
  (design D6) returns `unconfigured-stt` for Transcripts with `stt` null, `unconfigured-llm` for an
  LLM step with `llm` null and for a `claude-cli` `llm` with `claude_cli_allowed` false (but not
  when allowed), `not-approved` for `run_features_allowed` false, the first in that order when
  several apply, and null for a fully configured user or when only steps that need nothing missing
  are ticked; `useDebounced` delays a value by the given ms and keeps only the last change (fake
  timers); the confirm body renders the optional lead
  sentence first, the own-accounts sentence, and the auto-accept warning only in `accept` mode with
  Wiki ticked. Verify: red before 1.2 (module not found), green after.
  Evidence: red: `cd web && npx vitest run src/pages/index/components/autogenerate/` -> `Error: Cannot find module './autogenerateModel'`, `Failed to resolve import "./AutogenerateOptions"`, `Tests  no tests` (pia-1.1-red.log); green after 1.2: same command plus the Settings test -> `Test Files  3 passed (3)`, `Tests  42 passed (42)` (pia-1.2-green.log)
- [x] 1.2 Create `components/autogenerate/{autogenerateModel.ts,AutogenerateOptions.tsx}` by moving
  the constants, `useDebounced`, the Steps and Wiki output groups and the confirm body out of
  `settings/BatchAutogenerateSection.tsx`, which then renders them; move the two `apiFetch` calls
  of `useAutogeneratePreview` and `useStartAutogenerateJob` into exported
  `previewAutogenerateJob(teamId, body, signal?)` / `startAutogenerateJob(teamId, body, signal?)`
  in `useAutogenerateJobs.ts`, called by the hooks (design D8, finding F). Verify: 1.1 green;
  `BatchAutogenerateSection.test.tsx` green with no assertion changed (imports only);
  `npm run typecheck` exit 0; biome clean.
  Evidence: `cd web && npx vitest run src/pages/index/components/autogenerate/ src/pages/index/components/settings/BatchAutogenerateSection.test.tsx` -> `Test Files  3 passed (3)`, `Tests  42 passed (42)`; `BatchAutogenerateSection.test.tsx` unchanged (it renders through `SettingsView`, so not even its imports changed) (pia-1.2-green.log); `npm run typecheck` -> `tsc --noEmit` exit 0; `npx biome check --error-on-warnings src/pages/index/components/autogenerate src/pages/index/components/settings src/api/hooks` exit 0 (pia-1.2-typecheck.log; the whole-`src/` run reports one pre-existing error in untouched `wiki/WikiRoute.tsx:326` under biome 2.5.3)

## 2. Runner reports its successful imports (design D2)

- [x] 2.1 Test first, `web/src/pages/index/batchImport/playlistRunner.test.ts`: with
  `onSessionImported`, a run over five entries (created and completed; skipped as already in the
  system; definite failure; unknown outcome later confirmed by a segment; unknown outcome never
  confirmed) reports exactly the ids of the first and fourth; a retry into this import's own empty
  session that completes is reported; a `409` still-importing retry is not; after a `403` ends the
  part, the ids completed before it are reported and nothing after; an abort reports nothing more;
  every progress line is byte-identical to the same run without the callback; interrupted-run case
  (design D2): an entry whose name matches this import's remembered own session that has
  segments is skipped with the unchanged `Skipped … (already in system)` line, reported, and its
  key forgotten (a second run over the same entry then skips it without reporting); a name match
  that is not remembered, or remembered for another video, is skipped and not reported. Verify:
  red before 2.2, green after.
  Evidence: red: `cd web && npx vitest run src/pages/index/batchImport/playlistRunner.test.ts` -> `Tests  5 failed | 30 passed (35)`, e.g. `AssertionError: expected [] to deeply equal [ 'new-1', 'new-3' ]`, `expected [] to deeply equal [ 'mine' ]` (pia-2.1-red.log); the byte-identical, 409 and not-reported cases passed before 2.2 because they assert the absence of a report or a line change; green after 2.2 (pia-2.2-green.log)
- [x] 2.2 `playlistRunner.ts`: optional `onSessionImported(sessionId)` in
  `RunPlaylistImportOptions`, called at the two `Completed` points and at the remembered-own-
  session-with-audio skip, which also forgets the key. Verify: 2.1 and the whole
  existing `playlistRunner.test.ts` green.
  Evidence: `cd web && npx vitest run src/pages/index/batchImport/playlistRunner.test.ts` -> `Tests  35 passed (35)`; `npx vitest run src/pages/index/batchImport/` -> `Test Files  6 passed (6)`, `Tests  97 passed (97)`; `npm run typecheck` exit 0 (pia-2.2-green.log)

## 3. End-of-run start (design D4, D5, D12)

- [x] 3.1 Test first, new `web/src/pages/index/batchImport/autogenerateAfterImport.test.ts`
  (mocked `apiFetch`/`fetch`, injected `readProfile` and `listShowSessionIds`): no ids → the
  "no video was imported by this import" line and no request; a profile whose `auth.user.id`
  differs from `confirmedUserId` → the different-user line and no preview or start; a failed
  profile read → "the request failed" and no preview; a preview `404 Session not found` → one
  `listShowSessionIds` call, the left-out line with the dropped count, and exactly one more preview
  and start over the remaining ids (the same for a start `404`); a second `404` → the `<detail>`
  line and no third preview; every id gone → the "no video" line after the left-out line; a failed
  session-list read → "the request failed"; ids →
  preview body `{session_ids, steps (run order), wiki_mode}` to
  `teams/<team>/autogenerate-jobs/preview`, then start with the same scope and
  `expected_sessions` = the preview's `sessions` (deliberately different from the id count in one
  case, to prove the preview's value is sent), `201` → the started line with the preview's
  `sessions` and `max_runs`; preview `blocked` (each of the three) → its Settings text, no start;
  every row of the spec's table: start `409 {detail, job_id}` → the live-job line; start
  `409 {detail, sessions}`, `400`, `403` (both details), `404` and `503` (both details) → the
  `<detail>` line; preview `400`/`404` → the `<detail>` line; preview `422`, `500` and a network
  error → "the request failed"; start `422` → "the request failed"; start `500`, a non-JSON `524`
  and a network error → "may have started"; no case except the single `404` re-scope sends a
  second preview or start; an abort before or during
  either request resolves `[]` with no further request; the function never rejects except with
  `AbortError`. Verify: red before 3.2, green after.
  Evidence: red: `cd web && npx vitest run src/pages/index/batchImport/autogenerateAfterImport.test.ts` -> `Error: Cannot find module './autogenerateAfterImport'`, `Tests  no tests` (pia-3.1-red.log); green after 3.2 (pia-3.2-green.log). The tests stub the global `fetch` under the real `apiFetch`, so the typed bodies and non-JSON answers go through the real parse; the abort cases resolve `[]` (the function never rejects).
- [x] 3.2 `autogenerateAfterImport.ts`: `startAutogenerateAfterImport`, calling
  `previewAutogenerateJob` / `startAutogenerateJob` from task 1.2 (no new `apiFetch` site) and
  reading the typed 409 bodies.
  Verify: 3.1 green; `npm run typecheck` exit 0.
  Evidence: `cd web && npx vitest run src/pages/index/batchImport/autogenerateAfterImport.test.ts` -> `Tests  40 passed (40)`; `npm run typecheck` exit 0; biome clean (pia-3.2-green.log). A start `503` with a string `detail` (the route's pre-write "unconfigured" refusal) is the `<detail>` line per the spec table's string-detail row, not "may have started"; other `500`+ or non-JSON answers are.
- [x] 3.3 Test first, web API-response conformance for the new call sites (spec
  web-api-response-conformance "Every response-consuming site has a recorded conformance verdict"):
  run `cd web && npx vitest run src/apiResponseShapes.repo.test.ts src/api/types.conformance.test.ts`
  after 1.2 and 3.2. The end-of-run start calls the hook file's fetch functions, so its
  `apiFetch` sites are the moved ones in `useAutogenerateJobs.ts`. If the guard names a moved or
  new site, add a verdict entry per site: endpoint
  `POST /api/teams/:teamId/autogenerate-jobs/preview` → `AutogeneratePreviewResponse` and
  `POST /api/teams/:teamId/autogenerate-jobs` → `AutogenerateJobResponse`, CONFORMS against the
  batch-autogenerate captures `autogeneratePreview` / `autogenerateStart` (types.conformance lines
  960/966), plus the typed `409` bodies (`AutogenerateLiveJobConflict`,
  `AutogenerateSessionsChanged`, fixture-checked by batch-autogenerate). If the guard already passes
  because both types are fixture-assigned, record that output as evidence and add no entry.
  The up-front check's `GET /api/me/providers` reuses the existing `useProviders` hook site
  (`ProvidersResponse`, fixture `providersList`), and the live-job warning's job-list read reuses
  the existing `useAutogenerateJobs` site (`AutogenerateJobListResponse`, fixture
  `autogenerateList`), so neither adds a site; record that in the evidence. If either is instead
  called through a new `apiFetch<…>` site, add its CONFORMS verdict against that fixture.
  Verify: both test files green.
  Evidence: `cd web && npx vitest run src/apiResponseShapes.repo.test.ts src/api/types.conformance.test.ts` -> `Test Files  2 passed (2)`, `Tests  135 passed (135)` (pia-3.3-green.log), so no verdict entry was added: the two moved sites are `useAutogenerateJobs.ts:38` `apiFetch<AutogeneratePreviewResponse>` and `:51` `apiFetch<AutogenerateJobResponse>`, both fixture-assigned (`types.conformance.test.ts:960`, `:966`; the 409 bodies at `:982`, `:984`); `grep -c apiFetch autogenerateAfterImport.ts` -> `0`. The modal's provider and job-list reads go through the existing `useProviders` and `useAutogenerateJobs` hooks (task 4.2), adding no site; the guard is re-run after 4.2.

## 4. Modal: checkbox, options, up-front check, confirm, wiring (design D3, D6, D7, D9-D13)

- [x] 4.1 Test first, `web/src/pages/index/components/BatchImportModal.test.tsx`:
  - the checkbox is absent with no playlist loaded, absent for a `member` of the active team (and
    no `autogenerate-jobs` request is ever sent for them), present and unticked for an `owner` and
    an `admin`;
  - ticking shows the shared options with all four steps and the accept mode; controls are
    disabled during a run; reopening the modal resets them;
  - arming (design D11): loading another link, a failed listing and closing the modal each untick
    the box and reset the steps; a ticked box with every entry unchecked and a folder chosen leaves
    Start Import enabled and shows no confirm (spec scenario "A ticked box with no checked entry
    does not narrow Start Import"), and sends no preview;
  - the up-front preview is sent with `show_ids: [showId]`, debounced, only while armed; while it
    is pending Start Import is disabled with "Checking your providers…"; after the steps change,
    the previous answer (placeholder data) is not used and Start Import stays disabled until the
    new one arrives (stale case); a `200` `blocked` answer shows its text and disables Start
    Import, unticking re-enables it; a `400` preview (empty show) with `stt` null in
    `GET /api/me/providers` and Transcripts ticked shows the speech-to-text text plus "Your
    providers are checked again when the import ends." as a warning with Start Import enabled
    (fallback-warning case); a configured user shows no warning; both reads failing show nothing
    and leave Start Import enabled; no step ticked and more than 1000 checked entries each disable
    Start Import with their texts ("Autogenerate options can disable Start Import"), and "A
    playlist alone enables Start Import" still holds with the box unticked;
  - late block: with the confirm open, the preview for the current selection is refreshed to a
    `blocked` answer; confirming runs nothing, shows the block and disables Start Import;
  - dialog (design D13): during a run, Escape and a pointer-down outside leave the modal open and
    the runner's signal unaborted; Close aborts it; with no run in progress Escape still closes;
  - the confirm says the providers are checked again when the import ends;
  - Start Import with the box ticked opens the confirm with
    `Import 12 videos, then autogenerate on up to 12 sessions, at most 24 runs.` (12 entries, 2
    steps); dismissing imports nothing; unticked shows no confirm and sends no job-list request;
  - live-job warning (owner decision 6, design D10): Start Import with the box ticked sends
    `GET teams/<team>/autogenerate-jobs` before the confirm opens; a list with a `running` job and
    one with a `queued` job each put "A batch job is already running for this team; autogenerate
    after this import will not start unless it has finished by then." first in the confirm with
    Start still enabled, and confirming runs the import; a list with only `finished`, `cancelled`
    or `failed` jobs, a `500`, and a network error each open the confirm without the warning;
  - a confirmed run in which the runner reports a retried session from an earlier run passes its
    id in `session_ids` (owner decision 5);
  - account switch (design D12): the user id recorded at the confirm is passed as
    `confirmedUserId`;
  - a confirmed run (mocked runner and `startAutogenerateAfterImport`) calls the start once after
    the log part with exactly the ids the runner reported, the team id captured at Start Import,
    and the confirmed steps and mode, and appends its line after every import line; a part ending
    with a `Failed` line still starts it; closing the modal mid-run sends no autogenerate request.
  Verify: red before 4.2, green after.
  Evidence: red: `cd web && npx vitest run src/pages/index/components/BatchImportModal.test.tsx` -> `Tests  30 failed | 27 passed (57)` (every new case that needs the group, the confirm, the D13 Escape guard or the end-of-run call failed; the absence cases, e.g. "absent with no playlist loaded" and "with no run in progress, Escape still closes", passed already) (pia-4.1-red.log); green after 4.2 (pia-4.2-green.log)
- [x] 4.2 `BatchImportModal.tsx`: visibility from the profile role (D7), the options group under the
  picker, the job-list read before the confirm via `useAutogenerateJobs` (D10), `useAutogeneratePreview` then `useProviders` with `blockedFromProviders` for the up-front
  check (D6) with the pending/stale rule and the post-confirm re-check, arming and reset (D11),
  `closeOnOverlayClick={!isImporting}` and the ignored `onOpenChange(false)` during a run (D13),
  the confirmed user id (D12), the themed confirm (`useConfirm`), the
  `onSessionImported` collector, the end-of-run call after the existing parts and the
  `autogenerateKeys.all(teamId)` invalidation after a `201` or an unknown start. Verify: 4.1 and
  the whole existing `BatchImportModal.test.tsx` green; `npm run typecheck` exit 0; biome clean.
  Evidence: `cd web && npx vitest run src/pages/index/components/BatchImportModal.test.tsx` -> `Tests  57 passed (57)`; with the conformance guard, `batchImport/`, `autogenerate/` and the Settings test -> `Test Files  12 passed (12)`, `Tests  314 passed (314)` (pia-4.2-green.log; `apiResponseShapes.repo.test.ts` still green: the modal's reads use `useProviders`, `useAutogenerateJobs` and the runner's extracted `readProfile`/`readShowSessions`, so no new `apiFetch` site); `npm run typecheck -w web` exit 0; biome on the touched files exit 0 (pia-4.2-typecheck.log)
- [x] 4.3 README "YouTube audio import": one paragraph on "Autogenerate after import" (owners and
  admins, one job at the end over this run's imported videos, the confirm, the progress line and
  where to follow the job). Docs only; verify: `cd server && npx vitest run
  src/routers/readmeEndpoints.repo.test.ts` still green (no endpoint row changes) and the paragraph names
  Settings → Batch autogenerate.
  Evidence: README "YouTube audio import" gains the paragraph "**Autogenerate after import (playlist-import-autogenerate).**", which ends "Follow or retry the job in Settings → Batch autogenerate."; `cd server && npx vitest run src/routers/readmeEndpoints.repo.test.ts` -> `Tests  12 passed (12)` (pia-4.3-green.log)

## 5. Verification

- [ ] 5.1 Dev stack owner check (`make dev-up`, autologger-dev with a dev provider, the owner in
  the browser): as an owner, load a short playlist of 3 videos into a test show where one title
  already exists, tick Autogenerate after import with Transcripts and Topics, confirm (record the
  confirm text: 3 videos, at most 6 runs), and let it run. Record the progress lines (one skipped,
  two completed, then `Autogenerate started for 2 sessions (at most 4 runs)…`), and in Settings →
  Batch autogenerate that the job's scope is `sessions` with exactly those two sessions. Repeat
  while that job is still running to record the confirm's live-job warning (Start still enabled)
  and the end-of-run live-job line. As a `member` of the team, record
  that the checkbox is not shown. In a new empty show, with Transcripts ticked and no saved STT
  key, record the non-blocking warning and that Start Import stays enabled (the dev stack's
  `PROVIDER_DEV_MODE` fallback then lets the job start, design D6). Press Escape mid-run and
  record that the run continues.
- [ ] 5.2 `scripts/check-change.sh --stage hook` green, then `GITHUB_BASE_REF=main
  scripts/check-change.sh` (all gates, as CI) green.
- [x] 5.3 Tier 2 consistency read (`consistency-read` skill) over specs, design, code and tests by a
  fresh reviewer, appended to `panel.md`; every finding fixed or escalated. Verify:
  `scripts/check-change.sh --only panel` passes with no open critical.
  Evidence: `panel.md` "## Consistency read 2026-11-12" (fresh reviewer; scope change: no) with one `[major]` (no test for a job-list read that does not answer), fixed by the `BatchImportModal.test.tsx` case "a job-list read that never answers: the confirm opens without the warning after the 5 s wait": red with the race removed -> `TestingLibraryElementError: Unable to find role="alertdialog"` (pia-5.3-red.log), green -> `Tests  58 passed (58)` (pia-5.3-green.log); `GITHUB_BASE_REF=main scripts/check-change.sh --only panel` -> `PASS  panel  11 finding(s), no open criticals` (pia-5.3-panel.log)
