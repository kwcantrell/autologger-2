# api-contract-freeze — delta

## ADDED Requirements

### Requirement: Session deep-link HTML route
`GET /sessions/:id`, where `:id` is a single non-empty path segment, SHALL respond
`200` with the SPA index page HTML — the same document body served at `/` — 
unconditionally on whether a session with that id exists and on whether the requester
is authorized to see it. The HTML layer SHALL NOT leak session existence: the response
for a real session, a deleted session, and a foreign team's session is identical.
Authentication happens client-side through the existing `GET /api/profile` surface,
and session resolution through the `GET /api/sessions/:id` detail endpoint this same
delta authorizes below; the HTML route itself adds no JSON surface, sets no cookies,
and takes no query-parameter semantics.

This is an explicit page route, not a catch-all: paths outside the frozen inventory —
including `/sessions` (no id) and `/sessions/<id>/<more>` (nested segments) — keep
their current behavior (the static-asset fallback, `404` when no asset matches).
(Non-normative: a percent-encoded slash, e.g. `/sessions/a%2Fb`, is a single raw path
segment and therefore serves the shell — integration tests must not assert `404` for
the encoded form.)

#### Scenario: Deep link serves the shell
- **WHEN** `GET /sessions/abc-123` is requested (any single non-empty id segment,
  existing session or not, authenticated or not)
- **THEN** the server responds `200` with the SPA index HTML, identical to the document
  served at `/`, with no `Set-Cookie`

#### Scenario: No existence oracle
- **WHEN** `GET /sessions/<id>` is requested for a real session and for a random
  nonexistent id, in either case by an anonymous client
- **THEN** the two responses are indistinguishable (same status, same body)

#### Scenario: Non-matching paths stay 404
- **WHEN** `GET /sessions` or `GET /sessions/a/b` (or any other path outside the
  endpoint inventory) is requested and no static asset matches
- **THEN** the response remains `404`, exactly as before this change

### Requirement: Session detail endpoint
`GET /api/sessions/:id` SHALL respond `200` with a JSON object carrying exactly the
same field set and value semantics as one element of the `active`/`archived` arrays in
the `GET /api/sessions` response (produced by the same serialization, so the shapes
cannot drift), for any session the requester is authorized to access under the same
authorization rule the existing per-session routes use (studio membership via the
session's show), regardless of the requester's active-show or active-studio
preferences and regardless of the session's archived state. It SHALL respond `404` —
indistinguishable across the cases — for a nonexistent id, a deleted (`ui_hidden`)
session, and a session the requester is not authorized to access, preserving the
existing 404-masking posture. Authentication requirements match the other
`/api/sessions/*` routes. This endpoint is additive: the `GET /api/sessions` list
response (scope, shape, and semantics) is unchanged.

#### Scenario: Authorized fetch regardless of active scope
- **WHEN** an authenticated member of the session's studio requests
  `GET /api/sessions/<id>` while their active show or active studio preference points
  elsewhere
- **THEN** the server responds `200` with the session object, field-for-field the
  shape of a `GET /api/sessions` list entry

#### Scenario: Archived session still resolves
- **WHEN** the session exists, the requester is authorized, and the session is
  archived
- **THEN** the server responds `200` with the session object reflecting its archived
  state

#### Scenario: Masked 404 across all denial causes
- **WHEN** `GET /api/sessions/<id>` is requested for an id that never existed, for a
  deleted (`ui_hidden`) session, or for a session in a studio the requester is not a
  member of
- **THEN** every case responds with the same `404` (same shape), with no signal
  distinguishing them
