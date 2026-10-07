## MODIFIED Requirements

### Requirement: Every process-wide singleton has exactly one package home

Each process-wide mutable singleton (among them the AI chat turn registry, the MCP
listener singleton, the transcript-generation lock, the YouTube import guard, the DeepGram
shared dispatcher) SHALL be owned by exactly one module in
exactly one package or app, and SHALL NOT be duplicated or re-homed such that two module
instances could coexist in one process. A package move that touches a singleton's module
SHALL preserve single-instance semantics. Per-request state that must be shared by every server
process — the log-import job records, the AI v2 pending-question records and the AI chat resume
bindings (ADR 0021 slice 9b) — SHALL NOT be a process-wide singleton: it SHALL live in the
catalog's key-value store, reached through the `KvStore` port, and the AI v2 pending-question
registry SHALL be built per server binding at the composition root.

Where a singleton's single-instance identity is established by a key on `globalThis` rather
than by module identity alone — because the module must survive development-time module
re-evaluation — that mechanism SHALL be preserved verbatim across a package move, and SHALL
NOT be replaced by a module-local binding.

#### Scenario: Singleton modules resolve uniquely
- **WHEN** the module graph of a running server is inspected for the singleton-bearing modules
- **THEN** each loads exactly once, from exactly one package or app location

#### Scenario: A relocated singleton keeps its identity mechanism
- **WHEN** a singleton whose identity depends on a `globalThis` key moves into a package, and its
  state is written through one import path and read back through another after the module is
  re-evaluated
- **THEN** the same instance is observed, and the key and its rationale are unchanged by the move

#### Scenario: Shared request state is not process-local
- **WHEN** a log-import job is created, or an AI v2 question registered, or an AI chat resume id
  issued, through one server binding, and read through a second binding over the same database
- **THEN** the second binding sees it, and neither binding holds it in a module-level or
  `globalThis` structure
