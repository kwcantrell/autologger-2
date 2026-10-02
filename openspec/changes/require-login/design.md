# Design

## Context

Login is enforced in one place: `authContext` (`server/src/middleware/auth.ts`). It runs on
`*` after the IP allowlist (`server/src/app.ts:174-175`), so it also covers the session
WebSocket upgrade path. Since `gate-decoded-path`, it decides on Hono's decoded `c.req.path`,
which is the path the router matches. Today it calls `requireLoginEnabled(config)` and checks
login only when that returns true. `apiRequestRequiresLogin` (`server/src/auth/identity.ts:122`)
exempts two things:
- `GET /api/profile`;
- `/api/admin/*`.

On `/api/companion/*`, a valid `API_TOKEN` counts as logged in.

With `REQUIRE_LOGIN=0` (dev), routes see `user === null` and treat it as "sees everything":
- `requireSession` skips membership (`routers/_helpers.ts:37`);
- `shows.ts`, `logImport.ts` and `transcribe.ts` (`requesterCanViewSession`) do the same;
- `sessions.ts` and `profile.ts` read and write global `SETTING_ACTIVE_SHOW` and
  `SETTING_ACTIVE_STUDIO`;
- `profileAssembler.getEffectiveStudioForUser(null, false)` resolves the global active studio.

The `/api/companion/*` routes (`companion.ts`) never call `requireSession`. They do their own
lookups and are the frozen no-membership machine path.

Six features carry an open-network 503 that reads `requireLoginEnabled`. It is reached through
`env.ts` `openNetworkRefused`, and `main.ts` prints a matching boot warning.

The integration harness (`server/src/test/harness.ts`) runs with `REQUIRE_LOGIN: '0'` and
`GOOGLE_CLIENT_ID: ''`. Most `*.int.test.ts` suites call routes anonymously through
`app.request`. Three real-server suites (`apiToken`, `upgradeDispatch`, `companion-ws`) `serve()`
their own app.

## Goals / Non-Goals

**Goals:**
- Exactly one principal-less caller remains: `API_TOKEN` on `/api/companion/*`. Every other
  route that reaches the catalog has a signed-in user.
- The server can't start in a state where no one can sign in.
- Delete dead code; add no new modes.

**Non-Goals:** see proposal.md. That covers 5c's owner role and built-in studios, slice 9's
Companion credential, and RLS.

## Decisions

### D1. Boot refusal lives in `checkBootEnv`
`server/src/bootGuard.ts` `checkBootEnv` gets two new refusals, applied after the existing ones
and before anything else (the catalog wait included):
1. `REQUIRE_LOGIN` is present in the environment with any value, empty included. The message
   says it was removed and login is always required.
2. Any of `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` or `PUBLIC_BASE_URL` is missing or blank
   after trimming. This is the same rule `oauthConfigured()` applies (`env.ts:43`), so a server
   that boots always reports `oauth_configured: true`. The message names the variables and
   Infisical.

