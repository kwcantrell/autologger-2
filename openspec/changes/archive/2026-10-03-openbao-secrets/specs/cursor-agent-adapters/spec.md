## MODIFIED Requirements

### Requirement: The restart rule is scoped to identified dev processes
The `restart-server-yourself` rule (gate ruling E1, 2026-08-06: kept with the ownership fix)
SHALL authorize restarting only (a) processes the agent itself started, or (b) this
repository's dev stack, through `make dev-restart`; for any other process — including an
unidentified listener on `:8787` or any container outside the `autologger-dev` project — the
rule SHALL direct the agent to ask first. The rule SHALL state what `make dev-restart` does (it
reads the stack's secrets from OpenBao and restarts the app, the Companion and both gates),
SHALL direct the agent to stop and ask when `make dev-restart` fails rather than restart or exec
into containers directly, SHALL forbid starting a second server by hand inside a container, SHALL reference restart
commands via the Makefile rather than duplicating command lines, and SHALL state explicitly that
dev runs as a single process on `:8787` inside the dev stack (there is no host dev process and no
separate `:5173` frontend dev server to manage).

#### Scenario: Unidentified and foreign processes are off-limits
- **WHEN** a Cursor agent operating under the restart rule encounters a listener it did
  not start and cannot identify as this repository's dev stack
- **THEN** the rule directs it to ask the user rather than kill the process
