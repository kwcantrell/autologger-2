# Remove the Perf debug menu

Tier: 1
Tier reason: a web-only removal of a debug tool that stays inside existing contracts (no API, schema, auth or high-risk path); it modifies one web-session-console requirement, which names the tool's transport override.

Approved-by: Kalen 2026-10-14

## Why

Every build shows a **Perf** button in the bottom-right corner that opens a performance-debug panel. It served A/B checks during the Tailwind migration and is no longer needed (owner, 2026-10-14). It sits over page content, Settings reserves space for it, and the spec still requires the shell's transport tint to follow its override.

## What Changes

- The **Perf** button and its panel are removed from every route and every build.
- The panel's seven `body.perf-dbg--*` effect toggles and their CSS rules are removed.
- The panel's **session transport override** is removed. The shell's transport tint and status label follow only the real sources (recording lease, rolling timecode, local playback). Any value the panel saved in browser storage is ignored.
- Settings no longer reserves right-hand space for the button; the actions row sits flush right.

## Non-goals

- Other debug or developer tooling, such as the hide-internal-markers rule. The timeline class names on the JSX stay, even those no CSS reads once the perf rules go.
- Clearing the stale localStorage keys the panel wrote (`autologger:perfDebugV1`, `autologger:debugSessionTransport`). Nothing reads them after this change.
- Historical docs (`docs/reviews/`, `docs/superpowers/`), which record past work.
- Any other visual or layout change, apart from the loading-video side effect named in design.md.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `web-session-console`: "Transport state tints the shell" drops the performance-debug transport override.

## Impact

- **Web:**
  - removes `web/src/shared/utils/perfDebug.ts` and `web/src/shared/hooks/useDebugTransportOverride.ts`;
  - edits `AppShell.tsx` (no init call), `SessionWorkspace.tsx` (no override), `shared/theme/tailwind.css` (the perf-debug section), and the Settings `SidePanel.tsx` and `settingsParts.tsx` (no `pr-16`);
  - comment-only edits in the timeline components.
- **Tests:**
  - drops the mocks of the removed modules;
  - rewrites the one test that used the override to drive real playback;
  - flips the `pr-16` assertions;
  - drops the `perfDebug.ts` exemption from `apiResponseShapes.repo.test.ts`;
  - adds a guard test that the tool does not come back.
- **Docs:** one README phrase.
- **No server, contract, database or dependency change.**
