# cursor-agent-adapters

## Purpose

Governs the two remaining Cursor-side files: the untracked `.cursor/mcp.json` with its
tracked portable example, and the `restart-server-yourself` rule. Cursor and Codex agents read the
lifecycle from `AGENTS.md`; the former pointer adapters and their drift guard were retired by
`adopt-agent-lifecycle`.

## Requirements

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
