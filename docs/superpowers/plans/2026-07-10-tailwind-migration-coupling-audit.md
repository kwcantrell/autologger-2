# Tailwind migration — coupling audit (stage-0a artifact)

**Date:** 2026-07-10
**Spec:** `docs/superpowers/specs/2026-07-09-tailwind-migration-design.md` (stage 0a item 3)
**Method:** three parallel grep/read sweeps over `web/src` (globals & cross-file usage; media/hover/important/keyframes/exotic selectors; tokens & TSX vars), cross-checked against direct file reads. Line numbers are accurate as of commit `915e90c`; **they go stale as slices land — locate quoted code by content before editing.**

This document is the source of truth for the slice map in
`2026-07-10-tailwind-migration.md`. Sections: A `:global()` rule map · B cross-file
class emissions · C moduleless TSX consumers · D dead-rule verification ·
E equal-specificity duplicates · F media queries · G hover guarded/unguarded ·
H `!important` · I keyframes/animations · J pseudo-elements & exotic selectors ·
K token rename table · L token consumer counts · M TSX `var()` consumers ·
N locally-defined custom properties.

**Headline findings the plan builds on:**
- `#v4-log-session` / `.v4-log-sheet` are the dominant coupling anchors (6+ module files hook them).
- Massive dead surface: all 12 `#modal-app-settings` rules, TimecodeDisplay's 4 `:global` overrides, ~29 dead hashed locals, `glass.module.css` dead except `.glassPanel` (alive via `composes` — invisible to TSX greps), 6 dead chrome.css classes, dead `v3-cue-grid-panel`/`cat-btn__line`/`v6-workspace-modal*` remnants.
- `useTheme()` has zero call sites — the ThemeContext glass distribution is unrealized plumbing.
- `body[data-v4-transport]` is static (`"rolling"` hardcoded in index.html; no JS setter) — transport-attribute CSS toggles are frozen; convert as-is, flagged as a post-migration parity question (do NOT silently delete).
- Only 3 of ~70 `:hover` rules are touch-guarded — the unguarded custom variant is the default conversion, `hover:` the exception.
- V6Rail pre-existing bug: hyphen-case descendant tokens outside `:global()` can't match camelCase-hashed locals — adjudicate before replicating behavior.
- 116 `!important` declarations in three classes: specificity wars, the perf-debug toggle system (~28, needs layer-above/`!` treatment), and undocumented one-offs.

---

## A. `:global()` rule map

Verified via `grep -n ':global(' <file>` per file, cross-checked against `.tsx`/`.ts` emitters. Files are grouped in the order listed; each group opens with the file's documented rationale (from its header comment) where one exists.

### `pages/index/AppShell.module.css`

> Documented rationale: hashed classes are truly AppShell-rendered; everything else stays `:global()` because it's page baseline (`html`/`body`), referenced by perfDebug (`.v4-top-bar`), rendered by V6Rail (`.v4-search-input`), the shared 4-modal shell base (`.v6-workspace-modal*`), rendered by 3 components + `loadingVideo.ts` (`.autologger-loading-video*`), or page-level utilities (`.modal-card`/`.toast`/`.muted`/`.settings-panel h2`). Comment lines: 1–24 (design-intent block); also inline notes at 66–69 (`.shell.shell-v3` documented dead), 155 (`.v4-search-input` ownership), 179–183 (Radix Dialog superseded `.v6-workspace-modal*`).

| File | Line | Selector | Target | Owner (TSX emitter or DEAD) |
|---|---|---|---|---|
| AppShell.module.css | 79 | `:global(.autologger-loading-video) {` | `.autologger-loading-video` | `shared/utils/loadingVideo.ts:8` (template-literal HTML string) + `SessionWorkspace.tsx:230`, `CategoryButtonStrip.tsx:267`, `RecentSessionsList.tsx:365` |
| AppShell.module.css | 88 | `:global(.autologger-loading-video__media) {` | `.autologger-loading-video__media` | Same set: `loadingVideo.ts:8` + `SessionWorkspace.tsx:232`, `CategoryButtonStrip.tsx:269`, `RecentSessionsList.tsx:367` |
| AppShell.module.css | 102 | `:global(.shell.shell-v3) {` | `.shell.shell-v3` | `AppShell.tsx:173` — `className="shell shell-v3"`. File's own comment (66–69) flags a related `body > .shell.shell-v3` rule as removed-dead in v1.23.8 |
| AppShell.module.css | 145 | `.v6WorkspaceTopBar:global(.v4-top-bar) {` | compound: local `v6WorkspaceTopBar` + global `.v4-top-bar` | `AppShell.tsx:235-237` — `clsx('v4-top-bar', styles.v6WorkspaceTopBar, styles.v6WorkspaceTopBarVoid, ...)` |
| AppShell.module.css | 153 | `.v6WorkspaceTopBar:global(.v4-top-bar) {` (2nd, "beat min-height") | same compound | Same |
| AppShell.module.css | 170 | `.v6WorkspaceTopBarVoid:global(.v4-top-bar) {` | compound | Same clsx call |
| AppShell.module.css | 217 | `:global(.v4-top-bar) {` | `.v4-top-bar` | `AppShell.tsx:235` |
| AppShell.module.css | 233 | `:global(.v4-search-input) {` | `.v4-search-input` | `V6Rail.tsx:145` |
| AppShell.module.css | 245 | `:global(.v4-search-input::placeholder) {` | pseudo-element on same target | `V6Rail.tsx:145` |
| AppShell.module.css | 291 | `:global(.v4-top-bar) {` (v5-ui carve-out) | `.v4-top-bar` | `AppShell.tsx:235` |
| AppShell.module.css | 301 | `:global(.v4-search-input) {` (v5-ui color override) | `.v4-search-input` | `V6Rail.tsx:145` |
| AppShell.module.css | 305 | `:global(.v4-search-input::placeholder) {` (v5-ui) | same | `V6Rail.tsx:145` |
| AppShell.module.css | 316 | `:global(.settings-panel h2) {` | `.settings-panel` + `h2` | `.settings-panel` only emitted at `pages/admin-users/AdminUsersPage.tsx:151` — **DEAD or cross-page mismatch**; no `.settings-panel` in `pages/index/` |
| AppShell.module.css | 320 | `:global(.muted) {` | `.muted` | `RecentSessionsList.tsx:359` + 4 other sites |
| AppShell.module.css | 330 | `:global(.main-v3 .new-session-panel) {` | `.main-v3` (emitted) + `.new-session-panel` (not) | `.main-v3` at `AppShell.tsx:207`; **`.new-session-panel` — DEAD** |

Comment-only mention: line 10.

---

### `shared/utils/perfDebug.module.css`

> Documented rationale (lines 1–4): body classes set by `perfDebug.ts` for performance A/B toggles; selectors target elements outside this component, so stay global.

| File | Line | Selector | Target | Owner (TSX/TS emitter or DEAD) |
|---|---|---|---|---|
| perfDebug.module.css | 11 | `:global(body.perf-dbg--no-decorative-videos .autologger-loading-video) {` | body class + `.autologger-loading-video` | body class → `perfDebug.ts:57` (`applyBodyClasses()` line 117) |
| perfDebug.module.css | 16 | `:global(body.perf-dbg--no-panel-shadows .panel),` | body class + `.panel` | body class → `perfDebug.ts:62`; `.panel` used e.g. `AdminUsersPage.tsx:151` |
| perfDebug.module.css | 17 | `:global(body.perf-dbg--no-panel-shadows .footer),` | body class + `.footer` | body class as above; `.footer` no direct `pages/index` emitter found — flagged |
| perfDebug.module.css | 18 | `:global(body.perf-dbg--no-panel-shadows .toast),` | body class + `.toast` | body class as above; **`.toast` — DEAD** (see section D item 2: Toast.tsx only emits hashed `styles.toast`, never the literal class) |
| perfDebug.module.css | 19 | `:global(body.perf-dbg--no-panel-shadows .v4-top-bar),` | body class + `.v4-top-bar` | `AppShell.tsx:235` |
| perfDebug.module.css | 20 | `:global(body.perf-dbg--no-panel-shadows .v4-log-top),` | body class + `.v4-log-top` | `SessionWorkspace.tsx:263` |
| perfDebug.module.css | 21 | `:global(body.perf-dbg--no-panel-shadows .v4-log-sheet),` | body class + `.v4-log-sheet` | `FeedShell.tsx:31` |
| perfDebug.module.css | 22 | `:global(body.perf-dbg--no-panel-shadows .v4-session-aside) {` | body class + `.v4-session-aside` | `SessionWorkspace.tsx:360-361` |

---

### `pages/index/components/RecentSessionsList.module.css`

> Documented rationale (1–13): `:global(.v6-workspace-modal)` was meant to pin the rename-modal override against shared page chrome.

No live `:global(` selector — line 11 is comment-only, and now **stale**: `Dialog.module.css:2-3` states the Radix `Dialog` replaced the hand-rolled `.v6-workspace-modal` pattern, and no `.tsx` emits it anywhere.

---

### `pages/index/components/TimecodeDisplay.module.css`

> Documented rationale (1–9): `.v4-session-aside` ancestor is rendered by SessionWorkspace.tsx, so V5 typography overrides anchor via `:global(.v4-session-aside)`.

| File | Line | Selector | Target | Owner (TSX emitter or DEAD) |
|---|---|---|---|---|
| TimecodeDisplay.module.css | 223 | `:global(.v4-session-aside) .clock-label,` | ancestor (emitted) + `.clock-label` (kebab-case literal) | `.v4-session-aside` → `SessionWorkspace.tsx:360-361`. **`.clock-label` — DEAD**: `TimecodeDisplay.tsx:30` only emits hashed `styles.clockLabel` |
| TimecodeDisplay.module.css | 224 | `:global(.v4-session-aside) .clock-session-timecode {` | same + `.clock-session-timecode` | **DEAD** — `TimecodeDisplay.tsx:45` only emits `styles.clockSessionTimecode` |
| TimecodeDisplay.module.css | 229 | `:global(.v4-session-aside) .clock-label {` (font-size) | same | **DEAD** (as above) |
| TimecodeDisplay.module.css | 235 | `:global(.v4-session-aside) .clock-session-timecode {` (font-weight) | same | **DEAD** (as above) |

---

### `pages/index/components/EventLogSheet.module.css`

> Documented rationale (1–12): reserved for chrome rendered by FeedShell (shared with Transcribe/Topics feeds) and the `#v4-log-session` ancestor pivot.

| File | Line | Selector | Target | Owner (TSX emitter or DEAD) |
|---|---|---|---|---|
| EventLogSheet.module.css | 334 | `:global(.v4-log-sheet) {` | `.v4-log-sheet` | `FeedShell.tsx:31` (array-join className) |
| EventLogSheet.module.css | 347 | `:global(.v4-log-bottom) {` | `.v4-log-bottom` | `FeedShell.tsx:59` |
| EventLogSheet.module.css | 354 | `:global(.v4-log-sheet) {` (2nd) | same | `FeedShell.tsx:31` |
| EventLogSheet.module.css | 364 | `:global(#v4-log-session .v4-log-sheet.v5-event-feed) {` | `#v4-log-session` + `.v4-log-sheet.v5-event-feed` | `SessionWorkspace.tsx:258` id; `FeedShell.tsx:31` |
| EventLogSheet.module.css | 377 | `:global(#v4-log-session .v4-log-sheet.v5-event-feed > .v5-event-feed-top) {` | + `.v5-event-feed-top` | `FeedShell.tsx:35` |
| EventLogSheet.module.css | 390 | `:global(#v4-log-session .v5-event-feed-top__titles) {` | + `.v5-event-feed-top__titles` | `FeedShell.tsx:36` |
| EventLogSheet.module.css | 397 | `:global(#v4-log-session .v5-event-feed-top .v5-event-feed-head) {` | + `.v5-event-feed-head` | `FeedShell.tsx:35,37` |
| EventLogSheet.module.css | 407 | `:global(#v4-log-session .v5-event-feed-toolbar) {` | + `.v5-event-feed-toolbar` | `FeedShell.tsx:48` |
| EventLogSheet.module.css | 420 | (inside `@media (max-width: 767px)`) same as 377 | same | Same |
| EventLogSheet.module.css | 426 | `:global(#v4-log-session) .v5EventFeedToolbarBatch {` | ancestor + local hashed class | Self-referential specificity hack — `styles.v5EventFeedToolbarBatch` at `EventLogSheet.tsx:390` |
| EventLogSheet.module.css | 439 | `:global(#v4-log-session) .v5FeedStateInputs {` | ancestor + local | Self-referential — `EventLogSheet.tsx:434` |
| EventLogSheet.module.css | 452 | `:global(#v4-log-session) .v5FeedStateInputs input {` | + `input` | Self-referential |

---

### `pages/index/components/NewSessionModal.module.css`

No dedicated header rationale (general carve-out note only).

| File | Line | Selector | Target | Owner (TSX emitter or DEAD) |
|---|---|---|---|---|
| NewSessionModal.module.css | 83 | `.new-session-dialog :global(.btn.primary) {` | local/literal `.new-session-dialog` + global `.btn.primary` | `.btn.primary` widely emitted; `.new-session-dialog` unverified — presumed the Radix Dialog `className` prop, not `styles.newSessionDialog` |
| NewSessionModal.module.css | 90 | `.new-session-dialog :global(.btn.primary:hover) {` | same | Same |
| NewSessionModal.module.css | 94 | `.new-session-dialog :global(.btn:not(.primary)) {` | same | Same |
| NewSessionModal.module.css | 101 | `.new-session-dialog :global(.btn:not(.primary):hover) {` | same | Same |
| NewSessionModal.module.css | 105 | `.new-session-dialog :global(.profile-select),` | + `.profile-select` | `EventButtonsTable.tsx:400` + 9 sites |
| NewSessionModal.module.css | 106 | `.new-session-dialog :global(.fps-select),` | + `.fps-select` | `NewSessionModal.tsx:269` |
| NewSessionModal.module.css | 107 | `.new-session-dialog :global(.num),` | + `.num` | `NewSessionModal.tsx:288,310` |
| NewSessionModal.module.css | 108 | `.new-session-dialog :global(.new-session-form input) {` | + `.new-session-form` + `input` | `NewSessionModal.tsx:174` |
| NewSessionModal.module.css | 115 | `.new-session-dialog :global(.fps-field-label) {` | + `.fps-field-label` | `NewSessionModal.tsx:266` |
| NewSessionModal.module.css | 136 | `.new-session-dialog :global(#ns-fps-preset) {` | + `#ns-fps-preset` | `NewSessionModal.tsx:268` (id) |

---

### `pages/index/components/EventButtonsTable.module.css`

> Documented rationale (1–9): rules that need to beat global `.profile-select` margin/padding keep `:global(#modal-app-settings)` for specificity.

