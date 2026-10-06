# Session edit conflicts: the web sends the version an edit was based on and asks before overwriting

Tier: 2
Tier reason: this change is the client of the 7c-1 version contract. It adds an overwrite flow
that replaces another person's edit (a deliberate, audited data replacement), and it adds
captured fixtures in `server/src/routers/apiResponseFixtures.int.test.ts`, which is on a
high-risk path (test only; no server behaviour changes). ADR 0021 slice 7c-2.

Approved-by: Kalen 2026-10-06

## Why

Since 7c-1 the server can refuse a stale edit with
`409 {"detail":"Version conflict.","current":<row>}`, but the web never sends a version. Every
edit of an event, transcript word or topic is therefore still last-writer-wins, and a person who
saves second silently replaces someone else's work.

The web also can't read the `current` row today: `ApiError` keeps only `detail`/`message`. And no
row type declares `version`. Transcript-word and topic saves swallow failures, so even a plain
error goes unseen.

This change completes slice 7c. Each save carries the version the person's edit was based on. A
conflict asks whether to overwrite.

## Owner decisions (owner, 2026-10-06)

The plan of record is `~/.claude/plans/i-want-to-use-witty-wreath.md`.

1. **Two choices on a conflict.** The dialog offers **Overwrite** and **Keep theirs**, and shows
   theirs next to yours for the fields that differ. Overwrite retries with the server's current
   version plus `overwrite: true`; if a third person saves in between, the dialog appears again
   with their row. Keep theirs drops the person's draft and shows the server row.
2. **Delete wording.** A delete that meets a conflict is titled "Row changed". It shows what
   changed, asks "delete anyway?", and offers **Delete anyway** and **Keep theirs**. Keep theirs
   cancels the delete.
3. **Dismissing loses nothing.** Escape, an overlay click or a mobile drag-dismiss saves nothing
   and discards nothing. The text stays as an unsaved draft, based on the old version, so the next
   save meets the conflict again. A session switch also dismisses the prompt. Drafts are then
   cleared on the switch, as they are today for any unsaved edit.
4. **All six requests carry the version.** The hooks for event `PUT`/`DELETE`, word
   `PATCH`/`DELETE` and topic `PATCH`/`DELETE` all take an optional version guard.
   - The dialog is wired wherever the UI edits: event inline edit, event batch save, event delete,
     transcript word edit and topic edit.
   - Word and topic delete have no UI today, so they get the hook support only.
5. **Batch save continues past conflicts.** Each conflicting row prompts, and the batch then goes
   on with the rest. Any other error still stops the batch. A dismissed prompt also stops it, and
   the remaining rows stay pending.
6. **Report save failures.** Word and topic edits that fail for any reason other than a conflict
   show an error toast and keep the draft, as event edits already do.

## For the approver

- **What a person sees.** Nothing changes until two people edit the same row. Then the second
  save opens the dialog instead of silently winning.
- **What the server sees.** Requests gain `version` (body) or `?version=N` (delete query). An
  overwrite adds `overwrite: true` or `&overwrite=1`, and only an overwrite writes an audit row
  (7c-1).
- **Where the version comes from.** It is the version of the row the person **started** editing
  from, not the version in the cache at save time (design D3). A background refetch during typing
  must not move it, or the conflict would be missed.
- **No self-conflicts.** A person's own saves on one row run one at a time, and each reads the
  version the previous save returned (design D4). Two quick blurs on one row never conflict with
  each other.
- **Nothing is lost by accident.** Only an explicit Keep theirs discards text (decision 3).
- **Fixtures.** The `409` body is typed from captured responses, not hand-written ones (design
  D6). The response-shape guard gains a detector, so a future typed error body can't skip the
  check.

## What Changes

- **API client**
  - `ApiError` carries the parsed error body.
  - A new `web/src/api/versionConflict.ts` builds the guard (body fields and delete query) and
    recognises a version-conflict `409`.
- **Types:** `version: number` on `LogEvent`, `TranscriptWord` and `SessionTopic`; the version
  fields on `EventUpdateBody`; and the conflict envelope types.
- **Hooks:** the six mutations take an optional guard. On a conflict they write the server's
  `current` row into their query cache.
