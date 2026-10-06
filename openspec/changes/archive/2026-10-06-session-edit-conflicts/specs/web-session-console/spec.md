## MODIFIED Requirements

### Requirement: Unsaved inline edits survive row unmount

The Event Feed's and the Transcript feed's inline edit controls are **uncontrolled**, and both
feeds are virtualized — so the only copy of an in-progress edit used to live in a DOM node the
virtualizer could remove without React ever firing a blur, silently discarding the operator's
typing. Both feeds SHALL therefore back their inline edits with a **feed-owned draft store**
(`web/src/pages/index/utils/draftStore.ts`), one shared primitive rather than two per-feed
implementations, so the two cannot drift on the rule that is easy to get wrong: when a draft
stops being live.

A row SHALL write its raw control text through to the store on **every keystroke**, keyed by row
id, and a remounting row SHALL re-seed its controls from the store rather than from the server
value. Drafts SHALL be held in a mutable store behind stable callbacks (not React state), so a
keystroke does not re-render the feed and every other mounted row with it.

The two feeds reach inline edit by different routes, and this requirement binds both. In the
**Event Feed**, inline controls are live while the session is rolling **or** an audio recording
lease is alive, and batch-edit mode is off — batch edit being the stopped-state editing surface,
whose entry ends inline edit and drops every inline draft. That window is the one under render
budget pressure (the playback tick is running and new events are arriving), which is why the
store-not-state rule bites hardest there; it is not what makes the rule required. In the
**Transcript feed** the row controls carry no transport gate at all: they are editable whenever
the feed is shown, rolling or stopped. Nothing here narrows `Inline editing is untouched by the
jump column`, and the editing gate is independent of the jump gate in
`Feed jumps are gated to when timecode is not rolling` — in the Transcript feed both can be
available at once.

Every comparison that decides whether a draft is spent SHALL be made in **draft space** — raw
control text against the raw text the controls would render from the current server row — never
in value space (trimmed, parsed, or normalized), because a half-typed date has no parsed form at
all and a trimmed message hides trailing whitespace, so a value-space match reports "unchanged"
for text the control is still displaying.

A clear SHALL name the fields it covers. The store's `clearMatching(id, reference, covered)`
takes an **explicit covered-field set** separate from the reference text: which fields a clear
speaks for is decided by what the save actually persisted, while what to compare them against
must be read from something wider than a partial patch. A one-field PATCH SHALL NOT discard a
sibling field's unsaved text. A covered field whose recorded text has **diverged** from the
reference SHALL be kept, and a field outside `covered` SHALL be left untouched.

A draft SHALL be cleared only once its save has **round-tripped**, never when the save is
issued, so a **failed** save leaves the operator's text recoverable on the next remount instead
of silently reverting. Besides that and the existing clears (a draft spent against the server
row, entry into batch edit, and a session change), the only other clear is the operator's
explicit **Keep theirs** on a version conflict (`Version conflicts ask before overwriting`). A
dismissed conflict prompt SHALL NOT clear anything.

A draft's **base** is its row's seed (`Content edits carry the version they were based on`). The
seed SHALL be feed-owned like the draft and SHALL survive row unmount, so a remounted row's next
save is based on the row the draft was typed over. The clear SHALL re-read the store at resolution time (never a value
captured before the await), so keystrokes typed during the round trip survive.

The focus half SHALL be handled too — **in the Event Feed only**. The clauses below are scoped to
that feed and describe what shipped there; the Transcript feed shares the draft store above but
has no focus record, no `rangeExtractor` pin, and no caret restore, so an unsaved Transcript edit
survives a remount as *text* while its caret does not. That asymmetry is recorded here as a known
bound of what shipped, not asserted away. In the Event Feed, the feed SHALL record which row is
being inline-edited and where its caret sits, in a ref-backed store (a caret move must not
re-render the feed), and:

- The edited row's index SHALL be **pinned into the virtual window** through the virtualizer's
  `rangeExtractor` seam, so incoming events that shift the row down the list do not unmount the
  focused input out from under the operator. Because the two-spacer idiom requires the rendered
  index range to be **contiguous**, the pin SHALL be a contiguous clamp — the window is extended
  to reach the pinned index — and SHALL be **bounded** (shipped: 50 extra rows), past which the
  pin is dropped rather than rendering an unbounded slab of gap rows.
- When a remount happens anyway, the remounting row SHALL restore focus and caret. The restore
  SHALL use `focus({ preventScroll: true })` so it can never yank the viewport of an operator
  who is scrolling rather than editing; SHALL apply only while focus is currently nowhere
  (`<body>`/`<html>`, or a disconnected node), never stealing focus the operator has moved
  elsewhere; and SHALL be refused once the record is **stale** (shipped bound: 30 s since the
  operator last touched that edit, re-stamped by the store on every focus or selection change).
