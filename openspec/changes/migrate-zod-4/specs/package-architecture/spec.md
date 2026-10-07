## MODIFIED Requirements

### Requirement: Runtime dependencies checked by nominal identity are never duplicated

Where the app maps behavior by `instanceof` against a class owned by a package or a
shared third-party dependency (the `ZodError` → 422 and `ValidationError` → 400
mappings, the `InvalidRangeError` → 416 blob-range mapping, and the
`DashboardValidationError`/`DashboardBoundsError` → 422 dashboard-config mapping —
classes moved into `@autologger/storage` and `@autologger/session-core`
respectively), the dependency SHALL resolve to exactly one copy in the install tree and
each such class SHALL have exactly one module instance in the running process (moves
land as same-commit move + import rewrite; no shim window). `@autologger/contract`
SHALL declare `zod` as a peerDependency so it can never install a private copy, and
`@autologger/storage` (the data-directory lock) SHALL declare `better-sqlite3` as a
peerDependency (the server workspace remains the installing dependency).
`@autologger/session-core` SHALL NOT depend on `better-sqlite3` in any form: its storage is the
Postgres session adapter, injected by the composition root (ADR 0021 slice 7b-1).

`instanceof` mapping is **not** the only ground for single-copy treatment, and this
requirement SHALL NOT be read as licensing a private copy wherever no `instanceof` occurs.
`@autologger/ai-runtime` SHALL likewise declare `zod` as a peerDependency: it hands zod
schema objects to `@anthropic-ai/claude-agent-sdk`'s `tool()`, which carries its own `zod`
peer, so a second resolved copy is a **schema-identity** hazard independent of any error
mapping. The resolved `zod` SHALL satisfy that peer (`zod ^4`), and `@autologger/ai-runtime`
SHALL declare `@anthropic-ai/sdk` (the Agent SDK's type-only peer) as a devDependency. No `ZodError` raised inside an AI-runtime tool body can reach the app's error mapper
— every such parse uses `safeParse`, and the MCP SDK converts validation failures into
`{content, isError: true}` tool results rather than exceptions — so the error-mapping ground
is explicitly **not** claimed here. The single-copy property is the requirement; `instanceof`
is one reason to need it.

#### Scenario: One zod in the tree
- **WHEN** `npm ls zod --json` output is inspected after install
- **THEN** exactly one resolved copy exists, it is a zod 4 release, no package reports it `invalid` (it satisfies `@anthropic-ai/claude-agent-sdk`'s `zod ^4` peer and the MCP SDK's range), and every workspace package declaring `zod` declares it as a peerDependency except `server`, the installing package

#### Scenario: One better-sqlite3 in the tree
- **WHEN** `npm ls better-sqlite3 --json` output is inspected after install
- **THEN** exactly one resolved copy exists, with `@autologger/storage` resolving to it via peerDependency and `@autologger/session-core` declaring no dependency on it

#### Scenario: Cross-package error identity preserved
- **WHEN** a request fails a contract-package schema, a request triggers a domain-package `ValidationError`, an audio request with an unsatisfiable range triggers the storage package's `InvalidRangeError`, and a dashboard-config write with an invalid config triggers the session-core package's `DashboardValidationError`, each exercised through the real app
- **THEN** the responses are `422`, `400`, `416`, and `422` respectively, exactly as before the split (the `DashboardBoundsError` arm is wire-unreachable defensive code today and is covered by the single-module-instance property rather than a wire pin)

#### Scenario: The design turn's tool schemas survive the package move
- **WHEN** a design turn runs through the real app after the AI runtime moves into its package, with the aggregate MCP server's zod-schema'd tools registered
- **THEN** the tools are recognized and callable, proving the agent SDK and the package resolve the same `zod` copy

#### Scenario: The Agent SDK's peers are met
- **WHEN** `npm ls @anthropic-ai/claude-agent-sdk zod @anthropic-ai/sdk` runs after a full install
- **THEN** it exits `0` with no `invalid`, `missing` or `UNMET PEER` line
