# shadcn-port-workspace QA (task 6.1)

The walk (`screens.sh`, `cap.sh`, `contrast.js`) is copied from the archived `shadcn-port-shell/qa`, with one pass per width (`QA_VP="1440 900"`, then `"390 844"`) against its `after-shell` captures.

## New steps

- **`auto-generate-menu`:** the Event Feed's Auto Generate DropdownMenu, which is aria-disabled at rest in this session. The `time-display-menu` and `filter-menu` steps now capture the DropdownMenus, opened with real pointer events.
- **`ws-tabs-keyboard`:** the feed tabs after ArrowRight from Event Feed (Radix roving focus).
- **Probes on a session with data** (`QA_PROBE_SESSION`, ATS_youtube: 4 events and 2279 transcript words; the walk's own session has none):
  - **`feedprobe.js`:** the visible feed's ScrollArea viewport, measuring overflow on both axes, the sticky-header offset, mounted rows and row heights.
  - **`reveal-in-feed`:** clicks the last timeline marker and checks that its row mounts and flashes.
  - **`ws-transcript-scrolled`:** the virtualized transcript, scrolled.
  - **`focusprobe.sh`:** focuses a probe input, then does a real (trusted) mousedown-drag on the feed scrollbar.

## Probe results (both widths)

| Check | 1440 | 390 |
| --- | --- | --- |
| Event row height (A6, ≤ 31px) | 30.44px | 30.44px |
| Transcript viewport scrolls | 560 / 70661px | 591 / 70660px (the 70dvh cap is on the viewport) |
| Rows mounted (of 2279) | 39 | 40 |
| Sticky header offset after scrolling | 0 | 0 |
| Horizontal reach (overflow-x / client / scroll width) | scroll / 1098 / 1098 | scroll / 278 / 402 |
| Scrollbar drag keeps focus (D1) | focus stays on `qa-focus`; scrollTop 1200 → 6412 | stays; 1200 → 6126 |
| Reveal from a timeline marker | mounted + flashed | mounted + flashed |

**Found by the walk and fixed in this change:**
1. **Internal rows were near-invisible (1.14:1).** The server's internal-event colour names the legacy muted token, which since change 1 resolves to shadcn's 6% tint. This predates 3b; the owner folded the fix in, and it was re-panelled and re-approved as D8 / task 5.4. After the fix, the rows compute to `rgb(154, 160, 166)` and the `reveal-in-feed` screen has 0 contrast failures.
2. **Mobile feeds lost horizontal scroll.** Radix ScrollArea hides x-overflow unless a horizontal bar is mounted. Fixed by `scrollbars="both"` (D3 note); the 390 row above shows the result.

## Contrast

70 captures, with 0 failures apart from the out-of-scope user-data "Audio issue" colour (3.64, `filter-menu`). That includes `reveal-in-feed`, which shows the Internal rows.

## Diffs against `after-shell`

| Screen | 1440 | 390 |
| --- | --- | --- |
| admin-users | 0% | 0% |
| auto-generate-menu | new | new |
| batch-import | 0.22% | 0.24% |
| color-popover | 11.50%* | 29.75%* |
| event-instruction-modal | 2.59%* | 11.63%* |
| event-options-modal | 16.53%* | 33.57%* |
| filter-menu | 0.44% | 0.74% |
| home | 0.39% | 0.34% |
| login | 0% | 0% |
| login-error | 0% | 0% |
| new-session | 3.42%* | 9.33%* |
| new-session-expanded | 4.28%* | 13.07%* |
| not-found | 0% | 0% |
| reveal-in-feed | new | new |
| roll-tooltip | 0.33% | 0.23% |
| session-menu | 0.30% | 1.06% |
| session-not-found | 0.30% | 0% |
| settings-auto-sync | 8.05%* | 16.50%* |
| settings-debug | 7.87%* | 16.08%* |
| settings-event-buttons | 2.36%* | 9.07%* |
| settings-general | 2.42%* | 7.35%* |
| shortcuts | 0.17% | 0.10% |
| suffix-select | 2.83%* | 8.44%* |
| teams | 1.32% | 2.89% |
| teams-expanded | 2.89% | 5.22% |
| time-display-menu | 0.44% | 0.78% |
| transcribe-modal | 0.30% | 0.07% |
| ws-assistant | 0.33% | 0.06% |
| ws-dashboards | 0.37% | 0.18% |
| ws-event-feed | 0.33% | 0.23% |
| ws-export | 0.47% | 1.70% |
| ws-tabs-keyboard | new | new |
| ws-topics | 0.32% | 0.14% |
| ws-transcript | 0.33% | 0.15% |
| ws-transcript-scrolled | new | new |

\* **Data state, not code.** None of these surfaces is touched by 3b (Settings, its modals and New Session are 3c).
- Since the `after-shell` run, Settings opens on the **Youtube Studio** team, where the owner is a member, not an admin.
- Member view has no Suffix select and read-only Event Buttons. So the Suffix, AI Rules, dropdown-options and colour-picker steps had nothing to open, and the walk's Escape closed Settings. Those captures show the read-only panels or the home page.
- The recent-session list also changed (TS_261006_002 is gone), which shifts the background behind every modal.
- The walk did not switch the saved team selection, because that is the owner's preference. 3c re-baselines these screens.

The workspace screens (`ws-*`, the three menus, `roll-tooltip`, `shortcuts`, `transcribe-modal`) stay within 0.06–1.7%. That is scrollbar drift plus the new menu indicators.
