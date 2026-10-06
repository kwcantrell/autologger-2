# shadcn-shared-wrappers QA (task 5.1)

The walk (`screens.sh`, `cap.sh`, `contrast.js`) is copied from the archived `shadcn-foundation/qa`, with these changes:

- **Two new steps:** the Settings → Suffix select listbox (`suffix-select`) and the transport Roll tile tooltip (`roll-tooltip`).
- **One pass per width.** Dialogs now keep the card or sheet mode they opened in (design D2, `useDialogMode`), so a mobile sheet has to be opened at 390 rather than reached by resizing. Run both passes into the same output directory:

  ```bash
  QA_BASELINE=<archived>/qa/after-foundation QA_VP="1440 900" ./screens.sh after-wrappers
  QA_BASELINE=<archived>/qa/after-foundation QA_VP="390 844"  ./screens.sh after-wrappers
  ```

- **Mobile rail.** On mobile the rail is a drawer, so before rail controls the walk clicks "Open navigation".

## What the walk found, and the fixes

- **Breakpoint remount.** Crossing 768px with a dialog open swapped Dialog for Drawer, which remounted the content and closed Settings' nested Event Options dialog. Fixed by `useDialogMode` (commit `40a249c`, with a unit test). Verified live: Event Options inside Settings at 1440, resized to 390, and both dialogs were still open.
- **A transient `⋮` 2.16 contrast reading** in the first pass was the hover-revealed row menu mid-transition. It didn't reproduce.

## Data note

The dev DB gained a second session, `TS_261006_002`, between the end of the `shadcn-foundation` walk and the start of this one. The first capture of this walk (`home.1440`, 20 checked nodes against 17 before) already shows it. No step of this walk creates sessions, so it most likely came from the owner's manual dev-stack pass. It shifts the home and rail layout slightly in every diff below.

## Results against `shadcn-foundation` `after-foundation`

**Contrast:** 0 failures, apart from the out-of-scope user-data "Audio issue" (3.64). This includes the new select listbox and tooltip captures.

| Screen | 1440 | 390 |
| --- | --- | --- |
| admin-users | 0% | 0% |
| batch-import | 0.05% | 4.28% |
| color-popover | 0.13% | 15.48% |
| event-instruction-modal | 0.11% | 13.28% |
| event-options-modal | 0.01% | 8.90% |
| filter-menu | 0.10% | 0.35% |
| home | 0.10% | 0.07% |
| login | 0% | 0% |
| new-session-expanded | 0.05% | 4.89% |
| new-session | 0.05% | 4.89% |
| not-found | 0% | 0% |
| roll-tooltip | new | new |
| session-menu | 0.03% | 9.08% |
| settings-auto-sync | 0.01% | 5.48% |
| settings-debug | 0.01% | 4.79% |
| settings-event-buttons | 0.14% | 9.12% |
| settings-general | 0.01% | 6.82% |
| shortcuts | 0.05% | 4.94% |
| suffix-select | new | new |
| teams | 0.08% | 0% |
| time-display-menu | 0.10% | 0.35% |
| transcribe-modal | 0.10% | 0.35% |
| ws-assistant | 0.10% | 0% |
| ws-dashboards | 0.10% | 0% |
| ws-event-feed | 0.10% | 0% |
| ws-export | 0.10% | 0% |
| ws-topics | 0.10% | 2.26% |
| ws-transcript | 0.10% | 0% |

A blank diff means the screen is new (`suffix-select`, `roll-tooltip`), so there's no baseline image for it. The largest diffs are the mobile Settings sheet and its nested sheets. vaul's drawer sits about 6px higher than the legacy sheet, and the nested sheet's spacing differs slightly. The pairs look equivalent.

**The owner's review and dev-stack pass (task 5.2): done, approved on 2026-10-06 ("Everything looks good").** The owner also confirmed that `TS_261006_002` is their own session.
