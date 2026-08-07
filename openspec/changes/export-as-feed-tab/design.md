# export-as-feed-tab — design

## Context

Today `SessionWorkspace` keeps `FEED_TABS` at five entries and mounts `ExportModal` as a
Dialog when Timeline’s `#btn-export-log` sets `showExport`. `web-session-console` owns
tab IA; adding Export requires a delta. Client-side Transcript/Topics CSV helpers already
exist (or land with this change’s panel body); event CSV/JSONL remain server download
links.

## Decisions

### D1 — Sixth tab after Dashboards
**Choice:** `{ id: 'export', label: 'Export' }` appended after Dashboards.
**Alternatives:** keep Timeline button + modal — rejected (mandate). Nested under Event
Feed — rejected (plan: top-level tab).

### D2 — Inline FeedShell panel, not Dialog
**Choice:** refactor `ExportModal` → `ExportFeed` / `ExportPanel` inside `FeedShell`
(title **Export** via count/title chrome); drop `onClose` / Dialog / Close button.
**Alternatives:** keep Dialog opened from the tab — rejected (plan: no Dialog).

### D3 — Download set unchanged from the modal body
**Choice:** Event feed CSV + Transcript CSV + Topics CSV + Event feed JSONL; reuse
`useTranscriptWords` / `useTopics` and existing CSV helpers; server `export.csv` /
`export.jsonl` links unchanged.
**Alternatives:** only server exports — rejected (plan lists all four). Remove
Transcript tab’s own Export CSV — out of scope (explicit Non-Goal).

### D4 — Timeline head actions
**Choice:** remove Export button, `BTN_EXPORT`, `onExport` prop, and the empty
`PANEL_HEAD_ACTIONS` slot if it only held Export.
**Alternatives:** leave a dead actions column — rejected (clutter).

### D5 — Mounted-hidden
**Choice:** Export enters `feedPanels` and the same `hidden` tabpanel map as the other
tabs (warm query cache for words/topics while other tabs are selected).

## Implementation sketch

1. `ExportFeed.tsx` (or rename file): FeedShell + action column; no Dialog.
2. `SessionWorkspace`: extend `FEED_TABS` / `feedPanels`; delete `showExport` + modal mount
   + Timeline `onExport`.
3. `Timeline`: drop export affordance.
4. Tests + `e2e/visual.spec.ts` (tab click; new or updated snapshot name).

## Invariants (do not undo)

- No server contract / new export routes.
- Default tab remains Event Feed.
- Assistant / Dashboards mount discipline unchanged (Export does not need `key={sessionId}`).

## Panel & review log

### 2026-08-02 — Pre-panel fact-check (light-tier)

| Claim | Property verified | Method / evidence | Verdict |
|---|---|---|---|
| Spec freezes exactly five tabs | `web-session-console` SHALL present exactly five tabs in named order | Read `openspec/specs/web-session-console/spec.md` Requirement Workspace tab IA | CONFIRMED |
| FEED_TABS is five entries matching that order | SessionWorkspace tab source matches Event Feed…Dashboards | Read `FEED_TABS` in `SessionWorkspace.tsx` | CONFIRMED |
| Export is Timeline button + Dialog | `#btn-export-log` + `showExport` + `ExportModal` Dialog | Read Timeline + SessionWorkspace + ExportModal | CONFIRMED |
| web-ui-system scenario names Export dialog + Close | Scenario “Export modal buttons…” | Read `openspec/specs/web-ui-system/spec.md` | CONFIRMED |
| e2e visual clicks `#btn-export-log` | `export-modal` test | Read `e2e/visual.spec.ts` | CONFIRMED |

Judgment left unverified for panel: exact Export panel toolbar emptiness vs. empty
toolbar node; snapshot filename (`export-tab` vs keep `export-modal.png`).

### 2026-08-02 — Gate

Owner approved Cursor plan “Export as feed tab” and instructed implement-to-completion.
Treated as human gate for this change.

**Escalated → decided:**
- Tab order: Export after Dashboards (plan).
- No Dialog / no Timeline Export / no Close (plan).
- Downloads: four actions as listed in plan (inline modal body).

**Blockers/majors fixed in place:** none.

**Minors accepted as residual:** visual baseline rename left to implementer; Transcript
toolbar Export CSV remains (Non-Goal).

### 2026-08-02 — Post-gate consistency read

Clean — `proposal.md`, `design.md`, delta specs, and `tasks.md` agree on six-tab order,
inline Export panel, Timeline removal, and web-ui-system scenario retargeting; no
server/contract claims.

- **2026-08-06 — Retroactive multi-agent review (PR #4 pre-merge)**, standing in for the
  skipped adversarial panel and whole-change review (this change's artifacts were
  authored after its implementation; tasks born ticked — recorded deviation). Three
  independent reviewers (contract, code-quality, SDLC) covered the cumulative
  da14b20+8db4e40 web diff. No contract-surface impact (client-side CSV only). Clean
  except items recorded in the maximize-log-view entry (shared diff).
- **2026-08-06 — Transcript CSV export disposition (owner-authorized best-judgment
  call):** commit 9001ff9 (toolbar Export CSV + transcriptCsv util, 2026-07-27) shipped
  with no OpenSpec change, and this change's Non-Goal ("Transcript toolbar Export CSV
  remains") orphaned it — then this change itself relocated the button into the Export
  feed. Disposition: the surviving surface (transcriptCsv util + ExportFeed) is covered
  by THIS change's specs; the interim ungated commit is recorded here as an accepted
  process residual (web-only, no frozen surface). No retroactive change written.
