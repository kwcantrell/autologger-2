# Tasks: ui-refresh

> Plan of record. **Provisional until the adversarial panel + gate pass** (opsx:propose drafts
> all four artifacts; the gate is not encoded in tooling). Apply executes via subagents per the
> protocol, on a branch whose first commit is these gated artifacts. The spike branch
> `ui-refresh-spike` (be7e044) is the reference implementation — dispatch prompts may point
> implementers at specific spike files/hunks as a quarry, but every unit re-verifies its own
> slice (typecheck + `npx vitest run` for touched web tests) before its commit. `file:line`
> anchors below are orientation; locate code by content.

## 1. System vocabulary (web-ui-system)

- [x] 1.1 Re-skin the legacy `.btn` family + `.profile-select`/`.num`/`input[type=text]`/
      `textarea` + placeholder floor to V5 glass in `web/src/shared/theme/tailwind.css` (D1);
      raise eyebrow color to `rgba(229,238,252,0.62)`; add the stop/play capture-strip display
      rules (D6) and the `body.v4-is-recording` reveal rules (D8) in the same theme pass.
- [x] 1.2 Add `web/src/shared/ui/ConfirmDialog.tsx` (`ConfirmDialog` + `useConfirm`, D2) with
      the danger variant; unit-verifiable via its EventLogSheet consumer tests in unit 2.
- [x] 1.3 Contrast/motion fixes: TimelineTicks alpha 0.36→0.58; inactive feed-tab label
      0.48→0.6 (`feedTabStyles.ts`); marquee `motion-reduce:animate-none!` on Timeline's
      NAV_MSG_TRACK + token comment update.

## 2. Confirm migration + row delete (web-ui-system)

- [x] 2.1 Replace `window.confirm`/`window.prompt` everywhere: EventLogSheet (delete row,
      discard batch), RecentSessionsList (archive/delete/restore ×4), TeamCard (remove member,
      leave team), HomeSettingsModal Add-Show (themed input dialog). Zero
      `window.confirm|prompt` remains (spec scenario).
- [x] 2.2 EventLogRow: `relative` on the actions cell (D4), hover cluster anchored `right`
      inside the row, SVG trash icon button (ROW_ICON_BTN); keep UNDELETE as `.btn`.
- [x] 2.3 Beyond-spike scope (fact-check finding, D13 semantics as panel-pinned): convert
      `useRecoveryStopWarning.ts`'s `window.confirm` to hook-exposed pending state rendered
      through `ConfirmDialog` in SessionWorkspace — once per session mount, dismissal =
      decline, accept RE-VALIDATES orphan + lease before posting (no-op + dismiss if
      resolved), accept-time `marked_at_utc`, copy drops the fixed-timecode promise, pending
      decision dismissed on session switch; NEW unit coverage for accept/decline/re-validate.
      Also `AdminUsersPage.tsx`'s bare `confirm` via `useConfirm`. After this task the
      zero-occurrence scenario holds repo-wide. (Phase 2 carries a per-phase review — see
      design "Review tiers".)

## 3. Transport + timecode SVG icons, tooltips (web-ui-system / web-session-console)

- [x] 3.1 TransportControls: replace PNG `TRANSPORT_ICONS` with `TransportGlyph` currentColor
      SVGs (accent-tinted via `--session-ctl-accent`), wrap tiles in `Tooltip`; keep
      `#btn-ctl-N`/`#btn-ctl-N-icon` ids. Wrap the origination-guard tests in a
      TooltipProvider render helper.
- [x] 3.2 TimecodeDisplay: mic/record/stop glyphs → state-tinted SVGs; delete the 12 orphaned
      PNG assets (`git rm`), verify zero remaining references.
- [x] 3.3 Test infra (D12): `renderStrict` wraps `TooltipProvider` + export `StrictWrapper`;
      `matchMedia` stub in `web/src/test/setup.ts`; Tooltip module mocks export
      `TooltipProvider`.

## 4. Core loop (web-session-console)

- [x] 4.1 SessionWorkspace: stopped-state hint line under the capture strip (D6); pulsing red
      dot beside "Recording" status; session-ID copy chip (button + copy SVG + toast).
- [x] 4.2 CategoryButtonStrip: shared `triggerCategory` for click + 1–9 hotkeys (D7 guards
      per spec: liveDock condition, `event.repeat` ignored, once per keypress, Ctrl/Meta/Alt
      excluded with Shift permitted, typing/dialog bails); digit badges on live tiles using
      `[display:none]`/live-slot `[display:flex]` arbitrary properties (NOT the `.hidden`
      class — `!important` trap). NEW unit tests for the guard set (repeat, typing target,
      dialog open, modifier).
