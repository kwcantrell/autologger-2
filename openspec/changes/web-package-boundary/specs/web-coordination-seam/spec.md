## MODIFIED Requirements

### Requirement: The web app's internal import direction is mechanically enforced

Within `web/src`, production **value** imports SHALL flow only downward through
`pages → api → shared`. `api` and `shared` SHALL NOT value-import from `pages`. The `admin-users`
page SHALL NOT import from the `index` page, in either direction.

**Type-only upward edges are permitted and SHALL NOT be flagged.** Three exist today —
`shared/utils/{recording,timecode,audioClips}.ts` each `import type` from `api/types` — and they
erase at compile time, so the runtime graph stays acyclic while the type graph does not. The
boundary this requirement protects is the runtime and bundle structure, not the type graph.
Forbidding them would force import rewrites this rule was explicitly adopted to avoid.

This direction already holds; the requirement exists because it held only by convention. `web/`
builds two independent entry bundles, and the smaller one depends on none of the larger one's
libraries — a property nothing currently protects.

**The web app does not depend on the workspace package graph.** Production files under `web/src`
SHALL NOT import from `packages/` — neither by relative path nor by `@autologger/*` specifier — at
any layer. This is a **flat** rule: no per-layer permission is granted, because a permission
requires a consumer to justify it and there is none. The one place web-side code needs computations
a package also performs, it **hand-mirrors** them, and that mirror is permanent policy rather than a
provisional workaround.

**Threat model.** The mechanical check backing this rule is a **drift guard**, not an evasion-proof
barrier, and it does not claim to be one. It exists to catch a future edit reaching for `packages/`
because it is convenient — an ordinary import added without anyone deciding to cross the boundary —
and against that class of change it is effective: every such edit under `web/src` today is caught.
It is **not** a defence against a determined, deliberate evasion, and the requirement makes no claim
of exhaustiveness. Across repeated adversarial review, the check has been defeated and re-fixed
several times; the following bypasses are known, accepted as residual, and disclosed rather than
chased further:

- `import.meta.glob(...)` — Vite's other build-time bundling primitive besides static `import` and
  literal dynamic `import(...)`; the check does not resolve its glob argument.
- A directory literally named `node_modules` living **under** `web/src` (not a real package-manager
  install) — the walk's skip-list excludes any directory named `node_modules` unconditionally, so
  first-party code planted there is never examined.
- A symlinked **file** under `web/src` whose target lives under `packages/` — the file is scanned,
  but its own internal relative imports resolve against the symlink's location, not the target's
  real location, so nothing about it looks anomalous to a specifier-string check.
- A non-literal dynamic-import argument (`const p = '…'; await import(p)`) — cannot be resolved
  statically.
- `typeof import('...')` in type position — a distinct AST node the check does not walk; it erases
  at compile time regardless.
- A root-absolute specifier (`'/../packages/domain/src/index.ts'`) — the check does not resolve it,
  but `tsc` rejects it (`TS2307`), so this one has a real compensating control outside this check.

One shape found in review is fixed rather than disclosed, because it is a defect independent of
this rule: **no production file under `web/src` SHALL import a test file.** A production file
importing a `*.test.ts`/`*.test.tsx`/… file is a direct edge to code vitest's own test glob does
not collect, which ships as ordinary production code under a name that says it is not shipped —
this holds regardless of what the imported test file goes on to import, and the check does not
reason transitively about that; doing so is exactly the arms race this threat model declines to
run. This is the narrowest fix available: a direct-edge rule, not a package-reachability analysis.

**Test files are exempt, and the exemption is load-bearing.** The mirror's correctness is guaranteed
by a pinning test that imports the real package module and asserts identical output on shared
fixtures. Forbidding that import would remove the guarantee that makes the duplication acceptable.

Whether `web/` may depend on the package graph was left open across five changes; this settles it.
It SHALL be revisited if a **second** web-side consumer of package code appears — the arithmetic
behind both the flat rule and the decision not to retire the mirror rests on there being exactly
one.

#### Scenario: The layering direction is enforced, not merely observed

- **WHEN** production files under `web/src` are scanned for **value** imports crossing the
  `pages` / `api` / `shared` boundaries
- **THEN** no value import from `api` or `shared` targets `pages`, and the existing type-only
  `shared → api` edges are not reported

#### Scenario: The two entry bundles stay independent

- **WHEN** production files under `web/src/pages/admin-users` are scanned for imports
- **THEN** none targets `web/src/pages/index`

#### Scenario: Production web code does not reach the package graph

- **WHEN** production files under `web/src` are scanned for imports targeting `packages/`, by
  relative path or by `@autologger/*` specifier
- **THEN** none exists

#### Scenario: No production file imports a test file

- **WHEN** production files under `web/src` are scanned for a direct import edge whose target is a
  `*.test.*` file
- **THEN** none exists, regardless of what the imported test file itself imports

#### Scenario: The guard's threat model is disclosed, not claimed complete

- **WHEN** a reader consults the mechanical check enforcing this requirement to learn what it
  protects against
- **THEN** it is documented as a drift guard rather than an evasion-proof barrier, and its known,
  unfixed bypasses are enumerated rather than left for a future reviewer to rediscover

#### Scenario: The pinning test's cross-workspace import stays permitted

- **WHEN** a test file under `web/src` imports a package module to pin a hand-mirrored computation
  against its original
- **THEN** the check does not report it

#### Scenario: The mirror's justification stays truthful

- **WHEN** a reader consults the hand-mirrored module to learn why it is duplicated rather than
  imported
- **THEN** the stated reason reflects a live constraint, and the mirror is identified as permanent
  policy rather than as pending work
