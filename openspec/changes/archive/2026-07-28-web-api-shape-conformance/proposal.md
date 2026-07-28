# Fix `/admin/users` crash and close the client/server response-shape drift class

## Why

`GET /admin/users` white-screens as soon as the operator loads data. The React client types
a user's team memberships as `AdminUser.memberships: string[]`, but the server has **always**
returned `studios: [{id, name}]` (`server/src/routers/admin.ts`, the `usersOut.push({… studios:
mids.map(…)})` block). `u.memberships` is therefore `undefined`, `.map` throws, and React
unmounts the whole page — an unrecoverable blank screen, not a degraded row. The mismatch has
been present since the frontend was adopted (`cc60162`); the admin page has no test coverage,
so nothing caught it.

The interesting part is *why it survived typechecking*. `apiFetch<T>` ends in
`return res.json() as Promise<T>` — an unchecked cast. The type parameter **asserts** the
response shape rather than verifying it, so every place a JSON response acquires a type in
`web/src` is a place where the server can drift away from the client and `tsc` will stay silent
until a component dereferences the missing field at runtime.

This is not the first instance. Commit `2ca5b1d` ("round-trip show categories via name key")
fixed the same class once already, and its own commit message records the lesson: tests must
use *wire-accurate* fixtures, because "a label-keyed fixture can't mask the bug." Two instances
means the class is worth closing, not just the instance.

## What Changes

- **Fix the crash.** Retype `AdminUser.memberships: string[]` → a `studios` array of
  `{id, name}` (reusing the existing `StudioBrief`), matching the frozen response, and update
  its consumers in `AdminUsersPage.tsx`: two direct reads of the field — the membership chip
  list and the "+ Add team" already-a-member filter (`Array.includes` → `.some(m => m.id ===
  s.id)`) — plus the remove-membership call argument, which is threaded out of the chip list
  rather than read from the field independently.
- **Show team display names on membership chips.** The server already sends `name` alongside
  `id`; the chip currently renders the raw slug (`my-crew`). It becomes `My Crew`. A deliberate,
  user-visible improvement folded into the fix, not incidental drift.
- **Audit every place a JSON API response acquires a type** in `web/src` — not merely the 45
  literal `apiFetch<…>` occurrences. The enumeration is **semantic**: it includes assertions
  laundered through local generic wrappers (the crashing call is
  `fetchAdmin<AdminDataResponse>(…)`, which no `apiFetch<` grep can see), untyped `apiFetch(…)`
  calls, and raw `fetch(…).json() as X` consumers. Each site gets a recorded verdict against the
  response the server actually emits. Client-side mismatches are fixed here; server-side
  divergences are escalated, never fixed.
- **Verify client response types against captured real responses.** Payload-bearing endpoints
  get their emitted body captured into a committed fixture by a `server/` integration test that
  also asserts the live response still matches it. The web tier checks its client types against
  those same fixtures, so a client/server divergence fails `npm run typecheck` / `npm test` in
  CI — not in an operator's browser. Fixtures are **captured, never hand-written**: a
  hand-written fixture can embody the same wrong belief as the type it is meant to check.
- **Guard against new unverified sites** with a repo-invariant test, following the idiom this
  repo already uses twice (`queryKeyFactories.repo.test.ts`,
  `noAgentAuthoredMarkup.repo.test.ts`).
- **Add regression tests** for the admin page, which currently has none.

## Capabilities

### New Capabilities

- `web-admin-users`: observable behavior of the `/admin/users` operator page — how a user's
  team memberships are rendered, which teams the add-membership control offers, and what the
  membership controls act on. This surface is live and reachable but has never been specced;
  the crash is the direct consequence.
- `web-api-response-conformance`: that the web client's response types match what the server
  actually emits, that the match is **verified in CI against captured real responses** rather
  than asserted by a type parameter, and that new response-consuming sites cannot silently skip
  that verification.

### Modified Capabilities

None. `api-contract-freeze` is the authority this change conforms *to*, not one it edits.
`web-ui-system` mentions the admin-users page only for its dialog policy, which is untouched.

## Impact

- **Contract impact: NONE.** The server is not modified in this change — not a route, not a
  response shape, not a status code. The frozen contract is the correct side of the mismatch;
  the client is the wrong side, and the client is what moves. No `api-contract-freeze` delta
  is required or authorized. New `server/` **test** files that capture responses are additive
  and observe the contract without altering it.
- **Runtime impact: NONE.** No browser dependency, no bundle growth, no per-response parsing
  cost. Verification happens entirely at build/test time. (A runtime-validation design was
  considered and rejected at the gate — see `design.md` D1.)
- **Code:** `web/src/api/types.ts`, `web/src/api/hooks/*`, `web/src/pages/admin-users/`, plus
  new fixtures, new `server/` capture tests, a new web conformance-check module, and a new
  repo-invariant guard test.
- **Known mismatches the audit is expected to confirm** (found during review, recorded so the
  audit verifies rather than rediscovers them): `/api/profile`'s `active_studio.categories[]
  .dropdown_options` is emitted as `string[]` by `studioToApiDict` while the client's shared
  `Category` type declares `DropdownOption[]` — and the *same* client type is used for
  `ShowCategoriesResponse`, where the server genuinely emits `{label, needs_context}` via
  `showCategoriesApiShape`. Resolving this needs a **type split**, not a field edit. Separately,
  `transport/start` and `transport/stop` both `return c.json(state)` while the client asserts
  `OkResponse`.
- **Tests:** `npm test` grows admin-page coverage, response-capture tests in the server tier,
  conformance checks in the web tier, and the repo-invariant guard.
- **Operators:** the `/admin/users` page becomes usable again; membership chips read as names.

## Non-Goals

- **No server changes of any kind.** Not response shapes, not routes, not status codes. If the
  audit finds a case where the server looks wrong, that is escalated as a finding — it is not
  fixed here, because that would require an `api-contract-freeze` delta this change does not
  carry. This explicitly includes the `dropdown_options` inconsistency above: the *client* type
  splits; the two server shapes stay as they are.
- **No runtime response validation.** Rejected at the gate (`design.md` D1) after measurement:
  it detects no earlier than the status quo, and costs ~14 KB gzip on the shared main chunk.
  The one thing it would buy that fixtures cannot — production data variance — is recorded as a
  named residual, not built.
- **No request-body validation, no WebSocket message validation, no OpenAPI/codegen.**
- **No re-litigation of the frozen contract.** `studios: [{id, name}]` is correct because it is
  frozen and shipped, not because it is the nicer shape.
- **No refactor of `react-query` hook structure**, caching, or invalidation.
- **No new admin capabilities.** The admin page's feature set does not grow; only its
  correctness and its membership-chip label change.
