# web-ui-system — delta

## MODIFIED Requirements

### Requirement: The Settings modal costs nothing while closed
While the Settings modal is closed it SHALL perform no form-initialisation work and SHALL render
no element tree. Specifically: the initialisation that hydrates show drafts from the profile SHALL
NOT run until the modal is open, and the modal SHALL render nothing while closed rather than
building a tree the dialog primitive then declines to show.

The shell SHALL mount the modal **only while it is open**. The mount is gated on `showSettings` —
a piece of shell state — and the modal's module is fetched as a lazy chunk through the shared
`LazyChunk` boundary, warmed by an idle prefetch 2.5 s after load. The previous mechanism (an
unconditional mount relying on the dialog primitive to render nothing while `open` was false)
SHALL NOT be restored: behind a lazy chunk it would download the modal's bytes on every page load,
which is the cost the split exists to remove.

Route-change survival is unchanged and remains normative: the gate SHALL be shell state and SHALL
NEVER be the URL or a route branch, so an open modal survives a route change instead of
desynchronising `showSettings` from what is rendered. Beyond the mount gate this SHALL be
behaviour-neutral — it SHALL NOT change what an open modal shows, and the deferred-initialisation
discipline inside the modal SHALL remain in force (the modal still gates its own hydration on
`isOpen`, so the guarantee does not depend on the mount gate alone).

The chunk boundary is an **overlay** boundary with a `null` fallback: while a cold settings chunk
is in flight, nothing is rendered on screen and the invoking control offers no busy affordance.
This is a known, unclosed gap recorded in this change's proposal, not a property of this
requirement.

#### Scenario: Initialisation is deferred until the modal opens
- **WHEN** the app loads with the modal closed and the profile query resolves
- **THEN** no show drafts are hydrated and no form state is initialised, and that work happens on
  the first open instead — once, not twice

#### Scenario: A closed modal renders nothing
- **WHEN** the shell renders with the modal closed
- **THEN** the modal contributes no elements — it is not mounted at all, and its module is not
  fetched by the initial page load

#### Scenario: A cold first open traverses the chunk boundary
- **WHEN** the user opens the modal before the idle prefetch has completed
- **THEN** the lazy chunk is fetched, the boundary's `null` fallback renders nothing for the
  duration of that fetch, and the modal appears once the chunk resolves

#### Scenario: An open modal is unaffected
- **WHEN** the user opens the modal, and while it is open the route changes
- **THEN** the modal opens on the General tab fully initialised, and it stays open and functional
  across the route change exactly as before

## ADDED Requirements

### Requirement: The playback tick is fenced at named memo boundaries
Audio playback drives a `requestAnimationFrame` loop that pushes the absolute timeline second into
session-workspace state — `audioPlaybackSec`, a `useState` at the top of `SessionWorkspace` — on
every frame.

**What this requirement does not claim.** Because that state lives at the top of the workspace,
`SessionWorkspace` re-renders on every playback frame **by design**, and so does every part of its
tree that is not behind a memo boundary: the maximise strip and the Timeline that read the second,
and alongside them the headless audio components (`AudioRecorder`, `AudioPlayer` — bare
`forwardRef`s), the shortcuts dialog, the chunk-rescue banner, the tab strip, the six tabpanel
wrapper elements, and the surrounding section chrome. This requirement asserts nothing about how
often any component renders, and no sentence in it may be read as a per-component re-render
assertion — the instrument that would verify such a claim is not available here (see *Evidence and
instrument* below).

**What SHALL hold** is prop stability and memo bail-out at named boundaries, so the expensive
subtrees stay out of the per-frame path even though their parent is in it — the point of the
fencing is the 66-event feed row set and the marker list, not the chrome:

- Each of the six feed panels (`EventLogSheet`, `TranscribeFeed`, `TopicsFeed`, `AiPanel`,
  `AiV2Panel`, `ExportFeed`) SHALL be `memo()`-wrapped and SHALL take `sessionId` as its only
  prop, and the map of panel elements SHALL be memoised on `sessionId` alone — so a tick-driven
  render of the workspace hands each wrapper the referentially identical element it held on the
  previous frame, carrying an unchanged prop set.
- `TimelineMarkers` SHALL be `memo()`-wrapped, and every prop it receives SHALL hold a stable
  identity across a tick-driven render: its four mouse handlers are `useCallback`-stable in
  `Timeline`, and `events` / `status` / `totalSec` / `selectedEventId` are query-derived. The
  Timeline around it re-renders each frame to move the playhead; the marker list's inputs do not
  move with it.

**Deliberate invariant a future reader might undo.** Every prop crossing one of these memo
boundaries SHALL hold a stable identity across a tick-driven render. Adding an inline handler, an
object or array literal, or any per-frame value to the props of a fenced component silently
reopens the cascade — the component keeps its `memo()` wrapper and stops bailing out, with no test
failure and no type error to signal it.

