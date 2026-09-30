## MODIFIED Requirements

### Requirement: Cursor MCP config is untracked with a tracked portable example
`.cursor/mcp.json` SHALL be untracked (gitignored). A tracked `.cursor/mcp.json.example`
SHALL document local setup, SHALL contain no machine-specific absolute paths, and SHALL pin
the MCP server package to an exact version (no floating install). No automated guard enforces
this; review of `.cursor/` changes does.

#### Scenario: Local config never enters the tree
- **WHEN** a contributor localizes `mcp.json` from the example
- **THEN** the gitignore entry keeps the localized file untracked

#### Scenario: Package spec changes are conspicuous
- **WHEN** a change edits the example's MCP server package name or version
- **THEN** the edit appears as a change to the tracked `.cursor/mcp.json.example` in the
  reviewed diff, and the pinned version stays exact

### Requirement: The restart rule is scoped to identified dev processes
The `restart-server-yourself` rule (gate ruling E1, 2026-08-06: kept with the ownership fix)
SHALL authorize restarting only (a) processes the agent itself started, or (b) a listener
the agent has identified as this repository's dev process by its command line; for any
other process — including an unidentified listener on `:8787` and the hermetic
e2e server on `:8791` — the rule SHALL direct the agent to ask first. The rule SHALL
reference restart commands via the repo's package scripts rather than duplicating command
lines, and SHALL state explicitly that dev runs as a single process on `:8787` (there is
no separate `:5173` frontend dev server to manage).

#### Scenario: Unidentified and foreign processes are off-limits
- **WHEN** a Cursor agent operating under the restart rule encounters a listener it did
  not start and cannot identify as this repository's dev process, or any listener on
  `:8791`
- **THEN** the rule directs it to ask the user rather than kill the process

## REMOVED Requirements

### Requirement: Cursor adapter files route to the normative encodings without restating them
**Reason**: The pointer adapters it governs (`.cursor/commands/opsx/`, `.cursor/rules/openspec-sdlc.mdc`, and the old pointer `AGENTS.md`) are removed, and the encodings they routed to no longer exist. `AGENTS.md` is now the template's rulebook.
**Migration**: Cursor and Codex agents read `AGENTS.md` directly. The removed adapters are in git history (main @ 794c107).

### Requirement: A closed-world CI drift guard polices the entire agent surface
**Reason**: Its test (`web/src/cursorAdapters.repo.test.ts`) enforced the removed adapter allowlist and the old pointer `AGENTS.md` shape, and it is removed with them. The template guards its own surface: the `skills-sync` and `guide-size` checks, CODEOWNERS, and deny rules on `.claude/`.
**Migration**: The two remaining `.cursor/` requirements drop their drift-guard clauses; review is their control.
