# shadcn foundation: init shadcn (Radix) themed as V5, enable Preflight, clear baseline AA failures

Tier: 1
Tier reason: web-only UI infrastructure inside existing contracts. It touches no `high_risk_paths`, wire format, auth or data. The shadcn MCP entry in `.mcp.json`, which is agent tooling, is split into a separate change.

Approved-by: Kalen 2026-10-06

## Why

Every web primitive is hand-built. There's no shared Button, Tabs, Table or Field. Toasts and charts are bespoke, and five Radix wrappers sit next to per-file clsx styling. The owner wants every UI component to come from shadcn, reusing registry components (`@shadcn`, `@ai-elements`) wherever they exist. This first change lays the foundation that the later changes build on: shared wrappers, surface ports, and the AI SDK stream. It also clears every AA contrast failure that the Phase 0 baseline probe found on theme-styled text (`qa/README.md`). `web-ui-system` already forbids these failures.

## What Changes

- Initialize shadcn in `web/` with a hand-written `components.json`:
  - Radix base, CSS variables, `iconLibrary: lucide`.
  - Registries `@shadcn` and `@ai-elements`.
  - Aliases under the existing `@/shared/*` path: components in `@/shared/components/ui`, `cn()` in `@/shared/lib/utils`.
- Add dependencies: `tailwind-merge`, `class-variance-authority`, `lucide-react`, `tw-animate-css`, `radix-ui`, `vaul` and `sonner`.
  - Not added: the npm `cn` package and `next-themes`. The registry pulls them in, but generated files are rewritten to use the local `cn` and a fixed dark theme. A guard test keeps them out.
- Rename the legacy `--border`, `--muted` and `--accent` tokens, and their `--color-*` twins, to `--legacy-*`, and update every consumer. This frees those names for shadcn's semantic tokens without silently repainting legacy surfaces.
- Turn on Tailwind Preflight in `web/src/shared/theme/tailwind.css`, and delete the redundant universal `box-sizing` rule. Fonts, the body baseline, the background glow and the toggle hooks stay. Any element that relied on browser defaults gets explicit utilities.
- Map the V5 palette onto the full shadcn semantic token set in a single dark `:root`, exposed through `@theme inline`. There's no `.dark` class and no light theme. shadcn's `dark:` variants are folded into the base classes.
- Add these shadcn primitives, unused by product code in this change:
  - button, input, textarea, label, field, select, tabs, table
  - card, badge, alert, skeleton, separator, empty, spinner
  - tooltip, popover, dropdown-menu, radio-group
  - dialog, drawer, alert-dialog, sonner, scroll-area
  - `chart` is deferred to change 3d (see Non-goals).
- Restyle `Button`'s cva variants to the V5 vocabulary: glass face, uppercase tracked label, sky-tinted primary, red-tinted destructive. Disabled shows reduced opacity, muted text and no hover response.
- Clear the baseline AA failures (see `qa/README.md`):
  - **Muted text:** alpha raised 0.55 → 0.62. This fixes the recent-session details and duration, the dialog close `×` buttons, and the "AI Rules" label once that label uses the muted token.
  - **Placeholders:** floor raised 0.55 → 0.62.
  - **Timeline total duration:** its extra 0.82 opacity is removed.
  - **Primary labels:** the sky label in `BTN_PRIMARY_SKY` (`shared/theme/classnames.ts`) becomes `#e0f2fe`. The sky tint stays on the background and border.
  - **Login link:** the "Create an account with Google" secondary link gets its own 0.78-alpha label.
- QA artifacts: `qa/.gitignore` keeps PNGs out of the artifacts-first commit, and the root `.gitignore` covers later changes. `qa/screens.sh` (the walk), `cap.sh`, `contrast.js` and `*.contrast.json` stay tracked.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `web-ui-system`:
  - **"Single V5 component vocabulary"** gains one new obligation: "A shared component layer that new surfaces build on SHALL render this same vocabulary by default". It also gains a scenario for the shared-layer button.
  - **"AA contrast floor on rendered surfaces"** names more surfaces: recent-session details, timeline total duration, event-button secondary actions, primary button labels, dialog close buttons and the login secondary link. It updates the reference values (muted and placeholder 0.55 → 0.62). It adds a scenario for each surface.
  - **Change the approver must decide on:** the AA requirement gains the sentence "Disabled controls are exempt (WCAG 1.4.3 incidental text)". The current spec has no exemption. This narrows the floor to match WCAG and what the probe measures, so disabled buttons such as `SAVED` (2.02:1) don't count as failures. If you reject this, the sentence is dropped and disabled labels must reach 4.5:1 too, which adds those fixes to this change.

## Non-goals

- Porting any existing component or consumer to the new primitives. That's changes 2 and 3.
- Changing the shared wrappers in `shared/ui/*`, `Select.tsx` or `Toast.tsx`. That's change 2.
- The shadcn `chart` primitive and `recharts`. They move to change 3d, because the generated `ChartStyle` injects a `<style>` with `dangerouslySetInnerHTML`, which the repo-wide no-agent-authored-markup guard forbids. 3d must replace it with inline CSS custom properties.
- Any AI SDK, `useChat` or AI Elements usage, and any server or contract change. That's change 4.
- The shadcn MCP server entry in `.mcp.json`, which goes in a separate change.
- User-chosen category colors, such as the "Audio issue" filter label at 3.64:1. They're user data, not theme.
- Removing OverlayScrollbars, the legacy `.btn` family or other legacy CSS.
- A light theme or theme toggle.
- Replacing icons in existing components.

## Impact

- **New files:** `web/components.json`, `web/src/shared/components/ui/*`, `web/src/shared/lib/utils.ts`.
- **Theme:** `web/src/shared/theme/tailwind.css` (Preflight, token rename, shadcn tokens, contrast values) and `web/src/shared/theme/classnames.ts` (`BTN_PRIMARY_SKY`).
- **Legacy-token consumers:** `EventLogRow.tsx`, `FeedTable.tsx`, `EventLogSheet.tsx`, `CategoryButtonStrip.tsx`, `AudioSaveOverlay.tsx`, `SessionWorkspace.tsx`, and possibly `Timeline.tsx` and `timeline/TimelineMarkers.tsx`.
- **Contrast edits:** `Timeline.tsx`, `EventButtonsTable.tsx`, `LoginPage.tsx`.
- **Other:** `web/package.json` and the root lockfile, `.gitignore`.
- **Visual:** Preflight changes browser defaults app-wide. The agent-browser walk (`qa/screens.sh`, 26 screens at 1440 and 390) diffs every reachable screen. Surfaces the walk can't reach with the current dev data are listed in `qa/README.md` and checked by reading their code and in a human pass.
- **Supply chain:** seven new runtime packages, gated by `npm audit --audit-level=high` in check-change.
- **Bundle:** primitives that nothing imports are tree-shaken, so they add no bundle cost until changes 2 and 3 use them.
