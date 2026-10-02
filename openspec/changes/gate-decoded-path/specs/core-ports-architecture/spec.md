## MODIFIED Requirements

### Requirement: Authentication and authorization are distinct, single seams

Request **authentication** (resolving identity from session cookie or `API_TOKEN`) SHALL be
performed once in middleware; `API_TOKEN` SHALL be honoured only on paths under
`/api/companion/` (see `api-contract-freeze` "API_TOKEN authenticates only the Companion
surface"). The middleware's path decisions (login required, `API_TOKEN` scope) SHALL use the same
percent-decoded path the router matches, so a request that reaches an `/api/*` handler is always
judged as an `/api/*` request. Resource **authorization** (existence + studio-membership +
admin-token checks) SHALL be consolidated behind `requireSession`/`authorize` rather than
re-deriving the login decision. The login-required check SHALL NOT be duplicated between
middleware and per-route helpers. The consolidation SHALL preserve these exact behaviors,
each locked by a scenario below. (Replacing the `apiRequestRequiresLogin` URL-prefix matcher
with an explicit per-route policy is **deferred** — see the archived change's design D6 —
so its default-deny requirements are out of scope for this capability.)

#### Scenario: Login check is not duplicated
- **WHEN** a session-scoped route is exercised under `REQUIRE_LOGIN=1`
- **THEN** the unauthenticated-401 decision is made exactly once, and `requireSession` performs only resolve + authorize

#### Scenario: API_TOKEN machine clients bypass studio membership
- **WHEN** a request authenticated by `API_TOKEN` (no user) on a path under `/api/companion/` resolves a session in any studio under `REQUIRE_LOGIN=1`
- **THEN** it is allowed after an existence check, with no membership scoping applied — the Companion machine path is unchanged

#### Scenario: API_TOKEN is not an identity outside the Companion surface
- **WHEN** a request bearing only a valid `API_TOKEN` accesses a session-scoped route outside `/api/companion/` under `REQUIRE_LOGIN=1`
- **THEN** it is rejected by the single middleware login decision with `401`, and `requireSession` is never reached

#### Scenario: Percent-encoded API prefix is gated like the literal one
- **WHEN** `GET /%61pi/sessions` or `GET /%61pi/companion/state` is sent with no session cookie and no `API_TOKEN` under `REQUIRE_LOGIN=1`
- **THEN** the response is `401` `{"detail": "Login required."}`, exactly as for `/api/sessions` and `/api/companion/state`, and no handler runs

#### Scenario: Cross-studio access is masked as 404, not 403
- **WHEN** an authenticated user who is not a member of a session's studio requests that session
- **THEN** the response is `404` "Session not found" (not `403`), identical before and after

#### Scenario: Admin token distinguishes unset from wrong
- **WHEN** an `/api/admin/*` route is called with `ADMIN_TOKEN` unset versus with an invalid token
- **THEN** it returns `503` (unset) versus `401` (invalid) respectively, and a session cookie alone grants no admin access
