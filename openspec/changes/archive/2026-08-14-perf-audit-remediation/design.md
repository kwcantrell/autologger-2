# Design: perf-audit-remediation

> Retroactive. Every decision below was made and shipped before this document existed; it records
> the reasoning that was actually applied, including where that reasoning was later found wrong
> and corrected mid-flight. Where a decision was made by a subagent during implementation and I
> only ratified it, that is stated.

## Current state, measured on `main` @ `64593f7`

The audit that motivated the work ran against the production build (`npm run build && npm run
start`), not the dev server, using resource-timing and PerformanceObserver in a real browser.
Baseline and post-merge numbers are in `proposal.md`. Two measurement notes that shaped what was
believed:

- **Loopback distorts the payload findings favourably.** TTFB ~5 ms and a 4.15 MB fetch in 119 ms
  are localhost artifacts. The payload sizes are the real finding; the timings are not.
- **`agent-browser`'s React render counts over-count badly in this app** (recorded in the
  archived `settings-modal-mount-cost` change, which withdrew a claim built on them). All
  render-containment claims here are therefore backed by long-task and frame timing, never by
  render counts.

## Decisions

### D1 — OpenSpec was bypassed for the implementation, and this record is the remedy
The owner directed that the session ignore `openspec/` entirely, on the grounds that some process
rules had become too rigid and were causing friction. The work was implemented, reviewed seven
times, and merged on that basis. **Alternative considered:** stopping mid-session to propose and
gate. **Rejected** — it was the owner's explicit call, restated when the reviewers flagged the
missing delta. **Consequence accepted:** the contract changes shipped unauthorized, and
`api-contract-freeze`'s own scenario at `:35-39` has been failing since the merge. This change
cures that, but it cannot retroactively supply a panel or a gate, and it does not pretend to.

### D2 — Compression is scoped to `/api/*`, with an inner middleware that makes the threshold real
`hono/compress` skips small bodies only when a `Content-Length` header is already present, and
`c.json()` sets none — so the 1024-byte threshold was inert and an 11-byte `{"ok":true}` ack
gzipped to 32 bytes. Fixed by registering a second, *inner* middleware that buffers compressible
non-streaming bodies and stamps an accurate `Content-Length` before `compress()` inspects the
response; registration order is the mechanism.
**Alternatives:** (a) reimplement gzip with a real size check — rejected, duplicates a maintained
middleware; (b) leave the threshold inert — rejected, the hot paths are a 1.2 s status poll and a
5 s presence ack. **Scoping to `/api/*`** keeps the Next bridge (which compresses its own output)
and `/auth/*` out of the middleware entirely.

### D3 — The audio mime clamp is defined by the hazard, not by an allowlist
First implementation used an allowlist of audio families. It went stale immediately: batch imports
of `.mp4`/`.webm` store `video/mp4`/`video/webm`, which the allowlist rewrote to `audio/webm`,
breaking Safari playback for files that worked before — and neither type was ever compressible, so
the clamp bought nothing there. Inverted to: degrade only types the `/api/*` compression filter
would match, via a predicate shared with `app.ts` so the two cannot disagree.
**Why this is safe:** every markup-executing type (`text/html`, `image/svg+xml`,
`application/xhtml+xml`) is inside the compressible set, so all of them are still clamped; the rule
is strictly more restrictive than pre-branch `main`, which stored everything verbatim.
**Invariant a future reader might undo:** do not "simplify" this back to an `audio/` prefix test —
hono's compressible regex has a structured-suffix branch that matches any type ending `+json`,
`+xml`, etc., so `audio/x+json` is compressible and a prefix test would miss it.

### D4 — Profile slimming keeps a brief shape everywhere rather than full config for the active studio
**Alternative rejected:** assembling full config only for the active studio. Two consumers break —
the settings modal re-initialises drafts for a *non-active* studio on team switch, and the
event-generate modal looks up the session's show across all allowed studios. A heterogeneous
`shows[]` would have silently produced empty drafts. `title_suffix` is kept in the brief shape
because `NewSessionModal` branches on it at selection time; omitting it would have forced a fetch
just to render a form.

