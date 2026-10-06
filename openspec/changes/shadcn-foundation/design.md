# Design: shadcn foundation

## Context

See proposal.md for the motivation.

The current setup:

- **Stylesheet:** one file, `web/src/shared/theme/tailwind.css` (1933 lines).
  - It imports only Tailwind's `theme.css` and `utilities.css` into `@layer theme, base, components, utilities`, so Preflight is off.
  - The custom reset lives in `@layer base`, around lines 1832–1870.
  - Legacy component CSS lives in `@layer components`.
- **Tokens:** `@theme`/`@theme inline` tokens (`--color-*`) emit literal utility values, and there are parallel `:root` custom properties.
  - The legacy names `--border` (#343842), `--muted` (#9aa0a6, a text color) and `--accent` (#7cb7ff) are already defined in `:root`, with twins at `--color-border`, `--color-muted` and `--color-accent` in `@theme`.
  - Their consumers are `tailwind.css` (`var(--muted)` ×11, `var(--border)` ×9, `var(--accent)`) and `EventLogRow.tsx`. The utilities `text-muted`, `text-accent` and `border-border` are used in FeedTable, EventLogSheet, CategoryButtonStrip, AudioSaveOverlay, SessionWorkspace and EventLogRow.
- **Primary sky label:** comes from the `text-v5-primary` utility in `BTN_PRIMARY_SKY` (`shared/theme/classnames.ts`), which is layered above the `.btn.primary` component rule. That rule already sets `#e0f2fe`.
- **Path aliases:** `tsconfig` and `vitest` only alias `@/api/*`, `@/shared/*` and `@/pages/*`. `webBoundaries.repo.test.ts` enforces the layer direction `pages → api/shared`.
- **Markup guard:** `noAgentAuthoredMarkup.repo.test.ts` forbids any `dangerouslySetInnerHTML` usage in `server/`, `web/` and `companion/`, with no exceptions.
- **Phase 0 QA (`qa/`):**
  - `screens.sh` is a fixed agent-browser walk of 26 screens: pages, tabs, dialogs and menus. Each is captured at 1440 and 390.
  - `contrast.js` composites text over every ancestor background. For each gradient layer it picks the stop that gives the lowest contrast.
  - The baseline is in `qa/baseline/`.

## Goals / Non-Goals

**Goals:**
- shadcn tooling and primitives are installed and themed so that a later port changes internals, not the look.
- Preflight is on, with no visible regression on any reachable screen.
- Zero theme-styled AA failures on the walk.

**Non-Goals:**
- No consumer imports the new primitives yet. That's change 2.
- Legacy CSS is not removed, apart from the redundant `box-sizing` rule.

## Decisions

**D1. Location: `src/shared/components/ui` and `src/shared/lib/utils.ts`.**
- These sit under the existing `@/shared/*` alias, so `tsconfig`, `vitest` and `webBoundaries` need no change. In a scratch run, `webBoundaries` passed with all 25 primitives in place (109/109).
- Lowercase `dialog.tsx` in a different folder from `shared/ui/Dialog.tsx` avoids case-insensitive filesystem collisions.
- Alternative rejected: a top-level `src/components` with an `@/*` alias. That needs new aliases and a new boundary layer.

**D2. `components.json` is written by hand. No `shadcn init`. Generated files are normalized after each `add`.**
- `init` rewrites the CSS entry and adds a `.dark` block.
- The hand-written file has: `style: new-york`, `rsc: false`, `tsx: true`, `tailwind.css: src/shared/theme/tailwind.css`, `tailwind.config: ""`, `baseColor: neutral`, `cssVariables: true`, `iconLibrary: lucide`, the D1 aliases, and `registries: { "@ai-elements": "https://registry.ai-sdk.dev/{name}.json" }`.
- Each `add` runs with `--dry-run` first. Then every generated file is read and normalized:
  - **`cn` import:** the CLI (4.21.2) emits `import { cn } from "cn"` and installs the npm `cn` package (first published 2026-09-21). Rewrite these imports to `@/shared/lib/utils` and don't install `cn`.
  - **sonner:** the registry's `sonner.tsx` reads `useTheme()` from `next-themes`, and there's no provider in this app. Rewrite it to a fixed `theme="dark"` and don't install `next-themes`.
  - **`dark:` variants:** in this setup `dark:` compiles to `@media (prefers-color-scheme: dark)` and carries the dark-intended styling. Fold each `dark:X` into the base class, replacing its light counterpart, rather than deleting it. Examples: input `dark:bg-input/30`, outline button `dark:bg-input/30 dark:border-input`, tabs active `dark:bg-input/30`, destructive `dark:bg-destructive/60`.
- `--overwrite` is never used.
- **Guard:** `shadcnHygiene.repo.test.ts` (node) fails if any file under `web/src` imports from `"cn"` or `"next-themes"`, or if any file under `shared/components/ui` contains a `dark:` variant. Rule 8: a rule that must always hold should be a check.

**D3. Rename legacy tokens before adding shadcn tokens.**
- Rename `--border` → `--legacy-border`, `--muted` → `--legacy-muted` and `--accent` → `--legacy-accent` in `:root`. Rename `--color-border/muted/accent` → `--color-legacy-border/muted/accent` in `@theme`, which makes the utilities `text-legacy-muted`, `border-legacy-border` and `text-legacy-accent`.
- Update every consumer listed in Context. Rendered values don't change, so the QA diff must show no pixel change from this step alone.
- Then D5 defines the shadcn names.
- `--radius` stays at 10px. That equals shadcn's default 0.625rem, so there's no collision in meaning.
- Alternative rejected: prefixing shadcn's tokens instead. Every generated primitive would need rewriting, and every future `add` would repeat the work.
- **Guard:** `shadcnHygiene.repo.test.ts` also fails on `var(--muted)`, `var(--accent)` or bare `text-muted`/`text-accent` utilities outside `shared/components/ui`. That stops legacy code from reattaching to the shadcn tokens.

**D4. Preflight goes in the `base` layer, ahead of our reset.**
- Add `@import 'tailwindcss/preflight.css' layer(base);` and delete the redundant universal `box-sizing` rule.
- A scratch compile showed Preflight emitted first in `@layer base`, with our later rules winning in the same layer (tap-highlight, `:focus-visible`, `body`, fonts, glow). Legacy `@layer components` still beats Preflight.
- Drift only hits elements that relied on browser defaults: bare `h1`–`h6`, `p`, `ul`/`ol`, `button`, `img`, `hr`, form controls.
  - Reachable screens are checked by the QA diff.
  - Unreachable ones are checked by a grep of bare elements in the components listed in `qa/README.md` (YouTubeImportErrorModal, TranscribeModal, EventGenerateCustomModal, MaximizeLogStrip, TeamCard, ChunkRescueBanner, ConfirmDialog, AudioSaveOverlay). Wherever one relied on a browser margin or list style, it gets explicit utilities.

**D5. shadcn tokens alias V5 variables on `:root`. Dark only. Full set.**

| Token | Value |
| --- | --- |
| `--background` | `var(--v5-bg)` |
| `--foreground` | `var(--v5-text)` |
| `--card`, `--popover` | the V5 panel base (`rgba(19,27,48,.91)` composited, as a solid) |
| `--card-foreground`, `--popover-foreground` | `var(--v5-text)` |
| `--primary` | `var(--v5-primary)` |
| `--primary-foreground` | `#e0f2fe` |
| `--secondary`, `--muted`, `--accent` | `rgba(255,255,255,0.06)`, the V5 hover/raised surface |
| `--secondary-foreground`, `--accent-foreground` | `var(--v5-text)` |
| `--muted-foreground` | `var(--v5-muted)` (0.62) |
| `--destructive` | the V5 red |
| `--border`, `--input` | `var(--v5-border-strong)` |
| `--ring` | `var(--v5-primary)` |

- All are exposed with `@theme inline` (`--color-background: var(--background)` and so on).
- `--chart-*` is deferred with the chart primitive.
- Alternative rejected: shadcn's neutral or zinc palette, which conflicts with "Single V5 component vocabulary".

**D6. Button variants carry V5 explicitly.**
- The cva base has `uppercase tracking-[0.08em]`, `glass-face` and `border border-border`.
- Variants:
  - `default`: sky-tinted gradient and border, with a `text-primary-foreground` label.
  - `destructive`: red-tinted.
  - `outline`, `ghost`, `secondary` and `link` are kept.
- Disabled is `disabled:pointer-events-none disabled:opacity-50 disabled:text-muted-foreground`. That gives reduced opacity, muted text and no hover change, which is what the existing scenario requires.

**D7. Contrast fixes.**

All values were measured live with the corrected probe in this design phase (see Assumptions). Each injected rule replaces the value of the rule that currently wins for that element, which is what the planned edit does. Every fix was measured at 1440 on the screens listed in `qa/baseline/*.contrast.json`.

| Failure (baseline, corrected probe) | Edit | Measured |
| --- | --- | --- |
| Recent-session details and duration (4.27) | `--color-v5-muted` and `--v5-muted` alpha 0.55 → 0.62 | 4.98 |
| Dialog close `×` buttons (4.24) | same token change | 4.93 |
| "AI Rules" label (2.8) | `text-[rgba(229,238,252,0.35)]` → `text-v5-muted` (EventButtonsTable.tsx) | 5.14 |
| Placeholders (4.15) | placeholder floor alpha 0.55 → 0.62 (tailwind.css) | 4.82 |
| Timeline total duration (4.01) | drop `opacity-[0.82]` (Timeline.tsx:1034) | 6.77 |
| Primary labels (3.46, 4.48) | in `BTN_PRIMARY_SKY`, `text-v5-primary` → `text-[#e0f2fe]` | 6.47 / 8.36 |
| Login secondary link (4.32) | in `BTN_CREATE` (LoginPage.tsx), `text-v5-muted` → `text-[rgba(229,238,252,0.78)]` | 5.34 |

With all of these injected, the full 26-screen walk reported zero failures except the user-chosen "Audio issue" category color.

**D8. Tests.**
- **`button.test.tsx`, written first:**
  - role
  - `data-variant` for `default` and `destructive`
  - `disabled` blocks clicks
  - `asChild` renders a link
  - Class strings aren't asserted.
- **`shadcnHygiene.repo.test.ts`, written first:** covers the D2 and D3 guards. It fails as soon as the first `add` lands un-normalized files.
- **`contrastTokens.test.ts`, written first:**
  - It parses `tailwind.css` and `classnames.ts` for the muted, placeholder and primary-label colors, and the login link color from `LoginPage.tsx`.
  - Each color is composited over the **lightest effective surface the probe measured it on**. These are fixtures copied from the baseline JSON's `bg` field, such as `(35,57,76)` for session rows and `(46,54,74)` for the login link.
  - It asserts at least 4.5:1, and it fails on today's values. Using the lightest measured surface rather than the darkest V5 color is what makes it able to fail.
- **The live probe** is the acceptance test for the rendered result. It's run at the gate through `screens.sh`.

**D9. QA artifacts.**
- `qa/.gitignore` (`*.png`) sits inside the change directory, so it lands in the artifacts-first commit. Verified: `git check-ignore` prints the PNG path.
- The root `.gitignore` gets `openspec/changes/**/qa/**/*.png` for future changes.
- `cap.sh` moves the mouse to a corner before measuring, so hover states don't leak into the probe.

## Assumptions (each tested)

| Assumption | Command | Observed |
| --- | --- | --- |
| Preflight ships separately | `ls node_modules/tailwindcss/*.css` | `index.css preflight.css theme.css utilities.css` |
| The CLI is reachable | `npx -y shadcn@latest --version` | `4.21.2` |
| The AI Elements registry resolves | `curl -s https://registry.ai-sdk.dev/message.json \| head -c 120` | `{"$schema":"https://ui.shadcn.com/schema/registry-item.json","name":"message",…` |
| The hand-written `components.json` aliases are respected | panel scratch run: `shadcn info --json`; `add button field --dry-run` | `"ui": "@/shared/components/ui"`; `+ src/shared/components/ui/button.tsx`; field imports `@/shared/components/ui/label` |
| The generated `cn` import must be rewritten | panel scratch run: `add button --dry-run --view` | `import { cn } from "cn"`; deps `+ cn + radix-ui` |
| sonner needs a theme rewrite | registry `sonner.json` | deps `['sonner','next-themes']`; `const { theme = "system" } = useTheme()` |
| The chart primitive violates the markup guard | panel scratch run: `vitest run src/noAgentAuthoredMarkup.repo.test.ts` with chart added | `"file": "web/src/shared/components/ui/chart.tsx" … 1 failed` |
| `dark:` means media-query dark here | `grep -n custom-variant web/src/shared/theme/tailwind.css` | only `hover-always` |
| Legacy token names collide | `grep -nE "^\s*--(border\|muted\|accent)\s*:" tailwind.css` | `232: --border: #343842` `234: --muted: #9aa0a6` `235: --accent: #7cb7ff` |
| Legacy-token consumers | `grep -rln "var(--border)" web/src` and the utility grep | `tailwind.css EventLogRow.tsx`; FeedTable, EventLogSheet, CategoryButtonStrip, AudioSaveOverlay, SessionWorkspace, EventLogRow, Timeline, TimelineMarkers (the last two to confirm) |
| The primary sky label comes from `BTN_PRIMARY_SKY` | `cat web/src/shared/theme/classnames.ts` | `… text-v5-primary hover-always:…` |
| Primaries in the shared layer stay inside boundaries | panel scratch run: `vitest run src/webBoundaries.repo.test.ts` | `Tests 109 passed (109)` |
| `tw-animate-css` imports in a CSS-first setup | panel scratch compile | `.animate-in { animation: enter …}` |
| Measured fix values | `QA_INJECT=… ./screens.sh <scratch>` plus targeted `contrast.js` runs | see the D7 table; walk: only `('Audio issue', 3.64)` remains |
| Disabled exemption | `contrast.js` filter `!r.disabled`; baseline `SAVED` | disabled `SAVED` 2.02, excluded |

## Risks / Trade-offs

- **The legacy-token rename misses a consumer, and a legacy surface picks up a shadcn token value.**
  - Mitigation: the D3 guard test, plus the QA diff of that step alone, which must show zero pixel change.
- **Preflight drift on unreachable surfaces.**
  - Mitigation: the D4 grep review, plus a human dev-stack pass on the listed components, recorded in `qa/README.md`.
- **Biome rejects generated code** (`useImportType`, `noArrayIndexKey`, `noDoubleEquals`, `useSemanticElements`).
  - Mitigation: fix it in the file. A narrow `biome-ignore` is allowed only with a reason. No config-wide disables.
- **Radix duplication:** the unified `radix-ui` package sits next to the existing `@radix-ui/react-*`.
  - Accepted until change 2 retires the old wrappers.
- **Probe residual imprecision:** the probe takes the worst gradient stop per layer, so it over-reports rather than under-reports. It doesn't model `backdrop-filter`, box-shadow glows or images.
  - Mitigation: the human reviews the screenshot pairs.
- **The dev data is sparse:** one session with no events, audio or transcript.
  - Accepted by the owner. Unreachable surfaces are listed in `qa/README.md`.

## Migration Plan

This is web only, with no data or contract involved. Rollback is reverting the branch.
