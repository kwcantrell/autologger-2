# Tasks

The first commit on `playlist-import-autogenerate` holds only
`openspec/changes/playlist-import-autogenerate/` (the approved artifacts and `panel.md`). Base:
main 1902e271. The PR targets `main`.

Logs: keep every test and gate run under the session scratchpad as `pia-<task>-<red|green>.log`
and name the log in each `Evidence:` line. Each "test first" item is red before its change (record
the failure line) and green after; if a new test already passes, record that and why.

Web tests: `cd web && npx vitest run <files>`. Gates run through `scripts/check-change.sh`.

## 1. Shared autogenerate options (design D8)

- [ ] 1.1 Test first, new `web/src/pages/index/components/autogenerate/AutogenerateOptions.test.tsx`
  and `autogenerateModel.test.ts`: the four steps in run order with Settings' labels, all ticked
  by default by the caller's initial state; toggling a step calls back with the new set; the wiki
  radio is disabled without Wiki; `idPrefix` makes every id unique (two instances in one tree have
  no duplicate id); `disabled` disables every control; `BLOCKED_TEXT` holds the three Settings
  texts verbatim; `maxRuns(n, steps)` = n × steps; the confirm body renders the optional lead
  sentence first, the own-accounts sentence, and the auto-accept warning only in `accept` mode with
  Wiki ticked. Verify: red before 1.2 (module not found), green after.
- [ ] 1.2 Create `components/autogenerate/{autogenerateModel.ts,AutogenerateOptions.tsx}` by moving
  the constants, the Steps and Wiki output groups and the confirm body out of
  `settings/BatchAutogenerateSection.tsx`, which then renders them. Verify: 1.1 green;
  `BatchAutogenerateSection.test.tsx` green with no assertion changed (imports only);
  `npm run typecheck` exit 0; biome clean.

## 2. Runner reports its successful imports (design D2)

- [ ] 2.1 Test first, `web/src/pages/index/batchImport/playlistRunner.test.ts`: with
  `onSessionImported`, a run over five entries (created and completed; skipped as already in the
  system; definite failure; unknown outcome later confirmed by a segment; unknown outcome never
  confirmed) reports exactly the ids of the first and fourth; a retry into this import's own empty
  session that completes is reported; a `409` still-importing retry is not; after a `403` ends the
  part, the ids completed before it are reported and nothing after; an abort reports nothing more;
  every progress line is byte-identical to the same run without the callback. Verify: red before
  2.2, green after.
- [ ] 2.2 `playlistRunner.ts`: optional `onSessionImported(sessionId)` in
  `RunPlaylistImportOptions`, called at the two `Completed` points only. Verify: 2.1 and the whole
  existing `playlistRunner.test.ts` green.

## 3. End-of-run start (design D4, D5)

- [ ] 3.1 Test first, new `web/src/pages/index/batchImport/autogenerateAfterImport.test.ts`
  (mocked `apiFetch`/`fetch`): no ids → the "no video was imported" line and no request; ids →
  preview body `{session_ids, steps (run order), wiki_mode}` to
  `teams/<team>/autogenerate-jobs/preview`, then start with the same scope and
  `expected_sessions` = the preview's `sessions` (deliberately different from the id count in one
  case, to prove the preview's value is sent), `201` → the started line with the preview's
  `sessions` and `max_runs`; preview `blocked` (each of the three) → its Settings text, no start;
  every row of the spec's table: start `409 {detail, job_id}` → the live-job line; start
  `409 {detail, sessions}`, `400`, `403` (both details), `404` and `503` (both details) → the
  `<detail>` line; preview `400`/`404` → the `<detail>` line; preview `422`, `500` and a network
  error → "the request failed"; start `422` → "the request failed"; start `500`, a non-JSON `524`
  and a network error → "may have started"; no case sends a second start; an abort before or during
  either request resolves null with no further request; the function never rejects except with
  `AbortError`. Verify: red before 3.2, green after.
- [ ] 3.2 `autogenerateAfterImport.ts`: `startAutogenerateAfterImport`, using the existing client
  types `AutogeneratePreviewResponse` and `AutogenerateJobResponse` and the typed 409 bodies.
  Verify: 3.1 green; `npm run typecheck` exit 0.
