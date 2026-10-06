# Design: shadcn port, modals

## Context

The motivation is in proposal.md. This is the state on 2026-10-06, from read-only surveys in this change and 3c-1.

**New Session and Batch Import**
- Both have a custom header: `hideTitle`, a visible `<h2>`, an inline SVG icon, and a hand-built × close (`aria-label="Close"`). Both use the `md:` rail-offset translate.
- Fields are `label.field` + native inputs with `NS_INPUT_OVERRIDE`.
- New Session's two disclosures are `DISCLOSURE_BTN` buttons with `aria-expanded` and an inline chevron.
- Its frame-rate group uses `.fps-*`, `.inline` and `.num`.
- Its submit is `btn primary` + `BTN_PRIMARY_SKY`, inside `.modal-actions`.

**Other modals**
- YouTube error: `.tool-row` rows, `btn` / `btn primary` / `btn danger`, and an unnamed URL input.
- Transcribe: `a.btn.primary` download, `.modal-actions`.
- Custom generate: `.modal-hint.muted` hints, and a native checkbox inside a wrapping `<label>` per candidate.
- Category note/dropdown: `.modal-lead`, `label.field` + `input.profile-select`, `.modal-dropdown-actions`.

**Shared wrappers:** ConfirmDialog and PromptDialog still use `.modal-lead` and `.modal-actions` around shadcn Buttons.

**Tests**
- NewSession mocks `Dialog` and `Select`. It queries `getByLabelText('Show')`, `getByText('Episode')`, `#ns-episode` and "Create & open".
- BatchImport renders the real Dialog and Select. It needs exactly one `button{name:'Close'}`, plus the `Show` label, the prompt textbox `/Google Sheets URL/`, "Use URL" and the testids.
- CustomGenerate counts `role=checkbox` and names one `/Cam A/`.
- Category modals, YouTube error and Transcribe have no tests.
- `apiResponseShapes.repo.test.ts` pins two TranscribeModal source lines and the YouTube error `apiFetch` call shapes.
- `contrastTokens.test.ts:122-125` regex-reads `BTN_PRIMARY_SKY` from `shared/theme/classnames.ts`.

## Goals / Non-Goals

**Goals:** every listed surface renders through the shared layer with the same ids, names, roles, copy and V5 look; the modal-only legacy CSS is deleted, and a guard keeps it from returning.

**Non-Goals:** see proposal.md. At the design level, no modal logic, request or Escape behaviour changes.

## Decisions

**D1. The 3c-1 pattern.**

| Legacy | Becomes |
| --- | --- |
| `label.field` + native input | `Field` + `FieldLabel htmlFor` + `Input id` |
| hints and leads | utility strings with the legacy computed values: `HINT` = `m-0 mb-[0.65rem] text-[0.78rem] leading-[1.45] text-legacy-muted`; `LEAD` = `m-0 mb-4 text-[0.82rem] leading-[1.45] text-legacy-muted` |
| `.btn` | outline `Button` |
| `.btn primary` (± `BTN_PRIMARY_SKY`) | default `Button` |
| `.btn danger` | destructive `Button` |
| `.modal-actions` | `DialogActions` |
| native checkbox | `Checkbox` + `FieldLabel htmlFor` (so its accessible name still comes from the label) |

- Every ported button gets `TOUCH_TARGET`.
- The custom close buttons become `Button variant="ghost" size="icon-sm"` with lucide `X`. Each modal still has exactly one control named "Close"; the shared Dialog renders no close button by default (shadcn-shared-wrappers).

**D2. New Session.**
- **Disclosures:** `Button variant="ghost"`, left-aligned, keeping `id`, `aria-expanded`, `aria-controls` (where present) and the summary text. A lucide `ChevronRight` gets `rotate-90` when open.
- **Frame-rate group:**
  - `Field` + `FieldLabel htmlFor="ns-fps-preset"` "Frame rate" around the existing `Select id="ns-fps-preset"`;
  - custom fps: `Field` + `FieldLabel htmlFor="ns-fps-custom"` "Custom fps" + `Input type="number"`, keeping its min/max/step and `autoFocus`;
  - offset: `Field` + `FieldLabel htmlFor="ns-offset"` "Start offset (frames)" + `Input type="number"`;
  - hint: `FieldDescription id="ns-fps-hint"`.
