# Design: session-edit-conflicts (ADR 0021 slice 7c-2)

## Context

7c-1 (`session-row-versions`, archived 2026-10-06) shipped the server half. Line numbers below are
from base `7aec147b`.

**Version guards.** Six routes take an optional version guard:

| Route | Guard |
| --- | --- |
| `PUT /api/sessions/:id/events/:eventId` | body `version`, `overwrite` |
| `PATCH …/transcript-words/:wordId` | body `version`, `overwrite` |
| `PATCH …/topics/:topicId` | body `version`, `overwrite` |
| `DELETE` of the same three | query `?version=N[&overwrite=1]` |

- `overwrite` without `version` is a `422`.
- In a query, `overwrite` must be the literal `1`.

**Responses.**
- **Stale version:** the answer is `409 {"detail":"Version conflict.","current":<row>}`, and
  nothing is written.
  - `current` is the route's success shape with its current `version`.
  - For events that is the enriched event (`server/src/routers/events.ts:704,719`); for words,
    `wordApiDict` (`transcribe.ts:214,226`); for topics, the raw `Topic` (`transcribe.ts:389,401`).
- **Missing row:** the existing `404` (`Event not found.` and the like), never a `409`.
- **Overwrite:** an overwrite is a retry carrying `current.version` plus the overwrite flag. The
  check still runs, and a passing overwrite that changes the row is audited.

**What carries `version`.**
- Every event, word and topic in a list, create or update response carries `version`.
- No WebSocket frame carries one. Event writes push `event.changed {revision}`, which the web
  turns into a refetch. Words and topics push nothing.

**The web today:**
- It sends no version.
- `ApiError(status, message)` drops the error body (`web/src/api/client.ts:3-35`).
- The row types lack `version` (`web/src/api/types.ts:328-340, 352-360, 485-496`).
- Mutations are not optimistic; they invalidate on success.

**Edit surfaces:**

| Surface | Code | How it saves |
| --- | --- | --- |
| Event inline edit | `EventLogSheet.handleInlineSave` 823-869 via `EventLogRow.saveInline` 455-489 | on blur, draft-store backed |
| Event batch save | `handleSaveBatch` 767-786 | iterates `batchEdits` then `pendingDeleteIds`, stops at the first failure |
| Event delete | `handleDelete` 875-895 | after the sheet's own "Delete log row" confirm |
| Word edit | `TranscribeFeed.handleUpdate` ~124-150 via `TranscribeRow.commitField` 204-215 | one field per blur, draft-store backed; errors swallowed |
| Topic edit | `TopicsRow.commitField` ~109-120 | `update.mutate` fire-and-forget, local `edit` state, no error handling |

Owner decisions are in proposal.md: Overwrite / Keep theirs; delete wording; dismissal keeps the
draft; all six hooks; batch continues past conflicts; toast word and topic failures.

## Assumptions (each tested by the panel's assumption tester)

- **A1.** The fixture harness can capture a non-2xx JSON body. `expectCapturedResponse` asserts
  `spec.status ?? 200` and records the body (`server/src/test/apiFixtures.ts:222-247`).
- **A2.** The captured list and create fixtures already carry `"version": 1`, so making `version`
  required on the three types compiles against them. The hand-written `orphanFromSourceRead`
  literal in `types.conformance.test.ts` (~261-273) does not; it gains `version: 1`.
- **A3.** No other `409` uses `detail: "Version conflict."`. The AI single-flight `409` and the
  recording-lease `409` have different details.
- **A4.** `useConfirm` resolves a replaced pending confirm as `false`
  (`web/src/shared/ui/ConfirmDialog.tsx` `confirm`). So two conflict prompts in a row on one
  `useConfirm` would silently resolve the first as Keep theirs. Hence D5's queue.
- **A5.** In `ConfirmDialog`, the Cancel button and every dismissal (Escape, overlay click, mobile
  drag) all call `onCancel` (`ConfirmDialog.tsx:63-104`). A three-way result needs a separate
  dismissal callback.
