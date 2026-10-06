# shadcn-port-settings QA (task 4.1)

The walk is copied from the archived `shadcn-port-workspace/qa`. Its Settings section now does this:
- captures `settings-general-member` on the saved team (Youtube Studio, member view);
- switches the header Team picker to **Test Team**, which gives the owner view. The walk never saves; it leaves Settings by navigating away;
- captures the owner General and Event Buttons tabs, Suffix, AI Rules, the options modal and the colour popover.

**New steps:**
- `settings-tabs-keyboard`: focus General, then press ArrowRight;
- `add-show-dialog`;
- `touch-probe`: the heights of Save and a row "Remove event" button.

A fresh **`before-settings`** baseline was captured on the unported code (`supabase-migration` at 97f609c plus the artifacts commit) with the same walk. `after-settings` was diffed against it, one pass per width.

## Results

**Contrast:** 76 captures, with 0 failures apart from the out-of-scope user-data "Audio issue" (3.64, `filter-menu`).

**Touch floor (D2b):**

| | Save | Remove event |
| --- | --- | --- |
| 1440 | 36px (was 35) | 24px (unchanged) |
| 390 | 44px (unchanged) | 44px (unchanged) |

| Screen | 1440 | 390 | Note |
| --- | --- | --- | --- |
| settings-general | 1.55% | 3.90% | `.btn`/`.profile-select` controls became Button/Input; Save is the shared sky primary |
| settings-general-member | 0.85% | 2.50% | same |
| settings-tabs-keyboard | 3.67% | 9.26% | **intended**: ArrowRight now activates Event Buttons (Radix tabs). The old tablist ignored arrow keys and stayed on General |
| settings-event-buttons | 0.82% | 0.62% | lucide grip/trash, Button variants |
| suffix-select | 1.68% | 4.59% | same controls behind the listbox |
| add-show-dialog | 2.35% | 3.57% | Field/Input + DialogActions |
| event-instruction-modal | 1.32% | 4.10% | Textarea + DialogActions |
| event-options-modal | 3.37% | 9.30% | shadcn Checkbox and Textarea; the shorter content seats the 390 sheet lower |
| color-popover | 0.84% | 0.43% | table controls behind the popover |
| settings-auto-sync / settings-debug | 0.04% | 0.05% | hint utilities |
| every other screen (home, rail, workspace, menus, teams, login, route states, admin, New Session, Batch Import) | 0–0.01% | 0% | untouched surfaces are unchanged |

**Noted, not changed:** at 390 the Settings header's team/show row shows a native horizontal scrollbar behind open sheets. It is present in `before-settings` too, so it predates this change.
