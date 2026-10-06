# Tasks

## 1. Tooling and guards

- [x] 1.1 Write `web/components.json` by hand per design D2. Verify with `npx shadcn@latest info --json`: the output shows `"ui": "@/shared/components/ui"`, `iconLibrary: lucide` and the `@ai-elements` registry.
  - Evidence: `npx shadcn@latest info --json` -> `"ui": "@/shared/components/ui"`, `"iconLibrary": "lucide"`, `"@ai-elements": "https://registry.ai-sdk.dev/{name}.json"`
- [x] 1.2 Add `web/src/shared/lib/utils.ts` (`cn` = `twMerge(clsx(...))`) and install `tailwind-merge`, `class-variance-authority`, `lucide-react` and `tw-animate-css`. Test first: `web/src/shared/lib/utils.test.ts` asserts that `cn('px-2','px-4')` is `'px-4'` and that falsy values are dropped. Verify with `npm test -w web -- utils.test`.
  - Evidence: test first: `npx vitest run src/shared/lib/utils.test.ts` -> `Error: Cannot find module ./utils`; after `npm install -w web tailwind-merge class-variance-authority lucide-react tw-animate-css` + utils.ts -> `Tests  2 passed (2)`
- [x] 1.3 Test first: `web/src/shadcnHygiene.repo.test.ts` (D2 and D3 guards). It flags:
  - any import from `"cn"` or `"next-themes"` under `web/src`
  - any `dark:` variant under `shared/components/ui`
  - any `var(--muted)`, `var(--accent)` or bare `text-muted`/`text-accent` outside `shared/components/ui`
  - Evidence: test first: `npx vitest run src/shadcnHygiene.repo.test.ts` -> `× legacy code never references the bare --border/--muted/--accent tokens` (tailwind.css ×21, EventLogRow, …) `× … text-muted / text-accent / border-border utilities` (FeedTable, EventLogSheet, CategoryButtonStrip, AudioSaveOverlay, SessionWorkspace) `Tests 2 failed | 2 passed (4)`; turns green in 2.1

  It fails today on the legacy `var(--muted)` usages. Verify with `npm test -w web -- shadcnHygiene`, which should fail with the legacy usages listed.
- [x] 1.4 Add `openspec/changes/**/qa/**/*.png` to the root `.gitignore`. Verify with `git check-ignore openspec/changes/shadcn-foundation/qa/baseline/home.1440.png`, which should print the path.
  - Evidence: `git check-ignore -v --no-index openspec/changes/other-change/qa/after/a.png` -> `.gitignore:…:openspec/changes/**/qa/**/*.png` (root rule; this change also has qa/.gitignore)

## 2. Theme: legacy rename, Preflight and shadcn tokens

- [x] 2.1 Rename the legacy `--border`, `--muted` and `--accent` tokens, and their `--color-*` twins, to `--legacy-*`, and update every consumer (D3). Verify that `npm test -w web -- shadcnHygiene` passes, that `npm test -w web` is green, and that `QA` `./screens.sh qa/after-rename` shows zero visual change against the baseline (`agent-browser diff screenshot`).
  - Evidence: `npx vitest run src/shadcnHygiene.repo.test.ts` -> `Tests 4 passed (4)`; `npx vitest run` -> `Test Files 111 passed (111) Tests 1425 passed (1425)`; `npm run typecheck` clean; `QA_BASELINE=baseline ./screens.sh after-rename` -> 44 `✓ Images match (0% difference)`, 8 at ≤0.07% (focus ring on the last-clicked control, e.g. new-session-expanded frame-rate select; interaction timing, not colour)
- [x] 2.2 Test first: `web/src/shared/theme/contrastTokens.test.ts` (D8), with lightest-measured-surface fixtures. It fails on muted 0.55, placeholder 0.55, `BTN_PRIMARY_SKY`'s `text-v5-primary` and the login link's muted. Then apply the D7 token and class edits: muted and placeholder to 0.62, `BTN_PRIMARY_SKY` to `#e0f2fe`, `BTN_CREATE` to 0.78, the "AI Rules" label to `text-v5-muted`, and Timeline drops `opacity-[0.82]`. Verify with `npm test -w web -- contrastTokens`, which should pass.
  - Evidence: test first: `npx vitest run src/shared/theme/contrastTokens.test.ts` -> 6 × (muted 4.28, placeholder 4.15, BTN_PRIMARY_SKY 3.48, BTN_CREATE 4.32, AI Rules 2.80, Timeline `opacity-[`); after D7 edits (muted+placeholder 0.62, BTN_PRIMARY_SKY `text-[#e0f2fe]`, BTN_CREATE 0.78, AI Rules `text-v5-muted`, Timeline opacity dropped) -> `Tests 6 passed (6)`; full `npx vitest run` green. Note: the unit fixture for the login link passes at 0.62 while the live probe measured 4.39, so 0.78 is applied per D7 and the live gate (5.1) is authoritative
