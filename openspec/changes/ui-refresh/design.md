# Design: ui-refresh

## Context

A dual-agent impeccable critique (2026-07-21) scored the web UI 21/40. The V5 glass system
itself reviewed as strong and distinctive; the deficits were archaeological (a pre-V5 stratum in
modals and actions), broken affordances (search, row delete), an invisible core loop, an
unbranded home, migration-history tab names, and AA/reduced-motion violations.

**This change has an unusual shape:** a complete implementation was built and verified ahead of
the proposal (branch `ui-refresh-spike`, commit `be7e044` — a recorded SDLC deviation; see the
Panel & review log). These artifacts codify the spike's decisions as the plan of record; apply
re-lands the work from clean `main` under the standard protocol, using the spike as a quarry
(cherry-picking hunks is acceptable; blind whole-branch merges are not — each dispatch unit must
re-verify its own slice).

## Goals / Non-Goals

**Goals:** fix the critique's four P1s; make the logging loop visible and keyboard-operable;
give `/` a branded launch surface; rename/flatten the workspace tabs; make capability gates and
save models honest; keep the whole diff client-side.

**Non-Goals:** server changes or new API surface (frozen contract); Event Buttons editor
density redesign; `hover-always` touch-latch change (accepted residual); per-session
`document.title`; auto-redirecting `/`.

## Decisions

- **D1 — Re-skin the legacy `.btn`/form family in place (tailwind.css), not per-consumer.**
  Alternatives: port each consumer to `FEED_GLASS_BTN` (large mechanical diff, drift risk), or
  delete the family (breaks retained class hooks). Editing the shared rules converts every
  legacy modal at once while preserving markup/tests; the family can still be retired later at
  zero consumers.
- **D2 — Shared `ConfirmDialog` + promise-based `useConfirm()`** (`web/src/shared/ui/`), a
  drop-in for `if (!confirm(...)) return` call sites. Alternative (per-consumer dialog state)
  triples the diff at each call site. Eleven sites total (10 confirm-like + 1 prompt): the
  spike converted 9; the fact-check pass found two more — `useRecoveryStopWarning.ts`
  (`window.confirm`) and `AdminUsersPage.tsx` (bare `confirm`) — added to scope (D13).
  Panel-hardened semantics: a second `confirm()` while one is pending, or unmount with a
  pending decision, resolves the pending promise **false** (never a hung await); Escape,
  overlay click, and mobile drag-dismiss are decline. Separate `useConfirm` instances can
  stack (Radix handles overlay order); same-instance overlap resolves-then-replaces.
- **D13 — The recovery-stop warning becomes a themed dialog, with the async window made
  explicit.** `window.confirm` blocked the event loop, making the decision atomic; a themed
  dialog is non-blocking, so the panel-pinned semantics are: dialog shows once per session
  mount; any dismissal (Escape/overlay/switch) is decline and posts nothing; **accept
  re-validates** the orphan against current events/status and the recording lease and no-ops
  (dismissing) if the orphan resolved or the lease is alive; the posted `marked_at_utc` is
  accept-time and the copy no longer promises a specific timecode; a pending decision is
  dismissed on session switch. The hook exposes pending-decision state; SessionWorkspace
  renders it through `ConfirmDialog` (modal — and note the dialog's presence also suspends
  the new 1–9 hotkeys via the dialog guard, an interaction that did not exist before).
  AdminUsersPage's delete-team confirm converts via `useConfirm` directly. This is the one
  slice with NO spike reference — it gets fresh unit coverage (accept/decline/re-validate)
  and phase 2 carries a per-phase review (it brushes the destructive-data tier). Alternative
  — scoping these two sites out — would leave the zero-occurrence scenario failing by
  construction.
