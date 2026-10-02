## MODIFIED Requirements

### Requirement: Authentication and authorization are distinct, single seams

Request **authentication** (resolving identity from session cookie or `API_TOKEN`) SHALL be
performed once in middleware; `API_TOKEN` SHALL be honoured only on paths under
`/api/companion/` (see `api-contract-freeze` "API_TOKEN authenticates only the Companion
surface"). The middleware's path decisions (login required, `API_TOKEN` scope) SHALL use the same
percent-decoded path the router matches, so a request that reaches an `/api/*` handler is always
judged as an `/api/*` request. Resource **authorization** (existence + show access + admin-token checks; show access is the
team-management "Member content access" rule: the owner or an admin of the show's team, or a
member holding a grant for the show) SHALL be consolidated behind `requireSession` and its
show-level sibling rather than re-deriving the login decision; no session-scoped route SHALL
check access any other way. The login-required check SHALL NOT be duplicated between
middleware and per-route helpers. Route helpers MAY assert that a principal is present; a
missing principal behind the middleware is an internal error (500), not a second login
decision. The consolidation SHALL preserve these exact behaviors,
each locked by a scenario below. (Replacing the `apiRequestRequiresLogin` URL-prefix matcher
with an explicit per-route policy is **deferred** — see the archived change's design D6 —
so its default-deny requirements are out of scope for this capability.)

#### Scenario: Login check is not duplicated
- **WHEN** a session-scoped route is exercised
- **THEN** the unauthenticated-401 decision is made exactly once, in the middleware, and `requireSession` performs only resolve + authorize (at most asserting that a principal is present, which is never a `401`)

#### Scenario: API_TOKEN machine clients bypass studio membership
- **WHEN** a request authenticated by `API_TOKEN` (no user) on a path under `/api/companion/` resolves a session in any studio
- **THEN** it is allowed after an existence check, with no membership scoping applied — the Companion machine path is unchanged

#### Scenario: API_TOKEN is not an identity outside the Companion surface
- **WHEN** a request bearing only a valid `API_TOKEN` accesses a session-scoped route outside `/api/companion/`
- **THEN** it is rejected by the single middleware login decision with `401`, and `requireSession` is never reached

#### Scenario: Percent-encoded API prefix is gated like the literal one
- **WHEN** `GET /%61pi/sessions` or `GET /%61pi/companion/state` is sent with no session cookie and no `API_TOKEN`
- **THEN** the response is `401` `{"detail": "Login required."}`, exactly as for `/api/sessions` and `/api/companion/state`, and no handler runs

#### Scenario: Cross-studio access is masked as 404, not 403
- **WHEN** an authenticated user who is not a member of a session's studio requests that session
- **THEN** the response is `404` "Session not found" (not `403`), identical before and after

#### Scenario: Admin token distinguishes unset from wrong
- **WHEN** an `/api/admin/*` route is called with `ADMIN_TOKEN` unset versus with an invalid token
- **THEN** it returns `503` (unset) versus `401` (invalid) respectively, and a session cookie alone grants no admin access

#### Scenario: A member without a grant is masked as 404, not 403
- **WHEN** an authenticated member of a session's studio who holds no grant for the session's show
  requests that session through any session-scoped route
- **THEN** the response is `404` "Session not found" (not `403`), identical to the cross-studio
  response

#### Scenario: Every session-scoped route goes through the one gate
- **WHEN** the registered route table is enumerated
- **THEN** every route whose path names a session id, and the show-scoped log import, denies a
  member without a grant with the masked `404` before reading its body, and a route added later
  without the gate fails that check
