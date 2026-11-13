# Custom session dashboards through an MCP App

- Status: Proposed. Awaiting human approval of this design and of
  [ADR 0035](../decisions/0035-custom-session-dashboards-mcp-app.md).
- Date: 2026-11-13
- Inputs: the fourteen human decisions recorded in ADR 0035. This document gives the mechanism.
  It reopens none of those decisions; where it names something the human hasn't decided yet, it
  says so under **Open questions** (section 13.3).

## 1. Summary

A studio owner or admin connects Claude (claude.ai or Claude Desktop) to autologger as a custom
connector. Claude signs in through autologger's own OAuth 2.1 server, whose login step is the
existing Google sign-in. Claude then reads a session's events, transcript, topics and associated
wiki pages through paged MCP tools, and writes a dashboard as React TSX that uses the app's
shadcn components.

The server validates the TSX against an import allowlist, compiles it to JavaScript and stores
it with revision history, either on one session or as a studio template. A dashboard renders:

- in Claude, as an MCP App View;
- in autologger web, in the session's Dashboards tab.

Either way, the agent's code runs in a nested, sandboxed iframe from a dedicated runtime origin.
That iframe has no network access and an opaque origin. Its only capability is a typed query API,
which the trusted parent answers for the one session it was opened for, under the viewer's own
permissions.

Everything is behind `CUSTOM_DASHBOARDS_ENABLED`. When the flag is off, none of the new routes
exist and the deployment behaves exactly as it does today.

Terms:

- **Studio** is the catalog's name (`studio_id`, `user_studio_memberships`) for what the API and
  UI call a **team**. Roles are `owner`, `admin` and `member` (team-management).
- **Manager** means an owner or admin of the studio.
- **Reader of a session** means a user for whom `authCanAccessShow(user, session.show_id)` is true
  (team-management "Member content access").
- **Custom dashboard** is the new kind this design adds. **v2 dashboard** is the existing
  `ai-v2-dashboards` kind, which stays unchanged.

## 2. What exists today

Each item was checked against the code or a spec on `main` at `261d520c`.

| Area | Where | What this design relies on |
| --- | --- | --- |
| Studio role check | `server/src/routers/teams.ts`: `requireTeamRole`, `requireTeamRoleIn`, `OWNER_OR_ADMIN` | Masked `404` for a non-member and `403` for a member without the role. `requireTeamRoleIn` re-checks the role inside the write's transaction with `authGetMembershipRoleForShare`, so a concurrent demotion either waits for the write or fails it. Dashboard writes use the same pair. |
| Session access check | `server/src/routers/_helpers.ts`: `requireSession`, `canAccessSession`, `requireShowAccess`; `packages/catalog/src/authStore.ts`: `authCanAccessShow`, `authCanAccessShowForShare` | One rule: a manager of the show's studio, or a member with a grant on the show. Every denial is the same masked `404 Session not found`. Every MCP read tool and every web query call uses `requireSession`. |
| Caller binding | `server/src/middleware/auth.ts` (`authContext`); `server/src/autogenerate/principal.ts`; `server/src/catalogSystem.repo.test.ts` (`USER_BINDERS`, `USER_SESSION_CALLERS`) | `.forUser(` may appear only in the files `USER_BINDERS` lists: the auth middleware and the batch worker's `autogenerate/principal.ts`, which binds a batch job's work to its initiator (batch-autogenerate D4). Neither is a router, and a request credential is resolved only in the middleware. A new bearer credential therefore has to be resolved inside `authContext`, as Companion device tokens are, and not in a router. Request-path session-hub calls go through `sessionCaller(c)` (`_helpers.ts`), one of the allowed `userCaller(` sites. |
| Hashed bearer tokens | `server/src/auth/companionDeviceToken.ts`; `supabase/migrations/20261015000000_companion_devices.sql` | Prefixed random tokens, stored only as hex SHA-256 in a system-only table (`catalog_user` privileges revoked), and looked up in `authContext`. OAuth tokens copy this pattern. |
| Login sessions and OAuth state | `server/src/auth/identity.ts`: `createLoginSession`, `resolveSessionUser`, `putOauthState`, `takeOauthState`; `packages/ports/src/kvStore.ts` (`take`, `replaceIf`) | The KV store has an atomic one-shot `take`, which suits authorization codes. `resolveSessionUser` reads through `authGetUserById`, which excludes disabled accounts (`disabled_at_utc IS NULL`). |
| Google sign-in | `server/src/routers/auth.ts`: `GET /auth/google/start`, `GET /auth/google/callback` | The callback sets the `HttpOnly`, `SameSite=Lax`, host-only session cookie and always redirects to `/` (api-contract-freeze "OAuth callback failure redirect", scenario "Success path unchanged"). There is no return-to parameter today. Section 4.4 adds one, only for states issued by the new authorize endpoint. |
| Public base URL | `server/src/env.ts` `publicBaseUrl()`; `server/src/bootGuard.ts` `SIGN_IN_VARS`; web-frontend-platform; local-container-environments | **`PUBLIC_BASE_URL` already exists and is required at boot in every stack.** Dev pins it to `http://localhost:${DEV_PORT:-8787}`. A stage started with `STAGE_PUBLIC_BASE_URL` gets an `https://` value and `COOKIE_SECURE=1`. Prod sets the public HTTPS origin (container-deployment). This design adds **no** base-URL setting. It adds a check that the value is `https:` when the flag is on. |
| Existing MCP server | `packages/ai-runtime/src/aiMcpServer.ts` (`AiMcpListener`, `buildSessionMcpServer`); `packages/ai-runtime/src/mcpTools.ts`; `packages/ai-runtime/src/aggregates.ts` | It is loopback-only by design: "NEVER binds a non-loopback address … or folding it onto the public :8787 app". It uses per-turn tokens and binds the session at registration. **This design doesn't reuse the listener.** It reuses its discipline (session bound outside the model's arguments, hub resolved at call time, bounded and truncation-stating results) and the pure functions in `aggregates.ts`. The public `/mcp` endpoint is a new Hono route. |
| MCP SDK | `@modelcontextprotocol/sdk` 1.32.x (`package-lock.json`), which ships `server/webStandardStreamableHttp.js`; `LATEST_PROTOCOL_VERSION = '2025-11-25'` | The SDK's web-standard Streamable HTTP transport plugs into a Hono handler (Request in, Response out) in stateless mode. Its Express-based auth helpers are not used. |
| Hono app | `server/src/app.ts` (`wireApp`) | Middleware runs in this order: bindings, `ipAllowlistMiddleware`, `authContext`, and `/api/*` compression. Routers are mounted with `app.route('/', …)`. `onError` maps `ApiError` and others to `{detail}`. |
| Frontend bridge | `server/src/app.ts` `frontendBridge`, `keepAlreadySentOnHead`; `server/src/node/nextFrontend.ts`; container-deployment "Two images built from one repository" | **The answer depends on the process.** In the single-process server (the dev stack), `app.get('*')` hands every unmatched GET, except `/api*` and `/auth*`, to Next.js, so it gets Next's not-found document. The production `api` image has no `web/.next` and boots API-only; there `frontendBridge` has no frontend and answers every unmatched request with Hono's plain-text `404 Not Found`. Unmatched non-GET requests get Hono's `404` in both. In the split topology the `web:3000` container answers today's GETs for `/mcp`, `/oauth/*` and `/.well-known/*` with Next's not-found HTML, so **routing those GETs to the api would change their answer**. That is why the new router rules exist only when the flag is on (section 10.3). With the flag off, no new route is mounted and no router rule changes, so each topology keeps its own answers. `keepAlreadySentOnHead` (job 014) is untouched, because the new routes are ordinary Hono responses. |
| Router (split topology) | `docker/Caddyfile` rules 1–6; `docker/scripts/caddy-adapt.baseline.json`; `docker/scripts/check-envs.sh` invariants 10 and 13; `compose.yaml` `router`; `docker/dev-gate.Caddyfile` | Only `/api` and `/auth` prefixes, non-GET/HEAD methods and trailing-slash paths reach `api:8787`. **Every other GET goes to `web:3000`.** New GET routes need exact-path rules in the file's raw-URI CEL style (the lesson of deferred job 016). The file is bind-mounted read-only and adapted when the router starts; it already reads `{$VAR:default}` environment placeholders (`ROUTER_FRONT_GW`, `ROUTER_BACK_GW`). Invariant 13 pins the adapt output with no variables set to the committed baseline, and invariant 10 requires the prod router's resolved `environment` to be empty. |
| IP allowlist | `server/src/middleware/ipAllowlist.ts` | It applies to every path when `IP_ALLOWLIST` is set. Claude's connector traffic comes from Anthropic's egress range, so an operator using the allowlist has to add that range (section 10). |
| v2 dashboards | `openspec/specs/ai-v2-dashboards/spec.md`; `server/src/routers/aiV2.ts`; `catalog.session_dashboards`; `web/src/pages/index/components/aiV2/*` | One validated config per session, rendered through the app's own widget components. The Dashboards tab (web-session-console "Workspace tab IA") hosts it. All of this is unchanged. |
| shadcn set | `web/components.json`; `web/src/shared/components/ui/*.tsx` | The components that exist are the allowlist's starting set (section 7.2). `web/package.json` has no chart library. |
| Markup guard | `web/src/noAgentAuthoredMarkup.repo.test.ts` | Scans `server/`, `web/` and `companion/` for `dangerouslySetInnerHTML` usage. It stays, and the runtime doesn't need that API. |
| Rate-limit precedent | `supabase/migrations/20261017000000_provider_test_windows.sql` (provider tests limited to 5 a minute per user, across processes) | Database-backed windows shared by every process. The new limits use the same approach. |
| Wiki | `openspec/specs/show-wiki/spec.md`; `packages/catalog/src/wikiStore.ts`; `supabase/migrations/20261021000000_show_wiki.sql` | Pages belong to one show. A `session` page names one session (at most one live page per session). Citations take the form `cite:<session_id>@<seconds>`. There is **no citation index table**, so finding the pages that cite a session needs a show-scoped body scan (section 5.4). |
| Session hub reads | `packages/session-core/src/SessionHub.ts`: `listEvents({limit, offset})`, `listTranscriptWords()`, `listTranscriptEnrichment()`, `listTopics()` | Only events are paged at the hub. Words, paragraphs and topics are read whole and paged in memory, as the generation tools already do (`aiMcpServer.ts` `paginateGenerationTranscript`). |

## 3. Architecture

### 3.1 Components

| Component | Runs where | New or existing | Trust |
| --- | --- | --- | --- |
| Claude client (claude.ai, Desktop) | Anthropic | external | The OAuth client. The model in it reads untrusted session content. |
| MCP Apps host and sandbox proxy | Claude's web or desktop UI | external | Renders the View in its own sandboxed origin. |
| **OAuth authorization server** | api process, `server/src/routers/oauth*.ts` | new | Trusted server code. |
| **MCP endpoint `/mcp`** | api process, `server/src/routers/mcp.ts` | new | Trusted. Every tool authorizes the token's user on every call. |
| **Session query service** | api process, `server/src/dashboards/query.ts` | new | Trusted. Serves both the MCP tools and the web viewer. |
| **Dashboard store and compiler** | api process, `packages/catalog` (store), `server/src/dashboards/compile.ts` | new | Trusted code that handles untrusted TSX. |
| **MCP App View** (`ui://autologger/dashboard-view`) | Claude's sandboxed iframe | new | Our code, served by our server, running on the host's origin. Trusted with the binding for one dashboard and session. |
| **Dashboard runtime** | `DASHBOARD_RUNTIME_ORIGIN`, a static bundle served by the api | new | Our code, running agent code. Treated as **untrusted** once the agent code starts. |
| **Agent dashboard code** | inside the runtime frame (opaque origin) | new | **Untrusted.** |
| Web viewer (Dashboards tab section) | autologger web origin (Next) | new | Trusted. Holds the viewer's cookie, which never crosses into the frame. |
| Catalog (Postgres) | `db` | existing, new tables | Row-level security as today. The OAuth tables are system-only. |

