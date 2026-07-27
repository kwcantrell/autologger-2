# feed-row-seek — Design

## Context

`Timeline` is mounted as an always-present sibling above the workspace tab strip; three tabs are
feeds whose rows each carry a session time. The jump already exists in `MarkerNav.handleJump`, as
three calls against globals the workspace publishes:

```
window.AutoLogger_setManualScrubSec(sec)     // Timeline    — override the playhead position
window.AutoLogger_scrollTimelineToSec(sec)   // useZoomRail — scroll that position into view
window.AutoLogger_seekAudio(sec)             // SessionWorkspace → AudioPlayer.seekToTimelineSec
```

Constraints: the HTTP/WS contract is frozen (no server file is touched); the three feeds do not
share a coordinate source, and two of those sources are lossy or stale in ways the type definitions
do not reveal; and the time column in Transcript and Topics is a fixed `w-[6.5rem]` cell already
filled edge-to-edge by an `<input>`.

### Inline-edit models (they differ)

| Feed | Editable when | Commit |
|---|---|---|
| Event Feed | `(is_rolling \|\| audio_recording_lease_alive) && !batchEditMode`, or in `batchEditMode` | `handleBlur`, **with** a dirty check, deferred |
| Transcript | always | `onBlur` → `commitField`, **no** dirty check |
| Topics | always | `onBlur` → `update.mutate`, **no** dirty check |

## Goals / Non-Goals

**Goals:** one gesture takes you from an entry to hearing that moment; inline editing is untouched;
the jump never lands the player on a different recording than the playhead shows; one
implementation shared with marker navigation without gating it; zero server change.

**Non-Goals:** see `proposal.md`. The load-bearing one: **no server-side `start_sec` recompute** —
deferred to its own change because `start_sec === 0` is a sentinel `ai-v2-dashboards` reads.

## Decisions

### D1 — A feed jump starts playback; marker navigation does not

Activating a feed jump seeks **and plays**. This is the literal review loop the feature exists for
and the original stated request ("start playing audio from that point").

*This reverses an earlier seek-only decision, and the reversal is a consequence of D2.* Seek-only
was chosen when the affordance was a whole-row click, where the governing worry was that a
mis-click anywhere in a thousand-row table would emit sound in a working room. With the affordance
now a deliberate, discrete button in its own column, that worry largely dissolves — you do not
press a labelled "jump" button by accident the way you brush a table row.

A second argument surfaced in focused review and was decisive: under seek-only *plus* D2, there was
**no one-gesture path to listening at all**. Clicking the button focuses it, and
`isKeyConsumingInteractiveTarget` makes the global Space handler yield to focused buttons — so
Space re-jumped instead of playing, by pointer and by keyboard alike. Two independently reasonable
decisions combined into a feature that could not do the thing it was for.

*Implementation note.* `AudioPlayer.seekToTimelineSec` captures `wasPlaying` and calls `play()`
only inside that branch, so starting playback requires an explicit play-capable path.
**Marker navigation must keep calling the non-playing path** — its seek-only semantics are existing
behavior and are normative in the spec.

*Interaction with D6.* Playback starts only where a recording actually covers the target. An
uncovered target moves the playhead and does nothing audible.

*Residual.* With the button focused, Space re-activates it (a repeat jump) rather than toggling
playback, and while the control is `aria-disabled` Space is inert in both directions. Consistent
with `isKeyConsumingInteractiveTarget`'s deliberate behavior for every button in the app, and much
less consequential now that the primary need — hearing the moment — is satisfied by the jump.

### D2 — A dedicated leading jump column, not a control in the time cell

Each feed gains a narrow icon column ahead of its existing columns. `FeedTable`'s `ColumnDef`
already carries `ariaLabel` — documented "use for visually hidden columns (e.g. actions)" and used
by no feed today — which supplies the hidden header.

*This replaces two earlier designs, both of which failed, for different reasons.*

**First: a whole-row click handler where one click both seeked and began an edit.** Panel review
traced five independent defects to it, all moot under a discrete control:

| Row-click defect | Why it is gone |
|---|---|
| The pointer cursor — its only affordance — cannot render over the `<input>`s filling the cells | A button carries its own affordance |
| React portals bubble through the *React* tree, so a portalled select option reached `<tr onClick>`, and `closest()` could not exclude it (DOM target is in `document.body`) | No row handler exists; the exclusion predicate is deleted |
| Clicking to navigate focused a field, so Space was typed into the transcript and committed on blur | Activation does not focus a field |
| A bare `<tr onClick>` trips `a11y/useKeyWithClickEvents` and `noStaticElementInteractions` | A button needs no suppression |
| Seek was mouse-only; no keyboard path | A button is Enter/Space-activatable |

