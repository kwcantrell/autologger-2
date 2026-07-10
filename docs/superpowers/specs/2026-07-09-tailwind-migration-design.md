# Tailwind migration — design (sub-project 3)

**Date:** 2026-07-09
**Status:** Approved at the 2026-07-09 spec-review gate (escalations E-1/E-2 decided; see panel log)
**Parent:** `2026-07-09-node-port-and-frontend-adoption-design.md` (sub-project 3 summary)

## Goal

Convert the entire `web/` styling system from CSS Modules + plain shared CSS to
**Tailwind v4** with **visual parity**, shipped as incremental slices to `main`.

**End state ("done"):**

- Zero `*.module.css` files remain under `web/src/` (currently 23 files, 7,329 lines).
- The shared plain-CSS theme layer (`baseline.css` 303 lines, `chrome.css` 489,
  `bgGlow.css` 40, `glass.module.css` 43 — also one of the 23 module files —
  and `tokens.css` 133) is gone. Its contents live in Tailwind's layer system: scalar
  tokens with a matching namespace in `@theme`; tokens with no namespace (`--z-*`, the
  `--v4-*` layout values, alpha-composited lines, compound gradient/shadow stacks) in a
  plain `:root` block inside `tailwind.css`; shared multi-consumer classes as named
  `@utility` / `@layer components` rules; body baseline and fonts in `@layer base`.
- `clsx` composition is kept — same call sites, class strings swapped.
- Visual diffs green against the frozen baselines at every merge (desktop + mobile
  viewports; see stage 0b).
- No server, API, or DOM-structure changes. Stable ID/data-attribute hooks
  (`#v4-log-sheet`, `tr[data-event-id]`, `#v3-session-grid`, `#btn-ctl-*`,
  `[data-category-id]`, …) are untouched — e2e and Companion selectors keep working —
  and are **never** removed as part of class cleanup.
- A repo-wide grep for legacy token names (`var(--accent)`, `var(--muted)`, …) returns
  zero hits in both CSS **and TSX** — inline `style` props in `Timeline.tsx`,
  `TimelineMarkers.tsx`, `NewSessionModal.tsx`, and `EventLogRow.tsx` consume legacy
  token names via `var()` and are swept to the final names in the last slice.

**Decisions locked at the brainstorm gate:** full conversion (not hybrid); screenshot
regression harness (not manual eyeballing); incremental slices merged to `main` (not one
long-lived branch); theming approach A — `@theme` + `@utility` (not arbitrary-value
passthrough, not a wholesale `@layer components` rewrite).

## Non-goals / out of scope

- No visual redesign — parity is the acceptance bar, not an opportunity to "improve".
- **Dynamic** inline `style` props (timeline positioning math, playhead transforms,
  waveform SVG geometry) stay as-is — layout computation, not styling. **Static** inline
  `style` props (e.g. `AdminUsersPage.tsx` margin/opacity/flex literals) convert to
  utilities like any other static styling.
- No cross-browser matrix: chromium only, two fixed viewports (desktop + mobile). The
  harness is a migration safety net, not a permanent visual QA suite; post-migration it
  survives only as the opt-in `npm run e2e:visual` project (gate decision E-1).
- `animate.css` (used for `animate__pulse` in `SessionWorkspace.tsx`) is an animation
  library, not app styling: it is **kept**, vendored locally in stage 0a (off the cdnjs
  CDN) and never converted.
- The Python repo's frontend copy (`../autologger/frontend`) is untouched; this repo's
  `web/` is canonical. **Its docs are also non-authoritative:** panel review showed this
  `web/` tree has diverged (the `.v6-workspace-modal*` cluster described in the parent
  CLAUDE.md no longer exists here). Coupling facts come from the stage-0a audit of this
  repo, never from inherited descriptions.
- No change to the e2e smoke suite's behavioral scenarios (they keep passing unmodified).

## Stage 0a: pre-flight (before baselines)

Everything that must be true *before* baselines are frozen, because it changes pixels or
inventory:

