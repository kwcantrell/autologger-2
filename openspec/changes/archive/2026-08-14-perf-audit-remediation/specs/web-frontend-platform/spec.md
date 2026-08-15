# web-frontend-platform — delta

## ADDED Requirements

### Requirement: The client island is route-split behind recoverable boundaries

The single `ssr: false` client island SHALL NOT ship the whole application tree in one chunk.
Six surfaces SHALL be split out and loaded on demand: the **session workspace**
(`WorkspaceStatic`, mounted by `SessionRoute`), the **teams route**, and four **modals** — New
Session, Batch Import, YouTube Import Error, and Home Settings. Surfaces that render on the very
first homepage paint — the rail, the home route, the login page, the root gate, and
`SessionRoute` itself — SHALL stay statically imported, because splitting them would only buy a
waterfall.

Each split point SHALL use **`React.lazy`**, not `next/dynamic`. This is load-bearing rather
than stylistic: under the App Router, `next/dynamic` resolves to an implementation with no
`.preload()`, no `.retry()`, and `error` hardcoded to `null`, while the vitest tier resolves the
react-loadable implementation that has all three. A warming or retry layer built on those APIs
would therefore pass its tests and be `undefined` in production. Plain `React.lazy` behaves
identically in both tiers, and warming is a bare `import()` of the same module-scope loader,
which webpack de-dupes against the `lazy()`'s own request.

Every boundary SHALL be wrapped in a **chunk-load error boundary**, because the island has no
error boundary above it (the `pageExtensions` pin means there is no `error.page.tsx`), so a
rejected chunk import would otherwise throw straight out of the island root and unmount the
entire app to a permanently blank page. The trigger is routine, not exotic: a redeploy rewrites
content-hashed chunk URLs, so any tab left open across a deploy fails its next lazy import.

The boundary's retry SHALL **rebuild the `lazy()` instance**. `React.lazy` memoizes the promise
it is handed, rejection included, so a module-scope `lazy()` that has failed re-throws forever —
resetting boundary state, remounting, or clicking Retry any number of times cannot make it call
`import()` again. Call sites SHALL therefore pass a referentially stable **loader**, and the
wrapper SHALL own the instance together with an attempt counter in one state object (so they
cannot drift), with the attempt used as the boundary's `key` so a retry both remounts the
boundary and issues a genuinely new fetch. A failure SHALL stay **local** to its own boundary: a
dead modal chunk shows a dismissible card over an intact route rather than taking the route
down. A non-chunk render error SHALL render a visible error surface with Reload only (no Retry,
which could not work) and SHALL be logged with its component stack rather than swallowed.

Fallback discipline SHALL follow the surface's role:

- **Overlay** boundaries use `null`. An inline fallback would paint as stray content in the
  document flow rather than as an overlay, and the overlays are already gated behind open flags
  over an unchanged page, so arriving a frame late costs no layout shift.
- **Route** boundaries use a real surface **identical to their pending state** — `SessionRoute`
  renders the same `RouteLoadingState` frame for the chunk fetch that it renders while resolving
  the session, so the wait is one continuous frame rather than two differently sized ones; the
  teams boundary renders that same frame with its own label and id.

Measured outcome: the homepage **island chunk set** falls from **581,762 B to 218,401 B**. The
**measurement instrument SHALL be recorded with the measurement**: Next's First Load JS table is
blind to this change, because every boundary lives inside the already-dynamic island chunk, so the
island's own chunk set — read from `react-loadable-manifest` — is the only valid instrument, and
the figures above are that instrument's. A number quoted from the First Load JS table is not
evidence about this requirement.

Stated as **total homepage-critical JS** — the page/layout shell plus the island set — the same
pair reads 936,699 B → 573,544 B. That is a different quantity, and it moves only because the
island half moves: the shell half is what remains after subtracting the island set from each
total, 354,937 B before and 355,143 B after — a 206 B difference, i.e. flat, with the entire
363 KB reduction coming from the island. The two pairs SHALL NOT be relabelled into each other,
and the island-set instrument clause above governs the island-set pair specifically.

