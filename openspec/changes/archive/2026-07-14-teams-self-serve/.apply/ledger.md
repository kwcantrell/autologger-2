# Apply ledger — teams-self-serve

Branch: `teams-self-serve` (off main @ 64a7816, which includes the committed gated
artifacts). Protocol: subagent-per-dispatch-unit, strictly sequential; phases
partitioned into units at phase start; one reviewer per phase over the cumulative
diff; mid-tier (sonnet) implementers by default, top tier exception-only; final
whole-branch review on the most capable model.

Gate rulings binding this apply (see design.md Panel & review log): D1 backfill
admin-except-built-ins; seeded-session e2e fixture (task 7.1); DoS caps 20/200
(D10); disabled-account redirect account_disabled (D11); email_verified gate (D2);
built-ins excluded from entire /api/teams surface (D3); last-admin = global
invariant over ENABLED admins, transactional (D4).

## Tasks

Phase 1 units: [1.1+1.2] — one unit: migration + the store ops it enables are one
catalog seam; store int tests exercise the migrated schema. PHASE_BASE = 64a7816.
Model: sonnet.
Task 1.1+1.2: complete (commits 64a7816..c8366ea) — 5 migrator + 21 AuthStore int tests
Phase 1: review clean (phase-1-diff.txt — both verdicts APPROVED; full-scan email lookup accepted as residual, email_norm column deferred unless users table grows)
Phase 1 orchestrator notes (verbatim from reviewer):
- Store API: authAddMembershipWithRole (INSERT OR IGNORE), authUpsertMembershipRole (rescue + promote/demote), authGetMembershipRole, authCountEnabledAdmins(studioId), authListTeamMembers(studioId) → {id,email,given_name,family_name,role}[] admins-first.
- Invite ops: authUpsertInvite, authListInvitesForTeam, authDeleteInvite → number (check truthiness, not exact count), authCountPendingInvites, authDeleteAllInvitesForTeam (delete cascade hook), authConsumeInvitesForEmail(emailNorm) → Row[] — composes inside an outer db.tx(); phase 3 must call it INSIDE ports.catalog.tx(...), not wrap its own.
- authListUsersByEmailNorm(emailNorm) → Row[], JS-filtered scan, INCLUDES disabled — phase 3's invite-time matching uses this.
- Phase 2's last-admin check: authCountEnabledAdmins + the mutation inside the same db.tx() for race-freedom.
- No routers/callback/profileAssembler touched — phases 2-4 are pure consumers; no store gaps found.
Phase 2 units: [2.1+2.2] — one TDD unit: the endpoint-family tests and router are inseparable under the green-commit rule. PHASE_BASE = 869325f (after phase-1 bookkeeping commit). Model: sonnet.
Task 2.1+2.2: complete (commits 869325f..a2433b8) — 38 int tests (RED-verified)
Phase 2: review round 1 — contract compliance APPROVED (all 9 routes + default behaviors walked, auth ladder 400-before-404 deliberate + tested); quality FINDINGS: 1 Important (N+1 cap count — "bounded by cap" claim wrong) + artifact gap surfaced (no orphaned-team signal in GET shape → delta amended: enabled_admin_count added to GET detail before freeze) + minor (admin-plane delete cascade untested). Fix dispatched. 400-vs-422 local helper and response shapes APPROVED to freeze as chosen.
Phase 2 orchestrator notes (verbatim from reviewer):
- Response shapes for phase 6: create→{id,name,role}; GET→{id,name,role,enabled_admin_count,members:[{id,email,given_name,family_name,role}],invites?:[{email,invited_at_utc}]}; rename→{id,name} (no role — NOT interchangeable with GET); other mutations→{ok:true} or {ok:true,role}. Errors: {detail:string}.
- members[] has NO disabled flag (deliberate); orphaned-team UI uses enabled_admin_count.
- Phase 3 reuses authListUsersByEmailNorm/invite tables as-is; no phase-2 surface changes needed.
- Phase 4: admin.ts membership-add route untouched — upsert/role work fully pending.
- Cleanup note for branch review: AuthStore.authDeleteAllInvitesForTeam unused (StudioRegistry inlined the cascade SQL — sibling stores can't cross-reference).
Phase 2: fix 56c839b (authCountAdminTeams single indexed query; enabled_admin_count on GET — UNCONDITIONAL, not admin-gated; admin-route cascade test); re-review APPROVED (phase-2-diff-r2.txt). Final GET shape incl. enabled_admin_count is the frozen row for phase 6.
Phase 3 units: [3.1+3.2] — one TDD unit: callback materialization tests + implementation. PHASE_BASE = 4f618de. Model: sonnet.
Task 3.1+3.2: complete (commits 4f618de..d8a5e5e, implementer committed its own tasks.md ticks) — 26 callback tests; email_verified via jose payload index signature (verifier options untouched); deprecation warning tested in new config.test.ts (harness envWith limitation)
Phase 3: review clean (phase-3-diff.txt — both verdicts APPROVED, no findings; CSRF consumed before disabled-check = replay-safe; strict === true email_verified gate fails closed; atomicity proven by fault injection)
Phase 3 orchestrator notes (verbatim from reviewer):
- authAddMembershipWithRole is INSERT-OR-IGNORE (fresh users only); authUpsertMembershipRole is the upsert for phase 4's admin rescue — don't conflate.
- Phase 7 seeded-session fixture must mint via createLoginSession + the callback's cookie name/TTL/flags, and go through authCreateUserGoogle + authSeedPrefsFromGlobals for representative user rows.
- account_disabled code live; phase 5/6 confirm login page's unknown-code handling covers it (copy optional).
- CARRY TO BRANCH REVIEW: consolidate duplicated normalizeEmail (auth.ts + teams.ts) into a shared module — authorization-relevant normalization, drift risk.
- Warning fires once per createBindings (== once per real boot); not singleton-guarded — relevant only if main.ts ever calls it twice.
Phase 4 units: [4.1+4.2] — one unit: one small code-bearing task + its README rows; splitting costs more than it saves. PHASE_BASE = d8a5e5e. Model: sonnet.
Task 4.1+4.2: complete (commits d8a5e5e..56186ba) — profile role field + admin upsert (legacy role-less re-POST downgrade pinned by explicit test); note: authAddMemberships now unused by admin.ts (test seeding still uses it) — cleanup candidate for branch review
Phase 4: review clean (phase-4-diff.txt — both verdicts APPROVED, no findings; authListMembershipsForUser single-query join)
Phase 4 orchestrator notes: profile teams entries now {id, name, role} at auth.user.teams[] — web consumes directly; only GET /teams shell route remains server-side (5.1); support-plane upsert has no last-admin guard by design.
Phase 5 units: [5.1+5.2] — one unit: the serve route, route-module extension + three mirrors, and AppShell wiring are one routing seam; tests gate the pair. PHASE_BASE = 56186ba. Model: sonnet.
Task 5.1+5.2: complete (commits 56186ba..8a05b66) — +13 web tests; curl-verified vite matcher
Phase 5: review clean (phase-5-diff.txt — spec APPROVED incl. standalone checkout-verification of the intermediate commit; 2 quality minors: stale vite inner comment (folded into phase 6 brief), D6 same-commit wording loosened to same-phase in design)
Phase 5 orchestrator notes (verbatim from reviewer):
- Phase 6 fills TeamsRoute's body (id="teams-route-placeholder", data-testid="teams-route") — routing/gating/departure seam proven; pure content, no AppShell.tsx changes expected.
- Phase 6 should reconsider the stub's role="status" once real content lands (static shell doesn't need a live region; async loading states might).
- Phase 7 e2e: full /teams round-trip through a real browser (reload on /teams via production serve, sign-in-from-/teams stash round-trip, Back-from-/teams) — only unit/int covered so far.
- isRouterKnownPathname is an OR of two exact predicates — additive-open for future routes.
Phase 6 units: [6.1+6.2+6.3] — one unit: hooks + page + onboarding are one web seam consuming the same API shapes; tests gate throughout. PHASE_BASE = 08465bc (after D6 wording commit). Model: sonnet.
Task 6.1+6.2+6.3: complete (commits 08465bc..e050354) — +21 web tests (157 total)
Phase 6: review clean (phase-6-diff.txt — both verdicts APPROVED). Dispositions: BUILTIN_TEAM_IDS accept-with-comment (no contract amendment — bounded non-security drift, frozen 2-entry list); V6Rail untested accepted (pre-existing gap, one-liner through the wrapper); onboarding route-agnostic behavior BLESSED in spec (phrasing amended).
Phase 6 orchestrator notes (verbatim from reviewer):
- e2e testids ready: team-toggle-<id>, team-admin-panel-<id>/team-member-panel-<id>, team-create-form, onboarding-panel, teams-route, rail #v6-btn-teams.
- Phase 7 must e2e-verify a fresh zero-membership seeded user hits the onboarding panel (unit-tested only so far).
- CARRY TO BRANCH REVIEW: BUILTIN_TEAM_IDS client/server duplication as a tracked note (surfaces if a third built-in is proposed).
Phase 7 units: [7.1+7.2+7.3] — one unit: harness fixture + both smokes are one e2e seam; 7.1 is 7.2's prerequisite. PHASE_BASE = 767d134. Model: sonnet.
Task 7.1+7.2+7.3: complete (commits 767d134..97304de) — chromium 8/8, login-gate 5/5; seeding on :8791 (cookie resolution REQUIRE_LOGIN-independent, verified). OPEN QUESTION for phase review: visual suite 23 failed vs 17 documented — RESOLVED below.
Phase 7: review — gate compliance APPROVED (fixture byte-for-byte mirrors callback shapes, zero product-code touches); test quality: 1 Major on the REPORT's visual characterization (not the code): 17 failures = pre-existing environmental class, 6 = BRANCH-INDUCED (Teams rail button vs stale baselines; diff PNGs show the rail collision) — expected UI consequence, not a regression; report corrected by orchestrator note. No code fix round needed.
VISUAL DISPOSITION FOR ARCHIVE: 17 environmental (carried from session-deep-links) + 6 branch-induced (Teams rail button) = 23; re-baseline chore now covers two changes' UI deltas — increasingly worth scheduling.
Task 8.1: complete — all gates green (typecheck; 512 tests; chromium 8/8; login-gate 5/5; lint 4 pre-existing + 1 branch warning queued to fix round)
Task 8.2: whole-branch review (top tier) — FINDINGS, one fix round: (1) Major README omits account_disabled from the code enumeration; (2) Major normalizeEmail in THREE places incl. a factually-false comment — consolidate to shared.ts; (3) lint one-liner AppShell:173; (4) dead authDeleteAllInvitesForTeam + test; (5) BUILTIN_TEAM_IDS comment pointer. Accepted no-fix: authAddMemberships/authCountPendingInvites (test-seam callers), full-scan lookup, visual disposition as recorded. Contract discipline + spec sweep + seams all CLEAN; seeded-session proof spec confirmed as a live drift tripwire. Fix dispatched.
ARCHIVE NOTES (from branch reviewer): record residuals — stranded invites, create-slug existence oracle, invite-list PII, client-side built-in list, visual baselines stale across two changes (schedule re-baseline chore). Invariants: teams role checks ONLY in teams.ts (never requireSession); frozen shapes incl. unconditional enabled_admin_count; four-way route-table lockstep. NEW_USER_ALL_TEAMS full removal = possible future change.
Fix round 03ff88f: all five findings fixed; re-review APPROVED (branch-fix-diff.txt — normalizeEmail single-sourced in shared.ts w/ three importers; AppShell condition reasoned equivalent across all profile states; lint at 4 pre-existing; diff scope exact).
RUN COMPLETE: 18/18 tasks, 7 phases + final gates, all reviews clean. Merge + archive pending owner go.
