# cursor-agent-adapters

## ADDED Requirements

### Requirement: Cursor adapter files route to the normative encodings without restating them
The tracked Cursor-side agent surface SHALL consist of pointer artifacts: `AGENTS.md`
and every SDLC-routing file under `.cursor/` SHALL instruct the agent to read the full
content of and follow a named normative source (`CLAUDE.md`, a
`.claude/skills/openspec-*/SKILL.md`, or `openspec/config.yaml`) and SHALL NOT reproduce
procedure or rule content those sources carry. The sole non-routing artifact is the
restart rule governed by its own requirement below; no other tracked file is exempt from
the routing obligation. Stop-conditions are bounded: each SHALL
name a state the agent cannot otherwise know it is in plus where to read, SHALL NOT
characterize how any process step runs (procedure is restatement), and SHALL number at
most four per file. The routed target of an adapter SHALL NOT contradict the gate
ordering (tasks.md provisional until fact-check + panel + human gate); where a generated
skill contradicts it, the skill customization is part of this surface's obligations.

#### Scenario: Command adapter routes to the repo skill
- **WHEN** a Cursor user invokes a Cursor-runnable opsx command (explore, propose,
  update, sync, archive)
- **THEN** the injected command file directs the agent to read the full corresponding
  `.claude/skills/openspec-*/SKILL.md` and follow it, and contains no inline
  implementation loop or stock OpenSpec command body

#### Scenario: Propose path stops at the gate end-to-end
- **WHEN** a Cursor session completes proposal artifacts via the propose adapter
- **THEN** both the adapter's stop-condition AND the routed
  `.claude/skills/openspec-propose/SKILL.md` direct the agent to stop before apply until
  the fact-check, adversarial panel, and human gate recorded in CLAUDE.md have run, and
  neither file prompts the agent or user to proceed to apply

#### Scenario: Apply from Cursor is a handoff, not an execution
- **WHEN** a Cursor user invokes the apply adapter (or an agent operating under the
  always-apply rule reaches an apply step)
- **THEN** the surface directs the agent to stop and hand the change off to the owner's
  orchestration environment, stating that apply requires subagent dispatch this
  environment does not provide, and the agent is directed not to implement inline

#### Scenario: Panel runs via independent dispatch or hands off; never emulated
- **WHEN** a Cursor session finishes drafting change artifacts
- **THEN** the surface directs it to run the fact-check + panel only via real
  independent-subagent dispatch (fresh-context reviewers with distinct mandates,
  read-only, no git worktrees, synthesis and dispositions recorded in the Panel & review
  log) and otherwise to hand the change name to the owner's orchestration environment;
  in every case it is directed never to emulate the panel within a single context, and
  the human gate goes to the owner

#### Scenario: AGENTS.md is a pointer
- **WHEN** an agent auto-reads `AGENTS.md`
- **THEN** it finds a short document naming `CLAUDE.md` as the normative instruction
  source, directing a full read of it before acting, carrying the handoff statement and
  no process rules of its own

### Requirement: Cursor MCP config is untracked with a tracked portable example
`.cursor/mcp.json` SHALL be untracked (gitignored). A tracked `.cursor/mcp.json.example`
SHALL document local setup, SHALL contain no machine-specific absolute paths, SHALL pin
the MCP server package to an exact version (no floating install), and SHALL pass the
same content scan as adapter files.

#### Scenario: Local config never enters the tree
- **WHEN** a contributor localizes `mcp.json` from the example
- **THEN** the gitignore entry keeps the localized file untracked, and the drift guard
  fails if the gitignore entry or the tracked example is missing

#### Scenario: Package spec changes are conspicuous
- **WHEN** a change edits the example's MCP server package name or version
- **THEN** the drift guard's exact-literal assertion fails until the guard's expected
  literal is updated in the same reviewed change

### Requirement: A closed-world CI drift guard polices the entire agent surface
A repo-scan test running in the standard test suite SHALL walk `.cursor/**` recursively,
every `AGENTS.md` at any directory depth, and `.cursorrules`, and SHALL fail when any
tracked file found is not on its explicit allowlist. For each allowlisted file it SHALL
fail when the file is missing, exceeds its line and character budgets (counted over the
whole file including frontmatter and blank lines), lacks the path-literal pointer to its
mapped normative target (routing artifacts only; the restart rule is exempt from the
pointer check alone), or matches a banned phrase anywhere in the file including
frontmatter. It SHALL also assert the MCP-config requirements above.

#### Scenario: Unenumerated agent-surface file appears
- **WHEN** a commit adds any tracked file under `.cursor/`, any `AGENTS.md` at any depth,
  or a `.cursorrules` file that is not on the guard's allowlist
- **THEN** the guard fails the suite, making the addition a deliberate, reviewed guard
  edit

#### Scenario: Adapter grows rule content
- **WHEN** a change adds rule-bearing text to an allowlisted file such that it exceeds a
  budget or matches a banned phrase
- **THEN** the guard fails the suite

#### Scenario: Pointer goes stale
- **WHEN** a referenced normative file is renamed or removed without updating the adapter
- **THEN** the guard's path-literal pointer check fails the suite

### Requirement: The restart rule is scoped to identified dev processes
The reinstated `restart-server-yourself` rule (gate ruling E1, 2026-08-06: kept with the
ownership fix) is the surface's sole non-routing artifact; the drift guard applies its
size and banned-phrase checks to it but not the pointer check. The rule
SHALL authorize restarting only (a) processes the agent itself started, or (b) a listener
the agent has identified as this repository's dev process by its command line; for any
other process — including an unidentified listener on `:8787` or `:5173` and the hermetic
e2e server on `:8791` — the rule SHALL direct the agent to ask first. The rule SHALL
reference restart commands via the repo's package scripts rather than duplicating command
lines, and SHALL state its `:5173` (Vite) disposition explicitly.

#### Scenario: Unidentified and foreign processes are off-limits
- **WHEN** a Cursor agent operating under the restart rule encounters a listener it did
  not start and cannot identify as this repository's dev process, or any listener on
  `:8791`
- **THEN** the rule directs it to ask the user rather than kill the process