- [x] 2.3 Turn on Preflight (`@import 'tailwindcss/preflight.css' layer(base);`), delete the redundant universal box-sizing rule, and add `@import 'tw-animate-css';` (D4). Verify that `npm test -w web` and `npm run typecheck -w web` are green.
  - Evidence: `make dev-up` (rebuild with new deps) then `QA_BASELINE=baseline ./screens.sh after-preflight` -> contrast: only out-of-scope `Audio issue 3.64` fails; diffs 0.04–4.8% from Preflight normalization (`qa/preflight-drift.js` on home: buttons Arial 13.33px → Inter 15px, h1 700 → 400, svg inline → block). Owner accepted the normalization (design D4); League Gothic titles restored with `font-bold` (8 files). `npx vitest run` -> `Test Files 112 passed (112) Tests 1431 passed (1431)`; `npm run typecheck` clean
- [x] 2.4 Add the full shadcn semantic token set on `:root` plus the `@theme inline` mappings (D5). The test first extends `contrastTokens.test.ts` so that `--muted-foreground` and `--primary-foreground` reach at least 4.5:1 on the same fixtures. Verify with `npm test -w web -- contrastTokens`.
  - Evidence: test first: contrastTokens.test.ts + shadcn section -> `Tests 4 failed | 6 passed (10)`; after the :root shadcn tokens + `@theme inline` mappings -> `Tests 14 passed (14)` (with hygiene). Found during QA: `Internal` filter item fell to 1.15:1 via inline `var(--color-muted)`; hygiene guard widened to `var(--color-(border|muted|accent))` (failed on 8 refs), refs renamed to `--color-legacy-*`. Timeline `rounded-lg` pinned to `rounded-[0.5rem]` (shadcn radius scale). `npx vitest run` -> `Tests 1435 passed (1435)`; `QA_BASELINE=after-preflight ./screens.sh after-tokens` -> only `Audio issue 3.64`; diffs ≤0.52% (restored bold title)

## 3. Primitives

- [ ] 3.1 Run `npx shadcn@latest docs button` and read it. Then `npx shadcn@latest add button --dry-run`, then `add button`, and normalize the result per D2. Test first: `web/src/shared/components/ui/button.test.tsx` (D8). Restyle the variants to V5 (D6). Verify with `npm test -w web -- button.test shadcnHygiene`.
- [ ] 3.2 Add the remaining primitives: input, textarea, label, field, select, tabs, table, card, badge, alert, skeleton, separator, empty, spinner, tooltip, popover, dropdown-menu, radio-group, dialog, drawer, alert-dialog, sonner and scroll-area. No chart. Use `--dry-run` first, then read and normalize every file (D2: rewrite the `cn` import, give sonner a fixed dark theme, fold `dark:` variants), and make sure `cn`, `next-themes` and `recharts` aren't in `web/package.json`. Test first: `web/src/shared/components/ui/primitives.smoke.test.tsx` renders each primitive (dialog, alert-dialog and drawer opened; sonner `<Toaster/>` asserted as `data-sonner-theme="dark"` after a toast) and checks its role. Verify with `npm test -w web -- primitives.smoke shadcnHygiene noAgentAuthoredMarkup webBoundaries` and `grep -E '"(cn|next-themes|recharts)"' web/package.json`, which should print nothing.
- [ ] 3.3 Make the generated files pass Biome. Verify that `npm run lint -w web` exits 0. Any `biome-ignore` must carry a reason.

## 4. Preflight drift review

- [ ] 4.1 For the components the walk can't reach (listed in `qa/README.md`), grep for bare `h1`–`h6`, `p`, `ul`, `ol`, `button`, `img`, `hr`, `input` and `textarea`. Wherever one relied on a browser margin, list style or font size, add explicit utilities that restore the pre-Preflight look. Verify with a list of the findings and edits in `qa/README.md`, and keep their existing component tests green with `npm test -w web`.

## 5. Integration: QA gate and checks

- [ ] 5.1 Run `qa/screens.sh qa/after-foundation`. Verify that every `*.contrast.json` reports `fails: 0`, apart from the user-data "Audio issue" category label, which `qa/README.md` records as out of scope.
- [ ] 5.2 Diff each `after-foundation` screenshot against `baseline` (`agent-browser diff screenshot --baseline`). Fix any Preflight drift with local utilities. Record each screen's result in `qa/README.md`. The human reviews the image pairs and does a dev-stack pass on the unreachable surfaces.
- [ ] 5.3 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh` and `openspec validate shadcn-foundation --strict`. Verify that every gate passes. The known storage "8 contending" flake is re-run, not counted as a failure.