**Second: the same button, but inside the time cell.** This was chosen at a gate on semantic
grounds and never checked against geometry. Measured in headless Chromium against the literal class
strings: the Transcript/Topics time column is `w-[6.5rem]` (104px), and an 11-character
`HH:MM:SS:FF` needs 105px — **the cell is over capacity before anything is added**. Because
`FEED_CELL_TIME` sets `whitespace-nowrap`, an un-wrapped sibling *overflows onto the next column*;
because the input is `w-full`, it contributes nothing to min-content, so the column does not grow
and the input absorbs the entire loss (down to 72–80px with a control beside it). Fitting both
would require widening every feed's time column by ~36px.

A dedicated column costs the flexible word/message column instead of the fixed timecode column, is
uniform across all three feeds, needs no wrapper inside a cell an input already fills, and makes
"inline editing is untouched" **literally** true — no editable cell's contents, width, or
containing block change. It also dissolves the Event Feed's worst case, where the
recording-but-not-rolling state renders a stacked wall+timecode input pair in a cell that already
starves the wall input to 0px.

*Positionless rows carry no control at all* (gate decision). `aria-disabled` is right for the
**transient, global** rolling state — a user who focuses a control during a roll deserves to know
why it did nothing — and wrong for the **permanent, per-row** positionless state, where it would
make an anchorless transcript a thousand-stop corridor of inert buttons each announcing the same
non-actionable sentence. Nothing actionable is hidden from AT. In the rolling state all rows in a
feed reference **one shared reason node**; the toolbar precedent this pattern comes from is a single
button with room for a visible sentence beside it, and copying it literally would emit one span per
row.

*The accessible name follows what the row displays.* The Event Feed's first column shows either a
timecode or a wall-clock UTC string depending on its display-mode dropdown; naming the control
after an unrendered session time would announce two unrelated timestamps in one row with no
on-screen referent for the second.

*Residuals.* Focusing a jump control satisfies `EventLogRow`'s `:focus-within`, revealing the row's
hover action cluster — surprising once, visible in visual diffs, not dangerous. It also satisfies
that row's "someone is editing this row" guard, so inline inputs pause resyncing from server
updates while the control holds focus. And the time cell now announces twice in Transcript/Topics
("00:00:12:07, edit text … Jump to 00:00:12, button"); in the Event Feed's plain-text cell a future
refinement could make the displayed timecode *be* the label, collapsing that to one announcement.

### D3 — Session-time strings convert by frame arithmetic

```
total_frames = (hh*3600 + mm*60 + ss) * Math.round(fps) + ff
sec          = total_frames / fps            // ACTUAL fps, not rounded
```

*Why the obvious approach is wrong.* `hh*3600 + mm*60 + ss + ff/fps` is wrong at every non-integer
rate the app offers. Strings are produced by `fromTotalFrames`, which decomposes at
`Math.round(fps)` — so HH:MM:SS encodes `total / 24` while timeline space is `total / 23.976`. The
naive reading is systematically **early by ~0.1% of elapsed time**: 3.6 s at an hour, and
immediately several seconds off with a broadcast `start_offset_frames`. That magnitude matters
because of D6 — a multi-second error lands in a different recording. An earlier draft mitigated
only the *dropped frame field* (~0.04 s) and declared the hazard handled.

**This is not a novel derivation — it is the app's own existing inverse.** `server/src/routers/events.ts`'s
event-edit path already computes `const fps = Math.round(Number(row.frame_rate)); const totalFrames =
(hh * 3600 + mm * 60 + ss) * fps;`. Mirror that expression exactly, including its rounding of the
stored 3-decimal rate, so the client and server cannot diverge.

**Deliberate invariant — do not "simplify" this to `parseSmpteToSec`.** Two functions carry that
name (`shared/utils/audioClips.ts` honors the frame field, `shared/utils/timecode.ts` discards it)
and *neither* is correct here — both treat HH:MM:SS as literal seconds.

*Parser contract* (each of these was a live wrong-answer path):

- **Frame fields are one to three digits.** `formatSmpte` pads with `padStart(2, '0')`, which does
  not truncate, so at 100/119.88/120 fps it emits `00:00:01:102`. Both existing regexes require
  exactly `\d{2}`, so ~1 row in 6 fails to parse at those rates — and Topics have no fallback.
