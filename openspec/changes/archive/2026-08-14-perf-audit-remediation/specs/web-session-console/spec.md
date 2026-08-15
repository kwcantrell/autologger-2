# web-session-console — delta

## ADDED Requirements

### Requirement: The event feed renders a windowed row set

The Event Feed SHALL mount only a window of its rows — the rows the scroll viewport can show,
plus a fixed overscan — rather than one `<tr>` per row in the filtered, sorted set. The window
SHALL be produced by `@tanstack/react-virtual`'s `useVirtualizer` using the **padding-row idiom
`TranscribeFeed` established**: a top spacer `<tr>` and a bottom spacer `<tr>`, each carrying a
computed height, inside the feed's real `<table>`. The feed SHALL NOT be re-expressed as a
`div` grid — the `<table>`, its `colgroup`, its column widths, and the surrounding sheet chrome
SHALL be unaffected by virtualization.

The virtualizer's scroll element SHALL be the OverlayScrollbars viewport that `FeedTable`
publishes through its `scrollRef` callback, and the total scrollable height SHALL correspond to
the **full** row count (spacer heights plus mounted rows), not to the mounted subset — so the
scrollbar, its thumb size, and the reachable scroll extent read the same as an unvirtualized
list.

Row height SHALL be a fixed estimate rather than per-row measurement, because every cell in the
row is `whitespace-nowrap` and therefore does not vary in height with content. The shipped
constant is `ROW_HEIGHT = 31` (measured against the compiled CSS in headless Chromium: a 30.44px
row dominated by the 24px jump button plus cell padding and the 1px border), with `overscan =
10`; both match `TranscribeFeed`. Where a row is genuinely shorter (an unresolvable timecode
renders no jump control), over-estimating SHALL be the accepted direction — extra scroll extent
is harmless, a short window is not.

Virtualization SHALL NOT change any behavior the feed already had: sorting, category and
internal-row filtering, the jump column (`Feed jump column`), inline and batch editing, and the
pagination sentinel that grows the loaded page SHALL behave as they did before. The sentinel
SHALL sit **after** the bottom spacer so it still marks the true end of the list.

**Reveal-in-feed SHALL keep working for a row outside the mounted window.** A timeline-marker
reveal targets an event by id; a row outside the window has no DOM node at all, so a poll for
`tr[data-event-id=…]` would never find it. The feed SHALL therefore park the requested id and,
in a following effect, scroll the virtualizer to that event's index **computed against the
rendered order** — the filtered, sorted list, never the raw event list — so that a descending
sort or a hidden category cannot scroll to the wrong row. Mounting the row SHALL be what lets
the workspace's existing scroll-and-flash retry loop find and flash it; the reveal path SHALL
continue to grow the loaded page first when the target is outside the fetched slice, and a
target that never renders (filtered out) SHALL park harmlessly rather than erroring.

#### Scenario: Only a window of rows is in the DOM

- **WHEN** a session with 66 events renders its Event Feed at the audited viewport
- **THEN** the number of event `<tr>` elements in the document is the visible window plus
  overscan (measured: 18) rather than 66, while the table's scrollable height still corresponds
  to all 66 rows

#### Scenario: Revealing an event outside the mounted window

- **WHEN** a timeline marker reveals an event whose row is not currently mounted
- **THEN** the feed scrolls the virtualizer to that event's index in the rendered order, the row
  mounts, and the existing scroll-and-flash retry finds it and flashes it

#### Scenario: Reveal follows the rendered order, not the raw list

- **WHEN** the feed's sort direction is changed (or a category is hidden) and a marker then
  reveals an event
- **THEN** the row that is scrolled to and flashed is that event's row, because the index was
  resolved against the filtered, sorted order

**A pending first fetch SHALL be a distinct state from an empty result.** The Event Feed SHALL
pass its events query's pending flag to `FeedTable` as `isLoading`, so while the first fetch is
in flight the table body renders the shared loading row rather than an empty `<tbody>` — matching
the `TranscribeFeed`/`TopicsFeed` idiom, where `isEmpty` is consulted only when not loading. The
previous form suppressed the empty state during the fetch (`isEmpty={sorted.length === 0 &&
!isPending}`) without putting anything in its place, so the sheet rendered a bodyless table until
rows arrived. The two states SHALL stay distinct in both directions: an empty-result message SHALL
never be shown for a fetch that has not settled, and a pending fetch SHALL show something.

#### Scenario: The first events fetch shows a loading row, not an empty sheet

- **WHEN** the Event Feed mounts and its events query is still pending
- **THEN** the table body contains the shared loading row and no empty-state message, rather than
  being empty until rows arrive

