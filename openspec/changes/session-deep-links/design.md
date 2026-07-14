## Context

The active session is component state: `AppShell` holds `activeSessionId` in a
`useState` and fans it out into `body.dataset.sessionId`, `window.V3_selectSession` /
`window.V3_closeSession` globals (one in-app caller: `HomeSettingsModal`'s
studio-switch branch of its save handler), imperative `syncChrome()` class-toggling
(which owns the `#v3-session-placeholder` ↔ `#v3-session-grid` visibility swap and the
no-session title reset), and the `WorkspaceStatic sessionId` prop. Nothing is
URL-addressed; reload loses the session; Back/Forward do nothing. The archived
add-login-screen change built `RootGate` as a self-contained render switch explicitly
so it could relocate above a future router, and deferred post-login redirect-back to
this change because there was no URL-addressed state worth returning to.

Server side, static hosting is three explicit lines in `server/src/app.ts` (`/` →
index HTML, `/admin/users` → admin HTML, `*` → static assets); the HTTP contract is
frozen, so both new routes ship with an authorizing delta spec
(`specs/api-contract-freeze/spec.md`). A load-bearing scoping fact (panel finding S1):
`GET /api/sessions` returns only the user's **active show's** sessions
(per-user `active_show_id` pref within their active studio), while the per-session
routes authorize on **studio membership** (`requireSession`) — the list is a view
preference, not an authorization boundary, and therefore cannot be the deep-link
resolution source.

Constraints inherited from explore (2026-07-14, recorded in the roadmap memory and the
add-login-screen design):

- Deep-linkable sessions are the goal; the router is the enabler.
- The login gate stays a render switch ABOVE the router; never a `/login` route.
- `/admin/users` stays a separate MPA entry (owner decision, option 1: the admin page
  is the support back door when OAuth is broken; putting it under the login gate would
  put the back door behind the front door).
- Explicit `GET /sessions/:id` HTML route, not a catch-all — unknown paths keep 404ing.

## Goals / Non-Goals

**Goals:**

- `/sessions/:id` as a shareable, reloadable address for a session — resolving for any
  authorized session, not just the viewer's active show; `/` as the no-session home.
  Back/Forward as first-class state transitions.
- Retire the dataset/window-global selection spine.
- Post-login return to the deep link, hardened against open-redirect bypasses.
- A minimal `web/` vitest tier (validator, resolution states, RootGate scenarios).

**Non-Goals:**

- Folding `/admin/users` into the router (owner decision — separate MPA entry stays).
- Read-only workspace for archived sessions (interstitial only).
- Server-side `?next=`, callback changes, or any server surface beyond the two
  authorized additions. No URL state beyond the session id.
- Widening or rescoping the `GET /api/sessions` list (its active-show scope is
  home-view behavior, unchanged).

## Decisions

### D1 — Router: wouter, render-side only

**Decision:** Use `wouter` (hook-based, ~2 kB; verified compatible with the installed
React 19, no provider needed for browser history, `wouter/memory-location` available
for tests). The "route table" is `useRoute('/sessions/:id')` + `useLocation` inside
`AppShell`; there is no route config object and no nested-router machinery.

**Division of labor (panel S8):** wouter drives *rendering* — param extraction and
re-render on location change. It is deliberately NOT the mechanism for the departure
watcher (D4): navigation side-effects hang off the navigation wrapper + `popstate`
listener, which fire synchronously before React commits. One source of truth per
concern; wouter's hook timing is never load-bearing for transport correctness.

**Alternatives considered:**
- *react-router* — dominant but heavy; its data-loading APIs fight react-query, which
  owns all fetching here. Overkill for two routes.
- *TanStack Router* — type-safe route trees are attractive but a large dependency and a
  new idiom for a two-route app.
