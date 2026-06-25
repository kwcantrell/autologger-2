# autologger-cf

AutoLogger on the Cloudflare developer platform — **phases 1–2** of the migration
described in `../autologger/docs/cloudflare/autologger-on-cloudflare.md`.

This Worker is a faithful TypeScript port of the catalog + auth slice of the Python
backend (`../autologger`). It authenticates via Google OAuth, persists
users/studios/shows/prefs in **D1**, holds CSRF + login sessions in **KV**, and answers
the profile / studio / shows endpoints with the **same JSON shapes** the existing React
frontend expects.

> Local-only. No Cloudflare login, no remote provisioning. D1/KV ids in `wrangler.jsonc`
> are placeholders Miniflare ignores in local mode; secrets live in a gitignored
> `.dev.vars`. Real ids + `wrangler deploy` are a later, login-gated step.

## Stack

- **Hono** — routing + middleware (mirrors `web/app.py` + routers)
- **Zod** — request validation at the route boundary (ports `web/schemas.py`)
- **jose** — Google ID-token verification against Google's JWKS
- **D1** (SQLite) — global catalog; **KV** — login sessions + OAuth CSRF state (TTL)

## Source layout

```
src/
  index.ts              Hono app + middleware chain + router mounts   (← web/app.py)
  env.ts                Typed env accessors                           (← auth_identity.py getters)
  schemas.ts            Zod request schemas                           (← web/schemas.py)
  studio.ts             Built-in studios + palette/category helpers   (← studio.py)
  types.ts              Shared Hono generics (Bindings + Variables)
  db/
    d1.ts               D1 query layer + _profile_payload assembly    (← storage/db.py, deps.py)
    migrations/0001_init.sql   Catalog DDL + seeded built-in shows
  auth/
    oauth_google.ts     Authorize URL, code exchange, ID-token verify (← oauth_google.py)
    identity.ts         KV sessions + CSRF, bearer compare, gate rule (← auth_identity.py)
  middleware/
    auth.ts             Per-request context + REQUIRE_LOGIN gate      (← app.py auth_identity_and_gate)
    ipAllowlist.ts      CIDR allowlist on CF-Connecting-IP            (← app.py ip_allowlist_middleware)
  routers/
    auth.ts             /auth/google/start|callback, /auth/logout
    profile.ts          GET /api/studio, GET|PUT /api/profile
    shows.ts            GET|POST /api/shows
```

## Endpoints (this phase)

| Route | Python parity |
|-------|---------------|
| `GET /auth/google/start` · `/callback` · `GET\|POST /auth/logout` | `routers/auth.py` |
| `GET /api/studio` | `routers/profile.py` → `studio_to_api_dict` |
| `GET /api/profile` · `PUT /api/profile` | `routers/profile.py` → `_profile_payload` |
| `GET /api/shows` · `POST /api/shows` | `routers/shows.py` |

`SessionDO` / real-time / audio / transcription are phases 3–7 and are **not** built here.

## Quick start (local)

```bash
npm install
cp .dev.vars.example .dev.vars     # fill GOOGLE_CLIENT_SECRET to test real OAuth

npx wrangler types                              # regenerate worker-configuration.d.ts (Env)
npx tsc --noEmit                                # type check
npx wrangler d1 migrations apply autologger --local   # create + seed local D1
npx wrangler dev --port 8787 --local            # Miniflare: D1 + KV under .wrangler/state
```

> Sandbox note: if wrangler errors with `EACCES … /home/node/.config/.wrangler`, point its
> global config dir somewhere writable: `XDG_CONFIG_HOME=/tmp/wr-config npx wrangler …`.

### Verify parity

```bash
B=http://127.0.0.1:8787

# Anonymous parity (REQUIRE_LOGIN=0): profile + shows both answer.
curl $B/api/profile
curl $B/api/shows

# Login gate (restart with `--var REQUIRE_LOGIN:1`):
curl -o /dev/null -w '%{http_code}\n' $B/api/shows                       # 401
curl -o /dev/null -w '%{http_code}\n' $B/api/profile                     # 200 (always anonymous)
curl -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer <API_TOKEN>' $B/api/shows   # 200

# OAuth round-trip needs real Google creds (GOOGLE_CLIENT_ID var + GOOGLE_CLIENT_SECRET
# in .dev.vars) and PUBLIC_BASE_URL registered as an authorized callback URI. Without
# creds, exercise the cookie/KV plumbing by hand-inserting a local session:
#   HASH=$(node -e "console.log(require('crypto').createHash('sha256').update('tok').digest('hex'))")
#   wrangler d1 execute autologger --local --command "INSERT INTO users (...) VALUES (...)"
#   wrangler kv key put --local --binding AUTH "session:$HASH" "<userId>"
#   curl -H "Cookie: autologger_sid=tok" $B/api/profile     # → logged_in user + teams
```

## Pointing the React frontend here

Leave `../autologger/frontend` untouched. Run its Vite dev server and set the API root to
`http://127.0.0.1:8787` via the existing `data-api-root` / `__API_ROOT__` mechanism
(`frontend/src/api/client.ts`). Workers Assets hosting + the WebSocket migration are
phase 5/7.

## Deploy (later, login-gated — run by you)

Not part of this phase. You'll create real resources (`wrangler d1 create`,
`kv namespace create`), paste their ids into `wrangler.jsonc`, push secrets with
`wrangler secret put`, then `wrangler deploy`.
