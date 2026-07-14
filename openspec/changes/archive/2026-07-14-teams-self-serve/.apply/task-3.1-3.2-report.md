# Tasks 3.1 / 3.2 — sign-in materialization + callback fixes

Branch: `teams-self-serve` (plain checkout, no worktree). Commits:
- `880fad3` feat(auth): transactional invite materialization; account_disabled
  redirect; deprecate NEW_USER_ALL_TEAMS
- `d8a5e5e` docs(openspec): tick tasks 3.1-3.2

## Scope covered

1. **D11 — disabled-account sign-in redirect.** The callback now resolves the
   Google `sub` against ALL user rows (`AuthStore.authGetUserByGoogleSubAny`,
   new method) before the existing/new split. A disabled match short-circuits
   to `302 /?login_error=account_disabled`, no cookie, no writes — replacing
   the latent 500 (new-user branch tripping the unique `google_sub`
   constraint).
2. **D2 — transactional new-user branch.** User creation, pref seeding, and
   invite materialization all run inside one `c.env.ports.catalog.tx(() =>
   {...})` call at the router level in `server/src/routers/auth.ts`.
   Materialization fires only when `claims.email_verified === true` AND the
   raw (pre-fallback) `email` claim is non-empty — guards the synthesized
   `<sub>@users.noreply.invalid` address from ever normalizing into a match.
   It calls the pre-existing `authConsumeInvitesForEmail` (select+delete,
   no internal `tx()`) and grants `member` via `authAddMembershipWithRole`
   for each consumed row's `studio_id`. The async KV login-session write
   (`createLoginSession`) stays outside the transaction, after the
   existing/new `if` block.
3. **D5 — NEW_USER_ALL_TEAMS deprecation.** The blanket-grant block is
   deleted from the callback entirely (no more `newUserAllTeamsEnabled`
   import in `auth.ts`). The env var stays parsed (`Config.NEW_USER_ALL_TEAMS`
   unchanged in `types.ts`/`node/config.ts`). `createBindings` in
   `server/src/node/config.ts` now logs one `console.warn` after
   constructing bindings when `newUserAllTeamsEnabled(bindings.config)` is
   true — this runs once per process boot (once per `createBindings` call),
   never per-request. README (`Security notes`) and `server/.env.example`
   both call out the deprecation.

## email_verified claim plumbing

No change was needed to `verifyIdToken`/`oauth_google.ts`. `jose`'s
`JWTPayload` type carries `[propName: string]: unknown`, so `email_verified`
(and any other unlisted claim) already flows through the returned `payload`
at runtime — `auth.ts` just reads `claims.email_verified === true` off the
same `Record<string, unknown>` it already casts `verifyIdToken`'s result to.
Verified with the test suite: `mintIdToken({ claims: { ..., email_verified:
true } })` round-trips through the existing JWKS-stub verify path with no
production-code change to the verifier.

## normalizeEmail duplication (deliberate)

`routers/teams.ts` already has a `normalizeEmail` (`toLowerCase().trim()`)
but it isn't exported, and teams.ts is explicitly out of scope for this task
(scope guard: "do NOT touch teams.ts"). `auth.ts` gets its own one-line
`normalizeEmail` with a comment explaining the duplication is intentional —
the algorithm is a stateless primitive, so the two copies can't diverge in
practice, and exporting from teams.ts would have required touching a file
this task was told not to touch.

## Tx boundary shape

```
uid = c.env.ports.catalog.tx(() => {
  const newUid = catalog.auth.authCreateUserGoogle({...});
  catalog.auth.authSeedPrefsFromGlobals(newUid, ...);
  if (emailVerified && email) {
    const consumed = catalog.auth.authConsumeInvitesForEmail(normalizeEmail(email));
    for (const invite of consumed) {
      catalog.auth.authAddMembershipWithRole(newUid, String(invite.studio_id), 'member');
    }
  }
  return newUid;
});
```

`CatalogDb.tx` wraps `better-sqlite3`'s `db.transaction(fn)()`; every store
call inside is a plain synchronous statement (no nested `tx()` calls in
`authCreateUserGoogle`, `authSeedPrefsFromGlobals`, `authConsumeInvitesForEmail`,
or `authAddMembershipWithRole`), so this is one single transaction, not
nested savepoints, for the whole new-user branch.

## Warning placement

`createBindings` (`server/src/node/config.ts`) — the composition root called
exactly once at real process boot from `main.ts`. Placing the warning here
(rather than in the callback handler) is what makes it "once at startup, not
per-request": the callback branch that used to consult the flag is gone
entirely, so there's no per-request call site left to gate.

## Tests

`server/src/routers/auth.int.test.ts` — new describe block "callback --
invite materialization (task 3.1, design D2)", 8 new tests:
- case-insensitive materialization (invite `new.person@example.com`, sign-in
  claim `New.Person@Example.com`) → `member` role + invite row consumed
