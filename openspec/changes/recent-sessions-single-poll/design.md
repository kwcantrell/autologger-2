# recent-sessions-single-poll — design

## Context

`SessionCard` (RecentSessionsList.tsx) mounts
`useSessionStatus(isActive || s.is_rolling ? s.id : null)`; the hook polls at
1.2s while a session is rolling/recording. N rolling background cards → N
pollers. The 5s sessions-list poll already delivers `is_rolling` and
`rolling_timecode` per row; the card already falls back to
`formatTimecodeHMS(s.rolling_timecode)` when the status query has no data. The
active card's query is cache-shared with the workspace's own status query
(same key), costing nothing extra.

## Goals / Non-Goals

**Goal:** at most one status poller regardless of list size. **Non-Goals:** see
proposal (no batch endpoint, no WS list updates, no cadence changes elsewhere).

## Decisions

### D1 — Gate the card's status query on `isActive` alone

Alternatives: (a) list-level aggregate endpoint (new contract surface — YAGNI);
(b) longer per-card interval (still N pollers); (c) WS per-session subscriptions
(heavy, new semantics). Chosen: change the gate to `isActive ? s.id : null`.
Background rolling cards derive `isLive` from `s.is_rolling` and the timecode
from `s.rolling_timecode` — both already rendered as fallbacks today, so the
change deletes freshness, not capability. Active card behavior byte-identical
(same shared query).

### D2 — Badge derivation stays union-shaped

`isLive` keeps the `s.is_rolling || status?.…` union so the active card still
lights for recording-without-rolling; for background cards `status` is simply
absent and `s.is_rolling` governs (recording implies rolling for list purposes
— the existing comment's invariant, unchanged).

## Risks / Trade-offs

- Background rolling cards' timecode updates every ~5s instead of ~1.2s — the
  accepted UX cost, spec'd. The open session (the one the operator watches)
  is unchanged.
- Background rolling cards also change FORMAT: steady-state today they render
  the status query's full SMPTE (`HH:MM:SS:FF`); after, always
  `formatTimecodeHMS`'s `HH:MM:SS`. Disclosed in the proposal and pinned in
  the delta — approved knowingly at the gate, not implied byte-equivalence.
- The "no poller beyond the workspace's own" bound is stated observably; the
  cache-shared-query mechanism (identical react-query key) is rationale, true
  today because open-card ⇔ workspace-mounted is structural in AppShell.
- If the list poll is ever slowed, background liveness staleness grows with it
  — cadence coupling recorded here.

## Panel & review log

(Fact-check, panel, gate entries below.)

- **2026-08-07 — Pre-panel fact-check (light tier, shared pass with
  event-metadata-reserved-keys):** 6/6 claims CONFIRMED, none corrected —
  gate/poll cadences, row fields + existing fallback, identical query key with
  the workspace (cache-shared), no baseline spec pins card polling, existing
  tests don't inspect the hook's arguments (no conflict). Nuance for the
  panel: recording-implies-rolling is CLIENT-enforced (lease store has no
  transport dependency); a transient `is_rolling:false, lease_alive:true` row
  is theoretically possible — but today's gate also subscribes no query for
  such a background card, so the new gate changes nothing for that state.

- **2026-08-07 — Adversarial panel (3 reviewers, 4 mandates — failure+scope
  combined; shared panel with event-metadata-reserved-keys):** verdict
  approve-after-fixes. MAJOR fixed in place: the artifacts presented the
  change as cadence-only, but background rolling cards also permanently lose
  the frame field (status SMPTE `HH:MM:SS:FF` → list `HH:MM:SS`) — now
  disclosed in the proposal, pinned in the delta requirement/scenarios, and
  tasks 2.1's visual instruction reworded so a legitimate consequence isn't
  "fixed" as a defect; the gate approves it knowingly. Minors fixed: "open
  session" terminology (baseline uses "active" for non-archived) with an
  in-spec definition; zero-open-session scenario + test (the most common
  state — and where the change also ends today's perpetual off-route 1.2s
  polls, now claimed in the proposal); cache-share parenthetical demoted to
  rationale in favor of the observable no-extra-poller bound; test wording
  fixed to hook-receives-null/no-background-fetch; archive-time Purpose-line
  touch queued as task 2.2. Discharged: rolling_timecode is computed at
  response time (fresh at 5s); open-card ⇔ workspace-mounted is structural;
  cache GC safe; transient lease state a no-change.

- **2026-08-07 — Gate ruling (owner):** APPROVED as panel-hardened, KNOWINGLY
  including the background-card trade-off (5s cadence + HH:MM:SS, frame field
  dropped; open session unchanged). tasks.md is the plan of record.

- **2026-08-07 — Post-gate consistency read (light tier, shared):** two
  findings — proposal still stated the cache-share mechanism normatively
  (reworded to the observable no-extra-poller bound) and carried the
  pre-fact-check MODIFIED-conditional placeholder (resolved to ADDED). All
  else coherent (documents read: all four artifacts + delta).

- **2026-08-07 — Apply record + review/audit:** single-unit apply (9b62b29);
  combined review + audit verdict **MERGEABLE** — all three delta scenarios
  mapped to named tests, the two new/extended assertions MUTATION-VERIFIED
  (pre-change component restored transiently: exactly they failed), comment
  accuracy checked claim-by-claim, single-hunk tsx diff with everything else
  untouched, tasks ticked without reinterpretation (2.2 left for archive).
  Minors accepted: compositional coverage of scenario 1's WHEN; the
  zero-open-session loop lacks an explicit non-empty guard (vacuity precluded
  by the data-live assertions). Gates green incl. e2e 20/20 and visual 44
  with ZERO diffs.