#### Scenario: Table chrome is unchanged by virtualization

- **WHEN** the Event Feed renders with virtualization active
- **THEN** the rows are `<tr>`s inside the feed's real `<table>` between two spacer rows, the
  column widths and header chrome are unchanged, and the pagination sentinel still sits at the
  end of the list

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
keystroke does not re-render the feed and every other mounted row with it — inline edit is live
exactly while timecode is rolling, the render-budget-critical state.

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
of silently reverting. The clear SHALL re-read the store at resolution time (never a value
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

### Requirement: The transcript-words fetch is deferred until a consumer is shown

The transcript word list is the largest payload the session workspace pulls. Because all six
workspace panels stay mounted (see `Workspace tab IA (single owner)`), four always-mounted
consumers used to request it on session mount whether or not the operator ever opened those
tabs. The workspace SHALL therefore publish a **sticky per-session gate**
(`TranscriptWordsGateContext`), and `useTranscriptWords` SHALL accept an `enabled` option that
its gated consumers pass.

The gate SHALL open on the first activation of a **words-dependent tab** — Transcript, Topics,
or Export. Once open it SHALL stay open for that session, so switching back to the Event Feed
neither cancels an in-flight fetch nor causes a re-issue on the next visit. It SHALL **reset on
session change**, so session B never inherits session A's activation; because the workspace does
not remount per session, the reset SHALL be a render-time comparison of the current session id
against the previous one, applied **before** re-latching from the currently selected tab (so
landing on session B while Transcript is already selected opens B's gate immediately).

The Dashboards panel SHALL require **two** conditions, not one: its displayed dashboard config
must contain a words-derived widget **and** the Dashboards tab must be currently shown. The
gate context therefore publishes a second, non-sticky field — whether Dashboards is the selected
tab — which the dashboards-side words trigger ANDs with its own config check. A saved dashboard
containing a words widget SHALL NOT pull the payload while the operator sits on the Event Feed.

Panel lifecycles SHALL be untouched: this gate changes only an `enabled` flag on a query, never
what is mounted. The context's defaults SHALL be **fail-open** (`true`): a consumer rendered
outside a provider — a colocated feed test, or any future standalone mount — behaves exactly as
it did before the gate existed, because the worst case of failing open is the previously shipped
unconditional fetch, whereas failing closed would be a silent data regression.

A load-bearing consequence SHALL be respected by every gated consumer: **a disabled pending
react-query query reports `isLoading === false`** (v5 computes it as `isPending && isFetching`).
A consumer that hides content while loading MUST therefore gate on `isPending` **and** its own
enabled flag, not on `isLoading`, or it will render an empty/"no data" state for data nobody has
fetched. (The related offline case is why the stronger signal is kept even though the
enabling-render flash did not reproduce on react-query v5: an offline-*paused* query genuinely
diverges.)

Measured outcome on the production build with the same session data: session-open API transfer
falls from ~5.3 MB to 172 KB, with the word payload (614 KB gzip) fetched only when first
needed.

#### Scenario: Opening a session on the Event Feed fetches no words

- **WHEN** a session workspace is opened and the Event Feed is the selected tab
- **THEN** no `transcript-words` request is issued

#### Scenario: Activating a words-dependent tab issues exactly one fetch

- **WHEN** the operator activates the Transcript tab for the first time in that session
- **THEN** exactly one `transcript-words` request is issued for that session

#### Scenario: The gate is sticky within a session

- **WHEN** the operator returns to the Event Feed after the words have been fetched
- **THEN** the query stays enabled — the fetch is neither cancelled nor re-issued, and returning
  to Transcript triggers no new request

#### Scenario: A saved words widget waits for its own tab

- **WHEN** a session whose persisted dashboard contains a words-derived widget is opened and the
  operator stays on the Event Feed
- **THEN** no `transcript-words` request is issued; it is issued only once the Dashboards tab is
  shown

#### Scenario: Switching sessions resets the gate

- **WHEN** the operator navigates from a session whose gate is open to a different session,
  while a non-words tab is selected
- **THEN** the new session's gate is closed and no `transcript-words` request is issued for it

## MODIFIED Requirements

### Requirement: Workspace tab IA (single owner)
This capability is the sole owner of the session-workspace tab inventory, order, and labels.
The workspace SHALL present exactly six top-level tabs in one `Feed tabs` tablist, in order:
**Event Feed, Transcript, Topics, Assistant, Dashboards, Export**, defaulting to Event Feed.
Transcript and Topics SHALL be top-level panels (not nested under an agent tab); the agent
surfaces carry the names "Assistant" (chat) and "Dashboards" (AI v2) — the labels "AI" and
"AI v2" SHALL NOT appear in the tab navigation (other capabilities' references to tab labels
are non-normative and defer here). All six panels SHALL stay mounted with visibility toggled
via the `hidden` attribute (the established mounted-hidden discipline), and the Dashboards
panel SHALL keep `key={sessionId}` at its mount site. (The Assistant panel is deliberately
NOT keyed by session — its cross-session conversation persistence is pre-existing behavior,
recorded as an accepted residual in design.) The Export panel SHALL present the session's
download actions inline (not as a dialog) and SHALL NOT depend on a Timeline Export control.

The mounted-hidden discipline is **deliberately preserved** — it is what keeps the chat stream
alive across tab switches — but two consequences of it are now load-bearing and are recorded
here so a future reader does not reintroduce them:

1. **Mounted-hidden SHALL NOT mean re-rendered on every workspace render.** Keeping six feeds
   mounted is affordable only because a workspace-level render (a playback tick, a transport
   change) does not carry into them. That property — its mechanism, its prop-stability rule, and
   the honest caveat that it is comment-enforced with no test behind it — is owned entirely by
   the `web-ui-system` requirement **`The playback tick is fenced at named memo boundaries`**,
   which is also where the limits of the claim are stated. This requirement neither restates nor
   strengthens it; it records only that the mounted-hidden discipline **depends** on it, so a
   change that weakens the fencing there makes the tab IA here expensive rather than free.
2. **Mounted-hidden SHALL NOT mean fetching.** A panel being in the DOM is no longer sufficient
   cause for its data to be requested; the transcript-words payload in particular is gated by
   `The transcript-words fetch is deferred until a consumer is shown` above. Adding a new
   always-mounted panel with an unconditional expensive fetch would silently undo that.

#### Scenario: Tab inventory and default
- **WHEN** a session workspace mounts
- **THEN** the `Feed tabs` tablist contains exactly Event Feed, Transcript, Topics, Assistant,
  Dashboards, Export, with Event Feed selected

#### Scenario: Chat survives tab switches (no unmount)
- **WHEN** the user switches from Assistant to any other tab and back
- **THEN** the chat panel's DOM node is the same object (never unmounted) and an in-flight
  stream is not aborted

#### Scenario: Tab strip on narrow viewports
- **WHEN** the viewport is under 768px wide
- **THEN** the tablist scrolls horizontally with single-line tab labels (no wrapping), and
  every tab remains reachable by keyboard

#### Scenario: Export tab is mounted-hidden like other feeds
- **WHEN** the user is on Event Feed (or any non-Export tab)
- **THEN** the Export tabpanel remains in the DOM with the `hidden` attribute set

#### Scenario: A mounted-hidden panel does not fetch its payload
- **WHEN** the Transcript, Topics, Export and Dashboards panels are mounted-hidden because the
  Event Feed is selected
- **THEN** those panels are present in the DOM and no `transcript-words` request has been issued

### Requirement: Inline editing is untouched by the jump column

Adding the jump column SHALL NOT change inline editing in any feed. No editable field SHALL gain,
lose, or change a handler *on account of the jump column*, become read-only, require a new
gesture, or have its containing block or width altered. How edits begin and commit, and keyboard
access to editing, SHALL be unchanged by the jump column. Activating a jump SHALL NOT focus an
editable field.

This guarantee is about the jump column and is unchanged. What has changed since it was written
is the **mechanism** underneath it: inline editing in the Event Feed and the Transcript feed is
now mediated by the shared draft store required by `Unsaved inline edits survive row unmount`
above — controls remain uncontrolled, but every keystroke is additionally written through to a
feed-owned store — and, in the Event Feed alone, by that requirement's focus record, which makes
the edited row's caret pinned and restorable.
The observable begin/commit behavior described here is what that machinery exists to preserve
across a virtualizer-driven unmount; it is not a licence to read this requirement as "no handler
on an editable field may ever change for any reason".

#### Scenario: Fields still edit exactly as before

- **WHEN** the user clicks or tabs into any editable field in a feed row and then blurs it
- **THEN** the edit begins and commits exactly as it did before this change

#### Scenario: Jumping does not start an edit

- **WHEN** the user activates a row's jump control
- **THEN** no editable field in that row receives focus, and no edit is begun

#### Scenario: Draft mediation is invisible to the operator

- **WHEN** the user edits an inline field in a virtualized feed and commits it by blurring,
  without the row ever unmounting
- **THEN** the commit is the same request with the same values it would have been before the
  draft store existed, and no additional gesture, control, or confirmation is involved
