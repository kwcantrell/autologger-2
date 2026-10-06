# shadcn-port-shell QA (task 5.1)

The walk (`screens.sh`, `cap.sh`, `contrast.js`) is copied from the archived `shadcn-shared-wrappers/qa`, with one pass per width (`QA_VP="1440 900"`, then `"390 844"`). New steps:

- **`teams-expanded`:** Teams with the first card expanded, showing Field/Input, Badge and Button variants.
- **`session-not-found`:** `/sessions/does-not-exist`, rendered by the shared `RouteState` panel.
- **`login-error`:** `127.0.0.1:8787/?login_error=state_invalid`, the destructive Alert.
- **`session-menu`:** the existing step now captures the DropdownMenu, opened with real pointer events.

**Walk fix:** the Suffix-select step retries once if LazySelect swallows the first click, and presses Escape only while a listbox is open. An Escape with no listbox closed Settings and derailed every later Settings capture in the first run. That made the Settings screens show the home page and inflated their diffs to 10–34%. It was the walk, not the app.

## Results against `shadcn-shared-wrappers` `after-wrappers`

**Contrast:** 62 captures, 0 failures apart from the out-of-scope user-data "Audio issue" (3.64).

| Screen | 1440 | 390 |
| --- | --- | --- |
| admin-users | 0% | 0% |
| batch-import | 0.03% | 1.09% |
| color-popover | 0% | 0.01% |
| event-instruction-modal | 0.00% | 0.00% |
| event-options-modal | 0.00% | 0% |
| filter-menu | 0.09% | 0% |
| home | 0.45% | 3.27% |
| login-error | new | new |
| login | 0.01% | 0.03% |
| new-session-expanded | 0.03% | 0.03% |
| new-session | 0.03% | 1.11% |
| not-found | 0% | 0% |
| roll-tooltip | 0.09% | 0% |
| session-menu | 0.46% | 0.38% |
| session-not-found | new | new |
| settings-auto-sync | 0% | 0.01% |
| settings-debug | 0% | 0.01% |
| settings-event-buttons | 0% | 0.01% |
| settings-general | 0% | 0.01% |
| shortcuts | 0.03% | 1.60% |
| suffix-select | 0% | 0.01% |
| teams-expanded | new | new |
| teams | 2.20% | 6.63% |
| time-display-menu | 0.09% | 0% |
| transcribe-modal | 0.09% | 0% |
| ws-assistant | 0.09% | 0% |
| ws-dashboards | 0.09% | 0% |
| ws-event-feed | 0.09% | 0% |
| ws-export | 0.09% | 0% |
| ws-topics | 0.09% | 2.26% |
| ws-transcript | 0.09% | 0% |

`new` means the screen has no baseline yet. The diffs fall on this change's surfaces:
- Teams: Field/Input/Badge/Button.
- Home and rail: lucide icons and the Button-based New Session.
- The session menu: DropdownMenu.

Unported screens (Settings, workspace, modals) are at ≤0.1% at 1440. Mobile diffs come from the hamburger becoming a Button and the rail drawer's icons.

**The owner's review and dev-stack pass (task 5.2): done, approved on 2026-10-06 ("looks good").**