Both `main.ts` and `bootGuardCli.ts` already call this function, so dev's `tsx watch` is guarded
too. The messages name variables, never their values (the file's existing rule).

`compose-run.mjs` `checkSignInClient` (line 190) exempts dev from the `GOOGLE_CLIENT_ID` check
today. The exemption is removed, and both Google values are required after trimming. A
misconfigured stack therefore fails before compose starts, with an actionable message.
`PUBLIC_BASE_URL` is pinned by every compose file, so only the server checks it.

*Alternative:* boot and 401 everything. The owner rejected it, because the misconfiguration
would only show up at runtime.

### D2. The middleware checks login unconditionally
`authContext` drops the `requireLoginEnabled` guard. The rest stays as it is: the decoded path,
the API-token rule and the 401 body. `apiRequestRequiresLogin` exempts `/api/profile` for `GET`
**and `HEAD`**. Hono serves HEAD through the GET handler, so today `HEAD /api/profile` is a
spurious 401. `requireLoginEnabled` and `Config.REQUIRE_LOGIN` (`packages/ports/src/config.ts`,
`server/src/node/config.ts`) are deleted.

### D3. Route helpers assert a principal; they don't make a second login decision
`requireUser(c): AuthUser` moves from `teams.ts` (module-local today) to `routers/_helpers.ts`.
Its null case changes: a null user behind the middleware is an invariant violation, so it throws
an internal error. The error handler turns that into a 500 and logs it; it is not a 401. This
keeps `core-ports-architecture`'s rule "The login-required check SHALL NOT be duplicated between
middleware and per-route helpers": the 401 decision is made once, in the middleware.

`requireSession` calls `requireUser` and always checks membership. Its principal-less branch is
deleted: no `/api/companion/*` route uses it, and the Companion path lives in `companion.ts`,
unchanged.

The other routes that branched on `user === null` call `requireUser` and always check:
- `profile.ts`: `GET /api/studio` and `PUT /api/profile`;
- `shows.ts`: list, detail and create;
- `sessions.ts`: list and create;
- `logImport.ts`: start and status;
- `transcribe.ts`: `requesterCanViewSession`;
- `aiV2.ts`: the answer route (step 6), plus the principal-less comments.

`GET /api/profile` keeps `c.get('user')`, nullable, because it is exempt. `teams.ts` uses the
shared helper.

### D4. The open-network refusals are deleted outright
These are removed:
- `openNetworkRefused` and the four `*OpenNetworkRefused` exports in `env.ts`;
- the `*_OPEN_NETWORK_DETAIL` constants and their checks in `ai.ts`, `aiV2.ts`, `sessions.ts`,
  `transcribe.ts`, `events.ts` and `logImport.ts`;
- the `main.ts` warning block;
- their tests.

`loopbackHostname` stays, because `aiV2CredentialsRefused` uses it. AI v2's credentials 503 is
not tied to login, so it doesn't change. Route orderings close up: the step after the
configuration gate becomes whatever followed the open-network step.

### D5. The anonymous active team and show are no longer read or written
- `sessions.ts` list: the `user === null` settings branch goes; prefs only.
- `profile.ts` `PUT`: the anonymous transaction that wrote the global settings goes.
- `profileAssembler`:
  - `getEffectiveStudioForUser(user: AuthUser)` drops its `oauthConfigured` parameter and its
    `resolveActiveStudio` path;
  - `profilePayload(null, ctx)` always returns the existing signed-out payload, the one currently
    guarded by `user === null && oauthConfigured`;
  - the anonymous branch that read and repaired `SETTING_ACTIVE_SHOW` goes.

The stored rows are left as they are (non-goal).

Two readers are out of scope and stay:
- first sign-in seeds a new user's prefs from those settings (`auth.ts:234`);
- `sessionIndexStore.ts:372` falls back to `resolveActiveStudio`.

Both read defaults, never per-request anonymous state. 5c revisits them when the built-in studios
go.

### D6. `oauth_configured` stays in the frozen shape and is computed as before
`oauthConfigured(config)` is still evaluated and returned. Two things still read it:
- the `/auth/google/*` not-configured responses (frozen);
- `GET /api/profile`.

D1 refuses exactly the inputs that make it false, so it is `true` on every running server, and
the web stops reading it (D8). Removing the field would change a frozen shape, so it stays
(non-goal).

### D7. The test harness signs in a narrowed default member (owner)
Changes to `server/src/test/harness.ts` and `helpers.ts`:
- **Base config:** `GOOGLE_CLIENT_ID: 'test-client-id'`, `GOOGLE_CLIENT_SECRET` and
  `PUBLIC_BASE_URL` as today, and no `REQUIRE_LOGIN`.
- **Default user:** `resetTestEnv` seeds a default user with role `member` in the built-in studios
  only. `seededSession()` (and `seedSession` when given a fresh studio through `seededSession`)
  adds the same membership for its studio.
- **No auto-membership in `seedStudio`.** Team and admin suites see no extra member, so their
  member counts and the `adminUsers` capture don't change.
- **The exported `app` is wrapped.** It adds the default user's cookie only when all of these
  hold:
  - the request has no `cookie` header, checked case-insensitively (suites use both spellings);
  - it has no `authorization` header;
  - its path is not under `/api/companion/`, so Companion suites must send the bearer like the
    real client, and a forgotten bearer fails rather than silently running as a user.
- **`anonApp`** is the raw app, exported for unauthenticated requests.
- **Explicit cookies or `anonApp`.** Suites that test auth, roles or anonymous behavior use one of
  them: `gate`, `authz`, `apiToken`, `teams`, `admin`, the `shows-profile` signed-out cases and
  `activeShow.race`.

The masking risk (a route that forgot a check still passes through the wrapper) is closed
mechanically. `gate.int.test.ts` iterates Hono's registered routes (`app.routes`, the same
source `gate-decoded-path` already uses), sends each `/api/*` route with no credentials through
`anonApp`, and expects `401 Login required.`. The only routes not expected to get it are a named
exemption list: `GET`/`HEAD /api/profile` and `/api/admin/*`. A route added later without a
named exemption fails the test.

