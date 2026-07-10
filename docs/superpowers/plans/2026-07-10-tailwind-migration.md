# Tailwind Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert all `web/` styling from CSS Modules + plain shared CSS to Tailwind v4 with pixel-verified visual parity, per the approved spec `docs/superpowers/specs/2026-07-09-tailwind-migration-design.md`.

**Architecture:** Stage 0 builds the safety net (vendored fonts, dead-rule purge, frozen screenshot baselines, Tailwind wiring with all legacy CSS in a `legacy` cascade layer below `utilities`), then six conversion slices land component clusters ordered by the coupling audit, theme layer last. Every task is one branch → gates green → merge to `main`.

**Tech Stack:** Tailwind v4 (`tailwindcss` + `@tailwindcss/vite`, CSS-first — no JS config), Vite 8, React 19, `clsx`, Playwright `toHaveScreenshot` visual regression, Biome.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-09-tailwind-migration-design.md` — normative. Deviations get logged in the spec's panel log, not silently adopted.
- **Audit:** `docs/superpowers/plans/2026-07-10-tailwind-migration-coupling-audit.md` (sections A–N) is the source of truth for couplings, dead rules, hover guards, tokens. **Its `file:line` anchors go stale as slices land — always locate quoted code by content before editing.** Repeat this in every sub-agent prompt.
- **Gates, run per task before merge** (call this **GATES** below):
  1. `npm run typecheck` — expect exit 0
  2. `npm test` — expect all server vitest pass
  3. `npm run lint` — expect exit 0
  4. `npm run e2e` — expect smoke suite pass
  5. `npm run e2e:visual` — expect all screenshots match frozen baselines (from Task 3 onward)
- **Branching:** plain git branches off `main` (`git checkout -b tailwind/<task-slug>`), merge back after gates. **Never create git worktrees.**
- **Baselines are frozen** after Task 3. Re-capture only per the spec's re-baseline policy (per-shot, logged decision). Masks and tolerances are frozen with them.
- **`@playwright/test` stays exact-pinned** (Task 3) until the completion task relaxes it.
- **Stable hooks are never removed:** all `id="..."` and `data-*` attributes (`#v4-log-sheet`, `#v3-session-grid`, `#btn-ctl-*`, `#toast-queue`, `[data-event-id]`, `[data-category-id]`, …) stay byte-identical. No DOM-structure changes.
- **Legacy class retention rule (spec):** a converted component keeps emitting a legacy *global* class-name string while any unconverted CSS rule or JS/e2e hook targets it; drop it only in the slice that converts/deletes its last rule.
- **Token naming:** legacy tokens in `tokens.css` are **never renamed**. `@theme` names always differ from legacy names (`--color-v5-primary: var(--v5-primary)`). Exceptions handled in Task 4: `--font-poppins` / `--font-league-gothic` *move* into `@theme` with literal values (deleted from `tokens.css` in the same commit); orphaned `--font` is deleted in Task 2.
- **Versioning:** no version bump per slice; one bump + CHANGELOG entry in Task 12.

## The Conversion Recipe (referenced by Tasks 5–11)

Every component conversion follows this procedure. Task-specific hazards are listed per task; the recipe itself is identical everywhere.