- **D14 — Global single-key handlers get a dialog/interactive-target guard** (panel BLOCKER).
  Converting destructive confirms to in-page dialogs exposes them to the pre-existing global
  Space (AudioPlayer) and +/− (useZoomRail) handlers, which check typing targets but not open
  dialogs — Space on a focused Delete button toggled playback instead of confirming. Both
  handlers gain the same guard set the 1–9 hotkeys use (`[role="dialog"]` open → bail;
  interactive event target that consumes the key → bail). In scope because this change is
  what moves destructive decisions onto that surface.
- **D15 — Re-land divergence is auditable, and quarrying is PREFERRED.** Wherever the gate
  did not alter the spike's design, implementers cherry-pick/copy spike hunks rather than
  retyping (retyping working code is pure transcription risk). Task 8 produces a divergence
  audit artifact — `git diff ui-refresh-spike <branch> -- web/ e2e/` committed under
  `.apply/` — so every deliberate departure (D11 derived dirty, D13/D14, gate rulings) is
  enumerable and accidental departures are visible; the re-blessed visual baselines are
  diffed against the spike's baselines the same way, making the second bulk re-bless a
  comparison against reviewed pixels rather than a second act of trust.
- **D3 — Rail search filters the session lists client-side** (title match). Alternative — a
  cross-session log-content search — needs a server search route (frozen contract) and is out
  of scope; the affordance is renamed/scoped honestly ("Search sessions"). The offscreen
  input ELEMENT is deleted; its ids (`top-bar-search` on the new visible input,
  `v6-btn-search-logs` on the box) are retained per the spike — no external consumer exists
  (verified: e2e/companion/tailwind grep), but retention keeps the spike quarry-able. The
  collapsed-rail affordance must be a real focusable control (panel finding — the spike's
  `div onClick` is keyboard-unreachable when collapsed and is corrected at re-land).
- **D4 — Row-delete fix is `relative` on the actions cell** (the missing containing block) plus
  an in-row SVG icon button; the UNDELETE pill keeps the `.btn` vocabulary. Alternative (a real
  trailing actions column) changes the frozen-in-tests 3-column sheet layout for no UX gain.
- **D5 — Five top-level tabs; AiPanel becomes chat-only but KEEPS the hoisted chat state.**
  Transcribe/Topics move up as siblings (they are session data, not "AI"); labels become
  Assistant/Dashboards. The mounted-hidden discipline and `AiV2Panel key={sessionId}` are
  load-bearing invariants from ai-topics-chat/ai-v2-dashboards and are preserved verbatim —
  a future reader must NOT "simplify" the always-mounted panels into conditional mounts.
- **D6 — Stopped-state strip via CSS state extension**: `body[data-v4-transport='stop'|'play']`
  now also displays `.v4-log-top__capture` (it was display:none in every reachable state — the
  capture slot was dead markup). Buttons stay `disabled`; a hint line names the enablement path.
- **D7 — Hotkeys live in `CategoryButtonStrip`** (shared `triggerCategory` path for click and
  key), guarded per the spec: live-dock condition (rolling or audio-recording — the same
  condition that enables the tiles), `event.repeat` ignored (once per physical keypress),
  Ctrl/Meta/Alt excluded with Shift permitted (layout reasons), not in text entry, no
  `[role="dialog"]` open.
  Badges use `[display:none]`/`[#cat-strip-live-slot_&]:[display:flex]` arbitrary properties —
  the legacy `.hidden` class is `display:none !important` and beats ancestor variants (trap).
- **D8 — Recording indicator wires the class the markup always keyed on**: AudioRecorder
  toggles `body.v4-is-recording` scoped to the `recording` phase only (not upload, so the strip
  never lies); reveal rules live beside the other body-state rules in tailwind.css. The
  duration text keeps its existing imperative writer.