### 3.2 Origins

| Origin | What it serves | Cookies |
| --- | --- | --- |
| `PUBLIC_BASE_URL` (the app origin, `https:` required with the flag) | the web app, `/api/*`, `/auth/*`, `/oauth/*`, `/.well-known/oauth-*`, `/mcp` | the session cookie (host-only, `HttpOnly`, `Lax`) |
| `DASHBOARD_RUNTIME_ORIGIN` (a separate `https:` host, required with the flag) | `/runtime/v1/frame.html` and its hashed assets only | none: the server sets none, and the app cookie is host-only so it never applies here |
| Claude's View origin | the View HTML that the host loads from our `ui://` resource | not ours |
| Opaque (`null`) | the runtime frame document, because it is sandboxed without `allow-same-origin` | none |

The runtime host should be a different registrable domain from the app (for example
`autologger-dash.example.net` beside `autologger.example.com`), so it isn't even same-site. A
subdomain of the app's domain is accepted but documented as weaker. Section 10 explains why the
boot check only refuses an identical host.

### 3.3 Request path: Claude client to data and back

```
Claude model ──tool call──▶ Claude (Anthropic) ──HTTPS POST /mcp, Authorization: Bearer alm_…──▶ Caddy
  ──(rule 4: non-GET → api)──▶ api: ipAllowlist → authContext
      authContext, path === '/mcp':
        hash the bearer → mcp_access_tokens ⋈ mcp_grants (not revoked, not expired,
        resource = PUBLIC_BASE_URL + '/mcp') → authGetUserById (enabled)
        → c.set('user'), c.set('catalog', sys.forUser(user.id)), c.set('mcpGrant', …)
  ──▶ mcp router: checks Origin, size cap, per-user rate window
      → SDK WebStandardStreamableHTTPServerTransport (stateless) → McpServer built for this
        request with the tools in section 5
      → tool handler: requireSession(c, session_id)   (masked "Session not found")
                      → getSessionHub(c, session_id)  (bound to sessionCaller(c))
                      → query service: page, cap, cursor
  ◀── JSON-RPC result (structuredContent + text) ◀──
```

Rendering in Claude:

```
model calls open_dashboard {session_id, dashboard_id}
  → server: authorize reader; load compiled JS; mint binding (section 8.3)
  → result: _meta.ui.resourceUri = ui://autologger/dashboard-view, structuredContent
            {binding, dashboard meta, compiled code}
host fetches resources/read ui://autologger/dashboard-view → View HTML
  (_meta.ui.csp.frameDomains = [DASHBOARD_RUNTIME_ORIGIN])
View ⇄ host (postMessage JSON-RPC, ext-apps 2026-01-26):
  ui/initialize, ui/notifications/tool-result → View gets {binding, code}
View creates <iframe sandbox="allow-scripts" src="DASHBOARD_RUNTIME_ORIGIN/runtime/v1/frame.html">
View ⇄ runtime frame (MessagePort, section 8.2): load {code}, then query/result messages
View → host tools/call dashboard_data {binding, query}  (app-only tool)
  → server: verify binding (HMAC, user, expiry) → requireSession under the token's user
  → query service → result → View → port → runtime frame → React re-render
```

Rendering in autologger web (section 9) follows the same path from the View onward, with the
Dashboards tab in place of the View and `POST /api/sessions/:sessionId/custom-dashboards/query`
(cookie auth) in place of `dashboard_data`.

### 3.4 Processes

There are no new processes or containers. The OAuth server, `/mcp`, the query service, the
compiler and the runtime's static files all run in the existing api process. The runtime origin
is a second hostname that reaches the same api through the router (section 10.3). Several api
processes may run behind the router (session-frame-bus), so every piece of state lives in the
catalog or the KV store, never in process memory:

- OAuth codes and pending requests;
- tokens;
- rate-limit windows.

The `/mcp` transport is stateless: no `Mcp-Session-Id` is issued, so any process can serve any
request.

## 4. OAuth