### D5 — The transcript-words deferral is a sticky context gate, not prop threading or conditional mounting
**Alternatives:** (a) thread an `active` prop to the four consumers — cannot express the dashboards
case, since the workspace does not know the widget list; (b) unmount inactive tabs — forbidden, an
in-flight AI turn must not be aborted (`web-session-console`, `ai-v2-dashboards`); (c) read the
context inside `useTranscriptWords` — violates layering, `api/hooks` must not import from
`pages/index`. Chosen: a context publishing a sticky latch plus a non-sticky
`dashboardsTabActive`, with an `enabled` option on the hook. Default `true` outside a workspace so
colocated component tests keep fetching unchanged.
**Subtlety worth preserving:** a disabled pending react-query query reports `isLoading === false`.
A consumer that hides content while loading must gate on `isPending` *and* its own enabled flag,
or it renders "no data" for data nobody fetched. An implementing subagent mutation-tested the
prediction that this causes a visible flash and found it does *not* reproduce on react-query v5
(the optimistic result already reports `isFetching` on the enabling render) — but kept the
stronger signal anyway, because the two genuinely diverge for an offline-*paused* query. That is
the reasoning to preserve, not the flash claim.

### D6 — Route splitting uses `React.lazy`, not `next/dynamic`
App Router aliases `next/dynamic` to an implementation with no `.preload()`, no `.retry()`, and
`error` hardcoded `null`, while the vitest tier resolves the react-loadable implementation that has
all three. A `.preload()`-based warming layer would therefore pass tests and be `undefined` in
production. Plain `React.lazy` behaves identically in both tiers; warming is a bare `import()` of
the same module-scope loader, which webpack dedupes.

### D7 — Chunk retry rebuilds the `lazy()` instance
`React.lazy` memoizes the promise it is handed, rejection included, so a module-scope `lazy()` that
has failed re-throws forever — resetting boundary state or remounting cannot make it re-import.
Call sites therefore pass a *loader*, and the wrapper owns `useState(() => ({attempt, Loaded:
lazy(load)}))`; retry bumps the attempt and builds a fresh `lazy`, with the attempt as the
boundary's `key`. Counter and instance live in one state object so they cannot drift.

### D8 — A draft clear names the fields it covers
The shared draft store's clear originally took only a reference object, whose keys did double duty:
naming *which* fields the clear spoke for and *what* to compare them against. A partial save can
only supply the second, so the first went silently wrong — a one-field PATCH wiped a sibling
field's unsaved text. The signature now requires an explicit covered-field set, which makes the
class of mistake structurally impossible rather than merely fixed at one call site.

### D9 — The presence heartbeat runs on a Web Worker clock
Pausing the heartbeat entirely while hidden expired the server's 15 s presence TTL, so Companion
lost its session on a merely backgrounded tab. Reducing to 10 s was not sufficient either: Chrome's
intensive throttling coalesces main-thread timers to ~1/minute after 5 minutes hidden, and a
fake-timer test cannot observe that. The clock therefore runs in a Blob-URL dedicated worker, which
is not subject to intensive throttling, with a `setInterval` fallback when `Worker` or Blob URLs are
unavailable and an `onerror` path that re-arms the fallback if the worker dies asynchronously (a CSP
denying `blob:` fails that way — the constructor returns normally). **Honest limit:** on the
fallback path the sub-15 s guarantee does not hold, and this is documented at the hook.

### D10 — Events are always re-anchored on WS open; status and segments keep the cheap gate
The freshness gate that suppressed the mount/on-open double fetch cannot be made sound for the
events feed: no query in cache at `onopen` can prove it *started* after the socket opened, and an
event inserted during the handshake is both unreceivable as a frame and invisible to the gate. The
predicate therefore degenerates to "always invalidate" for events, and is written that way rather
than as a comparison that reads like a gate but never fires. Status and segments keep the gate —
their misses self-heal through frames. With compression the extra events refetch costs ~6 KB.
**Related finding worth keeping:** react-query's `cancelRefetch` does *not* restart a data-less
in-flight fetch (it joins the existing retryer promise), so closing the window required an explicit
`cancelQueries` before the invalidation. Verified against `query-core` source, not assumed.

### D11 — The two sticky words latches were left separate
An implementing subagent declined to unify `SessionWorkspace`'s render-time `prevSessionIdRef` latch
with `useAiV2WidgetData`'s ref: folding the latter into the provider needs state plus an effect (a
child cannot set parent state during render), which would delay the fetch by a commit and perturb
the existing tests. Accepted, and recorded as a residual — the duplication with divergent reset
mechanisms is real, and a reviewer flagged it twice.

## Deliberate invariants a future reader might "helpfully" undo

- **The six feed panels stay mounted and hidden.** Not an oversight — unmounting aborts an
  in-flight AI turn. The performance work went *around* this constraint (memoization + fetch
  gating), never through it.