- The feed SHALL additionally drop the focus record on the first interaction **outside** the
  edited row — a `focusin` outside it, or an outside `pointerdown` whose focus outcome one tick
  later is outside it — so an abandoned edit cannot pull the caret back later. Dropping the
  caret record SHALL NOT drop the draft: abandoning the caret is not abandoning the text, which
  stays recoverable until it is saved or superseded.

#### Scenario: Typing survives scrolling past the overscan

- **WHEN** the operator types into an inline field, scrolls the feed far enough that the row
  unmounts, and scrolls back
- **THEN** the remounted row displays the typed text, not the server value

#### Scenario: A one-field save keeps a sibling field's unsaved text

- **WHEN** a save persists one field of a row while another field of the same row holds unsaved
  text
- **THEN** the save's clear removes only the persisted field's draft, and the unsaved sibling
  text is still present when the row next remounts

#### Scenario: A failed save keeps the text recoverable

- **WHEN** an inline save is submitted and the request fails
- **THEN** the draft is not cleared, and the operator's text is what the row shows on its next
  remount

#### Scenario: The edited Event Feed row stays mounted as events arrive

- **WHEN** the operator is inline-editing an Event Feed row and new events arrive that shift it
  within the rendered order by fewer than the pin bound
- **THEN** the edited row remains mounted and focused, because the rendered range is extended
  contiguously to include it

#### Scenario: A restore cannot steal focus or scroll

- **WHEN** an edited Event Feed row remounts while the operator has focused something else, or
  more than the staleness bound has elapsed since the edit was last touched
- **THEN** no focus restore occurs; and when a restore does occur, it does not scroll the
  viewport

#### Scenario: A Transcript edit survives as text, not as a caret

- **WHEN** the operator types into a Transcript feed row and that row unmounts and remounts
- **THEN** the typed text is restored from the shared draft store, and the caret is not — the
  focus record and window pin are Event Feed machinery and do not exist in this feed

#### Scenario: A draft's base version survives a remount

- **WHEN** the operator types into a row whose server version is 3, the row unmounts, a refetch
  brings version 4 into the cache, and the row remounts
- **THEN** the remounted row shows the typed text, and its next save is based on version 3

## ADDED Requirements

### Requirement: Content edits carry the version they were based on

Every save of an event, transcript word or topic from the web SHALL be based on the row's
**seed**: the server row whose text the row's edit controls were last filled from. A save SHALL
send the seed's version, and SHALL decide which fields changed by comparing the controls against
the seed. It SHALL NOT use the cached row's version or text for either purpose. So a refetch that
lands while the operator edits can neither move the base nor make stale controls look like an
edit.

**Where the version goes**
- Event `PUT`, transcript-word `PATCH` and topic `PATCH` SHALL send it as the body field
  `version`. The three `DELETE`s SHALL send it as the query `?version=N`.
- The six client mutations SHALL take the guard as an optional input. Omitting it, or giving it
  no version, SHALL send exactly the request sent before this requirement (last-writer-wins).

**When the seed changes**
- The seed SHALL be feed-owned and SHALL survive row unmount.
- It SHALL follow the server row exactly while the row's controls do: the row holds no draft, no
  batch values and no edit in progress, has no save in flight or queued, and (for an Event Feed
  inline row) is not focused. This applies in every mode. Otherwise the seed SHALL be frozen; a
  dismissed conflict or a failed save leaves it at its old value. Starting an edit SHALL keep any
  text the row already holds.
- A successful save SHALL make the response row the new seed. Controls that still showed the old
  seed's text SHALL be refilled from the response row; controls holding the operator's unsaved
  text SHALL keep it.

**Saves on one row**
- Saves on one row SHALL run **one at a time**. Each SHALL read its base only after the previous
  save on that row has settled and its outcome has been applied.
- Saves on different rows MAY run concurrently.

**Batch and delete**
- In batch-edit mode, a row's base SHALL be its seed at its first batch change, which is the row
  the batch values were built from.
- A delete SHALL use the row's batch base when it has one, and its seed otherwise, taken when
  Delete is activated. A row nobody has touched therefore deletes against the version it shows,
  with no false conflict.

#### Scenario: Leaving a row without typing sends nothing

- **WHEN** the operator focuses an event row, another person's change to that row arrives, and
  the operator leaves the row without typing
- **THEN** no request is sent, and the other person's change stands

#### Scenario: A refetch during typing does not move the base

- **WHEN** the operator starts editing an event at version 2, another person's save advances it
  to 3, and the `event.changed` refetch lands before the operator's blur
- **THEN** the operator's save sends `version: 2` and receives the conflict, rather than silently
  overwriting version 3

#### Scenario: The operator's own consecutive saves do not conflict

- **WHEN** the operator commits one field of a row and then another field of the same row before
  the first response returns
- **THEN** the second save is sent after the first settles, with the version the first returned,
  and neither save meets a conflict

#### Scenario: Unversioned requests are unchanged

- **WHEN** a client mutation is called without a guard
- **THEN** the request body and URL are byte-identical to the request sent before versions
  existed

### Requirement: Version conflicts ask before overwriting