1. **Read the audit first.** Pull the component's rows from audit sections A (`:global` map), D (dead rules — already deleted in Task 2; if you find one left, delete it now), G (hover guarded/unguarded), H (`!important`), I (keyframes), J (exotic selectors), N (local custom properties).
2. **Translate each rule block to utilities** on the JSX element that the selector targets:
   - Values with an exact Tailwind scale equivalent use the scale (`1.25rem` → `p-5`); anything else uses arbitrary values (`px-[0.9rem]`) — **never round**.
   - Token references use theme utilities (`text-v5-text`, `rounded-v5-sm`, `border-v5-border`, `border-v5-line` — check Task 4's `@theme inline` list first; every token named there has a real utility) or var shorthand for the non-namespace tokens only (`z-(--z-toast)`, `w-(--v4-cat-btn-w)`). Drop `var()` fallback values — the tokens are always defined.
   - Compound glass/shadow tokens use the named utilities from Task 4 (`glass-face`, `glass-face-strong`, `glass-face-aside`, `shadow-glow-v5`, `panel-elevate`, `glass-panel`).
   - `:hover` rules: **unguarded** (the default — check audit G) → `hover-always:` variant; **guarded** (chrome `.btn` trio only) → plain `hover:`.
   - `:focus-visible` → `focus-visible:`; `:disabled` → `disabled:`; `prefers-reduced-motion` blocks → `motion-reduce:`; `@media (max-width: 767px)` → `max-md:` (Task 4 sets the breakpoint so `md` = 768px; **never restructure a desktop-first rule mobile-first**).
   - Radix `[data-state]`/`[data-highlighted]`/`[data-disabled]` selectors → `data-[state=open]:`, `data-highlighted:`-style variants.
   - Ancestor-context rules (`:global(#v4-log-session) .x`, `:global(.v4-cat-buttons__scroll) .x`) → ancestor arbitrary variants on the descendant's own element: `[#v4-log-session_&]:...`, `[.v4-cat-buttons__scroll_&]:...`. The ancestor class/id keeps being emitted (retention rule).
   - Keyframes → `--animate-*` tokens with `@keyframes` inside `@theme` in `tailwind.css`, named `<component>-<purpose>` (e.g. `toast-enter`); use via `animate-toast-enter`. Preserve reduced-motion guards with `motion-reduce:animate-none`.
   - Rules an inline utility genuinely cannot express (`::-webkit-scrollbar*`, multi-property `::before` texture layers, `[data-overlayscrollbars-viewport]` layout, `body[data-*]` state toggles targeting many descendants) → a named `@utility` or `@layer components` rule in `tailwind.css`, token-referencing, with a one-line comment stating why it can't be inline.
   - `!important` legacy rules (audit H): once the component's competing rules are all in Tailwind layers, most `!important` flags become unnecessary — drop them and let layer order work; keep `!` (Tailwind important modifier) only where the rule must beat *later* layers (perf-debug toggles, `.hidden`, the audio-saving pointer-events lock).
3. **Compose conditionals with `clsx`** at the existing call sites; class strings replace `styles.x` references. **State-variant rules that override base properties convert as clsx branches that REPLACE the conflicting utility, never stack it** (`entry.isError ? 'border-danger' : 'border-v5-border'`, not base + conditional append): when two utilities set the same property on one element, generated-stylesheet order wins, not `className` order — the legacy rule's specificity edge is gone. This governs every disabled/active/error/edit-mode flag (TransportControls `isDisabled`, feed edit-mode locks, toast error).
3b. **CSS-defined local custom properties** (module-side definitions that die with the file — audit N: V6Rail's 16-var local `:root` block, HomeSettingsModal's `--v6-tab-*`, TransportControls' 7-state `--session-ctl-accent` matrix, MarkerNav geometry vars, CategoryButtonStrip's `--cat` fallback): convert as arbitrary-property utilities on the defining element (`[--cat:#7cb7ff]`, state overrides via exclusive clsx branches), or — where a var cluster would be inline noise (the V6Rail root block) — a small named `@layer components` block in `tailwind.css` with a why-comment. Runtime `setProperty` vars stay untouched either way.
4. **Delete the module file and its `import styles` line(s) in the same commit** — including borrower files (audit C1: e.g. `EventLogRow` imports `EventLogSheet.module.css`). The *file* dies; legacy global class-name *strings* in JSX may persist under the retention rule.
5. **Run GATES.** For visual diffs, compare desktop and mobile. If a shot legitimately differs, you converted something wrong — fix the conversion, never the baseline.
6. **Review checklist** (per spec): diff every `hover:`/`hover-always:`/`focus-visible:`/`active:`/`disabled:`/`motion-reduce:` variant in the new JSX against the deleted module rules — semantics, not just presence.
7. **Commit** with `feat(web): tailwind slice N — <components>` and merge the branch.

---

### Task 1: Vendor network fonts + animate.css (stage 0a)

**Files:**
- Create: `web/src/shared/assets/fonts/inter-*.woff2`, `oswald-*.woff2`, `roboto-*.woff2` (exact filenames from download step)
- Create: `web/src/shared/theme/vendor/animate.min.css`
- Modify: `web/src/pages/index/index.html` (remove the two CDN `<link>`s)
- Modify: `web/src/shared/theme/baseline.css` (add `@font-face` blocks next to the existing self-hosted ones)
- Modify: `web/src/pages/index/main.tsx` (side-effect import of vendored animate.css)

**Interfaces:**
- Consumes: nothing.
- Produces: network-free font rendering identical to today; `animate__animated`/`animate__pulse` classes still resolve. Later tasks rely on baselines being network-independent.

- [ ] **Step 1: Inspect the existing @font-face pattern.** Open `web/src/shared/theme/baseline.css`, find the `@font-face` blocks near the top (Poppins / League Gothic / Chivo Mono) and note the `src: url(...)` path convention and the directory the existing woff2 files live in. Place the new files in the same directory; if it differs from `web/src/shared/assets/fonts/`, use the existing one.

- [ ] **Step 2: Download the exact font binaries the CDN serves.** The CDN request is `https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Oswald:wght@500&family=Roboto:wght@500&display=swap`. Fetch that CSS with a Chrome UA (so it returns woff2 URLs), then download each `url(...)`:

```bash
curl -s -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36" \
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Oswald:wght@500&family=Roboto:wght@500&display=swap' \
  -o /tmp/gf.css
grep -oE 'https://fonts.gstatic.com/[^)]+' /tmp/gf.css | sort -u
# download each URL; name files inter-400.woff2, inter-500.woff2, inter-600.woff2, oswald-500.woff2, roboto-500.woff2
# (keep only latin subsets unless the CSS shows the app needs more — mirror what the app actually renders)
mkdir -p web/src/shared/theme/vendor
curl -s -A "Mozilla/5.0" 'https://cdnjs.cloudflare.com/ajax/libs/animate.css/4.1.1/animate.min.css' \
  -o web/src/shared/theme/vendor/animate.min.css
```

- [ ] **Step 3: Add @font-face blocks** to `baseline.css`, matching the existing blocks' shape (family names exactly `Inter`, `Oswald`, `Roboto`; weights 400/500/600, 500, 500; `font-display: swap`).

- [ ] **Step 4: Remove both CDN `<link rel="stylesheet">` tags** from `web/src/pages/index/index.html` and add to `web/src/pages/index/main.tsx` (with the other side-effect imports):

```ts
import '@/shared/theme/vendor/animate.min.css';
```

Note in a comment that this file is a vendored third-party lib, kept out of the migration and out of cascade layers permanently (additive animation classes; competes with nothing).

- [ ] **Step 5: Verify rendering.** `npm run dev`, open `http://127.0.0.1:5173/src/pages/index/index.html` with devtools network offline for fonts.googleapis.com/cdnjs — confirm Inter renders (compare a feed header glyph against production) and no console 404s. Then run GATES 1–4.

- [ ] **Step 6: Commit** `feat(web): vendor Inter/Oswald/Roboto + animate.css — network-free rendering (spec stage 0a)` and merge.

---

### Task 2: Dead-rule purge (stage 0a)

**Files:**
- Modify (deletions only, plus two paired TSX edits): `web/src/shared/theme/chrome.css`, `web/src/pages/index/AppShell.module.css`, `web/src/pages/index/components/{CategoryButtonStrip,TimecodeDisplay,HomeSettingsModal,EventButtonsTable,SessionWorkspace,Timeline,FeedTable,EventOptionsModal,RecentSessionsList}.module.css`, `web/src/shared/utils/perfDebug.module.css`, `web/src/shared/theme/glass.module.css`, `web/src/shared/theme/ThemeProvider.tsx`, `web/src/shared/theme/tokens.css`, `web/src/pages/index/components/EventLogRow.tsx`

**Interfaces:**
- Consumes: audit section D (full dead list with verdicts + line ranges) and its S1–S7 sweep items.
- Produces: a smaller, all-alive CSS surface for baseline capture. `ThemeContextValue` loses `glass`/`glassStrong`/`shadowGlow` fields (no consumers exist — audit C). `glass.module.css` retains **only** `.glassPanel` (alive via `composes` in Dialog/Popover/Tooltip/Select modules).

- [ ] **Step 1: Delete every DEAD item from audit section D**, locating each by content (line numbers may have drifted). The complete list: `:global(.v3-cue-grid-panel)` blocks (CategoryButtonStrip); `perfDebug.module.css` `.toast` selector line (keep its 6 alive siblings in the group); chrome.css `.table-wrap`, `.new-session-panel`, `.modal-card h2`, `.log-form`, `.pad`, `.hint` blocks; `HomeSettingsModal.module.css` `.toolbarClose:global(.v6-workspace-modal__close)` rule; **all 12 `:global(#modal-app-settings)`-prefixed rules** (HomeSettingsModal + EventButtonsTable — note the caution in audit S1: we delete rather than "fix" the missing id; that is the as-rendered reality baselines will encode); `SessionWorkspace.module.css` `.table-wrap-log-sheet`, `#log-sheet-table`/`.v4-sheet-thead-sr` rules; `AppShell.module.css` `:global(.main-v3 .new-session-panel)`; CategoryButtonStrip `#v4-log-session .cat-btn__line`; `AppShell.module.css` `:global(.settings-panel h2)` (`.settings-panel` is emitted only on the admin page, which never loads this module); TimecodeDisplay's four dead `:global(.v4-session-aside) .clock-*` rules; Timeline's dead locals (14 classes, audit S7 list); CategoryButtonStrip's 10 dead locals; FeedTable's `.feedThActions`; the broken `animation: pulse 3.5s infinite;` declaration in `SessionWorkspace.module.css` (keyframe never existed); V6Rail's dead `:global(.v6-app--rail-animating)` block.
  **Do NOT delete:** `body[data-v4-transport=...]` rules (statically active via index.html's hardcoded attribute — flagged as a parity question, out of scope) and the V6Rail hyphen-case suspect rules (adjudicated in slice 2, Task 6).

- [ ] **Step 2: Retire the dead glass/ThemeContext surface.** In `glass.module.css` delete `.glass`, `.glassStrong`, `.shadowGlow` (and the `.glass.shadowGlow` compound), keeping `.glassPanel`. In `ThemeProvider.tsx` remove the `glass.module.css` import, the three fields from `ThemeContextValue` and both provider values (keep `variant`, the provider component, and the two `v5-bg-glow` nodes). Delete orphaned `--font` from `tokens.css` (zero consumers — audit L) and the orphaned `--log-row-accent` setter line in `EventLogRow.tsx` (set, never read — audit N). Update the `--font-poppins` line to inline the old `--font` stack: `--font-poppins: "Poppins", "SF Pro Text", system-ui, -apple-system, Segoe UI, Roboto, sans-serif;`.

- [ ] **Step 3: Run GATES 1–4** (no visual harness yet — these are verified-dead rules; typecheck gates the ThemeProvider edit).

- [ ] **Step 4: Manual spot-check** in the dev server: home page, workspace with a session, settings modal — no visible change.

- [ ] **Step 5: Commit** `refactor(web): purge audited dead CSS + unrealized glass ThemeContext (spec stage 0a)` and merge.

---

### Task 3: Visual regression harness + frozen baselines (stage 0b)

**Files:**
- Create: `e2e/visual.spec.ts`
- Modify: `playwright.config.ts` (projects, `expect` defaults, launch args)
- Modify: `package.json` (root — pin `@playwright/test` exact; add `e2e:visual`; scope `e2e` to the smoke project)
- Create: `e2e/visual.spec.ts-snapshots/*.png` (committed baselines)

**Interfaces:**
- Consumes: the hermetic `:8791` `webServer` block already in `playwright.config.ts`; smoke-flow selectors from `e2e/smoke.spec.ts`.
- Produces: `npm run e2e:visual` (both viewports) as GATE 5 for every later task; helper `prepareForShot(page)` inside `visual.spec.ts`.

- [ ] **Step 1: Pin Playwright.** In root `package.json` change `"@playwright/test": "^1.x.y"` to the exact installed version (read it from `package-lock.json`), run `npm install`, and confirm `npx playwright --version` is unchanged. Add a comment-adjacent note in this plan's ledger when done.

- [ ] **Step 2: Update `playwright.config.ts`.** Replace the `projects` array and add `expect` defaults (keep `webServer` byte-identical):

```ts
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixels: 0, // strict default; per-shot exceptions only, frozen with baselines
    },
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' }, testIgnore: /visual\.spec\.ts/ },
    {
      name: 'visual-desktop',
      testMatch: /visual\.spec\.ts/,
      // Serial: one hermetic server, wiped once per invocation — cross-test
      // interleaving would make the home shot's rail contents run-order-dependent.
      // (workers is capped via --workers=1 in the npm scripts; it is not a
      // per-project option.)
      fullyParallel: false,
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 720 },
        launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
      },
    },
    {
      name: 'visual-mobile',
      testMatch: /visual\.spec\.ts/,
      fullyParallel: false,
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
      },
    },
  ],
```

- [ ] **Step 3: Update root scripts:**

```json
"e2e": "npm run build -w web && playwright test --project=chromium",
"e2e:visual": "npm run build -w web && playwright test --workers=1 --project=visual-desktop --project=visual-mobile",
"e2e:visual:update": "npm run build -w web && playwright test --workers=1 --project=visual-desktop --project=visual-mobile --update-snapshots"
```

- [ ] **Step 4: Write `e2e/visual.spec.ts`.** Structure (selectors mirror `smoke.spec.ts`; locate by content if drifted):

```ts
import { expect, test, type Page } from '@playwright/test';

/** Kill nondeterminism the `animations: 'disabled'` flag can't reach. */
async function prepareForShot(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const v of document.querySelectorAll('video')) {
      v.pause();
      v.currentTime = 0;
    }
  });
  await page.evaluate(() => document.fonts.ready);
}
// Wall-clock text renders in the deck (.v4-session-date / .v5-session-date-inline)
// and the recent-sessions rail — baselines captured today would fail tomorrow.
// Date regions are masked in EVERY shot that shows them (loss logged: date
// typography is verified by the per-slice review checklist instead). The
// timecode aside is masked wherever the clock is not provably frozen.
const DATE_MASK = (page: Page) => [
  page.locator('.v4-session-date'),
  page.locator('.v5-session-date-inline'),
  page.locator('#v6-rail-recent'), // rail session cards carry dates — verify selector against RecentSessionsList.tsx
];
const VIDEO_MASK = (page: Page) => [page.locator('video'), page.locator('.autologger-loading-video')];
// Time-driven regions for rolling/playing shots: timeline geometry + the clock aside.
const LIVE_MASK = (page: Page) => [
  ...VIDEO_MASK(page),
  ...DATE_MASK(page),
  page.locator('#timeline-shell'),
  page.locator('.v4-session-aside'),
];

async function createSession(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#v6-btn-new-session').click();
  await expect(page.locator('#ns-show')).toBeEnabled();
  // Fixed name — session titles appear in shots; the default is date-derived.
  await page.locator('#ns-name').fill('Visual Baseline Session'); // verify field id against NewSessionModal.tsx
  await page.locator('#ns-submit').click();
  await expect(page.locator('#v3-session-grid')).not.toHaveClass(/hidden/);
}
async function rollAndLog(page: Page): Promise<void> {
  await page.locator('#btn-ctl-2').click(); // roll
  const sceneBtn = page.locator('#cat-strip-live-slot [data-category-id]').filter({ hasText: 'Scene' });
  await expect(sceneBtn).toBeEnabled();
  await sceneBtn.click();
  await expect(page.locator('#v4-log-sheet tr[data-event-id]').first()).toBeVisible();
}

test('home', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Select a session, or create a new one from the left rail.')).toBeVisible();
  await prepareForShot(page);
  await expect(page).toHaveScreenshot('home.png', { mask: VIDEO_MASK(page), fullPage: false });
});

test('admin-users', async ({ page }) => {
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Admin Users' })).toBeVisible();
  await prepareForShot(page);
  await expect(page).toHaveScreenshot('admin-users.png');
});

test('workspace stopped + seeded events', async ({ page }) => {
  await createSession(page);
  await rollAndLog(page);
  await page.locator('#btn-ctl-1').click(); // stop — verify control ids against TransportControls.tsx
  await prepareForShot(page);
  // Stopped clock still shows the last timecode, whose frame digits depend on
  // ms-level click timing → mask the aside here too.
  await expect(page).toHaveScreenshot('workspace-stop.png', {
    mask: [...VIDEO_MASK(page), ...DATE_MASK(page), page.locator('.v4-session-aside')],
  });
});

test('workspace rolling', async ({ page }) => {
  await createSession(page);
  await rollAndLog(page);
  await prepareForShot(page);
  await expect(page).toHaveScreenshot('workspace-rolling.png', { mask: LIVE_MASK(page) });
});

// ...same shape for: workspace-play (mask LIVE_MASK); new-session-modal;
// home-settings-modal (open via its trigger; includes EventButtonsTable);
// event-options-modal; rename-session-modal (RecentSessionsList row menu);
// export-modal; feed edit-mode; feed pending-delete; transcribe-feed tab;
// topics-feed tab; hide-internal toggle; audio-save overlay (trigger the save
// flow with fake media; video region masked — the shot covers the overlay
// chrome, per spec); persistent toast — BEFORE writing this test, grep
// `toast.persistent(` call sites in web/src and pick a UI-triggerable one; the
// spec's determinism fix requires the persistent variant (a 3.2s auto-dismiss
// races the toHaveScreenshot retry loop). If no call site is UI-reachable
// headless, STOP and escalate to the owner as a logged decision — do not
// substitute an auto-dismissing toast; error-toast variant shot (isError
// styling — trigger a failing action, e.g. invalid form submit, and shoot the
// error toast; it pins the border-danger/text conversion branch);
// timeline seeked-paused (roll, stop, click a marker → playhead fixed — mask
// DATE_MASK only; this is the unmasked-timeline pixel gate);
// audio-recording transport state (fake media device; if MediaRecorder path
// fails headless, SKIP with test.skip and log the coverage loss in the ledger).

test.describe('forced interaction states (desktop only)', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 768, 'hover shots are desktop-only');
  test('category button hover', async ({ page }) => {
    await createSession(page);
    await rollAndLog(page);
    const btn = page.locator('#cat-strip-live-slot [data-category-id]').first();
    await btn.hover();
    await prepareForShot(page);
    await expect(page).toHaveScreenshot('hover-category.png', { clip: (await btn.boundingBox())! });
  });
  // same shape: transport-button hover (#btn-ctl-2), feed-row hover (tr[data-event-id])
});
```

Each `// ...` block above must become a real test before baselines freeze — the comment lists the complete required state inventory from the spec (desktop set; the mobile project runs the same specs at 390×844, which exercises the Dialog bottom-sheet and V6Rail drawer automatically; add one explicit `mobile rail drawer open` test tapping the rail toggle).

- [ ] **Step 5: Stabilize, then freeze.** Run `npm run e2e:visual:update` twice back-to-back, then `npm run e2e:visual` three times; all three must pass with `maxDiffPixels: 0`. Any flaky shot gets a *minimal* per-shot `maxDiffPixels` (≤ `maxDiffPixelRatio: 0.001` equivalent) or a tighter mask — recorded in a comment at the assertion.

- [ ] **Step 6: Red-ability check.** Temporarily change `--v5-primary` in `tokens.css` to `#ff0000`, run `npm run e2e:visual`, confirm multiple shots FAIL. Revert. This proves the harness can catch a real regression.

- [ ] **Step 7: Run full GATES**, commit `feat(e2e): visual regression harness + frozen baselines, two viewports (spec stage 0b)` (PNGs included) and merge.

---

### Task 4: Tailwind v4 wiring + legacy cascade layer (stage 0c)

**Files:**
- Modify: `web/package.json` (add `tailwindcss`, `@tailwindcss/vite`)
- Modify: `web/vite.config.ts` (register plugin)
- Create: `web/src/shared/theme/tailwind.css`
- Modify: `web/src/pages/index/main.tsx`, `web/src/pages/admin-users/main.tsx` (swap side-effect imports)
- Modify: all 23 `web/src/**/*.module.css` (wrap in `@layer legacy { … }` — Tasks 1–3 delete rules, not files, so the full count survives to here)
- Modify: `web/src/pages/index/AppShell.tsx` (its `bgGlow.css` side-effect import moves to `tailwind.css` — read the comment there explaining why it lives in AppShell before relocating)
- Modify: `web/src/shared/theme/tokens.css` (remove `--font-poppins`/`--font-league-gothic` — they move into `@theme`)

**Interfaces:**
- Consumes: audit section K (rename table), frozen baselines (Task 3).
- Produces — **the vocabulary every conversion task uses**: theme utilities `bg-*/text-*/border-*` for `--color-bg|surface|surface-raised|surface-btn|border|text|muted|accent|accent-dim|danger|v5-bg|v5-text|v5-muted|v5-soft|v5-primary|v5-primary2|v5-danger|v5-line|v5-border|v5-border-strong`; `font-sans|font-mono|font-poppins|font-league-gothic`; `rounded-app|rounded-v5-lg|rounded-v5-md|rounded-v5-sm|rounded-v4-9|rounded-v4-10`; custom variant `hover-always:`; named utilities `glass-face`, `glass-face-strong`, `glass-face-aside`, `shadow-glow-v5`, `panel-elevate`; breakpoint `md` = 768px (so `max-md:` ≡ the repo's `max-width: 767px`).

- [ ] **Step 1: Install.** `npm install -w web tailwindcss @tailwindcss/vite`. If the peer range rejects Vite 8 (it should not — peer widened 2026-03), fall back to `npm install -w web tailwindcss @tailwindcss/postcss` and wire via `postcss.config` instead; log the deviation.

- [ ] **Step 2: Register the plugin** in `web/vite.config.ts`:

```ts
import tailwindcss from '@tailwindcss/vite';
// ...
plugins: [react(), tailwindcss()],
```

- [ ] **Step 3: Create `web/src/shared/theme/tailwind.css`:**

```css
/*
 * Tailwind v4 entry (spec stage 0c). Layer order is the hybrid-period contract:
 * ALL legacy CSS lives in `legacy`, lowest — converted utilities always win.
 * Preflight is intentionally absent (baseline.css is our base layer until slice 6).
 */
@layer legacy, theme, base, components, utilities;

@import './tokens.css' layer(legacy);
@import './baseline.css' layer(legacy);
@import './chrome.css' layer(legacy);
@import './bgGlow.css' layer(legacy);

@import 'tailwindcss/theme.css' layer(theme);
@import 'tailwindcss/utilities.css' layer(utilities);

@theme {
  /* md boundary matches the repo's single 767px breakpoint (max-md: ≡ max-width:767.9px). */
  --breakpoint-md: 768px;

  /* Moved out of tokens.css (same-name namespace tokens can't be defined twice): */
  --font-poppins: 'Poppins', 'SF Pro Text', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --font-league-gothic: 'League Gothic', sans-serif;
  --font-sans: 'SF Pro Text', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}

/* Hybrid-period aliases: values live in tokens.css (single source of truth);
 * `inline` makes utilities emit var(--legacy-name), resolved at the usage site.
 * Slice 6 (Task 11) inlines the literal values and deletes tokens.css. */
@theme inline {
  --color-bg: var(--bg);
  --color-surface: var(--surface);
  --color-surface-raised: var(--surface-raised);
  --color-surface-btn: var(--surface-btn);
  --color-border: var(--border);
  --color-text: var(--text);
  --color-muted: var(--muted);
  --color-accent: var(--accent);
  --color-accent-dim: var(--accent-dim);
  --color-danger: var(--danger);
  --color-v5-bg: var(--v5-bg);
  --color-v5-text: var(--v5-text);
  --color-v5-muted: var(--v5-muted);
  --color-v5-soft: var(--v5-soft);
  --color-v5-primary: var(--v5-primary);
  --color-v5-primary2: var(--v5-primary2);
  --color-v5-danger: var(--v5-danger);
  --color-v5-line: var(--v5-line);
  --color-v5-border: var(--v5-border);
  --color-v5-border-strong: var(--v5-border-strong);
  --font-mono: var(--mono);
  --radius-app: var(--radius);
  --radius-v5-lg: var(--v5-radius-lg);
  --radius-v5-md: var(--v5-radius-md);
  --radius-v5-sm: var(--v5-radius-sm);
  --radius-v4-9: var(--v4-radius-9);
  --radius-v4-10: var(--v4-radius-10);
}

/* The repo's dominant hover flavor: fires on touch-tap too (only chrome's .btn
 * trio is (hover:hover)-guarded — audit G). */
@custom-variant hover-always (&:hover);

/* Compound tokens that can't be single-property utilities (audit K). */
@utility glass-face {
  background: var(--v5-glass-face);
}
@utility glass-face-strong {
  background: var(--v5-glass-face-strong);
}
@utility glass-face-aside {
  background: var(--v5-glass-face-aside);
}
@utility shadow-glow-v5 {
  box-shadow: var(--v5-shadow-glow);
}
@utility panel-elevate {
  box-shadow: var(--v5-panel-elevate);
}
```

- [ ] **Step 4: Move the font tokens.** Delete `--font-poppins` and `--font-league-gothic` lines from `tokens.css` (their `@theme` copies now emit the same `:root` variables for the 9 legacy CSS consumers).

- [ ] **Step 5: Swap the entrypoint imports.** In both `main.tsx` files replace the `tokens.css`/`baseline.css`/`chrome.css` side-effect imports with a single `import '@/shared/theme/tailwind.css';` (keep the `animate.min.css` import in index's main.tsx). Remove the `bgGlow.css` import from `AppShell.tsx` (line ~15; read its comment first — it records why the import was deliberately placed there) — it now arrives via `tailwind.css`.

- [ ] **Step 6: Wrap every module file in the legacy layer.** Mechanical transform on all 22 `*.module.css`: first line becomes `@layer legacy {`, a closing `}` is appended, and the body is left *unindented* (minimal diff). Script it:

```bash
for f in $(find web/src -name '*.module.css'); do
  printf '@layer legacy {\n' | cat - "$f" > "$f.tmp" && printf '\n}\n' >> "$f.tmp" && mv "$f.tmp" "$f"
done
```

Then verify `composes: glassPanel from '../theme/glass.module.css'`-style lines still build (composes is a build-time name reference; the layer wrap must not break it — if it does, hoist the `composes` target file's wrap so the class stays at top level and log the deviation).

- [ ] **Step 7: Prove the no-op.** `npm run e2e:visual` — every frozen baseline must pass. This single run proves: no Preflight leaked in, the layer wrap preserved the legacy-internal cascade, and the `@theme` variable emissions are value-identical. Then run the remaining GATES.

- [ ] **Step 8: Commit** `feat(web): tailwind v4 wiring — @theme inline aliases, legacy cascade layer, hover-always variant (spec stage 0c)` and merge.

---

### Task 5: Slice 1a — Toast (worked exemplar)

**Files:**
- Modify: `web/src/shared/components/Toast.tsx`
- Delete: `web/src/shared/components/Toast.module.css`
- Modify: `web/src/shared/theme/tailwind.css` (add the `toast-enter` animation token)

**Interfaces:**
- Consumes: Task 4 vocabulary.
- Produces: the canonical conversion example every later task imitates; `--animate-toast-enter` theme token.

- [ ] **Step 1: Add the keyframes token** to `tailwind.css` inside the existing `@theme` block:

```css
  --animate-toast-enter: toast-enter 0.18s ease-out;
  @keyframes toast-enter {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
```

- [ ] **Step 2: Convert the JSX.** In `Toast.tsx`, replace the `styles` import with `import clsx from 'clsx';` and swap the render (source rules: `Toast.module.css` — `.toastQueue`, `.toast`, `.toast.error`, `@keyframes toastEnter`):

```tsx
  return createPortal(
    <output
      id="toast-queue"
      aria-live="polite"
      className="pointer-events-none fixed right-5 bottom-5 z-(--z-toast) flex max-w-[min(90vw,360px)] flex-col items-end gap-2"
    >
      {entries.map((entry) => (
        <div
          key={entry.id}
          className={clsx(
            'glass-face-strong animate-toast-enter pointer-events-auto w-full rounded-v5-sm border px-[0.9rem] py-[0.65rem] text-[0.85rem] leading-[1.35] shadow-[0_8px_32px_rgba(0,0,0,0.35)]',
            entry.isError ? 'border-danger text-[#ffb4b4]' : 'border-v5-border text-v5-text',
          )}
        >
          {entry.message}
        </div>
      ))}
    </output>,
    document.body,
  );
```

Conversion notes that generalize (cite these when prompting sub-agents): `right: 1.25rem` → scale `right-5`; `padding: 0.65rem 0.9rem` → arbitrary `px-[0.9rem] py-[0.65rem]` (no scale match); `var()` fallbacks dropped; the `body > *` stacking rule that used to defeat `position: fixed` here is in `@layer legacy`, so `fixed`/`z-(--z-toast)` now win by layer order — this is the cascade contract working as designed.

- [ ] **Step 3: Delete `Toast.module.css`.** Grep for orphans: `grep -rn "Toast.module" web/src` → zero hits.

- [ ] **Step 4: Run GATES.** The toast shot must match its frozen baseline (entry animation is disabled in shots; the animation token exists for real users).

- [ ] **Step 5: Commit** `feat(web): tailwind slice 1a — Toast (exemplar)` and merge.

---

### Task 6: Slice 1b — remaining shared leaves: Tooltip, Popover, Dialog, Select + FpsSelect, glass-panel

**Files:**
- Modify: `web/src/shared/ui/Tooltip.tsx`, `Popover.tsx`, `Dialog.tsx`, `web/src/pages/index/components/Select.tsx`, `FpsSelect.tsx`, `web/src/shared/theme/tailwind.css`
- Delete: `web/src/shared/ui/Tooltip.module.css`, `Popover.module.css`, `Dialog.module.css`, `web/src/pages/index/components/Select.module.css`, `web/src/shared/theme/glass.module.css`

**Interfaces:**
- Consumes: recipe + Task 4/5 vocabulary.
- Produces: `@utility glass-panel` (ports `.glassPanel` verbatim — it was `composes`-consumed by all four modules being deleted here, so the file dies in this slice); `--animate-*` tokens `tooltip-fade-in`, `popover-fade-in`, `overlay-fade-in`, `content-fade-in`, `sheet-slide-up`.

Task-specific hazards (from the audit):
- **Dialog** is the mobile-critical component: `.sheetContent.sheetContent` (double-class specificity vs consumer transforms), `sheetSlideUp`, `.dragHandle::before` pill (→ small `@utility` or `before:` utilities), `:focus-visible` rules. Its consumers' still-legacy override rules (`NewSessionModal.module.css` transform, `HomeSettingsModal` top/left) are in `@layer legacy` and now LOSE to Dialog's utilities — but those overrides were the *desktop positioning* of those modals. **Read them before converting:** any consumer rule that must keep winning (modal desktop position) must be replicated in that consumer's `className` prop passed into Dialog *in this same task* (the Dialog wrapper already accepts consumer classNames), as utilities so they participate in the same layer. Verify against the desktop + mobile modal baselines.
- **Select** carries the Radix `data-*` state matrix (audit J) → `data-[state=open]:`, `data-[disabled]:`, `data-[highlighted]:` variants; one unguarded hover (`.trigger:hover:not([data-disabled])`) → `hover-always:`.
- **Popover/Tooltip**: portal content; entrance animations → theme tokens; `PopoverItem` unguarded hovers → `hover-always:`.
- **FpsSelect** has no CSS of its own (prop pass-through) — verify only.

- [ ] **Step 1:** Add `@utility glass-panel { … }` to `tailwind.css` by porting the `.glassPanel` block from `glass.module.css` verbatim (locate by content), and add the five animation tokens with their keyframes.
- [ ] **Step 2:** Convert Tooltip → GATES → commit. Convert Popover → GATES → commit. (Small, independent commits inside the one branch.)
- [ ] **Step 3:** Convert Dialog per the hazard note (desktop AND mobile baselines are the gate — the bottom-sheet is what slips silently). Replace `composes: glassPanel` consumers with `glass-panel` in the class lists.
- [ ] **Step 4:** Convert Select + verify FpsSelect.
- [ ] **Step 5:** Delete `glass.module.css`; grep `glass.module|glassPanel from` → zero.
- [ ] **Step 6:** Full GATES; commit `feat(web): tailwind slice 1b — Radix wrappers + glass-panel utility`; merge.

---

### Task 7: Slice 2 — simple index components

**Files:**
- Modify + delete module for: `TimecodeDisplay`, `MarkerNav`, `AudioSaveOverlay`, `RecentSessionsList`, `CategoryButtonStrip`, `TransportControls`, `V6Rail` (all under `web/src/pages/index/components/`), `web/src/shared/theme/tailwind.css` (animation tokens: `cat-btn-momentary-press`, `wf-label-pulse`, `rail-scrim-fade`)
- Modify (rule extraction only): `web/src/pages/index/AppShell.module.css` — its four `:global(.v4-search-input)` rules style V6Rail-emitted DOM and convert here, onto `V6Rail.tsx`'s JSX (contextual overrides move with their target); the rest of AppShell's module stays legacy until Task 10.

**Interfaces:**
- Consumes: recipe; ancestor-variant pattern `[#v4-log-session_&]:`, `[.v4-cat-buttons__scroll_&]:`, `[.v4-session-ctrl_&]:`.
- Produces: converted components that still emit every legacy ancestor/global class they carry today (retention rule) — later slices depend on `#cat-strip-live-slot`, `.v4-session-nav-btn` etc. surviving.

Task-specific hazards:
- **TimecodeDisplay**: after Task 2's dead-rule purge its `:global` block is gone — a plain local conversion.
- **CategoryButtonStrip**: two live ancestor contexts (`.v4-cat-buttons__scroll` scroll-strip vs `#v4-log-session #cat-strip-live-slot` live slot — audit A) become ancestor variants on `.catBtn`/`.catStrip` utilities; scrollbar pseudo-rules (`::-webkit-scrollbar*`) → a named `@utility cat-strip-scrollbar` in `tailwind.css`; momentary-press keyframe + its two `motion-reduce` guards; local `--cat` custom property (audit N) is runtime-set — keep the `style` prop mechanism untouched.
- **TransportControls**: entire button stylesheet is anchored on SessionWorkspace ancestors (audit A: 17 rules) → ancestor variants; the `::before` hover-wash layer → `before:` utilities with `hover-always:before:opacity-100`; `wfLabelPulse` de-duplicates into ONE theme token (the hash-scoping reason for duplication dies with the modules); 3 `!important` disabled-state rules → plain utilities (layer order now suffices — verify against baselines).
- **RecentSessionsList**: OverlayScrollbars `[data-overlayscrollbars-viewport]` layout rule → `@layer components` rule in `tailwind.css` (library-generated DOM, can't carry utilities); `[data-menu-open]`/`[data-open]` → `data-[...]` variants; rename-session Dialog override → consumer className utilities (same pattern as Task 6 modals).
- **V6Rail**: also owns the `.v4-search-input` conversion (see the AppShell.module.css extraction in Files) and its module-local 16-var `:root` block (recipe rule 3b — the named-`@layer components`-block escape hatch is the right call here). FIRST adjudicate the hyphen-case suspect rules (audit cross-cutting #4): in the running app, toggle rail collapse and check computed styles — if the `:global(.v6-app--rail-collapsed) .v6-rail-menu`-style rules truly never matched, delete them (they're dead) and convert only live behavior; if they DO match (audit wrong), convert them as ancestor variants. Record which in the commit message. Mobile drawer (`max-md:` block, `translateX`, scrim + `rail-scrim-fade`) is gated by the mobile baselines incl. the explicit drawer-open shot.
- **AudioSaveOverlay** + the `body.autologger-audio-saving` pointer-events lock (baseline.css, `!important`): the lock rule stays in legacy (it converts in Task 11 with baseline.css); only the overlay's own module converts here.

- [ ] **Step 1:** Convert in order TimecodeDisplay → MarkerNav → AudioSaveOverlay → RecentSessionsList → CategoryButtonStrip → TransportControls → V6Rail, running GATES + committing after each component (one branch, seven commits).
- [ ] **Step 2:** Merge `feat(web): tailwind slice 2 — simple index components`.

---

### Task 8: Slice 3 — modal cluster: NewSessionModal, HomeSettingsModal, EventOptionsModal, EventButtonsTable

**Files:**
- Modify + delete module for the four components; modify `web/src/shared/ui/RadioGroup.tsx` callers only if class-prop shapes change (headless — no module of its own).

**Interfaces:**
- Consumes: recipe; Dialog consumer-className pattern from Task 6.
- Produces: modals fully utility-styled; `EventButtonsTable` freed of its (already-purged) `#modal-app-settings` dead zone.

Task-specific hazards:
- **EventButtonsTable belongs here, not with the feed** (audit B/D: it's rendered by HomeSettingsModal; its `v5-feed-*` coupling was a stale claim). After Task 2's purge, the 12 dead `#modal-app-settings` rules — which carried all 35 of this file's `!important` flags — are already gone; what remains is modest: `.presetBtn` hovers (`hover-always:`), the row/table layout rules, and the live `.colDelete:global(.btn-icon.btn)` rule. Verify via the home-settings baseline (which includes this table).
- **NewSessionModal / HomeSettingsModal**: their `:global(.btn...)`/`.profile-select`/`.fps-select` reach-ins style *chrome classes inside the dialog*. Chrome itself converts in Task 11 — until then these modal-scoped overrides must keep winning over `chrome.css`: convert them as utilities on the actual elements (which keeps beating legacy chrome by layer order). The `.btn`/`.profile-select` class strings stay on the elements (retention rule — chrome.css still styles them elsewhere).
- **EventOptionsModal**: emits orphaned `v6-*` literal classes with no CSS (audit B) — style them fresh from the module's actual rules; leave the class strings (harmless) or drop them if no e2e/Companion hook greps match (`grep -rn "v6-opt\|v6-event-o" e2e/ server/src`).

- [ ] **Step 1:** Convert NewSessionModal → GATES (new-session baseline, both viewports) → commit.
- [ ] **Step 2:** Convert HomeSettingsModal + EventButtonsTable together (one dialog surface) → GATES → commit.
- [ ] **Step 3:** Convert EventOptionsModal → GATES → commit; merge `feat(web): tailwind slice 3 — modal cluster`.

---

### Task 9: Slice 4 — feed cluster (atomic)

**Files:**
- Modify: `FeedTable.tsx`, `EventLogSheet.tsx`, `EventLogRow.tsx`, `FeedShell.tsx`, `TranscribeFeed.tsx`, `TranscribeRow.tsx`, `TopicsFeed.tsx`, `TopicsRow.tsx`, `SessionWorkspace.module.css` (extract feed-override rules only), `web/src/shared/theme/tailwind.css`
- Delete: `FeedTable.module.css`, `EventLogSheet.module.css`

**Interfaces:**
- Consumes: recipe; ancestor variants.
- Produces: the `thModifier: keyof typeof styles` indirection (audit C2) is **dissolved** — `ColumnDef` gains a plain `thClassName?: string` of utilities; `FeedShell`'s global chrome classes (`v4-log-sheet`, `v5-event-feed*`) keep being emitted (SessionWorkspace's remaining non-feed rules and perfDebug still target them).

Task-specific hazards:
- Six files consume `FeedTable.module.css` (audit C1) — all conversions land in this one slice; grep `FeedTable.module|EventLogSheet.module` → zero before merge.
- **SessionWorkspace's feed-override rules convert here** (spec: contextual overrides move with their *target*): locate every `:global(...v5-event-feed...)`/`.v5-panel-main-title` rule in `SessionWorkspace.module.css` by content, convert each onto the feed-side JSX as `[#v4-log-session_&]:` variants, and delete those rules from the module (the rest of the file stays legacy until Task 10).
- Edit-mode + pending-delete cells: the `!important` background/color locks and `::after` strikethrough overlays — strikethroughs become `after:` utilities on the three cell types; the `!important`s were beating row-hover tints inside the same module, so plain utilities in class order suffice — the dedicated edit-mode/pending-delete baselines are the gate.
- Sort glyphs (`::after` content `' ↑'`) → `after:content-['_↑']` style utilities; OverlayScrollbars host comment block: keep behavior (box-sizing only).
- `EventLogRow`'s literal orphan classes (`sheet-cell-control sheet-input sheet-tc`, `btn-undelete-row`, `btn-delete`): check `grep -rn "btn-undelete-row\|btn-delete\|sheet-input" e2e/ server/src companion-module-autologger/ 2>/dev/null` — keep any that are hooks, drop the rest.

- [ ] **Step 1:** Dissolve `thModifier` → `thClassName` (typecheck-gated refactor, no visual change) → commit.
- [ ] **Step 2:** Convert FeedTable + rows + feeds → GATES (feed, transcribe, topics baselines) → commit.
- [ ] **Step 3:** Convert EventLogSheet + EventLogRow + FeedShell + the extracted SessionWorkspace feed rules → GATES (feed edit-mode, pending-delete, workspace baselines) → commit; merge `feat(web): tailwind slice 4 — feed cluster`.

---

### Task 10: Slice 5 — Timeline (5a), then SessionWorkspace + AppShell (5b)

**Files:**
- 5a: `Timeline.tsx` + `timeline/TimelineMarkers.tsx`, `TimelineClips.tsx`, `TimelineTicks.tsx`, `TimelineWaveform.tsx`; delete `Timeline.module.css`; modify `SessionWorkspace.module.css` (rule extraction: the deck/meta/export rules it hosts for Timeline-emitted classes — `.v4-episode`, `.v4-session-date`, `.v4-playback-deck-header/-title`, `.v5-deck-title-cluster/-session-meta/-meta-sep`, `.v5-studio-name-inline`, `.v5-session-date-inline`, `.v5-btn-export-log`, `.v5-session-timeline-stack` (audit B) — convert onto Timeline's JSX in 5a and are deleted from the module here); `tailwind.css` (tokens: `marker-msg-marquee`, `v5-timeline-mock-shimmer`, `wf-label-pulse` if not already present; perf-debug handling)
- 5b: `SessionWorkspace.tsx`, `AppShell.tsx`; delete `SessionWorkspace.module.css`, `AppShell.module.css`

**Interfaces:**
- Consumes: everything above; the two-mode ancestor variant pattern at scale.
- Produces: only theme-layer CSS (chrome/baseline/bgGlow/tokens/perfDebug) remains unconverted.

Task-specific hazards:
- **Timeline's ~50-rule `:global(#v4-log-session)` block is self-referential** (audit A): the global ancestor was pure specificity armor for its own hashed locals. Under layers that armor is unnecessary — but the rules define the *session-context* look vs the standalone look. Convert them as `[#v4-log-session_&]:` variants so both modes survive. The seeked-paused timeline baseline is the pixel gate; `body[data-hide-internal]` marker rule → `[body[data-hide-internal="1"]_&]:`-style variant (verify Tailwind v4 accepts the attribute ancestor form; if not, a 3-line `@layer components` rule with a why-comment).
- **Perf-debug `!important` block inside Timeline.module.css** (28 declarations, lines ~1500–1556): these must beat utilities. Move them to a dedicated `@layer components` block in `tailwind.css` under a `/* perf-debug toggles — must override utilities; !important is the toggle contract */` comment, keeping `!important`. They join perfDebug's own module in Task 11.
- **Local custom properties stay local** (audit N): `--timeline-clip-strip-h`, `--v5-timeline-r`, `--mcol`, `--marker-glow-col` etc. are runtime/component vars — utilities reference them via `(--name)` shorthand; the TSX `setProperty` calls are untouched.
- **Dynamic inline styles are out of scope** (spec): playhead transforms, marker positions, waveform geometry all stay as `style` props.
- **5b AppShell**: `v6WorkspaceTopBarVoid` `!important` zero-height war vs `.v4-top-bar` min-height — both rules are AppShell's own; convert together and drop the flags. Its `:global(.muted)` rule (multi-emitter utility class — audit B) converts to a `@layer components` `.muted` rule in `tailwind.css` (emitters span RecentSessionsList/HomeSettingsModal — a class family, not a single element). `body > *` stacking and `html`/`body` rules live in baseline.css — NOT this slice.
- **5b SessionWorkspace**: transport-state `body[data-v4-transport]` rules — the attribute is static (`"rolling"` in index.html; audit headline). Convert the rules as-written into a small `@layer components` block (attribute-ancestor selectors over many descendants; commented) and add a ledger note: *post-migration parity question — attribute never updated by JS in this port*. The `min-height: 0 !important` flex-chain quintet: convert as plain `min-h-0` utilities on the elements (they were fighting legacy rules that are converting in the same slice).

- [ ] **Step 1 (5a):** Convert Timeline + the four sub-components (they all share the one module — one commit) → GATES → commit `feat(web): tailwind slice 5a — timeline`.
- [ ] **Step 2 (5b):** Convert SessionWorkspace, then AppShell → GATES after each → commits; merge `feat(web): tailwind slice 5 — big two`.

---

### Task 11: Slice 6 — theme layer endgame

**Files:**
- Modify: `web/src/shared/theme/tailwind.css` (chrome `@utility` set, base layer, perf-debug block, literal token values)
- Modify: `web/src/pages/admin-users/AdminUsersPage.tsx`, `web/src/pages/index/components/ExportModal.tsx`, `TranscribeModal.tsx`, `YouTubeImportErrorModal.tsx`, `web/src/shared/utils/perfDebug.ts` consumers as needed
- Modify: 4 TSX files with `var(--token)` inline styles: `Timeline.tsx`, `timeline/TimelineMarkers.tsx`, `NewSessionModal.tsx`, `EventLogRow.tsx`
- Delete: `web/src/shared/theme/chrome.css`, `baseline.css`, `bgGlow.css`, `tokens.css`, `web/src/shared/utils/perfDebug.module.css`

**Interfaces:**
- Consumes: everything.
- Produces: the end state. Chrome vocabulary as named utilities: `@utility btn` (+ `btn-primary`, `btn-danger` handled as the same class family — keep emitting `btn primary` strings? NO: this slice may finally normalize; see step 2), `@utility field`, `@utility panel`, `@utility profile-select`, `@utility tool-row`, `@utility modal-actions`, `@utility mono`… (multi-consumer classes per audit B); one-offs (`.tagline`, `.crumb`, `.developer-*`) inline into AdminUsersPage.

- [ ] **Step 1: chrome.css → named utilities.** For each multi-consumer class (audit B: `btn` 12+ files, `field`, `mono`, `profile-select`, `tool-row`, `modal-*`, `fps-*`, `num`, `settings-*`, `admin-*`, `shell`, `header`, `brand-*`, `footer`, `faint`, `hint`-compounds): port the rule block (including its `(hover:hover)` guards, `disabled:` overrides, and the `max-md:` touch-target floor) into `tailwind.css`, **keeping the exact class names emitted today** (JSX emits `"btn primary"`; renaming every call site is churn without benefit). **Class families with compound variants live entirely in `@layer components` as plain rules** — `.btn`, `.btn.primary`, `.btn.danger`, `.btn:disabled` together — NOT as `@utility` + components-layer compounds: `@utility` output lands in the `utilities` layer *above* `components`, so a split family would have base declarations beating the compounds by layer order and primary/danger buttons would render as default buttons. (Per-element utility overrides from earlier slices still win from the utilities layer — that contract is unchanged.) Variant-free multi-consumer classes (`mono`, `tool-row`, `modal-actions`, …) may use `@utility` or the same components block — pick one per family and comment it. Delete `chrome.css` when its last rule is ported; JSX class strings stay unchanged.
- [ ] **Step 2: Convert the chrome-only consumers** — AdminUsersPage (also style the orphaned `admin-table`/`header-home` from scratch to match current rendered look: they currently have NO rules, so "match current" = keep them rule-less; just verify the admin baseline), ExportModal, TranscribeModal, YouTubeImportErrorModal (their static inline `style` props → utilities, per spec). GATES per component.
- [ ] **Step 3: perfDebug.** Convert `perfDebug.module.css`'s panel/fab locals to utilities in its TSX; move its `:global(body.perf-dbg--*)` toggles + bgGlow's one + Timeline's block (parked in Task 10) into one commented `@layer components` perf-debug section keeping `!important`. Delete the module.
- [ ] **Step 4: baseline.css + bgGlow.css → `@layer base`** in `tailwind.css`: `@font-face` blocks verbatim; body baseline; noise `body::before`; `body > *` stacking; global `:focus-visible` ring; `-webkit-tap-highlight-color`; `overscroll-behavior`; `.hidden` (keep `!important`, move to `@layer components` — it must beat utilities); the audio-saving pointer-events lock (same treatment); the box-sizing reset once (currently duplicated in tokens+baseline). Delete both files; drop their `layer(legacy)` imports.
- [ ] **Step 5: Kill tokens.css.** Replace every `@theme inline` alias value with the literal from `tokens.css`; move all non-namespace tokens (`--v4-*`, `--v5-glass-*`, `--v5-shadow-glow`, `--v5-panel-elevate`, `--v5-aside-w`, `--v5-panel-*`, `--v5-timeline-lane-*`, `--z-*`) into a `:root { … }` block in `tailwind.css`; `--mono` needs no `:root` home — its value becomes the literal in `--font-mono` and its 5 CSS consumers are already converted by now (verify with a grep before dropping it); update the 4 TSX inline-style consumers to the theme names (`var(--accent)` → `var(--color-accent)`, `var(--muted)` → `var(--color-muted)`, `var(--text)` → `var(--color-text)`); delete `tokens.css` and its import. **Emission guarantee:** Tailwind prunes theme variables its source scanner doesn't see used, and raw `var()` strings in TSX inline styles are not utility candidates — so `--color-text`, `--color-muted`, and `--color-accent` must be declared in a `@theme static { … }` block (always emitted) rather than the pruned default. Gates: (a) `grep -rn 'var(--accent)\|var(--muted)\|var(--text)\|var(--mono)\|var(--bg)\|var(--v5-' web/src --include='*.tsx'` returns zero legacy names (local component vars from audit N are exempt — they're `--mcol`/`--cat`-style, not token names); (b) class strings carry no shorthand references to retired legacy tokens: `grep -rn '(--v5-line)\|(--accent)\|(--muted)\|(--mono)' web/src --include='*.tsx'` → zero (namespaced tokens have real utilities; shorthand is only for the `:root`-block tokens); (c) the built CSS still emits the TSX-consumed variables: `npm run build && grep -c -- '--color-accent\|--color-muted\|--color-text' web/dist/assets/*.css` ≥ 1.
- [ ] **Step 6: Drop the legacy layer.** `@layer legacy` is now empty: remove it from the declaration line. Remove `css.modules` from `web/vite.config.ts` and delete `web/src/types/css-modules.d.ts` once `find web/src -name '*.module.css'` returns nothing.
- [ ] **Step 7:** Full GATES incl. complete visual pass; merge `feat(web): tailwind slice 6 — theme layer endgame, css-modules retired`.

---

### Task 12: Completion — docs, version, unpin

**Files:**
- Modify: `CHANGELOG.md`, `package.json` (root version + `@playwright/test` back to caret), `README.md`, `CLAUDE.md` (CSS-architecture sections), `docs/superpowers/specs/2026-07-09-tailwind-migration-design.md` (ledger: deviations, coverage losses, the transport-attribute parity flag)

- [ ] **Step 1:** Final verification sweep: `find web/src -name '*.module.css'` → empty; `grep -rn 'styles\.' web/src --include='*.tsx' | grep -v '// '` → zero module references; **legacy-token sweep derived from audit section K's full left column** (all 85 names, not a hand-picked subset), run over ALL of `web/src` with no file-type filter — `for t in $(awk -F'|' '/^\| `--/{gsub(/[` ]/,"",$2); print $2}' docs/superpowers/plans/2026-07-10-tailwind-migration-coupling-audit.md | sort -u); do grep -rn -- "$t" web/src && echo "LEAK: $t"; done` → only audit-N local names and `@theme`-emitted new names may match (document each surviving match); full GATES.
- [ ] **Step 2:** Bump root `package.json` to `0.6.0`; CHANGELOG entry under `### Changed` (styling system migrated CSS Modules → Tailwind v4; visual parity; harness kept as opt-in `npm run e2e:visual` per gate decision E-1). Relax the Playwright pin to caret.
- [ ] **Step 3:** Rewrite README/CLAUDE.md styling sections to describe: `tailwind.css` layer architecture, `@theme` tokens, `hover-always`, named utilities, the visual harness + re-baseline policy (now free), and that `data-v4-transport` parity question.
- [ ] **Step 4:** Record implementation deviations in the spec's panel log (dated entry). Commit `docs: tailwind migration complete — v0.6.0` and merge.

---

## Execution notes

- Tasks 1–4 are strictly ordered. Tasks 5–11 are strictly ordered as slices (each assumes the prior merged). Within Task 7, components are independent and may be parallelized across sub-agents ONLY if each works on its own branch serially merged — simpler to keep serial.
- Every sub-agent prompt must include: the repo path, "locate quoted code by content — audit line numbers go stale", the Conversion Recipe section verbatim or by path, and the task's hazard list.
- If a visual diff fails and the conversion looks right: suspect (in order) a dropped `var()` fallback that was actually load-bearing (token undefined somewhere), an unguarded-vs-guarded hover mix-up, a `max-md:` boundary off-by-one, or a legacy rule that was winning via `!important` inversion in the legacy layer.
