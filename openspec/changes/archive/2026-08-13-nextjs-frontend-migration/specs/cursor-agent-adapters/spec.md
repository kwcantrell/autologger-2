# cursor-agent-adapters — delta (nextjs-frontend-migration)

## MODIFIED Requirements

### Requirement: The restart rule is scoped to identified dev processes
The reinstated `restart-server-yourself` rule (gate ruling E1, 2026-08-06: kept with the
ownership fix) is the surface's sole non-routing artifact; the drift guard applies its
size and banned-phrase checks to it but not the pointer check. The rule
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