**Evidence and instrument.** The outcome claimed for the shipped fencing is a **frame-timing**
one: **zero long tasks during steady playback** on a 66-event session. Render counts are **not** a
valid instrument for anything in this requirement — the profiling tool's React render counts
over-count badly in this app, which is why the re-render assertion recorded under this
capability's `The shell-to-workspace render boundary stays memoizable` was withdrawn. Any future
edit here SHALL keep the claim on the frame-timing and prop-identity side of that line.

Honest limits: the fencing is currently **comment-enforced only** — no test pins the fenced prop
sets, and `WorkspaceStatic` (the outermost render-isolation memo) has no characterization test at
all, because every test that touches it mocks it away. A future change that widens one of these
prop sets will not be caught mechanically.

#### Scenario: Steady playback stays inside the frame budget
- **WHEN** audio plays back on a 66-event session at the audited viewport, with no session change
  and no query result changing
- **THEN** that playback stretch records no long task and no dropped frame attributable to the
  workspace render

#### Scenario: The fenced components' props do not move with the tick
- **WHEN** the playback second advances from one frame to the next
- **THEN** each feed panel's element and its `sessionId` prop, and every prop passed to
  `TimelineMarkers`, are referentially identical to what they were on the previous frame

#### Scenario: A genuine input change still reaches the affected panel
- **WHEN** a feed panel's own input changes — the session id changes, or a query it owns returns
  new data
- **THEN** that panel updates to reflect it; the fencing withholds nothing that a changed input
  should produce

### Requirement: The Settings shows section says why it has nothing to show

The Settings modal's shows section is fed by a per-studio shows query, and its readiness flag only
ever flips on success. Two non-success outcomes therefore used to be rendered as "Loading shows…"
forever: a **failed** fetch, whose answer has already come back, and an **offline-paused** fetch,
which under react-query's default `networkMode: 'online'` is held rather than run — so `isPending`
stays true and `isError` stays false indefinitely.

The section SHALL distinguish three states, not two: loading, unavailable-because-failed, and
unavailable-because-offline. The offline state SHALL be identified by the query's own
`fetchStatus === 'paused'` (ANDed with `isPending`, so a paused *background* refetch over drafts
already on screen — which withholds nothing — says nothing), and SHALL be suppressed entirely for
a disabled query (an account with no team never fetches, so it neither errors nor pauses). Each
state SHALL carry copy of its own in both the show picker and the show-fields placeholder: the
picker shows `— Offline —`, `— Unavailable —`, or `Loading shows…`, and the placeholder says
`You’re offline — can’t load shows.`, `Couldn’t load shows.`, or `Loading shows…`.

**A Retry SHALL be offered on the error state and SHALL NOT be offered on the offline hold.** On
error it is the only way out without reopening the modal, since the readiness flag never flips on
an errored query. On the offline hold it would be a dead control: `refetch()` on a paused query
reaches `Query#fetch` with `fetchStatus === 'paused'` and `data === undefined`, which takes the
`retryer.continueRetry()` branch — that only clears the retry-cancelled flag and returns the
still-pending promise, starting no fetch. What resumes a paused query is `onlineManager` firing on
reconnect, with or without a click, so the offline branch SHALL instead state that recovery is
automatic (`Shows will load on their own once you’re back online.`).

Both unavailable states SHALL scope to the **shows** section only. Neither reaches the readiness
flag, so the shows scope contributes nothing to the modal's dirty state and a save omits
`show_updates` — while the **account scope stays fully editable and saveable throughout**. The
Add-Show control and the show picker stay disabled/hidden while shows are unavailable, because
there is no studio-scoped show list to act on.

#### Scenario: A failed shows fetch is named and retryable

- **WHEN** the shows query for the selected team fails
- **THEN** the picker reads `— Unavailable —`, the placeholder reads `Couldn’t load shows.`, and a
  Retry control is offered that re-issues the query

#### Scenario: An offline hold is not shown as loading, and offers no dead Retry

- **WHEN** the browser goes offline while the shows query is pending, so the fetch is paused
- **THEN** the picker reads `— Offline —`, the placeholder reads `You’re offline — can’t load
  shows.`, no Retry is offered, and the section states that shows will load on their own once
  connectivity returns

#### Scenario: The account scope is unaffected by an unavailable shows query

- **WHEN** the shows query is failed or offline-paused and the user edits an account field
- **THEN** Save arms and a save succeeds, carrying the account edit and omitting `show_updates`

#### Scenario: A team-less account sees neither unavailable state

- **WHEN** the modal is open for an account with no team, so no shows query is issued
- **THEN** the section reports neither the error nor the offline state — the disabled query is not
  an unavailable one
