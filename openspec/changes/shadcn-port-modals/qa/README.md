# shadcn-port-modals QA (task 5.1)

The walk is copied from the archived `shadcn-port-settings/qa`.

**New steps:**
- `new-session-other-fps`: both disclosures open, with "Other…" frame rate.
- `import-logs-prompt`: Batch Import → Import Logs, the themed PromptDialog.
- `settings-discard-confirm`: Settings switched to Test Team (so it's dirty) → Close shows the discard ConfirmDialog, declined with Escape and never confirmed.
- Touch probes for Create & open, Start Import and the confirm action.

A fresh **`before-modals`** baseline was captured on the unported code (`supabase-migration` at 5cb5fcc1 plus the artifacts commit). `after-modals` was diffed against it, one pass per width.

## Results

**Contrast:** 82 captures, with 0 failures apart from the out-of-scope user-data "Audio issue" (3.64, `filter-menu`).

**Touch floor at 390:** Create & open, Start Import, Save and row Remove are all 44px. The confirm action **went from 36px to 44px**: ConfirmDialog's shadcn Buttons had no phone floor before this change.

| Screen | 1440 | 390 | Note |
| --- | --- | --- | --- |
| new-session | 1.18% | 5.26% | Field/Input/Select, lucide Plus/X, the default-Button submit |
| new-session-expanded | 1.27% | 5.80% | ghost-Button disclosures (lucide chevron), Checkbox publish date |
| new-session-other-fps | 1.39% | 6.07% | labelled number Inputs and FieldDescription hint, which replace `.fps-*`/`.inline`/`.num` |
| batch-import | 0.34% | 1.74% | lucide Upload/X, outline imports, Start Import in DialogActions |
| import-logs-prompt | 0.18% | 5.14% | PromptDialog actions on DialogActions with the touch floor; Batch Import behind |
| settings-discard-confirm | 0% | 2.47% | ConfirmDialog sheet buttons gain the 44px floor (desktop alertdialog unchanged) |
| add-show-dialog / event-options-modal / reveal-in-feed | ≤ 0.03% | ≤ 0.03% | noise |
| the other 32 screens (home, rail, workspace, menus, Settings, teams, login, route states, **admin**) | 0% | 0% | untouched surfaces, including `/admin/users`, which still uses `.btn`/`.field`/`.profile-select` until 3c-2b |

**Found by the walk and fixed here:** the New Session "Custom fps" and "Start offset" inputs were pushed to the row's far edge. Two layout rules in the Field component caused it: a horizontal Field lets its label grow, and a vertical Field forces every child to full width. Fixed with `w-fit` rows and a plain-column frame-rate wrapper. The live check puts each input 6px after its label at 1440 and 390.

**Not reachable in the walk:**
- the category note and dropdown modals (rolling only);
- Custom generate (needs event instructions; Auto Generate is aria-disabled at rest);
- Transcribe;
- the YouTube error.

Unit tests cover them (task 3.x), and the owner's dev-stack pass covers them live.

## Owner review (task 5.2)

The owner did the dev-stack pass and reviewed the pairs (2026-10-06): "looks good".
- the category note and dropdown modals while rolling;
- Custom generate;
- Transcribe;
- a session-row Delete confirm;
- a YouTube import failure.
