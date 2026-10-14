# Design

## Context

See proposal.md for why. The pieces today:
- `initPerfDebugUI()` (`web/src/shared/utils/perfDebug.ts`) is called once from `AppShell`'s mount effect. It builds the `#perf-debug-fab` button and `#perf-debug-panel` with DOM calls, outside React.
- The panel's toggles add `body.perf-dbg--*` classes, which only the "PERF-DEBUG" section of `shared/theme/tailwind.css` reads.
- Its transport radios write `autologger:debugSessionTransport` and fire a window event. `useDebugTransportOverride()` reads that value, and `SessionWorkspace` computes `effectiveTransport = debugOverride ?? intrinsicState`.

## Goals / Non-Goals

**Goals:**
- No code, CSS or test path left for the tool.
- The transport state comes only from `intrinsicState`.
- A guard keeps it from coming back.

**Non-Goals:**
- Renaming or removing the timeline class literals the perf rules also targeted. `.timelineMarker` is still read by the hide-internal rule. The rest (`v4TlTrackLive`, `timelineShell`, `timelineTrack`, `timelineWaveforms`, `timelineMarkerPlayheadGlow`) have no CSS reader left, which is harmless. Pruning them is a separate cleanup.

## Decisions

- **Delete rather than hide behind a flag.** The owner wants it gone; a dev-only flag would keep the CSS, the hook and the test mocks alive for no user.
- **Drop the Settings `pr-16` reservation.** Its own comments say it exists only to keep Save clear of the button. The two layout tests that assert it flip to assert its absence, so the space doesn't come back unnoticed.
- **Keep the PLAY coverage on the real path.** `SessionWorkspace.maximizeLog.test.tsx` "reads PLAY in playback" forced playback through the override. It now has the mocked `AudioPlayer` call its `onPlayingChange(true)` prop, which is how `SessionWorkspace` learns of playback (`onPlayingChange={setIsPlaying}`).
- **Drop the flat-fallback assertions with the fallback.** `contrastTokens.test.ts` "the waveform progress is the accent, with no sky-blue stops" also asserts that the only `.timelineWaveformProgress {` rule in `tailwind.css` uses `var(--tx-wave-progress)`. That rule is the panel's "no waveform gradients" fallback, inside the section being removed. The test keeps its `TimelineWaveform.tsx` assertions (no sky-blue stops; `WAVEFORM_PROGRESS` uses the accent token) and drops the two `perf` lines, because their subject is gone.
- **Guard with a repo test.** A small `web/src` scan fails if `perf-dbg`, `perfDebug`, `perf-debug` or `DebugTransport` reappears, following the repo-test pattern already used under `web/src/*.repo.test.ts`. It excludes only itself. The AppShell "no performance-debug control" test avoids the guarded strings: it queries for a button named `Perf` and for any element whose id starts with `perf`.
- **Leave the stale localStorage keys.** Nothing reads them afterwards. Clearing them would add code for a dead key.

## Assumptions (each tested)

- **A1: the UI is initialised only from AppShell.**
  - `grep -rn "initPerfDebugUI(" web/src --include=*.ts --include=*.tsx | grep -v "\.test\.\|utils/perfDebug.ts"`
  - → `web/src/pages/index/AppShell.tsx:194:    initPerfDebugUI();`
- **A2: only SessionWorkspace consumes the override.**
  - `grep -rln "useDebugTransportOverride()" web/src | grep -v test`
  - → `SessionWorkspace.tsx` and the hook file itself.
  - `grep -n debugOverride …SessionWorkspace.tsx` → `:109 const debugOverride = useDebugTransportOverride();` and `:130 const effectiveTransport = debugOverride ?? intrinsicState;`
- **A3: only `tailwind.css` reads the `perf-dbg--*` classes.**
  - `grep -rln "perf-dbg--" web/ | grep -v node_modules`
  - → `web/src/shared/theme/tailwind.css` and `perfDebug.ts`, plus build output under `web/.next/` (generated).
- **A4: nothing outside `web/src` references the tool.**
  - `grep -rln "perf-debug\|perfDebug\|perf-dbg" test companion server packages docker`
  - → no output.
- **A5: the timeline class literals have other consumers.**
  - `grep -n "\.timelineMarker" web/src/shared/theme/tailwind.css | grep -v perf-dbg`
  - → `:851 body[data-hide-internal='1'] .timelineMarker[data-cat='Internal' i]`. There is no e2e suite (`ls test` → `pg`). The literals stay as a non-goal.
- **A6: `pr-16` exists only for the button.**
  - `SidePanel.tsx:173-174`: "`pr-16` keeps the actions clear of the bottom-right corner, where the perf-debug toggle … sits"
  - `settingsParts.tsx:126` says the same.
- **A7: the shape-guard exemption must go with the file.**
  - `apiResponseShapes.repo.test.ts:1281-1282`: "Entries are consumed one per matching site … a surplus entry is reported as stale."
- **A8: no spec requirement besides the one modified mentions the tool.**
  - `grep -rn -i "perf.debug\|perfDebug\|debugSessionTransport" openspec/specs`
  - → only `web-session-console/spec.md:1398`.
- **A9: the PLAY state is still covered elsewhere.**
  - `grep -rn "'PLAY'" web/src --include=*.test.tsx`
  - → `TopBar.test.tsx:232` and `MaximizeLogStrip.test.tsx:119` cover the label mapping. The rewritten `SessionWorkspace` test covers the wiring.

- **Behaviour change: loading videos present at AppShell mount stay frozen.**
  - `initPerfDebugUI()` always ran `syncVideoPauseWithState()`. With no flag set, that calls `play()` on every `video.autologger-loading-video__media` in the document (`perfDebug.ts:117-145`).
  - It ran right after `freezeAutologgerLoadingVideos(document)` (`AppShell.tsx:193-194`), which removes autoplay and loop and pauses each video at its first frame (`loadingVideo.ts:6-37`).
  - So today, a loading video already in the DOM when AppShell mounts is frozen and then played once. After this change it stays frozen, which is what `freezeAutologgerLoadingVideos` is for. Videos mounted later were never touched by either.
  - The panel also removed a `v5-glass-native-backdrop` body class. `grep -rn v5-glass-native-backdrop web/src` finds no other writer or reader.
  - This is a visible side effect for the owner to accept at approval. Task 3.2 checks the loading states in the browser.

## Risks / Trade-offs

- **[Risk] Someone used the override to preview tints without recording.** → They can play the session's recorded audio, or roll the timecode. The owner says the tool isn't needed.
- **[Risk] A CSS rule removed with the section was also styling something live.** → Every selector in the section is prefixed by `body.perf-dbg--*` or `.perf-debug-*` (A3). The agent-browser pass compares the session view before and after.