- *Hand-rolled `popstate` module (~40 lines), no dependency* — genuinely viable here
  (the panel's scope reviewer preferred it), since D4 forces us to own a navigation
  wrapper anyway. Kept wouter regardless: tested param matching, memory-location for
  unit tests, and familiar idiom outweigh one small dependency; the D4 wrapper stays
  either way, so switching later is cheap.

### D2 — Gate stays above; the router lives inside AppShell

**Decision:** `main.tsx → RootGate → AppShell` is unchanged as a component chain.
`RootGate` relocates verbatim (it already owns its `useProfile()`); `AppShell` swaps
`useState('')` for the route param. `WorkspaceStatic`/`SessionWorkspace` keep their
`sessionId` prop shape. There is deliberately no `<Route>` tree — the gate must keep
covering every URL without per-route wiring, and wouter's hooks make route-derived
state a one-line read.

**Invariant a future reader might "helpfully" undo:** do NOT convert `LoginPage` into a
`/login` route or move the gate below the router. The gate-above-router shape is what
guarantees a future route can't be added un-gated, and it's what keeps the anonymous
deep-link URL intact for the post-login return.

### D3 — History semantics: push on select, push on close, no-op on re-select

**Decision:** Selecting a session pushes `/sessions/:id`; selecting the already-active
session is a no-op (the session cards fire `onSelect` unguarded — without the no-op,
each click would stack a duplicate entry and make Back appear dead); the close control
and the studio-switch close path push `/`; session creation navigates like selection.
Back from a session therefore returns home, and Back again leaves the app — plain
browser semantics, no history rewriting. The only `replace` navigation is the
post-login stash return (no intermediate `/` entry). The archived-interstitial Restore
action stays on the same URL and navigates nowhere.

**Alternative considered:** `history.back()` for the close control (symmetric with how
the entry was pushed) — rejected: close must work deterministically even when the
session URL was the first entry (deep-link landing), where `back()` would exit the app.

### D4 — Transport-stop: originator-scoped, via a navigation-wrapper subscription

**Gate decision (2026-07-14):** the departure stop is **originator-scoped**. The
client tracks (in plain component/module state, set by the transport-start action)
whether *it* started the current roll during this workspace mount. On a same-document
departure from `/sessions/:id` (close, Back/Forward, switch to another id), the
watcher fires `window.AutoLogger_stopTransportIfNeeded?.()` only if that flag is set —
exactly once per departure. Clients that arrived at an already-rolling session never
stop it.

**Why originator-scoped (not "any departure stops", not behavior-preserving):** the
panel's failure review showed the stop global arms for ANY client that can see
`is_rolling` (the `blocksMedia` guard covers only the audio-recording lease, not a
plain roll), so with shareable URLs every leave-means-stop rule turns a passive viewer's
Back press into a kill switch for another operator's roll. Originator-scoping
eliminates that class entirely while preserving the rule's original intent — don't
accidentally leave *your own* roll running. Accepted behavior change vs. today: the
close control no longer stops a roll started by another client (the panel judged
today's behavior a multi-client footgun, and the gate concurred).

**Mechanism:** the stop call hangs off the navigation wrapper (all in-app navigations
go through one `navigate()` helper) plus a raw `popstate` listener — both fire
synchronously before React re-renders, so the call happens before `SessionWorkspace`'s
effects clear or redefine the global for the incoming route. Not an unmount/effect
cleanup: cleanups run child-first (the global would already be cleared) and StrictMode
double-invokes them in dev (which would stop a remotely-rolling session on mount).
wouter is not involved (D1).

**Scope limits (accepted residuals):** cross-document departures — tab close,
navigation to another origin, Back off a deep-link landing that is the first history
entry — fire no same-document event and are out of scope (no pagehide/sendBeacon
machinery). Additionally, the global is undefined while `blocksMedia` is true and for
roughly one status-fetch after deep-linking into a rolling session; both windows only
suppress a stop, never cause one, and matter even less under originator-scoping.

### D5 — Deep-link resolution: per-id query against the new detail endpoint

**Gate decision (2026-07-14, resolving panel blocker S1):** resolution uses a new
`GET /api/sessions/:id` endpoint (second authorized addition) — NOT the polled
sessions list. The list is active-show-scoped while authorization is studio-wide, so
list-based resolution would render "not found" for authorized sessions whenever the
viewer's active show/studio differs — breaking exactly the share-a-link scenario that
motivates the change (and the author's own bookmarks after a show switch).

**Server shape:** the endpoint reuses the list serializer (shape parity by
construction) and the existing `requireSession` authorization (studio membership,
masked 404 for nonexistent / deleted / unauthorized alike). Archived sessions resolve
`200` with their archived state. Additive; the list route is untouched.

**Client shape:** a `useSession(id)` react-query hook, fetched on route entry, **no
polling** — which makes resolution *latched* by construction: loading → workspace /
archived interstitial / not-found (404) / retryable error (non-404; never presented as
"not found"). Restore invalidates the per-id query, so the same URL re-resolves to the
workspace with no navigation. An open workspace is never evicted by background list
changes (remote archive, show switch) — the panel showed the live-resolution reading
would tear down working sessions mid-use.

The latch is a **within-mount guarantee only**: every fresh route entry re-resolves
against the server (`gcTime: 0` — no unmounted cache reuse; phase-4 review finding,
2026-07-14). Do NOT "optimize" this by letting a cached resolution serve a re-entry:
that reintroduces a stale window where a remotely archived/deleted session renders
its prior state.

**Bonus dissolutions:** the per-id fetch also removes the create→navigate not-found
flash (the id the server just returned resolves immediately, no stale-list window) and
the 5-second-staleness caveat the earlier list-based design carried.

**Alternatives considered:**
- *List-based resolution* (the pre-panel design) — rejected: built on the false
  "team-scoped" premise above.
- *Status-probe fallback* (`/sessions/:id/status` for ids missing from the list) — no
  new surface, but returns no title/archived flag, leaving out-of-scope sessions a
  degraded second-class state.
- *Widening the list to studio-wide* — changes frozen list semantics everywhere the
  home view consumes it; far larger observable change than the feature needs.

**Interstitial altitude (panel trim):** the normative requirements are behavioral —
archived ≠ live workspace, Restore available and re-resolving in place, not-found
indistinguishable across denial causes, error ≠ not-found. Visual composition (badge,
copy, back-link placement) is implementation freedom, consistent with D9's stance on
titles.

### D6 — Post-login return: route-scoped sessionStorage stash + strict validator

**Decision:** All three LoginPage affordances (sign-in, create-account, error-retry)
remain plain anchors to `/auth/google/start` — the existing login-gate e2e asserts
those `href`s — with a synchronous `onClick` stash write riding the activation: stash
the current path+query **iff the current location matches `/sessions/:id`**; otherwise
leave any existing stash alone. This one rule replaces the earlier strip-`login_error`
/ keep-when-`/` special-casing (panel simplification): error landings live at `/`, so
retries can never clobber a stashed deep link, and all three anchors get identical
treatment. The consume effect runs when the app renders with `auth.logged_in === true`
— checked explicitly, NOT inferred from AppShell mounting (dev anonymous mode mounts
AppShell with `logged_in: false` and must never consume) — validates, then
`replace`-navigates via the client router; the stash is cleared on every exit path
(valid, invalid, or navigation throw): single-use.

Validator in `web/src/shared/utils/` — URL-parse based, per the add-login-screen panel
recipe, verified against the bypass corpus by this change's panel: must be a string
starting with exactly one `/`, no `\` (WHATWG parses `/\` as `//`), no ASCII control
chars (a tab inside `//` reassembles a protocol-relative URL), and
`new URL(value, origin).origin === origin`; additionally the pathname must match a
router-known route (`/sessions/:id`) — same-origin non-router pages like
`/admin/users` are not return targets (avoids an SPA "navigation" to a URL the router
doesn't own, which would render the home view under a lying address bar).
Reject-by-default.

**Alternative considered:** server-side `?next=` on `/auth/google/start` threaded
through the OAuth state — rejected: touches the frozen callback success path
(`302 /`), adds a server-side open-redirect surface to defend, and was explicitly
declared out in add-login-screen. The client-side stash needs no contract delta at
all.

**Why sessionStorage (not localStorage):** per-tab, evaporates with the tab — a stale
return path can't ambush a sign-in days later in another tab. Accepted residuals:
middle-click/open-in-new-tab sign-in bypasses the stash (the new tab has its own
sessionStorage — the return silently doesn't happen), and an abandoned-attempt stash
can redirect the next logged-in boot *in that same tab* (bounded by tab lifetime and
the router-known-path constraint).

### D7 — Server routes + dev-server parity

**Decision:** `app.get('/sessions/:id', (c) => serveHtml(c, 'src/pages/index/index.html'))`
alongside the existing `/` route (verified empirically on the installed Hono: `:id`
matches exactly one segment; `/sessions`, `/sessions/`, `/sessions/a/b` fall through
to the static handler and keep 404ing; an encoded `/sessions/a%2Fb` is one raw segment
and serves the shell — the integration test must not assert 404 for it). The
serve-block comment ("no client-side router") is updated. The detail endpoint lands in
`server/src/routers/sessions.ts` beside the other `/api/sessions/:sessionId/*` routes,
reusing their auth helper and the list serializer.

For dev: a small Vite dev-only middleware serves the index entry for exactly `/` and
`/sessions/<single-segment>` — a precise matcher, NOT a "anything that isn't a file"
fallback, so `/admin/users` (separate MPA entry), the `/api` + `/auth` proxies, and
`/@vite/*`, `/src/*`, `/assets` HMR/asset requests are untouched. The middleware must
return `server.transformIndexHtml(...)` output, not raw file bytes — the source HTML
references `./main.tsx` relatively, and raw bytes served at `/sessions/abc` would
resolve it to `/sessions/main.tsx` and dead-app (panel finding). Deep links are then
exercisable at :5173 with HMR; README dev instructions change from the raw entry path
to `http://127.0.0.1:5173/`. Build output and the production serve path are unaffected.

**Alternative considered:** dev deep links only via :8787 (production serve path) —
rejected as primary DX: it forfeits HMR exactly on the flows this change is about.

### D8 — web vitest tier: minimal, jsdom, colocated

**Decision:** Add a `web/vitest.config.ts` (jsdom environment, `@testing-library/react`,
colocated `*.test.ts(x)` under `web/src/`; vitest 4 / vite 8 compatibility verified),
a `test` script in `web/package.json`, and extend the root `test` script to include
`-w web`. Scope of the initial suite: the return-path validator (including every
bypass case in the spec), deep-link resolution states, the stash write/consume rules,
originator-scoped departure logic, and RootGate's four gate states (paying down the
accepted add-login-screen residual). Test renders run under StrictMode. This is a test
*tier*, not a coverage campaign — no snapshot infrastructure, no visual tooling.

**Alternative considered:** piggyback web tests on the server vitest workspace —
rejected: different environment (jsdom vs node), different deps, and the server
workspace's unit/integration split is meaningful there and noise here.

### D9 — syncChrome's two observable behaviors move into rendering

`syncChrome()` owns two things (not one — corrected per panel finding S5): the
`#v3-session-placeholder` ↔ `#v3-session-grid` visibility swap (the placeholder is
statically visible and the grid statically `hidden` in `SessionWorkspace`'s JSX;
`syncChrome` is today the ONLY thing that reveals the workspace), and the
`document.title` reset to "AutoLogger" when no session is active. Both move to
route-driven conditional rendering/effects. Two existing e2e assertions watch the swap
(`smoke.spec.ts` and `visual.spec.ts` assert `#v3-session-grid` visibility) and must
stay green. Title format itself stays out of the spec — not frozen surface; the
visibility swap is covered by a scenario because e2e already treats it as observable.

## Risks / Trade-offs

- **[Originator flag lives in client memory]** → a reload mid-roll forgets that this
  client started the roll, so its later departure won't auto-stop. Accepted: failing
  *safe* (a missed auto-stop) beats failing destructive (stopping someone else's
  roll); the transport controls remain available.
- **[Navigation-wrapper discipline]** → the departure watcher only sees navigations
  that go through the wrapper (plus popstate). Any future code calling
  `history.pushState` directly bypasses it. Mitigation: the wrapper is the only
  exported navigation API in the codebase; review holds that line.
- **[Per-id endpoint is new frozen surface]** → one more row that can never change
  shape. Mitigated by construction: it reuses the list serializer, so shape drift
  between list entries and the detail response is impossible without touching both.
- **[Stale e2e/dev muscle memory]** → the dev URL changes from the raw entry path to
  `/`; README and onboarding notes move in the same change.
- **[StrictMode double-mount]** → D4's subscription design sidesteps it; any *new*
  effect touching transport or stash must be StrictMode-safe; the web vitest tier
  renders under StrictMode to keep this honest.

## Migration Plan

Single deploy, no data migration, no config change. Rollback = revert the branch: both
server routes are additive (old clients never request them), the stash key is inert to
the old bundle, and retiring the dataset spine only affects the e2e assertion updated
in the same change. Stale bookmarks from a rollback (`/sessions/:id` URLs) would 404
against a reverted server — accepted, matches pre-change behavior.

## Open Questions

- None. Both panel escalations were dispositioned at the gate (see log).

## Panel & review log

### 2026-07-14 — Adversarial panel (4 reviewers: requirements, assumptions, failure & abuse, scope) + gate

**Blockers/majors fixed in place:**

- **S1 (Blocker, found independently by requirements + assumptions):** resolution
  design rested on a verified-false premise — `GET /api/sessions` is active-show-scoped
  (`listSessionsForShow(activeShowId)`), not team-scoped, while `requireSession`
  authorizes studio-wide; shared links would render "not found" for authorized
  teammates. *Escalated to gate; decision: add `GET /api/sessions/:id` (second
  authorized delta).* Folded into the proposal, both ADDED requirements of the
  api-contract-freeze delta, the web-session-routing delta, D5, and tasks.
- **S2 (Major, failure&abuse + scope):** every leave-means-stop rule makes shared
  rolling-session links a passive-viewer kill switch (the `blocksMedia` guard covers
  only the audio lease, not plain roll); the original "unification is the only
  coherent rule" framing was wrong (a behavior-preserving rule of equal complexity
  exists). *Escalated to gate; decision: originator-scoped stop.* D4 + spec rewritten;
  close-button multi-client behavior change accepted as fixing an existing footgun.
- **S3 (Major, requirements):** create→navigate mandated a not-found flash against the
  stale list on the app's most common entry flow. Dissolved by the S1 ruling (per-id
  fetch resolves a just-created id immediately); explicit scenario added.
- **S4 (Major, requirements):** latched-vs-live resolution was unspecified; the live
  reading evicts open workspaces on remote archive/show switch. Fixed: resolution is
  normatively latched (no-poll per-id query); eviction scenario added.
- **S5 (Major, assumptions + requirements):** D9 falsely claimed `syncChrome` was
  title-only — it owns the placeholder↔grid reveal, and two e2e specs assert on it;
  task 3.2 as written would have shipped a never-visible workspace. D9/spec/tasks
  corrected.
- **S6 (Major, assumptions):** "stop regardless of cause" over-promised — cross-document
  departures fire no popstate. Requirement scoped to same-document departures;
  cross-document exits recorded as residuals.
- **S7 (Major, three reviewers):** no resolution state for a failed query — eternal
  spinner or a lying "not found" on transient errors. Fixed: fifth (retryable error)
  state, normatively distinct from not-found.
- **S8 (Major, scope):** wouter's hook + a separate watcher = two location
  subscriptions with an ordering risk and mid-implementation contingency language.
  Fixed: single-mechanism invariant (navigation wrapper + popstate own side-effects;
  wouter is render-side only); contingency language deleted.
- Minors fixed in place: route-scoped stash rule replacing two special cases (also
  covers the previously unspecified error-retry anchor); stash targets constrained to
  router-known paths (`/admin/users` excluded); consume keyed on `logged_in === true`,
  not AppShell mount; anchors keep their `href`s (login-gate e2e asserts them) with
  stash on click; single-use stash enforced on all exit paths; duplicate-history no-op
  on re-select; settings-modal scenario corrected to the real caller (studio-switch
  branch — no delete/close flow exists); unmatched-path SHALL demoted to a
  non-normative note with corrected rationale; interstitial/not-found affordances
  trimmed to behavioral altitude; Vite middleware precision + `transformIndexHtml`
  requirements; encoded-`%2F` id note for integration tests; e2e impact section names
  the `#v3-session-grid` assertions and the anonymous-deep-link URL test.

**Escalated to the gate (owner decisions, 2026-07-14):**

- S1 resolution source → **new `GET /api/sessions/:id` detail endpoint** (over: keep
  list + scope the feature; status-probe fallback; widen the list).
- S2 departure-stop rule → **originator-scoped** (over: behavior-preserving
  non-session-route rule; unified-stop as originally specced; no auto-stop).

**Minors accepted as residual:**

- Middle-click/new-tab sign-in bypasses the per-tab stash (return silently skipped).
- Abandoned-attempt stash may redirect the next logged-in boot in the same tab
  (bounded: per-tab, router-known paths only).
- Cross-document departures (tab close, external nav, Back off a first-entry deep
  link) never fire the departure stop.
- Deep-linking into a rolling session leaves a ~1-fetch window where the stop global
  is undefined; `blocksMedia` windows likewise suppress (never cause) a stop — both
  moot under originator-scoping unless the originator reloads mid-roll (see Risks).
- `/sessions/..`-style paths URL-normalize to `/` (200 home, harmless);
  `/sessions/a%2Fb` serves the shell and client-side resolves to not-found.
- Roadmap memory's "admin folded in as a route" line is superseded by the option-1
  decision; memory updated alongside this change.

### 2026-07-14 — Post-gate consistency read (light-tier, single reviewer)

One fix-needed finding, corrected in place: the HTML-route requirement in the
api-contract-freeze delta still said session resolution rides "the existing
`GET /api/sessions` surface" — stale pre-S1 language contradicting the sibling
detail-endpoint requirement; now points at `GET /api/sessions/:id`. Two cosmetic
fixes: log wording ("both server-facing specs" → the actual artifact list) and an
explicit test line in task 3.3 for the "Studio-switch close path still works"
scenario. All other checks passed: no surviving pre-decision language, all S1–S8
dispositions match their normative sections, D1–D9 references resolve, every delta
scenario has covering tasks, and the MODIFIED requirement header is byte-identical to
the baseline with all baseline scenarios carried forward.

**Defenses verified by the panel (no action):** redirect-validator recipe survives the
full bypass corpus (`\` and control-char rejections each load-bearing); Hono `:id`
matching verified empirically on the installed version; no existence oracle in the
HTML route (no `Set-Cookie`, uniform body); arbitrary ids cannot drive per-session
fetches (resolution gates the workspace mount); stash abuse contained by same-origin
storage + validator; wouter/React 19, vitest 4/vite 8, `wouter/memory-location`, and
`base:'/'` absolute assets all verified; not-found page's 5 s polling is the home
view's existing behavior, foreground-only.