- [ ] 3.3 Test first, web API-response conformance for the new call sites (spec
  web-api-response-conformance "Every response-consuming site has a recorded conformance verdict"):
  run `cd web && npx vitest run src/apiResponseShapes.repo.test.ts src/api/types.conformance.test.ts`
  after 3.2. If the guard names a new site (the two `apiFetch<…>` calls in
  `autogenerateAfterImport.ts`), add a verdict entry per site: endpoint
  `POST /api/teams/:teamId/autogenerate-jobs/preview` → `AutogeneratePreviewResponse` and
  `POST /api/teams/:teamId/autogenerate-jobs` → `AutogenerateJobResponse`, CONFORMS against the
  batch-autogenerate captures `autogeneratePreview` / `autogenerateStart` (types.conformance lines
  960/966), plus the typed `409` bodies (`AutogenerateLiveJobConflict`,
  `AutogenerateSessionsChanged`, fixture-checked by batch-autogenerate). If the guard already passes
  because both types are fixture-assigned, record that output as evidence and add no entry.
  Verify: both test files green.

## 4. Modal: checkbox, options, up-front check, confirm, wiring (design D3, D6, D7, D9)

- [ ] 4.1 Test first, `web/src/pages/index/components/BatchImportModal.test.tsx`:
  - the checkbox is absent with no playlist loaded, absent for a `member` of the active team (and
    no `autogenerate-jobs` request is ever sent for them), present and unticked for an `owner` and
    an `admin`;
  - ticking shows the shared options with all four steps and the accept mode; controls are
    disabled during a run; reopening the modal resets them;
  - the up-front preview is sent with `show_ids: [showId]`, debounced, only while ticked; a
    `blocked` answer shows its text and disables Start Import, unticking re-enables it; a `400`
    preview leaves Start Import enabled; no step ticked and more than 1000 checked entries each
    disable Start Import with their texts;
  - Start Import with the box ticked opens the confirm with
    `Import 12 videos, then autogenerate on up to 12 sessions, at most 24 runs.` (12 entries, 2
    steps); dismissing imports nothing; unticked shows no confirm;
  - a confirmed run (mocked runner and `startAutogenerateAfterImport`) calls the start once after
    the log part with exactly the ids the runner reported, the team id captured at Start Import,
    and the confirmed steps and mode, and appends its line after every import line; a part ending
    with a `Failed` line still starts it; closing the modal mid-run sends no autogenerate request.
  Verify: red before 4.2, green after.
- [ ] 4.2 `BatchImportModal.tsx`: visibility from the profile role (D7), the options group under the
  picker, `useAutogeneratePreview` for the up-front check, the themed confirm (`useConfirm`), the
  `onSessionImported` collector, the end-of-run call after the existing parts and the
  `autogenerateKeys.all(teamId)` invalidation after a `201` or an unknown start. Verify: 4.1 and
  the whole existing `BatchImportModal.test.tsx` green; `npm run typecheck` exit 0; biome clean.
- [ ] 4.3 README "YouTube audio import": one paragraph on "Autogenerate after import" (owners and
  admins, one job at the end over this run's imported videos, the confirm, the progress line and
  where to follow the job). Docs only; verify: `cd server && npx vitest run
  src/routers/readmeEndpoints.repo.test.ts` still green (no endpoint row changes) and the paragraph names
  Settings → Batch autogenerate.

## 5. Verification

- [ ] 5.1 Dev stack owner check (`make dev-up`, autologger-dev with a dev provider, the owner in
  the browser): as an owner, load a short playlist of 3 videos into a test show where one title
  already exists, tick Autogenerate after import with Transcripts and Topics, confirm (record the
  confirm text: 3 videos, at most 6 runs), and let it run. Record the progress lines (one skipped,
  two completed, then `Autogenerate started for 2 sessions (at most 4 runs)…`), and in Settings →
  Batch autogenerate that the job's scope is `sessions` with exactly those two sessions. Repeat
  while that job is still running to record the live-job line. As a `member` of the team, record
  that the checkbox is not shown.
- [ ] 5.2 `scripts/check-change.sh --stage hook` green, then `GITHUB_BASE_REF=main
  scripts/check-change.sh` (all gates, as CI) green.
