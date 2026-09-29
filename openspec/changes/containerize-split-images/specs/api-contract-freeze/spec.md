## ADDED Requirements

### Requirement: API_TOKEN authenticates only the Companion surface
A request's `API_TOKEN` bearer credential SHALL be honoured only when the request path is
under `/api/companion/`. On every other path, including every other `/api/*` route, the
`/api/sessions/:id/ws` upgrade (any `role`), `/auth/*`, and `/api/admin/*`, a request that
carries a valid `API_TOKEN` and no other credential SHALL be handled exactly as a request
that carries no credential, in both `REQUIRE_LOGIN` modes. Under `REQUIRE_LOGIN=1` that
means `401` with `{"detail": "Login required."}` wherever an anonymous request gets that
response today. `ADMIN_TOKEN` handling on `/api/admin/*` is unchanged. This requirement
authorizes a breaking change to fielded headless clients that used `API_TOKEN` outside
`/api/companion/*`. Deployed Companion modules call only
`/api/companion/{state,categories,log,transport,command}` and are unaffected.

#### Scenario: Companion routes still accept the token
- **WHEN** `GET /api/companion/state` is sent under `REQUIRE_LOGIN=1` with a valid
  `API_TOKEN` bearer and no session cookie
- **THEN** the response is `200` with the frozen state shape

#### Scenario: Token no longer opens other API routes
- **WHEN** `GET /api/sessions` is sent under `REQUIRE_LOGIN=1` with a valid `API_TOKEN`
  bearer and no session cookie
- **THEN** the response is `401` `{"detail": "Login required."}`

#### Scenario: Token no longer opens the session WebSocket
- **WHEN** `/api/sessions/<id>/ws?role=companion` is opened under `REQUIRE_LOGIN=1` with a
  valid `API_TOKEN` bearer and no session cookie
- **THEN** the upgrade is refused exactly as for an unauthenticated client

#### Scenario: Token outside the Companion surface is inert under open login
- **WHEN** `GET /api/sessions/<id>/ai/v2/dashboard` (which refuses token-only callers with `404` today) is called under
  `REQUIRE_LOGIN=0` with a valid `API_TOKEN` bearer
- **THEN** the response is identical to the same request sent with no `Authorization`
  header

### Requirement: Traversal-shaped request targets are not normalized into inventory routes in the split topology
In the split-container topology (`container-deployment`), a request whose raw path meets any
of the following conditions SHALL be answered with the server's own `404`:
- it has a segment that is, or percent-decodes to, `.` or `..`;
- it contains an empty segment;
- it contains an encoded `/` or `\` under `/api` or `/auth`.

Such a request SHALL NOT be dispatched to whatever inventory route its normalized form
names. Such targets are not in the endpoint inventory. This requirement authorizes the
`404` where the single-process server normalizes them into a route today.

#### Scenario: Encoded dot-segments do not reach a route
- **WHEN** `GET /api/companion/%2e%2e/sessions` is sent with a valid session cookie at the
  public origin of the split topology
- **THEN** the response is `404` and the sessions list handler does not run