1. **Self-host the network fonts.** `web/src/pages/index/index.html` currently loads
   Inter, Oswald, and Roboto from Google Fonts — and Inter is the first-choice family in
   `baseline.css`, `FeedTable`, `TimecodeDisplay`, `CategoryButtonStrip`, and `Timeline`.
   Vendor the same woff2 files into the repo (as Poppins/League Gothic/Chivo Mono already
   are), drop the CDN links. Same bytes → same rendering, and baselines become
   network-independent. Vendor `animate.css` the same way.
2. **Dead-rule audit.** Rules with no live consumer are deleted, not converted, with the
   normal gates proving no-op. Known candidates from panel review:
   `:global(.v3-cue-grid-panel)` rules in `CategoryButtonStrip.module.css` (no renderer
   left in `web/src`), `perfDebug.module.css`'s `:global(.toast)` (Toast emits only
   hashed classes), and `chrome.css`'s `.table-wrap` / `.new-session-panel` /
   `.modal-card` / `.log-form` (zero TSX consumers found — re-verify each before
   deleting).
3. **Coupling audit (written artifact).** A generated map, checked in next to the plan,
   of: every `:global()` rule and its target's owner; every cross-file class usage
   (which TSX files emit which global classes); every TSX `var(--token)` inline-style
   consumer; every `@media` block (`max-width: 767px` inventory); guarded vs unguarded
   `:hover` rules; known equal-specificity duplicate pairs (the documented
   `Timeline.module.css` ↔ `SessionWorkspace.module.css` bundle-order hazards); and a
   token rename table (legacy name → `@theme` namespace name, e.g. `--accent` →
   `--color-accent`, `--mono` → `--font-mono`, bare `--radius` → its new name). The
   slice map in the plan is derived from this artifact, not from memory or inherited
   docs.

## Stage 0b: screenshot regression harness (before any Tailwind code)

- New Playwright spec `e2e/visual.spec.ts` as a separate Playwright **project** in the
  root `playwright.config.ts`, reusing the hermetic `:8791` `webServer`. It runs via its
  own command (`npm run e2e:visual`), **not** inside default `npm run e2e` — so
  non-migration work on `main` is never blocked by migration baselines. Migration slices
  require both commands green.
- Uses `expect(page).toHaveScreenshot()` with **committed baseline PNGs** captured once
  against the pre-Tailwind build and **frozen for the whole migration**.
- **Viewports:** desktop (1280×720) and mobile (390×844 — below the repo's 767px
  breakpoint) for every state that has a `max-width: 767px` branch or `useIsMobile`
  behavior (Dialog bottom-sheet, V6Rail drawer, feed, workspace, chrome). Chromium only.
- **States covered** (deterministic, seeded through the same UI/API flows the smoke
  suite uses): home page with left rail and recent-sessions list; session workspace with
  seeded events; each modal — new-session, home-settings (including the event-buttons
  table inside it), event-options, **rename-session**, **export** — and the audio-save
  overlay; transport states **stop / play / rolling / audio-recording** (the
  `body[data-v4-transport="recording"]` layout flip included); timeline with markers and
  a selected event at a **seeked, fixed timecode while paused** (that's where timeline
  pixels are asserted); feed **edit-mode and pending-delete** row states; the
  **transcribe and topics feed variants**; `body[data-hide-internal="1"]`; a persistent
  toast; the admin-users page; and three forced-interaction shots (category-button
  hover, transport-button hover, feed-row hover) driven by **real interactions**
  (`page.hover()`, `locator.focus()`) — Playwright has no pseudo-state-forcing API, and
  class toggles can't trigger real `:hover` rules.
- **Determinism controls:** Playwright `animations: 'disabled'`; self-hosted fonts
  (stage 0a); all `<video>` elements paused and masked (the autoplaying webm loading
  video defeats `toHaveScreenshot`'s stable-frame retry — video regions carry no CSS
  signal worth the flake); the **rolling** shot masks time-driven regions (playhead,
  ticks readout, shimmer) and exists to cover rolling-state *chrome*, not timeline
  geometry; toasts use `toast.persistent` (auto-dismiss timers race the retry loop).
