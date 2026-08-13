# api-contract-freeze — delta (nextjs-frontend-migration)

## MODIFIED Requirements

### Requirement: Session deep-link HTML route
`GET /sessions/:id`, where `:id` is a single non-empty path segment, SHALL respond
`200` with the index shell HTML — the same page identity served at `/` (same route
group, layout, and page component; responses across router-known paths differ only in
the framework's serialized URL data) — unconditionally on whether a session with that
id exists and on whether the requester is authorized to see it. The HTML layer SHALL
NOT leak session existence: for a fixed deployment and fixed request headers, the
response SHALL NOT vary with session existence, deletion state, or the requester's
authorization — for a real session, a deleted session, and a foreign team's session at
the same id, the response bodies are identical. (The document MAY embed the requested
route itself — the serving framework serializes the matched URL — but SHALL embed no
session-derived or catalog-derived data. The response MAY vary with content-negotiation
headers the serving framework defines — e.g. an RSC flight request returns a payload,
not HTML — and MAY vary across deployments via build identifiers; neither variance may
correlate with session state.) Authentication happens client-side through the existing
`GET /api/profile` surface, and session resolution through the `GET /api/sessions/:id`
detail endpoint; the HTML route itself adds no JSON surface, sets no cookies, and takes
no query-parameter semantics.

Paths outside the frozen inventory — including `/sessions` (no id),
`/sessions/<id>/<more>` (nested segments), and trailing-slash variants of inventory
paths (`/teams/`, `/sessions/<id>/`) — SHALL keep responding `404` when no static
asset matches, with no canonicalizing redirect. Non-GET requests to paths outside the
inventory SHALL keep responding with the server's own `404`, exactly as before this
change. (Non-normative: a percent-encoded slash, e.g. `/sessions/a%2Fb`, is a
single raw path segment and therefore serves the shell — integration tests must not
assert `404` for the encoded form.)

#### Scenario: Deep link serves the shell
- **WHEN** `GET /sessions/abc-123` is requested (any single non-empty id segment,
  existing session or not, authenticated or not)
- **THEN** the server responds `200` with the index shell HTML, with no `Set-Cookie`

#### Scenario: No existence oracle
- **WHEN** `GET /sessions/<id>` is requested with identical request headers for an
  existing session, a deleted session, a foreign team's session, and a random
  nonexistent id
- **THEN** the response bodies are identical across all four cases for the same id
  value, and no part of any response derives from session or catalog data

#### Scenario: Non-matching paths stay 404
- **WHEN** `GET /sessions`, `GET /sessions/a/b`, or `GET /teams/` (or any other path
  outside the endpoint inventory, including trailing-slash variants) is requested and
  no static asset matches
- **THEN** the response status remains `404` with no redirect (the 404 body is the
  frontend framework's not-found document; only the status is pinned)

#### Scenario: Stray-path upgrade disposition
- **WHEN** a WebSocket upgrade is attempted in production on a path outside `/api/`
- **THEN** the socket is destroyed (previously it received an HTTP-status close via the
  upgrade replay; this change authorizes the destroy disposition — the `/api` WS
  surface is unchanged)

### Requirement: Teams page HTML route
`GET /teams` SHALL respond `200` with the index shell HTML — the same page identity
served at `/` and `/sessions/:id` — unconditionally on authentication (the login
gate renders client-side), setting no cookies. Paths below it (`/teams/<more>`)
remain outside the inventory and keep responding `404` when no static asset matches.

#### Scenario: Teams deep link serves the shell
- **WHEN** `GET /teams` is requested by an anonymous client
- **THEN** the server responds `200` with the index shell HTML and no `Set-Cookie`
