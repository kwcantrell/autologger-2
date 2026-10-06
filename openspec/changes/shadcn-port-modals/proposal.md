# shadcn port, modals: session modals, shared confirm/prompt, and the legacy modal CSS

Tier: 1
Tier reason: a web-only presentation port onto the shared shadcn layer, inside existing contracts. It touches no `high_risk_paths`, wire format, auth or data, and no spec obligation changes (`skip_specs: true`). Removing `/admin/users` is split into 3c-2b, which is tier 2.

Approved-by: Kalen 2026-10-06

## Why

3c-1 ported Settings. The remaining modals still build their controls from the legacy chrome (`.btn`, `label.field` + `input.profile-select`, `.modal-hint`/`.modal-lead`/`.modal-actions`, hand-drawn SVGs, native checkboxes):
- New Session, Batch Import, the YouTube import error, Transcribe and Custom generate;
- the category note and dropdown modals;
- the shared ConfirmDialog and PromptDialog.

Porting them leaves `/admin/users` as the only consumer of `.btn`, `.field` and `.profile-select`. 3c-2b then deletes those classes along with the page.

## What Changes

**New Session** (`NewSessionModal.tsx`)
- **Header:** the custom header keeps its visible "New Session" heading, now with lucide `Plus`. The × close becomes a ghost icon `Button` (lucide `X`, still named "Close").
- **Fields:** Show, Episode, Notes and YouTube link become `Field` + `FieldLabel` + `Input`/`Select`. "Use the video's publish date…" becomes the shadcn `Checkbox`.
- **Disclosures:** the two disclosures become ghost `Button`s with a rotating lucide chevron. They keep `aria-expanded` and their summaries.
- **Frame-rate group:** Frame rate, Custom fps and Start offset get real labels; the hint becomes `FieldDescription`.
- **Submit:** "Create & open" is the default `Button` in `DialogActions`.

**Batch Import:** the same header treatment (lucide `Upload`, one Close), Show `Field`, outline Import Audio / Import Logs, and Start Import as the default `Button` in `DialogActions`. The control order and the progress region are unchanged.

**YouTube import error:** Button variants (Import and Try a different link are default, Continue without audio is outline, Don't create session is destructive). The retry link input gains an accessible name.

**Transcribe:** "Download CSV" is a `Button` wrapping its `<a download>`, and Cancel/Close sit in `DialogActions`.

**Custom generate:** labelled `Checkbox` candidates, utility hint text (same copy), outline Retry, and Cancel/Generate in `DialogActions`.

**Category note / dropdown modals** (`CategoryButtonStrip.tsx`): `Field`/`Input`, utility lead text, outline option buttons, and `DialogActions`. Escape still steps back from context to options.

**ConfirmDialog / PromptDialog:** utility lead text and `DialogActions`. Behaviour is unchanged.

**Every ported button** carries the 44px mobile floor (`TOUCH_TARGET`).

**Legacy CSS removed** (zero consumers after the port, or already zero):
- `.modal-hint`, `.modal-lead`, `.modal-actions`, `.modal-dropdown-actions`, `.modal-export-actions`;
- `.tool-row`, `.export-row`;
- the `.fps-*` family;
- `.inline`, `.num` / `.num.wide`, `.new-session-form .field`;
- `.actions`, `.tool-row-session-opts`, `.v4-log-session .btn*`, the unused `#v4-log-session .v5-panel-head`, `__actions` and `--controls` rules and the `.v5-panel-eyebrow` rules (`.v5-panel-head__main` stays, because FeedShell still uses it), `.v4-log-top__capture` / `__playback`.

A hygiene guard stops the deleted class names from returning. `shared/theme/classnames.ts` (`BTN_PRIMARY_SKY`) is deleted, along with its contrast check, which duplicated the existing `--primary-foreground` check.

Every existing element id, test id, label, accessible name, role and spec-named copy is preserved: "Create & open", the disclosure summaries, the Batch Import order and the themed prompt.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. This is a presentation port; every spec obligation on these surfaces holds unchanged. The `.openspec.yaml` declares `skip_specs: true`.

## Non-goals

- Removing `/admin/users`, and deleting `.btn*`, `.field`, `.profile-select`, `.settings-*`, `.admin-settings-block` and the page chrome it still uses. That's 3c-2b (tier 2).
- `.muted`, `.mono` and `.shell`, which RecentSessionsList, the workspace and AppShell still use.
- Any change to modal logic, request shapes, or the two `TranscribeModal` lines `apiResponseShapes.repo.test.ts` pins.
- Dashboards (3d) and the Assistant (4).

## Impact

- **Code:**
  - `NewSessionModal`, `BatchImportModal`, `YouTubeImportErrorModal`, `TranscribeModal`, `EventGenerateCustomModal`, `CategoryButtonStrip`;
  - `shared/ui/ConfirmDialog`, `shared/ui/PromptDialog`;
  - `shared/theme/tailwind.css` (rules deleted);
  - `shared/theme/classnames.ts` deleted.
- **Tests:**
  - existing suites keep their queries;
  - new tests: the category modals, the YouTube error and Transcribe modals (none existed), NewSession labels / checkbox / disclosures / actions, and the dialog-actions row in Confirm and Prompt;
  - the hygiene guard;
  - one redundant contrast block removed.
- **Dependencies:** none.
- **Visual:** small drift where `.btn`/`.profile-select` become Button/Input. The QA walk compares against a fresh before baseline.