- **The memo fences are load-bearing and comment-enforced.** Every prop crossing one must stay
  referentially stable. Adding an inline arrow or object literal to any fenced consumer silently
  reopens the 60 fps cascade, and no test will fail.
- **Two Inter faces are in `web/public/`, not bundler-emitted.** That is what gives them stable,
  non-content-hashed URLs so the `<link rel=preload>` and the CSS `src:` hit one request. Moving
  them back under `web/src/assets/` would silently double-fetch.
- **`unregister(handle, handler)` releases only if you still own it.** With a lazy boundary now
  above a handle-owner tree, this identity scoping is the mitigation that keeps a remount
  interleave harmless. Do not simplify it to an unconditional delete.
- **The audio mime clamp is co-extensive with the compression filter by construction**, via a
  shared predicate. Keep them sharing it.

## Panel & review log

**No pre-panel fact-check pass ran.** Per `CLAUDE.md`, that pass is scoped to process changes; this
is a code change, so it is correctly skipped. Recording the skip explicitly so its absence is
distinguishable from an omission.

**No adversarial panel and no spec-review gate ran** — the change did not exist until after the
merge (D1). What stood in for them was a seven-round `/code-review` loop over the accumulating
branch, each round followed by its own fix wave dispatched to implementer subagents. Every wave —
the five implementation waves and the seven fix waves alike — was gated on `npm test` +
`npm run typecheck`; `npm run e2e` joined the gate from the third implementation wave onward.
Findings by round: **10 → 10 → 10 → 3 → 3 → 2 → 2**, converging on cosmetics. Rounds 4–7 verified
the prior round's fixes as well as hunting new ground.

### Blockers/majors fixed in place
Across the seven rounds, 30 confirmed findings were fixed and re-verified. The consequential ones:

- Companion lost its active session ~15 s after a tab was backgrounded (the first
  presence "fix" pausing the heartbeat) — D9.
- A failed chunk fetch blanked the entire app permanently, with no error boundary anywhere in
  `web/src` — D7.
- Virtualization silently destroyed unsaved inline edits on unmount; then, after the first fix, a
  one-field save discarded sibling drafts — D8.
- An account-only settings save reset the user's active show, because the profile route treats an
  absent `active_show_id` as "reset to the studio's first show".
- A failed shows fetch bricked the entire settings form, including account-only saves that worked
  before the change.
- Compressing tiny JSON bodies produced *larger* payloads on the hottest polls — D2.
- No `Vary: Accept-Encoding`, so a shared cache could serve gzip bytes to a non-gzip client.
- The audio mime allowlist regression — D3.
- A bare focus+blur on a transcript speaker cell PATCHed the display string over the raw
  diarization id, then (after the first fix) rewrote deliberate `"Person N"` labels on an idle
  tab-through.

**Roughly half of all findings were self-inflicted** — introduced by an earlier fix in the same
loop rather than pre-existing. That is the loop's main justification: it caught its own regressions.

### Findings escalated to the gate
None, because there was no gate. Three items that would have been gate decisions were instead taken
by the owner in-session: the OpenSpec bypass (D1), the decision to include frozen-contract shape
changes at all, and the deferral of three simplification findings (shared feed virtualizer,
unified words latch, playback-tick external store — the last measured unnecessary).

### Minors accepted as residual
- The five open items enumerated in `proposal.md` — no busy affordance during a cold chunk fetch,
  no cancellation across the async gap, `WorkspaceStatic` still uncharacterized, the bundle
  measurement unreproducible, and the missing `sync-from-disk` fixture capture.
- The duplicated sticky latch (D11).
- `['show-categories']` is still invalidated unconditionally on settings save, where the two show
  roots are now scoped to saves that actually carried `show_updates`.
- A row whose stored speaker is literally `"Person N"` cannot be converted to the diarization id
  that renders identically — the input is indistinguishable from "leave this custom label alone".
  Documented at the function rather than fixed.

### Verification log
- **2026-08-14 — retroactive drift audit.** Two independent read-only passes over
  `openspec/specs/**`, `README.md`, and `CLAUDE.md` enumerated every claim the merge falsified;
  their findings are the input to the delta specs in this change. A third pass verified the
  shipped tree against the `web-boot-split-boundaries` panel's eight required mitigations,
  finding three closed, two partially closed, and three open or unverifiable — the source of the
  "what shipped did NOT close" section.
