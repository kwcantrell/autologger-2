# Spec Delta

## MODIFIED Requirements

### Requirement: Event filter checkmarks

In the event feed Filter menu, each toggled-on category (and Show internal
events when on) SHALL show a checkmark beside the label and SHALL expose its
state as `aria-checked`. Selected state SHALL be conveyed by the checkmark (and
`aria-checked`) alone: selected items SHALL NOT use a background or text
highlight tint, such as the selected tint used elsewhere for highlighted menu
items.

#### Scenario: Visible category shows checkmark

- **WHEN** a show category is not hidden by the filter
- **THEN** its filter row shows a checkmark, reports `aria-checked="true"`, and is
  not highlighted via a selected background or text tint

### Requirement: The event feed renders a windowed row set

The Event Feed SHALL mount only a window of its rows — the rows the scroll viewport can show,
plus a fixed overscan — rather than one `<tr>` per row in the filtered, sorted set. The window
SHALL be produced by `@tanstack/react-virtual`'s `useVirtualizer` using the **padding-row idiom
`TranscribeFeed` established**: a top spacer `<tr>` and a bottom spacer `<tr>`, each carrying a
computed height, inside the feed's real `<table>`. The feed SHALL NOT be re-expressed as a
`div` grid — the `<table>`, its `colgroup`, its column widths, and the surrounding sheet chrome
SHALL be unaffected by virtualization.

The virtualizer's scroll element SHALL be the feed's scroll viewport element that `FeedTable`
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