- **D9 — Capability gating is client-latched off the first 503**, per mounted panel: the
  latch persists across session switches (the feeds are mounted-hidden and unkeyed) and
  clears on page reload — deliberate, since the 503 is deployment-level; the copy tells the
  operator to reload after configuring (the reverse-stale case). The disabled control's
  reason must be keyboard/AT-reachable (visible text or `aria-describedby` on a focusable
  `aria-disabled` control), not a mouse-only `title`. A server capability endpoint would be
  the honest-at-first-render design but adds API surface to a frozen contract — deferred to
  its own contract-delta change and recorded in Non-Goals.
- **D10 (GATE-OVERRIDDEN 2026-07-21) — Home launch is a dedicated route component.** The
  spike rendered HomeLaunch inside `#v3-session-placeholder` to leave web-session-routing
  untouched; the gate ruled for the dedicated-component architecture instead. Shape:
  `SessionRoute` renders `<HomeRoute onNewSession={...}/>` for the empty id (in
  WorkspaceStatic's place), so `SessionWorkspace` only ever mounts with a session id — its
  empty-id placeholder branch and the legacy `#v3-session-placeholder` element (plus its
  unreachable "Select a session…" copy) are retired. Consequences, priced in: a
  web-session-routing MODIFIED delta (the swap becomes route-driven mounting; deep-link/
  latching/nav-funnel untouched); the SessionWorkspace visibility-swap unit tests are
  replaced by SessionRoute home/workspace mount tests + HomeRoute component tests; e2e
  assertions move from the placeholder element to the home component's stable region id
  (`#home-launch`) and to `#v3-session-grid` for the workspace. The onNewSession prop chain
  SHORTENS to AppShell → SessionRoute → HomeRoute. `/` still never auto-redirects.
- **D11 — Settings dirty model: DERIVED, not hand-armed** (panel-revised; the spike hand-armed
  a `dirty` flag per callsite). Dirtiness = current form state differs from the initialized
  snapshot (deep compare of drafts + fields captured at init). Rationale: a forgotten
  `setDirty` call fails in the dangerous direction (Save bricked AND discard guard skipped);
  derived comparison can't rot per-callsite and also stops view-only selection (show/studio
  switching back) from prompting spurious discards. Save disabled + labeled "Saved" when
  clean; Close guarded by the themed discard confirm. The misleading "auto-saves" copy in the
  Event Buttons tab is corrected to match the actual draft-then-Save model (the copy was
  wrong, not the model).
- **D12 — Test-infra consequences are part of the design**: `renderStrict` wraps
  `TooltipProvider` (mirroring main.tsx) and exports `StrictWrapper` for identity-preserving
  rerenders; jsdom gets a `matchMedia` stub in the web test setup; Settings tests must arm the
  dirty flag before clicking Save. Visual baselines are re-blessed via the sanctioned
  `e2e:visual:update` flow; `#home-resume-session` joins DATE_MASK (content varies with the
  shared hermetic DB).

## Review tiers (per-phase disposition, declared)

Phase 2 (recovery flow — destructive-data-adjacent, no spike reference) and phase 6 (the
mounted-hidden / stream-survival machinery two shipped capabilities pin — the frontend's
closest thing to concurrency semantics) each get a per-phase review after their last task.
All other phases defer to the whole-branch layered audit. Intended dispatch units: (1.1–1.3),
(2.1–2.3), (3.1+3.3, then 3.2), (4.1–4.3), (5.1–5.2), (6.1–6.2), (7.1–7.3), (8.1–8.2),
(8.3–8.4). Task 1.1 lands D6/D8 CSS whose JS wiring arrives in phase 4 — deliberately dead
rules for two phases; the audit should not read that interim state as a defect.

## Risks / Trade-offs

- **Visual re-bless is a bulk trust event** — mitigated by D15: the re-blessed baselines are
  diffed against the spike's reviewed baselines, and the functional e2e suite pins unchanged
  semantics. The spike's interactive screenshot review did NOT cover the play state (the
  visual "play" shot is documented as capturing stop chrome — no headless audio); task 8.4
  covers it live with recorded audio.
