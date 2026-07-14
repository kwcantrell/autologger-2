## Why

A session in AutoLogger has no address: the active session lives in a `useState` in
`AppShell`, mirrored into `body.dataset.sessionId`, `window.V3_selectSession`/`V3_closeSession`
globals, and imperative `syncChrome()` DOM toggling. Nothing survives a reload, nothing can
be bookmarked or pasted into a chat, and browser Back/Forward do nothing. The archived
add-login-screen change deliberately deferred post-login redirect-back because "the app has
no URL-addressed state" — this change creates that state. Deep-linkable sessions are the
goal; the SPA router is the enabler.

## What Changes

- **Client-side router with two app routes.** `/` (no session selected) and
  `/sessions/:id` (the point of the change). The active session id moves from `AppShell`
  state into the URL; selecting a session pushes a history entry, closing it navigates
  back to `/`, and browser Back/Forward drive the same state transitions.
- **Login gate relocation, unchanged.** `RootGate` stays a render switch ABOVE the router
  (there is never a `/login` route) — it was built as a self-contained wrapper precisely
  so it relocates verbatim and keeps covering every current and future URL.
- **Two narrow server deltas (authorized).** (1) An explicit `GET /sessions/:id` HTML
  route serving the SPA index page — NOT a generic catch-all; unknown paths keep 404ing
  via the existing static handler. The route serves the shell regardless of whether the
  session exists or the visitor may see it (existence is never leaked at the HTML
  layer). (2) A `GET /api/sessions/:id` detail endpoint (panel finding S1, gate
  decision 2026-07-14): the sessions *list* is scoped to the user's active show, while
  per-session authorization is studio-wide — so list-based resolution would tell
  authorized teammates a shared session doesn't exist. The detail endpoint returns the
  same JSON shape as a list entry, 404-masked identically for nonexistent, deleted,
  and unauthorized ids.
- **Deep-link resolution states, client-side.** The client resolves `:id` with a
  per-id query against the new detail endpoint: loading → workspace (active) /
  archived interstitial (with the existing Restore affordance — not a read-only
  workspace) / not-found-doubles-as-access-denied (404, preserving the server's
  masking) / retryable error (non-404 failure, never presented as "not found").
  Resolution is latched — an open workspace is never evicted by background list
  changes.
- **Originator-scoped transport-stop on route departure** (gate decision 2026-07-14).
  Today `AutoLogger_stopTransportIfNeeded` runs only through the close-session click
  handlers. With shareable URLs, any leave-means-stop rule would let a passive viewer
  of a rolling session kill the roll by pressing Back — so the departure stop fires
  only for the client that started the roll during this workspace mount, on any
  same-document departure (close, Back/Forward, session switch). Passive viewers never
  stop a roll; the multi-client close-button footgun (closing stops a roll started
  elsewhere) goes away with it.
- **Legacy spine retired.** `body.dataset.sessionId`, `window.V3_selectSession`,
  `window.V3_closeSession`, and `syncChrome()` are removed; the only external reader (one
  e2e assertion) switches to asserting on the URL.
- **Post-login redirect-back, client-side.** The login page stashes the current path
  before handing off to `/auth/google/start`; after the (frozen, unchanged) callback
  `302 /`, the authenticated boot validates the stashed path with a hardened same-origin
  URL-parse validator (reject `\`, control characters, protocol-relative `//` and
  `/\evil.com`-style bypasses) and replace-navigates to it. No server-side `?next=`.
- **Minimal web vitest tier.** `web/` gains a vitest setup sufficient to unit-test the
  redirect validator (including bypass cases), the deep-link resolution states, and
  `RootGate`'s currently-untestable gate scenarios — an accepted residual of
  add-login-screen that this change pays down.

## Capabilities

### New Capabilities

