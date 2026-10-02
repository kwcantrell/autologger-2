# Design

## Context

`server/src/middleware/auth.ts:30` computes `path = new URL(c.req.url).pathname`. That path is
WHATWG-normalised (dot-segments collapsed) but percent-encoding is kept. It feeds two decisions:
- `apiTokenAuth = path.startsWith('/api/companion/') && token valid`;
- `apiRequestRequiresLogin(path, method)` (`server/src/auth/identity.ts:122`).

Hono's router matches `getPath(request)` (`node_modules/hono/dist/utils/url.js:83-94`), a
`%25`-protected `tryDecodeURI` of that same pathname, exposed as `c.req.path`. `/%61pi/x`
decodes to `/api/x`. `%2F` and `%3F` stay encoded (decodeURI's reserved set). `%5C` is decoded
to `\`, but the gate and the router read the same value, and the router's rule 1 rejects `%5C`
under `/api` anyway.

## Goals / Non-Goals

**Goals:** the login gate, the `API_TOKEN` scope and the router agree on one path.

**Non-Goals:** see proposal.md.

## Decisions

### D1. Use `c.req.path` for both decisions
Replace line 30 with `const path = c.req.path;`. It is the exact value the router matched, so
any request that routes to an `/api/*` handler is gated as `/api/*`. A request whose decoded path
is not under `/api/` cannot reach an `/api/*` handler.

*Alternative:* 400 any request whose raw and decoded paths differ. Rejected: it changes answers
for legitimate encoded characters in ids, and the router's forwarding rules already define which
encodings are valid.

### D2. Tests cover the encodings the Caddyfile forwards, in both directions
All cases run under `envWith({ REQUIRE_LOGIN: '1' })`.

`gate.int.test.ts`:
- `GET /%61pi/sessions`, `/a%70i/sessions`, `/%61%70%69/sessions`, and `/api/s%65ssions` (an
  encoded later segment, a guard against a future "decode the prefix only" refactor) each give
  `401 Login required.` with no credentials;
- `GET /%61pi/companion/state` with no token gives 401. With the valid token it gives 200.
- `GET /api/%63ompanion/state` with the valid token gives 200. This is the token-scope direction
  the fix opens, pinned so it reads as deliberate.
- `GET /%61pi/profile` and `GET /api/pro%66ile` give 200 (exempt, GET only).
  `HEAD /api/profile` gets 401 today; that is pre-existing and out of scope (recorded for 5b).
- `GET /%61pi/admin/users` and `/api/%61dmin/users` keep the admin-token rules (401 with a
  wrong token).
- A table case: for each registered `/api` route (read from `app.routes`), `/%61pi<rest>` with
  no credentials gets the same status as `/api<rest>`.

`authz.int.test.ts`: a valid token, and no cookie, on `/%61pi/sessions/<id>/status` for a real
seeded session gives 401. Today it returns the session's status, part of the bypass. A made-up id
would give 404 and hide the gate.

Only the no-credential encoded-prefix cases, the encoded companion token case
(`/api/%63ompanion`), and the authz case are red before D1. The rest are guards that pass both
before and after; task 1.1 records which is which.

## Assumptions (each with the command that tests it)

| # | Assumption | Command | Observed |
|---|---|---|---|
| A1 | The bypass is live on stage | `curl -s -o /dev/null -w '%{http_code}' 127.0.0.1:8788/%61pi/sessions` | `200` (and `/api/sessions` gives `401`) |
| A2 | The gate uses the raw pathname | `grep -n pathname server/src/middleware/auth.ts` | `30: const path = new URL(c.req.url).pathname;` |
| A3 | Hono routes on a decodeURI of the path | `grep -n "tryDecodeURI(path" node_modules/hono/dist/utils/url.js` | `94: return tryDecodeURI(path.includes("%25") ? path.replace(/%25/g, "%2525") : path);` |
| A4 | No other server security decision uses the raw path, except the upgrade dispatcher (literal-only admit) | `grep -rn "new URL(c.req.url)\|\.pathname" server/src --include=*.ts \| grep -v test` | `upgradeDispatch.ts:111` (admits literal /api only), `sessionWs.ts:19` (query only), `middleware/auth.ts:30` |

## Risks / Trade-offs

- **A legitimate client sending an encoded `/api` prefix now gets 401 without login.** That is
  the intended behavior.
- **Drift.** A future middleware that decides on `new URL(c.req.url).pathname` would bring the
  bug back. A CI grep that bans `.pathname` in `server/src/middleware/**` and
  `server/src/routers/**` (allow-listing `upgradeDispatch.ts`) is a follow-up for 5b, where
  AGENTS.md rule 8 can be applied without growing this hotfix.
- **Merge into `supabase-migration`:** 5b's `require-login` modifies the same middleware and the
  same spec requirement. Merge `main` into `supabase-migration` after this lands, before 5b's
  first commit, so 5b builds on the fix.
