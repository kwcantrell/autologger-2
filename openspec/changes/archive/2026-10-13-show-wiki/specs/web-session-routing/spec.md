# Spec Delta

## MODIFIED Requirements

### Requirement: URL-addressed session state
The web app SHALL derive its active-session state from the URL via a client-side route
table with exactly six app routes: `/` (no session selected; home/sessions view),
`/sessions/:id` (the session workspace for `:id`), `/teams` (the sessions home view with the Settings view opened on its Members section; no
session selected), `/search` (the search results page; no session selected), `/wiki` (the active show's wiki; no
session selected), and `/wiki/:pageId` (one wiki page; no session selected). Selecting a session SHALL push a
history entry for `/sessions/:id`; selecting the session that is already active SHALL
NOT push a duplicate entry (no-op or replace); closing the active session SHALL
navigate to `/`; browser Back/Forward SHALL drive the same state transitions as in-app
selection and close. Creating a session SHALL navigate to its `/sessions/:id` the same
way selection does. Navigating to `/teams`, `/search`, `/wiki` or `/wiki/:pageId` SHALL push a history entry and leaves any
active session (the departure semantics of the transport-stop requirement apply
unchanged). The workspace's session id SHALL come from the route parameter —
there SHALL be no parallel component-state copy of the active session id that can
disagree with the URL. The router-known route table SHALL remain defined in the
shared route-definition module, which its runtime consumers import: the post-login
stash write, the return-path validator, and the server-side shell router (the Next
catch-all's segment-shape validation). The module holds two predicates with
deliberately different domains — the deep-link predicate (`isRouterKnownPathname`,
excludes `/`) consumed by the stash write and return-path validator, and the shell
segment-shape helper (includes `/`) consumed by the catch-all — and they SHALL NOT be
merged into one predicate. `AppShell`'s wouter patterns remain the one
sanctioned mirror that cannot mechanically share the definition — extending it in the
same change that extends the module is the requirement. (The former vite dev-middleware
matcher and hand-written server serve block no longer exist; the shell router consumes
the module directly instead of mirroring it.)

Route matching stays eager, but the **view** a matched route mounts may be code-split. `/teams`
has no chunk of its own: matching it renders the home view and sets the shell's Settings state to
the Members section, so the Settings view's overlay boundary (web-frontend-platform "The client
island is route-split behind recoverable boundaries") is what loads — with that boundary's `null`
fallback while in flight and its dismissible failure card over the intact home view on failure.
Route identity, history behaviour, and the route table are unaffected.

(Non-normative: a path matching no route 404s at the HTML layer under the shell
router; the previously reachable raw built-asset path, e.g.
`/src/pages/index/index.html`, no longer exists as a served asset.)

#### Scenario: Selecting a session updates the URL
- **WHEN** an authenticated user selects a session from the rail or session list
- **THEN** the address bar shows `/sessions/<id>`, a history entry is pushed, and the
  workspace for that session mounts

#### Scenario: Re-selecting the active session does not stack history
- **WHEN** the user activates the session card or rail entry for the session already
  shown at `/sessions/<id>`
- **THEN** no additional history entry is created — one Back press still leaves the
  session

#### Scenario: Browser Back leaves the session
- **WHEN** the user is on `/sessions/<id>` (having navigated there in-app) and presses
  the browser Back button
- **THEN** the app returns to the no-session home view at `/`, exactly as if the
  close-session control had been used

#### Scenario: Deep-link reload restores the session
- **WHEN** an authenticated user reloads the browser on `/sessions/<id>` for a session
  they can access, or pastes that URL into a new tab
- **THEN** the session workspace for `<id>` mounts once resolution completes — the
  session survives the reload

#### Scenario: Teams route is a first-class app route
- **WHEN** an authenticated user navigates to `/teams` in-app, or reloads the browser
  on `/teams`
- **THEN** the home view renders at that URL with the Settings view open on Members once the
  Settings chunk has loaded, and browser Back returns to the previous view

#### Scenario: The teams route announces its own chunk wait and failure
- **WHEN** `/teams` is matched while the Settings chunk is still in flight, and separately when
  that chunk fetch fails
- **THEN** the pending case shows the home view with nothing overlaid (the overlay boundary's
  `null` fallback), and the failed case shows the overlay variant's dismissible failure card over
  the home view, with the rest of the app shell still mounted

#### Scenario: Search route is a first-class app route
- **WHEN** an authenticated user opens `/search?q=budget` in-app, or reloads the browser on it
- **THEN** the search results page renders for `budget` with no session selected, and browser
  Back returns to the previous view

#### Scenario: Wiki routes are first-class app routes
- **WHEN** an authenticated user opens `/wiki` or `/wiki/<pageId>` in-app, or reloads the browser on either
- **THEN** the wiki list or that wiki page renders with no session selected, and browser Back returns to
  the previous view

#### Scenario: Route table extension is single-sourced
- **WHEN** a future change adds a router-known route
- **THEN** it extends the shared route-definition module (predicate and segment shape)
  and `AppShell`'s wouter patterns in the same change, and no other copy of the route
  table exists to update
