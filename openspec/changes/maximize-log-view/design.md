# maximize-log-view — design

## Context

`SessionWorkspace` renders a two-panel deck (`v5-session-timeline-panel` +
`v5-session-controls-panel`) above the `Feed tabs` tablist. While rolling/recording,
`liveDock` swaps timeline chrome for the live category strip. AppShell already owns a
client-mic **Recording audio** strip (separate from Session Controls lease status).

## Decisions

### D1 — Sole fused-strip layout
**Choice (owner amendment 2026-08-02):** The fused strip is the **only** session deck
layout. Twin glass panels, layout preference, and Maximize log / Default view toggle are
retired. Rolling/recording no longer switch layouts.
**Alternatives:** Preference + force-default — superseded by owner “this should be the
only view.”

### D2 — Live category buttons in the scrub lane
**Choice:** While rolling or recording, replace the timeline scrubber with
`CategoryButtonStrip` in a horizontal scroll row at the **same height** as the scrub lane
(`≈80% of `--v5-timeline-lane-h``). Meta row + transport aside stay.
**Alternatives:** Force twin-panel live dock — superseded.

### D3 — Status + recording meters in the strip
**Choice:** Session status (Stopped / Rolling / Recording) sits above the compact
timecode. While the local mic is live (`body.v4-is-recording`), reveal mic level +
recording duration beside status (same `#top-bar-mic-*` / `#top-bar-recording-dur` IDs
AudioRecorder writes). AppShell “Recording audio” pill retired.
**Alternatives:** Global AppShell strip — superseded by owner amendment.

### D4 — Fused strip composition and height
**Choice:** No glass container. Timeline column: session meta (show · name · date left;
marker nav right-aligned to the **timeline column**, not the full strip) + scrubber or
live buttons. Trailing aside: status (+ meters when recording) → timecode → transport +
`?`. Scrub/button lane ≈ **80% of `#timeline-clips` / `--v5-timeline-lane-h`.

### D5 — Storage key
**Choice:** One browser-local key (e.g. `autologger.sessionLayoutPreference`) holding
`default` | `maximize-log`; invalid/missing → `default`.
**Alternatives:** Per-session keys — rejected (cross-session preference).

### D6 — Sequencing with export-as-feed-tab
**Choice:** Toggle is orthogonal to tab inventory; sits after the tablist buttons whether
five or six tabs. If `export-as-feed-tab` is in flight on the same branch, no conflict
beyond shared `SessionWorkspace` tablist markup.
**Alternatives:** Block on Export tab archive — unnecessary.

## Implementation sketch

1. Tiny preference hook/module: read/write localStorage; React state synced on toggle.
2. `SessionWorkspace`: `displayedMaximize = preference === 'maximize-log' && !rolling && !recording`.
3. Conditional deck: default → today’s panels; maximize → fused strip component (extract
   Timeline body / reuse TransportControls + TimecodeDisplay).
4. Tablist row: append labeled toggle + disabled reason when forced.
5. Tests: preference round-trip; force on roll/rec without clearing preference; restore on
   idle session navigation.

## Invariants (do not undo)

- Force-default must not clear preference.
- Live category dock / stopped-state strip visibility rules in **default** mode stay as
  specified today.
- No HTTP/WS contract changes.
- Toggle is not a feed tab (does not join `FEED_TABS` / tabpanels).

## Panel & review log

### 2026-08-02 — Pre-panel fact-check (light-tier)

| Claim | Property verified | Method / evidence | Verdict |
|---|---|---|---|
| Deck is two glass panels above feed tabs | Timeline + Controls sections in SessionWorkspace | Read SessionWorkspace `v5-session-panels` | CONFIRMED |
| `liveDock` when rolling or recording | `liveDock = rolling \|\| audio-recording` | Read SessionWorkspace transport derivation | CONFIRMED |
| AppShell has client recording strip | “Recording audio” strip + duration | Read AppShell + web-session-console recording requirement | CONFIRMED |
| No existing maximize-log preference | No session layout preference key in web src | Grep localStorage usage for layout/focus | CONFIRMED (none) |
| Feed tablist is the Feed tabs role=tablist | `aria-label="Feed tabs"` | Read SessionWorkspace | CONFIRMED |

Judgment left unverified: exact fused-strip pixel height token; whether shortcuts button
moves into the strip vs relies on `?` only.

### 2026-08-02 — Gate

Owner rulings (chat):

1. **Strip height:** ≈ **80% of `#timeline-clips` height** (not ~30% of full deck).
2. **Shortcuts:** initially “global `?` only”; **amended** — fused strip also hosts the
   keyboard-shortcuts (`?`) button (owner: “add that button”).
3. **Toggle under force-default:** OK as proposed (Default view actionable; Maximize log
   blocked under roll/rec).
4. **Play state:** OK — maximize-log allowed while playing; only rolling or recording
   force default.

**Blockers/majors fixed in place:** height criterion updated across proposal/spec/tasks;
shortcuts button required on fused strip after amendment.

**Minors accepted as residual:** exact CSS calc vs measured clips row left to implementer
within the 80% rule.

### 2026-08-02 — Post-gate consistency read

Clean — `proposal.md`, `design.md`, `specs/web-session-console/spec.md`, and `tasks.md`
agree on preference vs force-default, toggle labels/disable rules, play allowed,
fused-strip height = 80% of `#timeline-clips`, and shortcuts `?` button on the strip.

### 2026-08-02 — Post-amendment consistency read

Clean after shortcuts-button amendment — strip contents scenarios and task 2.1 mention the
`?` control; no stale “global `?` only” normative language remains.
