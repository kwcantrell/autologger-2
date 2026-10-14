# Tasks

## 1. Baseline

- [x] 1.1 Record the baseline: web `npm test` passes, and the inventory grep `grep -rn "perf-dbg\|perfDebug\|perf-debug\|DebugTransport" web/src README.md` lists the expected files. Verified by both outputs.
  Evidence: `cd web && npx vitest run` on `7d24fb8e` → `Test Files  164 passed (164)` / `Tests  2195 passed (2195)`; `grep -rln "perf-dbg\|perfDebug\|perf-debug\|DebugTransport" web/src README.md` → 27 files (perfDebug.ts, the hook, AppShell, SessionWorkspace and six of its tests, tailwind.css, Settings, timeline comments, README …).

## 2. Remove the menu and the override (tests first)

- [x] 2.1 Write the failing tests first:
  - an `AppShell.test.tsx` case "renders no performance-debug control": after mount there is no button named `Perf` and no element whose id starts with `perf`. It uses no guarded string;
  - `web/src/perfDebugRemoved.repo.test.ts`: no file under `web/src` (excluding that test) contains `perf-dbg`, `perfDebug`, `perf-debug` or `DebugTransport`.
  Verified failing, then passing, by `npx vitest run src/pages/index/AppShell.test.tsx src/perfDebugRemoved.repo.test.ts`.
  Evidence: before removal, `npx vitest run src/pages/index/AppShell.test.tsx src/perfDebugRemoved.repo.test.ts …` → `× finds zero references outside this guard`, `× renders no performance-debug control`; after 2.3–2.5 the full web run (`rpd-web.log`) → `Tests  2197 passed (2197)` (+2: these two).
- [x] 2.2 Rewrite `SessionWorkspace.maximizeLog.test.tsx` "reads PLAY in playback, as the top bar does" so the mocked `AudioPlayer` calls `onPlayingChange(true)`, with no override. Verified passing before and after removal by the same file.
  Evidence: the rewritten test (hoisted `audioPlayer.playing` flag; the `AudioPlayer` mock calls `onPlayingChange(true)` from an effect; reset in `beforeEach`) passed in the pre-removal run (only the 4 new/flipped tests failed: `Tests  4 failed | 89 passed (93)`) and passes after removal (`rpd-web.log`: `Tests  2197 passed`).
- [x] 2.3 Remove the code:
  - delete `perfDebug.ts` and `useDebugTransportOverride.ts`;
  - drop the call in `AppShell.tsx` and the hook in `SessionWorkspace.tsx`;
  - remove the "PERF-DEBUG" section of `tailwind.css`;
  - drop the removed modules' `vi.mock` blocks (six `SessionWorkspace.*` tests, `AppShell.test.tsx`, `AppShell.onboarding.test.tsx`, `departureWatcher.test.tsx`);
  - drop the `perfDebug.ts` exemption in `apiResponseShapes.repo.test.ts`;
  - drop the two flat-fallback assertions (`perf`) from `contrastTokens.test.ts` "the waveform progress is the accent, with no sky-blue stops", keeping its `TimelineWaveform.tsx` assertions.
  Verified by web `npm run typecheck` and `npx vitest run`.
  Evidence: `git rm` perfDebug.ts and useDebugTransportOverride.ts; tailwind.css lines 856–1092 deleted; mocks dropped in 6 SessionWorkspace tests + AppShell.onboarding + departureWatcher; exemption and the two `perf` assertions dropped. `npm run typecheck` → `tsc --noEmit` with no errors; `npx vitest run` → `Test Files  165 passed (165)` / `Tests  2197 passed (2197)`.
- [x] 2.4 Drop the Settings `pr-16` reservation in `SidePanel.tsx` and `settingsParts.tsx`, flipping `SidePanel.test.tsx` and `AccountSection.test.tsx` to assert it is absent (failing first). Verified by those two files.
  Evidence: pre-removal run → `× sits flush right, with no reserved bottom-right corner`, `× keeps the save bar's action flush right, with no reserved bottom-right corner`; after dropping `pr-16` both pass (`rpd-web.log`: `Tests  2197 passed`).
- [x] 2.5 Reword the comments that cite perf-debug:
  - the timeline components, `FeedShell.tsx`, `SessionWorkspace.tsx`, `AppShell.tsx`, `contrastTokens.test.ts`, `types/css-modules.d.ts`, and the `tailwind.css` comment that still names the perf-debug section;
  - the README `components` layer phrase.
  Verified by the inventory grep returning nothing, and by the 2.1 guard.
  Evidence: `grep -rn "perf-dbg\|perfDebug\|perf-debug\|DebugTransport\|perf override" web/src README.md | grep -v perfDebugRemoved.repo.test.ts` → no output; the 2.1 guard passes.

## 3. Verify

- [x] 3.1 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh` and `openspec validate --all --strict`. Verified by every gate passing.
  Evidence: `rpd-check.log` (`GITHUB_BASE_REF=supabase-migration scripts/check-change.sh`): every gate PASS except `tasks` (then open), including `tests-with-code  15 source / 15 test file(s)` and `commands  ran ['typecheck', 'test']`; `openspec validate --all --strict` → `Totals: 32 passed, 0 failed (32 items)`. `npx biome check web/src` reports one pre-existing error in `wiki/WikiRoute.tsx:326` (useExhaustiveDependencies), identical on the base branch; lint isn't a configured gate.
- [x] 3.2 Run the dev stack with agent-browser at 1440 and 390 px:
  - no Perf button on `/`, a session, `/wiki`, `/search` or Settings;
  - Settings actions sit flush right;
  - the transport label reads PLAY while audio plays;
  - the loading states (route loading, session loading) show the frozen first frame and nothing else changes.
  Verified by screenshots and DOM queries.
  Evidence: agent-browser on localhost:8787. At 1440 and 390, `/`, a session, `/wiki`, `/search` and Settings all report `0 0` for `[id^=perf]` and Perf/Hide buttons. On session ATS_0098, clicking "Play or pause audio" → `PLAY / topbar: PLAY`. Settings at both widths → `saves=1 gap=0 pr16=false perf=0` (screenshot `rpd-settings-390.png`: "Saved" flush right). Loading states: sampling `video.autologger-loading-video__media` four times during a session load → `none` each time, so the transient loading video couldn't be caught; per design.md, videos mounted after AppShell were never touched by the removed code.
- [ ] 3.3 Open the PR, and confirm CI is green on it. Verified by the PR's check status.
