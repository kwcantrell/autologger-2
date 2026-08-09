# Tasks — sdlc-orchestrator-obligations

**PROVISIONAL until the fact-check pass and the human gate have run.** No questions are escalated
(design Open Questions), so the gate is a straight accept/reject/amend rather than a set of rulings.

`file:line` anchors below are **orientation only** — every target was located by content when this
plan was written, and must be located by content again before editing. One target's wording was
already found to differ from an initial assumption.

**Standing per-unit gate:** `npm run typecheck` + `npm test` + `npm run lint` + `npm run docs:check`.
No unit may be knowingly red.

**Gates deliberately skipped, declared not assumed:** `npm run e2e` and `npm run e2e:visual`. This
change touches no runtime surface — no file under `web/`, `server/`, `packages/`, `companion/`, or
`e2e/`. Every edit is to `CLAUDE.md` or a skill body.

**No task edits `openspec/config.yaml` or any skill frontmatter.** Task 2.1 removes a skill **body**
line only and verifies the skill still loads.

## 1. CLAUDE.md — the two additions

Both land in `CLAUDE.md` deliberately: it is the only encoding that auto-loads for every agent
including subagents (design D1). Do not move either to a capability spec or to a skill.

- [x] 1.1 **Premise-checking at propose time.** Extend the existing `opsx:propose` ordering
      paragraph (locate by its "do not skip the gate" sentence). The orchestrator, before drafting
      `proposal.md`'s Why, measures the request's stated premises against the tree — **bounded to
      the nouns the framing names and any inherited deferral pointer it relies on** — records a
      `Current state, measured on <branch> @ <sha>` block in the design, and routes any contradiction
      to the human as a numbered decision carrying **at least two priced options**.
      **The bound is load-bearing**: it is what makes the obligation falsifiable. Do not write it as
      an unbounded "check the request against the repo".
      State the justification as **cost, not correctness** (design D2) — the panel catches six of
      seven false framings; this makes them cheap, not caught.
- [x] 1.2 **Widen the fact-check enumeration.** Locate the existing list by its "symbol existence,
      caller counts, wire shapes" wording. Add three classes: **precedent citations** (a claim that
      X is precedent for Y requires showing X is live and load-bearing), **capability or coverage
      claims** (what a guard catches is checkable), and **characterizations relayed from subagents**.
      Add that any count entering an artifact carries its derivation inline.
      Keep it to the enumeration — do not restructure the surrounding paragraph, which carries a
      2026-07-27 decided-method clause.

## 2. The propose skill — the deletion

- [x] 2.1 Delete `openspec-propose/SKILL.md`'s guidance line instructing to **"prefer making
      reasonable decisions to keep momentum"** (locate by that phrase; it currently sits in the
      Guardrails list). It instructs the opposite of purpose clause 3 at the exact moment that
      clause governs.
      Delete the clause cleanly — if the surrounding bullet becomes ungrammatical or loses a
      still-valid instruction ("if context is critically unclear, ask the user"), **keep that half**.
      This is a **body** edit: do not touch frontmatter. Afterwards, confirm the file still parses
      and the skill still loads, and say so in the report — a malformed edit to a machine-parsed
      governance file fails silently, not visibly.

## 3. Verification

- [x] 3.1 Run all four root gates and record **actual output, not a claim**: `npm run typecheck`,
      `npm test`, `npm run lint`, `npm run docs:check`. State explicitly that `npm run e2e` and
      `npm run e2e:visual` were skipped, and why.
- [x] 3.2 **Verify this change against its own new rules** — it introduces them, so it is the first
      subject:
      - Does the change's own design carry a `Current state` block with branch and SHA (1.1)?
      - Does every count in its artifacts carry its derivation (1.2)?
      A change introducing obligations it does not itself meet is the defect class this whole line
      of work exists to catch.
- [x] 3.3 `openspec validate sdlc-orchestrator-obligations --strict`.
- [x] 3.4 Confirm the diff is **documentation only**: `git diff --name-only` lists only `CLAUDE.md`,
      `.claude/skills/openspec-propose/SKILL.md`, and this change's artifacts. Any other path is a
      finding, not a convenience.
