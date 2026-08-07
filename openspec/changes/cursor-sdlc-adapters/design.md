# Design: cursor-sdlc-adapters

## Context

The repo's SDLC rules live normatively in exactly three operational encodings (`CLAUDE.md`
"How we work (SDLC)", `.claude/skills/openspec-apply-change/SKILL.md`,
`openspec/config.yaml`) — capability `sdlc-process`, gate ruling 2026-07-14. The prior
Cursor artifact set violated that ruling (drifting `AGENTS.md` copy; stock opsx bodies
actively contradicting the encodings) and was deleted on `pr-3-review` (`0a13b54`) and
again on this branch (`ed43b29`). A Cursor-using contributor still needs in-editor
tooling. This change reinstates the surface as pointer adapters with CI enforcement and
designed stop/handoff points.

**Efficacy record (honest baseline, panel-corrected):** a materially similar routing rule
(`openspec-sdlc.mdc`, commit `0c1d213`, 2026-07-27 — always-on, skill-routing,
gate-stating) was live throughout the PR #3 deviation window. Routing alone demonstrably
did not produce compliance. The deltas this change adds over that failed baseline:
removal of the contradicting stock bodies *including in routed targets* (D8), the
closed-world drift guard (D5), and designed apply/panel handoffs (D9). No stronger claim
is made.

**2026-08-06 fidelity-review dispositions** (the review that motivated `ed43b29`; findings
were reported in-session and are recorded durably here): B1 stock apply.md inline loop →
addressed by D1/D8/D9; B2 reintroduction-via-merge of a ruled-out set → addressed by
`ed43b29` + this gated change; B3 foreign-machine mcp.json → addressed by D4; M1
propose.md gate-skip → addressed by D8; M2 AGENTS.md drifted copy → addressed by D2; M3
practice-record under-constraint → addressed honestly in scope (see efficacy record); M4
coverage gaps → addressed by D3 bounded stop-conditions + D9; m1 restart-rule scope/drift
→ escalated (E1); m2 unadapted stock commands → addressed by D1 (pending E2 at the time; later ruled keep).

## Goals / Non-Goals

**Goals:**
- A Cursor session is routed to the same normative sources as a Claude Code session, with
  every point where Cursor *cannot* execute the process turned into an explicit designed
  stop/handoff instead of an improvised fallback.
- **Drift enforcement, honestly scoped**: the guard is a conspicuousness tripwire — it
  catches stock regeneration, foreign paths, oversized files, unenumerated files, and
  stale pointers, and it forces any legitimate adapter change to be a deliberate,
  reviewable guard edit. It does not prove content-freedom (paraphrase, splitting, and
  negation evade any textual check); that residue stays review-time.
- Portable tracked config with zero dependencies on any particular machine's Cursor
  capabilities.

**Non-Goals:** (see proposal; binding here too) no rule-content changes beyond the D8
alignment, no Cursor-native apply, no replacement-architecture evaluation, no claim of
behavioral enforcement.

## Decisions

### D1 — Adapters are pointer-only instruction files with a per-verb runnability map
Each shipped `.cursor/commands/opsx/<verb>.md` (E2: keep, gate ruling 2026-08-06)
contains: one sentence naming the task, an instruction to **read the full file and
follow** `.claude/skills/openspec-<mapped>/SKILL.md`, and the verb's stop-condition(s)
within the D3 bounds — one for most verbs; propose carries two (D8's gate stop and D9's
panel-dispatch-or-handoff). Mapping (from the in-repo skills inventory, fact-check confirmed):
explore→`openspec-explore`, propose→`openspec-propose`, update→`openspec-update-change`,
sync→`openspec-sync-specs`, archive→`openspec-archive-change`, apply→**no skill routing**.
**Runnability map (panel blocker fix):** explore, propose, update, sync, archive are
Cursor-runnable (single-context work; archive's whole-branch-audit precondition is stated
by its own skill). Apply is NOT Cursor-runnable — its protocol requires subagent dispatch
and model-tier control Cursor does not provide — so `apply.md` is a stop/handoff: "apply
executes via the subagent-dispatch protocol in
`.claude/skills/openspec-apply-change/SKILL.md`; this environment cannot dispatch
subagents — STOP and hand the change off to the owner's orchestration environment; do not
implement inline." A "degraded Cursor apply" is deliberately not designed (Non-Goals);
the adapter must not imply one exists.
- *Alternative — repo-customized full command bodies:* rejected; the relocated drift
  generator. *Alternative — stock commands + strong rule:* rejected; recorded failure
  (fidelity B1: injected command text wins).