- [x] 4.3 `ShortcutsDialog.tsx` (+ exported `isTypingTarget`, arrow-scrub row scoped "when
      the timeline playhead is focused"); `?` listener (no Ctrl/Meta/Alt; Shift permitted) +
      keyboard entry button in Session Controls head; AudioRecorder toggles
      `body.v4-is-recording` on the recording phase only (D8) **with an unmount cleanup that
      removes the class** (panel finding — stale-strip leak); AppShell top-bar strip markup
      styled (pulse dot, duration) with the duration excluded from live-region announcement
      (aria-quiet per spec).
- [x] 4.4 Global-key dialog guards (D14, panel BLOCKER): AudioPlayer's Space handler and
      useZoomRail's +/− handler bail when any `[role="dialog"]` is open or the event target
      is an interactive element consuming the key; unit-test the Space-on-focused-button
      case.

## 5. Home launch + rail search (web-home-launch)

- [x] 5.1 Dedicated home route (D10 as gate-overridden): `HomeRoute`/`HomeLaunch` component
      (stable region id `#home-launch`; wordmark, tagline, resume card via `useSessions`,
      New Session) rendered by SessionRoute for the empty id in WorkspaceStatic's place;
      `onNewSession` threads AppShell → SessionRoute → HomeRoute (stable callback). Retire
      SessionWorkspace's empty-id placeholder branch + the `#v3-session-placeholder` element;
      replace the visibility-swap unit tests with SessionRoute mount tests (home for empty
      id, workspace for found session) + HomeRoute tests (resume card, no-active copy,
      New Session opens the shared modal).
- [x] 5.2 V6Rail: replace the fake search button + offscreen input with the inline search
      field (glass box, collapse-aware, clear button, Escape clears; ids retained per D3;
      the collapsed-state affordance is a REAL focusable control — panel finding); pass
      `filter` to RecentSessionsList/ArchivedSessionsList; filtered-empty states; rail tile
      size/type legibility bump (3.15rem tile, 0.72/0.62rem type); focus-visible reveal for
      the ⋮ menu. NEW unit tests: filter narrows both lists, no-match copy, collapsed
      keyboard activation.

## 6. Five-tab IA (web-session-console)

- [x] 6.1 SessionWorkspace: five-tab state/labels/panels (D5), TranscribeFeed/TopicsFeed as
      top-level mounted-hidden panels, `AiV2Panel key={sessionId}` preserved; AiPanel → chat-
      only wrapper keeping hoisted chat state; mobile tablist horizontal scroll + tab
      `whitespace-nowrap shrink-0`.
- [x] 6.2 Rewrite `SessionWorkspace.test.tsx` for the five-tab IA: tab inventory, mounted-
      hidden node-identity tests (chat + design rail), mid-stream no-abort, session A→B clean
      panel (rerender via `StrictWrapper`). (The old placeholder↔grid visibility-swap tests
      are replaced in task 5.1, not here.)

## 7. Honest gates + save models (web-session-console)

- [x] 7.1 TranscribeFeed/TopicsFeed: 503-latch per mounted panel (D9: persists across
      session switches, reload clears — copy says so), generate control non-actionable with
      a keyboard/AT-reachable reason (visible text or aria-describedby on focusable
      aria-disabled — NOT a mouse-only title), remedy empty-state copy, single inline error
      channel (remove toast duplication).
- [x] 7.2 HomeSettingsModal: DERIVED dirty tracking (compare form state to initialized
      snapshot — D11 as panel-revised, diverging from the spike's hand-armed flag), Save
      disabled/"Saved" when clean, guarded Close via `useConfirm`, themed Add-Show dialog,
      corrected Event Buttons copy. `HomeSettingsModal.test.tsx`: edit-any-field-enables-Save
      coverage per tab.
- [x] 7.3 NewSessionModal: progressive disclosure (YouTube + timecode-settings sections with
      value summaries), Bonus as a true `aria-pressed` toggle; TeamsRoute anonymous-mode
      notice names `REQUIRE_LOGIN=1`; FEED_GLASS_BTN `max-md:px-4`.
- [x] 7.4 Finish the vocabulary rename in copy (panel finding): AiV2Design's "AI v2 isn't
      configured…" and AiChat's not-configured strings updated to the Dashboards/Assistant
      vocabulary; README's session-workspace tab sentence updated (docs line in the same
      change).

## 8. Final gates

- [x] 8.1 `npm run typecheck` + `npm test` + `npm run lint` (expect only the 5 pre-existing
      warnings).
- [x] 8.2 Update e2e for the IA/copy/home: smoke + teams-smoke home assertions target
      `#home-launch` (placeholder element retired) + Add-Show dialog flow, ai-chat →
      Assistant/Topics top-level tabs, ai-v2-dashboards → Dashboards tab, visual.spec
      Transcript/Topics navigation + `#home-resume-session` in DATE_MASK + home shots
      against the home route; `npm run e2e` (chromium + login-gate) green.
- [ ] 8.3 Re-bless visual baselines (`npm run e2e:visual:update`) in this branch's own diff,
      then verify `npm run e2e:visual` passes deterministically (run twice).
- [ ] 8.4 Live verification pass (dev server + browser): stopped-state strip + hint, hotkey
      badges + a hotkey-logged event (and held-key logs once), export/confirm/shortcuts
      dialogs, Space-on-confirm-button behavior, home surface, mobile 390px tab scroll +
      toolbar fit, **play state with recorded audio** (strip + hint + playback panel layout —
      the one state the spike never verified), recording strip incl. unmount-while-recording.
- [ ] 8.5 Divergence audit artifact (D15): commit `git diff ui-refresh-spike <branch> --
      web/ e2e/` (and a baseline-PNG diff summary) under `.apply/`, with each deliberate
      departure annotated (D11, D13, D14, gate rulings); accidental departures resolved or
      justified before the whole-branch audit.
