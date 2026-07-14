# teams-settings-nav — apply ledger
Branch: teams-settings-nav (off main @ 6087fe165595e13709780ded7fd207f7faa6d50e)
NOTE: tree carries uncommitted deepgram-change files (server/src/node/audioMerge.*, server/scripts/, server/src/test/fixtures/, package.json/package-lock.json/server/tsconfig.json edits) — never staged by this change's units.

Phase 1 units: [1.1+1.2]
Phase 2 units: [2.1+2.2], [2.3]
Phase 3 units: [3.1+3.2]

PHASE_1_BASE=6087fe165595e13709780ded7fd207f7faa6d50e
Task 1.1+1.2: complete (commit 2ca5b1d)
PHASE_2_BASE=2ca5b1d4a632982b338ddf34371d3fbe04804dbe
Phase 1: review clean (phase-1-diff.txt)
Phase 1 orchestrator notes:
- ShowCategory type (web/src/api/types.ts) is now canonical name-keyed shape for Show.categories / ShowUpdateEntry.categories; Category (label-keyed) remains for active_studio/ShowCategoriesResponse/EventLogRow — later phases reuse ShowCategory there.
- ['show-categories'] invalidation lives inside HomeSettingsModal.handleSave alongside ['events']/['session-status'] — phase 2 lifts the modal's MOUNT, not its internals; preserve it.
- Phase 2 must still do the AppShell.test.tsx mock rework named in D1 (useProfileMutation/useCreateShow need mocking once the real modal renders under AppShell) — no incidental progress made.
- No as-any shortcuts; Show.categories is genuinely ShowCategory[] at type level.
- No residuals from phase 1.
Task 2.1+2.2: complete (commit 26544af; ride-along: departureWatcher.test.tsx modal mock)
Task 2.3: complete (commit 83144e2)
PHASE_3_BASE=83144e2df1643c45795a38bcab3041cc64aaa470
Phase 2: review clean (phase-2-diff.txt)
Phase 2 orchestrator notes:
- Phase 3 e2e can rely on: Settings via #v6-btn-settings on /teams renders a real dialog; "Back to sessions" button on /teams is getByRole('button', {name: /back to sessions/i}) and navigates to '/' — real production behavior, not mocked.
- Phase 1's invalidation + name-keyed save untouched by phase 2; only the activeTab reset touched HomeSettingsModal.tsx.
- WorkspaceStatic stays a recorded-deferral memo wrapper — expected, not a residual defect.
- Final review must re-confirm no deepgram-change files staged through phase 3's commits.
Task 3.1+3.2: complete (commit 3aa4377)
Phase 3: review clean (phase-3-diff.txt); reviewer independently re-ran e2e (5/5) + pixel-verified snapshot re-bless.
Process gap (owner-raised + phase-3 reviewer note): gated artifacts were not committed before task execution; landed late as 2455ad1. Future applies: commit artifacts as the branch's first commit.
Final whole-branch review: CLEAN (branch-diff.txt) — approve for merge + archive. 3 minors accepted as residual: mobile-on-/teams settings open covered by shared path not direct e2e; tasks.md ticks rode inside feat commits; rail Teams button silent no-op on /teams (no active-route styling — future rail-polish note).
Archive notes: the three accepted resurrected save behaviors are now live user-reachable semantics (design.md gate log is authoritative); invariant — HomeSettingsModal has exactly ONE mount site (AppShell); WorkspaceStatic memo wrapper is a recorded deferral, not cleanup fodder.