- **Tolerance & mask governance:** default tolerance is strict (0); a per-shot
  `maxDiffPixels` allowance is added only where anti-aliasing noise is demonstrated,
  capped at `maxDiffPixelRatio: 0.001`. Masks, tolerances, and baselines are all frozen
  together — any change to any of them mid-campaign requires an explicit, logged
  decision (see re-baseline policy).
- **Environment pin:** `@playwright/test` is pinned **exact** (no caret) for the life of
  the migration — a Chromium bump shifts anti-aliasing across every shot and is
  indistinguishable from a mass regression. Baselines are platform-suffixed; the
  campaign's baselines are captured and compared in the primary Linux dev environment
  only.
- **Re-baseline policy:** when a legitimate non-migration UI change lands on `main`
  mid-campaign, re-capture **only the affected shots**, via an explicit decision logged
  in the campaign ledger, with a human-reviewed before/after diff confirming only the
  intended change moved. Never re-capture the full set wholesale; a full re-capture
  under hybrid CSS would silently re-anchor "parity" to hybrid rendering.
- The harness must be **red-able**: before freezing baselines, temporarily perturb one
  CSS value and confirm the diff fails.

## Stage 0c: Tailwind setup + legacy layering

- Add `tailwindcss` + `@tailwindcss/vite` to the `web/` workspace; register the plugin
  in `web/vite.config.ts`. (Vite 8 peer support verified: tailwindcss PR #19790,
  2026-03-12. Fallback if install disagrees: `@tailwindcss/postcss`.) Tailwind v4 is
  CSS-first: no `tailwind.config.js`.
- New entry `web/src/shared/theme/tailwind.css`, side-effect imported from each page's
  `main.tsx`. It declares the layer order and imports Tailwind **without Preflight**:

  ```css
  @layer legacy, theme, base, components, utilities;
  @import 'tailwindcss/theme.css' layer(theme);
  @import 'tailwindcss/utilities.css' layer(utilities);
  ```

- **Preflight stays off permanently.** The app renders against `baseline.css`'s own
  reset assumptions; our own `@layer base` (absorbing `baseline.css` in the final slice)
  plays that role.
