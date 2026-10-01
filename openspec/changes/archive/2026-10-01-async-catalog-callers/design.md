# Design: async-catalog-callers

## Context

3a (`async-session-callers`) established three things:
- `await` on a still-synchronous call runs it in place and yields only to already-queued
  microtasks, so nothing observable changes (3a D1);
- the type-checked promise-hygiene repo test;
- the slice 4 hazard list in ADR 0021.

This change applies the same mechanical conversion to the remaining callers, and closes the gaps
the panel found in the promise-hygiene test before 3d relies on it.

## D1. Scope of the conversion

The assumption tester's type-checker probe resolved every server call whose declaration lives in
`packages/catalog/src`. There are 56 calls to convert:

| File | Calls to await | Helpers made async |
|---|---|---|
| `routers/teams.ts` | 17 | `requireTeamMember`, `requireTeamAdmin`, `countOwnedNonBuiltinTeams` |
| `routers/profile.ts` | 15 | none |
| `routers/admin.ts` | 12 | none |
| `routers/shows.ts` | 8 | none |
| `routers/auth.ts` | 2 (`authGetUserByGoogleSubAny`, `authUpdateUserProfile`) | none |
| `middleware/auth.ts` | 1 (`catalog.init()`) | none |
| `auth/identity.ts` | 1 (`authGetUserById`) | none |

These are not converted:
- the transaction-reachable code (D2);
- the memory-only getters (D3);
- `logImport.ts`'s `projectLive` callback, which already returns the call to an awaiting caller
  (3a).

Every other server file is fully converted already.

## D2. Transaction-reachable code stays synchronous until 3d

better-sqlite3's `db.transaction(fn)` throws for a callback returning a promise ("Transaction
function cannot return a promise"; verified by the assumption tester). Server code has exactly
two transaction sites, `teams.ts:124` and `auth.ts:197`, with nothing nested.

The code that runs inside them stays synchronous, named here because not all of it is lexically
inside the callback:
- **`auth.ts:197-224`**, the Google sign-up body: create, seed prefs (two `getSetting`), consume
  invites, add memberships.
- **`teams.ts` `guardedAgainstLastAdmin`:** its transaction callback;
  `wouldStripLastEnabledAdmin` (`teams.ts:97-109`, three calls); and the three `mutate`
  arrows (`teams.ts:277-278`, `296-297`, `307-308`). The guard is called without `await` and
  returns `void`.

**The trap.** "Fixing" a `mutate` arrow by making it `async (cat) => { await … }` would
typecheck, because a `(catalog) => void` parameter accepts an async function. It would also pass
today's tests. But the write would run after `COMMIT`, outside the last-admin check, once storage
does I/O. Two defences:
- `mutate`'s type becomes `(catalog: CatalogFacade) => undefined`, so only block-bodied
  synchronous arrows that return nothing fit. The three call sites become `(cat) => {
  cat.auth.…(…); }`.
- The promise-hygiene test flags any promise-returning function passed to a parameter whose type
  returns `void` or `undefined` (D4).

3d converts all of this to `tx(async (t) => …)` with a scoped handle.

## D3. Memory-only registry getters are not awaited

`studioNamesDict`, `studioOrderTuple`, `isKnownStudio` and `listStudiosBrief` return the
in-memory registry that `Catalog.init()` loads per request (`studioRegistry.ts:78-90, 165-174`),
with no `db` access. They stay synchronous in 3d, so awaiting them now would be async costume.
No server code awaits them today.

`listStudiosBriefAllowed` is the same kind but has no server caller.

**Dependency.** A getter is only correct after `await catalog.init()`. Every server caller is
behind `middleware/auth.ts`. A non-request caller (boot, a WebSocket path, a detached job) must
call `init()` first. That is recorded on the slice 4 list together with snapshot staleness (D6).

## D4. Promise-hygiene test: close the gaps (permanent), and no temporary catalog test

The draft's temporary `catalogAwait.repo.test.ts` is dropped. It duplicated what 3d's return
types bring for free, its lexical rule contradicted D2 (the `mutate` and `wouldStrip…` calls), and
it would have needed deleting in 3d.

Instead, `server/src/promiseHygiene.repo.test.ts` gains three checks. Each gap was found by the
failure reviewer, and each matters once the catalog returns promises:
1. **Response body.** Any argument to a `.json(…)` call whose type is promise-like: the body
   itself (`c.json(promise)`, as in `profile.ts:36,58,133`), any property including shorthand
   (`{ members }`), and spread sources.
2. **Comparison operand.** A promise-like operand of `===`, `!==`, `==` or `!=`. TypeScript
   allows `promise === null`, which is always false (`teams.ts:287`-style existence checks).
3. **Async callback where void is expected.** An argument whose type is a function returning a
   promise, passed to a parameter whose function type returns `void` or `undefined`.

Each check gets an in-memory fixture. The tree must pass all of them today. Today none of these
values are promises, so this doubles as proof that the checks don't false-positive.

**Completeness evidence for 3b, kept as a log and not committed.** After the conversion, a local
probe retypes the catalog store interfaces and facade methods (except the D3 getters) to return
`Promise<…>`. It then runs `tsc` and the promise-hygiene test, records the excerpt in the task
log, and reverts the probe. The expected result: findings only at the D2 transaction-reachable
sites, which 3d converts.

## D5. Gates

The gate helpers `requireTeamMember`/`requireTeamAdmin` fail closed if an await is missed. The
failure reviewer verified each failure mode:
- `const { role } = requireTeamMember(…)` gives TS2339;
- `admin.id` on a promise gives TS2339;
- `countOwnedNonBuiltinTeams(…) >= N` gives TS2365;
- a bare `requireTeamAdmin(c, id);` is a dropped promise;
- `!gate()` is a condition misuse.

`createCatalog` builds a new `Catalog` and `StudioRegistry` per request (`catalog.ts:47`), so
requests share no registry state.

## D6. Slice 4 hazards added (ADR 0021)

None of these can race while the catalog is synchronous (3a D1). All become real with I/O:
1. **Authorisation is checked outside the mutating transaction.** Every `requireTeamAdmin` gate
   reads the role, then a later statement writes. For example, a demoted admin's in-flight
   self-promote or delete still completes. Remedy: re-check the gate inside the mutating
   transaction, or rely on RLS (slice 6).
2. **Team creation:** the cap count, then create the studio, then add the admin membership. That
   is two writes with no transaction, so a failure between them leaves a studio with no admin
   (pre-existing). Remedy: one transaction, with the cap re-checked inside it.
3. **Pending-invite cap:** count, then upsert. Remedy: a transaction or a constraint.
4. **Role change:** read the current role, then write (the promote path, outside the guard).
   Remedy: a conditional update.
5. **Member removal:** the existence check sits outside the guarded transaction. Remedy: move it
   inside.
6. **Team delete versus show create:** `adminDeleteStudio` counts shows outside its own
   transaction (`studioRegistry.ts:214-219`), while `POST /api/shows` checks the studio, then
   creates. Remedy: count inside the delete transaction, or a foreign key.
7. **Registry snapshot:** getters need `init()` first (D3), and the snapshot can go stale across
   awaits within one request, for example names next to mutations in `admin.ts` and
   `teams.ts:165`. Remedy: refresh after writes, or read names inside the response query.
8. **First Google sign-in:** concurrent first sign-ins with the same `sub` get a 500 on the
   unique constraint (pre-existing). Remedy: catch the conflict and retry the lookup.

## D7. Size

About 56 × 2 for the awaits, plus helper call sites, signatures, the `mutate` type and the three
block bodies. That's about 140-180 counted lines. The test changes are not counted.