| File | Line | Selector | Target | Owner (TSX emitter or DEAD) |
|---|---|---|---|---|
| EventButtonsTable.module.css | 150 | `:global(#modal-app-settings) .copyFromSelect {` | `#modal-app-settings` + local | **`#modal-app-settings` — DEAD** (see D/S1: `id="modal-app-settings"` never rendered) |
| EventButtonsTable.module.css | 163 | `:global(#modal-app-settings) .headNewBtn:global(.btn) {` | same + local + global `.btn` | Same DEAD ancestor; `.btn` alive |
| EventButtonsTable.module.css | 290 | `:global(#modal-app-settings) .table .colName,` | same | DEAD ancestor |
| EventButtonsTable.module.css | 291 | `:global(#modal-app-settings) .table .colType {` | same | DEAD ancestor |
| EventButtonsTable.module.css | 326 | `:global(#modal-app-settings) .table .colOptionsBtn:global(.btn) {` | same | DEAD ancestor |
| EventButtonsTable.module.css | 346 | `:global(#modal-app-settings) .table .colNameWrap .colName {` | same | DEAD ancestor |
| EventButtonsTable.module.css | 353-354 | `.colNameWrap:hover/:focus-within .colName` | same | DEAD ancestor |
| EventButtonsTable.module.css | 358 | `.colOptionsWrap .colOptionsBtn:global(.btn) {` | same | DEAD ancestor |
| EventButtonsTable.module.css | 368-369 | `.colOptionsWrap:hover/:focus-within .colOptionsBtn:not(:disabled)` | same | DEAD ancestor |
| EventButtonsTable.module.css | 373 | `.colDelete:global(.btn-icon.btn) {` | same | DEAD ancestor |
| EventButtonsTable.module.css | 388 | `.table .colDelete:global(.btn-icon) svg {` | local + global `.btn-icon` | `EventButtonsTable.tsx:385,489` — this one has **no** `#modal-app-settings` prefix, so it's alive |

*(All 12 `#modal-app-settings`-prefixed rules in this file are unreachable — see Section D, S1.)*

---

### `pages/index/components/FeedTable.module.css`

> Documented rationale (10–16): reserved for ancestor/sibling hooks other components own — `.v5-transcribe-feed`/`.v5-topics-feed` modifier strings into FeedShell; `.mono` is chrome's font helper.

| File | Line | Selector | Target | Owner |
|---|---|---|---|---|
| FeedTable.module.css | 19 | `:global(.v5-transcribe-feed),` | `.v5-transcribe-feed` | `TranscribeFeed.tsx:133` — `modifier="v5-transcribe-feed"` into `FeedShell` |
| FeedTable.module.css | 20 | `:global(.v5-topics-feed) {` | `.v5-topics-feed` | `TopicsFeed.tsx:95` — same mechanism |
| FeedTable.module.css | 50-51 | (media query) same pair | same | Same |
| FeedTable.module.css | 192 | `.feedInlineInput:global(.mono) {` | local + global `.mono` | `TranscribeRow.tsx:50` (clsx); `.mono` widely emitted |

---

### `pages/index/components/V6Rail.module.css`

> Documented rationale (1–13): body-state classes `.v6-app--rail-collapsed`/`.v6-app--rail-animating` toggled by JS on `<body>`.

| File | Line | Selector | Target | Owner (TSX emitter or DEAD) |
|---|---|---|---|---|
| V6Rail.module.css | 68 | `:global(.v6-app--rail-animating) .v6-rail {` | body class + local `.v6-rail` | **`.v6-app--rail-animating` — DEAD**: only `.v6-app--rail-collapsed` is toggled (`V6Rail.tsx:47,50`) |
| V6Rail.module.css | 72 | `:global(.v6-app--rail-collapsed) .v6-rail {` | body class (alive) + local | `V6Rail.tsx:47` `document.body.classList.toggle(...)` |
| V6Rail.module.css | 78-80 | `.v6-rail-menu,` `.v6-rail-primary,` `.v6-rail-nav {` | same body class + locals | Same. **Note:** these trailing hyphen-case tokens outside `:global()` will NOT match the camelCase-hashed local classes (`styles.v6RailMenu` etc.) under `localsConvention: 'camelCaseOnly'` — flagged as a likely pre-existing bug (see Section B) |
| V6Rail.module.css | 201, 208, 212, 237, 264, 302, 426 | Various `.v6-rail-*` descendants | same body class | Same caveat as above |
| V6Rail.module.css | 460, 467-469, 475-476 | (media query) same set | same | Same |

---

### `pages/index/components/EventOptionsModal.module.css`

No live `:global()` — line 6 comment documents `#modal-event-options` as dropped in v1.22.1 (Radix Dialog migration). Confirmed dead, historical only.

---

### `pages/index/components/CategoryButtonStrip.module.css`

No dedicated header rationale.

| File | Line | Selector | Target | Owner (TSX emitter or DEAD) |
|---|---|---|---|---|
| CategoryButtonStrip.module.css | 19 | `.logFormPanelCompact :global(.field) {` | local + global `.field` | `.field` → `CategoryButtonStrip.tsx:32,111` + widely elsewhere |
| CategoryButtonStrip.module.css | 207 | `:global(.v4-cat-buttons__scroll) .catStrip {` | `.v4-cat-buttons__scroll` + local | `SessionWorkspace.tsx:268` |
| CategoryButtonStrip.module.css | 223, 248-249 | `.catBtn` / `:disabled` variants | same | Same |
| CategoryButtonStrip.module.css | 261 | `:global(.v3-cue-grid-panel) .catStrip {` | **`.v3-cue-grid-panel` — DEAD** | No emitter anywhere (confirmed in Section D item 1) |
| CategoryButtonStrip.module.css | 271 | `.catBtn` variant | same | DEAD |
| CategoryButtonStrip.module.css | 296 | `:global(#v4-log-session #cat-strip-live-slot) .catStrip {` | both ids | `SessionWorkspace.tsx:258,316` |
| CategoryButtonStrip.module.css | 308 | `:global(#v4-log-session) .catBtn {` | `#v4-log-session` + local | `SessionWorkspace.tsx:258` |
| CategoryButtonStrip.module.css | 316 | `:global(#v4-log-session .cat-btn__line) {` | + `.cat-btn__line` | **`.cat-btn__line` — DEAD** (confirmed D/S6) |
| CategoryButtonStrip.module.css | 328, 354, 361, 367, 372, 382 | `#cat-strip-live-slot` variants | both ids | `SessionWorkspace.tsx:258,316` |
| CategoryButtonStrip.module.css | 390 | (media query) same as 367 | same | Same |

---

### `pages/index/components/HomeSettingsModal.module.css`

> Documented rationale (12–14): `:global(#modal-app-settings)` used where specificity must beat shared globals (`.profile-select`, `.btn`, `.v6-workspace-modal__close`).

| File | Line | Selector | Target | Owner (TSX emitter or DEAD) |
|---|---|---|---|---|
| HomeSettingsModal.module.css | 33, 40 | `.settings-dialog :global(.btn.primary)` (+hover) | literal `.settings-dialog` + global | `.btn.primary` widely emitted |
| HomeSettingsModal.module.css | 44-46 | `.profile-select`, `.fps-select`, `.num` | same | Cross-component reuse |
| HomeSettingsModal.module.css | 121 | `:global(#modal-app-settings) .toolbar :global(.profile-select) {` | **DEAD ancestor** | `#modal-app-settings` never rendered (D/S1) |
| HomeSettingsModal.module.css | 135 | `:global(#modal-app-settings) .toolbarActions :global(.btn) {` | **DEAD ancestor** | Same |
| HomeSettingsModal.module.css | 142 | `:global(#modal-app-settings) .toolbarClose:global(.v6-workspace-modal__close) {` | **DEAD** (two reasons — see D item 4) | `#modal-app-settings` never rendered AND `.v6-workspace-modal__close` never emitted |
| HomeSettingsModal.module.css | 165 | `.profileShowFieldsHead :global(.settings-subheading) {` | local + global | `HomeSettingsModal.tsx:349` + 5 sites |

---

### `pages/index/components/Timeline.module.css`

No dedicated `:global()` policy comment. Nearly all `:global(#v4-log-session)`-prefixed rules are a **self-referential specificity hack** — descendant classes are Timeline's own hashed locals, wrapped in the global ancestor purely to win cascade order.

| File | Line | Selector | Target | Owner (TSX emitter or DEAD) |
|---|---|---|---|---|
| Timeline.module.css | 48 | `.timelineAudioSeekOverlay:not(:global(.hidden)) {` | local + global `.hidden` (negated) | `.hidden` widely toggled |
| Timeline.module.css | 111, 121 | `.autologgerLoadingVideoTimelineOverlay :global(.autologger-loading-video__media)` (+nested) | local + global | As documented in AppShell section |
| Timeline.module.css | 648, 1448 | `:global(.timeline-hover-tooltip) {` | `.timeline-hover-tooltip` | `Timeline.tsx:870` |
| Timeline.module.css | 1042 | `:global(#v4-log-session) {` | `#v4-log-session` | `SessionWorkspace.tsx:258` |
| Timeline.module.css | 1047–1462 (~50 rules) | `.v4TimelineZoomRail`, `.v4ExtRow`, `.v4TimelineRow`, `.v4TlTrackLive`, `.v4NavArea/Cat/CatDynamic/CatTitle/Msg*`, `.timelineShell/Viewport/Ticks/Track*`, `.timelineTrackLayers`, `.timelineClip*`, `.timelineMarker*`, `.timelinePlayhead`, `.timelineHoverPlayhead*`, `.v4ZoomRange/Bar/Handle` | `#v4-log-session` + local hashed classes | Self-referential — all resolve to `Timeline.tsx`/`timeline/Timeline*.tsx` sub-components (full line-by-line detail in scratch artifact) |
| Timeline.module.css | 1342, 1346 | `.timelineAudioSeekOverlayBackdrop`, `.timelineAudioSeekOverlayLabel` | `#v4-log-session` + local | **DEAD** — not emitted via `styles.*` anywhere |
| Timeline.module.css | 1431 | `.timelineReadout` | `#v4-log-session` + local | **DEAD** — not emitted anywhere |
| Timeline.module.css | 1500–1555 (~13 rules) | `body.perf-dbg--*` variants (waveform, playhead-glow, decorative-videos, panel-shadows, marker-fx, waveform-gradients) | body class + `#v4-log-session`/`#timeline-shell` + local | body classes → `perfDebug.ts:47-72`; `#timeline-shell` → `Timeline.tsx:711` |

---

### `pages/index/components/SessionWorkspace.module.css`

> Documented rationale (7–24, Step 11e v1.15.2): hashed classes are truly SessionWorkspace-rendered; everything else is `:global()` because it's rendered by AppShell (`.main-v3`/`.v3-layout-session-focus`), Timeline (`.v5-deck-*`/`.v4-playback-deck-*`/`.v5-studio-name-inline`/`.v5-session-date-inline`/`.v4-episode`/`.v4-session-date`/`.v5-btn-export-log`/`.v5-session-timeline-stack`), or FeedShell (`.v5-panel-main-title*`/`.v5-event-feed*`).

This is the largest file — 130+ `:global()` occurrences, many repeated across three responsive/phase carve-in blocks (base, phase-5, phase-3 v5-ui). Key findings:

| Target | Lines (all repeats) | Owner |
|---|---|---|
| `.main-v3` | 37, 100, 232 | `AppShell.tsx:207` |
| `.main-v3 .v3-right-wrap` | 50, 107, 238 | AppShell + `SessionWorkspace.tsx:199` |
| `.main-v3.v3-layout-session-focus .v3-right-wrap` | 59, 252, 1083 | Same |
| `.v3-session-active-root` | 67, 115, 259, 1084 | `SessionWorkspace.tsx:242` |
| `#v3-session-grid.v4-session-workspace` | 76, 124, 1085 | `SessionWorkspace.tsx:256` |
| `.v4-session-workspace` | 83, 132, 278 | `SessionWorkspace.tsx:256` |
| `.v4-session-workspace .v4-log-session` | 87, 139, 287, 1086 | `SessionWorkspace.tsx:258-259` |
| `.v4-log-sheet` | 92 | `FeedShell.tsx:31` |
| `.v4-session-workspace .v4-log-bottom` | 96, 173, 313, 1087 | `FeedShell.tsx:59` |
| `#v4-log-session .v5-session-panels` | 159, 556, 1060 | `SessionWorkspace.tsx:258,282` |
| `#v4-log-session .v5-session-timeline-stack` | 163, 583 | `Timeline.tsx:594` |
| `#v4-log-session .v5-panel-head` | 164, 679 | `Timeline.tsx:595` + `SessionWorkspace.tsx:310` |
| `#v4-log-session .v4-log-top__playback.v5-session-timeline-panel` | 168, 566, 1065 | `SessionWorkspace.tsx:285` |
| `#v4-log-session .v5-session-controls-panel` | 169, 630, 1071 | `SessionWorkspace.tsx:334` |
| `#v4-log-session .v4-log-sheet.v5-event-feed …` (event feed group) | 182, 191, 195-197, 723 | `FeedShell.tsx:31,35-37` |
| `#v4-log-session … .table-wrap-log-sheet` | 201 | **DEAD** — no emitter |
| `.v4-log-session` / `.v4-log-top` / `.v4-log-bottom` (bare) | 205-207, 359, 370, 380, 524, 528 | `SessionWorkspace.tsx:258-263`; `FeedShell.tsx:59` |
| `#v4-log-session .v4-log-top.v4-log-top--playback` | 212, 547 | `SessionWorkspace.tsx:263` — **see Section E, resolved duplicate with Timeline.module.css** |
| `.v4-log-sheet #log-sheet-table thead.v4-sheet-thead-sr` (+`th`) | 293, 305 | **DEAD** — `#log-sheet-table` and `.v4-sheet-thead-sr` never emitted |
| `.v4-log-sheet .sheet th` | 309 | `.sheet` self-referential → `EventLogSheet.tsx:419` |
| `.v3SessionLoading :global(.autologger-loading-video[__media])` | 332, 336 | `SessionWorkspace.tsx:224` |
| `.v4-log-session.is-visible` | 366 | `SessionWorkspace.tsx:259` |
| `.v4-log-top__capture` | 389, 401, 539, 624 | `SessionWorkspace.tsx:265` |
| `body[data-v4-transport="…"] .v4-log-top__capture/__playback` | 396-397, 414-415 | **DEAD attribute** — `data-v4-transport` never set anywhere |
| `.v4-cat-buttons` / `.v4-cat-buttons__scroll` | 428, 437 | `SessionWorkspace.tsx:267-268` |
| `.v4-episode` / `.v4-session-date` | 466, 477, 879, 888 | `Timeline.tsx:615,624` |
| `.v4-session-ctrl` | 486, 666 | `SessionWorkspace.tsx:364` |
| `#v4-log-session #studio-name.v4-episode` | 512 | `Timeline.tsx:615-616` |
| `#v4-log-session[data-v5-live-log="1"] …` | 621, 624, 627 | `data-v5-live-log` → `SessionWorkspace.tsx:261` (live, ternary attribute — unlike the dead `data-v4-transport`) |
| `.v5SessionLiveLog*` group | 593, 601, 605, 611, 715 | Self-referential locals |
| `.v5-panel-head__main/__actions/--controls`, `.v5-panel-eyebrow` | 690, 699, 710, 721-723 | Timeline + SessionWorkspace + FeedShell (multi-emitter) |
| `.v5-panel-main-title*` | 746, 758, 765 | `SessionWorkspace.tsx:339` + `FeedShell.tsx:39` |
| `.v5-deck-title-cluster`, `.v4-playback-deck-title/__header`, `.v5-deck-session-meta/-meta-sep`, `.v5-studio-name-inline`, `.v5-session-date-inline` | 782-844 | All → `Timeline.tsx:598-624` |
| `.v5-btn-export-log.btn.primary` | 860, 874 | `Timeline.tsx:634` |
| `.v5FeedTabsPanel :global(.v4-log-sheet.v5-event-feed)` | 1026 | `FeedShell.tsx:31` |
| `.v4-log-session .btn`/`.btn.primary` | 1032, 1039, 1043, 1049 | Widely emitted `.btn`/`.primary` |