*Alternative:* add an explicit cookie in every suite. The owner chose the narrowed default
instead.

### D8. The web gate keys on `logged_in`
In `RootGate.tsx`, the condition `oauth_configured && !logged_in` becomes `!logged_in`.
`TeamsRoute.tsx` loses its anonymous-mode panel (the `REQUIRE_LOGIN` copy) and the branch that
renders it. Stale dev-anonymous comments go from `AppShell.tsx`, `useLoginReturnConsume.ts` and
`LoginPage.tsx`. Tests are updated to match: `AppShell.onboarding.test.tsx` loses its
dev-anonymous case, and `EventLogSheet.test.tsx`'s `oauth_configured:false` fixture becomes
`true`.

### D9. Compose drops the pin; the boot refusal is the guard
`REQUIRE_LOGIN` is removed from `compose.yaml` (`api`) and `docker/compose.dev.yaml` (`app`).
`check-envs.sh` drops it from invariant 7 (stage and prod, where `TRUST_PROXY` stays pinned),
from dev invariant 6's literal pins, from the `unset` list and from `dev-custom.env`.

No absence assertion is added. Three things make one unnecessary:
- the boot refusal (D1) fails any stack that sets the variable;
- Infisical can't inject it, because it isn't in `docker/secrets-env.yaml`;
- a compose literal would be caught at the first `make <env>-up`.

### D10. Dev credentials are owner steps, not code
The owner:
- creates a Google OAuth client for dev, with redirect
  `http://localhost:8787/auth/google/callback`;