- `web-session-routing`: the frontend's URL-addressed session state — route table
  (`/`, `/sessions/:id`), history semantics (push on select, Back/Forward as first-class
  state transitions, originator-scoped transport-stop on route departure), deep-link
  resolution states (loading, workspace, archived interstitial,
  not-found-doubles-as-access-denied, retryable error; latched once mounted), and
  retirement of the dataset/window-global spine.

### Modified Capabilities

- `api-contract-freeze`: authorizes exactly two observable additions — (1)
  `GET /sessions/:id` (single non-empty path segment) responds `200` with the SPA index
  HTML, unconditionally on session existence and authorization; (2)
  `GET /api/sessions/:id` responds with a list-entry-shaped session object for
  authorized requests regardless of active-show/studio preferences and archived state,
  and a masked `404` for nonexistent, deleted, and unauthorized ids alike. All other
  surface keeps its current behavior; no other `/api/*`, `/auth/*`, or WS changes.
- `web-login-experience`: the login gate now covers every route (an anonymous visit to
  `/sessions/:id` renders the login page at that URL), and a successful sign-in returns
  the visitor to the deep link they arrived on via a client-side stash guarded by a
  same-origin validator. The OAuth callback contract (success `302 /`, failure
  `302 /?login_error=<code>`) is untouched.

## Impact

- **Contract impact:** two authorized additions — the `GET /sessions/:id` HTML route
  and the `GET /api/sessions/:id` detail endpoint (endpoint inventory grows by two
  rows; README table updated). Everything else: none. The callback success path stays
  byte-identical; redirect-back is entirely client-side.
- **Server:** `server/src/app.ts` serve block (one route + comment update);
  `server/src/routers/sessions.ts` detail endpoint reusing the list serializer and the
  existing per-session authorization helper; integration coverage for both routes
  (shell for arbitrary ids, non-matching paths still 404; detail 200 shape parity,
  masked 404s, archived and out-of-active-scope resolution); two README endpoint
  table rows.
- **Web:** new routing dependency (small hook-based router, selected in design);
  `AppShell` rewired from `useState` to the route param; removal of `syncChrome`,
  `body.dataset.sessionId`, and the `V3_*` globals (the placeholder↔grid visibility
  swap `syncChrome` performs today moves to route-driven conditional rendering; the
  sole external `V3_closeSession` caller is `HomeSettingsModal`'s studio-switch branch
  and becomes a prop/navigation); per-id resolution hook + the five resolution states;
  originator-tracked departure stop; `LoginPage` stash; post-auth return navigation +
  validator utility; new `web/` vitest tier (validator, resolution states, RootGate
  scenarios).
- **e2e:** `smoke.spec.ts` session assertion flips from `body.dataset.sessionId` to the
  URL (its and `visual.spec.ts`'s existing `#v3-session-grid` visibility assertions
  must stay green); deep-link reload smoke (navigate directly to `/sessions/:id`);
  anonymous deep link keeps its URL on the login-gate project.
- **Untouched:** Companion module, all `/api/*` routes and WS surface, catalog/DB layer,
  `/admin/users` (see Non-Goals).

## Non-Goals

- **No folding of `/admin/users` into the router.** Explore decision (2026-07-14): the
  admin page stays a separate Vite MPA entry with its own admin-token flow. It is the
  support back door when OAuth itself is broken; placing it under the login gate would
  put the back door behind the front door. It remains unlinked and unchanged.
- **No read-only workspace for archived sessions.** Archived sessions are not openable in
  the UI today (restore-only cards); a deep link to one resolves to an interstitial with
  the existing Restore action. A true read-only workspace mode is its own change.
- **No server-side `?next=` parameter** and no change to the OAuth callback semantics,
  session/cookie semantics, or login-session KV scheme.
- **No `/login` route.** The gate stays a render switch above the router.
- **No URL-addressed state beyond the session id** — no query-param workspace state
  (selected take, scroll position, settings-modal-open, etc.).
- **No broader MPA consolidation or build-config rework** beyond what the index entry
  needs.
