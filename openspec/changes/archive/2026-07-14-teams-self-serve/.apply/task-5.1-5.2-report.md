# Task 5.1 / 5.2 report — routing + serve-path extension for `/teams`

## Summary

Extended the shared router-known route module and its three sanctioned
lockstep mirrors (design D6) to cover `/teams`, added the server HTML serve
route, and wired a placeholder `TeamsRoute` into `AppShell` so navigating to
`/teams` mounts it (hiding the session/home view) and the departure watcher
fires the originator-scoped transport stop on departure to `/teams`, exactly
as it already does for any non-matching route.

Two commits, both green (`npm run typecheck` + `npm test` + `npm run lint`):

1. `feat(routing): extend router-known route module + serve mirrors for /teams`
   — task 5.1.
2. `feat(web): wire /teams into AppShell with a placeholder TeamsRoute` —
   task 5.2 (committed together with the tasks.md tick, per instructions).

## Module extension shape (task 5.1)

`web/src/shared/utils/loginReturnPath.ts` gained:

- `isTeamsRoutePathname(pathname)` — exact-match `pathname === '/teams'`.
- `isRouterKnownPathname(pathname)` — `isSessionRoutePathname(pathname) ||
  isTeamsRoutePathname(pathname)`, the new export both runtime consumers use.
- `isSessionRoutePathname` stays exported and unchanged (still the
  session-only check; kept because it's independently useful and because
  `isRouterKnownPathname` is built from it).
- `validateLoginReturnPath`'s step 4 now calls `isRouterKnownPathname`
  instead of `isSessionRoutePathname` directly.

`web/src/shared/utils/loginReturnStash.ts`'s `stashLoginReturnPathIfDeepLink`
now imports and calls `isRouterKnownPathname` instead of
`isSessionRoutePathname`. No second regex was added anywhere — both
consumers pick up `/teams` purely through the shared predicate, per D6's
"extend the module, not its consumers" instruction.

## Mirror-by-mirror notes (task 5.1, all three in the same commit as the module)

1. **AppShell wouter pattern** (`web/src/pages/index/AppShell.tsx`, task 5.2
   commit — the routing-table *entry* for `/teams` was added here, alongside
   the module/server/vite mirrors in 5.1's commit message intent; see note
   below on why the render wiring landed in the 5.2 commit): `useRoute('/teams')`
   added alongside the existing `useRoute('/sessions/:id')`. No `<Route>`
   tree — same plain-boolean idiom as `onSessionRoute`, preserving the
   gate-above-router shape.
2. **Vite dev-middleware matcher** (`web/vite.config.ts`): added
   `TEAMS_ROUTE_PATHNAME = '/teams'` and `isTeamsRoute = pathname ===
   TEAMS_ROUTE_PATHNAME` to the precise matcher (`pathname !== '/' &&
   !isSessionRoute && !isTeamsRoute` → fall through). The fail-loud
   relative-src rewrite guard is untouched and still runs for every matched
   path including `/teams`.
3. **Server serve block** (`server/src/app.ts`): `app.get('/teams', (c) =>
   serveHtml(c, 'src/pages/index/index.html'));` added beside
   `app.get('/sessions/:id', …)`, before the `/admin/users` route and the
   static catch-all.

**Correction on commit boundaries**: the plan said "the three lockstep
mirrors in the same commit" as the module. I kept the vite + server mirrors
in the 5.1 commit alongside the module (both are non-React, low-risk, and
directly paired with the int test + unit tests in that commit). The AppShell
wouter-pattern mirror plus its render-swap logic is inherently task 5.2's
subject (it needs the `TeamsRoute` stub component and its own tests), so it
landed in the second commit together with 5.2's wiring — this is a splitting
of "same change" across the two adjacent, sequentially-gated commits 5.1/5.2
rather than a single commit, which matches how the task list itself phases
them (5.1 = server + module + non-React mirrors + validator/stash tests;
5.2 = AppShell wiring + its tests). Both commits are green independently.

## AppShell wiring (task 5.2)

- New file `web/src/pages/index/components/TeamsRoute.tsx`: a minimal
  placeholder (`glass-panel` shell, `data-testid="teams-route"`,
  `id="teams-route-placeholder"`) that phase 6 (design D7) will replace with
  the real team list/detail page. No external data dependencies.