- **503-latch gating only becomes honest after the first failure** (accepted; D9 records the
  endpoint alternative as deferred).
- **Five tabs overflow narrow viewports** — mitigated with a scrolling single-line tablist and
  narrower toolbar buttons on ≤767px (verified live at 390px).
- **Companion/e2e id surface**: the rule is "every id / accessible name referenced by
  `e2e/*.spec.ts` is preserved except those this change's own e2e edits rename" (`#btn-ctl-N`,
  `#session-list`, `ns-*`, `profile-*`, …); the one retirement is `#v3-session-placeholder`
  (gate-overridden D10) whose assertions move to `#home-launch`/`#v3-session-grid`.

## Panel & review log

- **2026-07-21 — process deviation (owner-flagged):** the change was implemented before the
  proposal existed, under the /impeccable skill flow with an in-skill question gate. The owner
  ruled this a breach of the SDLC; remediation = this change (spike preserved as
  `ui-refresh-spike` for reference/evidence, artifacts written as-built, panel + gate run
  before any re-landing, apply from clean `main` under the standard protocol). Recorded in the
  `feedback-skills-dont-override-sdlc` memory so it does not recur.
- **2026-07-21 — fact-check pass (light-tier, pre-panel):** 25 claims checked against `main`
  and `ui-refresh-spike` (git show/diff; no checkout). 22 CONFIRMED (spike commit/critique
  file, baseline defects incl. the dead capture strip and never-toggled `v4-is-recording`,
  spike values 0.58/0.6/0.62, 12 PNG deletions, `key={sessionId}`, 503 server behavior, 5
  pre-existing lint warnings in untouched files). **Corrections folded:** (1) `ai-topics-chat`
  IS a modified capability — its baseline requirement pins the two-tab/three-subtab STRUCTURE
  (labels only are non-normative); delta spec added, proposal corrected. (2) Two additional
  confirm sites (`useRecoveryStopWarning.ts` `window.confirm`, `AdminUsersPage.tsx` bare
  `confirm`) were missing from scope and remain unconverted on the spike — scope expanded
  (D2/D13, task 2.3); note the spike does NOT satisfy the zero-occurrence scenario as-built.
  **Checker artifact dismissed:** the "eyebrow 0.45 not found" correction was a grep-spacing
  miss — `color: rgba(255, 255, 255, 0.45)` exists verbatim at tailwind.css:826 on `main`
  (re-verified). Judgment-laden claims (design rationale, UX quality) reach the panel
  un-vouched.