### D2 — `AGENTS.md` is a short pointer file, not a symlink, not a copy
~12 lines: `CLAUDE.md` is the normative instruction source, read it fully before acting,
do not act on restatements — plus the D9 handoff sentence. Symlink rejected (unreliable
on Windows checkouts — inference from the confirmed `C:\Users\EnnyMura\…` mcp.json path
and committer identity; unverified as the contributor's actual OS, but the pointer
document dominates the symlink in every case since it can carry the handoff and
no-restatement instructions). Full synced copy rejected (recorded 291-line drift).

### D3 — `openspec-sdlc.mdc` stays always-apply; stop-conditions are bounded
Frontmatter `alwaysApply: true`. Body: the three encodings by path; "read CLAUDE.md 'How
we work (SDLC)' fully before design-bearing work"; and **bounded stop-conditions** under
the adjudication test (panel fix, normative in the capability spec): a stop-condition
(a) names a state the agent cannot otherwise know it is in and where to read
("tasks.md is provisional until the gate recorded in CLAUDE.md has run"), (b) never
characterizes *how* any process step runs (that is procedure = restatement), and (c) is
capped at **four stop-condition lines per file** — the gate stop, the apply handoff, the
frozen-contract pointer, the worktree ban. A file needing a fifth is presumptively
becoming a rulebook and the guard budget forces that edit into review.

### D4 — `mcp.json` is unconditionally untracked; `.example` is the tracked artifact
No conditional on Cursor interpolation support (panel simplification — the conditional
existed only to defend an unverifiable environment fact). `.gitignore` gains
`.cursor/mcp.json`; the tracked `.cursor/mcp.json.example` carries the localization
instructions and the pinned package spec (`@colbymchenry/codegraph@<exact version>` — no
`-y` floating install). The guard asserts: gitignore entry present, example present,
example contains the exact expected package-spec literal (any bump/swap is a conspicuous,
reviewed edit), example passes the same banned-phrase/size scan as adapters (config files
can carry directive text too). Supply-chain residual recorded in Risks.

### D5 — Drift guard: closed-world repo-scan test in the `*.repo.test.ts` family
New `web/src/cursorAdapters.repo.test.ts`, colocated with the three existing repo-scan
guards (all resolve repo root via `fileURLToPath(import.meta.url)` — same mechanism, no
cwd or git-subprocess dependency; tracking-state asserted textually via `.gitignore`
content, not `git ls-files`). Checks:
1. **Closed world (the load-bearing check, panel blocker fix):** walk `.cursor/**`
   recursively, plus every `AGENTS.md` at any directory depth, plus `.cursorrules` at
   root. Any file found that is not on the explicit allowlist FAILS the suite. (Nested
   `AGENTS.md` files and new `.mdc`/command files are the recorded evasion channel.)
2. Per allowlisted file: exists; ≤ 30 lines AND ≤ 2,000 characters (a long-line rulebook
   cannot hide in a short file); counting includes frontmatter and blank lines
   (deterministic budget); contains the path-literal pointer to its mapped normative
   target (routing artifacts only — the restart rule is exempt from the pointer check
   per D6/E1, all other checks apply); matches no banned phrase — scan covers the whole
   file including frontmatter.
3. Banned phrases (from the stock bodies, fact-check confirmed verbatim): "Make the code
   changes", "Ready for implementation", "to start implementing". Matching is
   case-sensitive substring; the propose adapter's legitimate stop-condition is phrased
   to avoid collision ("stop before apply", never "run /opsx:apply") — the guard is why
   that phrasing constraint exists.
4. D4 assertions (gitignore entry, example presence/content/package-spec literal).
5. Stop-condition line cap per D3 is enforced as review discipline, not parsed by the
   guard (adjudicating "what is a stop-condition" mechanically is not worth the
   machinery; the size budgets are the mechanical backstop).