Honest limits of what shipped, recorded here rather than implied away: only two of the six
boundaries are warmed (settings after a 2.5 s idle delay, the workspace on session-route entry);
there is **no busy affordance** on an invoking control during a cold chunk fetch, so activating
New Session or Batch Import on a cold chunk produces nothing on screen for the duration; there
is **no cancellation across the async gap**, so a pending overlay can land after the user has
navigated away; and the chunk-set measurement is **not scripted or regression-guarded**.

#### Scenario: A cold homepage load does not fetch the split chunks

- **WHEN** the homepage is loaded cold with no session open
- **THEN** the workspace, teams, and modal chunks are not among the scripts fetched for first
  paint

#### Scenario: A failed chunk fetch is scoped, not fatal

- **WHEN** a lazy import rejects because its content-hashed URL no longer exists
- **THEN** the owning boundary renders a retry/reload surface and the rest of the application
  stays mounted and interactive — the island does not blank

#### Scenario: Retry after a failed import can succeed

- **WHEN** the user activates Retry on a chunk-load failure and the module is now reachable
- **THEN** a fresh `lazy()` instance is built, a new network request is issued, and the surface
  renders — rather than re-throwing the cached rejection

#### Scenario: A modal chunk failure leaves the route intact

- **WHEN** a modal's chunk fails to load
- **THEN** a dismissible failure card appears over the route, the route beneath remains rendered
  and interactive, and dismissing it closes the modal's open flag

### Requirement: Self-hosted font faces are deduplicated and scoped to what renders

The self-hosted font stack SHALL declare no redundant and no unused faces.

**No two `@font-face` declarations SHALL reference byte-identical font files.** Three Inter faces
(weights 400, 500, and 600) were byte-identical copies of the same variable font carrying the
full weight axis, so the browser downloaded the same ~48 KB file three times to render one
typeface. They SHALL be a single `@font-face` whose `font-weight` is the **range** `400 600`,
letting the variable axis serve every weight the app asks for.

**A declared `@font-face` SHALL correspond to a family something in `web/src` actually renders.**
The Chivo Mono and Oswald declarations, and their files, had zero references anywhere and SHALL
be deleted. This deletion's win is honestly bounded: an unreferenced `@font-face` never
downloads, so what it removes is source and build size, **not** transfer.

The two faces on the critical path — the deduplicated Inter latin subset and the League Gothic
latin subset used by the boot loading skeleton — SHALL be served from stable `/static/fonts/`
paths so the root layout can preload them (see `Server-rendered shell`). The remaining subsets
of those families (League Gothic latin-ext and vietnamese) and the other self-hosted families
stay bundler-emitted asset imports.

Measured outcome: −94 KB of font transfer per session-page load.

#### Scenario: One Inter file per page

- **WHEN** a session page is loaded and rendered
- **THEN** exactly one Inter `.woff2` is requested, and it serves every Inter weight the page
  renders

#### Scenario: The preloaded faces are fetched once each

- **WHEN** a page in the index route group is loaded
- **THEN** the preloaded Inter and League Gothic files are each requested exactly once — the
  preload and the CSS `src:` resolve to the same URL and share one request

#### Scenario: No declared family is unreferenced

- **WHEN** the stylesheet's `@font-face` families are enumerated and compared against the
  families referenced by `web/src`
- **THEN** every declared family is referenced by something that renders

### Requirement: The Companion presence heartbeat outlives tab backgrounding

While a page holds a session, the client SHALL keep its Companion presence entry fresh for as
long as the page is alive, **regardless of tab visibility**. The server prunes a presence entry
after a fixed freshness window (`PRESENCE_FRESH_MS`, 15 s) and Companion's active-session
resolution requires a fresh entry, so a client that stops reporting is dropped as a Companion
target while its tab, its WebSocket, and possibly an in-progress recording are all still alive.

The reporting interval SHALL stay strictly under that window in every visibility state. It is
currently 5 s while visible and 10 s while hidden — the hidden cadence is a traffic reduction,
**not** a pause, and SHALL NOT be widened to or past the freshness window. A visibility change
SHALL additionally report immediately, so a hide or show is observable to Companion at once
rather than at the next tick, and a change to whether audio is playing SHALL likewise report
once without restarting the interval.