---

### `pages/index/components/TransportControls.module.css`

> Documented rationale (8–11): ancestor classes `.v4-session-ctrl`, `.v5-session-controls-panel`, `#v4-log-session` are rendered by SessionWorkspace.tsx.

| File | Line | Selector | Target | Owner |
|---|---|---|---|---|
| TransportControls.module.css | 78 | `:global(#btn-ctl-1-icon) {` | `#btn-ctl-1-icon` | `TransportControls.tsx:267` — template-literal id (matches when `i===0`) |
| TransportControls.module.css | 125 | `:global(.v4-session-ctrl) .v4CtrlBtn.sessionCtlBtn {` | `.v4-session-ctrl` + local | `SessionWorkspace.tsx:364` |
| TransportControls.module.css | 138–293 (17 rules) | `#v4-log-session .v5-session-controls-panel) .v4CtrlBtn.sessionCtlBtn` + state modifiers (`isSolidGrey.toneGreen/Red/Grey/Light`, `isSolidGreen`, `isSolidRed`, `isDisabled`, hover/focus/media-query variants) | Both ancestors + local | `SessionWorkspace.tsx:258,334`; modifiers via `clsx` in `TransportControls.tsx` |

### Summary of confirmed DEAD `:global()` targets

- `.new-session-panel` (AppShell.module.css:330)
- `.v6-workspace-modal` / `.v6-workspace-modal__close` (comments + HomeSettingsModal.module.css:142) — superseded by Radix Dialog
- `#modal-event-options` (EventOptionsModal comment only, dropped v1.22.1)
- `.clock-label` / `.clock-session-timecode` (TimecodeDisplay.module.css:223,224,229,235) — kebab-case never matched
- `.v6-app--rail-animating` (V6Rail.module.css:68)
- `.v3-cue-grid-panel` (CategoryButtonStrip.module.css:261,271)
- `.cat-btn__line` (CategoryButtonStrip.module.css:316)
- `.timelineAudioSeekOverlayBackdrop` / `.timelineAudioSeekOverlayLabel` (Timeline.module.css:1342,1346)
- `.timelineReadout` (Timeline.module.css:1431)
- `.table-wrap-log-sheet` (SessionWorkspace.module.css:201)
- `#log-sheet-table` / `.v4-sheet-thead-sr` (SessionWorkspace.module.css:293,305)
- `body[data-v4-transport="…"]` (SessionWorkspace.module.css:396,397,414,415) — attribute never set
- `.settings-panel h2` context (AppShell.module.css:316) — `.settings-panel` only on admin-users page
- All 12 `#modal-app-settings`-prefixed rules (HomeSettingsModal + EventButtonsTable) — `id="modal-app-settings"` never rendered

---

## B. Cross-file class emission map

### Layout / shell / page-chrome classes

| Class name | Emitted by | Styled by | Notes |
|---|---|---|---|
| `shell` | `AppShell.tsx:173`; `AdminUsersPage.tsx:134` | `chrome.css:12` | chrome-only — safe Tailwind target |
| `shell-v3` | `AppShell.tsx:173` | `chrome.css:18` + `:global(.shell.shell-v3)` `AppShell.module.css:102` | Cross-module |
| `header` | `AdminUsersPage.tsx:135` | `chrome.css:25` | chrome-only |
| `header-home` | `AdminUsersPage.tsx:135` | NONE | Orphaned |
| `main` | `AdminUsersPage.tsx:150` | `chrome.css:187` | chrome-only (distinct from `main-v3`) |
| `main-v3` | `AppShell.tsx:207` | `:global(.main-v3)` in AppShell.module.css:100,232; RecentSessionsList/NewSessionModal/SessionWorkspace.module.css:37,50,59,100,107,238,252 | Heavy cross-module — anchor reused by 4+ module files |
| `v3-layout-session-focus` | `AppShell.tsx:207` | SessionWorkspace.module.css:59,252 | Cross-module |
| `v3-right-wrap` | `SessionWorkspace.tsx:199` | AppShell.module.css:50,238 | Cross-module |
| `footer` | `AdminUsersPage.tsx:324` | `chrome.css:341,349`; perfDebug.module.css:17 | Mostly chrome-only |
| `brand`, `brand-with-logo`, `brand-lockup`, `brand-logo`, `brand-text` | `AdminUsersPage.tsx:136-139` | `chrome.css:37,45,61,76` | chrome-only |
| `tagline` | `AdminUsersPage.tsx:144` | `chrome.css:83` | chrome-only |
| `crumb` | `AdminUsersPage.tsx:140` | `chrome.css:377,382,387` | chrome-only |
| `developer-footer/-label/-logo` | `AdminUsersPage.tsx:325,326,328` | `chrome.css:353,360,368` | chrome-only |
| `panel` | (only as `settings-panel` compound) | `chrome.css:193,200`; perfDebug.module.css:16 | chrome + perf-debug override |
| `settings-panel` | `AdminUsersPage.tsx:151` | `chrome.css:96`; `AppShell.module.css:316` (`h2` reach-in) | Cross-module |
| `admin-settings-block` | `AdminUsersPage.tsx:173,205,244`; `EventButtonsTable.tsx:260`; `HomeSettingsModal.tsx:346,415` | `chrome.css:90,96` | chrome-only rules, shared vocabulary across 3 components |
| `settings-subheading` | `AdminUsersPage.tsx` + `EventButtonsTable.tsx:261` + `HomeSettingsModal.tsx:349,431` | `chrome.css:100`; HomeSettingsModal.module.css:165 | Mostly chrome, one cross-module reference |
| `settings-actions` | `AdminUsersPage.tsx:165` | `chrome.css:107` | chrome-only |
| `admin-table` | `AdminUsersPage.tsx:207,215,246` | NONE | Orphaned — needs net-new Tailwind styling |

### Button / form chrome classes

| Class name | Emitted by | Styled by | Notes |
|---|---|---|---|
| `btn` | Extremely widespread (12+ components) | `chrome.css:146,159,168...`; `:global(.btn…)` in NewSessionModal/HomeSettingsModal/SessionWorkspace/EventButtonsTable.module.css | Heavy cross-module coupling — not a simple Tailwind swap |
| `primary` (`btn primary`) | Same components | `chrome.css:303,309,314` + same 4 module files | Cross-module |
| `danger` | AdminUsersPage, EventOptionsModal, YouTubeImportErrorModal, EventButtonsTable | `chrome.css:146,152,159,160` | chrome-only |
| `btn-icon` | AdminUsersPage:273; EventButtonsTable:385 | `:global(.btn-icon.btn)` EventButtonsTable.module.css:373,388 | Cross-module — no chrome.css base rule |
| `field` | NewSessionModal, CategoryButtonStrip, EventOptionsModal, HomeSettingsModal, AdminUsersPage | `chrome.css:215,221`; `:global(.field)` CategoryButtonStrip.module.css:19 | Mostly chrome-only |
| `field-optional` | NewSessionModal.tsx:213 | NONE | Orphaned |
| `num` | NewSessionModal.tsx:288,310 | `chrome.css:228,248,253` + NewSessionModal.module.css:107 + HomeSettingsModal.module.css:46 | Cross-module |
| `mono` | AppShell, EventOptionsModal, TopicsRow, TranscribeRow, RecentSessionsList, SessionWorkspace, Timeline, HomeSettingsModal | `chrome.css:242,243,349` + `:global(.mono)` FeedTable.module.css:192 | Cross-module composition |
| `faint` | EventLogSheet, Timeline, SessionWorkspace (all clsx) | `chrome.css:391` | chrome-only |
| `hint` / `actions` | Not emitted bare (only compounds like `fps-hint`, `modal-hint`, `settings-actions`) | `chrome.css:264` / `chrome.css:257` | Base rules present, no bare emitters found |
| `pad` | Not emitted (only JS var `pad` in Timeline.tsx) | `chrome.css:461` | **Dead** (see Section D, S3) |
| `table-wrap` | Not emitted bare | `chrome.css:465`; `table-wrap-log-sheet` variant also dead | **Dead** (see Section D) |
| `log-form` | Not emitted | `chrome.css:209` | **Dead** (see Section D) |
| `profile-select` | Extremely widespread | `chrome.css:175` + `:global(.profile-select)` in NewSessionModal/HomeSettingsModal.module.css | Heavy cross-module coupling |
| `tool-row`, `tool-row-session-opts`, `export-row` | ExportModal, NewSessionModal, YouTubeImportErrorModal, TranscribeModal | `chrome.css:323,409,337` | chrome-only |
| `modal-actions`, `modal-dropdown-actions`, `modal-export-actions`, `modal-lead`, `modal-hint` | Various modals | `chrome.css:168,118,472,132,139` | chrome-only |
| `modal-card` | Not emitted (only AppShell.module.css comment) | `chrome.css:125` | **Dead** — superseded by Radix Dialog |
| `modal-transcribe-status/-error` | TranscribeModal.tsx:61,75 | NONE | Orphaned |
| `fps-field`, `fps-field-label`, `fps-select`, `fps-custom-*`, `fps-hint` | NewSessionModal.tsx:264-297 | `chrome.css:413-454` + `:global()` in NewSessionModal/HomeSettingsModal.module.css | Cross-module on `fps-select`/`fps-field-label`; others chrome-only. **Not** via `FpsSelect.tsx` — it only forwards a `className` prop |
| `new-session-form` | NewSessionModal.tsx:174 | `chrome.css:405` + NewSessionModal.module.css:108 | Cross-module |
| `new-session-panel` | Not emitted | `chrome.css:397` + `:global(.main-v3 .new-session-panel)` AppShell.module.css:330 | **Dead** |

### v3-* session-root classes

| Class name | Emitted by | Styled by | Notes |
|---|---|---|---|
| `v3-session-active-root` | SessionWorkspace.tsx:242 | AppShell.module.css:67,115,259; SessionWorkspace.module.css:1084 | Cross-module |
| `v3-cue-grid-panel` | Not emitted | CategoryButtonStrip.module.css:261,271 | **Dead** |

### v4-* session/workspace classes

| Class name | Emitted by | Styled by | Notes |
|---|---|---|---|
| `v4-top-bar` | AppShell.tsx:235 | AppShell.module.css:145,153,170,217,291; perfDebug.module.css:19 | Cross-module, heavily overridden |
| `v4-search-input` | V6Rail.tsx:145 | AppShell.module.css:233,245,301,305 | Cross-module (V6Rail emits, AppShell styles) |
| `v4-log-bottom` | FeedShell.tsx:59 | EventLogSheet, SessionWorkspace.module.css | Cross-module |
| `v4-log-sheet` | FeedShell.tsx:34 (sheetCls) | EventLogSheet, SessionWorkspace, perfDebug.module.css | Heavy cross-module — single biggest anchor family alongside `#v4-log-session` |
| `v4-session-workspace` | SessionWorkspace.tsx:256 | SessionWorkspace.module.css (self, multiple carve-ins) | Mostly self-referential |
| `v4-log-session` (id `#v4-log-session` + class) | SessionWorkspace.tsx:258-259 | SessionWorkspace, EventButtonsTable, Timeline, EventLogSheet, TransportControls, CategoryButtonStrip.module.css | **Very heavy cross-module coupling — used as ancestor hook by 6 different module.css files** |
| `v4-log-top`, `v4-log-top--playback` | SessionWorkspace.tsx:263 | SessionWorkspace.module.css:151,370,528,384,553; perfDebug.module.css:20 | Cross-module |
| `v4-log-top__capture` | SessionWorkspace.tsx:265 | SessionWorkspace.module.css (own carve-ins) | Mostly self-scoped |
| `v4-cat-buttons`, `v4-cat-buttons__scroll` | SessionWorkspace.tsx:267,268 | SessionWorkspace.module.css:428,437; CategoryButtonStrip.module.css | Cross-module |
| `v4-cat-hint` | CategoryButtonStrip.tsx:262,317 | NONE | Orphaned (superseded by `styles.catStripHint`) |
| `v4-log-top__playback` | SessionWorkspace.tsx:285 | SessionWorkspace.module.css:168,566,627; Timeline.module.css:1051 | Cross-module (SessionWorkspace ↔ Timeline) |
| `v4-session-aside` | SessionWorkspace.tsx:360 | TimecodeDisplay.module.css:223,224,229,235 (all DEAD); perfDebug.module.css:22 | Cross-module |
| `v4-session-ctrl` | SessionWorkspace.tsx:364 | SessionWorkspace.module.css:486; TransportControls.module.css:125 | Cross-module |
| `v4-episode`, `v4-session-date` | Timeline.tsx:615,624 | SessionWorkspace.module.css:466,477,879,888,518 | Cross-module (Timeline emits, SessionWorkspace styles) |
| `v4-playback-deck-header/-title` | Timeline.tsx:598,601 | SessionWorkspace.module.css:833,844 | Cross-module |
| `session-title-code/-sep/-ep`, `session-aside-date` | Timeline.tsx:605,608,611,624 | NONE | Orphaned |

### v5-* panel/feed classes