- **A6.** `EventLogRow`'s server-sync effect skips a refetched `event` while focus is in the row
  (`EventLogRow.tsx:339-345`). So focused controls can show an older row than the cache, which is
  why D3 compares against the seed and not the live row.
- **A7.** `handleSaveBatch` keeps the whole `batchEdits` map on a failure, so pressing Save again
  re-sends rows that already saved (`EventLogSheet.tsx:767-786`).

## Decisions

### D1. The client keeps the error body

- `ApiError` gains `readonly body?: unknown`: the parsed JSON of a non-2xx response, untyped.
- `detail` and `message` are derived exactly as today. A non-JSON error body leaves `body`
  undefined.
- The error probe's exemption key in `apiResponseShapes.repo.test.ts` is re-keyed to the new
  line. Its reason states that the body stays `unknown` until D2 types it.

### D2. `web/src/api/versionConflict.ts` (no React)

```ts
export interface VersionGuard { version?: number; overwrite?: boolean }
export function guardBody(g?: VersionGuard): { version?: number; overwrite?: true };
export function versionQuery(g?: VersionGuard): string;   // '' | '?version=N' | '?version=N&overwrite=1'
export function versionConflictOf<C extends VersionConflict<{ version: number }>>(e: unknown): C | null;
```

- **Guard helpers.** `guardBody` and `versionQuery` return nothing for an absent guard or an
  absent version, which is last-writer-wins, byte-identical to today's request. They throw on
  `overwrite` without `version`, because that is a programming error the server would `422`.
