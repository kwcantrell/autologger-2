# Tasks

**Branch and commits**
- The first commit on `supabase-7c2-session-edit-conflicts` holds only
  `openspec/changes/session-edit-conflicts/`, so the plan is pinned before code.
- The PR targets `supabase-migration`.
- The gates run with `GITHUB_BASE_REF=supabase-migration`.
- One PR (ADR 0024: no size budget).

**Test-first discipline.** Each "test first" item is red before its change; record the failure
line. It is green after. If a new test already passes, record that and say why. Changing an
existing test is allowed only for the five categories in design D10 ("Existing tests that
change"); any other change is a stop: update the artifacts and ask the owner.

**Commands**
- **Web:** `cd web && npx vitest run <files>`.
- **Full web suite:** `cd web && npx vitest run`, plus `npm run typecheck` and `npx biome check web/src`.
- **Server fixtures** (dev stack): `npm run fixtures:capture -w server` captures, and
  `cd server && npx vitest run --project integration src/routers/apiResponseFixtures.int.test.ts`
  verifies.

Keep each task's text, and later its `Evidence:`, in one block with no blank line.

## 1. Fixtures and types (design D6, A1, A2)

- [x] 1.1 Test first: add the 9 captures to `server/src/routers/apiResponseFixtures.int.test.ts`. For each row kind: a versioned update (200), a stale versioned update after an unversioned one (`status: 409`), and a stale versioned delete (`status: 409`).
  - Verify: red with "missing captured fixture" for each of the 9; then `npm run fixtures:capture -w server` writes them, and the file is green.
  - Each conflict fixture's `current.version` is 2 and its `detail` is `Version conflict.`.
  - Evidence: 9 captures in `apiResponseFixtures.int.test.ts` (events, transcript words, topics: `*Update` 200, `*UpdateConflict` and `*DeleteConflict` 409, each set up as create v1, unversioned write to v2, stale request at v1, plus `toMatchObject({ detail: 'Version conflict.', current: { version: 2 } })`). `cd server && npx vitest run --project integration src/routers/apiResponseFixtures.int.test.ts` -> `Tests  9 failed | 34 passed (43)`, each `Error: Missing captured fixture eventUpdate.json …` (and the other 8). `npm run fixtures:capture -w server` -> `Tests  43 passed (43)`, 9 new files under `fixtures/api-responses/` (no existing fixture changed); rerun assert-only -> `Tests  43 passed (43)`; `web/src/apiResponseShapes.repo.test.ts` (fixture-inventory parity) -> `Tests  44 passed (44)` unchanged.
- [x] 1.2 Test first: in `web/src/api/types.conformance.test.ts`, assign each new fixture to its type (`LogEvent`, `TranscriptWord`, `SessionTopic`, and the three `*VersionConflict` aliases), add the runtime `detail`/`current.version` assertions, and add `version: 1` to `orphanFromSourceRead`.
  - Verify: `npx tsc --noEmit` red (the missing types and fields).
  - Then add `version: number` to the three row types, the version fields to `EventUpdateBody`, and `VersionConflict<T>` plus the aliases to `web/src/api/types.ts`.
  - Then add `version` to the test row literals (D10 category 1).
  - Gate: typecheck clean and the conformance file green.
  - Evidence: `types.conformance.test.ts`: a D6 describe assigns `eventUpdate`/`transcriptWordUpdate`/`topicUpdate` (and the create rows) to `LogEvent`/`TranscriptWord`/`SessionTopic` reading `.version` (2 and 1), the six conflict fixtures `satisfies` `EventVersionConflict`/`TranscriptWordVersionConflict`/`TopicVersionConflict` with `detail === 'Version conflict.'` and `current.version === 2`, `current` keys equal the success shape; `version: 1` on `orphanFromSourceRead`. `cd web && npx tsc --noEmit` -> 9 errors: `TS2305: Module '"./types"' has no exported member 'EventVersionConflict'` (and the two other aliases), `TS2339: Property 'version' does not exist on type 'LogEvent'` (and `TranscriptWord`, `SessionTopic`). `types.ts`: required `version: number` on the three rows, `version?`/`overwrite?` on `EventUpdateBody`, `VersionConflict<T>` and the three aliases -> 29 errors in 21 test files, all `Property 'version' is missing` on row literals; D10 category 1: `version: 1,` added to 29 literals (diff is only those 29 added lines). `npm run typecheck` exit 0; conformance `Tests  55 passed (55)`; full web suite `Test Files  126 passed (126)`, `Tests  1556 passed (1556)`; biome clean.

## 2. Client and guard helpers (D1, D2)

- [ ] 2.1 Test first: `web/src/api/client.test.ts` gains three cases:
  - a 409 JSON body is on `ApiError.body`;
  - `detail`/`message` are unchanged;
  - a non-JSON error leaves `body` undefined.
  Red, then `client.ts`.
- [ ] 2.2 Test first: `web/src/api/versionConflict.test.ts` covers:
  - `guardBody`/`versionQuery` for no guard, version only, and version plus overwrite;
  - overwrite without a version throws;
  - `versionConflictOf` matches only the version-conflict 409. It rejects a different 409 detail, a non-`ApiError`, a missing or non-object `current`, and a non-numeric version.
  Red, then the module.

## 3. Hooks (D8)

- [ ] 3.1 Test first: new hook tests for events, words and topics (`renderHook` with a QueryClient wrapper, `apiFetch` mocked, the real `ApiError`). They cover:
  - the update body carries `version`/`overwrite`;
  - the delete URL carries `?version=N[&overwrite=1]`;
  - no guard means a request byte-identical to today's;
  - a version-conflict error writes `current` into every matching cache entry and invalidates.
  Red, then the three hooks. Update `EventLogSheet`'s delete call to the new variables object (D10 category 3).

## 4. Response-shape guard (D6)

- [ ] 4.1 Test first: in `web/src/apiResponseShapes.repo.test.ts`, add the Detector 8 `errorBody` synthetic cases:
  - an unchecked `versionConflictOf<T>` site fails;
  - a covered one passes;
  - an aliased import is still found.
  Add the canary in `useEvents.ts` and the `errorBody` floor. Red, then the detector. Then re-key the `client.ts` error-probe exemption and the three DELETE URL exemptions (D10 category 4), and re-measure every floor with the arithmetic in the comment. Gate: the file green.

## 5. Shared pieces (D3, D4, D5, D7)

- [ ] 5.1 Test first: `seedStore.test.ts` covers:
  - `get`, `set` and `clearAll`;
  - the follow rule as a pure helper (`followServer(rows, isHeld)`): a row that is held keeps its seed, and an unheld row takes the server row;
  - an entry survives a consumer unmount;
  - stable callbacks, so a write re-renders nothing.
  Red, then `web/src/pages/index/utils/seedStore.ts` (D3).
- [ ] 5.2 Test first: `ConfirmDialog.test.tsx` covers `choose()`:
  - confirm, cancel and Escape resolve `'confirm'`, `'cancel'` and `'dismiss'`;
  - an overlay click and unmount resolve `'dismiss'`;
  - the boolean `confirm()` still resolves `false` on Escape.
  Red, then `ConfirmDialog.tsx` (`onDismiss`) and `useConfirm().choose`.
- [ ] 5.3 Test first: `useVersionedSave.test.tsx` covers:
  - saved with the base version;
  - conflict, Overwrite, conflict, Overwrite, then saved (each retry carries the newer `current.version` and `overwrite: true`);
  - Keep theirs gives `keptTheirs`; dismiss gives `dismissed`, with no further send;
  - two conflicts on different rows are prompted one after the other and neither is auto-resolved;
  - two saves on one row: the second waits and reads its base after the first settles;
  - a non-conflict error rejects unchanged;
  - `onSaved` runs inside the row's chain, so a queued save's base thunk sees the rebased seed;
  - after `keptTheirs` or `dismissed`, saves still queued on that row settle with the same outcome and send nothing;
  - a `sessionId` change dismisses the open and queued prompts and sends no queued save;
  - a 409 that arrives after a `sessionId` change opens no dialog and sends nothing;
  - `isBusy(rowKey)` is true while a save is in flight or queued for that row;
  - unmount resolves queued prompts as `dismissed`;
  - the prompt renders row text as text (a `<b>` in a message shows literally), lists sibling fields holding operator text, and truncates values at 200 characters.
  Red, then the hook and `conflictPromptCopy.tsx`.

## 6. Event feed (D3, D9)

- [ ] 6.1 Test first: `EventLogSheet.virtualization.test.tsx`. The PUT mock gains a server-side `version`, a `conflictFor` set, and a 409 `ApiError` carrying `current`. It covers:
  - an inline save sends the base version;
  - a refetch (new version in the cache) while the row is focused does not move the base, so the dialog shows;
  - Overwrite sends `version: current.version, overwrite: true` and the row keeps the operator's text;
  - Keep theirs: the controls show theirs, and the draft is gone after a remount;
  - dismiss: the draft survives a remount;
  - two consecutive own saves on one row send no conflicting version (with timing: the second blur lands while the first is in flight);
  - after the operator's own save with focus back in the row, the next edit is based on the saved version;
  - focus a row, another person's change lands, leave without typing: nothing is sent;
  - a save queued behind a conflicting one is not sent after Keep theirs;
  - Keep theirs while virtualization has remounted the row: the remounted copy shows theirs;
  - dismiss, then leave the row again: the dialog shows again (the seed did not follow `current`);
  - a failed save, then another person's change lands while the row is unfocused, then leave the row again: a conflict, not a silent overwrite.
  Red, then `EventLogRow.tsx` and `EventLogSheet.tsx` (inline, seed store).
- [ ] 6.2 Test first: `EventLogSheet.test.tsx` covers:
  - batch of three with a conflict on the second, Keep theirs: the third still saves and batch mode ends;
  - a 500 on the second stops the batch, and a second Save sends only the unsettled rows;
  - dismissing a batch conflict stops the batch and keeps the rest;
  - a pending batch delete that conflicts, then Delete anyway: `?version=N&overwrite=1`;
  - a non-batch delete conflict, then Keep theirs: the row stays;
  - a delete that 404s shows the existing message and no dialog;
  - another person's change lands before the operator touches a row; then a batch edit, a batch delete and a non-batch delete of it: no prompt.
  Red, then the batch and delete code.

## 7. Transcript and topics (D9)

- [ ] 7.1 Test first: `TranscribeFeed.drafts.test.tsx` covers:
  - a word PATCH carries the base version;
  - conflict then Overwrite;
  - conflict then Keep theirs: the draft is cleared and the row shows theirs;
  - dismiss keeps the draft;
  - two quick field commits on one word don't conflict;
  - a one-field Overwrite, then a blur of an untouched sibling field: no stale text is sent;
  - Keep theirs lists every field that holds operator text;
  - focus and leave without typing after another person's change: nothing is sent;
  - a server error shows an error toast and keeps the draft.
  Red, then `TranscribeFeed.tsx` and `TranscribeRow.tsx` (seed store, seed-based comparison).
- [ ] 7.2 Test first: `TopicsFeed.test.tsx`, plus `TopicsRow.test.tsx` per D10 category 5 (the PATCH-body cases move to the feed or assert `onUpdate`), covers:
  - the PATCH carries the seed version;
  - conflict then Overwrite / Keep theirs / dismiss;
  - a dismissed topic, then refocus and blur: the operator's text is still there and the dialog shows again (the `startEdit` guard);
  - a server error shows a toast and keeps `edit`;
  - one dialog serves the whole feed.
  Red, then move the save and seed store into `TopicsFeed.tsx` and update `TopicsRow.tsx`.

## 8. Docs, QA and checks

- [ ] 8.1 ADR 0021: add a 7c-2 entry under item 7 with the owner decisions. Note that 7c is complete.
- [ ] 8.2 QA walk. Copy the walk from the latest archive's `qa/`, then capture before and after at 1440 and 390; every existing screen must stay at 0% change. Then exercise each conflict path with two agent-browser tabs on the ATS_youtube session:
  - event inline edit: Overwrite, Keep theirs, Escape;
  - event batch with a conflict;
  - transcript word conflict;
  - topic conflict.
  Event delete conflicts are left to the owner (the QA tooling cannot click Delete). Record the screenshots and results in `qa/README.md`, and query `catalog.session_overwrites` to show rows appear only for overwrites.
- [ ] 8.3 The owner's pass and review: two tabs, every dialog path including Delete anyway.
- [ ] 8.4 Checks: the full web suite, `npm run typecheck`, biome, the server fixture-capture test, and `openspec validate --all --strict`. Add the tier-2 consistency read. Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook` and `--stage pr`, recording the deferred storage contention flake if it fires.
