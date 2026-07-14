# Design: retire-python-port-framing

## Context

The repo began as a faithful TypeScript/Node port of the Python AutoLogger backend and its
normative documents still frame it that way in the present tense. The facts on the ground
(verified 2026-07-14, corrected by the panel):

- The origin repo **exists** at `~/AutoLog` (live git, v1.24.1, `src/autologger/web/routers/`
  matches every path our headers cite). What is broken is the *pointer*: docs reference
  `../autologger`, a sibling path that no longer resolves.
- The origin repo is out-of-workspace, unlinked, not a dependency, and superseded — this
  repo is the canonical implementation. Anchoring the API freeze on it means the repo's
  strongest invariant appeals to a codebase that is no longer authoritative.
- 21 `server/src/**/*.ts` files carry origin header comments, plus mid-file mentions,
  2 SQL migrations, and 1 `web/` CSS note. Nearly all are already past-tense provenance;
  the present-tense parity claims amount to ~4–6 lines.
- `README.md`'s endpoint table has a "Python parity" column; "parity" elsewhere in the
  repo also means crash-consistency, auth-mode, visual, and test-suite parity.

Exploration (2026-07-13) surfaced the load-bearing insight: the port framing is not
decorative — it is the anchor that freezes the API contract. Removing it without a
replacement weakens the invariant that stops API-surface drift.

## Goals / Non-Goals

**Goals:**
- Replace the Python-parity anchor with an equally forceful, self-contained one: the
  server's **full published HTTP/WS contract is frozen**; consumers (`web/`, Companion
  module, `e2e/`, external API clients) are the *reason*, not the measuring stick.
- Make that anchor durable as the `api-contract-freeze` capability spec AND operative at
  session start by promoting it into CLAUDE.md's "Invariants (spec)" section.
- Remove every broken `../autologger` pointer and all present-tense port framing from
  living documents.
- Keep port history where it explains structure, phrased as past-tense provenance.

**Non-Goals:** (full list in `proposal.md`)
- No edits to frozen `docs/superpowers/` records or `de-cloudflare-strong-core` artifacts.
- No Cloudflare-era naming cleanup.
- No code, API, schema, or test behavior changes.

## Decisions

### D1 — Demote to past-tense provenance, don't erase
**Chosen:** Port history stays wherever it explains structure (module-for-module layout,
`durable/`/`d1.ts` naming, per-file origin headers), reworded to past tense where needed.
**Alternatives:**
- *Full erasure* — leaves future readers unable to answer "why is this shaped this way?";
  destroys genuinely useful provenance for no gain.
- *Keep as-is* — retains broken pointers and a false present-tense identity; the trigger
  for this change.
**Rationale:** The problem is the port as a *present-tense normative frame*, not the
history.