| Class name | Emitted by | Styled by | Notes |
|---|---|---|---|
| `v5-event-feed-top`, `-top__titles`, `-head`, `-toolbar`, `v5-event-feed` | FeedShell.tsx:30-48 | SessionWorkspace + EventLogSheet.module.css | Heavy cross-module — FeedShell emits, both style |
| `v5-panel-main-title`, `--numeric` | FeedShell.tsx:39; SessionWorkspace.tsx:339 | SessionWorkspace.module.css:746,758,765 | Cross-module, two emitters |
| `v5-transcribe-feed`, `v5-topics-feed` | Passed as `modifier` prop into FeedShell from TranscribeFeed/TopicsFeed | FeedTable.module.css:19,20,50,51 | Cross-module via prop indirection |
| `v5-panel-head`, `--timeline`, `--controls`, `__main`, `__actions` | Timeline.tsx:595,596,631; SessionWorkspace.tsx:310,311,335,336 | SessionWorkspace.module.css:679,690,699,710 | Heavy cross-module; **`v5-panel-head--timeline` has no CSS rule — orphaned modifier** |
| `v5-panel-eyebrow` | Timeline.tsx:597; SessionWorkspace.tsx:312,337 | SessionWorkspace.module.css:721-723 | Cross-module |
| `v5-deck-title-cluster`, `-session-meta`, `-meta-sep`, `v5-studio-name-inline`, `v5-session-date-inline` | Timeline.tsx:599-624 | SessionWorkspace.module.css:782-824 | Cross-module (Timeline emits all deck/meta typography, SessionWorkspace styles) |
| `v5-btn-export-log` | Timeline.tsx:634 | SessionWorkspace.module.css:860,874 | Cross-module |
| `v5-session-timeline-stack` | Timeline.tsx:594 | SessionWorkspace.module.css:583 | Cross-module |
| `v5-session-panels`, `v5-session-timeline-panel` | SessionWorkspace.tsx:282,285 | SessionWorkspace.module.css (own carve-ins) | Mostly self-scoped |
| `v5-session-controls-panel` | SessionWorkspace.tsx:334 | SessionWorkspace.module.css (8+ lines) + **entire** TransportControls.module.css (17 rules) | Very heavy cross-module — SessionWorkspace's ancestor anchors TransportControls' whole button stylesheet |

### v6-* rail classes

| Class name | Emitted by | Styled by | Notes |
|---|---|---|---|
| `v6-app` | AppShell.tsx:174 | (modifier siblings only) | `v6-app--rail-collapsed`/`--rail-animating` toggled via `document.body.classList` in V6Rail.tsx:47,50 — **DOM-imperative, not JSX-emitted** |
| `v6-rail` | V6Rail.tsx:65-66 (id + local `styles.v6Rail`) | `:global(.v6-app--rail-collapsed) .v6-rail` etc | **Flagged likely-broken**: trailing hyphen-case tokens (`.v6-rail-menu`, `.v6-rail-primary`, etc.) outside `:global()` won't match camelCase-hashed locals under `localsConvention: 'camelCaseOnly'` — pre-existing bug independent of Tailwind migration |
| `hidden` | V6Rail.tsx:335,339 | `baseline.css:301` | chrome-only, direct Tailwind `hidden` equivalent |

### Modal / dialog classes (non-Radix, legacy)

| Class name | Emitted by | Styled by | Notes |
|---|---|---|---|
| `v6-event-option-label`, `v6-opt-label/-nc/-remove`, `v6-event-onoff-fields`, `v6-onoff-on/-off` | EventOptionsModal.tsx:71-143 | NONE | All orphaned — clean Tailwind-ify candidates (no CSS debt) |
| `v6-workspace-modal*` | Not emitted | Comments only + one live dead rule (HomeSettingsModal.module.css:142) | Legacy, superseded by Radix Dialog |
| `autologger-loading-video`, `__media` | CategoryButtonStrip, RecentSessionsList, SessionWorkspace.tsx | AppShell, perfDebug, SessionWorkspace, Timeline.module.css | Heavy cross-module — reused by 4 module files simultaneously |
| `timeline-hover-tooltip` | Timeline.tsx:870 | Timeline.module.css:648,1448 (same file) | Not actually cross-module despite being global — safe within Timeline's own migration |

### Utility classes

| Class name | Emitted by | Styled by | Notes |
|---|---|---|---|
| `hidden` | Timeline, SessionWorkspace, V6Rail.tsx | `baseline.css:301` | chrome-only, straightforward Tailwind swap; watch `Timeline.module.css:48`'s `:not(:global(.hidden))` negation |
| `muted` | RecentSessionsList, HomeSettingsModal.tsx | `:global(.muted)` AppShell.module.css:320 (single-file anchor) | Moderate but concentrated coupling |
| `animate__animated`, `animate__pulse` | SessionWorkspace.tsx:249,250 | NONE in this repo | Third-party `animate.css` classes — external stylesheet not found in `web/package.json`; confirm loading mechanism before touching |
| `col-timecode/-category/-message` | EventLogSheet.tsx:456-458 (on `<col>`) | NONE | Likely intentionally inert (browser limitation on `<col>` styling) |
| `sheet-cell-control`, `sheet-input`, `sheet-tc` | EventLogRow.tsx:171 | NONE | Orphaned — likely an unconverted literal; equivalent hashed classes exist elsewhere in same component |
| `btn-undelete-row`, `btn-delete` | EventLogRow.tsx:267,280 | NONE | Orphaned, possibly e2e test hooks — verify against `e2e/` before removing |

### v5-bg-glow (theme provider)

| Class name | Emitted by | Styled by | Notes |
|---|---|---|---|
| `v5-bg-glow`, `--grid`, `--corners` | `shared/theme/ThemeProvider.tsx:48,49` | `shared/theme/bgGlow.css` (plain CSS, zero module coupling) | **Cleanest Tailwind-ify candidate in the whole audit** |

### Admin-users page summary

`AdminUsersPage.tsx` has **no dedicated `.module.css`** — only imports `tokens.css`, `baseline.css`, `chrome.css`. Every class it emits is either chrome-only or orphaned (`header-home`, `admin-table`). **This is the cleanest page to pilot a Tailwind conversion on** — zero CSS-module cross-coupling to untangle.

---

## C. Moduleless TSX consumers