- *What the guard is NOT (recorded, panel fix):* proof of content-freedom. Paraphrased
  rules, rule content split across files, and pointer-negating text ("follow the skill
  except…") pass it. Those are review-time; the guard's job is making every change to
  this surface loud.
- One-time check that the guard's predicate rejects the pre-drop stock bodies runs
  against `git show ed43b29^:<path>` output during implementation and is recorded in the
  ledger — the stock bodies are never committed as fixtures.

### D6 — `restart-server-yourself.mdc` ships with the ownership fix (GATE ruling E1, 2026-08-06)
The gate ruled **keep with the ownership fix** over the scope reviewer's cut
recommendation (both positions were escalated; owner decided). The shipped rule:
authorizes restarting only (a) processes the agent itself started, or (b) a listener the
agent has identified as this repo's dev process by its command line; everything else —
including unidentified `:8787`/`:5173` listeners and always `:8791` — is ask-first;
`:5173` disposition stated explicitly in the rule; restart commands referenced via the
repo's package scripts. Guard treatment: this file is the one allowlisted non-routing
rule — guard check 2's pointer requirement is scoped to the SDLC-routing artifacts, and
this file gets the budgets/banned-phrase scan only (the capability spec's requirement 4
is its normative anchor instead of a pointer target).

### D7 — Lands on this branch (PR #4), after `ed43b29`
Unchanged: same-PR ordering so main never sees the stock set tracked. First
implementation commit is the gated artifacts.

### D8 — The routed targets are in scope: customize `openspec-propose/SKILL.md`
Panel blocker fix: the propose skill is stock generated output whose Output step
instructs "Run `/opsx:apply` … to start implementing" — the gate-skip living in the
routed target. The change: replace that Output step with the gate stop (artifacts
complete → tasks.md provisional until fact-check + panel + gate; do not suggest or run
apply), mirroring the existing repo customization pattern in the apply skill, and extend
CLAUDE.md's "re-apply that customization if the CLI regenerates the skill" note to name
the propose skill too. Normative anchor: the capability spec requires adapters' routed
targets not to contradict the gate ordering — the requirement governs the pointed-at
file, not just the pointer.

### D9 — Panel reachability: native dispatch or handoff, never emulation (GATE ruling E3, 2026-08-06)
The panel's value is structural — N independent fresh-context reviewers with distinct
adversarial mandates, then synthesis — not vendor-bound; it does not require Claude
models. **Premise correction folded at gate time:** the panel's assumption that "Cursor
cannot dispatch subagents" is stale for current versions — Cursor ≥2.4 (Jan 2026) has
subagents with independent context windows, 3.2 added parallel `/multitask`, 3.5 added
cloud agents. The gate therefore ruled: the fact-check + panel MAY run natively in a
Cursor session **iff** it uses real independent-subagent dispatch (fresh contexts, the
four distinct mandates, read-only reviewers, NO git worktrees — repo invariant — and the
synthesis + dispositions recorded in the Panel & review log); otherwise the session
hands the change name to the owner's orchestration environment. **Single-context panel
emulation (one context role-playing multiple reviewers) is forbidden in every case** —
it forges the independence the log attests (recorded precedent: PR #3's Cursor-plan
stand-in missed a cross-tenant leak). The human gate is ALWAYS the owner's, wherever the
panel ran. Apply remains handoff-only regardless (D1): Cursor's parallel execution leans
on git worktrees, which this repo bans, and the apply protocol's ledger/tier mechanics
are unported — a Cursor-native apply would be its own gated change. The adapter surface
carries all this as one routed stop-condition (state + pointer), with the conditions
normative in the capability spec.

## Deliberate invariants (do not "helpfully" undo)

- **Adapters stay content-free; the closed world stays closed.** Inlining skill text, or
  adding an unenumerated file under `.cursor/`, recreates the parallel rulebook — the
  guard's allowlist failure is the designed friction.
- **The apply adapter stays a handoff.** "Improving" it into a Cursor-native apply loop
  is the recorded pre-drop defect; a real degraded mode needs its own gated change.
- **The banned-phrase list, budgets, and allowlist live in the guard test** — enforcement
  detail, not process rules.
- **mcp.json stays untracked** — re-tracking it "because it now works on my machine" is
  the recorded B3 defect shape.

## Risks / Trade-offs

- [Routed guidance alone has a recorded failure (0c1d213 live during deviations)] →
  RESIDUAL with one recorded failure, not "mitigated": this change's additional levers
  are stock-body removal (incl. D8) and the guard; behavioral compliance stays
  review-time (commit shape, panel logs).
- [Two-hop pointer-following unverified: a Cursor command turn may ingest only a prefix
  of a 500-line skill] → adapters instruct reading the FULL file; behavioral spot-check
  on the contributor's machine is a non-gating follow-up task with conservative default
  (if unverifiable, the runnable-verb adapters still route and the failure mode is the
  status quo ante, not a regression).
- [Guard and adapters are same-commit editable; a session that edits both and skips
  review defeats the tripwire] → RESIDUAL, recorded honestly: the guard protects against
  drift-by-accident and forces conspicuousness under review; it does not constrain a
  session that also rewrites the guard.
- [Supply chain: version pin has no integrity hash; transitive deps resolve fresh;
  example↔local-copy drift is silent] → RESIDUAL: the guard's exact-literal check makes
  package changes reviewable; deeper controls (lockfile'd install) out of scope.
- [Cursor surface variance: rule attachment/AGENTS.md handling across chat/agent/CLI
  modes and versions] → non-gating verification on the modes the contributor actually
  uses; conservative default is already shipped (both routing surfaces are pointers, so
  a non-attaching surface degrades to status quo ante).
- [Contributor-machine checks could stall the branch] → all such checks are non-gating
  follow-ups with conservative defaults; no task in the plan of record blocks on another
  person's machine.
- [`CLAUDE.md` is Claude-Code-flavored; a Cursor agent routed into it reads about tools
  it lacks] → acceptable for informational reads; the D1 runnability map and D9 handoff
  cover the executable boundaries. Noted, no action.

## Migration Plan

Additive files + one guard test + one skill-file customization + a one-line CLAUDE.md
note + a `.gitignore` line; no runtime surface. Rollback = revert the implementation
commits. The contributor localizes `.cursor/mcp.json` from the example once and deletes
any stale cached copy.

## Open Questions

None — E1/E2/E3 ruled at the 2026-08-06 gate (see D6, D1/proposal, D9 and the Panel &
review log).

## Panel & review log

- **2026-08-06 — Pre-panel fact-check pass** (light-tier, fetch-and-compare): 11 claims
  checked across proposal/design/both delta specs — 10 CONFIRMED, 0 corrected,
  1 UNVERIFIED (D2's "contributor is on Windows" is an inference; the mcp.json
  Windows-path evidence and the EnnyMura committer identity are confirmed, the OS itself
  is not mechanically provable — panel treated D2's symlink rejection as resting on
  corroborated-but-unproven grounds; D2 now records the decision as robust to the
  inference failing). Notable confirmations: the sdlc-process MODIFIED block reproduces
  the baseline byte-identical except the inserted allowance and one new scenario
  (diff-verified); pre-drop stock bodies contain the banned phrases verbatim; all six
  opsx→skill mappings exist; repo-scan precedent files exist and run under `npm test`;
  ports 8791/8787 confirmed; commits 0a13b54/ed43b29/3cc98c3 verified with ancestry.

- **2026-08-06 — Adversarial panel** (4 reviewers: requirements / assumptions /
  failure & abuse / scope & simpler design; all skeptical-calibrated). Dispositions:

  **Blockers/majors fixed in place:**
  - Propose adapter routed to a stock skill containing the gate-skip verbatim
    (requirements B1) → D8: customize `openspec-propose/SKILL.md` Output step + CLAUDE.md
    note; capability requirement extended to routed targets.
  - Apply adapter routed into a protocol Cursor cannot execute; fallback undesigned
    (assumptions B-1, requirements M2) → D1 runnability map; apply adapter is a
    stop/handoff; Non-Goal "no Cursor-native apply".
  - Guard was open-world; rulebook regrows in an unenumerated file (failure/abuse B1,
    requirements M3) → D5 closed-world walk of `.cursor/**` + all `AGENTS.md` depths +
    `.cursorrules` with allowlist failure; new spec scenario.
  - Unbounded state-plus-pointer carve-out adjudicates nothing (failure/abuse M1,
    requirements M4b) → D3 adjudication test + four-line cap, normative in the
    capability spec.
  - sdlc-process allowance pre-authorized ungoverned adapter surfaces (failure/abuse M3,
    requirements M4a) → delta now requires a governing capability + guard per surface
    and makes new adapter surfaces design-bearing.
  - Efficacy framing contradicted by field data — prior routing rule `0c1d213` live
    during PR #3 deviations (assumptions M-1) → proposal Why rewritten; risk downgraded
    from "mitigated" to residual-with-recorded-failure.
  - Panel/gate unreachable from Cursor; stop stranded the contributor or invited panel
    emulation (assumptions M-2) → D9 handoff design; E3 confirms the workflow at gate.
  - Guard evadable via line length, frontmatter, and mcp-example content (failure/abuse
    M4); budget counting rules unstated (assumptions m-6); banned-phrase collision with
    the legitimate stop-condition (requirements m8) → D5: char cap, whole-file scan,
    deterministic counting, collision-avoiding phrasing, example scanned +
    package-spec-literal assertion (also failure/abuse m2).
  - "Zero-drift by construction" overclaim (failure/abuse m1, requirements M5) →
    Goals/D5 reworded: conspicuousness tripwire; evasion residuals recorded.
  - mcp.json conditional design + guard git-subprocess dependency (scope M2,
    assumptions m-5) → D4 unconditional untracked + example; textual assertions only.
  - Fidelity review cited but not durably recorded (requirements m6) → dispositions
    recorded in Context.
  - Stock-body fixtures must not be committed for guard verification (scope m6) → D5
    one-time `git show` check, ledger-recorded.
  - Contributor-machine verification tasks gated the plan (requirements m8, assumptions
    M-3/m-4, scope m5) → all such checks non-gating with conservative defaults; tasks.md
    revised.
  **Escalated to the gate:** E1 restart rule cut vs keep-with-ownership-fix (scope M1 vs
  failure/abuse M2 — synthesis recommends cut); E2 ship vs cut the six opsx command
  adapters (scope M3; requirements B1's invocation-time evidence argues keep — synthesis
  recommends keep); E3 confirm Cursor-originated changes gate in the owner's environment
  (assumptions M-2).
  **Minors accepted as residual:** same-commit guard-edit bypass (failure/abuse m3);
  paraphrase/splitting/negation evasion (failure/abuse m1); supply-chain transitive-dep
  exposure and example↔local drift (failure/abuse m2); Windows-OS inference
  (assumptions m-7, fact-check UNVERIFIED — decision robust either way); CLAUDE.md's
  Claude-Code flavor for Cursor readers (assumptions m-8); redundant delta scenario kept
  in tightened form rather than cut (scope m4 — the scenario now carries the
  governing-capability condition, so it is no longer redundant).

- **2026-08-06 — Human gate, escalated decisions ruled** (owner): **E1** = keep the
  restart rule with the ownership fix (over the synthesis recommendation to cut). **E2**
  = keep the six opsx command adapters. **E3** = allow a Cursor-native panel when real
  independent-subagent dispatch is available (Cursor ≥2.4; read-only reviewers, no
  worktrees, log recorded), handoff otherwise; single-context emulation forbidden; gate
  always the owner's. E3 incorporated a premise correction: the assumptions reviewer's
  claim "Cursor has no dispatch mechanism" is stale for Cursor ≥2.4 (subagents with
  independent contexts; 3.2 /multitask; 3.5 cloud agents — web-verified 2026-08-06);
  apply stays handoff-only on the independent grounds (worktree ban, unported protocol
  mechanics). Overall verdict: **revise-first** — rulings folded back across all four
  artifacts before final approval.
- **2026-08-06 — Post-rulings consistency read** (light-tier, all five documents +
  baseline diff): 3 defects found and fixed — D1's stale "single stop-condition" cap
  contradicted the E3 fold-back (propose carries two; reworded), tasks 2.2 omitted the
  D9 panel-dispatch-or-handoff content for the propose adapter (added), and two stale
  "(pending E2)" annotations post-ruling (updated). Verified clean: sdlc-process
  MODIFIED block byte-faithful to baseline outside the intended insertions; restart-rule
  pointer exemption consistent across all documents; no banned-phrase collision with
  required adapter phrasing; panel-log claims match section contents.
- **2026-08-06 — Human gate: APPROVED** (owner, final): proceed to apply. tasks.md is
  the plan of record.