### D2 — Replacement anchor: the full published surface (gate ruling 2026-07-14)
**Chosen:** The frozen surface is the *entire published* HTTP/WS contract — the README
endpoint table is the normative route inventory — independent of what any consumer
currently reads. `web/` + Companion + `e2e/` + external clients are named as the rationale.
Captured as the `api-contract-freeze` capability (delta spec in this change → durable
baseline on archive) and mirrored into CLAUDE.md's Invariants section.
**Alternatives:**
- *Consumption-derived anchor* ("authority derives from what `web/` + Companion actually
  consume") — the original draft; the panel showed it silently unfreezes surface with no
  in-repo caller (`/api/companion/commands/wait` exists solely for stale external clients)
  and blesses co-mutation PRs while deployed Companion installs lag the repo. **Rejected
  at the gate.**
- *Prose-only in CLAUDE.md/config.yaml* — not durable; no normative artifact to validate
  changes against.
- *Extract a standalone API contract document (OpenAPI etc.)* — over-built; the README
  endpoint table already inventories the surface (YAGNI).
**Rationale:** Equal or greater force than "match the Python backend", no external
dependency, and immune to the "nobody reads that field anymore" and "both sides moved
together" loopholes — both are explicit non-loopholes in the spec.

### D3 — README endpoint table: route column stays normative, origin column goes historical
**Chosen:** The route column is the frozen inventory D2 leans on and stays normative; only
the Python-module column is relabeled historical origin, its per-route paths kept as
provenance.
**Alternatives:** *Delete the column* — loses the only per-endpoint provenance map;
*demote the whole table* — contradicts D2, which makes the table the normative inventory.
**Rationale:** Resolves the panel-found D2/D3 contradiction: the table's *claim* changes
(origin, not verified parity) on one column only. The origin repo at `~/AutoLog` could
still verify parity today, but this repo no longer answers to it — the relabel reflects
authority, not availability.

### D4 — Source comments: minimal-touch audit with correct patterns
**Chosen:** Audit the full measured surface (21 `.ts` headers, mid-file mentions, 2 SQL
migrations, 1 `web/` CSS note) using patterns that actually match (`../autologger`,
case-insensitive `python`, `.py` paths, `src/autologger/`). Edit only present-tense
normative claims (~4–6 lines, e.g. `profileAssembler.ts` "byte-compatible with the Python
server's", `0001_init.sql` "matches the Python server's"); past-tense provenance stays
verbatim.
**Alternatives:** *Rewrite all origin headers uniformly* — churn that pollutes `git blame`
for zero semantic gain.
**Rationale:** The demote decision makes most comments already-correct; touch only what
asserts a present-tense obligation.

### D5 — Ship on a feature branch, not via the docs-only exception
**Chosen:** Feature branch off `main`.
**Rationale:** Comment edits touch code files; CLAUDE.md scopes the docs-only exception to
non-code artifacts.

### D6 — Spec shape: single requirement; governance lives elsewhere (gate ruling 2026-07-14)
**Chosen:** The durable capability spec carries only the contract freeze. The doc-anchor
rule ("normative docs anchor on the in-repo contract, not the origin codebase") and the
past-tense-provenance posture live in `config.yaml` context/rules and a CLAUDE.md
convention line; the `../autologger` pointer sweep is a one-time change task.
**Alternatives:**
- *Three durable requirements (original draft)* — the panel showed Requirements 2–3 were
  this change's acceptance criteria dressed as durable SHALLs: they duplicated the
  config.yaml rule (the actually-injected control), the sweep scenario would have flagged
  its own archived self (the spec file contains the literal `../autologger`), and the
  "mid-flight artifacts" exemption was a self-renewing unbounded class.
- *Split into two capabilities* — cleanest separation, most ceremony; rejected as
  process-artifact inflation for one-time checks.
**Rationale:** Trimming dissolves three panel findings at once and keeps `openspec/specs/`
about the system, not about sentences in prose files.

### D7 — Ordering with de-cloudflare-strong-core (gate ruling 2026-07-14)
**Chosen:** This change lands first, before de-cloudflare implementation begins.
**Consequence to hand off:** de-cloudflare's docs phase must re-check the rewritten
CLAUDE.md/README paragraphs after its `durable/` → `session/` and `d1.ts` → `catalog.ts`
renames — its own rename-sweep does not cover CLAUDE.md/README, so the reconciliation
needs this named owner.
**Alternative:** *Land after de-cloudflare* — paragraphs written once against final paths,
but blocks a small doc fix behind a large refactor and still needs the same sweep-gap fix.

## Deliberate invariants a future reader might "helpfully" undo

- **The contract freeze survives the port's retirement.** "No more Python parity" does not
  mean shapes may evolve: the freeze now covers the full published surface and requires an
  authorizing delta spec for any observable change. Shape/status-code edits are *never*
  "small, obvious fixes" under the SDLC.
- **Non-consumption does not unfreeze surface.** Endpoints/fields with no in-repo caller
  are kept deliberately for stale/external clients.
- **Consumer co-mutation is not an exemption.** Deployed Companion module versions lag the
  repo.
- **Remaining Python references in `docs/superpowers/` and change archives are
  deliberate** frozen history — don't sweep them.
- **Past-tense origin headers are deliberate provenance**, not stale comments to strip.

## Risks / Trade-offs

- [Rewording subtly weakens the invariant] → The replacement language was reviewed head-on
  by the adversarial panel (see log); the consumption-derived draft was in fact weaker and
  was replaced at the gate.
- [The spec is never loaded at session start, so it can't stop drift by itself] → The
  freeze is mirrored into CLAUDE.md's "Invariants (spec)" section (always read) with the
  never-a-small-fix clause; the spec is the durable normative artifact behind it.
- [Sweep misses references] → Patterns widened to what the references actually contain
  (`.py` paths, `src/autologger/`, "Python server"), not just the word "python" and the
  literal `../autologger`.
- ["parity" polysemy — a meaning-blind sweep corrupts unrelated docs] → Only
  Python-anchored parity prose is re-anchored; crash-consistency ("Known parity windows"),
  auth-mode, visual (tailwind.css), and test-suite parity stay verbatim.
- [Dual freeze anchors in the durable baseline] → de-cloudflare's refactor-parity
  requirement (anchored on `AUTH-API.md`) is reconciled with `api-contract-freeze` during
  that change's archive sync (gate decision; recorded in its Non-Goals entry).
- [Self-reference: artifacts drafted under the old config context] → Accepted; the gate
  read them knowing the anchor was being replaced mid-flight.

## Migration Plan

Single small PR on a feature branch, landed **before** de-cloudflare implementation (D7).
Prerequisite: `npm rebuild better-sqlite3` (the checkout's `npm test` is currently red
from a native-ABI mismatch — environmental, verified 2026-07-14). Then: edit docs/config,
fix the ~4–6 present-tense comment lines, run the closing sweep, gate on
`npm run typecheck` + `npm test` + `openspec validate --strict`. No deploy/rollback
complexity.

## Open Questions

- Final wording of the README origin-column label — gate nit, decide during apply.

## Panel & review log

### 2026-07-14 — Adversarial panel (requirements / assumptions / failure & abuse / scope) + gate

Four parallel skeptical reviewers over proposal + spec + design, all claims verified
against the live repo; synthesized, then ruled at the gate.

**Blockers/majors fixed in place:**
- False premise: "the Python repo no longer exists on disk" — it exists at `~/AutoLog`
  (assumptions #1, BLOCKER). Why re-argued on the true premise: broken *pointer*,
  superseded *authority*.
- False "Verified" claim: de-cloudflare's delta specs do contain parity phrasing
  ("HTTP/WS surface parity is preserved and verified", `AUTH-API.md`-anchored) — corrected
  to "no *Python-anchored* parity phrasing" (assumptions #2 / failure F2).
- Frozen observables were narrower than the anchor they replaced (four JSON-centric items;
  lost CSV/JSONL bodies, range/header semantics, WS emission semantics) — enumeration
  broadened and made explicitly non-exhaustive (requirements #2).
- Sole enforcement scenario was unfalsifiable ("rejected at review") — restated against
  checkable repo state (authorizing delta spec exists) (requirements #3).
- Footprint corrected: 21 headers + mid-file + 2 SQL migrations + 1 CSS note (not "~14
  files"); sweep patterns widened; plan slimmed accordingly (assumptions #4, scope #2).
- Enforcement reality: freeze promoted into CLAUDE.md "Invariants (spec)";
  shape/status-code edits declared never-small-fixes (failure F5/F6).
- de-cloudflare coordination: ordering declared (D7), sweep-gap ownership recorded
  (failure F3).
- `npm test` red in this checkout (better-sqlite3 ABI) — rebuild made a prerequisite
  (assumptions #5).
- Minors fixed: D2/D3 contradiction (route column stays normative, requirements #5);
  CLAUDE.md workspaces claim (`server`/`web`/`companion`, assumptions #6); "parity"
  polysemy guard (failure F7 / scope #4); task/spec exemption alignment (requirements #8;
  moot after D6 trim).

**Escalated to the gate (with decisions):**
- Freeze-scope wording — consumption-derived vs full published surface (requirements #1
  BLOCKER, failure F1). **Decision: full published surface**; consumers are rationale,
  non-consumption and co-mutation are explicit non-loopholes (D2).
- Spec shape — 3 requirements vs trim vs split (requirements #4, scope #1/#3).
  **Decision: trim to the single freeze requirement**; governance to config.yaml +
  CLAUDE.md, sweep to a one-time task (D6). Also dissolves the self-violating sweep
  scenario (assumptions #3) and the unbounded exemption class (failure F4).
- Dual freeze anchor in the durable baseline after de-cloudflare archives (failure F2).
  **Decision: reconcile during that change's archive sync**; accepted until then.
- Ordering with de-cloudflare (failure F3). **Decision: this change lands first**, with
  the named hand-off in D7.

**Minors accepted as residual:**
- Loss of "verified parity" claim strength on the README table — honest demotion;
  recoverable from git history; nothing mechanical depends on the wording (failure F8).
- The origin repo at `~/AutoLog` could still verify parity today; the change deliberately
  stops treating it as authoritative rather than pretending it is unavailable (D3 note).
- Requirement-tense enforceability: the past-tense-provenance posture is a CLAUDE.md
  convention, not a mechanically checkable durable SHALL (scope #3 — resolved by D6).