- **2026-07-21 — adversarial panel (4 reviewers: requirements / assumptions / failure & abuse
  / scope & simpler design), synthesized.** ~40 findings, deduped. Dispositions:

  **Blockers/majors fixed in place:**
  - Space-in-dialog toggles playback; +/− zoom behind dialogs (failure BLOCKER) → D14 + spec
    requirement "Global single-key handlers yield to dialogs" + task 4.4.
  - ai-topics-chat delta silently dropped 3 baseline scenarios + weakened the normative
    enumeration (requirements + assumptions) → delta rewritten carrying all five scenarios
    and the full enumeration.
  - Tab-IA ownership fragmented + label-normativity contradiction (scope + requirements) →
    web-session-console is sole owner of tab inventory/labels; ai-topics-chat delta defers
    structure by reference; ai-v2-dashboards stays unchanged (its "alongside the existing
    tabs" wording is compatible — verified).
  - Spec under-coverage (Settings dirty model, Add-Show dialog, New Session disclosure) →
    requirements added to web-ui-system.
  - D13 async-window semantics unpinned (all four reviewers) → pinned (re-validate at accept,
    dismissal=decline, accept-time timestamp, session-switch dismissal); phase-2 review tier.
  - Recording indication: dual truth sources unpinned; `v4-is-recording` leaks on unmount;
    per-second aria-live announcements → requirement rewritten (scoped sources, unmount
    scenario, AT-quiet duration).
  - Hotkey guard enumeration (auto-repeat, once-per-keypress, Ctrl/Meta/Alt-only wording with
    Shift permitted, liveDock-not-isRolling condition, `?` reachable under Shift) → spec
    rewritten.
  - Collapsed-rail search keyboard-unreachable in the spike → spec + D3 corrected.
  - Hand-armed dirty flag fails dangerous-direction → D11 revised to derived dirtiness.
  - Migration tactics fossilized as durable requirements → web-ui-system re-specced to steady
    state (vocabulary/vector-glyph outcomes; mechanism moved to design).
  - Verification holes → unit coverage assigned (rail search, hotkeys), play-state added to
    8.4, divergence-audit artifact added (D15), per-phase review tiers declared.
  - Minors folded: useConfirm overlap/unmount resolve-false; clipboard-unavailable path;
    resume-card definition (first active entry, newest-created) + archived-only copy; League
    Gothic/placeholder-id de-normativized; contrast measurement rule + tokens-as-evidence;
    zero-occurrence grep defined; D3 id disposition; arrow-scrub scope qualifier in the
    shortcuts dialog; "AI v2 isn't configured"/"AI chat isn't configured" strings + README
    tab sentence added to scope (task 7.4).

  **Escalated to the gate (owner decisions — see gate entry below for rulings):**
  (1) sequencing vs the gated pending change
  `ai-session-analyst`, whose plan of record adds an Analyst subtab to the AiPanel structure
  this change dissolves — unacknowledged collision, panel BLOCKER; (2) affirm-on-merits the
  reversible calls D3 (client-side session filter), D9 (503 latch vs deferred capability
  endpoint), D10 (home inside the placeholder), D11's revised derived-dirty model; (3) the
  re-land-with-divergence-audit plan (D15) vs merging the spike.

  **Minors accepted as residual:** Assistant panel deliberately unkeyed by session
  (pre-existing conversation-across-sessions behavior; recorded in the web-session-console
  requirement); typographic glyphs `⋮`/`✕` outside the vector-icon requirement;
  team-management copy (the anonymous-mode notice) intentionally unspecified at capability
  level; the preserved-id rule restated as "every id/name referenced by e2e is preserved
  except those this change's own e2e edits rename".
- **2026-07-21 — GATE (owner rulings, recorded verbatim from the question round):**
  1. **Sequencing: ui-refresh lands first.** `ai-session-analyst` is re-planned afterwards
     via `opsx:update` (+ consistency read) against the five-tab IA before its own apply.
  2. **Design calls:** D11 (derived dirtiness) AFFIRMED as folded. D3 AFFIRMED for this
     change **plus a queued follow-up change** for real cross-session log/transcript search
     (server route — contract delta; drafted as `web-log-search`). D9 AFFIRMED for this
     change **plus a queued follow-up change** for a server capability endpoint (contract
     delta; drafted as `server-capabilities`; the 503 latch is the interim and gets swapped
     out when that lands). **D10 OVERRIDDEN: dedicated home route component** (not
     auto-resume) — folded above (D10 rewrite, web-session-routing delta, web-home-launch
     rewording, tasks 5.1/6.2/8.2).
  3. **Landing: re-land per-unit with the D15 divergence audit** (artifacts-first branch,
     spike quarried where unchanged, atomic commits, per-phase reviews on phases 2 & 6).
  4. **Verdict: PASS — proceed to apply** after the post-gate consistency read.
- **2026-07-21 — post-gate consistency read (light-tier): one finding, fixed** — the Risks
  preserved-id list still named `#v3-session-placeholder` as preserved, contradicting the D10
  override (corrected to the rule + explicit retirement). Otherwise CLEAN; documents read:
  proposal.md, design.md, tasks.md, and all five delta specs (web-ui-system,
  web-session-console, web-home-launch, ai-topics-chat, web-session-routing).