| Component | Styles consumed from | How | Notes |
|---|---|---|---|
| `EventLogRow.tsx` | `EventLogSheet.module.css` (parent's) | `import styles from './EventLogSheet.module.css'` (line 12) | Imports sibling module directly by relative path, not via props |
| `TranscribeRow.tsx` | `FeedTable.module.css` | `import styles from './FeedTable.module.css'` (line 4) | Direct import of a "grandparent-ish" shared module |
| `TopicsRow.tsx` | `FeedTable.module.css` | `import styles from './FeedTable.module.css'` (line 5) | Same pattern |
| `TranscribeFeed.tsx` | `FeedTable.module.css` | `import styles ...` (line 13) + `thModifier` string keys (lines 20-22) resolved inside `FeedTable.tsx` | Two borrowing channels: direct import + typed string-key indirection |
| `TopicsFeed.tsx` | `FeedTable.module.css` | `import styles ...` (line 7) + `thModifier` keys (lines 14-22) | Same dual pattern |
| `timeline/TimelineClips.tsx` | `Timeline.module.css` (parent's) | `import styles from '../Timeline.module.css'` (line 4) | Reaches up a directory to owning component's module |
| `timeline/TimelineMarkers.tsx` | `Timeline.module.css` | `import styles from '../Timeline.module.css'` (line 6) | Same |
| `timeline/TimelineTicks.tsx` | `Timeline.module.css` | `import styles from '../Timeline.module.css'` (line 3) | Same |
| `timeline/TimelineWaveform.tsx` | `Timeline.module.css` | `import styles from '../Timeline.module.css'` (line 9) | Heaviest consumer by class count |
| `shared/ui/RadioGroup.tsx` | Props from `EventButtonsTable.tsx` (via `EventButtonsTable.module.css`) | `className`/`itemClassName` props (interface lines 9-16) | Headless Radix wrapper — "child renders whatever class parent computed" pattern, distinct from sibling-import pattern |
| `FeedShell.tsx` | *(none — global CSS only)* | Builds `sheetCls` from plain strings (line 31) | **Not actually a module-borrower** despite being on the "known" list — owns no module, imports none. Structural shell composing legacy global chrome classes + a `modifier` prop |
| `ExportModal.tsx`, `TranscribeModal.tsx`, `YouTubeImportErrorModal.tsx` | *(none — global CSS only)* | Literal chrome-class strings; wrap content in `Dialog` for structure only | Not true module-borrowers |
| `FpsSelect.tsx` | Props from caller (NewSessionModal, HomeSettingsModal) | `className?: string` forwarded to `Select` | `Select` owns its own module; FpsSelect never imports it |
| `AudioPlayer.tsx`, `AudioRecorder.tsx` | *(none)* | No className/styles at all | Logic-only components |
| `WorkspaceStatic.tsx` | *(none)* | Pure `memo()` composition wrapper | Not a CSS consumer |
| `AdminUsersPage.tsx` | *(none — global CSS only)* | Literal global strings throughout | No module.css anywhere on the page |

### ThemeContext consumers

Exhaustive search (`grep -rn "useTheme"` / `"ThemeContext"`) found **zero call sites** of `useTheme()` outside its own definition.

- `shared/theme/ThemeProvider.tsx:55` — hook definition only, exported but unused.
- `pages/index/main.tsx:18`, `pages/admin-users/main.tsx:15` — both mount `<ThemeProvider>` (context *is* provided at runtime) but nothing consumes it via `useTheme()`.

**Implication:** the premise that `ThemeProvider` "distributes `glass.module.css` classes via ThemeContext" to moduleless consumers is **aspirational/unrealized** — the plumbing exists but has zero live consumers today. Any `glass.module.css` classes appearing elsewhere arrive through a different channel (plain global `v5-*` classes), not this Context. `ThemeProvider.tsx` itself owns `glass.module.css` directly and is the producer, not a moduleless consumer.

---

## D. Dead-rule verification

Verification method: for each suspect, (a) locate the exact CSS rule block, (b) grep all `.tsx`/`.ts` for any emission — including `clsx()`, template literals, `styles['bracket']` access — and (c) distinguish literal global classes (matched by `:global()`) from hashed CSS-module classes (`styles.xxx`), which do **not** satisfy `:global()` selectors.

### 1. `:global(.v3-cue-grid-panel)` — CategoryButtonStrip.module.css
- **VERDICT: DEAD**
- Evidence: `grep -rn 'v3-cue-grid-panel' --include='*.tsx' --include='*.ts' web/src` → no matches anywhere; only the CSS file itself references it. The block's own comment says "moved from SessionWorkspace.css" — that legacy origin no longer exists.
- Location: `CategoryButtonStrip.module.css:256-287` (comment 256-258; `.catStrip` rule 261-269; `.catBtn` rule 271-287)

### 2. `:global(.toast)` — perfDebug.module.css
- **VERDICT: DEAD** (hashed-vs-literal mismatch)
- Evidence: the selector requires a literal `toast` class. `Toast.tsx:113` emits `` `${styles.toast} ${...}` `` — the hashed module class, never the literal string. No body-class mechanism re-exposes a plain `toast` class.
- Location: `perfDebug.module.css:16-24` (7-selector group; `.toast` is line 18 specifically — its 6 siblings `.panel`/`.footer`/`.v4-top-bar`/`.v4-log-top`/`.v4-log-sheet`/`.v4-session-aside` are all ALIVE)

### 3. chrome.css: `.table-wrap`, `.new-session-panel`, `.modal-card`, `.log-form`
- **VERDICT: ALL FOUR DEAD**
- Evidence: word-boundary greps for each across all `*.tsx` → zero matches for all four. (Distinct from alive lookalikes: `styles.feedTableWrap` hashed class, `new-session-form` literal, `styles.newSessionDialog` hashed class.)
- Location (`shared/theme/chrome.css`): `.modal-card h2` 125-130; `.log-form` 209-213; `.new-session-panel` 397-402; `.table-wrap` 465-470.

### 4. `.v6-workspace-modal*` remnants
- **VERDICT: DEAD** — already migrated away; remnants are stale comments plus one unreachable compound rule
- Evidence: zero `.tsx` emitters anywhere. All CSS hits are inside comments (`Dialog.module.css:2`, `AppShell.module.css:3,14,20,190,339`, `NewSessionModal.module.css:27,29,80`, `HomeSettingsModal.module.css:13,17`, `RecentSessionsList.module.css:11` — the last is itself stale, claiming a rule that no longer exists) **except** one live rule: `HomeSettingsModal.module.css:142`, which is unreachable for two independent reasons: `id="modal-app-settings"` is never rendered, AND the close button emits `clsx('btn', styles.toolbarClose)`, never the literal `v6-workspace-modal__close`.
- Location: `HomeSettingsModal.module.css:142-151` is the only deletable rule body.

### Sweep — additional dead rules found

- **S1. All 12 `:global(#modal-app-settings)`-prefixed rules** (`HomeSettingsModal.module.css:121,135,142`; `EventButtonsTable.module.css:150,163,290-291,326,346,353-354,358,368-369,373`) — DEAD, unreachable ancestor (`id="modal-app-settings"` never rendered; only `modal-app-settings-title` exists at `HomeSettingsModal.tsx:261`). **Migration caution**: the local classes composed inside these selectors are independently alive via their base rules — deleting is safe today, but if the missing id is ever fixed instead, these would suddenly activate.
- **S2. `.table-wrap-log-sheet`** (`SessionWorkspace.module.css:201-203`) — DEAD; real wrapper uses hashed `styles.feedTableWrap`.
- **S3. `.pad`** (`chrome.css:461-463`) — DEAD; only hit is an unrelated JS variable in `Timeline.tsx`.
- **S4. `.hint`** (`chrome.css:264-267`) — DEAD; only compounds (`fps-hint`, `modal-hint`) are alive.
- **S5. `.main-v3 .new-session-panel`** (`AppShell.module.css:330`) — DEAD, companion to item 3.
- **S6. `#v4-log-session .cat-btn__line`** (`CategoryButtonStrip.module.css:316`) — DEAD; comment claims "JS uses .cat-btn__line" but no JS creates it.
- **S7. 29 dead LOCAL (hashed) module classes** across 4 files, found via full 23-file sweep:
  - `FeedTable.module.css` (1): `.feedThActions` (line 93)
  - `CategoryButtonStrip.module.css` (10): `.studioBadge`, `.logFormPanelCompact`, `.logFormHeading`, `.logFormStreamlined`, `.catStripLabel`, `.catBtnMomentaryPress` (two-sided orphan — paired with a dead literal `'cat-btn-press'` in TSX with no CSS rule), `.catBtnSelected`, `.metadataDetails`, `.metadataSummaryHint`, `.metadataField`
  - `Timeline.module.css` (14): `.timelineShellSeekLoading`, `.timelineAudioSeekOverlay`, `.timelineAudioSeekOverlayBackdrop`, `.timelineAudioSeekOverlayLogoAnchor`, `.timelineAudioSeekOverlayLabel`, `.timelineAudioSeekOverlayWaveforms`, `.autologgerLoadingVideoTimelineOverlay`, `.timelineToolbar`, `.timelineReadout`, `.timelineMarkerNav`, `.markerCurrentCatCell`, `.timelineZoomBtn`, `.timelineTrackDisabled`, `.timelineWaveformClip`
  - `glass.module.css` (3+1 compound, with caveat): `.glass`, `.glassStrong`, `.shadowGlow`, `.glass.shadowGlow` — packaged into the unreachable `useTheme()` context value; deleting requires a paired `ThemeProvider.tsx` edit. **`.glassPanel` is ALIVE** via `composes: glassPanel` in Dialog/Popover/Tooltip/Select.module.css — `composes` usage is invisible to TSX-only greps, check before deleting any module class.

### Side finding (inverse — TSX references with no CSS rule)

`Timeline.tsx` references six `styles.*` keys with no matching rule in `Timeline.module.css` (resolve to `undefined`): `markerCurrentMsgSegment`, `markerCurrentMsgGap` (only `markerCurrentMsgGap2` exists), `v4ZoomHandleLeft/Right`, `timelineZoomHandleLeft/Right`. Plus `CategoryButtonStrip.tsx:170`'s literal `'cat-btn-press'` has no CSS rule anywhere. Out of scope for deletion but relevant to the same cleanup.

### Summary table

| Class/selector | File:lines | Verdict |
|---|---|---|
| `:global(.v3-cue-grid-panel)` rules | CategoryButtonStrip.module.css:261-287 | DEAD |
| `:global(body.perf-dbg--no-panel-shadows .toast)` | perfDebug.module.css:18 | DEAD (siblings alive) |
| `.table-wrap` | chrome.css:465-470 | DEAD |
| `.new-session-panel` | chrome.css:397-402 | DEAD |
| `.modal-card h2` | chrome.css:125-130 | DEAD |
| `.log-form` | chrome.css:209-213 | DEAD |
| `.v6-workspace-modal*` | comments + HomeSettingsModal.module.css:142-151 | DEAD |
| `:global(#modal-app-settings)` (12 rules) | HomeSettingsModal + EventButtonsTable.module.css | DEAD |
| `.table-wrap-log-sheet` | SessionWorkspace.module.css:201-203 | DEAD |
| `.pad` | chrome.css:461-463 | DEAD |
| `.hint` | chrome.css:264-267 | DEAD |
| `.main-v3 .new-session-panel` | AppShell.module.css:330 | DEAD |
| `.cat-btn__line` | CategoryButtonStrip.module.css:316 | DEAD |
| `.feedThActions` | FeedTable.module.css:93 | DEAD |
| 10 CategoryButtonStrip locals | CategoryButtonStrip.module.css (various) | DEAD |
| 14 Timeline locals | Timeline.module.css (various) | DEAD |
| `.glass`/`.glassStrong`/`.shadowGlow` | glass.module.css:12-28 | DEAD (needs ThemeProvider.tsx edit too) |
| `.glassPanel` | glass.module.css:38 | **ALIVE** via `composes` |
| All other chrome.css classes (37 checked) | — | ALIVE |
| All other module.css locals (19 files) | — | ALIVE |

---

## E. Equal-specificity duplicate pairs

**Bundle-order finding.** `SessionWorkspace.tsx:27` imports its own CSS before importing `Timeline` at line 29; `Timeline.tsx:26` imports its own CSS in turn. Render chain: `AppShell.tsx` → `WorkspaceStatic.tsx` → `SessionWorkspace.tsx` → `Timeline.tsx`. Because Vite/Rollup registers CSS-module side-effect imports in module-graph traversal order, `Timeline.module.css` is registered **later** in the bundle and wins ties at equal specificity. `web/vite.config.ts` has no explicit CSS-ordering override. This is a strong inference from static import-graph inspection, not confirmed against an actual `npm run build` output.

Both files were read in full (Timeline.module.css: 1558 lines; SessionWorkspace.module.css: 1093 lines) and every class/id token extracted and intersected. There is exactly **one genuine equal-specificity duplicate target**, and it is already resolved:

| Target | Timeline.module.css | SessionWorkspace.module.css | Specificity | Winner |
|---|---|---|---|---|
| `#v4-log-session .v4-log-top.v4-log-top--playback` | **Removed** — `Timeline.module.css:1081-1088` comment documents a formerly-present identical-selector rule, deleted specifically because "the winner was decided purely by CSS-module bundle order; an unrelated import-graph change could flip it and clamp the deck." | `SessionWorkspace.module.css:547-551` — `height: auto; min-height: calc(...); max-height: none;` (a non-conflicting second rule for the same pair also exists at line 212-214, `margin-top: 0`) | Equal — both `(1,2,0)` when the Timeline copy existed | **SessionWorkspace.module.css:547** — sole surviving rule by design; a *resolved* hazard, with the Timeline copy deliberately deleted rather than left to race |

**No other pairs found.** Checked and ruled out as single-file-only: `.v4-log-sheet`/`.v5-event-feed`, `.v4-cat-buttons`, `.v5-session-panels`, `.v5-panel-head`, `.v4TimelineZoomRail`, `.timelineMarker*`, `.timelinePlayhead`, `.timelineReadout`, `.v4NavArea/Cat*/Msg*`, `.v4ExtRow`, `.v4TimelineRow`, `.v4TlTrackLive`, bare `.v4-log-top*` forms, `.v4-session-workspace`, `.main-v3`, `.v3-session-active-root`. One coincidental same-name match, `.autologger-loading-video__media`, is styled independently in each file for different mounted overlay instances via different compound selectors — not a true duplicate.

**Uncertainty flagged:** the bundle-order conclusion rests on Rollup/Vite's de facto (undocumented) per-chunk CSS emission order for a single-entry build — not verified against `web/dist/assets/*.css`. If certainty is required for future migration decisions, building and grepping the emitted CSS asset for both rules' relative position would confirm it directly.

---

### Cross-cutting notes for the migration

1. **`#v4-log-session` / `.v4-log-sheet` / `.v4-log-session` are the two dominant coupling anchors** in the entire codebase — 6+ module.css files hook off them. Any Tailwind slice touching `SessionWorkspace.tsx`'s root elements must be coordinated with Timeline, EventLogSheet, EventButtonsTable, TransportControls, and CategoryButtonStrip in the same pass.
2. **`admin-users` is the cleanest starting slice** — zero module.css, only chrome.css classes plus two orphaned classes needing net-new styling (`header-home`, `admin-table`).
3. **`shared/theme/bgGlow.css` (`v5-bg-glow*`) is the cleanest component-level slice** — single plain CSS file, zero cross-module coupling.
4. **A pre-existing bug, independent of Tailwind work**, was surfaced in V6Rail.module.css: several `:global(.v6-app--rail-collapsed) .v6-rail-*` selectors use hyphen-case for what should be camelCase-hashed local classes under this repo's `localsConvention: 'camelCaseOnly'` — those rules likely never match. Worth a build/computed-style check before relying on them, and before assuming their visual behavior needs replicating in Tailwind.
5. **`id="modal-app-settings"` is never rendered anywhere**, silently deadening 12 `:global()` override rules across two files (Section D, S1) — a systemic dead zone, not scattered noise.
6. **The scratch working files** (raw per-file grep dumps, full selector-by-line detail for the two largest files) live at `/tmp/claude-1000/-home-kalen-AutoLog-autologger-cf-autologger-cf/48dbd59d-3cc3-44ef-abe7-e7ba32cebc20/scratchpad/section_{A,B,C,D,E}.md` if deeper per-line drill-down is needed beyond what's condensed above.

---

# Audit sections F–J (media/hover/important/keyframes/exotic) — verbatim from sweep agent

## F. Media-query inventory

All 16 `@media` blocks resolve to exactly **three** query strings; no other query types (no `min-width`, `print`, `orientation`, etc.) exist anywhere in `web/src/**/*.css`. **No breakpoint other than `767px`** appears anywhere.

### `(max-width: 767px)` — 6 blocks (all the same breakpoint, none flagged)

| File | Line | Summary |
|---|---|---|
| `pages/index/AppShell.module.css` | 376 | Unlocks `html`/`body` to natural page scroll and collapses `.v6App` to block flow for the phone-first stacked layout; sizes the mobile rail-toggle button (2.75rem touch target). |
| `pages/index/components/SessionWorkspace.module.css` | 1059 | Stacks `.v5-session-panels` into a column, neutralizes the fixed `--v5-aside-w` basis, and forces several nested flex containers to `display: block; height: auto` so content-sized stacking works on phones. |
| `pages/index/components/FeedTable.module.css` | 48 | Caps `.feedTableWrap` / transcribe / topics feed panels to `flex: 0 0 auto; max-height: 70vh/70dvh` so the feed scrolls internally instead of collapsing to 0 height. |
| `shared/theme/chrome.css` | 478 | Stacks `.header` into a column and sets a 2.75rem `min-height` touch-target floor on the app-wide `.btn`. |
| `pages/index/components/EventLogSheet.module.css` | 419 | Lets the rigid toolbar row (`.v5-event-feed-top`) wrap instead of overflowing the stacked panel width. |
| `pages/index/components/V6Rail.module.css` | 440 | Converts the rail into a fixed off-canvas drawer (`translateX(-100%)`, `width: min(82vw, 20rem)`, slide transition) and forces the collapsed-desktop label/shelf states back to fully visible. |

### `(hover: hover)` — 3 blocks (touch-safety guard)

| File | Line | Summary |
|---|---|---|
| `shared/theme/chrome.css` | 151 | Guards `.btn.danger:hover` background/border/color wash. |
| `shared/theme/chrome.css` | 286 | Guards `.btn:hover` border/color wash (app-wide default button). |
| `shared/theme/chrome.css` | 308 | Guards `.btn.primary:hover` border-color wash. |

(A fourth reference at `shared/theme/baseline.css:242` is a **comment**, not an actual `@media` block — it documents the hover-guard convention.)

### `(prefers-reduced-motion: reduce)` — 7 blocks

| File | Line | Summary |
|---|---|---|
| `pages/index/components/TransportControls.module.css` | 288 | Disables the `::before` hover-wash `transition` on session control buttons. |
| `pages/index/components/TransportControls.module.css` | 322 | Kills the `wfLabelPulse` animation on `.ytImportStatusLabel`, pins opacity to 0.85. |
| `pages/index/components/CategoryButtonStrip.module.css` | 102 | Disables the `cat-btn-momentary-press` animation on `.catBtnMomentaryPress`. |
| `pages/index/components/CategoryButtonStrip.module.css` | 389 | Disables the same momentary-press animation for the live-slot scoped variant. |
| `pages/index/components/Timeline.module.css` | 1286 | Disables the `v5TimelineMockShimmer` animation + resets `background-position` on `.timelineTrack::before`. |
| `pages/index/components/Timeline.module.css` | 1491 | Kills `wfLabelPulse` on `.timelineWaveformDecodingLabel`, pins opacity to 0.85. |

**Gap flagged:** `pages/index/AppShell.module.css:366` (`railScrimFade`), `pages/index/components/Timeline.module.css:316` (`marker-msg-marquee`), and all four Radix-wrapper entrance animations (`Toast.module.css`, `Dialog.module.css` ×3, `Popover.module.css`, `Tooltip.module.css`) have **no** `prefers-reduced-motion` guard.

## G. Hover inventory: guarded vs unguarded

**Total `:hover` occurrences: 70 (grep count). Distinct rules ≈ 65. GUARDED = 3 (all `.btn` variants in chrome.css:151/287/309). UNGUARDED = ~67 — every one needs the custom unguarded-hover variant to avoid touch-tap latch.**

### GUARDED (3 total — all in `shared/theme/chrome.css`)

| File | Line | Selector |
|---|---|---|
| `shared/theme/chrome.css` | 151 | `.btn.danger:hover` |
| `shared/theme/chrome.css` | 287 | `.btn:hover` |
| `shared/theme/chrome.css` | 309 | `.btn.primary:hover` |

### UNGUARDED per-file detail

**`shared/theme/chrome.css`** (4): 160 `.btn.danger:disabled:hover`; 295 `.btn:disabled:hover`; 315 `.btn.primary:disabled:hover`; 387 `.crumb a:hover`

**`pages/index/components/CategoryButtonStrip.module.css`** (6): 82 `.catBtn:hover`; 128 `.catBtnToggleArmed:hover`; 140 `.catBtnToggleOn:hover`; 145 `.catBtn:disabled:hover`; 249 `:global(.v4-cat-buttons__scroll) .catBtn:disabled:hover`; 354 `:global(#v4-log-session #cat-strip-live-slot) .catBtn:hover:not(:disabled)`

**`pages/index/components/EventButtonsTable.module.css`** (4): 68 `.presetBtn:hover`; 244 `.table tbody tr.btnRow:hover td:not(.colColorCell):not(.colDrag)`; 353 `:global(#modal-app-settings) .table .colNameWrap:hover .colName`; 368 `:global(#modal-app-settings) .table .colOptionsWrap:hover .colOptionsBtn:not(:disabled)`

**`pages/index/components/EventLogSheet.module.css`** (6 rule-groups / 9 tokens): 43 `.sheet tbody tr:hover td`; 114 `.sheet tbody tr:hover .rowHoverActions`; 221–223 batch-edit editable cells `:hover` (grouped); 264/268/272 `> td.colTcCellEdit/.sheetCatEdit/.sheetMsgCell:hover`

**`pages/index/components/FeedTable.module.css`** (4): 113 `.feedTh button:hover`; 128 `.feedRow:hover`; 256 `.feedGlassBtn:hover:not(:disabled)`; 272 `.feedGlassBtnPrimary:hover:not(:disabled)`

**`pages/index/components/HomeSettingsModal.module.css`** (3): 40 `.settings-dialog :global(.btn.primary:hover)`; 241 `.logoutBtn:hover`; 342 `.option:hover`

**`pages/index/components/MarkerNav.module.css`** (1): 78 `.v4-session-nav-btn:not(:disabled):hover`

**`pages/index/components/NewSessionModal.module.css`** (4): 74 `.v6-new-session-close:hover`; 90 `.new-session-dialog :global(.btn.primary:hover)`; 101 `.new-session-dialog :global(.btn:not(.primary):hover)`; 129 `.new-session-dialog [role="combobox"]:hover`

**`pages/index/components/RecentSessionsList.module.css`** (6): 52 `.v6-rail-session:hover`; 63 `.session-card--open-active:hover`; 91 `.session-card-link:hover`; 93 `.session-card--open-active .session-card-link:hover`; 188 `.v6-rail-session:hover .v6-rail-session__menu`; 193 `.v6-rail-session__menu:hover`

**`pages/index/components/Select.module.css`** (1): 27 `.trigger:hover:not([data-disabled])`

**`pages/index/components/SessionWorkspace.module.css`** (4): 874 `:global(#v4-log-session .v5-btn-export-log.btn.primary:hover)`; 963 `.v5FeedTab:hover:not(.v5FeedTabActive)`; 1039 `:global(.v4-log-session .btn:hover)`; 1049 `:global(.v4-log-session .btn.primary:hover)`

**`pages/index/components/Timeline.module.css`** (9): 229 `.timelineZoomRange .timelineZoomHandle:hover`; 506 `.timelineMarker:hover`; 526 `.timelineMarkerSelected:hover`; 801 `.v4ZoomRange button.v4ZoomHandle:hover`; 1400 `:global(#v4-log-session) .timelineMarker:hover`; 1410 `:global(#v4-log-session) .timelineMarkerSelected:hover`; 1523/1525/1543 perf-dbg marker-fx hover overrides

**`pages/index/components/TransportControls.module.css`** (5): 59 `.sessionCtlBtn:not(.isDisabled):hover`; 267/274/279 live-slot scoped ctrl-btn hovers; 284 `...:hover::before`

**`pages/index/components/V6Rail.module.css`** (4): 136 `.v6-rail-menu:hover`; 175 `.v6-rail-primary:hover`; 366 `.v6-rail-nav:hover`; 395 `.v6-rail-nav.v6-rail-nav--google-signin:hover`

**`shared/ui/Popover.module.css`** (2): 41 `.item:hover:not(:disabled)`; 62 `.itemDanger:hover:not(:disabled)`

**`shared/utils/perfDebug.module.css`** (2): 134 `.perf-debug-panel__actions button:hover`; 157 `.perf-debug-fab:hover`

## H. `!important` inventory (116 declarations)

- **`pages/index/AppShell.module.css` (9)**: lines 159–165, 171–173 — `.v6WorkspaceTopBarVoid` zero-height strip; comment line 152: "Beat `.v4-top-bar { min-height }`".
- **`pages/index/components/CategoryButtonStrip.module.css` (1)**: line 24 `.logFormHeading { margin-bottom: 0.35rem !important }` (no comment).
- **`pages/index/components/EventButtonsTable.module.css` (35)**: all inside `:global(#modal-app-settings) .table ...` — compact admin-table sizing; comment line 219: "Beat global `.profile-select` padding/margin"; comment line 340 re flat controls.
- **`pages/index/components/EventLogSheet.module.css` (6)**: 56 cursor pointer; 211/224 editable-cell background lock; 249/273 pending-delete background `#8d4545`; 258 pending-delete `#fff` text.
- **`pages/index/components/HomeSettingsModal.module.css` (1)**: 352 `.optionActive { z-index: 20 !important }`.
- **`pages/index/components/RecentSessionsList.module.css` (1)**: 94 hover/active `background: transparent !important`.
- **`pages/index/components/SessionWorkspace.module.css` (11)**: 108/126/133/143/175 `min-height: 0 !important` flex-chain; 170 `overflow: visible !important`; 602/622/625/628 transport-state display toggles (inline comments re UA `[hidden]` and V4 hide/show fights).
- **`pages/index/components/Timeline.module.css` (23)**: 881–885 nav-marker grid reset; 1386–1391 `.timelineClip*` fully hidden (legacy clips retired); 1500–1556 perf-debug override block (comment 1498: "perf-debug overrides (moved from perfDebug.module.css)").
- **`pages/index/components/TransportControls.module.css` (3)**: 260–262 `.isDisabled` border/background/shadow.
- **`shared/theme/baseline.css` (3)**: 293/298 audio-saving pointer-events lock + overlay exception; 302 `.hidden { display: none !important }`.
- **`shared/theme/bgGlow.css` (1)**: 39 perf-dbg `.v5-bg-glow { display: none !important }`.
- **`shared/utils/perfDebug.module.css` (4)**: 12/23/52/162 perf-debug toggles + `[hidden]` locks.

**Three rationale classes:** (1) specificity wars vs `:global()`/legacy selectors; (2) the perf-debug toggle system (~28 declarations — needs a dedicated highest-priority layer or `!` utilities); (3) undocumented one-off overrides (riskiest under layers).

## I. Keyframes + animation inventory

### Definitions
| File | Line | Name |
|---|---|---|
| `pages/index/AppShell.module.css` | 366 | `railScrimFade` |
| `pages/index/components/CategoryButtonStrip.module.css` | 86 | `cat-btn-momentary-press` |
| `pages/index/components/Timeline.module.css` | 316 | `marker-msg-marquee` |
| `pages/index/components/Timeline.module.css` | 1281 | `v5TimelineMockShimmer` |
| `pages/index/components/Timeline.module.css` | 1486 | `wfLabelPulse` (dup #1) |
| `pages/index/components/TransportControls.module.css` | 317 | `wfLabelPulse` (dup #2 — intentional; hash-scoped per module) |
| `shared/components/Toast.module.css` | 36 | `toastEnter` |
| `shared/ui/Dialog.module.css` | 65/74/163 | `overlayFadeIn` / `contentFadeIn` / `sheetSlideUp` |
| `shared/ui/Popover.module.css` | 71 | `popoverFadeIn` |
| `shared/ui/Tooltip.module.css` | 21 | `tooltipFadeIn` |

### Usages (guarded = wrapped in prefers-reduced-motion)
Guarded: CategoryButtonStrip 99/368; Timeline 1273 (shimmer), 1481 (wfLabelPulse); TransportControls 312.
Unguarded: AppShell 363 `railScrimFade`; Timeline 313 `marker-msg-marquee` (15s continuous — a11y concern); Toast 28; Dialog 11/27/94/115; Popover 14; Tooltip 13; SessionWorkspace 223 — **`animation: pulse 3.5s infinite` references a keyframe that does not exist anywhere (CSS Modules hash-scope keyframes): broken/no-op today — dead-rule candidate.**

**animate.css**: only TSX usage is `SessionWorkspace.tsx:248-249` (`animate__animated animate__pulse`), loaded from cdnjs in `pages/index/index.html` line ~15. Not an npm dep.

## J. Pseudo-element & exotic-selector inventory

### `::before`/`::after`
- tokens.css 126–127 + baseline.css 232–233: universal box-sizing resets (duplicated).
- baseline.css 276 `body::before`: film-grain noise overlay (opacity 0.055, z-index -1).
- Dialog.module.css 155 `.dragHandle::before`: bottom-sheet drag pill.
- Timeline.module.css 25 / 1256 / 1287 / 1378: track-line + shimmer pseudo-layers.
- TransportControls.module.css 164/284/293: accent-gradient hover-wash layer.
- SessionWorkspace.module.css 1006 `.v5FeedTabActive::before`: active-tab accent stripe.
- FeedTable.module.css 117/122: `' ↑'`/`' ↓'` sort glyphs via `content`.
- EventLogSheet.module.css 287/300/314: pending-delete strikethrough rules.

### Scrollbars
- CategoryButtonStrip.module.css 53/57 `::-webkit-scrollbar(-thumb)` (6px strip scrollbar).
- Timeline.module.css 363 `.timelineViewport::-webkit-scrollbar` (hidden).

### OverlayScrollbars
- FeedTable.module.css 33–37: `.feedTableWrap` is OS host (comment only).
- RecentSessionsList.module.css 237–248: `.v6-rail-sessions > [data-overlayscrollbars-viewport]` layout rules.

### Attribute selectors
- SessionWorkspace.module.css 396–397/414–415 `body[data-v4-transport="..."]` panel toggles; 621/624/627 `#v4-log-session[data-v5-live-log="1"]`.
- Timeline.module.css 502 `body[data-hide-internal="1"] .timelineMarker[data-cat="Internal" i]`.
- RecentSessionsList.module.css 47/189/194 `[data-menu-open]`/`[data-open]`.
- Select.module.css 27/36/40/45/58/105–106/111: Radix data-state styling.

### Combinators driving behavior
- baseline.css 262 `body > *` stacking context (z-index 1 over noise layer).
- RecentSessionsList 188 row-hover menu reveal; EventLogSheet 43/114 row-hover cells, 264–272 per-cell edit hover, 281–312 pending-delete `> td` overlays.

### `:focus-visible` (22 rules, all unconditional per baseline.css:244 convention)
baseline.css 249 global ring; Dialog 30/118; Popover 17/45; CategoryButtonStrip 108; EventButtonsTable 320/415; EventLogSheet 201/227; RecentSessionsList 92; Select 31; SessionWorkspace 974; Timeline 534/1427; TransportControls 185; V6Rail 137/176/367/402.


---

## K. Token rename table

Source: `web/src/shared/theme/tokens.css` (single `:root` block, 85 custom properties, lines 10–121).

| Current name | Line | Tailwind v4 `@theme` mapping | Notes |
|---|---|---|---|
| `--bg` | 10 | `--color-bg` | flat color |
| `--surface` | 11 | `--color-surface` | flat color |
| `--surface-raised` | 12 | `--color-surface-raised` | flat color |
| `--surface-btn` | 13 | `--color-surface-btn` | flat color |
| `--border` | 14 | `--color-border` | flat color |
| `--text` | 15 | `--color-text` | flat color |
| `--muted` | 16 | `--color-muted` | flat color |
| `--accent` | 17 | `--color-accent` | flat color |
| `--accent-dim` | 18 | `--color-accent-dim` | flat color |
| `--danger` | 19 | `--color-danger` | flat color |
| `--radius` | 20 | `--radius-app` | bare `--radius` can't keep its name inside the `--radius-*` namespace (it would collide with Tailwind's own bare `radius` utility slot); `--radius-app` names it after this being the legacy/base app radius. Alternative: `--radius-base`. |
| `--font` | 21 | `--font-sans` | **Collision**: this is the legacy base font stack, but Tailwind's `--font-*` namespace requires a suffix — there is no valid bare `--font`. Resolution: rename to `--font-sans` (matches Tailwind's own default-sans naming convention) and repoint the two dependents (`--font-poppins`'s `var(--font)` fallback, and anywhere consuming `--font` directly — none found, see Section L, 0 external consumers) to `var(--font-sans)`. |
| `--mono` | 22 | `--font-mono` | fits the namespace directly once renamed |
| `--font-poppins` | 24 | `--font-poppins` | already namespace-shaped; internal `var(--font)` reference becomes `var(--font-sans)` |
| `--font-league-gothic` | 25 | `--font-league-gothic` | already namespace-shaped |
| `--v5-bg` | 28 | `--color-v5-bg` | flat color; keep `v5-` prefix in the color name since it's a distinct dark-theme background from legacy `--bg` |
| `--v5-text` | 29 | `--color-v5-text` | flat color |
| `--v5-muted` | 30 | no namespace — stays `:root` | alpha rgba color (`rgba(229,238,252,0.55)`); Tailwind `--color-*` CAN technically hold rgba, so this is a borderline case — recommend `--color-v5-muted` since it's a standalone, independently-meaningful color value (not a compound). Flagged for gate decision if project wants a stricter "opaque only" rule. |
| `--v5-soft` | 31 | `--color-v5-soft` | flat color |
| `--v5-primary` | 32 | `--color-v5-primary` | flat color (highest-coupled token, 14 CSS files — see Section L) |
| `--v5-primary2` | 33 | `--color-v5-primary2` | flat color |
| `--v5-danger` | 34 | `--color-v5-danger` | flat color |
| `--v5-line` | 35 | `--color-v5-line` | alpha rgba color, same borderline case as `--v5-muted`; recommend `--color-v5-line` |
| `--v5-glass-top` | 37 | no namespace — stays `:root` | alpha rgba, but used ONLY as an internal input to `--v5-glass-face`/`-strong` gradients (zero external consumers, Section L). Keep as a private `:root` value feeding the compound `@utility` gradient. |
| `--v5-glass-bot` | 38 | no namespace — stays `:root` | same as above — internal-only gradient input |
| `--v5-glass-strong-top` | 39 | no namespace — stays `:root` | internal gradient input (feeds `--v5-glass-face-strong`/`-aside`); has 1 direct external CSS consumer too (SessionWorkspace.module.css) so must remain a real custom property, just not namespaced |
| `--v5-glass-strong-bot` | 40 | no namespace — stays `:root` | internal gradient input + 1 external consumer (Tooltip.module.css) |
| `--v5-glass-face` | 42–43 | no namespace — stays `:root`; **flagged for `@utility`** | compound multi-layer `linear-gradient(...)` stack referencing other tokens — destined for a `.glass-face` `@utility` class rather than a flat theme token |
| `--v5-glass-face-strong` | 44–45 | no namespace — stays `:root`; **flagged for `@utility`** | compound gradient stack — `@utility` candidate |
| `--v5-glass-face-aside` | 46–47 | no namespace — stays `:root`; **flagged for `@utility`** | compound gradient stack — `@utility` candidate |
| `--v5-glass-rim` | 48 | no namespace — stays `:root`; **flagged for `@utility`** | `inset 0 1px 0 rgba(...)` — single-layer but is a shadow *ingredient* combined into `--v5-panel-elevate`; treat as part of the glass/elevate `@utility` group rather than `--shadow-*` (it's never used alone as a full box-shadow — check Section L: 1 direct consumer, glass.module.css, where it's composed with the glow) |
| `--v5-border` | 49 | `--color-v5-border` | alpha rgba flat color (11 CSS consumers) |
| `--v5-border-strong` | 50 | `--color-v5-border-strong` | alpha rgba flat color (12 CSS consumers, tied-highest) |
| `--v5-shadow-glow` | 52–57 | no namespace — stays `:root`; **flagged for `@utility`** | multi-part compound `box-shadow` (5 comma-separated layers) — not a "simple single-purpose shadow"; `@utility .shadow-glow` candidate |
| `--v5-panel-elevate` | 58 | no namespace — stays `:root`; **flagged for `@utility`** | alias/compose of `--v5-shadow-glow` + `--v5-glass-rim` — compound, `@utility .panel-elevate` candidate |
| `--v5-radius-lg` | 59 | `--radius-v5-lg` | radius, namespace-safe |
| `--v5-radius-md` | 60 | `--radius-v5-md` | radius, namespace-safe (12 CSS consumers, tied-highest) |
| `--v5-radius-sm` | 61 | `--radius-v5-sm` | radius, namespace-safe (10 CSS consumers) |
| `--v5-aside-w` | 62 | no namespace — stays `:root` | layout dimension, no Tailwind theme namespace fits (not spacing scale, single-purpose width) |
| `--v5-panel-padding` | 63 | no namespace — stays `:root` | layout dimension |
| `--v5-panel-head-main-gap` | 64 | no namespace — stays `:root` | layout dimension |
| `--v5-timeline-lane-base` | 67 | no namespace — stays `:root` | `calc()` chain referencing `--v4-nav-grid-my`; internal-only (0 external consumers, Section L) |
| `--v5-timeline-lane-h` | 68 | no namespace — stays `:root` | `calc()` chain |
| `--v5-timeline-lane-delta` | 69 | no namespace — stays `:root` | `calc()` chain |
| `--v4-bar-h` | 75 | no namespace — stays `:root` | `--v4-*` layout dimension (all v4 tokens are bespoke pixel-matched layout values, not theme-scale spacing) |
| `--v4-rec-mr` | 76 | no namespace — stays `:root` | layout dimension |
| `--v4-search-mx` | 77 | no namespace — stays `:root` | layout dimension |
| `--v4-log-top-h` | 78 | no namespace — stays `:root` | layout dimension |
| `--v4-btn-area-pt` | 79 | no namespace — stays `:root` | layout dimension |
| `--v4-btn-area-px` | 80 | no namespace — stays `:root` | layout dimension |
| `--v4-grid-gap-y` | 81 | no namespace — stays `:root` | layout dimension |
| `--v4-cat-btn-w` | 82 | no namespace — stays `:root` | layout dimension |
| `--v4-cat-btn-h` | 83 | no namespace — stays `:root` | layout dimension |
| `--v4-ctrl-btn-w` | 84 | no namespace — stays `:root` | layout dimension |
| `--v4-ctrl-btn-h` | 85 | no namespace — stays `:root` | layout dimension |
| `--v4-ctrl-btn-my` | 86 | no namespace — stays `:root` | layout dimension |
| `--v4-session-nav-btn-w` | 87 | no namespace — stays `:root` | `calc()` chain (`var(--v4-ctrl-btn-w) * 2`) |
| `--v4-session-nav-btn-h` | 88 | no namespace — stays `:root` | `calc()` chain |
| `--v4-clock-box-h` | 89 | no namespace — stays `:root` | layout dimension |
| `--v4-clock-box-mb` | 90 | no namespace — stays `:root` | layout dimension; **0 external consumers** — internal-only (feeds `--v4-clock-box-mv`), dead-ish, flag for cleanup review |
| `--v4-clock-box-mv` | 91 | no namespace — stays `:root` | alias of `--v4-clock-box-mb` |
| `--v4-clock-inner-py` | 92 | no namespace — stays `:root` | layout dimension |
| `--v4-clock-inner-h` | 93 | no namespace — stays `:root` | `calc()` chain |
| `--v4-clock-label-straddle` | 94 | no namespace — stays `:root` | layout dimension |
| `--v4-radius-9` | 95 | `--radius-v4-9` | radius, namespace-safe (numeric suffix kept for parity with legacy design-spec naming) |
| `--v4-radius-10` | 96 | `--radius-v4-10` | radius, namespace-safe |
| `--v4-ext-row-h` | 97 | no namespace — stays `:root` | layout dimension |
| `--v4-tl-row-h` | 98 | no namespace — stays `:root` | layout dimension |
| `--v4-zoom-handle-w` | 99 | no namespace — stays `:root` | layout dimension |
| `--v4-zoom-handle-h` | 100 | no namespace — stays `:root` | layout dimension |
| `--v4-nav-edge-m` | 101 | no namespace — stays `:root` | layout dimension |
| `--v4-nav-area-h` | 102 | no namespace — stays `:root` | `calc()` chain |
| `--v4-nav-grid-my` | 103 | no namespace — stays `:root` | layout dimension; also consumed inside `--v5-timeline-lane-base`'s `calc()` |
| `--v4-tl-bar-ml` | 104 | no namespace — stays `:root` | layout dimension |
| `--v4-tl-bar-mr` | 105 | no namespace — stays `:root` | layout dimension |
| `--v4-tl-bar-h` | 106 | no namespace — stays `:root` | layout dimension |
| `--v4-icon-nav-back` | 107 | no namespace — stays `:root` | `url(...)` icon reference — not a Tailwind theme category |
| `--v4-icon-nav-next` | 108 | no namespace — stays `:root` | `url(...)` icon reference |
| `--z-rail-scrim` | 115 | no namespace — stays `:root` | z-index scale; Tailwind v4 has no dedicated `--z-*` `@theme` namespace (z-index isn't a first-class theme category) — keep as plain custom properties |
| `--z-rail-drawer` | 116 | no namespace — stays `:root` | z-index scale |
| `--z-dialog-overlay` | 117 | no namespace — stays `:root` | z-index scale |
| `--z-dialog-content` | 118 | no namespace — stays `:root` | z-index scale |
| `--z-popover` | 119 | no namespace — stays `:root` | z-index scale |
| `--z-top-float` | 120 | no namespace — stays `:root` | z-index scale |
| `--z-toast` | 121 | no namespace — stays `:root` | z-index scale |

**Collision flags:**
- `--font` (legacy base stack, line 21) vs the `--font-*` @theme namespace: bare `--font` has no valid home inside `--font-*`. **Resolution: rename to `--font-sans`.** Update the one internal reference (`--font-poppins: "Poppins", var(--font);` at line 24) to `var(--font-sans)`. Section L confirms `--font` itself has zero external CSS/TSX consumers, so this is a contained, low-risk rename — only `tokens.css` line 24 needs updating.
- `--radius` (legacy base radius, line 20) vs the `--radius-*` @theme namespace: same shape of collision. **Resolution: rename to `--radius-app`** (or `--radius-base`, pick one convention and apply consistently against `--v5-radius-*`/`--v4-radius-9/10` above). Section L: `--radius` has exactly 1 external consumer (`shared/theme/chrome.css`) that needs updating in the same commit as the rename.

**Compound tokens destined for `@utility` classes** (glass/shadow stacks, non-flat, multi-layer or multi-token composites — cannot be flattened into a single `@theme` value):
- `--v5-glass-face` (lines 42–43)
- `--v5-glass-face-strong` (lines 44–45)
- `--v5-glass-face-aside` (lines 46–47)
- `--v5-glass-rim` (line 48)
- `--v5-shadow-glow` (lines 52–57)
- `--v5-panel-elevate` (line 58, itself a composition of `--v5-shadow-glow` + `--v5-glass-rim`)

These six form one coherent "glass/elevate" utility group. Recommend a small set of `@utility` classes (e.g. `.glass-face`, `.glass-face-strong`, `.glass-face-aside`, `.panel-elevate`) defined in `shared/theme/glass.module.css` (already the primary consumer of most of these per Section L) rather than shipping them as bare `:root` custom properties consumed via inline `background:`/`box-shadow: var(--v5-panel-elevate)` declarations scattered across component CSS.

---

## L. Per-token consumer counts

Counts are **distinct files** referencing `var(--token)`, excluding `tokens.css` itself (which contains internal token-to-token references, e.g. `--v5-glass-face` → `var(--v5-glass-top)`). CSS paths are relative to `web/src`. TSX/TS counts only found matches in `pages/index/components/`; zero hits anywhere in `pages/admin-users/`, `shared/`, `api/`.

| Token | CSS files | TSX/TS files | TSX/TS files (named) |
|---|---|---|---|
| `--bg` | 2 | 0 | |
| `--surface` | 2 | 0 | |
| `--surface-raised` | 2 | 0 | |
| `--surface-btn` | 2 | 0 | |
| `--border` | 7 | 0 | |
| `--text` | 3 | 1 | `pages/index/components/EventLogRow.tsx` |
| `--muted` | 7 | 1 | `pages/index/components/NewSessionModal.tsx` |
| `--accent` | 5 | 2 | `pages/index/components/Timeline.tsx`, `pages/index/components/timeline/TimelineMarkers.tsx` |
| `--accent-dim` | 3 | 0 | |
| `--danger` | 3 | 0 | |
| `--radius` | 1 | 0 | |
| `--font` | 0 | 0 | (internal-only within tokens.css? no — literally zero references anywhere, including tokens.css itself outside its own definition; only `--font-poppins` references `var(--font)`) |
| `--mono` | 5 | 0 | |
| `--font-poppins` | 7 | 0 | |
| `--font-league-gothic` | 2 | 0 | |
| `--v5-bg` | 1 | 0 | |
| `--v5-text` | 12 | 0 | |
| `--v5-muted` | 9 | 0 | |
| `--v5-soft` | 2 | 0 | |
| `--v5-primary` | 14 | 0 | |
| `--v5-primary2` | 2 | 0 | |
| `--v5-danger` | 1 | 0 | |
| `--v5-line` | 1 | 0 | |
| `--v5-glass-top` | 0 | 0 | internal-only (feeds `--v5-glass-face`) |
| `--v5-glass-bot` | 0 | 0 | internal-only (feeds `--v5-glass-face`) |
| `--v5-glass-strong-top` | 1 | 0 | |
| `--v5-glass-strong-bot` | 1 | 0 | |
| `--v5-glass-face` | 2 | 0 | |
| `--v5-glass-face-strong` | 7 | 0 | |
| `--v5-glass-face-aside` | 1 | 0 | |
| `--v5-glass-rim` | 1 | 0 | |
| `--v5-border` | 11 | 0 | |
| `--v5-border-strong` | 12 | 0 | |
| `--v5-shadow-glow` | 1 | 0 | |
| `--v5-panel-elevate` | 6 | 0 | |
| `--v5-radius-lg` | 3 | 0 | |
| `--v5-radius-md` | 12 | 0 | |
| `--v5-radius-sm` | 10 | 0 | |
| `--v5-aside-w` | 1 | 0 | |
| `--v5-panel-padding` | 1 | 0 | |
| `--v5-panel-head-main-gap` | 2 | 0 | |
| `--v5-timeline-lane-base` | 0 | 0 | internal-only (feeds `--v5-timeline-lane-h`/`-delta`) |
| `--v5-timeline-lane-h` | 1 | 0 | |
| `--v5-timeline-lane-delta` | 1 | 0 | |
| `--v4-bar-h` | 2 | 0 | |
| `--v4-rec-mr` | 1 | 0 | |
| `--v4-search-mx` | 1 | 0 | |
| `--v4-log-top-h` | 1 | 0 | |
| `--v4-btn-area-pt` | 1 | 0 | |
| `--v4-btn-area-px` | 1 | 0 | |
| `--v4-grid-gap-y` | 1 | 0 | |
| `--v4-cat-btn-w` | 1 | 0 | |
| `--v4-cat-btn-h` | 2 | 0 | |
| `--v4-ctrl-btn-w` | 1 | 0 | |
| `--v4-ctrl-btn-h` | 1 | 0 | |
| `--v4-ctrl-btn-my` | 2 | 0 | |
| `--v4-session-nav-btn-w` | 1 | 0 | |
| `--v4-session-nav-btn-h` | 1 | 0 | |
| `--v4-clock-box-h` | 1 | 0 | |
| `--v4-clock-box-mb` | 0 | 0 | internal-only (feeds `--v4-clock-box-mv`) |
| `--v4-clock-box-mv` | 1 | 0 | |
| `--v4-clock-inner-py` | 1 | 0 | |
| `--v4-clock-inner-h` | 1 | 0 | |
| `--v4-clock-label-straddle` | 1 | 0 | |
| `--v4-radius-9` | 2 | 0 | |
| `--v4-radius-10` | 1 | 0 | |
| `--v4-ext-row-h` | 1 | 0 | |
| `--v4-tl-row-h` | 1 | 0 | |
| `--v4-zoom-handle-w` | 1 | 0 | |
| `--v4-zoom-handle-h` | 1 | 0 | |
| `--v4-nav-edge-m` | 1 | 0 | |
| `--v4-nav-area-h` | 1 | 0 | |
| `--v4-nav-grid-my` | 2 | 0 | |
| `--v4-tl-bar-ml` | 1 | 0 | |
| `--v4-tl-bar-mr` | 1 | 0 | |
| `--v4-tl-bar-h` | 1 | 0 | |
| `--v4-icon-nav-back` | 1 | 0 | |
| `--v4-icon-nav-next` | 1 | 0 | |
| `--z-rail-scrim` | 1 | 0 | |
| `--z-rail-drawer` | 1 | 0 | |
| `--z-dialog-overlay` | 1 | 0 | |
| `--z-dialog-content` | 1 | 0 | |
| `--z-popover` | 1 | 0 | |
| `--z-top-float` | 3 | 0 | |
| `--z-toast` | 1 | 0 | |

**Highest-coupled tokens**: `--v5-primary` (14 CSS files), `--v5-text` / `--v5-radius-md` / `--v5-border-strong` (12 each), `--v5-border` (11), `--v5-radius-sm` (10), `--v5-muted` (9).

**Zero-external-consumer tokens** (candidates for cleanup review, separate from the rename — confirm before dropping since some are internal-only feeders): `--font` (truly orphaned — not even internally referenced), `--v4-clock-box-mb` (internal-only, feeds `--v4-clock-box-mv`), `--v5-glass-top` / `--v5-glass-bot` (internal-only, feed `--v5-glass-face`), `--v5-timeline-lane-base` (internal-only, feeds `--v5-timeline-lane-h`/`-delta`).

**Only 3 tokens have any TSX/TS consumer**: `--text`, `--muted`, `--accent` — all as inline-style fallback values, detailed in Section M.

---

## M. TSX `var(--` consumers (exact)

Exhaustive sweep of `web/src/**/*.tsx` and `*.ts`. All 6 occurrences of `var(--...)` live under `web/src/pages/index/components/`; zero hits in `pages/admin-users/`, `shared/`, `api/`.

| File:Line | Token(s) | Context |
|---|---|---|
| `pages/index/components/EventLogRow.tsx:65` | `var(--text)` | Plain JS object (`msgStyle = { color: 'var(--text)' }`, later spread into a `style` prop) — fallback text color for non-`internal` log rows when the row has no category color. |
| `pages/index/components/NewSessionModal.tsx:239` | `var(--muted)` | Inline `style={{ fontSize: '0.85rem', color: 'var(--muted)' }}` on a `<span>` label ("Use YouTube publish date"). |
| `pages/index/components/timeline/TimelineMarkers.tsx:34` | `var(--accent)` | Plain JS inside `useMemo`: `const color = e.category_color || 'var(--accent)';` — fallback marker color, later assigned as the value of the dynamic custom property `--mcol` (see Section N) at line 53 of the same file. |
| `pages/index/components/Timeline.tsx:542` | `var(--accent)` | Plain JS inside a marker-glow computation: `best = { sec, col: String(e.category_color || '').trim() || 'var(--accent)' };` — fallback color, later passed to `el.style.setProperty('--marker-glow-col', best.col)` at line 550 of the same file. |

All four seed locations from the task prompt were verified with **no line-number drift**. No `var(` occurrences inside CSS-in-JS template literals or styled-component-like tags anywhere in `web/src`.

### Dynamic custom-property manipulation in TS/TSX (non-`var()` — sets and reads)

No `document.documentElement.style.setProperty(` calls exist anywhere in `web/src` — all custom-property writes are scoped to specific element refs or JSX inline-style objects, never global/root-level. No `getPropertyValue(` reads of any `--` property anywhere. `getComputedStyle(` appears exactly once (`pages/index/hooks/useZoomRail.ts:137`, reading the standard `width` property — unrelated to custom properties).

| File:Line | Property | Sets/Reads | Mechanism |
|---|---|---|---|
| `pages/index/components/Timeline.tsx:550` | `--marker-glow-col` | Sets | `el.style.setProperty('--marker-glow-col', best.col)` — imperative DOM write inside a `useEffect` marker-glow effect (also sets `opacity`/`left`/`transform` on the same element), re-runs on `[activeSec, totalSec, events, status]` changes. |
| `pages/index/components/Timeline.tsx:649` | `--nav-cat-col` | Sets | JSX computed-key style: `style={ currentNavMarker ? { ['--nav-cat-col' as string]: currentNavMarker.col } : undefined }` on the current-marker category pill. |
| `pages/index/components/Timeline.tsx:858` | `--tooltip-cat-col` | Sets | JSX computed-key style: `style={{ ['--tooltip-cat-col' as string]: markerTipCol }}` on the React-owned marker tooltip, positioned via `useLayoutEffect`. |
| `pages/index/components/EventLogRow.tsx:62` | `--log-row-accent` | Sets | Plain JS object `{ '--log-row-accent': color }` (from `event.category_color`), spread into the row's `style` prop. |
| `pages/index/components/MarkerNav.tsx:150` | `--v4-session-nav-border` | Sets | JSX computed-key style: `style={{ ['--v4-session-nav-border' as 'borderColor']: prevColor }}` on the "previous marker" button. |
| `pages/index/components/MarkerNav.tsx:168` | `--v4-session-nav-border` | Sets | Same pattern for the "next marker" button, value `nextColor`. |
| `pages/index/components/CategoryButtonStrip.tsx:307` | `--cat` | Sets | `style={{ '--cat': cat.color } as React.CSSProperties}` per-category toggle button. |
| `pages/index/components/timeline/TimelineMarkers.tsx:53` | `--mcol` | Sets | JSX computed-key style inside `.map()`: `{ left: \`${pct}%\`, ['--mcol' as string]: color }`, where `color` is the `var(--accent)`-fallback value from line 34. |

These 8 dynamically-set properties (`--marker-glow-col`, `--nav-cat-col`, `--tooltip-cat-col`, `--log-row-accent`, `--v4-session-nav-border`, `--cat`, `--mcol`, plus the read-only `var(--text/--muted/--accent)` fallbacks) are **not candidates for `@theme`** — they are per-instance runtime values driven by `event.category_color`. The migration must preserve every `setProperty`/computed-key call site and every `var(--token, fallback)` read in the corresponding CSS Modules (see Section N for the CSS-side consumers) untouched, since Tailwind's `@theme` sweep only targets the static tokens in `tokens.css`.

---

## N. Locally-defined custom properties (outside tokens.css)

These are defined either inside `*.module.css` component rules or set at runtime from TSX/TS. They are **component-local** and must **not** be swept into `@theme` — several names look like global tokens (`--v5-timeline-r`, `--cat`) or shadow the `--v4-*`/`--v5-*` prefix convention, which is the specific confusion this section exists to prevent.

### A. Defined in `*.module.css` (rule-scoped, not `:root` in `tokens.css`)

| File:Line | Property | Definition context | Known consumers |
|---|---|---|---|
| `pages/index/components/CategoryButtonStrip.module.css:63` | `--cat` | `.catBtn { --cat: #7cb7ff; ... }` (fallback default) | `var(--cat)` throughout the same file (borders, box-shadow, `color-mix`); overridden inline from `CategoryButtonStrip.tsx:307` |
| `pages/index/components/CategoryButtonStrip.module.css:329` | `--cat` | Second rule: `--cat: var(--v5-primary);` (variant override) | Same `var(--cat)` consumers |
| `pages/index/components/MarkerNav.module.css:27` | `--v4-session-nav-border` | `.v4-session-nav-btn { --v4-session-nav-border: transparent; ... }` (fallback) | `var(--v4-session-nav-border)` at line 35, same file; overridden inline from `MarkerNav.tsx:150,168` |
| `pages/index/components/MarkerNav.module.css:48` | `--v4-session-nav-icon-r` | `.v4-session-nav-hint { --v4-session-nav-icon-r: calc(1.05rem / 2); ... }` | Local geometry var, consumed later in same file |
| `pages/index/components/MarkerNav.module.css:49` | `--v4-session-nav-hint-r` | Same rule: `--v4-session-nav-hint-r: 0.225rem;` | Local geometry var, consumed later in same file |
| `pages/index/components/Timeline.module.css:448` | `--timeline-clip-strip-h` | `.timelineClip { --timeline-clip-strip-h: max(1px, 0.0625rem); ... }` | Same-rule height `calc()` |
| `pages/index/components/Timeline.module.css:461` | `--timeline-clip-strip-h` | `.timelineClipActive { --timeline-clip-strip-h: max(4px, 0.25rem); ... }` (override) | Same as above |
| `pages/index/components/Timeline.module.css:467` | `--timeline-clip-strip-h` | `.timelineClipMissingAudio { --timeline-clip-strip-h: max(4px, 0.25rem); ... }` (override) | Same as above |
| `pages/index/components/Timeline.module.css:1043` | `--v4-ext-row-pad-y` | `:global(#v4-log-session) { --v4-ext-row-pad-y: 0.22rem; ... }` | Feeds `--v4-zoom-rail-below-extra` calc, line 1044 |
| `pages/index/components/Timeline.module.css:1044` | `--v4-zoom-rail-below-extra` | Same rule: `calc(2 * (var(--v4-nav-grid-my) - var(--v4-ext-row-pad-y)))` | `var(--v4-zoom-rail-below-extra)` on `.v4TimelineZoomRail` padding-bottom, just below |
| `pages/index/components/Timeline.module.css:1244` | `--v5-timeline-r` | `.v4TlTrackLive .timelineTrack { --v5-timeline-r: 0.65rem; ... }` | `var(--v5-timeline-r)` in `border-radius`, same rule. **Looks like a global `--v5-*` token — it is NOT; it's locally scoped to this one selector.** |
| `pages/index/components/EventLogSheet.module.css:340` | `--v4-log-sheet-col-min` | `:global(.v4-log-sheet) { ... --v4-log-sheet-col-min: 10.5rem; ... }` | Feeds the 3 sibling vars below |
| `pages/index/components/EventLogSheet.module.css:341` | `--v4-log-col-tc-min` | Same rule, `var(--v4-log-sheet-col-min)` | Column-width consumer (`grid-template-columns`) elsewhere in file |
| `pages/index/components/EventLogSheet.module.css:342` | `--v4-log-col-event-min` | Same rule | Column-width consumer elsewhere in file |
| `pages/index/components/EventLogSheet.module.css:343` | `--v4-log-col-msg-min` | Same rule | Column-width consumer elsewhere in file |
| `pages/index/components/TransportControls.module.css:139` | `--session-ctl-accent` | Base rule: `--session-ctl-accent: var(--v5-primary);` (references a global token as its default) | `var(--session-ctl-accent)` in hover-wash `color-mix()` gradient, ~line 46–47 |
| `pages/index/components/TransportControls.module.css:192` | `--session-ctl-accent` | `.isSolidGrey.toneGreen { --session-ctl-accent: rgb(52, 211, 153); }` (state override) | Same consumer |
| `pages/index/components/TransportControls.module.css:202` | `--session-ctl-accent` | `.isSolidGrey.toneRed { --session-ctl-accent: #fb7185; }` | Same consumer |
| `pages/index/components/TransportControls.module.css:212` | `--session-ctl-accent` | `.isSolidGrey.toneGrey { --session-ctl-accent: #94a3b8; }` | Same consumer |
| `pages/index/components/TransportControls.module.css:220` | `--session-ctl-accent` | `.isSolidGrey.toneLight { --session-ctl-accent: #e2e8f0; }` | Same consumer |
| `pages/index/components/TransportControls.module.css:230` | `--session-ctl-accent` | `.isSolidGreen { --session-ctl-accent: #38bdf8; }` | Same consumer |
| `pages/index/components/TransportControls.module.css:244` | `--session-ctl-accent` | `.isSolidRed { --session-ctl-accent: #fb7185; }` | Same consumer |
| `pages/index/components/HomeSettingsModal.module.css:56` | `--v6-settings-toolbar-row-h` | Rule-scoped: `--v6-settings-toolbar-row-h: 2.5rem;` | Local layout var, consumed elsewhere in file |
| `pages/index/components/HomeSettingsModal.module.css:258` | `--v6-tab-panel-bg` | `.settingsPanel { --v6-tab-panel-bg: linear-gradient(165deg, ...); ... }` | Consumed elsewhere in same file |
| `pages/index/components/HomeSettingsModal.module.css:263` | `--v6-tab-panel-border` | Same rule: `rgba(255, 255, 255, 0.14)` | Consumed elsewhere in same file |
| `pages/index/components/HomeSettingsModal.module.css:264` | `--v6-tab-inactive-bg` | Same rule: `linear-gradient(180deg, ...)` | Consumed elsewhere in same file |
| `pages/index/components/HomeSettingsModal.module.css:269` | `--v6-tab-overlap` | Same rule: `0.55rem` | Consumed elsewhere in same file |
| `pages/index/components/EventButtonsTable.module.css:183` | `--v6-events-row-h` | `.table { --v6-events-row-h: 1.5rem; ... }` | Local row-height var, consumed elsewhere in file |
| `pages/index/components/EventButtonsTable.module.css:184` | `--v6-events-head-h` | Same rule: `1.5rem` | Local var, consumed elsewhere in file |
| `pages/index/components/V6Rail.module.css:17–33` | `--v6-rail-w-expanded`, `--v6-rail-w-collapsed`, `--v6-rail-pad-collapsed-x`, `--v6-rail-pad-collapsed-y`, `--v6-rail-collapsed-inner`, `--v6-rail-pad`, `--v6-rail-btn-h`, `--v6-rail-btn-pad-x`, `--v6-rail-gap`, `--v6-rail-gap-sm`, `--v6-rail-ease`, `--v6-rail-dur`, `--v6-rail-recent-shelf-max-h`, `--v6-rail-recent-shelf-mt`, `--v6-rail-recent-shelf-pad`, `--v6-rail-recent-shelf-radius`, `--v6-rail-recent-shelf-bg` (16 vars) | A **module-scoped `:root { ... }` block inside `V6Rail.module.css`** — not the shared `tokens.css` `:root`. CSS Modules hashing does not touch `:root`, so this behaves like a private mini-token-set for the rail component only. | All consumed via `var(--v6-rail-*)` later in the same file (`--v6-rail-collapsed-inner` self-references `--v6-rail-w-collapsed`/`--v6-rail-pad-collapsed-x` in its own `calc()`). **A naive `grep :root` sweep for the `@theme` migration would wrongly scoop these up as global tokens — they must be excluded.** |

### B. Set dynamically at runtime from TSX (inline style objects / `setProperty`)

(Cross-referenced with Section M — these are the same call sites, repeated here with their CSS-side consumers for completeness.)

| File:Line | Property | Assigned expression | Consumed via |
|---|---|---|---|
| `pages/index/components/Timeline.tsx:550` | `--marker-glow-col` | `el.style.setProperty('--marker-glow-col', best.col)` — category color or `'var(--accent)'` fallback | `Timeline.module.css:615–629` (`box-shadow` glow via `color-mix(in srgb, var(--marker-glow-col, var(--accent)) ...)`) and `Timeline.module.css:1415` |
| `pages/index/components/EventLogRow.tsx:62` | `--log-row-accent` | `{ '--log-row-accent': color }` from `event.category_color`, applied to `<tr>` (line 295) | **No consumer found anywhere** — no `var(--log-row-accent)` in any CSS file, including `EventLogSheet.module.css` (the module this component imports). **Appears orphaned/dead** — flag for removal or explicit exclusion rather than silent carry-over. |
| `pages/index/components/MarkerNav.tsx:150` | `--v4-session-nav-border` | `prevColor` (`colorOf(prevEvent)` or `'transparent'`) | `MarkerNav.module.css:35` |
| `pages/index/components/MarkerNav.tsx:168` | `--v4-session-nav-border` | `nextColor` | `MarkerNav.module.css:35` |
| `pages/index/components/CategoryButtonStrip.tsx:307` | `--cat` | `cat.color` | `CategoryButtonStrip.module.css` (many `var(--cat)` usages; module-level fallback defaults at lines 63, 329) |
| `pages/index/components/Timeline.tsx:649` | `--nav-cat-col` | `currentNavMarker.col` | `Timeline.module.css:286, 840, 1176, 1177` (`color-mix(in srgb, var(--nav-cat-col, <fallback-hex>) ...)`) |
| `pages/index/components/Timeline.tsx:858` | `--tooltip-cat-col` | `markerTipCol` | `Timeline.module.css:561` (`color: var(--tooltip-cat-col, #bfc5cd);`) |
| `pages/index/components/timeline/TimelineMarkers.tsx:53` | `--mcol` | `color` (= `e.category_color \|\| 'var(--accent)'`) | `Timeline.module.css:493, 510–513, 520–523, 528–531, 1397, 1402, 1407, 1411` (marker fill + multi-layer glow `box-shadow` via `color-mix(in srgb, var(--mcol) ...)`) |

### Summary — do not sweep into `@theme`

**25 locally-scoped property names** total (17 distinct `*.module.css`-defined names + 16 `V6Rail.module.css` `:root` names, with `--cat` and `--v4-session-nav-border` counted once each despite multiple definition sites, minus overlaps) plus the runtime-only quintet (`--marker-glow-col`, `--nav-cat-col`, `--tooltip-cat-col`, `--mcol`, `--log-row-accent`). Two specific traps for the migration:

1. **`--v5-timeline-r`** (`Timeline.module.css:1244`) — prefixed like a global `--v5-*` theme token but is locally scoped/redefined inside one component selector. Do not conflate with genuine `--v5-*` entries in `tokens.css` (Section K).
2. **`V6Rail.module.css`'s `:root { ... }` block** (lines 16–33) — a second, module-local "mini token set" hiding under a `:root` selector. A naive `grep -r ":root"` sweep for `@theme` candidates would incorrectly capture these 16 rail-only vars as global tokens.

Additionally, **`--session-ctl-accent`** (`TransportControls.module.css`) is a case where a local override *defaults to* a global token (`var(--v5-primary)`) but is itself component-scoped state (tone/color variants) — keep local, do not merge into `@theme`.