- adds `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `API_TOKEN` to Infisical `autologger-dev`;
- enters the token in the dev Companion module (stored in its volume).

dev's GoTrue already takes its Google audience from `GOOGLE_CLIENT_ID`
(`docker/supabase-services.yaml:44`), so no compose change is needed. Nothing enforces dev's
`API_TOKEN`. Without it the dev Companion gets 401s, which the docs and the 6.3 live check name.

### D11. Spec deltas use REMOVED + ADDED where a rewrite would leave a contradicting title
For small requirements whose scenarios described open-network 503s or dev anonymous mode, the
delta removes the requirement and adds one under an accurate name. Large requirements are
modified in place, with the contradicting scenarios rewritten. Three main-spec Purpose paragraphs
still name the removed modes: `web-login-experience`, `ai-topics-chat` and
`youtube-audio-import`. A delta can't change a Purpose, so archive edits them directly (task
6.6).

### D12. Captured fixtures and suites that encoded anonymous behavior
- `fixtures/api-responses/profileAnonymous.ts` (anonymous with OAuth unconfigured) is deleted,
  along with its capture entry. `profileLoggedOutOauth` already captures the signed-out shape,
  and `web/src/api/types.conformance.test.ts` switches to it.
- The `apiResponseFixtures` busy fixture's "dev-anonymous requester sees the holder" case becomes
  "a member sees the holder".
- `activeShow.race.int.test.ts`: its anonymous case is deleted. It waited on an `app_settings`
  write that no longer exists. The signed-in case stays.
- `shows-profile.int.test.ts`: "sets the active studio (anonymous)" becomes the signed-in
  equivalent.
- `events.generate.int.test.ts:801`: it set the global active studio and show and then listed
  anonymously. It now sets the default user's prefs.
- `apiToken.int.test.ts`: "token-only is inert under open login" is deleted, with its scenario.
- The real-server suites (`upgradeDispatch.int.test.ts`, `companion-ws.int.test.ts`) send a
  cookie on session WebSockets and the bearer on `/api/companion/*`.
- `bootOrder.int.test.ts`: its spawned env gains the Google values and `PUBLIC_BASE_URL`, so the
  "unreachable catalog" case still reaches the catalog wait.
- `compose-run.test.mjs`: its fixtures gain `GOOGLE_CLIENT_SECRET`, and new cases cover the
  refusal in every stack.

### D13. A repo test bans raw-path security decisions
AGENTS.md rule 8: a rule that must always hold is a check, not prose. A repo test (in the
style of `promiseHygiene.repo.test.ts`) fails on `new URL(c.req.url).pathname` or `.pathname`
anywhere in `server/src/middleware/**` and `server/src/routers/**`. Only `upgradeDispatch.ts`
(outside those directories) reads the raw pathname, by design. This keeps `gate-decoded-path`
from regressing.

## Assumptions (each with the command that tests it)

| # | Assumption | Command | Observed |
|---|---|---|---|
| A1 | The middleware runs on every path, including the WS upgrade, after the IP allowlist | `grep -n "authContext\|use(" server/src/app.ts` | `174: app.use('*', ipAllowlistMiddleware)`, `175: app.use('*', authContext)` |
| A2 | The exemptions are exactly `GET /api/profile` and `/api/admin/*` | `sed -n 122,126p server/src/auth/identity.ts` | `if (path === '/api/profile' && method === 'GET') return false; if (path.startsWith('/api/admin/')) return false; return path.startsWith('/api/');` |
| A3 | Infisical can't inject `REQUIRE_LOGIN` | `grep -c REQUIRE_LOGIN docker/secrets-env.yaml` | `0` |
| A4 | `compose-run` exempts dev from the Google check today | `grep -n GOOGLE_CLIENT docker/scripts/compose-run.mjs` | `193: if (env !== 'dev' && !secrets.get('GOOGLE_CLIENT_ID')) refuse(...)` |
| A5 | dev's GoTrue Google audience comes from `GOOGLE_CLIENT_ID` | `grep -n EXTERNAL_GOOGLE docker/supabase-services.yaml` | `44: GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID:-}` |
| A6 | The global active settings are read outside the anonymous branches only by first sign-in and the session-index fallback | `grep -rn "SETTING_ACTIVE_SHOW\|SETTING_ACTIVE_STUDIO\|resolveActiveStudio" packages server/src --include=*.ts \| grep -v test` | hits in `profileAssembler.ts`, `profile.ts`, `sessions.ts` (anonymous branches, removed), `auth.ts:234-235`, `sessionIndexStore.ts:372`, `studioRegistry.ts:192` (definition) |
| A7 | The open-network predicate has only the six feature call sites plus `main.ts` | `grep -rn "OpenNetworkRefused\|requireLoginEnabled" server/src --include=*.ts \| grep -v test` | `env.ts` definitions; `middleware/auth.ts`, `main.ts`, and the routers `ai`, `aiV2`, `sessions`, `transcribe`, `events`, `logImport` |
| A8 | The test harness defaults to anonymous mode | `grep -n "REQUIRE_LOGIN\|GOOGLE_CLIENT_ID" server/src/test/harness.ts` | `57: GOOGLE_CLIENT_ID: ''`, `59: REQUIRE_LOGIN: '0'` |
| A9 | `oauthConfigured` needs both Google values and `PUBLIC_BASE_URL`, trimmed | `sed -n 30,45p server/src/env.ts` | `return Boolean(googleClientId(env) && googleClientSecret(env) && publicBaseUrl(env));` with `.trim()` accessors (panel) |
| A10 | No Companion route calls `requireSession` | `grep -n requireSession server/src/routers/companion.ts` | no output (panel) |
| A11 | A signed-out profile capture already exists | `ls fixtures/api-responses/ \| grep profile` | `profileAnonymous.ts`, `profileAuthenticated.ts`, `profileLoggedOutOauth.ts` |
| A12 | The gate already judges the decoded path | `grep -n "c.req.path" server/src/middleware/auth.ts` | `const path = c.req.path;` (gate-decoded-path, PR #32/#33) |

## Risks / Trade-offs

- **Dev is down from task 2.2 until the owner adds credentials.** Dev's bind-mounted
  `tsx watch` reloads the moment `checkBootEnv` changes, and dev still has `REQUIRE_LOGIN=0` and
  no Google client, so it refuses. This is intended. Don't "fix" dev by editing compose early.
  The owner step (6.2) restores it.
- **The harness default cookie can mask a missing login check.** This is covered by the
  route-table 401 test (D7) and by D2 keeping a single gate.
- **The stored global settings go stale.** They are still read as first-sign-in defaults
  (D5). Whatever value they last held becomes a new user's initial team and show until 5c. The
  harm is low: membership still decides access.
- **Cutover and rollback.** Recorded in ADR 0021's cutover notes:
  - the new image run with `main`'s compose (`REQUIRE_LOGIN: "1"`) refuses to boot and
    crash-loops under `restart: unless-stopped`. That fails closed, but it is an outage, so the
    cutover deploys the integration branch's compose with its image;
  - rolling back to the old image with the new compose is safe, because the old server treats
    an unset `REQUIRE_LOGIN` as login required.
- **Size.** About 550-650 counted lines, mostly deletions. `README.md` and the deleted fixture
  count toward the budget; `docs/**` and tests don't. The owner chose one PR with
  `size-override`.
