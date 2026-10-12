# Spec Delta

## MODIFIED Requirements

### Requirement: URL-addressed session state
The web app SHALL derive its active-session state from the URL via a client-side route
table with exactly four app routes: `/` (no session selected; home/sessions view),
`/sessions/:id` (the session workspace for `:id`), `/teams` (the sessions home view with the Settings view opened on its Members section; no
session selected), and `/search` (the search results page; no session selected). Selecting a session SHALL push a
history entry for `/sessions/:id`; selecting the session that is already active SHALL
NOT push a duplicate entry (no-op or replace); closing the active session SHALL
navigate to `/`; browser Back/Forward SHALL drive the same state transitions as in-app
selection and close. Creating a session SHALL navigate to its `/sessions/:id` the same
way selection does. Navigating to `/teams` or `/search` SHALL push a history entry and leaves any
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

#### Scenario: Route table extension is single-sourced
- **WHEN** a future change adds a router-known route
- **THEN** it extends the shared route-definition module (predicate and segment shape)
  and `AppShell`'s wouter patterns in the same change, and no other copy of the route
  table exists to update

## ADDED Requirements

### Requirement: Moment deep links
`/sessions/:id` SHALL accept one optional moment parameter:

| Parameter | Target |
| --- | --- |
| `t=<seconds>` | a non-negative decimal number of seconds |
| `topic=<id>` | a topic of that session |
| `event=<id>` | an event of that session |

Applying the parameter:
- **When:** once the session's status has resolved and its timeline is ready, the workspace SHALL move the timeline to the target exactly once. It SHALL NOT start playback. If the session is rolling, it SHALL NOT seek.
- **Already open:** a moment link to the session that is already open SHALL apply the same way, without remounting the workspace and without the departure behaviour of leaving a session.
- **How topics and events are placed:** `topic` and `event` targets SHALL be placed by the same rules, gating included, as choosing that row in its feed.
- **Unusable targets:** a missing, unparseable or unplaceable target SHALL open the session with no seek and no error.
- **Afterwards:** the parameter SHALL be removed from the URL by a history replace (no new entry), so a reload or Back does not seek again.
- **Precedence:** if more than one moment parameter is present, `t` SHALL take precedence, then `topic`, then `event`.

#### Scenario: Seek to seconds
- **WHEN** an authenticated user with access opens `/sessions/<id>?t=754.2`
- **THEN** the workspace mounts with the timeline at 754.2 seconds, not playing, and the address bar
  shows `/sessions/<id>`

#### Scenario: Seek to a topic
- **WHEN** the user opens `/sessions/<id>?topic=<topicId>` for a topic whose feed row can jump
- **THEN** the timeline is placed where choosing that topic row would place it

#### Scenario: Unplaceable target
- **WHEN** the user opens `/sessions/<id>?event=<eventId>` for an event with no usable timecode, or `?t=abc`
- **THEN** the session opens with no seek and no error, and the parameter is removed from the URL

#### Scenario: Moment in the session already open
- **WHEN** `/sessions/<id>` is open with its workspace mounted and the app navigates to `/sessions/<id>?t=30`
- **THEN** the timeline moves to 30 seconds without remounting the workspace or starting playback, and the address bar returns to `/sessions/<id>`

#### Scenario: Rolling session is not moved
- **WHEN** the user opens `/sessions/<id>?t=30` while that session is rolling
- **THEN** the session opens with no seek, and the parameter is removed from the URL

#### Scenario: Moment link survives login
- **WHEN** a logged-out user opens `/sessions/<id>?t=30`, logs in, and is returned to the link
- **THEN** the session opens at 30 seconds
