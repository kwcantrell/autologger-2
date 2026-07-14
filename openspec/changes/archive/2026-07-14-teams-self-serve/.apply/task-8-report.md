# Task 8 report — final gates + whole-branch review

## Branch-review fix round

The whole-branch review of `teams-self-serve` (task 8.2) returned five
findings. All five were fixed in one round on the same branch (no worktree,
per repo convention), gated, and committed.

### 1. README `login_error` enumeration missing `account_disabled`

`server/src/routers/auth.ts` emits `302 /?login_error=account_disabled` on
the disabled-account sign-in redirect path (authorized by the
`api-contract-freeze` delta's "Disabled-account sign-in redirect" clause),
but the README's "Auth callback failure redirects" enumeration (line ~149)
still listed only the six original codes. Added `account_disabled` to the
list, same backtick/comma format as its neighbors.

### 2. `normalizeEmail` triple duplication

The lowercase/trim email-normalization primitive (design D2: JS
`toLowerCase().trim()` only, never SQL `lower()`) existed independently in
three places:
- `server/src/routers/auth.ts` — local `function normalizeEmail`, with a
  comment claiming "teams.ts is out of scope for this change (apply-scope
  guard)" — factually wrong (teams.ts is very much in scope; both files are
  part of this same branch) and removed along with the duplicate.
- `server/src/routers/teams.ts` — an identical local `function
  normalizeEmail`.
- `server/src/db/authStore.ts`'s `authListUsersByEmailNorm` — the same
  algorithm inlined as `.filter((u) => String(u.email).toLowerCase().trim()
  === emailNorm)`.

Consolidated into one exported helper, `normalizeEmail(raw: string): string`
in `server/src/db/shared.ts` (already a dependency-free import target for
both the Catalog facade and domain stores — `authStore.ts` already imported
`nowIso`/`Row` from it). All three call sites now import and call the shared
helper; no call-site behavior changed (`raw.toLowerCase().trim()`,
byte-for-byte identical to all three prior copies). Existing tests
(`authStore.int.test.ts`'s `authListUsersByEmailNorm` cases, and the
router-level invite/sign-in tests) were left unmodified and stayed green,
pinning the preserved semantics.

### 3. `AppShell.tsx:173` `useOptionalChain` warning

`profile.auth.user !== null && profile.auth.user.teams.length === 0`
rewritten to `profile.auth.user?.teams.length === 0`. Verified equivalence
by case analysis (undefined/null-user cases both fall through to falsy
either way) and confirmed by `npm run typecheck` + the full web test suite
staying green. Running `npm run lint` (which invokes `biome check --write`
for the web workspace) then surfaced a *second*, previously-masked
`useOptionalChain` opportunity on the same statement — the outer `profile
!== undefined && profile.auth.logged_in` guard — once the inner one was
fixed. Applied biome's own suggested unsafe fix
(`profile?.auth.logged_in && profile.auth.user?.teams.length === 0`),
re-verified equivalence (TypeScript's control-flow narrowing correctly
narrows `profile` on the right side of `&&` given the left side's optional
chain — confirmed by a clean `tsc --noEmit`) and re-ran the full test suite.
Final state: `npm run lint` reports exactly 4 warnings, all pre-existing
(`TopicsRow.tsx:74` `noFocusedTests`, three `loadingVideo.ts`
`useOptionalChain` warnings) and untouched by this branch.

### 4. Dead `AuthStore.authDeleteAllInvitesForTeam`

Grepped for all references before removing: only its own definition
(`server/src/db/authStore.ts`) and its dedicated int-test block
(`server/src/db/authStore.int.test.ts`, `'authDeleteAllInvitesForTeam
cascades every invite for a team, leaves other teams alone'`). No caller in
`server/src/studio.ts` or elsewhere — `StudioRegistry`'s delete-team cascade
was inlined separately rather than calling through this method, making it
production-dead. Removed both the method and its test block. Grepped again
post-removal: zero remaining references anywhere in the repo.

### 5. `TeamsRoute.tsx` `BUILTIN_TEAM_IDS` provenance comment

Extended the comment above `const BUILTIN_TEAM_IDS = ['test-studios',
'test-studio-2']` with a source-of-truth pointer: "Mirrors
`BUILTIN_STUDIO_ORDER` in `server/src/studio.ts` — extend both if a third
built-in lands." (verified `BUILTIN_STUDIO_ORDER` is in fact defined there,
same two ids, same order).

## Gate results (post-fix)

- `npm run typecheck` — **green** (server + web + companion + `tsc --noEmit
  -p e2e`).
- `npm test` — **green**: server 334/334, web 157/157, companion 20/20.
- `npm run lint` — **4 warnings** (pre-existing: `TopicsRow.tsx` focused-test
  lint, 3× `loadingVideo.ts` optional-chain; the branch's own
  `AppShell.tsx:173` warning is now resolved).
- `npm run e2e` (project chromium) — **8/8 passed**.
- `npx playwright test --project=login-gate` — **5/5 passed**.

## Files changed this round

- `README.md` — added `account_disabled` to the `login_error` enumeration.
- `server/src/db/shared.ts` — new exported `normalizeEmail`.
- `server/src/routers/auth.ts` — import shared `normalizeEmail`, drop local
  copy + its stale "out of scope" comment.
- `server/src/routers/teams.ts` — import shared `normalizeEmail`, drop local
  copy.
- `server/src/db/authStore.ts` — `authListUsersByEmailNorm` now calls the
  shared `normalizeEmail`; removed dead `authDeleteAllInvitesForTeam`.
- `server/src/db/authStore.int.test.ts` — removed the
  `authDeleteAllInvitesForTeam` test block (assertions for surviving methods
  untouched).
- `web/src/pages/index/AppShell.tsx` — `needsOnboarding` collapsed to
  optional chains (both layers).
- `web/src/pages/index/components/TeamsRoute.tsx` — extended
  `BUILTIN_TEAM_IDS` comment with the `BUILTIN_STUDIO_ORDER` cross-reference.
- `openspec/changes/teams-self-serve/tasks.md` — 8.2 ticked.

## Concerns / notes for the reviewer

- None blocking. The AppShell optional-chain fix ended up two layers deep
  rather than one (finding 3 as literally described), because fixing the
  inner chain revealed a second, previously-masked lint opportunity on the
  same line — both are verified type-equivalent to the original four-clause
  `&&` chain and covered by the existing (unmodified) test suite.