- **Publish date:** `Checkbox id="ns-yt-publish-date"` + `FieldLabel` with the same copy, in a horizontal `Field`.
- **Unchanged:** episode logic and ids, and `NS_INPUT_OVERRIDE` (it now overrides `Input`).
- **Added during implementation (task 2.1):** the New Session and Batch Import close control is `Button variant="outline" size="icon"` with lucide `X`, not ghost. The bordered 36px box matches today's × look. Its name stays "Close", and it carries `TOUCH_TARGET`. Form spacing: the `.new-session-form .field` margin and the `.profile-select` bottom margin become `flex flex-col gap-3` on the form plus `mb-4` on the text inputs.
- **Test environment (panel finding):** a Radix `Checkbox` inside a `<form>` renders a bubble input that calls `useSize`, which needs `ResizeObserver`, and jsdom lacks it. `web/src/test/setup.ts` gains a guarded global stub (`globalThis.ResizeObserver ??= class { observe(){} unobserve(){} disconnect(){} }`). The ~15 suites with their own local stubs keep working, because the stub only fills an absent global.

**D3. Batch Import.** Show `Field` around the existing Select (still labelled "Show" through `aria-label`). Import Audio and Import Logs are outline `Button`s with `self-start`. Start Import is the default `Button` in `DialogActions`, above the progress region, so the spec order holds.

