# Tasks

## 1. Baseline

- [ ] 1.1 Record the baseline: web `npm test` passes, and the inventory grep `grep -rn "perf-dbg\|perfDebug\|perf-debug\|DebugTransport" web/src README.md` lists the expected files. Verified by both outputs.

## 2. Remove the menu and the override (tests first)

- [ ] 2.1 Write the failing tests first:
  - an `AppShell.test.tsx` case "renders no performance-debug control": after mount there is no button named `Perf` and no element whose id starts with `perf`. It uses no guarded string;
  - `web/src/perfDebugRemoved.repo.test.ts`: no file under `web/src` (excluding that test) contains `perf-dbg`, `perfDebug`, `perf-debug` or `DebugTransport`.

  Verified failing, then passing, by `npx vitest run src/pages/index/AppShell.test.tsx src/perfDebugRemoved.repo.test.ts`.
- [ ] 2.2 Rewrite `SessionWorkspace.maximizeLog.test.tsx` "reads PLAY in playback, as the top bar does" so the mocked `AudioPlayer` calls `onPlayingChange(true)`, with no override. Verified passing before and after removal by the same file.
- [ ] 2.3 Remove the code:
  - delete `perfDebug.ts` and `useDebugTransportOverride.ts`;
  - drop the call in `AppShell.tsx` and the hook in `SessionWorkspace.tsx`;
  - remove the "PERF-DEBUG" section of `tailwind.css`;
  - drop the removed modules' `vi.mock` blocks (six `SessionWorkspace.*` tests, `AppShell.test.tsx`, `AppShell.onboarding.test.tsx`, `departureWatcher.test.tsx`);
  - drop the `perfDebug.ts` exemption in `apiResponseShapes.repo.test.ts`;
  - drop the two flat-fallback assertions (`perf`) from `contrastTokens.test.ts` "the waveform progress is the accent, with no sky-blue stops", keeping its `TimelineWaveform.tsx` assertions.

  Verified by web `npm run typecheck` and `npx vitest run`.
- [ ] 2.4 Drop the Settings `pr-16` reservation in `SidePanel.tsx` and `settingsParts.tsx`, flipping `SidePanel.test.tsx` and `AccountSection.test.tsx` to assert it is absent (failing first). Verified by those two files.
- [ ] 2.5 Reword the comments that cite perf-debug:
  - the timeline components, `FeedShell.tsx`, `SessionWorkspace.tsx`, `AppShell.tsx`, `contrastTokens.test.ts`, `types/css-modules.d.ts`, and the `tailwind.css` comment that still names the perf-debug section;
  - the README `components` layer phrase.

  Verified by the inventory grep returning nothing, and by the 2.1 guard.

## 3. Verify

- [ ] 3.1 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh` and `openspec validate --all --strict`. Verified by every gate passing.
- [ ] 3.2 Run the dev stack with agent-browser at 1440 and 390 px:
  - no Perf button on `/`, a session, `/wiki`, `/search` or Settings;
  - Settings actions sit flush right;
  - the transport label reads PLAY while audio plays;
  - the loading states (route loading, session loading) show the frozen first frame and nothing else changes.

  Verified by screenshots and DOM queries.
- [ ] 3.3 Open the PR, and confirm CI is green on it. Verified by the PR's check status.