- **2026-08-14 — pre-gate consistency read across all fourteen artifacts.** The eleven delta
  specs were written in parallel by three authors from a shared brief, so a coherence pass ran
  before the artifacts went to the owner. **Not clean — 15 findings, all fixed.** The three that
  mattered:
  1. The new `web-ui-system` playback-tick requirement **re-made the very render-count claim the
     same capability's baseline had withdrawn as a profiling-tool artifact**, and was
     independently false as written: `audioPlaybackSec` is `useState` in `SessionWorkspace`, so
     that component and every unmemoized child re-render each frame by design. Rewritten around
     what is true and testable — prop stability plus memo bail-out at named boundaries, evidenced
     by frame timing — and retitled "The playback tick is fenced at named memo boundaries".
  2. The bundle figure `~937 KB → 574 KB` was **mislabelled as the island chunk set** while the
     same requirement made `react-loadable-manifest` the normative instrument. It is the total
     (shell + island); the island set is 581,762 B → 218,401 B. Both are now stated and labelled.
  3. The **worker-clock presence heartbeat was covered by no delta at all** — real, shipped,
     user-observable behavior with a documented degradation mode and no owning capability
     anywhere in the baseline. Added to `web-frontend-platform`.
  Also fixed: a duplicated memoization rule with no single owner, `ChunkLoadBoundary` retry
  semantics specified normatively in two capabilities, a cross-reference claiming this change
  authorized `GET /api/sessions/:id` (it did not), new text presented as pre-existing in
  `web-home-launch`, focus-pin machinery attributed to both feeds when it ships in one, an
  arithmetically false "within 1%" supersede claim (the "after" figure is 4.1% off), two
  incompatible "wave" vocabularies, and two shipped behaviors no delta covered (the event-feed
  loading row; the settings shows error/offline-paused states).
  The pass also corrected three claims I had asserted in the fix brief itself — `FeedShell` sits
  behind the memo fence rather than re-rendering per frame, the shell half of the JS total
  differs by 206 B between the two builds rather than being identical, and the loading-row commit
  did not replace a visible "no events" flash (the empty message was already suppressed while
  pending).
- **2026-08-14 — post-archive consistency read over the merged baseline.** Ran after the gate
  and after the eleven deltas were hand-merged into `openspec/specs/`, reading each touched
  capability end to end plus a sweep of the other fourteen. **Not clean — 11 findings, all
  fixed.** The merge's characteristic failure was authors rewriting a requirement without
  reading their own file:
  1. `web-ui-system`'s settings requirement said drafts "hydrate from the profile" — contradicted
     by the ADDED requirement 190 lines below it in the same file, by three sibling baselines,
     and by the code (drafts come from a per-studio shows query; the profile feeds the account
     scope). Rewritten as the shipped two-scope init.
  2. `web-coordination-seam` asserted there is "no second `lazy()` anywhere under `web/src`" —
     falsified 112 lines later in its own file. The load-bearing truth is narrower: no suspension
     point *nests below* a handle-owner tree. Corrected, and the reachability argument now rests
     on a true premise.
  3. `web-session-console` claimed "inline edit is live exactly while timecode is rolling",
     which collided with the whole jump-column family. The code says the Event Feed gate is
     rolling **or** a live recording lease, and the Transcript feed has no transport gate at all
     — so the claim was wrong twice over. Scoped per feed.
  Also fixed: the render-isolation boundary being asserted by one requirement and disclaimed as
  untested by another; two "above" cross-references pointing hundreds of lines below; a Purpose
  claiming five workspace tabs where its own requirement says six; two `TBD - created by
  archiving change` placeholder Purposes on files that had just gained substantial requirements;
  duplicated ownership of the split-point enumeration and of the `/static/fonts/` path decision;
  transfer figures that did not reconcile because uncompressed and gzip units were mixed
  unlabelled; a stale neighbour still listing the deleted **Next Ep** control; and two dangling
  "this change" references the merge introduced.
  **Two shipped behaviors had no owning requirement anywhere** and gained one:
  transcript speaker display↔raw conversion, and the cache re-anchoring performed when the
  session socket opens.
  The pass also corrected four points in the fix brief itself — there is one `lazy()`
  construction site instantiated at six call sites (five shell siblings plus the workspace one
  level down, with `/teams` and the workspace mutually exclusive); two island-level
  `next/dynamic` suspension points sit *above* the shell and are irrelevant to the argument; the
  render-boundary scenarios are pinned for 5 of the 6 named shell state changes because no test
  drives the YouTube-import-error modal; and the `SessionRoute`→`WorkspaceStatic` forwarding is
  unpinned in addition to the memo comparator. All four are now disclosed in the specs rather
  than assumed away.