- **The `legacy` layer is the load-bearing hybrid mechanism.** Under the CSS cascade,
  *unlayered* author styles beat *all* layered styles regardless of specificity — so if
  legacy CSS stayed unlayered, every converted component would unconditionally lose
  every style collision until the last slice (panel blocker: `baseline.css`'s
  `body > * { position: relative; z-index: 1 }` would defeat a converted Toast's
  `fixed`; the global `:focus-visible` ring would defeat every focus-ring opt-out;
  `chrome.css`'s bare `input`/`textarea` rules would re-style converted form controls).
  Therefore **all legacy CSS moves into `@layer legacy`**, declared lowest:
  - The shared plain files (`tokens.css`, `baseline.css`, `chrome.css`, `bgGlow.css`)
    are imported from `tailwind.css` via `@import './x.css' layer(legacy)` (their
    `main.tsx` side-effect imports are removed at the same time).
  - Every remaining `*.module.css` file has its content wrapped in `@layer legacy { … }`
    — one mechanical stage-0c commit (or a small PostCSS auto-wrap if that proves
    cleaner; the plan decides).
  - Putting **all** legacy CSS in **one** layer preserves its internal cascade exactly
    (specificity and source order resolve within a layer as they did unlayered), so the
    wrap is a rendering no-op — **proven** by the frozen stage-0b baselines going green
    on this very commit. That ordering is why the harness (0b) precedes the Tailwind
    import (0c): an accidental Preflight pull-in or a layering mistake is caught by the
    first diff run.
  - Consequences to design around (in the plan): converted utilities now *always* beat
    legacy rules, so cross-component **contextual override rules convert with their
    target** — the component whose look they change — regardless of which module file
    hosts them (e.g. `SessionWorkspace.module.css`'s `:global(… .v5-event-feed …)` feed
    overrides convert in the feed slice as ancestor-variant utilities, not in the
    workspace slice). Overrides that must beat utilities from *outside* (the perf-debug
    `body.perf-dbg--*` toggles) either convert atomically with their targets in the
    final slice or use Tailwind's `!` important modifier — decided per case in the plan.
    `!important` rules in legacy CSS (`EventLogSheet` edit-mode cells) invert layer
    precedence — flagged in the coupling audit, handled in their slice.
- **`@theme inline` mapping:** scalar tokens with a matching namespace move into
  `@theme inline` as references to the legacy custom properties
  (`--color-v5-primary: var(--v5-primary);`). `inline` is the documented mode for
  var()-valued theme tokens (plain `@theme` resolves the var where the *theme* property
  is defined, not where the utility is used — the docs explicitly warn against it) and
  it makes utilities emit `var(--v5-primary)` directly, resolved at the usage site.
  Namespaces used: `--color-*`, `--font-*` (`--font-mono`, `--font-poppins`, …),
  `--radius-*`, `--shadow-*` (simple single-stack shadows only). There is no z-index
  namespace; `--z-*` and other non-namespace tokens are consumed via CSS-variable
  shorthand utilities (`z-(--z-toast)`, `border-(--v5-line)` — the bare form is the
  *color* form for `border-*`).
- **`tokens.css` is frozen for the whole campaign** — no per-slice `:root` edits, no
  per-token deletion ledger (a defined-but-unconsumed custom property is inert; the
  by-reference `@theme inline` definitions already guarantee one source of truth). The
  **final slice** deletes `tokens.css` in one move: namespace-token values are inlined
  into `@theme`, non-namespace tokens move to the `:root` block in `tailwind.css`, and
  the TSX inline-style `var()` consumers are swept to the final names (grep-gated: zero
  legacy token names repo-wide).
- **Compound tokens** — the glass gradient faces (`--v5-glass-face`, `-strong`,
  `-aside`), `--v5-shadow-glow`, `--v5-panel-elevate`, `--v5-glass-rim`, the noise
  overlay — become named `@utility` classes (`glass-face`, `shadow-glow-v5`, …).
  Note: today these reach components through **`ThemeProvider` context strings**
  (`glass.glass`, `glassStrong`, `shadowGlow` from `glass.module.css`), not CSS imports
  — converting them touches the `ThemeContextValue` contract, not import lines.
- `@font-face` declarations stay as plain CSS (moving into `@layer base` in the final
  slice).

## Migration order & slicing

Each slice = one branch off `main` → convert → gates green → merge. Gates per slice:
`npm run e2e:visual` (both viewports), `npm run typecheck`, `npm test`, `npm run e2e`,
`npm run lint`. The definitive slice map is derived in the plan from the stage-0a
coupling audit; the shape, corrected for the couplings panel review verified in *this*
repo's CSS:

1. **Shared leaf components:** `Toast`, `Tooltip`, `Popover`, `Dialog` (mobile
   bottom-sheet shots required — its `.sheetContent` double-class rule exists precisely
   to beat consumer transforms), plus the index-local `Select` + `FpsSelect`.
   *Not* `perfDebug` — its `:global` hooks target chrome/AppShell/workspace classes, so
   it converts in the final slice with its targets.
2. **Simple index components:** `TimecodeDisplay`, `CategoryButtonStrip`, `MarkerNav`,
   `TransportControls`, `RecentSessionsList` (rename-session dialog shots),
   `AudioSaveOverlay`, `V6Rail` (mobile drawer shots). Ancestor-context rules inside
   these files (`:global(.v4-cat-buttons__scroll)`, `:global(#v4-log-session
   #cat-strip-live-slot)`, `:global(.v4-session-aside)` typography) convert **in the
   same slice** as ancestor-scoped variants (`[#v4-log-session_&]:…` arbitrary variants
   or a named `@custom-variant`), keyed off ancestor DOM that already exists — no
   waiting on slice 5.
3. **Modals cluster (actual coupling):** `NewSessionModal`, `HomeSettingsModal`,
   `EventOptionsModal`, **and `EventButtonsTable`** — it is rendered by
   `HomeSettingsModal` and couples to `:global(#modal-app-settings)`, not to the feed.
   (The spec'd `.v6-workspace-modal*` cluster does not exist in this repo — dead
   remnant handled in the stage-0a audit.)
4. **Feed cluster, atomically:** `FeedTable` + `EventLogSheet` + `FeedShell`/row
   components (`EventLogRow`, `TranscribeRow`, `TopicsRow`, `TranscribeFeed`,
   `TopicsFeed` — TSX-only consumers, named in the plan) + the `:global(.v5-feed-*)` /
   `.v5-event-feed` chrome **including `SessionWorkspace.module.css`'s feed-override
   rules** (contextual-override rule above). Edit-mode / pending-delete `!important`
   styling converts here with its dedicated shots.
5. **The big two, as two slices:** 5a `Timeline` + its four sub-components (its
   `:global(#v4-log-session)` two-mode overrides convert here as ancestor variants);
   5b `SessionWorkspace` + `AppShell`. The documented equal-specificity duplicate pairs
   between these files are resolved deliberately (audit in hand), not left to bundle
   order.
6. **Theme layer last:** `glass.module.css` → `@utility` (+ `ThemeProvider` contract);
   `chrome.css` — **named-`@utility`-first**: multi-consumer classes (`.btn` — 42 uses
   across 12 files — `.field`, `.mono`, `.tool-row`, `.modal-actions`, …) become named
   `@utility` / `@layer components` rules preserving their variant/media structure;
   descendant and element-selector rules (`.panel h2`, `.field span`, bare
   `input`/`textarea`) get explicit owners (nested rules inside the named utility, or
   `@layer base`); only true one-off classes inline into their single consumer.
   `ExportModal` is styled purely by chrome classes — its shots gate this slice.
   `perfDebug` converts here with its targets. `bgGlow.css` and `baseline.css` →
   `@layer base`; `tokens.css` deleted per stage 0c; legacy `main.tsx` side-effect
   imports removed; `@layer legacy` is now empty and the declaration order line drops
   it.

A pause after any merged slice leaves a working hybrid app on `main`: legacy CSS in the
`legacy` layer, converted components in Tailwind's layers, interaction governed by the
explicit layer order rather than accident. Known residual: deleting module files
reorders the remaining legacy bundle, and equal-specificity duplicate pairs inside
`legacy` can still flip (documented `Timeline`/`SessionWorkspace` hazard) — the coupling
audit lists the known pairs, and the harness covers the affected states.

## Conventions

- Utilities inline in JSX; conditional state composed with `clsx` at the existing call
  sites.
- **Legacy class retention rule:** a converted component *keeps* emitting a legacy
  global class name as long as any unconverted CSS rule or JS/e2e/Companion hook still
  targets it (utilities layered above legacy win collisions predictably); the class is
  dropped only in the slice that converts or deletes its last remaining rule. Stable
  IDs and `data-*` hooks are never dropped.
- **`:hover` policy:** Tailwind v4's `hover:` variant is gated behind
  `@media (hover: hover)`. The repo deliberately distinguishes guarded hovers
  (chrome `.btn` pattern) from **unguarded** ones (`FeedTable`, `Timeline`,
  `NewSessionModal`, …) that must keep firing on touch. Guarded → `hover:`; unguarded →
  a named `@custom-variant` (e.g. `hover-always` = `&:hover`) so touch behavior is
  preserved. The coupling audit's guarded/unguarded inventory drives this; reviewers
  check variant *semantics*, not just presence.
- **Media-query policy:** the repo is desktop-first with `max-width: 767px` overrides.
  Convert them with `max-*` variants against a breakpoint matching the existing 767px
  boundary — do **not** restructure rules mobile-first; that inversion is the classic
  silent phone-breaker and the mobile shots exist to catch it.
- **Per-slice review checklist** for states pixels can't fully cover: `hover:` /
  `focus-visible:` / `active:` / `disabled:` / **`motion-reduce:`** variants diffed
  against the deleted module rules.
- Rules Tailwind cannot express inline (complex keyframes, `::before`/`::after` texture
  layers, scrollbar pseudo-elements, OverlayScrollbars integration) become named
  `@utility` or small `@layer components` rules in `tailwind.css` — named,
  token-referencing, and justified (an inline utility must not be able to serve).
- Class strings and Biome: `npm run lint` stays green per slice; configure Biome if
  formatting fights, never disable it.
- Every slice deletes its `*.module.css` file(s) and the corresponding
  `import styles from …` lines in the same commit — no orphaned module files. (The
  *file* is deleted; a legacy global class-name *string* may persist in JSX under the
  retention rule above — the two rules govern different things.) Each slice also
  enumerates **all** TSX files it touches (including moduleless consumers of shared
  styles) from the coupling audit.

## Testing & definition of done

- **Per slice:** the five gates above (visual on both viewports + typecheck + unit/int
  tests + smoke e2e + lint).
- **At completion:** final whole-app visual pass against the frozen baselines; repo-wide
  greps confirm zero `.module.css` files, zero `styles.` module references, zero legacy
  token names (CSS and TSX); version bump + CHANGELOG entry (Keep a Changelog;
  "Changed"); README + `CLAUDE.md` CSS-architecture sections rewritten;
  `web/src/types/css-modules.d.ts` and the Vite `css.modules` config removed; the
  `@playwright/test` exact pin relaxed back to caret.
- Post-migration harness fate: kept as the opt-in `npm run e2e:visual` project,
  excluded from default gates (gate decision E-1).

## Risks

- **Cascade-layer regressions during the hybrid** — the `legacy` layer is the designed
  answer; its no-op-ness is proven against frozen baselines on the stage-0c commit, and
  contextual overrides convert with their targets. Residual: legacy-internal
  bundle-order flips (known pairs audited; harness-covered states only).
- **Coverage holes** — mobile viewport added; audio-recording, edit-mode,
  pending-delete, transcribe/topics, rename/export modals added to the shot list.
  Residual risk concentrates in perf-debug developer states (accepted: code-review
  only), `prefers-reduced-motion` (checklist variant review), and non-chromium browsers
  (accepted: out of scope).
- **Harness rot** — exact Playwright pin, per-shot re-baseline policy with logged
  decisions, visual project isolated from default `npm run e2e`.
- **Timeline determinism** — timeline pixels asserted only in paused, seeked states;
  the rolling shot masks time-driven regions. If waveform rendering still proves
  nondeterministic, it gets masked with the loss logged.
- **7,300 lines is a long campaign** — every merged slice leaves `main` shippable; the
  campaign can pause indefinitely.

## Panel & review log

### 2026-07-09 — Adversarial panel (4 reviewers: requirements, assumptions, failure & abuse, scope/YAGNI)

Three of four reviewers independently found the cascade-layer inversion blocker; the
requirements reviewer independently falsified the spec's coupling claims against this
repo's actual CSS (they had been inherited from the Python repo's docs).