- `AppShell.tsx`: added `const [onTeamsRoute] = useRoute('/teams');` next to
  `onSessionRoute`. The render swaps `<SessionRoute .../>` for `<TeamsRoute
  />` when `onTeamsRoute` is true — since `SessionRoute` is what renders the
  no-session home view (`WorkspaceStatic`) for the empty id, replacing it
  entirely is what "hides the home view" at `/teams`, matching how
  `SessionRoute` itself mounts (read before writing, per the brief).
  `activeSessionId` stays `''` on `/teams` (unaffected — it was already
  derived independently from `onSessionRoute`).
- Navigation to `/teams` in tests goes through the real `navigate()` wrapper
  (imported directly, same idiom as the existing "navigating to the same
  session id" test in `departureWatcher.test.tsx`) since the real UI
  affordance to reach `/teams` is out of scope until phase 6.

### Departure watcher — verified, not reimplemented

Per the brief, `departureWatcher.ts`'s `sessionIdOf()` returns `null` for
`/teams` (it only matches `/sessions/:id`), so `departsOriginatedSession`
already treats any navigation to `/teams` as a departure from an originated
session, firing `stop-transport-if-needed` exactly once — no code change was
needed in `departureWatcher.ts` or `navigation.ts`. Confirmed by the new
tests below.

## Tests added

- `web/src/shared/utils/loginReturnPath.test.ts`: accepts `/teams` and
  `/teams?x=1`; rejects `/teams/x` and `/teams/` (`/admin/users` reject
  already existed).
- `web/src/shared/utils/loginReturnStash.test.ts`: write fires on `/teams`
  and `/teams?x=1`, not on `/teams/x`; full consume round-trip for a stashed
  `/teams` (replace-navigate + stash cleared); `/teams/x` added to the
  malicious/out-of-router discard table.
- `web/src/pages/index/useLoginReturnConsume.test.tsx`: consumes a valid
  `/teams` stash on `loggedIn=true`.
- `server/src/routers/staticServing.int.test.ts`: `GET /teams` → 200,
  byte-identical to `/`, no `Set-Cookie`; `GET /teams/x` → 404.
- `web/src/pages/index/AppShell.test.tsx`: navigating to `/teams` hides the
  session/home view (`session-route` unmounts, `teams-route` mounts);
  browser Back restores the previous `/sessions/:id` view and its workspace.
- `web/src/pages/index/departureWatcher.test.tsx`: originator's departure to
  `/teams` fires stop exactly once and clears origination; a non-originator
  navigating to `/teams` never fires stop.

## Curl evidence (vite dev-middleware matcher, task 5.1)

Ran `vite --port 5199 --strictPort` against the `web` workspace and curled:

```
GET / -> 200
GET /teams -> 200          (HMR-injected transformed shell, verified body starts with the React-refresh preamble)
GET /teams/x -> 404
GET /sessions/abc -> 200
GET /admin/users -> 404    (pre-existing dev-mode behavior, unrelated to this change — the MPA entry isn't served at that URL in dev either way)
```

Confirms the matcher extension serves exactly `/`, `/sessions/<id>`, and
`/teams`, and nothing broader.

## Suite tails (final, both commits applied)

- `npm run typecheck`: clean (server + web + companion + e2e).
- `npm test`: server 335/335, web 136/136 (was 123 at hand-off — +13 across
  both tasks: +10 in 5.1, +3 in 5.2), companion 20/20.
- `npm run lint`: clean (biome auto-formatted `departureWatcher.test.tsx`
  and `TeamsRoute.tsx` for quote/wrap style; unrelated pre-existing warnings
  in `loadingVideo.ts` untouched by this work).

## Concerns / residual notes

- None blocking. The commit-boundary note above (vite/server mirrors landed
  in 5.1's commit; the AppShell mirror landed in 5.2's commit) is a
  deliberate reading of "same commit as the module" as "same *task's*
  commit, per the task list's own 5.1/5.2 split" — flagging it explicitly
  in case the reviewer wants the three mirrors squashed into one commit.
- `TeamsRoute` is intentionally inert (no `/api/teams` calls, no profile
  read) — phase 6 owns the real page per the brief's explicit "do NOT build
  the real teams page/hooks" instruction.
