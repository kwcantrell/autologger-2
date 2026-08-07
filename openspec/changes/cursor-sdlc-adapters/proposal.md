# Proposal: cursor-sdlc-adapters

## Why

A contributor works in Cursor, and the repo's Cursor-side surface was just removed: the
prior `.cursor/` + `AGENTS.md` set was ruled a forbidden parallel process rulebook
(commit `0a13b54`, re-applied on this branch as `ed43b29`) after a process-fidelity
review found the stock opsx command copies instruct the exact behaviors the SDLC forbids
(inline implementation in `apply.md`, "run apply now" gate-skipping in `propose.md`), the
291-line `AGENTS.md` copy of `CLAUDE.md` had already drifted, and `mcp.json` hardcoded a
foreign-machine absolute path.

The honest efficacy record (panel finding, 2026-08-06): a routing rule materially similar
to this change's design (`openspec-sdlc.mdc`, added `0c1d213` on 2026-07-27 — always-on,
skill-routing, gate-stating) was **live during the PR #3 deviation window**, and the
deviations happened anyway. Routed guidance alone is therefore known-insufficient. What
this change actually delivers is narrower and real: it (a) removes the actively
contradicting stock bodies from every surface Cursor injects — including the routed
*targets*, not just the adapters; (b) adds CI enforcement (a closed-world drift guard) so
the contradiction cannot silently return; and (c) designs the previously undesigned cases
(what a Cursor session does at apply, and at the panel/gate boundary). Behavioral
compliance of any agent remains a review-time concern (Non-Goals).

## What Changes

- Reinstate `.cursor/` as **content-free adapters**: opsx command files become thin
  wrappers that instruct the agent to read and follow the corresponding
  `.claude/skills/openspec-*/SKILL.md` — never stock OpenSpec command bodies, never
  restated rule text. Adapters for Cursor-runnable verbs (explore, propose, update, sync,
  archive) route to their skills; the **apply adapter is a stop/handoff** ("apply executes
  via subagent dispatch this environment does not provide — stop and hand off to the
  owner's orchestration environment; do not implement inline").
- **Customize `.claude/skills/openspec-propose/SKILL.md`** (encoding amendment, in scope):
  the current file is stock generated output whose Output step instructs "Run
  `/opsx:apply` to start implementing" — the gate-skip in the routed target itself.
  Replace that step with the gate stop (artifacts created → tasks.md provisional until
  fact-check + panel + gate), and extend CLAUDE.md's re-apply-customization note (which
  today covers only the apply skill) to cover it.
- Reinstate `AGENTS.md` as a short pointer document: identifies `CLAUDE.md` as the
  normative instruction source and directs agents to read it before acting; carries no
  process rules of its own; includes the panel/gate handoff sentence (below).
- Reinstate `.cursor/rules/openspec-sdlc.mdc` (always-apply) as a routing rule: names the
  three normative encodings, requires reading `CLAUDE.md` "How we work (SDLC)" before any
  design-bearing work, and carries only bounded stop-conditions (see design D3) — states
  plus pointers, never reproduced procedure.
- **Panel/gate boundary** (gate ruling E3, 2026-08-06): the fact-check + adversarial
  panel MAY run natively in Cursor when the contributor's Cursor provides real
  independent-subagent dispatch (≥2.4) — fresh-context reviewers with the four mandates,
  read-only, no git worktrees, synthesis + Panel & review log recorded; otherwise the
  Cursor session hands the change name to the owner's orchestration environment.
  Single-context panel emulation is forbidden in every case, and the human gate is
  always the owner's. The propose adapter and `AGENTS.md` carry this as one routed
  stop-condition.
- `mcp.json` is **unconditionally untracked** (gitignored); a tracked, portable,
  version-pinned `.cursor/mcp.json.example` documents local setup. No conditional on any
  machine's Cursor capabilities.
- Reinstate `.cursor/rules/restart-server-yourself.mdc` with ownership-scoped
  authorization (gate ruling E1, 2026-08-06: keep with the ownership fix): restart only
  agent-started or command-line-identified dev processes; ask-first for everything else
  including `:8791` and unidentified `:8787`/`:5173` listeners; script references, not
  duplicated command lines.
- Ship all six opsx command adapters (gate ruling E2, 2026-08-06: keep — the recorded B1
  failure was invocation-time, so occupying the command namespace with safe text is the
  point; the closed-world guard polices them).
- Add a **closed-world drift guard**: a repo-scan test that walks the entire agent
  surface (`.cursor/**` recursively, every `AGENTS.md` at any depth, `.cursorrules`),
  fails on any tracked file not on its explicit allowlist, and checks every allowlisted
  file (whole file including frontmatter) against size budgets, pointer presence, and a
  banned-phrase list; also asserts the mcp tracking state and the exact expected
  package-spec literal.

## Capabilities

### New Capabilities
- `cursor-agent-adapters`: the Cursor-side adapter surface — the closed-world file set,
  the requirement that adapters and their routed targets are consistent with the gate
  ordering, bounded stop-conditions, MCP config portability, and the drift guard.

### Modified Capabilities
- `sdlc-process`: adds a bounded adapter allowance to the no-parallel-rulebook
  requirement — pointer adapters are permitted only under a governing capability that
  imposes content-free constraints and CI guard coverage; introducing a new adapter
  surface is design-bearing; an adapter that restates rule or procedure content, or one
  without a governing capability, falls under the duplicate-rulebook prohibition.

## Impact

- **Contract impact: none.** No HTTP/WS/JSON surface is touched; this is process tooling
  only (`.cursor/**`, `AGENTS.md`, `.gitignore`, one drift-guard test, plus the
  `openspec-propose` skill customization and its CLAUDE.md note — both process-encoding
  files, no runtime surface).
- Affected files: `.cursor/commands/opsx/*.md` (6), `.cursor/rules/openspec-sdlc.mdc`,
  `.cursor/rules/restart-server-yourself.mdc`, `.cursor/mcp.json.example` + `.gitignore`
  entry, `AGENTS.md`, `.claude/skills/openspec-propose/SKILL.md`, `CLAUDE.md` (one-line
  note extension), `web/src/cursorAdapters.repo.test.ts`.
- Affected people: the Cursor-using contributor gets working tooling with designed
  stop/handoff points; Claude Code sessions are unaffected.
- Depends on the merge commit `3cc98c3` + drop commit `ed43b29` already on this branch.

## Non-Goals

- No change to any process rule's *content* beyond the propose-skill Output-step
  customization (which restores the gate ordering CLAUDE.md already mandates — it aligns
  an encoding with the rule, it does not change the rule).
- No replacement-architecture evaluation (the 2026-07-27 declined replacement and its
  reversal conditions are untouched).
- No Cursor-native apply mode: apply from Cursor is stop-and-hand-off; designing a
  degraded Cursor apply would be a separate design-bearing process change.
- No claim of behavioral enforcement: the guard is a conspicuousness tripwire against
  drift-by-accident and stock regeneration; paraphrase, splitting, and instruction
  negation remain review-time concerns (recorded residuals in design.md).