The interval SHALL NOT depend on a main-thread timer. Chrome applies intensive throttling to
main-thread timers in a tab hidden longer than five minutes, coalescing them to roughly one
wakeup per minute — four times the freshness window — and an open WebSocket does not exempt the
page. The clock therefore runs off the main thread (a dedicated worker created from a Blob URL,
which intensive throttling does not apply to). Where a dedicated worker cannot be created — no
`Worker`, no Blob URL, or a Content-Security-Policy that denies `blob:` workers — the
implementation SHALL fall back to a main-thread timer and SHALL treat the sub-window guarantee as
not holding on that path, documented at the call site rather than silently assumed. A worker that
fails **asynchronously** (the CSP case: the constructor returns and the failure arrives as an
error event) SHALL be detected and SHALL re-arm the fallback, because a worker that never ticks
is strictly worse than the main-thread timer it replaced.

This is a property a future reader is likely to "optimize" away: pausing the heartbeat while
hidden looks like an obvious saving and silently costs the operator Companion control of a
backgrounded tab. A fake-timer test cannot observe browser throttling, so tests SHALL NOT be read
as evidence that a main-thread cadence is sufficient.

#### Scenario: A backgrounded tab stays a valid Companion target
- **WHEN** a page holding a session is hidden for longer than the server's presence freshness
  window, including beyond the five-minute intensive-throttling threshold
- **THEN** presence reports continue at a cadence under that window, and Companion commands
  addressed to that session continue to resolve rather than failing with no-active-session

#### Scenario: Visibility and playback changes report immediately
- **WHEN** the tab is hidden or shown, or the playing state changes
- **THEN** a presence report is sent at once carrying the new state, and the periodic interval
  is not restarted by it

#### Scenario: A worker-less environment degrades to a documented weaker guarantee
- **WHEN** a dedicated worker cannot be created, or an already-created worker fails
  asynchronously
- **THEN** reporting continues on a main-thread timer, and the sub-window guarantee is recorded
  as not holding on that path rather than being claimed


## MODIFIED Requirements

### Requirement: Server-rendered shell
The documents served for the router-known paths **and for the admin route
(`/admin/users`)** SHALL contain server-rendered layout chrome (document structure,
theme/body attributes, stylesheet and font references, and a static loading skeleton)
rather than an empty mount node, and the not-found page SHALL be statically rendered.
The skeleton SHALL contain no user- or session-derived data.

The document for the **router-known paths** SHALL additionally emit `<link rel="preload"
as="font" type="font/woff2" crossorigin>` for the two font faces on the critical path — the
deduplicated Inter latin subset and the League Gothic latin subset the loading skeleton itself
renders in. (This applies to the index route group's layout; the admin route's document is
unchanged and emits no font preloads.) Because that layout has no `<head>` element and Next's
`metadata` export has no preload API, the links are rendered in the body and hoisted to the
document head by React 19 — the supported route.

Two properties of those preloads are load-bearing:

- **The preload `href` and the CSS `src:` MUST resolve to the same URL.** A preload names an
  exact request; if the stylesheet then asks for a different URL, the preloaded bytes are dead
  weight and the font is fetched twice. This is why those two faces are served from stable,
  deliberately **non-content-hashed** `/static/fonts/` paths in `web/public/` rather than being
  bundler-emitted with a content hash. The accepted trade-off is that these two files lose
  immutable content-hash caching; they change approximately never.
- **`crossorigin` is mandatory**, even same-origin. Fonts are always fetched in CORS mode, so a
  preload without it is a cache-key mismatch and the file downloads twice — the opposite of the
  intended effect.

#### Scenario: First paint is not an empty root
- **WHEN** `GET /` is fetched without executing JavaScript
- **THEN** the response HTML contains the layout chrome and loading skeleton markup, not
  an empty root element

#### Scenario: Critical fonts are preloaded with matching URLs
- **WHEN** `GET /` is fetched without executing JavaScript
- **THEN** the document contains two `<link rel="preload" as="font" type="font/woff2"
  crossorigin>` elements whose `href`s are the same stable `/static/fonts/` URLs the
  stylesheet's `@font-face` `src:` declarations request
