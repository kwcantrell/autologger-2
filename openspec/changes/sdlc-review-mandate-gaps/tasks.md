# sdlc-review-mandate-gaps — Tasks

> **Gated 2026-07-27** — the adversarial panel ran (4 reviewers, all REQUEST-CHANGES,
> findings folded), and the gate dispositioned all six escalations (see design.md Panel &
> review log). This is now the plan of record. Gate addendum: all subagents run on fable
> by owner directive.
>
> Landing path: **light** (design.md D8; 2026-07-14 D11 precedent). One implementer pass
> on a plain branch off `main`; no dispatch-unit partitioning, phase reviewers, or
> whole-branch audit. Docs-only gate declaration (config.yaml rule): `npm run e2e` and
> `npm run e2e:visual` are **skipped — no runtime surface is touched**; typecheck + unit
> suite still run to prove exactly that.

## 1. Encoding edits (one implementer pass, plain branch)

- [ ] 1.1 Branch `sdlc-review-mandate-gaps` off `main`; first commit is the gated OpenSpec
      artifacts themselves (`docs(openspec): add sdlc-review-mandate-gaps gated artifacts`),
      version-pinning the plan of record.
- [ ] 1.2 `.claude/skills/openspec-apply-change/SKILL.md` — apply D1/D3/D4 as gated:
      - Step 6f + Guardrails: orchestrator bookkeeping commits stage explicit paths, never
        `git add -A`/`git add .`/`commit -a`; `git status --porcelain` read before each
        commit; every unexplained path gets a ledger disposition line (path, origin,
        deleted / committed-under-task-N; delete-unless-claimed default) (D1.1).
      - Step 6c dispatch-prompt requirements: implementers stage explicit paths and report
        unexplained tree entries rather than sweeping them (D1.1 — subagents author most
        commits).
      - Step 7 package build: always materialize `git diff --stat main...HEAD` +
        `git log --stat`; run the mechanical stray-file scan (binaries / ~100 KB+ /
        flag-shaped names, illustrative not exhaustive) at build time; verify **package
        integrity** — every phase section non-empty, per-phase diffs reconciling against
        `main...HEAD` totals; a truncated package is a build failure (D1.2/D1.3).
      - Step 7 charter: tree hygiene answered in affirmative-evidence form — file count +
        "flagged: none"/list with dispositions (D1.3).
      - Step 6 partition block + Guardrails: seam declaration for caller-supplied
        parameters later phases satisfy independently — parameter, the property each call
        site must satisfy (stated against the external consumer, not inter-caller
        uniformity), calling phases; revisited at every subsequent partition; declare-when
        guidance (consumer-agreement data yes, mode/identity params no); carried in
        dispatch prompts with the ledger entry as cross-check (D3.1).
      - Step 7 package list + charter: all call sites of every declared seam always
        included, packaged together, each checked **against the declared property**;
        declared seams are a floor, not a ceiling — undeclared independently-satisfied
        parameters still get the question (D3.2).
      - Step 6e/7 + Guardrails: fix waves closing a merge-blocking / silent-wrong-behavior
        finding record a reproducible pre-fix failure (named test/command) and a
        named-test mutation check (working-tree-only, never committed); the scoped
        re-review **re-executes** the recorded mutation and remains expected to run one of
        its own (D4).
- [ ] 1.3 `CLAUDE.md` — apply D2/D7 as gated, keeping the file's short-pointer posture:
      - Fact-check block: claims (however enumerated) state the property to verify, never
        a line to confirm; function-behavior claims require a whole-function (+
        relevant-callee) read, and a behavioral CONFIRMED quotes the claim-relevant code
        path in the log entry, which also says which read was done — worded as defining
        the adequate *method* the existing per-claim-method rule demands, reconciled with
        (not layered beside) the "CONFIRMED is reserved for mechanically checkable facts"
        reservation (D2/D7).
      - "How we work" audit-package parenthetical: add tree-hygiene/package-integrity and
        declared-seam call-site items so the CLAUDE.md summary matches the skill's
        charter (D1/D3).
- [ ] 1.4 Confirm `openspec/config.yaml` is **unchanged** (D7: no proposed rule fires at
      artifact-generation time; the gate ordered no re-routing).

## 2. Verification (docs-only set, per design.md D8)

- [ ] 2.1 `openspec validate sdlc-review-mandate-gaps --strict` passes.
- [ ] 2.2 Skill-load check: `openspec-apply-change` still loads (frontmatter intact,
      customization note + steps 6–7 present); record the result. Also record which skill
      actually loads on `/opsx:apply` (the `opsx:apply` plugin vs the customized
      `openspec-apply-change`) and confirm the customized SKILL.md remains the protocol
      home CLAUDE.md points at — closing the D6 auto-load question with observation
      rather than assumption.
- [ ] 2.3 `npm run typecheck` + `npm test` green — proving the diff has no runtime
      surface (e2e/e2e:visual skipped per the declaration above).
- [ ] 2.4 `git diff --stat main...HEAD` lists only: this change's artifacts, `CLAUDE.md`,
      the skill file — practicing D1's rule on the change that introduces it. Any other
      path is a stop-and-fix.

## 3. Consistency read + closure

- [ ] 3.1 Light-tier consistency reviewer over the final `CLAUDE.md`, `SKILL.md`, and this
      change's four artifacts: gate dispositions vs normative text, stale pre-gate
      language, cross-references (including that the marker-spec delta and D6 tell the
      same story). Outcome recorded as a dated Panel & review log line — "clean" naming
      documents read, or findings + fixes.
- [ ] 3.2 Merge to `main` (no push without an explicit ask). Suggest archive
      (`/opsx:archive`), which syncs the `sdlc-process` delta into the durable baseline;
      at sync, touch up the baseline spec's `## Purpose` narrative to mention the
      2026-07-27 evaluation (deltas sync requirements only — the Purpose edit is
      deliberate, panel-flagged).
- [ ] 3.3 Post-landing note to the user: tag `backup-pre-rewrite` is now free to delete
      (user's call — evidentiary role ends once the corrected artifacts have landed, not
      at the gate; F1's commits become GC-eligible on deletion).