The target is the MCP authorization spec, revision 2025-11-25
(<https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization>), with OAuth 2.1
(draft-ietf-oauth-v2-1), RFC 9728 (protected-resource metadata), RFC 8414 (AS metadata), RFC 7591
(dynamic client registration), RFC 7636 (PKCE), RFC 8707 (resource indicators), RFC 7009
(revocation) and RFC 9207 (`iss` in the authorization response). The design was checked against
Claude's connector requirements
(<https://claude.com/docs/connectors/building/authentication>, read 2026-11-12):

- callback `https://claude.ai/api/mcp/auth_callback`;
- PKCE `S256` always sent;
- a `401` starts sign-in;
- the PRM `resource` must equal the URL the user enters;
- only the first `authorization_servers` entry is used;
- form-urlencoded `/token` requests;
- `invalid_grant` for a dead refresh token;
- 10 s discovery, registration and token timeouts, and 30 s for refresh.

Revision 2026-07-28 deprecates DCR in favor of Client ID Metadata Documents. That change is
recorded in ADR 0035 as a later addition and is not part of v1.

### 4.1 Identifiers

- **Issuer:** `ISSUER = publicBaseUrl()`, for example `https://autologger.example.com`, with no
  path and no trailing slash.
- **Resource (canonical MCP URL):** `RESOURCE = ISSUER + '/mcp'`. The user pastes this URL into
  Claude.
- **Scope:** one scope, `dashboards`. It covers the read tools and the dashboard write tools.
  Writes are still role-gated per call. A single scope keeps the consent screen honest: roles,
  not scopes, decide what a token can do.

### 4.2 Endpoints

All are mounted only when the flag is on (section 10).

| Method and path | Purpose | Auth | Answers |
| --- | --- | --- | --- |
| `GET /.well-known/oauth-protected-resource/mcp` and `GET /.well-known/oauth-protected-resource` | RFC 9728 PRM | none | `200` `{resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: ["dashboards"], bearer_methods_supported: ["header"], resource_name: "AutoLogger"}` |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 AS metadata | none | `200` `{issuer, authorization_endpoint: ISSUER+'/oauth/authorize', token_endpoint: ISSUER+'/oauth/token', registration_endpoint: ISSUER+'/oauth/register', revocation_endpoint: ISSUER+'/oauth/revoke', response_types_supported: ["code"], grant_types_supported: ["authorization_code","refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], revocation_endpoint_auth_methods_supported: ["none"], scopes_supported: ["dashboards"], authorization_response_iss_parameter_supported: true}` |
| `POST /oauth/register` | RFC 7591 DCR, public clients only | none; rate-limited | `201` client information; `400` `{error: "invalid_redirect_uri" \| "invalid_client_metadata"}`; `429` |
| `GET /oauth/authorize` | Validates the request, then shows the consent page, or sends the user to Google first | session cookie, if any | `200` consent HTML; `302` to Google; `302` back to `redirect_uri` with an error once that URI is validated; `400` HTML when `client_id` or `redirect_uri` is invalid (never redirect to an unvalidated URI) |
| `POST /oauth/authorize` | The consent decision (approve or deny) | session cookie plus a CSRF token | `302` to `redirect_uri` with `code`, `state` and `iss`, or with `error=access_denied` |
| `POST /oauth/token` | `authorization_code` and `refresh_token` grants, form-urlencoded | public client (`client_id` in the body) | `200` `{access_token, token_type: "Bearer", expires_in: 3600, refresh_token, scope}`; `400` `{error: "invalid_grant" \| "invalid_request" \| "unsupported_grant_type" \| "invalid_client"}`; `429` |
| `POST /oauth/revoke` | RFC 7009: revoke an access or refresh token, and with it the grant | public client | always `200`, even for unknown tokens (RFC 7009 §2.2) |
| `GET /api/oauth/connected-apps` | The "Connected apps" list | session cookie (`/api` login gate) | `200` `{apps: [{grant_id, client_name, redirect_host, created_at, last_used_at}]}` |
| `DELETE /api/oauth/connected-apps/:grantId` | Revoke one grant | session cookie | `204`; masked `404` for another user's or an unknown grant |

`/oauth/*` responses carry `Cache-Control: no-store`. The consent page also carries
`Content-Security-Policy: default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`
and `X-Frame-Options: DENY`, so it can't be framed for clickjacking. It is rendered server-side
by Hono's auto-escaping `html` helper, not by Next.

### 4.3 Dynamic client registration

- **Accepted:** `client_name` (1–100 characters, no control characters; stored and always shown
  as text), `redirect_uris` (1–5), `grant_types` ⊆ `["authorization_code","refresh_token"]`,
  `response_types` = `["code"]`, `token_endpoint_auth_method` = `"none"`, and an optional
  `application_type`. Other metadata fields are ignored, and none of them (`logo_uri`,
  `client_uri`, `policy_uri`) is ever fetched or rendered, so registration triggers no
  server-side request.
- **Redirect URIs:** each must be an absolute `https:` URL with no fragment, or a loopback
  `http://127.0.0.1` / `http://localhost` / `http://[::1]` URL with any port. The loopback form
  serves Claude Code and is matched ignoring the port, per RFC 8252 §7.3. Anything else gets
  `400 invalid_redirect_uri`. Authorization requests match the registered URI exactly, apart
  from the loopback port rule.
- **Issued:** `client_id` = `alc_` plus 16 random bytes in base64url. No secret is issued.
- **Storage:** `catalog.mcp_clients` (section 4.7).
- **Abuse bounds:** at most 10 registrations an hour per source address. An IPv4 address counts
  alone; an IPv6 address counts by its `/64` prefix, which closes the hole of rotating addresses
  inside one allocation. There are at most 10,000 live clients in total; past that, registration
  answers `429`. A client that never completed an authorization is deleted 24 h after it
  registered, by the sweeper (section 4.9). Claude registers a new client on each fresh connection
  (Claude's docs), so unused clients are expected and are cleaned up.

### 4.4 Authorization code flow and the Google login step

`GET /oauth/authorize` checks, in order:

1. `client_id` names a live client, and `redirect_uri` matches one of its registered URIs. If
   either fails, it answers `400` with a plain HTML error and **no redirect**.
2. `response_type=code`, `code_challenge` (43–128 characters of the PKCE alphabet) with
   `code_challenge_method=S256`, `resource` exactly equal to `RESOURCE`, `scope` absent or
   `dashboards`, and `state` present (at most 512 characters). A failure redirects to
   `redirect_uri` with `error=invalid_request` (or `invalid_scope` / `invalid_target`), plus
   `state` and `iss`.
3. Store the validated request in KV as `mcpauthz:<id>` (128-bit id, 10 min TTL).
4. If the request carries a valid session cookie, show the consent page for `mcpauthz:<id>`.
5. **If there is no session, go through the existing Google sign-in:**
   - Issue an OAuth state with `newOauthState()`, stored with the existing `putOauthState`
     prefix but with the value `mcp:<id>` instead of `1`.
   - Redirect to Google with the same `authorizationUrl` call and the same registered redirect
     URI (`${PUBLIC_BASE_URL}/auth/google/callback`), so the operator registers nothing new at
     Google.
   - `GET /auth/google/callback` changes in one place. `takeOauthState` returns the stored value
     (today it returns a boolean). On success, a value of the form `mcp:<id>` redirects to
     `/oauth/authorize/resume?request=<id>` instead of `/`. Every failure keeps its
     `/?login_error=<code>` redirect unchanged.
   - Every check of the sign-in itself is unchanged: closed sign-ups, disabled accounts, the
     Supabase Auth exchange and bootstrap claims. A user who couldn't sign in to the web app
     can't authorize a connector.
   - **With the flag off, no `mcp:` state is ever written, so the callback behaves exactly as
     today.**

`GET /oauth/authorize/resume?request=<id>` requires the session cookie and a live
`mcpauthz:<id>`, and shows the consent page. A missing or expired request answers a `400` HTML
page that says to start again from Claude.

**The consent page** shows:

- the signed-in user's email;
- the client name, labelled as given by the client;
- the redirect host in bold (for example `claude.ai`);
- what the app can do: "read every session you can open, and create, edit and delete dashboards
  in studios where you are an owner or admin";
- Approve and Deny buttons.

The form posts `request`, `decision` and `csrf`. `csrf` is an HMAC-SHA256, under
`MCP_SIGNING_SECRET`, of the request id and the SHA-256 of the session cookie, so a form lifted
from another session or request fails. The `Lax` cookie is not sent on a cross-site POST, which
blocks forged consent independently. Consent is asked on every authorization, with no silent
re-approval, because DCR gives every connection a new client.

**Approve** does the following:

- `take`s `mcpauthz:<id>`, so a request is approved at most once.
- Creates a grant row `(user, client, scope, resource)`.
- Issues `code` = 32 random bytes in base64url, stored as KV
  `mcpcode:<sha256(code)>` → `{grant_id, client_id, redirect_uri, code_challenge, resource, scope}`
  with a 60 s TTL.
- Redirects to `redirect_uri?code=…&state=…&iss=ISSUER`.

**Deny** redirects with `error=access_denied`.

### 4.5 Token endpoint

Both grants require `client_id` to match the stored client and the client to be live.

- **`authorization_code`**:
  - `take`s `mcpcode:<sha256(code)>`, which is one-shot and atomic across processes.
  - Requires `redirect_uri` to be identical to the stored one and `resource` to equal
    `RESOURCE`.
  - Requires `BASE64URL(SHA256(code_verifier)) === code_challenge`, compared in constant time.
  - On success it issues the first access and refresh token of the grant's chain. Any failure
    answers `400 invalid_grant`, and a code is never usable twice.
- **`refresh_token`**:
  - Hashes the token and runs one statement:
    `UPDATE mcp_refresh_tokens SET used_at = now WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now RETURNING grant_id`.
  - **If a row returns**, it checks the grant is not revoked and the user is enabled, then issues
    a new access token and a new refresh token in the same transaction. The new refresh token
    expires 30 days after issue; each rotation restarts the 30 days.
  - **If no row returns but the hash exists with `used_at` set**, that is **reuse**. The grant is
    revoked (`revoked_at`, with every access and refresh token of the grant deleted) in its own
    transaction. The server logs `mcp oauth: refresh reuse, grant <id> revoked` (ids only) and
    answers `400 invalid_grant`.
  - An unknown or expired token answers `400 invalid_grant`.
- **Token format:** access tokens are `alm_` and refresh tokens `alr_`, each followed by 32
  random bytes in base64url. Only `sha256(token)` (hex) is stored. Access tokens expire 3600 s
  after issue.
- **Rate limits:** 30 token requests a minute per client and 60 per source address (IPv6 by
  `/64`).

### 4.6 How a token maps to a user and roles on each call

`authContext` (`server/src/middleware/auth.ts`) gains one branch, beside the Companion one.

- **It applies only when `c.req.path === '/mcp'`, exactly, and the flag is on.**
  - On `/mcp`, the `Authorization: Bearer` header decides the caller and the cookie is ignored.
  - A Bearer header anywhere else is still ignored, as it is today outside `/api/companion/`.
- **Token checks:**
  - It hashes the token and reads `mcp_access_tokens` ⋈ `mcp_grants` as a system read under
    the existing reason `auth-resolve`.
  - It requires the token unexpired, the grant unrevoked and `resource = RESOURCE`, which is the
    audience check (RFC 8707). A token minted for another resource is refused.
  - It then reads the user with `authGetUserById`, which refuses disabled accounts.
- **On success** it sets:
  - `c.set('user', user)`;
  - `c.set('catalog', sys.forUser(user.id))`, keeping the one `.forUser(` site;
  - `c.set('mcpGrant', {id, clientId})`.
- It throttles a `last_used_at` update on the grant, at most once a minute, as `touch` does for
  devices.
- **On failure** it answers `401` with
  `WWW-Authenticate: Bearer resource_metadata="<ISSUER>/.well-known/oauth-protected-resource/mcp", scope="dashboards"`
  and a JSON-RPC-free body `{"detail":"Login required."}`. Claude needs the `401` to start
  sign-in.
- **No role, studio or session is carried in the token.** Every tool calls the existing checks
  on every call:
  - `requireSession` for reads;
  - `requireTeamRole` and then `requireTeamRoleIn` (inside the write's transaction) for writes.

  A demotion, removal, revoked grant on a show or disabled account therefore takes effect on
  the next call. The token's lifetime doesn't matter for authorization.

### 4.7 Storage

These tables are added by migration. All are **system-only**, like `companion_devices`: an
allow-all policy for `catalog_system`, no `catalog_user` policy, and `catalog_user` privileges
revoked. They are read and written only by the server's own code, under reviewed system reasons
added to `catalogSystem.repo.test.ts`: `mcp-oauth` for the OAuth routes and `mcp-sweep` for
cleanup. Lookups by user always carry the user id in the statement.

```sql
catalog.mcp_clients (
  id text primary key,                         -- alc_…
  client_name text not null check (char_length(client_name) between 1 and 100),
  redirect_uris_json text not null,            -- validated array, 1–5
  registered_from text not null,               -- the IPv4 address or the IPv6 /64 the limit counted
  created_at_utc text not null,
  last_authorized_at_utc text                  -- null until first successful consent
)
catalog.mcp_grants (
  id text primary key,
  user_id text not null references catalog.users(id) on delete cascade,
  client_id text not null references catalog.mcp_clients(id) on delete cascade,
  scope text not null, resource text not null,
  created_at_utc text not null, last_used_at_utc text, revoked_at_utc text
)
catalog.mcp_access_tokens (
  token_hash text primary key,                 -- hex sha256
  grant_id text not null references catalog.mcp_grants(id) on delete cascade,
  expires_at_utc text not null
)
catalog.mcp_refresh_tokens (
  token_hash text primary key,
  grant_id text not null references catalog.mcp_grants(id) on delete cascade,
  issued_at_utc text not null, expires_at_utc text not null, used_at_utc text
)
catalog.mcp_rate_windows (                     -- shape of provider_test_windows
  bucket text not null, window_start_ms bigint not null, count int not null,
  primary key (bucket, window_start_ms)
)
```

Authorization codes and pending authorize requests live in KV (`mcpcode:`, `mcpauthz:`), which
are TTL'd and taken atomically. Raw tokens, codes and verifiers are never stored or logged, and
neither is the `Authorization` header.

### 4.8 Revocation and "Connected apps"

- **Settings › Connected apps** is a new section beside `CompanionDevicesSection`
  (`web/src/pages/index/components/settings/`). It lists the signed-in user's live grants from
  `GET /api/oauth/connected-apps`: client name (as text), redirect host, connected and last-used
  times. Each row has a Revoke button, which calls `DELETE /api/oauth/connected-apps/:grantId`.
  That sets `revoked_at` and deletes the grant's tokens in one transaction. The client's next
  call gets `401` and has to reconnect.
- **With the flag off**, the section doesn't render: the list route doesn't exist, the web
  treats `404` as "feature off", and the profile shape is unchanged.
- `POST /oauth/revoke` lets the client revoke its own grant the same way.
- **Account and studio changes** need no extra revocation hook:
  - A disabled account fails the token lookup.
  - A deleted user cascades its grants.
  - A role or grant change is seen per call (section 4.6).

### 4.9 Cleanup

The sweep runs once a minute in every process, like the lease sweep in `server/src/main.ts`, and
deletes:

- expired access tokens;
- refresh tokens expired more than a day ago;
- revoked grants older than 30 days;
- clients with no live grant that are over 24 h old and never authorized, or whose last grant
  ended more than 30 days ago;
- rate windows older than an hour.

Each delete is bounded (`LIMIT 1000` per tick). KV entries expire by TTL through the existing
`purgeExpired`.

## 5. The MCP tool list

### 5.1 Transport and conventions

- **Endpoint.** `POST /mcp` uses Streamable HTTP in stateless mode (no `Mcp-Session-Id`), with
  protocol `2025-11-25` as negotiated by the pinned SDK.
  - `GET /mcp` and `DELETE /mcp` answer `405` with `Allow: POST`.
  - Requests whose `Origin` header is present and is not `https://claude.ai` (or listed in
    `MCP_ALLOWED_ORIGINS`) get `403`. This follows the transport's Origin-validation rule against
    DNS rebinding; server-to-server calls send no `Origin`.
  - Bodies over 512 KiB get `413`.
- **Server info:** `name` is `autologger`. Capabilities: `tools`, `resources`, and the
  `io.modelcontextprotocol/ui` extension.
- **Tool shapes.** Every tool declares a zod input schema, with unknown keys refused, and an
  `outputSchema`. It returns `structuredContent` plus a short `text` rendering.
- **Errors.** A tool error returns `isError: true` with a fixed text. Errors never carry
  provider, SQL or stack detail, following `redactDatabaseError`. The fixed texts are:
  - `Session not found` (masked, same as `requireSession`);
  - `Dashboard not found` (masked);
  - `Studio not found`;
  - `Owner or admin role required.`;
  - `Revision conflict: current revision is N.`;
  - `Invalid cursor.`;
  - `Rate limit exceeded; retry in N s.`;
  - the validation messages of section 7.
- **Rate limit:** each user gets 120 tool calls a minute and 2,000 an hour, across processes
  (`mcp_rate_windows`).

### 5.2 Paging contract (every list tool)

- **Input:** `cursor?: string` and `limit?: integer`. A missing `limit` uses the tool's default,
  and a `limit` above the tool's maximum is clamped to it, never refused.
- **Output:** `{items: [...], next_cursor: string | null, total: integer, truncated: boolean, note?: string}`.
- **The cursor** is base64url JSON
  `{v: 1, t: <tool>, s: <session_id or scope id>, k: <position key>, r: <revision seen>}`.
  - It carries no authority. Every call re-authorizes `session_id` from the arguments.
  - A cursor whose `t` or `s` doesn't match the call gets `Invalid cursor.`
  - The position key is the last item's stable sort key: `ordinal` for words and paragraphs, and
    `(timecode_total_frames, id)` for events, which are offset-paged at the hub and re-anchored
    by key. If the session changed since the cursor was issued (`r` differs from the hub's
    revision), the page still continues from the key and `note` says
    `"session changed since the first page"`. Data is live (decision 8), so a reader sees
    current rows.
- **Character cap.** Every result is capped at **40,000 characters** of serialized
  `structuredContent`, below the 45,000-character bound the repo already uses for tool results
  (`GENERATION_PAGE_MAX_CHARS`).
  - When `limit` items would exceed the cap, the page ends early, `truncated` is `true`, and
    `next_cursor` continues from the last included item.
  - A single item over the cap (a 100,000-character wiki body) is never returned whole by a
    list tool; `get_wiki_page` pages it by characters.
- **Totals:** `total` is the full count for the session, so Claude can state coverage.

### 5.3 Tools

**Model-visible read tools.** Authorization is per call. *Reader* means `requireSession` passes
for the token's user.

| Tool | Input | Output items | Default / max limit | Authorization | Reads |
| --- | --- | --- | --- | --- | --- |
| `list_studios` | — | `{studio_id, name, role}` | all (≤ 100) | memberships of the user | `user_studio_memberships`, `studio_definitions` |
| `list_shows` | `studio_id, cursor?, limit?` | `{show_id, name, show_code, can_access}` | 50 / 200 | member of the studio (masked `Studio not found`) | shows, same `can_access` rule as `/api/profile` |
| `list_sessions` | `show_id, cursor?, limit?, include_hidden?` | `{session_id, title, date, archived, hidden}` | 50 / 200 | `requireShowAccess` | session index |
| `get_session` | `session_id` | `{session_id, show_id, studio_id, title, date, fps, counts: {events, words, paragraphs, topics, wiki_pages}, revision}` | — | reader | session index row, hub counts |
| `list_events` | `session_id, cursor?, limit?` | the event wire shape of `GET /api/sessions/:id/events` (`EventRpc`) | 200 / 500 | reader | `SessionHub.listEvents` |
| `list_transcript_paragraphs` | `session_id, cursor?, limit?` | `{ordinal, speaker, session_time, start_sec, end_sec, text}` | 100 / 300 | reader | `listTranscriptEnrichment().paragraphs` |
| `list_transcript_words` | `session_id, cursor?, limit?` | `{ordinal, session_time, speaker, word, start_sec, end_sec}` | 1,000 / 3,000 | reader | `listTranscriptWords` |
| `list_topics` | `session_id, cursor?, limit?` | `{id, session_time, duration_sec, topic_level, summary, …}` (the topics wire shape) | 200 / 500 | reader | `listTopics` |
| `get_session_aggregates` | `session_id` | the `aggregates.ts` results (talk time, event counts by category, topic timeline), each `{available, reason?}` | — | reader | hub rows through `packages/ai-runtime/src/aggregates.ts` |
| `list_wiki_pages` | `session_id, cursor?, limit?` | `{page_id, kind, title, aliases, revision, association: "session_page" \| "cites_session" \| "linked_from_session_page", body_chars}` | 20 / 50 | reader | associated pages (section 5.4) |
| `get_wiki_page` | `session_id, page_id, offset?, max_chars?` | `{page_id, kind, title, revision, body_md (slice), offset, next_offset, body_chars}` | 20,000 / 40,000 chars | reader, **and** the page is associated with that session | `wikiStore.getPage` under the user binding (RLS) |

**Dashboard tools.**

| Tool | Input | Output | Authorization | Notes |
| --- | --- | --- | --- | --- |
| `list_dashboards` | `session_id` **or** `studio_id`, `cursor?, limit?` (20 / 100) | `{dashboard_id, title, scope, show_ids, revision, updated_at, updated_by_name}` | with `session_id`: reader, and the list is the session's dashboards plus the applicable templates (section 6.3); with `studio_id`: a manager sees all of the studio's, and a member sees the applicable templates of the shows they can access | metadata only, never code |
| `get_dashboard` | `dashboard_id, revision?` | `{dashboard_id, title, scope, show_ids, revision, tsx, created/updated by and at}` | the dashboard is visible to the user (section 6.3) | the source TSX, so Claude can edit it |
| `list_dashboard_revisions` | `dashboard_id, cursor?, limit?` (20 / 20) | `{revision, title, author_name, created_at, tsx_chars}` | visible to the user | at most 20 exist |
| `save_dashboard` | `{dashboard_id?, expected_revision?, title, tsx, scope: {kind: "session", session_id} \| {kind: "template", studio_id, show_ids?: string[]}}` | `{dashboard_id, revision}` or validation errors | **manager** of the target studio (`requireTeamRole`, then `requireTeamRoleIn` inside the transaction); for the session scope, also reader of the session; on update, `expected_revision` is required and compared and set | create when `dashboard_id` is absent. Validation and compile follow section 7. A dashboard's scope kind and studio can't change; a template's `show_ids` can. |
| `delete_dashboard` | `dashboard_id, expected_revision` | `{deleted: true}` | manager of its studio | permanent, revisions included |
| `restore_dashboard_revision` | `dashboard_id, revision, expected_revision` | `{dashboard_id, revision}` (a new revision whose content is the old one) | manager | the restored code is re-validated and recompiled against today's allowlist |
| `preview_dashboard` | `{session_id, title, tsx}` | UI result (section 8): View with the compiled draft | **manager** of the session's studio, and reader of the session | validates and compiles, stores nothing; lets Claude show a draft before saving |
| `open_dashboard` | `{session_id, dashboard_id, revision?}` | UI result: View with the compiled code and a binding | reader of the session, and the dashboard applies to the session (section 6.3) | the viewing path in Claude |

**App-only tool**, with `_meta.ui.visibility: ["app"]`, so the model never sees or calls it:

| Tool | Input | Output | Authorization |
| --- | --- | --- | --- |
| `dashboard_data` | `{binding, query}`, where `query` is one of the typed queries of section 8.4 | the query's page | valid binding (section 8.3) for the token's own user, then `requireSession` for the binding's session, as the token's user |

`preview_dashboard` and `open_dashboard` declare `_meta.ui.resourceUri: "ui://autologger/dashboard-view"`
and `_meta.ui.visibility: ["model", "app"]`.

There is no tool that writes session data. There are no tools for audio, exports, recording,
Companion, provider keys, admin, teams or invites (decision 11).

### 5.4 "Associated wiki pages", precisely

For session `S`, whose show is `H`, a wiki page `P` is **associated with S** when `P` belongs to
`H`, is live (`deleted_at_utc IS NULL`) and is not merged (`merged_into IS NULL`), and at least one of
these holds:

1. **Session page:** `P.kind = 'session'` and `P.session_id = S`. There is at most one, per
   show-wiki.
2. **Cites the session:** `P`'s current `body_md` contains at least one citation to `S`, as
   found by `citationsOf` (`packages/contract`, the parser the renderer and the wiki checks
   already use). A citation is a link that passes the show-wiki citation grammar with session
   `S`, in any of the rendered forms (inline, reference, autolink).
3. **Linked from the session page:** `P` is the target of a `wiki:<page_id>` link in the current
   body of the page from rule 1. This is one hop only; links from those pages are not followed.

How it is computed:

- Rule 2 is evaluated with a show-scoped pre-filter, so the scan never leaves `H`:
  `strpos(lower(body_md), lower('cite:' || S || '@')) > 0`, plus the reference-definition and
  angle-bracket forms. The parser then confirms each candidate. There is no citation index today;
  adding one is out of scope unless measurement shows the scan is slow (section 13).
- Rule 3 uses `parseWikiLinks` on the session page's body.
- Ordering is rule 1 first, then rule 2 by title, then rule 3 by title. A page that matches
  several rules is listed once, under its first rule.

Every read runs under the user binding, so wiki row-level security applies on top of
`requireSession`.

## 6. The dashboard data model

### 6.1 Tables

These tables are new and separate from `catalog.session_dashboards` (v2), which is untouched.

```sql
catalog.custom_dashboards (
  id text primary key,                               -- uuid
  studio_id text not null references catalog.studio_definitions(id),
  scope text not null check (scope in ('session','template')),
  session_id text references catalog.sessions(id),   -- set iff scope = 'session'
  show_ids_json text not null default '[]',          -- template only; [] = every show of the studio
  title text not null check (char_length(title) between 1 and 200),
  revision int not null,                             -- current revision number
  source_session_id text,                            -- the session Claude was looking at when it created it (audit only)
  created_by text not null, created_by_name text not null, created_at_utc text not null,
  updated_by text not null, updated_by_name text not null, updated_at_utc text not null,
  check ((scope = 'session') = (session_id is not null))
)
catalog.custom_dashboard_revisions (
  dashboard_id text not null references catalog.custom_dashboards(id) on delete cascade,
  revision int not null,
  title text not null,
  tsx text not null,                                 -- the source as saved
  compiled_js text not null,                         -- the compiler's output (section 7.4)
  compiler_version text not null,
  author_id text not null, author_name text not null, created_at_utc text not null,
  primary key (dashboard_id, revision)
)
```

- **Row-level security:**
  - `catalog_user` may `SELECT` a session-scoped dashboard when it can access the session's
    show.
  - It may `SELECT` a template of a studio it is a member of. Applicability to a session is
    checked in code (section 6.3).
  - `INSERT`, `UPDATE` and `DELETE` require a manager role in the row's studio, checked by the
    same predicate functions the show-grant policies use.
  - The routes also check, so the policies are the backstop, as for the wiki.
- **Deleting a session or show:** a session that is deleted for good cascades its session-scoped
  dashboards. A show removed from a template's `show_ids` is dropped from the list when the
  template is next saved, and an unknown show id in the list is ignored at read time.

### 6.2 Revisions, history and delete

- Every save writes revision `n+1` in one transaction with the head update, compare-and-set on
  `expected_revision`. It then deletes revisions `<= n+1-20`, so **at most 20 are kept**. Revision
  numbers keep increasing; they never reuse a pruned number.
- Restore copies a kept revision's `title` and `tsx` into a new revision, re-validates and
  recompiles it, and prunes the same way. Restoring a pruned revision gets `Revision not found`.
- **Delete is permanent.** It removes the dashboard row, and its revisions go by cascade. There
  is no soft delete and no undo, so the MCP tool description says so.
- Each revision records its author id and name (names as at write time, as the wiki does) and
  its time.

### 6.3 Session-attached vs studio template, and the show restriction

- A **session dashboard** belongs to one session. It is visible to readers of that session, and
  only there.
- A **studio template** belongs to one studio. Its `show_ids` is either empty, meaning every show
  of the studio, or a list of up to 100 shows of that studio. Saving a show from another studio is
  refused.
- **A template applies to session `S`** when it belongs to `S.show.studio_id`, and either its
  `show_ids` is empty or `S.show_id` is in it.
- **Who sees what:**
  - A reader of `S` sees `S`'s session dashboards plus every template that applies to `S`, with
    session dashboards listed first.
  - Opening a template against a session that it doesn't apply to is masked as
    `Dashboard not found`.
- **Rendering:** a template always renders with data from the session it is opened for, under
  the viewer's permissions. It never uses the session it was designed on.

### 6.4 Size limits

| Item | Limit |
| --- | --- |
| `tsx` source | 100,000 characters, no NUL |
| compiled JS | 300,000 characters (refused, not truncated) |
| `title` | 1–200 characters, no control characters |
| dashboards per session | 20 |
| templates per studio | 100 |
| `show_ids` per template | 100 |
| kept revisions per dashboard | 20 |
| import specifiers per dashboard | 60 |

## 7. The import allowlist and save-time validation

### 7.1 What runs where

Validation and compilation run in the api process, on `save_dashboard`,
`restore_dashboard_revision` and `preview_dashboard`, before anything is stored or shown. They
are **an early refusal, not the security boundary.** The boundary is the runtime sandbox
(sections 8 and 9), which assumes the compiled code is hostile.

### 7.2 Allowlist

A dashboard may import only these module specifiers:

| Specifier | Exports offered | Notes |
| --- | --- | --- |
| `react` | `useState`, `useMemo`, `useEffect`, `useReducer`, `useCallback`, `useRef`, `Fragment`, and the default `React` | no `react-dom`, no portals |
| `@autologger/dashboard` | the data hooks and helpers of section 8.4 (`useSession`, `useEvents`, `useTranscriptParagraphs`, `useTranscriptWords`, `useTopics`, `useWikiPages`, `useWikiPage`, `useAggregates`), formatters (`formatTimecode`, `formatDuration`), and `Unavailable` (the explicit unavailable state) | the only data path |
| `@/components/ui/<name>` | the shadcn components in `web/src/shared/components/ui/` that render without portals or browser-only APIs. Starting set: `alert`, `avatar`, `badge`, `button`, `card`, `checkbox`, `empty`, `field`, `input`, `item`, `kbd`, `label`, `radio-group`, `scroll-area`, `separator`, `skeleton`, `spinner`, `table`, `tabs`, `textarea`, `toggle`, `toggle-group`, `tooltip` | The portal-based components (`dialog`, `alert-dialog`, `drawer`, `sheet`, `popover`, `dropdown-menu`, `select`, `command`, `sonner`, `sidebar`) are left out of v1: they render outside the dashboard root and add focus traps that a hostile dashboard could misuse. The list is a constant in `packages/contract`, shared by the validator and the runtime, and a repo test pins it to the files that exist. |
| `@/lib/utils` | `cn` | class merging |

Only named imports are allowed, plus `import React from 'react'`. Namespace imports
(`import * as x`) are allowed only for `react`.

### 7.3 Validation rules (all refusals name the first problem, with line and column)

- **Parsing.** The source must parse as TSX (ES2022 and JSX). The build job picks a pinned
  parser and transformer that runs in Node without native binaries (candidates are `sucrase`
  for the transform and `acorn` with `acorn-jsx` for the AST). It records the choice under the
  dependency review of ADR 0012. TypeScript 7's native compiler has no in-process JS API to rely
  on.
- **Imports.** Every `import` is static, and each specifier and imported name is on the
  allowlist. These are refused:
  - `import()`, `require`, `export … from`, `import.meta`;
  - `export *`;
  - `<script>` and `<iframe>` JSX intrinsic elements;
  - `dangerouslySetInnerHTML`, `srcDoc` and `ref` callbacks on intrinsic elements;
  - `on*` attributes whose value is a string literal.
- **Exports.** There must be exactly one `export default`, which is a function component.
- **Lint-level denylist** (an early refusal of the obvious; the sandbox still assumes it can be
  evaded): any reference to the identifiers below is refused.
  - Network: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator`.
  - Messaging: `postMessage`, `parent`, `top`, `opener`, `frames`.
  - Window and document: `window`, `globalThis`, `self`, `document`, `location`, `history`.
  - Code evaluation: `eval`, `Function`, `importScripts`.
  - Storage: `localStorage`, `sessionStorage`, `indexedDB`, `caches`.
  - Workers: `Worker`, `SharedWorker`, `ServiceWorker`.
  - Timers and URLs: `setInterval` (`setTimeout` is allowed), `URL.createObjectURL`.
- **Size.** The limits of section 6.4 apply.
- **Text.** The source must contain no NUL (api-contract-freeze "Text containing NUL is refused").

### 7.4 Compilation

TSX is transformed to an ES2020 function body with:

- JSX through the automatic runtime's `jsx` and `jsxs`, which the runtime provides;
- imports rewritten to `__import("<specifier>")` calls that read a frozen registry inside the
  runtime;
- the default export assigned to `__exports.default`.

The output is stored with `compiler_version`. A runtime that sees a newer `compiler_version`
than it supports refuses to run the code and shows "needs a newer viewer".

## 8. The MCP App View

The target is the MCP Apps extension `io.modelcontextprotocol/ui`, stable revision 2026-01-26
(<https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx>),
with the `@modelcontextprotocol/ext-apps` SDK. Release 2.0.x, whose wire protocol is unchanged
from 1.x, is pinned exactly by the build job.

### 8.1 The View resource

- **URI and type:** `ui://autologger/dashboard-view`, MIME `text/html;profile=mcp-app`, served
  by `resources/read`.
- **Content:** one self-contained HTML document, with the View's script and styles inlined and
  built by the build job from `packages/dashboard-view`.
- **Resource `_meta.ui`:**
  - `csp.connectDomains: []`, so the View itself makes no network requests and all data goes
    through `tools/call`.
  - `csp.resourceDomains: []`.
  - `csp.frameDomains: [DASHBOARD_RUNTIME_ORIGIN]`, which is the only frame it may create.
  - `prefersBorder: true`.
  - No `permissions` (no camera, microphone, geolocation or clipboard).
- The View never calls `ui/message`, `ui/update-model-context` or `ui/open-link`, so nothing a
  dashboard renders can reach the conversation or open a link through the host.

### 8.2 The nested-sandbox protocol

1. On `ui/notifications/tool-result` for `open_dashboard` or `preview_dashboard`, the View reads
   `structuredContent`: `{binding?, dashboard: {id?, title, revision?}, compiled_js, compiler_version, session: {id, title}}`.
2. The View creates
   `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" src="<DASHBOARD_RUNTIME_ORIGIN>/runtime/v1/frame.html">`.
   - There is no `allow-same-origin`, so the frame's origin is opaque. It can't read cookies or
     storage of any origin, and every request it could make is credential-less.
   - There is no `allow-popups`, `allow-forms`, `allow-top-navigation`, `allow-modals` or
     `allow-downloads`.
3. **Runtime frame response headers** (served by the api for the runtime host only):
   - `Content-Security-Policy: default-src 'none'; script-src <DASHBOARD_RUNTIME_ORIGIN> 'unsafe-eval'; style-src <DASHBOARD_RUNTIME_ORIGIN> 'unsafe-inline'; img-src data: blob:; font-src <DASHBOARD_RUNTIME_ORIGIN>; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors https:`.
   - `connect-src 'none'` closes `fetch`, XHR, WebSocket, EventSource and beacons.
   - `'unsafe-eval'` is scoped to this one document; it is how the runtime turns compiled code
     into a function.
   - `frame-ancestors https:` is deliberate. The host's View origin isn't ours to pin, and the
     frame holds no secret: it only runs what its parent hands it, with no network.
   - The headers also include `Cross-Origin-Opener-Policy: same-origin`,
     `Cross-Origin-Resource-Policy: cross-origin`, `Referrer-Policy: no-referrer`,
     `X-Content-Type-Options: nosniff` and `Permissions-Policy` with every feature `()`.
4. **The handshake:**
   - On the frame's `load`, the View makes a `MessageChannel` and posts
     `{type: "autologger-dashboard-init", v: 1}` with `port2` transferred, to
     `iframe.contentWindow`, with target origin `"*"`. An opaque origin can only be addressed as
     `"*"`; the message carries no data, only the port.
   - The frame accepts the first such message from `window.parent` only, and ignores later
     ones.
   - All further traffic uses the port. The View accepts messages only on its own `port1`, never
     on `window`, so other frames can't inject.
5. Over the port, the View sends `{type: "load", compiled_js, compiler_version}`. The frame
   evaluates the code with `new Function("__import", "__exports", "jsx", "jsxs", code)`, giving
   it the frozen registry, and renders the default export inside an error boundary.
6. **Queries** go frame → View as `{type: "query", id, query}`, and the View answers
   `{type: "result", id, page}` or `{type: "error", id, message}` (section 8.4).
7. **Liveness:** the View sends `{type: "ping"}` every 2 s. If no `pong` arrives within 6 s, the
   View removes the iframe and shows "This dashboard stopped responding". A dashboard that loops
   forever is cut off.
8. **Size:** the frame reports its content height with `{type: "size", height}`. The View clamps
   it to 4,000 px and forwards it with `ui/notifications/size-changed`.

### 8.3 How the session id is pinned

- The session is fixed **by the tool call that opened the View**, never by the dashboard code:
  - `open_dashboard` authorizes the session and the dashboard;
  - `preview_dashboard` authorizes the session.
- The tool result carries a **binding**: base64url of
  `{v: 1, u: user_id, g: grant_id, s: session_id, d: dashboard_id | null, exp: now + 1 h}` plus
  an HMAC-SHA256 tag under `MCP_SIGNING_SECRET`.
- **The View keeps the binding and never gives it to the frame.** The frame's query messages
  have no session field, and the View adds the binding to every `dashboard_data` call.
- **`dashboard_data` checks, in order:**
  1. the tag;
  2. `exp`;
  3. `u` equals the token's user and `g` its grant, so a binding from another user or connection
     is refused;
  4. `requireSession(s)` as the token's user, so access is re-checked on every query.
- Neither the model nor the frame can choose another session:
  - `dashboard_data` is app-only, so the model can't call it.
  - The frame never sees the binding.
  - A View is ours and passes only its own binding.
- An expired binding gets `Binding expired; reopen the dashboard.` The View offers a "Reload"
  button, which calls `open_dashboard` again through `tools/call`. `open_dashboard` is visible to
  the app.

### 8.4 The typed query API

`@autologger/dashboard` exposes React hooks that send queries over the port. The query is a
discriminated union, validated by the View, and again by the server, with the same zod schema
from `packages/contract`:

```ts
type DashboardQuery =
  | { kind: 'session' }
  | { kind: 'events'; cursor?: string; limit?: number }
  | { kind: 'transcript_paragraphs'; cursor?: string; limit?: number }
  | { kind: 'transcript_words'; cursor?: string; limit?: number }
  | { kind: 'topics'; cursor?: string; limit?: number }
  | { kind: 'wiki_pages'; cursor?: string; limit?: number }
  | { kind: 'wiki_page'; page_id: string; offset?: number; max_chars?: number }
  | { kind: 'aggregates' };
```

- **Shapes and limits.** Each kind returns exactly the item shape, paging contract and limits of
  the matching read tool in section 5.3. Both are served by one query service
  (`server/src/dashboards/query.ts`), so the MCP tools, `dashboard_data` and the web route can't
  drift.
- **Hook behavior.**
  - Each hook returns `{data, error, loading, hasMore, loadMore}`.
  - `useEvents({all: true})` and the other `all: true` forms follow cursors up to the render
    budget.
  - Missing timing data surfaces as the aggregates' `{available: false, reason}`, which
    `Unavailable` renders. It never shows as zero, matching the v2 rule that data unavailability
    is a rendered state.
- **Per-render budget,** enforced by the View: at most 4 queries in flight, 300 queries and
  20 MB of results per load. A dashboard that exceeds it gets errors from then on, and the View
  shows "This dashboard asked for too much data".

## 9. The web viewer

### 9.1 Where it appears

- The session's **Dashboards** tab gets a "Custom dashboards" section **above** the v2
  dashboard editor. The tab's identity, order and mounted-hidden behavior (web-session-console
  "Workspace tab IA") are unchanged.
- The section lists `GET /api/sessions/:sessionId/custom-dashboards`. The list response is
  `{dashboards: [{id, title, scope, revision, updated_at, updated_by_name}], runtime_origin}`.
- Each list item is labelled "Custom" (and "Template" for a template), and opens a viewer pane.
- **When that route answers `404`** (the flag is off), the section doesn't render and the tab
  looks exactly as it does today.
- Viewing only. Creating and editing happen through Claude (decision 3).

### 9.2 The separate-origin runtime

- **Loading the code.** The viewer pane loads `GET /api/custom-dashboards/:dashboardId?session=:sessionId`.
  - It answers `{id, title, revision, compiled_js, compiler_version}`.
  - It requires a reader of the session and a dashboard that applies to it; otherwise it gives
    the masked `404`.
- **The frame.** The pane creates the same iframe as section 8.2, from
  `runtime_origin + '/runtime/v1/frame.html'`, with the same sandbox attribute, the same
  `MessageChannel` handshake and the same port protocol.
  - The web app is the parent here.
  - The runtime bundle is **the same build** as the one the View frames, so Claude and the web
    render identically.
- **The app origin's own CSP.** It gains `frame-src <runtime_origin>` only on pages that render
  the section. Today the app sets no CSP (checked: no `Content-Security-Policy` in `server/src`,
  `web/next.config.ts` or `web/src`), so this adds a header without loosening one.

### 9.3 Data under the viewer's permissions, without their credentials

The parent (the web page, on the app origin) answers each query from the frame by calling
`POST /api/sessions/:sessionId/custom-dashboards/query` with body `{query}`:

- The call goes **from the parent**, with the viewer's `HttpOnly` cookie, which the browser
  attaches.
- The route runs `requireSession` as the viewer and calls the same query service.

The frame never holds the cookie, a token or a URL it could call:

- it is on an opaque origin, under `connect-src 'none'`;
- its only output is messages on the port;
- the parent decides the session id (from the page's route) and the endpoint.

**What a hostile dashboard can do in a viewer's browser:**

- ask the parent for pages of the one session being viewed, which the viewer can already read;
- render anything inside its own frame;
- burn CPU until the watchdog cuts it off.

**What it can't do:**

- read the cookie;
- call any other API;
- reach another session;
- write anything;
- navigate the page;
- open windows;
- talk to the network.

## 10. The opt-in flag and config

### 10.1 Settings

| Variable | Required when on | Meaning |
| --- | --- | --- |
| `CUSTOM_DASHBOARDS_ENABLED` | — | Opt-in. `1`, `true` or `yes` enables, case-insensitively after trimming, as `AI_V2_ENABLED` does. Unset, empty or anything else means **off**. |
| `PUBLIC_BASE_URL` | already required in every stack | When the flag is on, it must parse as an `https:` origin with no path, query or fragment. Otherwise boot is refused, naming the variable. The flag can't be turned on in the dev stack's `http://localhost` setup; use a stage with `STAGE_PUBLIC_BASE_URL`. |
| `DASHBOARD_RUNTIME_ORIGIN` | yes | An `https:` origin with no path, whose host differs from `PUBLIC_BASE_URL`'s. A host equal to the app's is refused. A same-site host is allowed, with a boot warning that recommends a separate registrable domain. |
| `MCP_SIGNING_SECRET` | yes | At least 32 characters, server-only, kept in OpenBao like `FRAME_BUS_SECRET`. It signs bindings and consent CSRF tokens. Rotating it invalidates open Views and pending consents only. |
| `MCP_ALLOWED_ORIGINS` | no | Extra `Origin` values accepted on `/mcp`, beyond `https://claude.ai`. |

The boot guard (`server/src/bootGuard.ts`, `checkBootEnv`) applies these checks only when the
flag is on. Its messages name variables, never values (web-frontend-platform).

### 10.2 What exists when it is on

- the routes of section 12.1;
- the `authContext` `/mcp` bearer branch;
- the `mcp:` OAuth state value and its resume redirect;
- the runtime-origin host handler;
- the sweeper's MCP cleanup;
- the web sections (Connected apps, Custom dashboards), which appear because their list routes
  answer.

### 10.3 Router, proxy and allowlist (the operator's part)

- **Caddy (`docker/Caddyfile`): the new rules exist only when the flag is on.** They can't be
  always present. In the split topology `web:3000` answers today's GETs on these paths with
  Next's not-found HTML, but the production `api` image is API-only and its frontend bridge
  answers the same GETs with Hono's plain-text `404 Not Found` (section 2, "Frontend bridge").
  An always-present rule would change those answers on deployments that never opt in.
  - **Mechanism.** The Caddyfile defines two snippets, `(custom-dashboards-off)`, which is empty,
    and `(custom-dashboards-on)`, which holds the new rules. One line, placed after rule 5 and
    before rule 6, imports one of them:

    ```
    import custom-dashboards-{$ROUTER_CUSTOM_DASHBOARDS:off}
    ```

    Caddy resolves the placeholder from the router container's environment when it adapts the
    file at start-up, as it already does for `ROUTER_FRONT_GW` and `ROUTER_BACK_GW`. A snippet
    definition that isn't imported adds nothing to the config.
  - **The `on` snippet** holds exact-path rules, in the file's raw-URI CEL style, that send these
    GET/HEAD paths to `api:8787`:
    - `/.well-known/oauth-protected-resource`;
    - `/.well-known/oauth-protected-resource/mcp`;
    - `/.well-known/oauth-authorization-server`;
    - `/oauth/authorize`;
    - `/oauth/authorize/resume`;
    - `/mcp`.

    It also holds a host rule that sends every request whose `Host` is the runtime host to
    `api:8787`. That host reaches the router through a variable J6 names; `check-envs.sh`
    requires it to be a bare host name, so a value can't break out of a matcher (as
    `hostile_ports` does for ports). Look-alikes and percent-encoded variants are not matched;
    the deferred job 016's acceptance criteria are reused.
  - **The router variable.** `compose.yaml` sets `ROUTER_CUSTOM_DASHBOARDS:
    ${ROUTER_CUSTOM_DASHBOARDS:-off}` on both the `router` and the `api` service, so an unset or
    empty value resolves to `off`. The operator sets it to `on`, in the same OpenBao secret, when
    they set `CUSTOM_DASHBOARDS_ENABLED`. `check-envs.sh` requires the resolved value to be
    exactly `on` or `off`. Caddy itself refuses most other values, because it looks for an
    import file (`File to import not found: custom-dashboards-true`) and won't start, but it
    accepts a value such as `on x` as `on` with an extra argument, so the check is needed. Invariant 10 changes
    from "the router's `environment` is empty" to "it holds exactly `ROUTER_CUSTOM_DASHBOARDS`
    (plus the gateway variables only in non-prod stacks)".
  - **The two settings can't disagree.** When `ROUTER_CUSTOM_DASHBOARDS` is present in the api's
    environment (only the split-topology stacks set it), the boot guard refuses to start unless
    it is `on` exactly when the flag is on, and names both variables. The router depends on a
    healthy api, so a mismatched pair never serves traffic. The dev single-process stack sets no
    router variable, so the check doesn't apply there.
  - **For the approver.** The router setting, its name, its `on`/`off` values and the need for
    two agreeing settings in the split topology are design choices, not human decisions. They
    are open question 6 in section 13.3.
  - **With the flag off the router config is byte-identical to today's.** Adapting the gated
    Caddyfile with the variable unset, or set to `off`, produces exactly the committed
    `docker/scripts/caddy-adapt.baseline.json`; with `on`, the only differences are the new rules
    and the renumbered route groups. This was checked with a prototype of the snippets on the
    pinned router image while this design was revised (job 022, proof round 1). Invariant 13 keeps
    its existing baseline; J6 adds a second baseline for `on`.
- **The runtime host** has to resolve to the same tunnel or proxy as the app, with its own TLS
  certificate. The api serves only `/runtime/v1/*` on that host and answers `404` for everything
  else there, including `/api`, `/mcp` and `/auth`, by checking `Host` before routing. This is
  why the boot check requires a distinct host.
- **`IP_ALLOWLIST`.** When it is set, the operator has to add Anthropic's connector egress range
  (`160.79.104.0/21`, from Claude's connector docs) for `/mcp` and the token and registration
  endpoints to work. With the flag on and `IP_ALLOWLIST` set, boot logs a warning that names the
  documentation, not the range. The allowlist itself is not changed by this design.

### 10.4 What exactly is unchanged when it is off

- **Routes:** none of the routes of section 12.1 is mounted.
  - `GET` and `HEAD` on `/mcp`, `/oauth/*` and `/.well-known/*` get today's answer in each
    topology. In the split topology no new router rule is imported (section 10.3), so they still
    reach `web:3000` and get Next's not-found document. In the single-process server they fall
    through to the frontend bridge, as today.
  - `POST`, `PUT` and `DELETE` on them get Hono's `404`, as today.
  - The new `/api/...` routes get the `/api` not-found answer, as any unknown `/api` path does
    today.
- **Auth:**
  - `authContext` ignores Bearer headers outside `/api/companion/`, as today.
  - The Google callback never sees an `mcp:` state, so every redirect is unchanged.
- **Headers:** no new response header on any existing route. The CSP of section 9.2 is sent
  only on pages that render the custom section, which doesn't render when the flag is off.
- **Web:**
  - The Dashboards tab and Settings render as today.
  - The two new list requests each cost one `404` per tab or Settings open. They are client-side
    requests, not a change to any existing route.
- **Router:** the adapted Caddy config is byte-identical to the committed baseline
  (section 10.3). The api never sees the GETs that `web:3000` answers today.
- **Boot:**
  - Boot needs nothing new. `ROUTER_CUSTOM_DASHBOARDS` resolves to `off` when unset, which
    agrees with the flag being off.
  - The new migrations create **empty** tables, which is not observable through the contract.
  - The sweeper's MCP deletes find nothing.
- **Unaffected surfaces:** the WebSocket, v2 dashboards, AI chat, the generation features,
  Companion and exports.

## 11. Threat model

This model follows `docs/security.md`. That file covers coding agents and, in its "Known gaps"
entries, the app's own AI surfaces. Each build job adds an entry there, in that style (control,
then residuals). Session content is untrusted data (security.md ASI01). A dashboard's code is
treated as attacker-controlled from the moment it is saved.

| # | Threat | Mitigation | Residual |
| --- | --- | --- | --- |
| T1 | **Prompt injection through session content into dashboard code.** A transcript line, event note, topic or wiki page tells Claude to write code that exfiltrates data or misleads viewers. | **(a)** The sandbox makes exfiltration impossible: there is no network (`connect-src 'none'`), the origin is opaque, and the only channel is queries for the bound session, under the viewer's permissions (sections 8 and 9). **(b)** Validation refuses network, eval and DOM-escape identifiers and non-allowlisted imports as an early signal (section 7). **(c)** Only managers can save, and saves are attributed with revisions, so a bad dashboard is traceable and revertible (section 6). **(d)** The MCP surface has no session-data writes and no tools beyond dashboards (decision 11), so an injected instruction can't change session data. **(e)** The View never calls `ui/message` or `ui/update-model-context`, so a rendered dashboard can't inject back into the conversation. | A dashboard can still **show** false or misleading content about data the viewer can read (a fake "0 events", an injected banner). Attribution, revisions and manager-only writes are the control. A user is asked to approve a save in Claude's tool-approval UI, per their client settings. |
| T2 | **Malicious TSX tries to reach the host bridge, the user's tools, other sessions, cookies or the network.** | **Host bridge and tools:** the code runs in a nested frame, not in the View. It has no reference to the host's `window.parent` channel: its parent is the View, which listens only on a private `MessagePort` and implements only `query` and `pong`. `dashboard_data` is app-only and needs a binding the frame never sees. **Other sessions:** queries carry no session field; the View or web parent adds its pinned binding or route session; the server re-checks `requireSession` per query (section 8.3). **Cookies and storage:** opaque origin (no `allow-same-origin`) on a separate host from the app, and the app cookie is host-only. **Network:** `connect-src 'none'`, `frame-src 'none'`, `worker-src 'none'`, `form-action 'none'`; no `allow-popups`, `allow-top-navigation` or `allow-forms`; `img-src` limited to `data:` and `blob:`, so there is no image beacon; `Referrer-Policy: no-referrer`. **Early refusal:** the section 7.3 denylist. | Browser sandbox or CSP bugs. The runtime build job adds a browser test that runs a hostile dashboard (fetch, image beacon, `top.location`, `parent.postMessage`, `document.cookie`, `window.open`, form post) and records that each is blocked, as evidence. Side channels (timing, CPU) within the frame are not addressed. |
| T3 | **Token theft and replay.** | Tokens are 256-bit random values stored only as SHA-256 hashes (a database dump yields nothing usable). Access tokens last 1 h and are audience-bound to `RESOURCE` (RFC 8707). Refresh tokens rotate, and a reused one revokes the whole grant chain (section 4.5). PKCE `S256` is mandatory. Codes are one-shot, last 60 s and are `take`n atomically. Redirect URIs must match exactly. `iss` is returned in the authorization response (RFC 9207, against mix-up). `state` is required. Tokens are accepted only in the `Authorization` header on exactly `/mcp`, never in a query string and never on `/api`. Tokens, codes and headers are never logged. Users revoke through Connected apps. Consent pages can't be framed and carry an HMAC CSRF token. The `Lax` cookie blocks cross-site consent POSTs. | A stolen **access** token works for at most 1 h, within the user's own permissions. A stolen refresh token used before the client's next refresh gets one rotation, then the client's own refresh trips reuse detection and revokes it. A lost refresh response logs the user out of the connector (accepted, ADR 0035). DCR is open: a phishing client can register any name, which the consent page labels as client-supplied, showing the real redirect host. |
| T4 | **Privilege drift after a role change or removal from a studio.** | Tokens carry no roles or studios. Every tool re-reads access through `requireSession` and `requireTeamRole`, and writes re-check inside the transaction with `requireTeamRoleIn` (`FOR SHARE`), so a demotion racing a save either waits for it or fails it (team-management "Concurrent team and ownership writes"). A disabled account fails token lookup. A deleted user cascades grants. Open Views re-check on every `dashboard_data` call. | A removed user's grant stays listed until they revoke it or it ages out, but it authorizes nothing they can't currently do. A View already showing data keeps showing what it fetched until reload. |
| T5 | **Template data leaking across sessions or shows.** | Templates store **code, never data**. Every render fetches from the session it is opened for, under the viewer's permissions. The applicability rule (section 6.3) masks templates outside their studio or shows. `show_ids` are validated against the studio. Templates never cross studios. | Agent-written code can embed **literal text** copied from the session it was designed on (a quote, a name). That text is visible wherever the template applies, including to a viewer who can't read the source session. Mitigations: only managers, who can read every show of the studio, can save; the tool description for templates tells Claude not to embed session data; `source_session_id` is recorded for audit. Reviewing for literals is the author's job. This is a residual the human accepts with decision 6. |
| T6 | **Denial of service through large reads or heavy dashboards.** | **Reads:** every list tool is cursor-paged with item and 40,000-character caps (section 5.2). Each user gets 120 calls a minute and 2,000 an hour. `/mcp` bodies are capped at 512 KiB. **Registration and token abuse:** per-address windows (IPv6 by `/64`), a global client cap, and 24 h cleanup of unused clients. **Heavy dashboards:** source and compiled size caps, 20 per session and 100 templates per studio; the per-render budget (4 in flight, 300 queries, 20 MB); a watchdog that removes a frame that stops answering pings; a height clamp. **Server:** the query service reads through the hub with the existing statement timeouts (core-ports-architecture "Root catalog statements are time-bounded"). | Whole-transcript reads (`listTranscriptWords`) are paged in memory, so each page request reads the whole transcript from the database. That is bounded by the rate limit, and a paged hub read is a follow-up if measurements show cost (section 13). A dashboard can still use a lot of CPU within its frame until the watchdog fires (6 s). |
| T7 | **Consent phishing and open redirect.** | No redirect ever goes to an unvalidated `redirect_uri`, and errors before validation are plain HTML. Only `https:` or loopback redirect URIs are accepted. The consent page shows the redirect host prominently. Consent is asked every time. | A user who approves a hostile client's consent gives it their own read access. That is inherent to OAuth, and Connected apps is the undo. |
| T8 | **Cross-process races.** | Codes and pending requests are `take`n from KV. Refresh rotation is one conditional `UPDATE … RETURNING`. Revision writes compare and set. Rate windows live in the catalog. | none known |
| T9 | **The runtime origin used for something else.** | The api serves only `/runtime/v1/*` on that host and answers `404` to everything else there, sets no cookies on it, and the boot check refuses the app's own host. | The runtime is a public "run code with no network" page. Framing it elsewhere gives an attacker nothing they couldn't do in their own page. |

## 12. Contract impact

All of this is **additive**. When the flag is off, no existing route, method, JSON shape, status
code, header, export body or WebSocket message changes (section 10.4), in the single-process
server and in the split topology with the API-only `api` image. In the split topology the router
config is byte-identical to today's, because the new router rules are imported only when
`ROUTER_CUSTOM_DASHBOARDS` is `on` (section 10.3). When the flag is on,
exactly two existing behaviors change, listed in section 12.2, and each changes only for
requests that only the new feature can produce.

### 12.1 New HTTP routes (all flag-gated; each lands in the README endpoint table in its job)

| Method and path | Section | Auth |
| --- | --- | --- |
| `GET /.well-known/oauth-protected-resource` | 4.2 | none |
| `GET /.well-known/oauth-protected-resource/mcp` | 4.2 | none |
| `GET /.well-known/oauth-authorization-server` | 4.2 | none |
| `POST /oauth/register` | 4.3 | none, rate-limited |
| `GET /oauth/authorize` | 4.4 | cookie, optional |
| `GET /oauth/authorize/resume` | 4.4 | cookie |
| `POST /oauth/authorize` | 4.4 | cookie plus CSRF |
| `POST /oauth/token` | 4.5 | public client |
| `POST /oauth/revoke` | 4.8 | public client |
| `POST /mcp` (`GET`, `DELETE` → `405`) | 5.1 | OAuth bearer |
| `GET /api/oauth/connected-apps` | 4.8 | cookie |
| `DELETE /api/oauth/connected-apps/:grantId` | 4.8 | cookie |
| `GET /api/sessions/:sessionId/custom-dashboards` | 9.1 | cookie |
| `GET /api/custom-dashboards/:dashboardId?session=:sessionId` | 9.2 | cookie |
| `POST /api/sessions/:sessionId/custom-dashboards/query` | 9.3 | cookie |
| `GET /runtime/v1/frame.html` and `GET /runtime/v1/assets/*` on `DASHBOARD_RUNTIME_ORIGIN` only | 8.2, 10.3 | none |

There are no new WebSocket messages, and the upgrade dispatch (`server/src/upgradeDispatch.ts`)
is unchanged.

### 12.2 Changed spec requirements

| Spec | Requirement | Change | Job |
| --- | --- | --- | --- |
| `api-contract-freeze` | "OAuth callback failure redirect" (scenario "Success path unchanged") | When the consumed state was issued by `/oauth/authorize` (value `mcp:<id>`, which only exists with the flag on), success redirects to `/oauth/authorize/resume?request=<id>` instead of `/`. Failures and every other state are unchanged. | J3 |
| `api-contract-freeze` | "Companion device tokens authenticate only the Companion surface" | Its rule that a Bearer is ignored outside `/api/companion/` gains one exception: on exactly `/mcp`, with the flag on, an MCP access token decides the caller. Device tokens stay Companion-only, and MCP tokens are accepted nowhere else. | J5 |
| `api-contract-freeze` | new requirements for each route group of section 12.1, each stating "additive, flag-gated, absent when off" | added | J2–J9 |
| `ai-v2-dashboards` | "No agent-authored markup is ever rendered" | Scoped: the rule continues to govern v2 dashboards and the app origin, and its "anywhere, by any path" no longer covers code executed inside the custom-dashboards sandbox runtime, which `custom-dashboards` governs. The Purpose line is updated to match. Nothing else in v2 changes. | J7 |
| `web-session-console` | "Workspace tab IA (single owner)" | The Dashboards tab hosts the custom section above the v2 editor. The six tabs, their order and their labels are unchanged. | J9 |
| `web-ui-system` | new "Settings manages the user's connected apps", beside "Settings manages the user's Companion devices" | added | J4 |
| `web-frontend-platform` | the boot-guard requirement (the `PUBLIC_BASE_URL` checks) | the flag-on checks of section 10.1 (J1); the refusal when `ROUTER_CUSTOM_DASHBOARDS` is present and disagrees with the flag (J6, section 10.3) | J1, J6 |
| `core-ports-architecture` | "Every catalog and session call is bound to a caller" and "Authentication and authorization are distinct seams for every caller" | the `/mcp` bearer as a second credential resolved in the auth middleware; the new system reasons | J2, J5 |
| `container-deployment`, `local-container-environments` | "Internal router preserves the single-origin disposition matrix", "Deployment behind a TLS-terminating proxy is configured explicitly" | the new exact-path and runtime-host rules, present only in the `(custom-dashboards-on)` snippet that `ROUTER_CUSTOM_DASHBOARDS=on` imports; the router's environment allowlist (check-envs invariant 10) and the `on` adapt baseline beside the unchanged `off` one (invariant 13); the new variables | J6 |
| new `mcp-authorization` | the OAuth server, tokens, consent, revocation, cleanup | new capability | J2, J3, J4 |
| new `mcp-session-data` | `/mcp`, the read tools, paging and associated wiki pages | new capability | J5 |
| new `custom-dashboards` | the data model, validation, the runtime, the View and the web viewer | new capability | J7, J8, J9 |
| `team-management` | "Team roles, owner anchor and show access", operation table | adds a row "create, edit, delete or restore a custom dashboard: owner yes, admin yes, member `403`" | J7 |

## 13. Job breakdown

Each job is independently mergeable. When it merges, `main` is releasable with the flag off, and
nothing half-built is reachable with the flag on before J5. Each job updates
`docs/security.md` when it adds exposure, updates the README endpoint table for its routes, and
passes `scripts/check-change.sh`. Dependencies are merge order.

### 13.1 Jobs

**J1. Flag and configuration.**
- *Goal:* add `CUSTOM_DASHBOARDS_ENABLED`, `DASHBOARD_RUNTIME_ORIGIN`, `MCP_SIGNING_SECRET` and
  `MCP_ALLOWED_ORIGINS` to `Config` and `node/config.ts`, the env accessors, and the boot checks
  of section 10.1. No routes.
- *Draft criteria:*
  - Boot is refused, naming the variable, when the flag is on with an `http:` `PUBLIC_BASE_URL`,
    with a missing, invalid or same-host runtime origin, or with a short secret.
  - Boot is unchanged when the flag is off, whatever the other variables say.
  - The same-site warning and the `IP_ALLOWLIST` warning are logged without values.
  - Tests are in `bootGuard.test.ts` and `env.test.ts`.
- *Depends on:* none.
- *Specs:* `web-frontend-platform`.

**J2. OAuth metadata, client registration and storage.**
- *Goal:* the migration for the tables of section 4.7, the system reasons, PRM and AS metadata,
  `POST /oauth/register` with its limits, and the sweeper.
- *Draft criteria:*
  - The metadata documents match section 4.2 byte for byte in their fields.
  - Redirect URI rules are tested, including the loopback port rule.
  - The 11th registration in an hour from one IPv4 address, or from two addresses in one IPv6
    `/64`, gets `429`.
  - Unused clients are swept after 24 h.
  - The tables are system-only (pg test: `catalog_user` gets `42501`).
  - With the flag off, every route answers as today (int test against the frontend-bridge and
    `404` answers).
- *Depends on:* J1.
- *Specs:* new `mcp-authorization`, `api-contract-freeze` (routes), `core-ports-architecture`
  (reasons).

**J3. Authorization, consent, token and revocation endpoints.**
- *Goal:* everything in sections 4.4 and 4.5, plus `POST /oauth/revoke`, including the Google
  callback resume.
- *Draft criteria:*
  - The full code flow passes with PKCE.
  - A wrong verifier, a reused code, a mismatched `redirect_uri` and a wrong `resource` each get
    `invalid_grant` or `invalid_request` as specified.
  - Errors before validation never redirect.
  - Consent CSRF is checked, and the consent page carries its CSP and frame headers.
  - Refresh rotates, and reuse revokes the grant along with all its tokens.
  - Refresh tokens expire after 30 days.
  - A disabled user can't refresh.
  - The callback with an `mcp:` state redirects to resume; with a `1` state it redirects to `/`
    exactly as before (the existing callback tests still pass unchanged).
  - Token and IPv6 `/64` rate limits.
- *Depends on:* J2.
- *Specs:* `mcp-authorization`, `api-contract-freeze` ("OAuth callback failure redirect").

**J4. Connected apps.**
- *Goal:* the two `/api/oauth/connected-apps` routes and the Settings section.
- *Draft criteria:*
  - A user lists only their own live grants.
  - Revoke deletes the grant's tokens, and the next `/mcp` call gets `401`. That case is
    exercised after J5 merges; until then, the token lookup unit is tested.
  - Another user's grant gets the masked `404`.
  - With the flag off, the section doesn't render and makes one `404` request.
  - Client names render as text.
- *Depends on:* J3.
- *Specs:* `web-ui-system`, `mcp-authorization`, `api-contract-freeze`.

**J5. `/mcp` endpoint and the read tools.**
- *Goal:* the `authContext` bearer branch, `POST /mcp` (stateless, Origin check, size cap,
  `405`s), the query service and the read tools of section 5.3, including associated wiki pages
  and the paging contract.
- *Draft criteria:*
  - With no or a bad token: `401` with the exact `WWW-Authenticate`.
  - A wrong-audience or expired token gets `401`.
  - An ungranted member gets `Session not found` from every read tool.
  - Demoting or removing a user takes effect on the next call (int test).
  - Each paging rule: clamped limits, the 40,000-character cap with `truncated`, cursor mismatch,
    and the changed-session note.
  - Associated pages: all three rules, the one-hop limit, deleted and merged pages excluded,
    another show's pages excluded.
  - Rate limits.
  - No tool writes session data (a tool-list pin test).
  - A Bearer header on `/api/*` is still ignored.
- *Depends on:* J3.
- *Specs:* new `mcp-session-data`, `api-contract-freeze` (Companion-token exception, `/mcp`
  route), `core-ports-architecture`.

**J6. Router rules for the new paths and the runtime host.**
- *Goal:* the flag-gated Caddy snippets and import of section 10.3, the
  `ROUTER_CUSTOM_DASHBOARDS` variable on the `router` and `api` services, the boot-guard
  agreement check, the `check-envs.sh` changes, the `on` adapt baseline, and documentation.
- *Draft criteria:*
  - Deferred job 016's criteria 1–6, extended with `/oauth/authorize/resume`,
    `/.well-known/oauth-protected-resource` and the runtime-host rule, hold with
    `ROUTER_CUSTOM_DASHBOARDS=on`.
  - `caddy adapt` on the router's pinned image, with the variable unset and with it set to
    `off`, prints output byte-identical to the **existing, unregenerated**
    `docker/scripts/caddy-adapt.baseline.json` (check-envs invariant 13). With `on` it matches
    a new committed `on` baseline.
  - `check-envs.sh` fails on a router value other than `on` or `off`, on a hostile runtime-host
    value, and on any other router environment key in prod (invariant 10, with
    `test_check_envs.sh` cases).
  - The boot guard refuses to start, naming both variables, when `ROUTER_CUSTOM_DASHBOARDS` is
    present and disagrees with the flag; it starts when they agree or the variable is absent.
  - **Flag-off parity on the API-only `api` image, as deployed.** On a stage stack built from
    the same `docker/Dockerfile` targets as prod (the `api` target, which has no `web/.next` and
    logs its API-only warning), with the flag and `ROUTER_CUSTOM_DASHBOARDS` both off: for `GET`,
    `HEAD`, `POST`, `PUT` and `DELETE` on each path of section 10.3 (and the runtime host),
    the router's answer is identical to the answer recorded on the same stack built from `main`
    before J6. J6 adds these rows to `docker/scripts/test_router.sh`'s disposition table
    (status, `Set-Cookie` presence and the compared headers, including `Content-Type`), plus a
    hash of each body, recorded with `--record` against the `main` stack first; the job's stack
    must then pass the unchanged table. The GETs must still show Next's HTML not-found document
    from `web:3000`, not the api's plain-text `404 Not Found`.
  - With both on, the same GETs reach the api (recorded the same way).
- *Proof plan:* the verifier re-runs the adapt comparisons and `check-envs.sh` on the pinned
  image, and re-runs the stage before/after recording against the API-only `api` image. The dev
  single-process stack is not accepted as flag-off parity evidence for the split topology.
- *Depends on:* J3, so the paths are final. It may merge before J5.
- *Specs:* `container-deployment`, `local-container-environments`, `web-frontend-platform` (the
  agreement check).

**J7. Dashboard store, validation and write tools.**
- *Goal:* the migration for section 6.1 with its policies, the parser and compiler dependency
  (dependency review), the validator and compiler of section 7, and the dashboard tools of
  section 5.3 except `open_dashboard` and `preview_dashboard`.
- *Draft criteria:*
  - A member gets `Owner or admin role required.` on every write.
  - Any manager edits any of the studio's dashboards.
  - `expected_revision` conflicts are refused.
  - The 21st revision prunes the oldest.
  - Restore re-validates.
  - Delete removes the revisions.
  - Each allowlist and denylist rule has a refusing test (names line and column).
  - Each size limit.
  - Template `show_ids` must be in the studio.
  - The applicability rule is tested.
  - RLS pg tests for each role.
  - The allowlist constant is pinned to the shadcn files.
- *Depends on:* J5.
- *Specs:* new `custom-dashboards`, `team-management` (operation row), `ai-v2-dashboards`
  ("No agent-authored markup…" scoping, Purpose), `api-contract-freeze`.

**J8. Runtime and MCP App View.**
- *Goal:* `packages/dashboard-runtime` (frame document, registry, hooks, watchdog), its serving
  on the runtime host with the section 8.2 headers, `packages/dashboard-view` (the `ui://`
  resource), `open_dashboard`, `preview_dashboard` and `dashboard_data` with bindings.
- *Draft criteria:*
  - The resource's `_meta.ui` matches section 8.1.
  - The binding is refused when tampered, expired, from another user or grant, or after losing
    access.
  - `dashboard_data` is app-only (a model-visible tool list excludes it).
  - Query budget and watchdog unit tests.
  - **Evidence:** a browser run (Playwright, recorded under the job's `evidence/`) of a hostile
    dashboard showing that `fetch`, image beacon, `document.cookie`, `top.location`,
    `window.open`, `parent.postMessage` and a form post are all blocked, and that a normal
    dashboard renders.
  - A manual run in claude.ai against a stage deployment, with screenshots.
  - The runtime host answers `404` to everything except `/runtime/v1/*`.
- *Depends on:* J6 and J7.
- *Specs:* `custom-dashboards`, `api-contract-freeze` (runtime routes).

**J9. Web viewer in the Dashboards tab.**
- *Goal:* the three `/api/.../custom-dashboards` routes and the Dashboards-tab section using the
  J8 runtime.
- *Draft criteria:*
  - A reader sees the session's dashboards plus the applicable templates, and nothing else.
  - The query route re-checks access per call.
  - The frame gets no cookie: an evidence screenshot or recording of the frame's request headers
    for its own assets, and no request to the app origin from the frame.
  - Flag off: the tab is identical (snapshot test) and one `404` request is made.
  - The v2 editor tests pass unchanged.
- *Depends on:* J8.
- *Specs:* `web-session-console` ("Workspace tab IA"), `custom-dashboards`,
  `api-contract-freeze`.

### 13.2 Order

```
J1 → J2 → J3 → J4
            ├→ J5 → J7 ─┐
            └→ J6 ──────┴→ J8 → J9
```

ADR 0035 moves to Accepted when J1 merges.

### 13.3 Open questions for the human (not blocking this design's approval)

1. **CIMD.** Should a later job add Client ID Metadata Documents beside DCR? The 2026-07-28
   revision prefers CIMD, and Claude uses it when advertised.
2. **Absolute grant lifetime.** Each refresh token lasts 30 days from its own issue, so an
   active connection never expires. Should there be a hard cap, for example 90 days?
3. **Portal-based shadcn components and charts.** These are left out of v1 (section 7.2). Adding
   a chart library (shadcn's chart component uses `recharts`) would be a dependency decision.
4. **A citation index.** Measure the rule 2 scan of section 5.4 on the largest show before
   adding one.
5. **Protocol revision 2026-07-28** (no transport sessions, header checks). Adopt it when Claude
   and the SDK do.
6. **The router setting `ROUTER_CUSTOM_DASHBOARDS` (section 10.3).** This is a design choice
   the approver should confirm; human decision 13 names one opt-in flag, and this adds a second
   operator setting beside it.
   - **Name and values.** `ROUTER_CUSTOM_DASHBOARDS`, and its only allowed values are `on` and
     `off`. Unset or empty resolves to `off`; `check-envs.sh` refuses anything else.
   - **Two settings must agree in the split topology.** There the operator sets both
     `CUSTOM_DASHBOARDS_ENABLED` and `ROUTER_CUSTOM_DASHBOARDS`, and boot refuses to start when
     they disagree, naming both variables. The router setting can't turn anything on by itself.
     The dev single-process stack sets no router variable, only the flag.
   - **Why one setting isn't enough.** The flag accepts `1`, `true` or `yes` (any case), but
     Caddy picks the snippet by pasting the variable's value into a snippet name, and it can't
     map those spellings onto `custom-dashboards-on`. So the router needs one exact value, and
     the boot check keeps the two in step.
7. **Builder-chosen environment variable names.** `CUSTOM_DASHBOARDS_ENABLED`,
   `DASHBOARD_RUNTIME_ORIGIN`, `MCP_SIGNING_SECRET` and `MCP_ALLOWED_ORIGINS` (section 10.1),
   and `ROUTER_CUSTOM_DASHBOARDS` (item 6). The names are a design choice the approver should
   confirm.
8. **Builder-chosen size limits.** The section 6.4 caps (100,000-character source, 300,000-
   character compiled JS, 1–200-character title, 20 dashboards per session, 100 templates per
   studio, 100 `show_ids` per template, 60 import specifiers) and the 512 KiB `/mcp` body cap
   (section 5.1). The 20 kept revisions are human decision 12, not part of this item. These
   numbers are a design choice the approver should confirm.
9. **Builder-chosen paging and rate limits.** The per-tool default and maximum `limit` values
   of section 5.3, the 40,000-character page cap of section 5.2, the per-user 120 tool calls a
   minute and 2,000 an hour (section 5.1), and the token-endpoint windows of section 4.5 (30 a
   minute per client, 60 per source address). These numbers are a design choice the approver
   should confirm.
10. **A single OAuth scope, `dashboards` (section 4.1).** One scope covers the read and write
    tools, and roles decide what a token can do. This is a design choice the approver should
    confirm.
11. **Consent on every authorization (section 4.4).** Today the design shows the consent page
    on every authorization, with no silent re-approval, and doesn't remember a decision per
    client. Its reason is that DCR gives every connection a new client, and asking each time
    blunts consent phishing (T7). The alternative is to remember an approval per user and
    client, and skip the page on a repeat authorization from the same client with the same
    scope and redirect URI until the user revokes it in Connected apps. That means one click
    fewer on reconnects, but a stored approval a hostile client could reuse silently. This is a
    design choice the approver should confirm.

### 13.4 Assumptions to re-check at build time

Each was checked once while this design was written. The job that relies on it re-checks it.

- **Claude support (J8).** claude.ai and Claude Desktop render MCP Apps and allow
  `csp.frameDomains` nested frames. The MCP Apps overview lists Claude as a host; Claude's
  connector docs don't state the extension revision.
- **SDK fit (J5).** `@modelcontextprotocol/sdk` 1.32's `WebStandardStreamableHTTPServerTransport`
  runs in stateless mode inside a Hono handler. The file exists in the installed SDK.
- **CSP in a sandboxed frame (J8).** A sandboxed opaque-origin frame enforces a host-source
  `script-src` for its own origin's scripts. The J8 browser evidence settles it; if not, the
  runtime inlines its bundle with a hash source.
- **Claude's egress (J1, J6).** Claude's server-side connector calls send no `Origin` header, and
  they come from `160.79.104.0/21`.
