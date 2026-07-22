# Proposal: ui-refresh

## Why

A dual-agent design critique of the web frontend (2026-07-21, snapshot preserved at
`.impeccable/critique/2026-07-21T19-20-50Z__web-src.md` on branch `ui-refresh-spike`) scored the
UI **21/40** and found four P1 defects: a dead search affordance that strands keyboard focus
off-screen, a spatially broken row-delete control (every row's delete button renders stacked at
one detached point below the table), a pre-V5 legacy component vocabulary (`.btn` grey chrome,
emoji iconography, native `window.confirm`) surviving inside prime flows, and violations of the
product's own WCAG-AA bar on its own time data (timeline ticks at 2.96:1) plus an unguarded
marquee under `prefers-reduced-motion`. Beyond the P1s: the core logging loop is invisible in a
stopped session, has no keyboard path, the home route is an unbranded void whose copy is wrong on
mobile, the tab nav wears its migration history ("AI", "AI v2"), and capability-gated features
are discovered by failing with no remedy named.

**Process note:** a full reference implementation of this change was built and verified ahead of
this proposal (branch `ui-refresh-spike`, commit `be7e044`) — a deviation from the SDLC, called
out by the owner and being remediated by this change. The artifacts codify that implementation's
design decisions; the panel reviews them with the spike available as evidence, and
implementation re-lands from a clean `main` under the apply protocol.

## What Changes

- **Repair the four P1s**: real rail session-search (replacing the offscreen-input hack);
  row-delete anchored inside its row with an SVG icon; the legacy `.btn`/form family re-skinned
  to the V5 glass vocabulary in one systemic edit; a shared themed `ConfirmDialog` replacing all
  `window.confirm`/`window.prompt`/bare `confirm()` call sites (11 total across EventLogSheet,
  RecentSessionsList, TeamCard, HomeSettingsModal, the orphan-recording recovery warning in
  `useRecoveryStopWarning`, and the admin-users page — the last two found by the fact-check
  pass and added to scope beyond the spike); AA contrast fixes (ticks, inactive tabs, eyebrows,
  placeholders) and `prefers-reduced-motion` guards.
- **Core-loop discoverability**: the category strip renders (disabled, with a "press Roll" hint)
  in stopped/play transport states; `1–9` hotkeys log the first nine categories while rolling
  (numbered badges on live tiles); a `?` keyboard-shortcut reference dialog with a visible entry
  point; tooltips on transport tiles; raster transport/timecode PNGs replaced by currentColor
  SVGs; the never-wired top-bar "Recording audio" indicator wired for real.
- **Home launch surface**: `/` renders a dedicated branded home route component (wordmark,
  tagline, resume-most-recent-session card, New Session action) in the workspace's place,
  with copy that is correct on every viewport; the legacy placeholder element is retired
  (gate-ruled D10 override — the spike's render-into-placeholder approach is superseded).
- **Five-tab IA restructure**: session-workspace tabs become Event Feed | Transcript | Topics |
  Assistant | Dashboards — Transcribe/Topics lifted out of the nested "AI" subtab arrangement,
  "AI"/"AI v2" renamed to human names. Mounted-hidden tab discipline and
  `AiV2Panel key={sessionId}` are preserved unchanged.
- **Honest capability gates**: transcript/topics generation latch their first 503 into a
  disabled control plus empty-state copy naming the cause and remedy, with a single inline error
  channel (duplicate toasts removed); the Teams anonymous-mode notice explains why there is no
  sign-in button; the Settings modal gains dirty-state tracking (Save disabled until changed,
  guarded Close) and a themed Add-Show dialog; New Session collapses to its core fields with
  YouTube import and timecode settings behind progressive disclosure.
- **Minors**: rail metadata legibility bump, keyboard-visible row menus, session-ID copy chip,
  mobile tab-strip scrolling and toolbar fit, mis-stating Settings copy corrected.

## Capabilities

### New Capabilities

- `web-ui-system`: the frontend's component vocabulary and interaction-quality bar — single V5
  glass vocabulary for buttons/forms/dialogs, themed confirmations, AA contrast floor,
  reduced-motion guards, SVG-only iconography.
- `web-session-console`: the session workspace's operator experience — five-tab IA, stopped-state
  logging visibility, logging hotkeys, shortcut reference, truthful recording indication,
  honest capability gating on generation features.
- `web-home-launch`: the no-session home surface — brand presence, resume-last-session, New
  Session entry, viewport-correct copy, real rail session search.

### Modified Capabilities

- `ai-topics-chat`: its "AI tab and subtab arrangement" requirement normatively pins a
  two-top-level-tab / three-subtab structure (label strings are carved out as non-normative,
  the STRUCTURE is not — fact-check finding, 2026-07-21). The delta rewrites that requirement
  to defer tab structure/labels to `web-session-console` (the panel-ruled single owner) while
  carrying forward, scenarios included, every chat/feed semantic: feeds unchanged, turn
  survival across switches, `create_topic` liveness refresh, Stop, and the 503
  not-configured state.
- `web-session-routing`: gate override of D10 (2026-07-21) — the no-session home view becomes
  a dedicated home route component, so the "Legacy selection spine retired" requirement's
  placeholder↔grid swap language is modified (the legacy `#v3-session-placeholder` element is
  retired; the swap becomes route-driven mounting). Deep-link resolution, latching,
  navigation-funnel, and departure-watcher requirements are untouched.

<!-- Unchanged: ai-v2-dashboards (its "AI v2 tab" requirement pins mounted-hidden +
     hoisted-state semantics "alongside the existing tabs", not nesting or the label —
     verified), team-management, api-contract-freeze. -->

## Impact

- **Sequencing collision (gate decision required):** the gated, not-yet-applied change
  `openspec/changes/ai-session-analyst` plans an `Analyst` subtab inside the AiPanel subtab
  structure this change dissolves. Whichever lands second must be re-planned; the gate rules
  the order and the loser's artifacts get an `opsx:update` + consistency read. This change's
  artifacts assume ui-refresh lands first.

- **Frontend only** (`web/src/**`, `e2e/**`): ~30 components/styles/tests plus the Playwright
  suite and re-blessed visual baselines. No server code.
- **HTTP/WS contract: no observable change** — no route, JSON shape, status code, or WS message
  is added or altered (capability gating is inferred client-side from existing 503 responses;
  no capability endpoint is added *because* the contract is frozen).
- **Shipped invariants preserved**: `navigation.ts` as sole navigate caller;
  `isSessionRoutePathname` single route definition; `HomeSettingsModal` single AppShell mount;
  mounted-hidden tab panels (no unmount of in-flight chat/design streams);
  `AiV2Panel key={sessionId}`.
- **Tests**: unit tests updated for the tab IA + Save-dirty model; e2e selectors updated for the
  renamed tabs; visual baselines re-blessed (sanctioned `e2e:visual:update` flow).

## Non-Goals

- No server-side changes of any kind; no new API surface (a server capability endpoint for
  honest gating is explicitly deferred — it would need its own contract-delta change).
- No redesign of the Event Buttons settings editor's per-row density (recorded residual).
- No change to the `hover-always` touch-latch behavior (accepted audit-G residual).
- No per-session `document.title`, no auto-redirect of `/` to the last session (the launch
  surface keeps `/` stable for the routing spec's latching semantics).
- No dark/light theming work; the V5 dark system is the committed identity.
