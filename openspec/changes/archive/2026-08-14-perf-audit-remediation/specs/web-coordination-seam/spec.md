# web-coordination-seam — delta

## MODIFIED Requirements

### Requirement: Handler ownership is identity-scoped at teardown

A teardown SHALL clear a handle only if the handler being torn down is still the registered one.
A stale owner's teardown SHALL NOT clear a handler a newer owner has since registered.

**This is forward insurance against a latent hazard, not repair of an observed defect.** The
hazard is real at the mechanism level — two owners of one handle spanning separate commits can
produce cleanup-after-newer-setup — and it remains unreachable in the component tree as it stands.
The application **does** now use `React.lazy` and `<Suspense>`: the route split put six surfaces
behind a shared `LazyChunk` boundary, and the session workspace — a handle-owner tree — is one of
them. The earlier blanket precondition "the application uses no `Suspense`, `React.lazy`,
transition API, or Offscreen boundary" is therefore **false and is retired**. Unreachability now
rests on four narrower, individually checkable facts:

1. **One owner, one position.** Each handle still has exactly one owner rendered at exactly one
   position. The workspace `LazyChunk` is rendered at exactly one site inside `SessionRoute`,
   which is itself rendered at exactly one site in the shell.
2. **No nested suspension point below the boundary.** There is no second `lazy()`, no
   suspense-mode query, and no `useTransition` / `startTransition` / Offscreen anywhere under
   `web/src`. A subtree can therefore never re-suspend after it has been revealed — and a
   post-reveal re-suspension is the only way React would keep a hidden-but-mounted owner alive
   beside a newly mounted one.
3. **A session switch is unmount→remount, not overlap.** The per-id resolution query sets
   `gcTime: 0`, so an id change drops `data` to `undefined`; `SessionRoute` then returns its
   loading state, unmounting the `LazyChunk` and every owner below it in that same commit, before
   the new id's workspace can mount.
4. **Chunk-retry remount cannot interleave.** Retry is offered only for chunk-load errors, and a
   chunk-load error can only be thrown by the initial module import — at that point no owner below
   the boundary has mounted and nothing is registered. Retry then remounts the boundary by key,
   and React runs passive unmount effects before passive mount effects within a key-change commit.

Any of these four changing makes the hazard reachable again: a second owner for a handle, an owner
rendered at two positions, a nested suspension point (a second `lazy()`, a suspense-mode query, or
adoption of a transition/Offscreen API) below a handle-owner tree, a resolution cache that lets two
ids overlap, or decomposition of the session workspace into independently mounted regions.

Identity-scoped `unregister(handle, handler)` — release only if you still own it — SHALL remain the
mechanism, and it is the **load-bearing mitigation**. Facts 1–4 are defence in depth behind it, not
a substitute for it: they are properties of today's tree that an ordinary refactor can change
without touching this module, whereas the identity check holds regardless. There SHALL remain no
unconditional `clear(handle)`, which would re-admit the same clobber through a second door.

#### Scenario: A stale teardown does not clear a newer registration

- **WHEN** owner A registers a handler, owner B registers a replacement for the same handle, and
  only then does owner A's teardown run
- **THEN** owner B's handler remains registered, and invoking the handle runs owner B's handler

#### Scenario: A current owner's teardown does clear

- **WHEN** an owner registers a handler and its teardown runs with no intervening registration
- **THEN** the handle has no registered handler afterwards

#### Scenario: A lazy boundary between the shell and a handle owner keeps one live owner

- **WHEN** a handle owner is mounted behind a `React.lazy` / `<Suspense>` chunk boundary and the
  route's session id changes, or the boundary is remounted by a chunk-load retry
- **THEN** at no point are two owners of the same handle simultaneously registered: the outgoing
  subtree unmounts before the incoming one mounts, and a failed chunk import registers nothing at
  all

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
builds **two independent entry bundles** — the index island and the admin island — and the smaller
one depends on none of the larger one's libraries; that independence is the property nothing
currently protects, and it is unchanged.

What has changed is the shape *inside* the index entry: it is no longer a single download. The
index island is route-split behind `React.lazy`, with at least seven dynamic-import edges below
the entry — six `LazyChunk` split points (the session workspace, the `/teams` route, and the New
Session, Batch Import, YouTube-import-error, and Settings overlays) plus Batch Import's own inner
import of the log-import client. "Entry bundle" in this requirement therefore means the entry
graph and the chunks reachable from it, not one file; the enforced property is the **direction** of
edges, which is indifferent to how the bundler carves them into chunks.

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

- A directory literally named `node_modules` living **under** `web/src` (not a real package-manager
  install) — the walk's skip-list excludes any directory named `node_modules` unconditionally, so
  first-party code planted there is never examined.
- A symlinked **file** under `web/src` whose target lives under `packages/` — the file is scanned,
  but its own internal relative imports resolve against the symlink's location, not the target's
  real location, so nothing about it looks anomalous to a specifier-string check.
- A non-literal dynamic-import argument (`const p = '…'; await import(p)`) — cannot be resolved
  statically. This residual now sits directly beside the app's primary code-splitting mechanism:
  literal dynamic `import(...)`, used at the loaders in `AppShell.tsx` and `SessionRoute.tsx`.
  Those literal specifiers **are** resolved by the check; only a computed argument escapes it.
- `import.meta.glob(...)` — Vite's build-time bundling primitive; the check does not resolve its
  glob argument. The production bundler is now Next/webpack, which does not implement it, so this
  bypass no longer describes a way to get package code into a shipped bundle; it is retained
  because Vite survives as the test transform and such a file would still resolve there.
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

#### Scenario: Route-split chunks are subject to the same direction rule

- **WHEN** a module reached only through a dynamic `import(...)` below the index entry is scanned
- **THEN** it is scanned exactly like a statically imported production file — being in a
  lazily-fetched chunk grants no exemption from the direction, packages, or test-file rules

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
