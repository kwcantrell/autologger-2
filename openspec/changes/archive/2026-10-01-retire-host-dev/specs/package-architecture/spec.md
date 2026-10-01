## MODIFIED Requirements

### Requirement: Packages are source-only with full toolchain coverage

Internal packages SHALL export TypeScript source directly (`"exports"` pointing at
`./src/*.ts`) with no build step required to run, test, or typecheck the repository, and
no committed build artifacts. Every package SHALL be covered by the root typecheck
command (per-project `tsc --noEmit`), the root test command, and the root lint command
(`biome.json` includes `packages/**`).

The mechanism differs between the app and the packages, and SHALL be described accurately
because a change that wires a new package into the wrong one fails **silently**: the
server's own coverage is explicitly enumerated vitest projects — its two-tier
unit/integration project setup, including its integration `setupFiles`, SHALL be preserved
verbatim, and package projects SHALL NOT be added to it — while each package's coverage is
an entry in the **root manifest's** chained `test` and `typecheck` commands invoking that
workspace. A package absent from those chains is never tested and never typechecked while
every gate reports green.

#### Scenario: No build artifacts
- **WHEN** the repository is inspected after `npm run typecheck` and `npm test`
- **THEN** no committed `packages/*/dist` or emitted declaration output exists and no package defines a build script required for consumption

#### Scenario: Package tests provably execute
- **WHEN** a deliberately failing test is placed in each package (and in the server's unit and integration tiers) during test-wiring implementation
- **THEN** the root test command fails for each, proving no project is silently skipped; the check is recorded in the apply ledger

#### Scenario: A newly added package joins both root chains
- **WHEN** a change adds a package and the root manifest's `test` and `typecheck` chains are inspected
- **THEN** the package appears in both, proven by a deliberately failing test **and** a deliberate type error each failing the corresponding root command — a passing root run is not evidence the package ran

#### Scenario: Integration tier keeps its setup
- **WHEN** the server's `*.int.test.ts` suite runs under the new test wiring
- **THEN** the integration setup file still executes for that tier, and the `--project` selection used by the fixture-capture script still works

#### Scenario: Dev loop runs unchanged
- **WHEN** the dev stack runs `npm run dev` (its container command)
- **THEN** the server boots resolving package source via tsx with no additional build or watch command
