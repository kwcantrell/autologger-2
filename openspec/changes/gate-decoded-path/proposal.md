# The login gate decides on the decoded path the router matches

Tier: 2
Tier reason: authentication bypass fix in the login middleware, on frozen `main` (owner-approved exception to the migration freeze).

Approved-by: Kalen 2026-10-01

## Why

The login gate can be bypassed with a percent-encoded path. `authContext` decides login and the
`API_TOKEN` scope on the raw request path (`new URL(c.req.url).pathname`). Hono routes on the
decoded path, so `GET /%61pi/sessions` reaches the `/api/sessions` handler while the gate sees a
path outside `/api/` and lets it through. The router (`docker/Caddyfile`) forwards `%61pi`
deliberately, because `/%61pi/x` *is* `/api/x` to Hono.

The adversarial panel of slice 5b (`require-login`) found this. The owner confirmed it on the
local stage stack (no cookie, no token):
- `GET /api/sessions` gives 401;
- `GET /%61pi/sessions` gives 200;
- `GET /%61pi/companion/state` gives 200.

Prod is not deployed (owner, 2026-10-02), and stage is reachable only on loopback, so no
exposed deployment runs this code. The owner chose to fix it on `main` now, as an exception to
the migration freeze, so that prod's first deploy and the integration branch both have the fix.

## What Changes

- `authContext` (`server/src/middleware/auth.ts`) uses Hono's decoded `c.req.path` for both
  decisions: login required (`apiRequestRequiresLogin`) and `API_TOKEN` scope
  (`/api/companion/`). The gate and the router then see one path.
- Regression tests: encoded spellings of `/api` routes get the same answer as their literal
  forms (design D2).

## Contract impact

These are observable changes to the frozen HTTP contract, recorded in the
`api-contract-freeze` delta. All of them apply under `REQUIRE_LOGIN=1`:
- an encoded spelling of a gated `/api` route without a credential gets `401 Login required.`
  (today `200`). For example, `/%61pi/sessions` and `/%61pi/companion/state` without a token;
- an encoded spelling that matches no route, such as `OPTIONS /%61pi/sessions` or a trailing
  slash, gets `401` instead of `404`, exactly like its literal form;
- a valid `API_TOKEN` is honoured on an encoded spelling of `/api/companion/*` (such as
  `/api/%63ompanion/state`, today `401`), and an encoded spelling of `/api/profile` (GET) or
  `/api/admin/*` is exempt from login like its literal form. Admin routes still check
  `ADMIN_TOKEN` themselves.

Literal paths get exactly the answers they get today.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `core-ports-architecture`: "Authentication and authorization are distinct, single seams". The
  middleware decides on the same decoded path the router matches, and a new scenario covers an
  encoded `/api` prefix.
- `api-contract-freeze`: "API_TOKEN authenticates only the Companion surface". "The request path"
  is defined as the decoded path the router matches, and a scenario covers the encoded spellings.

## Non-goals

- Anything slice 5b does: removing `REQUIRE_LOGIN=0`, the anonymous branches, the open-network
  refusals.
- Changing the Caddyfile. The router's forwarding is correct; the server's two decisions were
  inconsistent.
- The upgrade dispatcher (`upgradeDispatch.ts`). It hands Hono only a literal `/api` prefix.
  Anything else is destroyed, or in dev goes to Next's upgrade handler, so an encoded upgrade
  never reaches a Hono handler.
- Replacing the URL-prefix matcher with a per-route policy (still deferred).

## Impact

- **Code:** `server/src/middleware/auth.ts` (a few lines), plus tests in
  `server/src/routers/gate.int.test.ts` and `authz.int.test.ts`.
- **Deploy:** prod is not deployed, so there is nothing to redeploy. Prod's first deploy must be
  built from a commit that contains this fix.
- **Exposure:** none on an exposed deployment, because prod is not deployed and stage is
  loopback-only. On any deployment running the old code, an anonymous caller could reach every
  `/api/*` route except admin, across studios, because `requireSession` skips the membership
  check when there is no user. The server and `docker/Caddyfile` log no requests, so such access
  could only be found by inspecting the data. This is why the fix must precede the first deploy.
- **Slice 5b:** the same fix is carried on `supabase-migration` (merge `main` into it, or
  cherry-pick).