- **Reject `ff >= Math.round(fps)`**, and minutes/seconds above 59. `session_time` is a free-text
  input; `00:00:00:99` at 24 fps otherwise resolves to 4.125 s on a row displaying zero — the same
  display-vs-jump divergence D4 exists to eliminate. Reject rather than clamp: clamping still shows
  one time and jumps to another. `events.ts` already rejects `mm > 59 || ss > 59` with a 400.
- **`MM:SS` is NOT accepted.** An earlier task proposed tolerating it for generator robustness;
  `"05:30"` is 330 s as MM:SS and 19,800 s as HH:MM with nothing to disambiguate. It is also
  unmotivated — the generator copies `[HH:MM:SS:FF]` prefixes out of the transcript, so plausible
  malformations are truncations of that shape, not two-field clock times. `H:MM:SS` is accepted.
- **Self-consistency holds under 24 hours only.** `fromTotalFrames` wraps (`% 24`). Below 24 h the
  round trip recovers the original within `0.5/fps` (verified by sweep). Above it, the server also
  stores wrapped frames, so strings, clips, and markers stay mutually consistent even though all are
  offset — D3 inherits the existing non-monotonicity rather than adding an error. **D3's correctness
  now depends on `fromTotalFrames` continuing to wrap**, so that round trip is pinned by a test.
- **Drop-frame is not modelled.** Treating `;` as `:` is correct for strings the app renders
  (`fromTotalFrames` does no drop-frame renumbering). A *hand-entered* true drop-frame label from a
  deck converts ~0.1% long. This is a new call site, not merely a multiplied one.

### D4 — Per-feed resolution, with the stored string authoritative for transcript rows

| Feed | Source |
|---|---|
| Events | `timecode_total_frames / frame_rate`; **absent frames ⇒ unresolvable** |
| Transcript | stored `session_time` via D3 when it parses; else `start_sec`; else positionless |
| Topics | stored `session_time` via D3 |

*Events must use the numeric field directly, not `eventTimelineSec`* — whose SMPTE fallback both
substitutes `0` for a missing timecode (jumping the playhead to `0:00`) and carries the D3 defect.

*Why transcript prefers the string over the number* — the reverse of the intuitive rule. The number
is authoritative only for DeepGram-generated words never edited: `insertTranscriptWord` omits
`start_sec` (column default `0.0`) and `wordRow` maps `Number(r.start_sec ?? 0)`, so a hand-inserted
row has a real typed time and `start_sec === 0`; and `updateTranscriptWord` patches only
`session_time`, `speaker`, `word`, so editing the displayed timecode never recomputes the number.

**"Stored", not "displayed"** — `TranscribeRow`/`TopicsRow` render `vals.session_time`, the
uncommitted edit buffer while a field has focus. Resolve from the last committed value.

*Honest trade.* String-first is what exposes transcript rows to the D3 parser residuals (24-hour
wrap, hand-entered drop-frame); the number would have been immune to those. It is worth it for the
insert/edit staleness it fixes, but it is a trade, not a strict dominance.

*Alternative deferred.* Recomputing `start_sec` server-side fixes this at the source for every
consumer. The gate deferred it: `start_sec === 0` is the sentinel behind `ai-v2-dashboards`' "Data
unavailability is a rendered state, never a zero", and a partial recompute would flip a hand-entered
transcript out of its honest unavailable state into a **fabricated measured duration**.

### D5 — Gate on loaded `is_rolling`, plus batch-edit mode

The gate requires status to have **resolved** and report not-rolling; unresolved is treated as
unavailable, not as "not rolling" (`undefined` is falsy and would fail open on first paint). It also
suppresses while a feed is in batch-edit mode, where the user has deliberately entered a bulk-edit
surface.

It deliberately excludes `audio_recording_lease_alive`: recording without rolling does not advance
the playhead, so the conflict the gate prevents does not arise.