**Blockers/majors fixed in place:**

1. **Cascade-layer inversion** (assumptions #1 BLOCKER, failure #1 BLOCKER,
   requirements #6) — original spec left legacy CSS unlayered while utilities lived in
   `@layer utilities`; unlayered beats layered unconditionally, so every converted
   component would lose every collision until slice 6 (Toast vs `body > *`, focus-ring
   opt-outs vs global `:focus-visible`, form controls vs bare `input`/`textarea`,
   Dialog's mobile sheet vs `NewSessionModal`'s transform). → All legacy CSS moves into
   `@layer legacy`, lowest in the declared order; no-op proven against frozen baselines;
   contextual-override and legacy-class-retention rules added (stage 0c, Conventions).
2. **Stale coupling model** (requirements #1, failure #5) — `.v6-workspace-modal*`
   cluster doesn't exist here; `EventButtonsTable` belongs with `HomeSettingsModal`, not
   the feed; `v5-feed` chrome also lives in `SessionWorkspace.module.css`; "simple"
   leaves carry ancestor-context `:global` rules. → Slices re-cut; stage-0a coupling
   audit made the source of truth; ancestor-variant conversion convention added.
3. **Harness determinism false premises** (failure #2, requirements #3) — Google-Fonts
   Inter/Oswald/Roboto + cdnjs animate.css falsified "self-hosted fonts"; autoplaying
   webm defeats stable-frame retry; rolling playhead is server-time-driven; toast
   timers race. → Fonts + animate.css vendored in stage 0a; videos paused/masked;
   timeline pixels asserted paused-and-seeked only; persistent toast.
4. **Frozen-baseline rot** (failure #3, assumptions #7) — exact `@playwright/test` pin;
   per-shot re-baseline policy with logged decisions; visual project moved out of
   default `npm run e2e` into `npm run e2e:visual`.
5. **Mobile ungated** (failure #4 — a multi-part coverage finding also cited in fixes
   #6 and #7; requirements #4) — phone-first codebase with
   `max-width: 767px` branches everywhere and a min-width-inversion hazard. → Mobile
   viewport (390×844) added for all states with mobile branches; max-* media-query
   policy added.
6. **`hover:` semantics change on touch** (failure #4) — v4 gates `hover:` behind
   `(hover: hover)`; repo has deliberate unguarded hovers. → guarded/unguarded policy +
   `@custom-variant` for unguarded; audit inventory drives it.
7. **Missing shot states** (requirements #2, scope #6) — audio-recording transport
   state, rename-session + export modals, edit-mode/pending-delete rows,
   transcribe/topics variants, `data-hide-internal` added.
8. **`@theme` by-reference needs `inline`** (assumptions #3, failure #7) — docs warn
   plain `@theme` resolves var() at definition scope. → `@theme inline` specified.
9. **`@theme` renames break TSX `var()` consumers** (assumptions #2) — 4 TSX files use
   legacy names in inline styles; deletion rule was scoped to CSS only. → final-slice
   TSX sweep + repo-wide grep gate added to end state.
10. **Per-token deletion ledger over-built** (scope #1) — `tokens.css` frozen for the
    campaign, deleted once in the final slice; contradiction about non-namespace tokens
    resolved (`:root` block in `tailwind.css`).
11. **chrome.css conversion stance inverted** (scope #2) — named-`@utility`-first for
    multi-consumer classes (`.btn` 42×12 files), dead-rule audit added, descendant/
    element selectors given owners, ExportModal shot added.
12. **Stage-0 ordering contradiction** (requirements #5, assumptions #8) — harness (0b)
    now explicitly precedes Tailwind import (0c); Preflight-catch claim now true.
13. **Forced-pseudo-state mechanism didn't exist** (assumptions #6, scope #4,
    requirements) — replaced with real interactions (`page.hover()`, `locator.focus()`);
    kept at three shots.
14. **Tolerance/mask governance** (failure #6) — strict default, demonstrated-noise
    exceptions capped at 0.001 ratio, masks/tolerances frozen with baselines.
15. **Slice-5 size** (scope #5) — split into 5a (Timeline) / 5b (SessionWorkspace +
    AppShell); perfDebug moved to the final slice with its targets; Select/FpsSelect
    correctly labeled index-local; glass-via-ThemeProvider contract noted; static
    inline styles assigned (convert).

**Escalated to the gate (decided 2026-07-09):**

- **E-1 — Post-migration harness fate** (scope #3): the spec's non-goal ("not a
  permanent visual QA suite") contradicted the DoD ("stays after migration"). Options:
  (a) delete at completion; **(b) keep as the opt-in `npm run e2e:visual` project,
  excluded from default gates — recommended** (it already lives outside `npm run e2e`
  per fix #4, so keeping it costs nothing at the gate line); (c) fold into default
  `npm run e2e`. → **Decision (owner, 2026-07-09): (b) — kept as the opt-in
  `npm run e2e:visual` project, excluded from default gates.**
- **E-2 — Harness scope growth vs. locked brainstorm decision** (synthesis): fixes #5
  and #7 grew the harness (2 viewports, ~2× shot states) beyond the brainstorm-gate
  sketch ("one browser/viewport"). The panel judged this necessary for the parity
  mandate (the ungated mobile branch was a designated silent casualty); flagged for
  explicit owner confirmation rather than silently adopted. → **Decision (owner,
  2026-07-09): confirmed — two viewports and the expanded shot list stand.**

**Minors accepted as residual:**

- perf-debug developer states verified by code review only (no shots).
- Non-chromium browsers and real-device rendering out of scope.
- Legacy-internal bundle-order flips in uncovered states during the hybrid (known pairs
  audited; accepted for the campaign's duration).
- `prefers-reduced-motion` covered by checklist review, not pixels.