- **Matching a conflict.** `versionConflictOf` matches only when all of these hold:
  - `e instanceof ApiError`;
  - `status === 409`;
  - `body.detail === 'Version conflict.'`;
  - `body.current` is a non-null object with a numeric `version`.

  Anything else returns `null`, and the caller rethrows. This is one discriminator on the error
  path, not per-response runtime shape checking (web-api-response-conformance "Verification is
  build-time").

### D3. The base is the seed: the server row the controls were filled from

One rule covers every surface. Each editable row has a **seed**: the server row whose text its
controls were last filled from. A save sends `seed.version`, and decides what changed by
comparing the controls against the **seed**, never against the cached row. The cached row's
version is **never** used as a base, and no surface has a fallback to it. Panel finding 1
(critical) traced every missed conflict to such a fallback.

**The seed store.** Each feed owns one (`createSeedStore<TRow>()` in
`web/src/pages/index/utils/seedStore.ts`, a mutable `Map<id, TRow>` behind stable callbacks,
like the draft store).
- It survives row unmount, so a remounted row keeps the base its draft was typed over.
- The feed clears it with its drafts on a session change.
- The draft store is unchanged; a draft's base is its row's seed.
- Words and topics wrap it in `createRowSeeds` (`web/src/pages/index/utils/rowHolds.ts`): the
  store plus counted **holds** (a row registers one while its `edit` exists, so the feed's
  `followServer` freezes that seed) and a per-row subscription that notifies on every seed
  change.

**When the seed changes.** The rule is: **the seed follows the server row exactly while the
row's controls do**. That means the row holds:
- no draft;
- no batch values;
- no `edit` (words and topics);
- no save in flight or queued for it (`useVersionedSave.isBusy(rowKey)`);
- for an Event Feed inline row, no focus.

Otherwise the seed is frozen. Being unfocused alone is not "holds no edit": drafts outlive focus
through a save in flight, a failed save or a dismissed conflict (re-panel finding).

| Event | Seed |
| --- | --- |
| The row holds none of the above and the server row changes (any mode: inline, batch or idle) | the current server row |
| The event row's inline resync runs while a draft field survives its `clearMatching`, or while the row is busy | unchanged. The resync may refill untouched controls, but leaves the seed alone. |
| Editing starts (the first keystroke, the first batch change, or `startEdit` creating `edit`) | frozen at its current value |
| A save settles `saved` | the response row (D4 rebase) |
| Keep theirs | `current` (D5) |
| Dismissal or a non-conflict failure | unchanged |

The feed applies the first row when its list data changes, for every row that qualifies, so the
seed also follows in batch and idle modes, where `EventLogRow`'s resync effect does not run.
Batch and delete bases are therefore the row the operator is looking at, and never cause false
conflicts.

**Comparing against the seed.** With the seed as reference:
- Focusing a row and leaving without typing sends nothing, even if someone else changed the
  row meanwhile. Today `saveInline` and `commitField` compare against the live row, so stale
  controls look like an edit and silently revert the other person (panel findings).
- Event inline: `EventLogRow.saveInline` compares against the seed (`syncedEventRef` becomes the
  seed store's entry).
- Words: `TranscribeRow.commitField` compares against the seed's field.
- Topics: `TopicsRow.commitField` compares against the seed's field.

**Starting an edit keeps what is there.** `TopicsRow.startEdit` gains the `prev ??` guard that
`TranscribeRow.startEdit` already has. So refocusing a field after a dismissed conflict keeps
the operator's text instead of re-snapshotting the row (panel finding 2, critical).

**Batch.**
- `batchEdits` becomes `Map<id, {values, seed}>`. The seed is frozen at the row's first batch
  change, and it equals the row the batch values were built from.
- `pendingDeleteIds` becomes `Map<id, seedVersion>`.
- A non-batch delete takes the row's seed version when Delete is activated.

### D4. Saves are serialized per row, and each save's outcome is applied before the next starts

Two fields of one row can each commit before the first response returns. `useVersionedSave`
therefore chains saves per `rowKey`.

**Inside the chain.** The caller's outcome handlers (`onSaved`, `onKeptTheirs`, `onDismissed`)
run **before** the row is released. The next queued save reads its base (a thunk over the seed
store) only after that, so it always sees the rebased seed. This fixes panel finding 4: the
earlier design rebased in the caller after `await run()`, and a queued save could read the old
base first.

**Rebase on `saved`.** The new seed is the response row. Each control that held the old seed's
text (untouched) is refilled from the response row. A control whose text differs from the old
seed (the operator's unsaved text) keeps it. This is a three-way rule: old seed, operator's
text, new row. It means a one-field word or topic save, or an Overwrite, never leaves a sibling
control showing stale text that a later blur would send with the newer base (panel finding).
- For event rows, every inline save submits all four fields, so nothing is left to refill.
- For words and topics, `edit` holds only the fields that diverge from the seed; untouched
  controls render from the row's current seed, read through the `createRowSeeds` subscription.
  So when the feed rebases the seed, every mounted copy of the row (including one virtualization
  rebuilt while the save was in flight) shows the saved row, and a later blur of an untouched
  control sends nothing stale.

**Different rows** still save concurrently.

### D5. `useVersionedSave`: one save loop, one queued prompt

`web/src/shared/hooks/useVersionedSave.tsx`:

```ts
type SaveOutcome<R, C> =
  | { kind: 'saved'; result: R }
  | { kind: 'keptTheirs'; current: C }
  | { kind: 'dismissed'; current?: C };
useVersionedSave(sessionId: string): {
  run<R, C extends { version: number }>(opts: {
    rowKey: string;
    baseVersion: () => number | undefined; // reads the seed store; never the cache
    send: (guard: VersionGuard) => Promise<R>;
    conflictOf: (e: unknown) => C | null;
    prompt: (current: C) => ChoiceOptions;
    onSaved?: (result: R) => void;        // run inside the row's chain (D4)
    onKeptTheirs?: (current: C) => void;
    onDismissed?: () => void;
  }): Promise<SaveOutcome<R, C>>;
  isBusy: (rowKey: string) => boolean;  // a save in flight or queued (D3 follow rule)
  conflictElement: ReactNode;
};
```

**The loop:**
1. `send({version: baseVersion()})`. The base fails closed: an unknown base (`undefined`)
   rejects with an `Error` and sends nothing, never an unguarded last-writer-wins request.
   Every surface seeds each row it shows before the row can save, so no surface reaches it;
   the hooks' own optional guard (no guard is last-writer-wins, D8) is unchanged.
2. On a conflict, prompt:
   - **confirm** → `send({version: current.version, overwrite: true})`. Another conflict prompts
     again with the newer `current`.
   - **cancel** → `keptTheirs`.
   - **dismiss** → `dismissed`.
3. A non-conflict error rejects unchanged.

**A decision covers the row's queued saves.**
- After `keptTheirs` or `dismissed`, every save still queued on the same `rowKey` resolves with
  that same outcome **without sending**. A queued save holds text built from the old seed:
  - sending it after Keep theirs would silently overwrite the row the operator chose to keep
    (panel finding 1b, critical);
  - after a dismissal it would only meet the same conflict again.

  Its text is still in the draft or `edit`.

**Prompts are queued (FIFO).** One three-way decision (D7) serves the hook, and prompts are
asked one at a time, never replaced (A4).

**Session switch.** The feeds stay mounted across sessions (web-session-console: "the workspace
does not remount per session"). So when `sessionId` changes:
- the open prompt and every queued prompt resolve `dismiss`;
- every queued save is dropped without sending.

Each `run` also records the session generation when it starts. After **every** await inside
the loop (a send, or a prompt), a changed generation or an unmount resolves `dismissed` without
prompting or sending. So a `409` that arrives for a request in flight at the switch never opens a
prompt over the next session (re-panel finding). `send` closures are created with the session id
captured when `run` was called. The feeds' drafts
are cleared on a session change as today, so a dismissed draft does not cross sessions (panel
finding 3). Unmount behaves the same way.

**Keep theirs refills every mounted copy of the row.** `onKeptTheirs`:
- clears the row's draft;
- sets the seed to `current`;
- bumps a per-row **epoch** that the feed includes in the row's React `key`.

So the row remounts and fills from `current`, which D8 has put into the cache, even if
virtualization had already remounted it while the prompt was open (panel finding 1c).

**Copy** (new `web/src/shared/hooks/conflictPromptCopy.tsx`):
- **Edits:** title "Row changed", confirm "Overwrite", cancel "Keep theirs", danger styling.
- **Deletes:** title "Row changed", the changed-field lines, then "Delete anyway?"; confirm
  "Delete anyway", cancel "Keep theirs".
- **Which fields are listed:** every field where the operator's text in that row (the draft or
  `edit`, plus the patch being sent) differs from `current`. That includes a word's or topic's
  sibling fields, so Keep theirs never discards text the dialog did not show (panel finding).
- Lines are inline `<span class="block">`, because `ConfirmDialog` wraps the message in a `<p>`.
  Text is rendered by React, never as markup.
- Each value is truncated for display at 200 characters, so a huge field cannot push the
  buttons off-screen.

### D6. Typing `current` from captured responses

**Fixtures.** `server/src/routers/apiResponseFixtures.int.test.ts` gains 9 captures in its
events, transcript-words and topics blocks:

| Fixture | How it is produced |
| --- | --- |
| `eventUpdate`, `transcriptWordUpdate`, `topicUpdate` | 200, a versioned update |
| `eventUpdateConflict`, `transcriptWordUpdateConflict`, `topicUpdateConflict` | `status: 409`, a stale versioned update after an unversioned one |
| `eventDeleteConflict`, `transcriptWordDeleteConflict`, `topicDeleteConflict` | `status: 409`, a stale versioned delete |

They are captured with `npm run fixtures:capture -w server`, never hand-written.

**Types** (`web/src/api/types.ts`):
- `version: number`, required, on the three row types. The server always sends it, and an
  optional field would let a missing version quietly fall back to last-writer-wins.
- `VersionConflict<T> { detail: string; current: T }`.
- The aliases `EventVersionConflict`, `TranscriptWordVersionConflict` and
  `TopicVersionConflict`. Detectors match bare type names, so each needs an alias.

**Conformance** (`types.conformance.test.ts`):
- Each new fixture is assigned to its type.
- Runtime assertions pin `detail === 'Version conflict.'` and that `current.version` is the
  advanced version.

**Detector 8, `errorBody`** (`apiResponseShapes.repo.test.ts`):
- A `versionConflictOf<T>(` call is a response-consuming site. The callee name is resolved
  through its import from `api/versionConflict`, so an alias is followed.
- The site must name a covered `T`.
- It comes with a floor `errorBody: 6` (measured: the three hooks' sites, plus the three feed
  `conflictOf` sites in `EventLogSheet`, `TranscribeFeed` and `TopicsFeed` added during
  implementation; the first measure was 3), a canary in `useEvents.ts`, and synthetic-tree
  cases: an unchecked `T` fails and a covered `T` passes.
- The three DELETE exemptions whose keys contain the URL template are re-keyed. Floors are
  re-measured, with the arithmetic in comments.

### D7. A three-way themed decision

- `ConfirmDialog` gains an optional `onDismiss`. When it is absent, dismissal calls `onCancel`
  exactly as today, so every existing two-way confirm is unchanged.
- `useConfirm` gains `choose(opts): Promise<'confirm' | 'cancel' | 'dismiss'>`. A replaced or
  unmounted pending `choose` resolves `'dismiss'`. The boolean `confirm()` keeps resolving
  `false` in those cases.

### D8. Hooks own their cache

- Update variables gain `guard?: VersionGuard`.
- Delete variables become `{eventId | wordId | topicId, guard?}`. Their only consumer is
  `EventLogSheet`.
- Each update and delete hook has an `onError` that, when `versionConflictOf` matches, writes
  `current` into its cache and invalidates:
  - events: `setQueriesData` over `eventsKeys.all(sid)`, replacing by `event_id`;
  - words and topics: `setQueryData` on their key.
- The cache therefore always holds server truth, and the person's text lives only in the draft.
  That keeps "Keep theirs" in a component to clearing the draft and refilling the controls.

### D9. Surfaces

- **Event inline edit (`handleInlineSave`).**
  - `run({rowKey: eventId, baseVersion: () => seeds.get(eventId).version, onSaved, onKeptTheirs, …})`.
  - `onSaved`: the existing `clearMatching`, then the seed becomes the response row, then
    `showToast('Updated.')`.
  - `onKeptTheirs`: the D5 refill (clear the draft, seed = `current`, epoch bump).
  - `dismissed`: nothing; the draft stays.
  - **Not adopted from the first draft:** the "adopt the refetched row while focused" fix. The
    seed rebase on `saved` covers the self-conflict it targeted (scope finding), so
    `EventLogRow`'s focus guard is unchanged.
- **Event batch save (`handleSaveBatch`).**
  - Iterate a snapshot, sending each row's batch seed version.
  - Each `saved` or `keptTheirs` row is removed from `batchEdits` or `pendingDeleteIds` at once
    (functional `setState`), which fixes A7.
  - A `dismissed` prompt or a non-conflict error stops the batch with a toast. The remaining rows
    stay.
  - A prompt dismissed by a **session switch** ends the batch quietly, with no toast and no
    further rows: the existing session-change reset clears the batch and its drafts.
  - On full completion, batch mode exits. The toast is "Changes saved." plus ", N kept theirs"
    when N > 0.
- **Event delete (`handleDelete`).** After the sheet's own confirm, `run` with the delete copy and
  the seed version taken at click. Keep theirs and dismiss both leave the row.
- **Words (`TranscribeFeed`/`TranscribeRow`).**
  - The feed owns a seed store and holds (`createRowSeeds`, `utils/rowHolds.ts`).
    `TranscribeRow.startEdit` stamps the seed when it creates `edit`, and keeps an existing seed
    when `edit` comes from a restored draft. `edit` holds only divergent fields; untouched
    controls render from the subscribed seed (D4).
  - `onUpdate(wordId, patch)` runs with `baseVersion: () => seeds.get(wordId).version`.
  - `onSaved`: the D4 three-way merge of `edit`, then `clearMatching`.
  - `onKeptTheirs`: the D5 refill (whole-row draft cleared, which the prompt listed).
  - The bare `catch {}` becomes `showToast(message, true)`, and the draft is kept.
- **Topics (`TopicsFeed`/`TopicsRow`).**
  - `useUpdateTopic`, `useVersionedSave` and the seed store move up into `TopicsFeed`. It passes
    `onUpdate(topicId, patch, handlers)`, whose base is the thunk over the seed store.
  - `startEdit` gains the `prev ??` guard and stamps the seed only when it creates `edit`.
  - Seeds and holds as for words (`createRowSeeds`); `edit` holds only divergent fields and
    untouched controls render from the subscribed seed.
  - `commitField` compares against the seed and awaits the outcome:
    - saved: three-way merge of `edit`;
    - keptTheirs: refill;
    - dismissed: keep `edit`;
    - error: toast, and keep `edit`.

## Test strategy (D10)

Every behaviour is driven test-first, with `apiFetch` mocked through `vi.mock` of `api/client`
and the real `ApiError` (the repo's pattern; there is no msw).

- **Unit tests:**
  - `client.test.ts`, `versionConflict.test.ts`, `seedStore.test.ts`;
  - `useVersionedSave.test.tsx`, `ConfirmDialog.test.tsx`;
  - new hook tests per row kind.
- **Surface tests:**
  - `EventLogSheet.virtualization.test.tsx` (inline);
  - `EventLogSheet.test.tsx` (batch and delete);
  - `TranscribeFeed.drafts.test.tsx`;
  - `TopicsFeed.test.tsx` (topic saves now live in the feed).
- **Every panel scenario is a named test on the surface it names:**
  - focus without typing while another person's change lands: nothing is sent;
  - a queued save after Keep theirs is not sent;
  - Keep theirs while a remounted copy of the row is showing: it refills;
  - a dismissed topic, then refocus and blur: the dialog shows again;
  - a session switch with an open prompt and a queued one: nothing is sent and the dialog closes;
  - a 409 arriving after the session switch: no dialog and no second request;
  - an event dismiss, then blur again: the dialog shows again;
  - a failed save, then another person's change, then blur again: a conflict, not a silent overwrite;
  - a batch edit or delete on a row someone else changed before the operator touched it: no
    prompt;
  - two quick saves on one row, with timing: no self-conflict;
  - a one-field word Overwrite, then a sibling blur: no stale text is sent;
  - Keep theirs on a word lists every field with operator text.

**Existing tests that change.** Only these categories; any other change is a stop.
1. Row literals gain `version`, about 31 files.
2. Exact request-body or URL assertions gain the guard (any event or word body assertion).
3. Delete-hook call sites take the new variables object.
4. Guard keys and floors in `apiResponseShapes.repo.test.ts`.
5. `TopicsRow.test.tsx` cases that assert `apiFetch` PATCH bodies (154-262) move to
   `TopicsFeed.test.tsx` or assert the `onUpdate` prop instead, because the row no longer makes
   the request.
6. Mock servers in existing surface test files gain version checks and 409 responses, and
   file-wide mocks (e.g. `Toast`); no existing assertion changes.

## Risks and trade-offs

- **The base version is subtle.** A wrong seed either misses conflicts (it reads a too-new
  version) or invents self-conflicts (it reads a too-old one). Mitigations: the seed rules in D3,
  the serialization in D4, and self-conflict tests on every surface.
- **Whole-row choice.** Overwrite replaces every field the person's save sends, even a field the
  other person did not touch. That is what the server's check covers. Field-level merge is a
  non-goal.
- **Two dialogs.** The sheet's delete confirm and the conflict prompt are separate dialogs that
  appear one after the other, never together.
- **Mechanical diff.** Adding `version` to test literals touches about 31 files. It is mechanical
  but wide.
- **A larger guard.** Detector 8 adds code to an already large guard. Its synthetic cases keep it
  from being vacuous.

## Migration and rollback

There is no data or server change. Reverting the branch restores last-writer-wins on the web; the
server keeps accepting unversioned requests. The captured fixtures are additive.