**D4. YouTube error and Transcribe.**
- **YouTube error:**
  - the URL input becomes `Input` with `aria-label="YouTube video link"`, a new accessible name for a control that had none (an a11y fix, no copy change);
  - `.tool-row` becomes `flex flex-wrap items-center gap-x-4 gap-y-3` (`.tool-row`'s exact 1rem column and 0.75rem row gaps), keeping the `mt-*`;
  - `apiFetch` calls untouched.
- **Transcribe:**
  - `Button asChild` wraps `<a href download>`;
  - `.tool-row.export-row.modal-export-actions` becomes a flex row with `mt-3`;
  - the two pinned lines are not edited, and the diff is checked for that.

**D5. Custom generate.** Each candidate becomes `Checkbox id="custom-gen-${key}"` + `FieldLabel htmlFor` wrapping the label and instruction spans, so `getByRole('checkbox', {name: /Cam A/})` resolves. The fieldset and legend are kept. Hints use `HINT`, keeping their exact curly-apostrophe copy.

**D6. Category modals.**
- Inputs get ids `category-note-input` and `category-context-input`, keeping `autoFocus` and Enter-submits. The existing `preventDefault` stays on TextModal; DropdownModal gains none, so behaviour is unchanged.
- The option list is `flex flex-col gap-[0.45rem] mb-3` with full-width outline `Button`s.
- The Escape step-back through `onOpenChange` is unchanged.

**D7. ConfirmDialog / PromptDialog.**
- Drawer path: `p.modal-lead` becomes `<p className={LEAD}>`.
- AlertDialog path: it becomes `AlertDialogDescription asChild > p.LEAD`.
- `.modal-actions` becomes `DialogActions` on both paths (it's a plain div, valid inside AlertDialogContent).
- PromptDialog gets the same `DialogActions`.

**D8. CSS deletion, the `BTN_PRIMARY_SKY` retirement, and the guard.**
- **Deleted rules:** the ones listed in proposal.md, from `shared/theme/tailwind.css`.
  - **Kept: `#v4-log-session .v5-panel-head__main`** (panel finding). FeedShell still emits `v5-panel-head__main` (`FeedShell.tsx:102`), and the rule supplies `min-width:0; flex:1 1 auto`, which `FEED_HEAD` does not replicate.
- **`classnames.ts`:** deleted. `contrastTokens.test.ts` drops its `BTN_PRIMARY_SKY` block, which is redundant with "primary-foreground on the sky-tinted primary surface" (`:160-164`): same `#e0f2fe` on the same `SURFACE.primaryButton`. The default `Button` renders `text-primary-foreground`.
- **Guard (attribute-aware, panel finding):** `shadcnHygiene.repo.test.ts` gains a `DELETED_LEGACY_CLASSES` list and asserts that no non-test source passes one as a whitespace-delimited token inside a **class argument**: the string literal or template of a `className=` attribute, or a string argument to `cn(`/`clsx(`.
  - **Ids are not scanned**, so the kept `id="new-session-form"` doesn't trip the guard.
  - **The list holds only distinctive names:** `modal-hint`, `modal-lead`, `modal-actions`, `modal-dropdown-actions`, `modal-export-actions`, `tool-row`, `export-row`, `tool-row-session-opts`, the seven `fps-*` names, `new-session-form`, `v5-panel-eyebrow`, `v4-log-top__capture`, `v4-log-top__playback`.
  - **Generic words are excluded:** `inline`, `num`, `wide` and `actions`. Once the `!important` legacy `.inline` rule is deleted, Tailwind's own `inline` utility is legitimate again.

## Assumptions (tested)

- **A1. Each deleted class has no consumer outside the files this change ports.**
  - Command: `grep -rnE "(className=|clsx\(|cn\(|['\"\` ])<class>(['\"\` ]|$)"` over `web/src` (non-test, comments excluded), per class.
  - Results:
    - `modal-hint` → EventGenerateCustomModal only;
    - `modal-lead` → CategoryButtonStrip, ConfirmDialog;
    - `modal-actions` → NewSession, CategoryButtonStrip, EventGenerateCustom, Transcribe, BatchImport, ConfirmDialog, PromptDialog;
    - `modal-dropdown-actions` → CategoryButtonStrip;
    - `modal-export-actions`, `export-row` → Transcribe;
    - `tool-row` → YouTubeImportError, Transcribe;
    - `fps-*`, `num`, `new-session-form` → NewSession;
    - `tool-row-session-opts`, `v5-panel-head`, `v5-panel-eyebrow`, `v4-log-top__capture/__playback` → 0.
- **A2. `inline` and `actions` are not class tokens elsewhere.**
  - `inline` is also a Tailwind utility, so the legacy `!important` `.inline` rule would hijack any Tailwind use. A tighter grep of className strings for a standalone `inline` token → only `NewSessionModal.tsx:365,387`.
  - A standalone `actions` token → only variable names (`ChunkLoadBoundary.tsx:91`, `perfDebug.ts:269`, which uses `perf-debug-panel__actions`).
- **A3. `BTN_PRIMARY_SKY` has two importers and a duplicate contrast check.**
  - `grep -rn "from.*shared/theme/classnames" web/src` → `BatchImportModal.tsx:6`, `NewSessionModal.tsx:7`.
  - `contrastTokens.test.ts:122-125` (classConst `BTN_PRIMARY_SKY` vs `SURFACE.primaryButton`) duplicates `:160-164` (`--primary-foreground` vs `SURFACE.primaryButton`, where `--primary-foreground` = `#e0f2fe` per 3c-1's foundation tokens).
- **A4. The TranscribeModal pinned lines and the YouTube error call shapes** are named in `apiResponseShapes.repo.test.ts` (~:1389-1393, ~:1454-1497). They are verified unchanged by running that test after the port (tasks 3.x).
- **A6. `v5-panel-head__main` is live (panel).** An AST scan of non-test string literals → `FeedShell.tsx:102 "v5-event-feed-head v5-panel-head__main"`; `sed -n 896,903p tailwind.css` → `min-width: 0; flex: 1 1 auto;`. Kept.
- **A7. A Radix Checkbox inside a form needs ResizeObserver under jsdom (panel).** A scratch test of Checkbox + FieldLabel in a `<form>` → `ReferenceError: ResizeObserver is not defined (use-size.tsx:14)`; with a stub → one accessible checkbox, a label click toggles it, no form submit.
- **A5. The test stubs stay in force.** NewSession mocks `shared/ui/Dialog`; the mock is extended with `DialogActions` (the same move as in 3c-1). BatchImport, CustomGenerate, Confirm and Prompt render the real wrappers.

## Risks / Trade-offs

- **[A deleted rule still styles something reached through a computed class string]** → A1/A2 greps, the new guard, and the QA diff of untouched screens (expected at 0%).
- **[A second "Close" control appears in Batch Import]** → The existing test asserts it; D1 keeps exactly one.
- **[Checkbox names change]** → D5 uses explicit `htmlFor`, and the existing `/Cam A/` query runs in the suite.
- **[Category modals and Transcribe can't be reached in QA while stopped or without instructions]** → New unit tests cover them, and the owner's dev-stack pass covers them live.

## Migration Plan

Web-only. Roll back by reverting the merge commit.