- `email_verified: false` → user created, invite remains, no membership
- `email_verified` absent → user created, invite remains, no membership
  (distinct test from `false`, per the spec's absent-or-false wording)
- revoked invite (upsert then delete before sign-in) never materializes
- existing-user sign-in does not re-scan an invite seeded after the account
  already existed
- `NEW_USER_ALL_TEAMS=1` with a studio present grants zero memberships
- disabled account sign-in → 302 `/?login_error=account_disabled`, no
  `Set-Cookie`, and the user row is byte-for-byte unchanged
  (`authGetUserRowAny` before/after `toEqual`)
- atomicity: `vi.spyOn(AuthStore.prototype, 'authConsumeInvitesForEmail')`
  throws mid-transaction → response is the app's ordinary 500 (Hono's
  `onError`, matching the existing "post-verification write throws"
  coverage — errors resolve as 500 responses, not rejected promises) and no
  user row was ever persisted. This is a real fault-injection, not a
  structural-only proof: it exercises `better-sqlite3`'s transaction
  rollback on the one realistic mid-branch throw site the real store exposes.

New `server/src/node/config.test.ts` (unit tier, no harness needed —
`createBindings` builds its own temp-dir bindings from a procEnv object,
same pattern `test/harness.ts` uses): asserts the warning fires exactly once
when `NEW_USER_ALL_TEAMS=1` and matches `/NEW_USER_ALL_TEAMS.*deprecated/i`,
and does not fire when unset/`0`. Rationale for the separate file: the
existing `auth.int.test.ts` harness (`envWith`) only overlays `Config` on
top of bindings already constructed once per test by `resetTestEnv()` — it
never calls `createBindings` again, so a per-request env override can't
observe a boot-time log line. The `NEW_USER_ALL_TEAMS=1` test in
`auth.int.test.ts` therefore only asserts the *behavior* (zero memberships
granted) and documents in a comment why the warning assertion lives in
`config.test.ts` instead.

## RED evidence

`git stash push -- server/src/routers/auth.ts server/src/db/authStore.ts
server/src/node/config.ts README.md server/.env.example` (kept the new/
extended test files), then ran:

```
cd server && npx vitest run src/routers/auth.int.test.ts src/node/config.test.ts
```

Result: 5 failing, 21 passing (26 total) —
- `logs a one-time startup warning when NEW_USER_ALL_TEAMS is truthy` — 0 calls, expected 1
- `materializes a pending invite into a member membership...` — role `null`, expected `'member'`
- `NEW_USER_ALL_TEAMS=1 grants nothing...` — 3 memberships (the old blanket grant), expected 0
- `a disabled account signing in is redirected...` — 500 (UNIQUE constraint on `users.google_sub`,
  the exact latent bug D11 describes), expected 302
- `atomicity: a throw mid-materialization rolls back...` — 302 (no tx to roll back), expected 500

`git stash pop` restored the implementation; the same command then reported
26/26 passing (GREEN).

## Suite tails

- `npm run typecheck` (server + web + companion + e2e): clean, no errors.
- `npm test`: server 46 files / 329 tests passed; web 13 files / 123 tests
  passed; companion 6 files / 20 tests passed.
- `npm run lint`: 4 pre-existing warnings in `web/src/shared/utils/loadingVideo.ts`
  (optional-chain suggestions), untouched by this change and outside scope
  (`web/` is off-limits per the scope guard). No new warnings introduced.

## Scope guard compliance

Did not touch `teams.ts`, `profileAssembler.ts`, `admin.ts`, or anything
under `web/`. Only touched: `server/src/routers/auth.ts`,
`server/src/routers/auth.int.test.ts`, `server/src/db/authStore.ts` (one
additive method), `server/src/node/config.ts`, `server/src/node/config.test.ts`
(new), `README.md`, `server/.env.example`, plus this repo's
`openspec/changes/teams-self-serve/tasks.md` bookkeeping tick.

## Concerns / residual notes

- The `NEW_USER_ALL_TEAMS=1` deprecation-warning assertion could not be
  observed from the same integration test that exercises the grant-nothing
  behavior, because of how the test harness layers `Config` overrides on an
  already-constructed `Bindings` (see "Tests" above). Covered instead by a
  dedicated `createBindings`-level unit test. This is a harness-shape
  limitation, not a product gap — the behavior (no warning per request,
  exactly one warning per real boot) is what design D5 asks for.
- README changes are limited to the "Security notes" bullet for
  `NEW_USER_ALL_TEAMS`, per task 3.2's explicit scope ("README env docs").
  Task 4.2 (endpoint table rows for `/api/teams` + `GET /teams`) is a
  separate, not-yet-done task and was left untouched.