*Why the gate exists* — `Timeline`'s `activeSec` priority is `audioPlaybackSec > manualScrubSec >
nowSec`, and `manualScrubSec` clears only on session switch or a timeline-track double-click. A jump
during a roll would detach the live playhead for the whole take, recoverable only by an
undiscoverable gesture.

*Known limitation.* The gate is **advisory, not a guarantee**: `useSessionStatus` sets
`refetchInterval: false` while not rolling — polling is off exactly when the gate is open — so
freshness depends on the WebSocket's `transport.changed` invalidation. Consequence is the pre-roll
latch, not bad data.

### D6 — No covering clip ⇒ playhead only

The hook checks clip coverage before issuing audio. `resolvePlayPosition` does **not** no-op on an
uncovered target: after the containing-clip loop fails it resolves **forward** to the next playable
clip, then **backward** to the last, returning `null` only when no clip is playable at all. So an
unsuppressed jump into a gap cues a *different take* — and under D1 would now **play** it.

An earlier draft asserted the opposite and built its degradation story on it; three of four panel
reviewers caught it independently.

`useAudioClips(sessionId, events)` is a hook, so feeds read clips directly — React Query dedupes.

### D7 — The feed owns the hook; rows receive a stable callback and a resolved prop

Each feed calls the hook once and passes a `useCallback`-stable handler plus each row's resolved
state. `TranscribeRow` is `memo`-wrapped and `TranscribeFeed` virtualized, so an unstable handler
defeats memoization across recycled rows, and per-row status subscriptions would multiply one query
subscription by the row count. Seekability must arrive as a **prop** so `memo` re-renders when the
gate flips.

*Row height.* `TranscribeFeed` sizes rows from a hard-coded `ROW_HEIGHT = 34` with no
`measureElement` (actual measured row: 29.44px). The jump column must not push the row past the
estimate, or virtual offsets drift. Re-measure and reconcile the constant.

### D8 — One shared jump, with the gate outside it

The shared module exports the ungated, uncoverage-checked, non-playing three-call jump; the gate,
coverage check, playback, and position resolution live in the hook above it.

**Marker navigation must not become gated, coverage-checked, or playing.** Baking any of those into
the jump would regress it. Its behavior is normative in the spec and pinned by a characterization
test written before the refactor.

*Scope note.* The shared thing is a plain module, not a hook, and the overlap it removes is three
lines. Its value is being the one typed place the three global names live, so a rename is a compile
error rather than a silent no-op.

## Risks / Trade-offs

- **Wrong-recording playback** → the top severity mode, now amplified by D1 (a wrong jump *plays*).
  Attacked on three fronts: D3 removes the multi-second position error, D3's parser contract removes
  the finite-but-wrong string paths, D6 removes the uncovered-target path.
- **Topic `session_time` is model-authored and unvalidated** (`z.string().max(20)`; the prompt says
  only "HH:MM:SS-style"). The worst case is **not** a silently unseekable feed — it is a feed
  silently seekable to a *wrong second*: for an anchorless transcript the model gets no `[HH:MM:SS]`
  prefixes to copy, invents elapsed-from-zero times, and those parse perfectly. Mitigated by marking
  topic jumps unavailable when the transcript is wholly anchorless (same predicate shape as
  `wordTimingsAreDegenerate`) and by exercising real generated output.
- **Jumping mid-edit fires a `PATCH`** — `TranscribeRow`/`TopicsRow` `commitField` has no dirty
  check, so blurring a focused field by clicking the jump control writes an unchanged value and
  invalidates the query under a virtualized list. Narrowed by D2 (the control is not in the edit
  cell) but not eliminated; a dirty check is scheduled.
- **Marker-nav regression during the refactor** → D8 plus a pre-refactor characterization test.
- **Pre-roll `manualScrubSec` latch** → pre-existing, not fixed; see `proposal.md` → Impact.
- **`Timeline`'s live `nowSec` still uses the naive parse**, so the rolling playhead disagrees with
  markers/clips at non-integer rates — pre-existing, unreachable through a gated feed jump.

## Migration Plan

No migration. No data model change, no server change, no persisted state, no feature flag.
Additive in the UI and reversible by revert.

## Open Questions

**None outstanding.** All gate decisions of 2026-07-26 are recorded below.

## Panel & review log

### 2026-07-26 — Pre-panel fact-check pass (light tier, mechanical)

A fetch-and-compare reviewer verified stated checkable claims against the live repo with per-claim
method and evidence; judgment-laden claims were excluded and reached the panel un-vouched.
**30 claims (+3 incidental): 28 confirmed, 1 corrected, 2 left unverified.**

*Corrected in place:* a portal sentence that could be misread as claiming the select trigger was the
only click-exclusion target. (Superseded — no exclusion predicate exists under the current D2.)

*Left unverified:* "zero server change" (forward-looking, no diff yet — hence the final-gate check);
and whether an *implicit* `web-session-console` conflict exists (judgment, sent to panel).

**Lesson recorded.** The pass confirmed "`seekToTimelineSec` returns silently when no playable clip
covers the target" — true of the line it was pointed at, **materially misleading** about the
function (see D6). The checklist asked the wrong question and the pass answered it faithfully. This
is why the pass is an aid and never a warrant.

### 2026-07-26 — Adversarial panel (4 reviewers, distinct mandates, skeptical calibration)

Requirements / Assumptions / Failure & abuse / Scope & simpler design. Verdicts: 3, 3, 4, 2 blockers.

**Convergence:** 4/4 found the pointer cursor unsatisfiable; 3/4 the `resolvePlayPosition`
fall-forward; 3/4 the transcript `start_sec` staleness; 3/4 the pre-roll scrub latch.

**Reviewer conflict resolved.** Failure & abuse cleared the portal reasoning; Assumptions refuted it
with `node_modules` evidence. **Assumptions is correct** — React propagates synthetic events through
the React tree. Moot under D2, resolved on the record.

*Fixed in place:* the non-integer-fps coordinate error (→ D3); the fall-forward premise (→ D6); the
transcript staleness (→ D4); the cursor, portal, Space-trap, PATCH-per-click and biome-a11y findings
(all dissolved by the affordance change); the gate failing open on unloaded status (→ D5); a process
rule wrongly encoded as a product requirement (`sdlc-process` forbids a fourth normative home);
capability sprawl (re-homed as a `web-session-console` delta); file paths hard-coded into the durable
baseline; an untestable "exactly one implementation" SHALL; coverage gaps for seek-only, the rolling
transition, and the Event Feed's edit paths; test-infrastructure gaps (`ResizeObserver`,
`QueryClientProvider`, virtualizer renders zero rows in jsdom); an overstated "no covering tests"
claim; and `npm run e2e` running only the `chromium` project.

*Escalated to the gate, with decisions:* row-wide click vs. a focusable control → **button**;
transcript `start_sec` → **split** (client-side here, server recompute its own change, after
verification showed it would break `ai-v2-dashboards`' sentinel); uncovered targets → **suppress**;
seek-only vs. seek-and-play → **seek-only** (later reversed, see below).

### 2026-07-26 — Post-gate consistency read (light tier)

Clean on five of six classes across all four rewritten artifacts; D3's arithmetic independently
re-derived against `timecode.ts` and `transcriptRemap.ts`. Two minor coverage gaps found and fixed
(a scenario with no covering task; a task with no covering scenario). Note it did **not** catch the
batch-edit task/spec mismatch that focused review later found.

### 2026-07-26 — Focused adversarial review of D2 + D3 (2 reviewers)

The gate-selected button design and the frame-arithmetic decision were new, un-reviewed design, so
one reviewer took each. Scoped tightly and told not to assume safety because a gate chose it.

**D3/D4 held under attack.** Verified sound: the start-offset chain is consistent end to end (events,
markers, clip boundaries, `totalSec`, transcript anchors all offset-inclusive in actual-fps space);
`frame_rate` is immutable after creation (no `SET frame_rate` anywhere); the round-trip bound is
exactly `0.5/fps` across a 200,000-position sweep per rate, met and never exceeded. Every finding
was at the **parser boundary**, not in the arithmetic.

**D2's semantics held; its geometry did not.** The reviewer measured in headless Chromium against
the literal class strings rather than reasoning about them.

#### Fixed in place

- **Three-digit frame fields** at 100/119.88/120 fps break both regexes (`padStart(2,'0')` does not
  truncate) — ~1 row in 6 unparseable, with no fallback in Topics. → D3 parser contract.
- **Frame field unbounded** against the rate — `00:00:00:99` at 24 fps resolves to 4.125 s on a row
  showing zero. → reject, per `events.ts`'s existing precedent.
- **`MM:SS` tolerance removed** — ambiguous with `HH:MM` (19,470 s error), and unmotivated given the
  generator copies full `[HH:MM:SS:FF]` prefixes.
- **`events.ts` cited** as D3's existing server-side inverse, and its exact rounding expression
  mirrored.
- **24-hour wrap** qualified in D3 and pinned by a test, since D3's correctness now depends on
  `fromTotalFrames` continuing to wrap.
- **Drop-frame residual restated** — this is a new call site, not a multiplied one.
- **Events with no `timecode_total_frames`** resolve to `0` via `eventTimelineSec`'s fallback → D4
  requires the numeric field directly; added to the positionless list.
- **"Displayed" → "stored"** `session_time`, which is otherwise the uncommitted edit buffer.
- **`viewUtc` mode** appeared in no artifact; the accessible name now follows what the row displays.
- **Batch-edit suppression** was asserted by a task but authorized by no requirement — added to the
  gate requirement. (The consistency read missed this.)
- **`ROW_HEIGHT = 34`** is hard-coded with no `measureElement` and went unmentioned → D7 + a task.
- **Visual fixtures screenshot empty feeds**, so the claim "baselines will move" was false for
  exactly the two feeds where clipping would show → fixtures must be seeded.
- **`!cursor-pointer` on the Event Feed time cell** beats any `aria-disabled:cursor-not-allowed` →
  the reconciliation task now states the required outcome.
- **D2's "moot" claim about PATCH-per-click was overstated** — narrowed, not eliminated; recorded as
  a risk with a dirty-check task.

#### Escalated to the gate (with decisions)

1. **Placement (BLOCKER).** The time cell is 104px and an 11-char `HH:MM:SS:FF` needs 105px — over
   capacity before adding anything; `whitespace-nowrap` makes a sibling overflow onto the next
   column, and the `w-full` input absorbs the loss without the column growing. **Decision:
   dedicated leading jump column**, using `ColumnDef.ariaLabel`. → D2.
2. **`aria-disabled` at scale.** Mandating a focusable inert control per positionless row makes an
   anchorless transcript a thousand-stop corridor. **Decision: omit the control entirely for
   positionless rows**; reserve `aria-disabled` for the rolling state with one shared reason node
   per feed. → D2.
3. **No one-gesture "jump and listen".** D1 (seek-only) and D2 (a button, which takes focus and
   makes Space yield) combined to make the feature unable to do what it was for. **Decision:
   reverse D1 — feed jumps start playback; marker navigation stays seek-only.** → D1.
4. **Mobile viewport scrolling.** `scrollIntoView` on a block-flow phone layout scrolls the tapped
   row off-screen, making repeated jumping unusable. **Decision: drop it entirely** on all
   viewports. → Non-Goals.

#### Minors accepted as residual

- Space re-activates the focused jump button rather than toggling playback; inert while
  `aria-disabled`. Much reduced in consequence under D1.
- One extra tab stop per row (N → N+1 on rows that already carry 3–4 inputs); the Event Feed's
  delete button is already in the tab order today. Virtualization tab-through is intact
  (`overscan: 10`).
- The time cell announces twice in Transcript/Topics; a future refinement could make the Event
  Feed's displayed timecode *be* the label.
- Focusing the control satisfies `:focus-within`, revealing the row's hover action cluster, and
  satisfies `EventLogRow`'s "someone is editing this row" resync guard.
- 1–9 logging hotkeys still fire with a jump control focused — **verified correct**, not a finding:
  the digit handler is rolling-only, exactly when jumps are gated off.
- `parseSmpte` has no fps validation for drop-frame semantics; drop-frame remains unmodelled.
- `eventTimelineSec`'s SMPTE fallback shares the D3 defect; changing that shared helper would move
  markers and clips, so it is out of scope and recorded for a successor.

### 2026-07-26 — Second post-gate consistency read (light tier)

All four artifacts were rewritten a second time after the focused round, including a reversal
(D1), so the read was re-run. **Clean on five of seven classes**, including the highest-risk one:
the D1 reversal is consistent in every document — feed jumps play, marker navigation stays
seek-only, ungated, and uncoverage-checked, with no leftover assertion otherwise. No stale
pre-decision language presented as current; all nine `design D<n>` citations resolve correctly
after the second renumbering; the four focused-round gate decisions match the Decisions section
exactly. Independently re-confirmed against source: `ColumnDef.ariaLabel` exists and is used by no
feed's column array, the `!cursor-pointer [&_*]:!cursor-pointer` lock, and `ROW_HEIGHT = 34`.

**Three findings, all fixed:**

1. Task 8.3's anchorless-transcript rule — a safety behavior, since under D1 an invented topic time
   now *plays* — was implemented by a task with no normative requirement behind it. → Added
   "Topic jumps require an anchored transcript" with two scenarios, so it is protected by the
   frozen-behavior discipline rather than living only in a task.
2. The `MM:SS`-rejected / `H:MM:SS`-accepted parser rule was tested (task 2.1) and reasoned about
   (D3) but absent from the spec. → Added a scenario.
3. `tasks.md` said "seven gate decisions" against eight recorded escalations. → Corrected, noting
   that one reversed an earlier one.