- **Save loop:** a shared `useVersionedSave` hook runs it:
  - per-row serialization;
  - a queued conflict prompt;
  - the overwrite retry loop;
  - outcomes `saved` / `keptTheirs` / `dismissed`.
- **Confirm dialog:** `ConfirmDialog`/`useConfirm` gain a three-way choice (confirm / cancel /
  dismiss). The boolean `confirm()` is unchanged.
- **Seeds:** each feed keeps a per-row seed, the server row the controls were filled from, in a
  store that survives unmount. Saves send its version and compare against it (design D3).
- **Event feed**
  - Inline edit, batch save and delete send the base version and handle conflicts.
  - Batch save drops each row once it is settled, so a retry never resends a saved row.
  - Focusing a row and leaving it without typing sends nothing. Today stale controls look like an
    edit and silently revert another person's change.
- **Transcript and topics:** word edits and topic edits handle conflicts and toast other failures.
  The topic save moves up from `TopicsRow` into `TopicsFeed`, so one dialog serves the feed.
- **Fixtures and guards**
  - 9 new captured fixtures (update success, update conflict, delete conflict for each row kind).
  - Conformance assignments.
  - A new `errorBody` detector in `apiResponseShapes.repo.test.ts`.
  - Re-keyed exemptions and re-measured floors.
- **Docs:** a 7c-2 entry in ADR 0021.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `web-session-console`
  - ADDED "Content edits carry the version they were based on".
  - ADDED "Version conflicts ask before overwriting".
  - ADDED "Transcript and topic save failures are reported".
  - MODIFIED "Unsaved inline edits survive row unmount": a draft's base is its row's seed,
    which survives unmount, and an explicit Keep theirs is a clear.
- `web-ui-system`: MODIFIED "Themed confirmations replace browser chrome". A three-way decision
  resolves dismissal separately from its cancel action.
- `web-api-response-conformance`: MODIFIED "Every response-consuming site has a recorded
  conformance verdict". A typed error body is a site, and it is checked against a captured
  non-2xx response.

## Impact

- **Web**
  - `web/src/api/{client.ts,types.ts,versionConflict.ts}` and `web/src/api/hooks/{useEvents,useTranscriptWords,useTopics}.ts`.
  - `web/src/shared/ui/ConfirmDialog.tsx` and the new `web/src/shared/hooks/useVersionedSave.tsx`
    and `web/src/shared/hooks/conflictPromptCopy.tsx`.
  - the new `web/src/pages/index/utils/seedStore.ts` and `web/src/pages/index/utils/rowHolds.ts`.
  - `EventLogSheet.tsx`, `EventLogRow.tsx`, `TranscribeFeed.tsx`, `TranscribeRow.tsx`,
    `TopicsFeed.tsx` and `TopicsRow.tsx`.
  - About 31 test files whose row literals gain `version`.
- **Server (tests only):** `server/src/routers/apiResponseFixtures.int.test.ts` and 9 new files
  under `fixtures/api-responses/`.
- **Guards:** `web/src/apiResponseShapes.repo.test.ts` and `web/src/api/types.conformance.test.ts`.
- **Docs:** `docs/decisions/0021-migrate-to-self-hosted-supabase.md`.
- **Unchanged:** server routes and behaviour, `packages/contract`, the WebSocket and Companion.

## Non-goals

- **Server:** no change to the server or the contract. `api-contract-freeze` is untouched.
- **Live updates:** no WebSocket frames for words or topics, and no live "someone else is
  editing" indicator. A conflict is found at save time only.
- **Audit:** no viewer for the overwrite audit, and no retention policy for it.
- **Delete UI:** no UI for word or topic delete.
- **Unchanged behaviour:**
  - a batch delete that meets a `404` (row already gone) still stops the batch;
  - Companion requests stay unversioned;
  - the web still ignores `events_stream_revision`;
  - no merging of field-level edits (the choice is whole-row Overwrite or Keep theirs).

## After merge

The QA walk on the dev stack exercises each dialog path with two browser tabs on one session. The
owner confirms that only overwrites add rows to `catalog.session_overwrites`.
