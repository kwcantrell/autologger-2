# Async catalog callers: teams, admin, profile, shows, auth and the auth middleware await the catalog

Tier: 2
Tier reason: touches `server/src/routers/**` (high-risk path), the auth router, the authentication middleware and the session-identity lookup.

Approved-by: Kalen 2026-10-01
## Why

This is ADR 0021 slice 3b, the second of four top-down PRs that make the storage ports async
while they still run on SQLite:
- 3a (`async-session-callers`, merged) made KV and presence async, converted the session-side
  routers, and added a type-checked test that forbids dropped or misused promises in `server/src`.
- This change converts the remaining catalog callers.

After it, every server catalog call outside a transaction body is awaited. That lets 3d change
the catalog's return types to promises with no further router edits beyond the transaction
bodies.

## What Changes

**56 catalog calls are awaited** (design D1):
- `routers/teams.ts`, `routers/admin.ts`, `routers/profile.ts`, `routers/shows.ts`,
  `routers/auth.ts`;
- `middleware/auth.ts`: `await catalog.init()`;
- `auth/identity.ts`: `resolveSessionUser`'s user lookup.

Teams' `requireTeamMember`, `requireTeamAdmin` and `countOwnedNonBuiltinTeams` become async.

**Code that runs inside a catalog transaction stays synchronous until 3d** (design D2):
- the Google sign-up body;
- the teams last-admin guard, including `wouldStripLastEnabledAdmin` and the `mutate`
  callbacks, which aren't lexically inside the transaction.

`mutate`'s type becomes `(catalog) => undefined`, so an async callback can't be slipped in. Its
write would otherwise run after the transaction commits.

**Memory-only registry getters stay synchronous and are not awaited** (design D3):
`studioNamesDict`, `studioOrderTuple`, `isKnownStudio`, `listStudiosBrief`.

**The promise-hygiene test gains three permanent checks** (design D4), each one a gap the panel
found that 3d would otherwise fall through:
- a promise used as a response body, field or shorthand field;
- a promise compared with `===`/`!==`;
- an async function passed where a void callback is expected.

**Completeness is proven by a local probe.** It retypes the catalog to promises, runs `tsc` and
the hygiene test, and is recorded in the task log, not committed.

**The ADR 0021 slice 4 hazard list grows** (design D6). New entries:
- authorisation checked outside the mutating transaction;
- the team-creation and invite caps;
- the role read-then-write;
- team delete racing show create;
- the registry snapshot dependency and staleness;
- concurrent first sign-in.

**No HTTP change.** The existing route suites pass with no changed expectations.

## Decisions (owner, 2026-10-01)

As for slice 3:
- catalog, KV and presence go async; the session hub waits for slice 7;
- the conversion runs top-down;
- the async transaction uses a scoped handle under a FIFO lock (3c and 3d);
- test seed helpers stay synchronous until slice 4.

## Non-goals

- No change to `CatalogDb`, the catalog stores, or any transaction body (3c and 3d).
- No change to OAuth state handling. The atomic take stays on the slice 4 list for the owner to
  decide.
- No change to authentication or authorisation logic; the awaits are added in place.

## Impact

- **Code:** `server/src/routers/{teams,admin,profile,shows,auth}.ts`, `server/src/promiseHygiene.repo.test.ts` (test),
  `server/src/middleware/auth.ts`, `server/src/auth/identity.ts`.
- **Specs:** `core-ports-architecture`, "Server code never drops or misuses a promise" is
  MODIFIED. It now also forbids promise comparisons, promise response bodies (including
  shorthand fields), and async callbacks where no value is expected. No transitional requirement
  is added.
- **ADR 0021:** the slice 4 hazard list gains this change's check-then-act sequences.