When a save meets `409 {"detail":"Version conflict.","current":<row>}`, the web SHALL ask the
operator before replacing the other person's change. This covers event inline edit, event batch
save, event delete, transcript-word edit and topic edit.

**The dialog**
- It SHALL be the shared themed decision dialog, titled "Row changed".
- It SHALL list theirs (from `current`) next to yours for every field where the operator's text in
  that row differs from `current`, including sibling fields the save does not send, so Keep
  theirs never discards text the dialog did not show.
- An edit SHALL offer **Overwrite** and **Keep theirs**. A delete SHALL end its message with
  "delete anyway?" and offer **Delete anyway** and **Keep theirs**.
- Row text SHALL be rendered as text, never as markup.

**The choices**
- **Overwrite / Delete anyway** SHALL resend the same edit or delete with `current.version` and the
  overwrite flag (`overwrite: true`, or `&overwrite=1`). If that meets another conflict, the
  dialog SHALL be shown again with the newer row.
- **Keep theirs** SHALL discard the operator's draft for that row, show `current` in the row's
  controls, and, for a delete, leave the row in place.
- **Dismissal** (Escape, overlay click or drag-dismiss) SHALL save nothing and discard nothing.
  The draft stays, with its old base, so its next save meets the conflict again.
- A decision other than Overwrite SHALL also settle every save still queued on the same row,
  **without sending it**. After Keep theirs, every mounted copy of the row SHALL show `current`.
- A **session switch** SHALL dismiss the open prompt and every queued one, and SHALL send no
  queued save. A conflict that arrives after the switch for a request sent before it SHALL open
  no prompt and send nothing. Drafts then follow the existing session-change clear.

**Several conflicts**
- Prompts SHALL be queued and asked one at a time. A prompt SHALL never be replaced by a later
  one, and SHALL never be resolved as Keep theirs without the operator choosing it.

**Batch save**
- A conflicting row SHALL prompt, and the batch SHALL then continue with the remaining rows.
- A dismissed prompt or any non-conflict error SHALL stop the batch with a toast, keeping the
  unsettled rows.
- Each row that is saved or kept-theirs SHALL leave the batch at once, so a later retry never
  resends it.

**Other errors**
- A `404` for a row that no longer exists SHALL keep its existing error message, with no dialog.
- After any conflict, the client's cached copy of the row SHALL be the server's `current`.

#### Scenario: Overwrite replaces the other person's change

- **WHEN** an inline event save meets a version conflict and the operator chooses Overwrite
- **THEN** the edit is resent with `current.version` and `overwrite: true`, and the row shows the
  operator's text

#### Scenario: Keep theirs shows the other person's change

- **WHEN** a transcript-word save meets a version conflict and the operator chooses Keep theirs
- **THEN** the operator's draft for that row is gone, and the row shows the server's current text

#### Scenario: Dismissing keeps the draft unsaved

- **WHEN** a topic save meets a version conflict and the operator presses Escape
- **THEN** nothing is sent, the operator's text is still in the row, and saving it again shows the
  dialog again

#### Scenario: A dismissed event edit asks again

- **WHEN** an event inline save meets a conflict, the operator dismisses the prompt, and then
  leaves the row again
- **THEN** the save is sent with the old base and the dialog shows again, rather than the other
  person's change being overwritten

#### Scenario: A third writer in between asks again

- **WHEN** the operator chooses Overwrite and another person saves the row before the retry
  arrives
- **THEN** the retry meets a conflict, and the dialog shows the newer row

#### Scenario: A queued save after Keep theirs is not sent

- **WHEN** a second save of a row is queued behind one that meets a conflict, and the operator
  chooses Keep theirs
- **THEN** the queued save is not sent, and the row shows the other person's version

#### Scenario: A session switch closes the prompt

- **WHEN** a conflict prompt is open and the operator switches to another session
- **THEN** the prompt closes, and no save for the previous session is sent

#### Scenario: A batch continues past a conflict

- **WHEN** a batch save of three rows meets a conflict on the second and the operator chooses Keep
  theirs
- **THEN** the third row is still saved, and batch mode ends

#### Scenario: A failed batch never resends a saved row

- **WHEN** a batch save's second row fails with a server error and the operator presses Save again
- **THEN** only the unsettled rows are sent

#### Scenario: Deleting a changed row asks first

- **WHEN** the operator confirms deleting a log row that another person changed since it was
  loaded
- **THEN** the "Row changed" dialog offers Delete anyway and Keep theirs, Delete anyway sends
  `?version=N&overwrite=1`, and Keep theirs leaves the row

### Requirement: Transcript and topic save failures are reported

A transcript-word or topic save that fails for any reason other than a version conflict SHALL
show an error toast carrying the server's message, and SHALL keep the operator's text so it can
be saved again. Event inline edits already behave this way.

#### Scenario: A failed topic save is visible

- **WHEN** a topic summary save fails with a server error
- **THEN** an error toast is shown, and the row still holds the operator's text
