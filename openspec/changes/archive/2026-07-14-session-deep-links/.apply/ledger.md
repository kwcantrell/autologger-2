# Apply ledger — session-deep-links

Branch: `session-deep-links` (off main @ 32f808d, which includes the vitest 4 chore).
Protocol: subagent-per-task, strictly sequential. Reviews per PHASE (owner decision
mid-apply, 2026-07-14, after phase 1): one reviewer over each phase's cumulative diff
after its last task; mechanical-only phases defer to the final whole-branch review.
Phase 1 predates the switch and was reviewed per-task (stricter — no gap).

Pre-apply note: vitest 2→4 upgrade + workspace→projects migration landed as
`chore/vitest-4` (32f808d, merged to main before this branch). Task 2.1's web tier
therefore starts on vitest 4 (matches design D8).

## Tasks

Task 1.1+1.2: complete (commits 32f808d..4a06e9f, review clean — both verdicts APPROVED, no findings)
Task 1.3+1.4: complete (commits 4a06e9f..7398a7e, review clean — both verdicts APPROVED; serializer extraction shared by both routes; reviewer noted report undercounted requireSession callers (~30, not 7), which strengthens the two-query call)
Task 1.5: complete (commits 7398a7e..84dc5af, skipped-mechanical — README rows + stale page-route prose)
Phase 1: reviewed per-task under the old cadence (both reviews clean) — no phase review needed
Task 2.1: complete (commits 84dc5af..f537db0) — PHASE_BASE for phase 2 = 84dc5af
[interlude] docs(sdlc) commit: per-phase review cadence (CLAUDE.md + SKILL.md) — process, outside phase diffs
Task 2.2: complete (commits f537db0..937b522) — note: added web/src/test/setup.ts (testing-library auto-cleanup; load-bearing for 3.3/4.3/5.2/6.4)
Phase 2: review clean (phase-2-diff.txt — both verdicts APPROVED; setup.ts judgment call endorsed)
[interlude] docs(sdlc) commit 2: dispatch-unit batching at phase start (CLAUDE.md + SKILL.md)
Phase 3 units: [3.1+3.2+3.3] — one unit: all three tasks reshape the same AppShell/SessionWorkspace/HomeSettingsModal seam, and 3.3's tests gate the pair. PHASE_BASE = 937b522
Task 3.1+3.2+3.3: complete (commits 937b522..f9cedd8, incl. docs interlude 16ae2a5) — navigation.ts wrapper (phase-5-ready, no departure logic yet); close paths still call stop directly (by design until 5.1); e2e smoke dataset assertion red-by-design until 8.1; minor: no-session close skips the / push (flagged for review)
Phase 3: review clean (phase-3-diff.txt — both verdicts APPROVED; no-session-close judgment call endorsed)
[interlude] docs(openspec) commit 288f216: change artifacts committed (user prompt — was an orchestrator oversight)
Phase 4 units: [4.1+4.2+4.3] — one unit: hook + resolution component + tests are one seam; tests gate the pair. PHASE_BASE = 288f216
[interlude] docs(sdlc) commit 3: implementers default mid-tier, top tier exception-only. Phases 3+4 units ran on top tier (dispatched before this decision); phase 5 onward defaults to sonnet.
Task 4.1+4.2+4.3: complete (commits 288f216..fd27e92, incl. docs interlude 1207bff) — SessionRoute gates workspace mount; 404-as-data (never retried); latch = staleTime Infinity + focus/reconnect opt-outs; useRestoreSession also invalidates per-id key
Phase 4: review round 1 — spec APPROVED, 1 Important quality finding (gcTime 5-min cached re-entry); fix a420dfb (gcTime: 0 + remount-refetch test) + D5 pinned (within-mount latch); re-review APPROVED (phase-4-diff-r2.txt)
Phase 4 orchestrator notes (verbatim from re-reviewer):
- SessionRoute gates the workspace mount on resolution — phase 5's departure watcher can rely on its resolved-state transitions alongside the navigation wrapper + popstate per D4.
- gcTime: 0 — per-id query cache never survives unmount; phases 5/6 must not assume residual per-id cache across departure/re-entry.
- useRestoreSession.onSuccess invalidates both ['sessions'] and sessionKeys.detail(id) — the pattern for any mutation needing in-place re-resolve.
- navigate() wrapper test seam (setNavigationImplForTesting) already exercised — phase 5 departure and phase 6 stash tests reuse it.
- No residuals carry forward from phase 4 (gcTime residual closed, not deferred).
Phase 5 units: [5.1+5.2] — one unit: TDD pair on the same navigation/transport seam. PHASE_BASE = a420dfb. Model: sonnet (default per SDLC — D4 fully specifies the mechanism).
Task 5.1+5.2: complete (commits a420dfb..9a1760a) — departure watcher on wrapper+popstate; 2 old AppShell tests updated (they pinned the gate-retired unconditional-stop behavior)
Phase 5: review round 1 — quality APPROVED; compliance 1 Important (async-gap origination race: markOriginated after await can set the flag post-departure → next departure from a DIFFERENT rolling session fires its stop) + 1 Minor (no same-id replace-navigate test). Fix dispatched.
Phase 5 orchestrator notes (verbatim from reviewer):
- Phase 6's stash consume will navigate(path, {replace:true}) through the same wrapper — watcher runs on it; post-login return to /sessions/:id can't fire (flag can't be set pre-login); same-id no-fire test added in fix round.
- sessionIdOf strips query/hash before matching — phase 6's ?x=1-bearing return paths won't confuse the watcher.
- Phase 7 (vite middleware): no interaction — watcher is same-document only.
- Phase 8 e2e: existing smoke starts its roll in-UI (originator) so close-stops-roll is unchanged there; only a shared/second-context scenario would observe non-originator semantics.
Phase 5: fix fd51e3b (call-site guard via live refs; race regression test + same-id replace test); re-review APPROVED (phase-5-diff-r2.txt). Same-id replace-navigate no-fire contract now locked in for phase 6's stash return.
Phase 6 units: [6.1], [6.2+6.3+6.4] — validator is a self-contained pure util with its own exhaustive tests; stash write + consume + tests are one seam consuming the validator's interface. PHASE_BASE = fd51e3b. Model: sonnet both.
Task 6.1: complete (commits fd51e3b..9940e6d) — web/src/shared/utils/loginReturnPath.ts, returns validated path or null; 44 corpus tests; %2F/%5C stay percent-encoded in URL#pathname (verified)
Task 6.2+6.3+6.4: complete (commits 9940e6d..ecd5645) — stash key namespaced; remove-before-navigate idempotency; loginReturnPath exports shared isSessionRoutePathname (write/validate share the matcher)
Phase 6: review clean (phase-6-diff.txt — both verdicts APPROVED; adversarial bypass attempt found nothing; wouter pushState noted as independent same-origin backstop)
Phase 6 orchestrator notes (verbatim from reviewer):
- Phase 7 middleware only serves / and /sessions/<segment> shells; no phase-6 code needs dev-server awareness.
- Phase 8.3 should ALSO assert the anchors' hrefs stay /auth/google/start at /sessions/:id — phase 6's stash write silently depends on that contract.
- Phase 8.2 real OAuth-round-trip return assertion is optional, not a gap.
- Phases 7/8 fully independent of phase 6's diff (web-only).
- isSessionRoutePathname (^/sessions/([^/]+)$) is the single source of truth for router-known routes — phase 7's matcher / phase 8's specs should reference the behavior, not re-derive a second regex.
Phase 7 units: [7.1+7.2] — one unit: the README edit documents the middleware's behavior; splitting costs more than it saves. PHASE_BASE = 4511278 (after phase-6 checkbox bookkeeping commit). Model: sonnet.
Task 7.1+7.2: complete (commits 4511278..aeedcec) — pre-hook middleware (design's post-hook suggestion 404s on / in this MPA setup); explicit ./main.tsx → root-absolute rewrite (transformIndexHtml doesn't rewrite relative srcs); curl matrix + Playwright render verified; implementer disclosed a git-stash mishap mid-verification, recovered + reran gates
Phase 7: review clean (phase-7-diff.txt — both verdicts APPROVED; reviewer independently re-ran the curl matrix; stash incident confirmed residue-free). CARRY TO BRANCH REVIEW: Minor — vite.config.ts src-rewrite is a silent no-op if the entry script tag changes shape; add a fail-loud guard (match-count assert).
Phase 8 units: [8.1+8.2+8.3] — one unit: all three tasks live in e2e/ and share the Playwright harness; 8.1's flip is what lets the suite run green at all. PHASE_BASE = aeedcec. Model: sonnet.
Task 8.1+8.2+8.3: complete (commits aeedcec..84829d5) — npm run e2e fully green (chromium 4/4 incl. deep-link smoke; login-gate 4/4 incl. anonymous-deep-link + anchor hrefs). CONCERN under investigation: 17 pixel-diff failures (~3px/0.01) in the separate e2e:visual suite; proven not caused by phase 8's diff, but branch-vs-main causality unknown (baselines frozen pre-branch, main == merge-base 32f808d). Diagnostic dispatched before phase review.
Phase 8: review clean (git show 84829d5 — both verdicts APPROVED; reviewer re-ran both e2e projects). Orchestrator notes: npm run e2e covers chromium only — login-gate project needs explicit --project=login-gate in the 9.1 gates; tasks.md 8.x ticks were missing from the implementer commit (fixed by orchestrator).
Visual diagnosis: VERDICT B — environmental (visual-diagnosis-report.md). Same 17 failures, identical magnitudes, with the full pre-branch web app at merge-base 32f808d against the same frozen baselines; visual.spec.ts + baselines byte-identical since merge-base. NOT branch-induced. Disposition for branch review/archive: pre-existing baseline/environment drift — re-baselining is out of scope for this change (baselines untouched); note for a follow-up chore.
Task 9.1: complete — all gates green at branch tip (typecheck; 395 tests; lint clean, 4 pre-existing warnings; e2e chromium 4/4 + login-gate 4/4)
Task 9.2: complete — whole-branch review APPROVED (branch-diff.txt, top-tier reviewer): contract discipline clean (exactly 2 authorized additions), full spec-scenario sweep mapped, cross-phase seams sound, merge readiness confirmed. Carry item (a) fixed post-approval: 3e5d839 fail-loud dev-shell rewrite guard (smoked).
ARCHIVE NOTES (from branch reviewer):
- Residual to record: visual-suite environmental drift (17 pixel diffs, pre-existing at merge-base) — follow-up re-baseline chore.
- Invariants: navigation.ts is the ONLY wouter-navigate caller; serializeSessionEntry is the one list/detail shape builder; gcTime-0 per-id latch semantics (phases 5/6 assume no residual cache).
- Roadmap: isSessionRoutePathname is the single router-known-route definition; successors extend it, don't re-derive (vite.config.ts mirror regex is the one sanctioned, documented duplicate).
RUN COMPLETE: 26/26 tasks, 8 phases + final gates, all reviews clean.
