# autologger-cf

AutoLogger on the Cloudflare developer platform — **phases 1–7** of the migration
described in `../autologger/docs/cloudflare/autologger-on-cloudflare.md`.

This Worker is a faithful TypeScript port of the Python backend (`../autologger`). It
authenticates via Google OAuth, persists the global catalog (users/studios/shows/prefs)
in **D1**, holds CSRF + login sessions in **KV**, stores live per-session data (events,
transport, audio metadata, recording lease, transcript words, topics) in a **Durable
Object per session** (embedded SQLite), keeps audio bytes in **R2**, and pushes live
updates over a hibernatable **WebSocket** — all with the **same JSON shapes** the existing
React frontend expects.

> Local-only through phase 7. No Cloudflare login, no remote provisioning. D1/KV/DO/R2 ids
> in `wrangler.jsonc` are placeholders Miniflare ignores in local mode; secrets live in a
> gitignored `.dev.vars`. Real ids + `wrangler deploy` are the final, login-gated cutover.

## Architecture (doc §2)

- **D1 = global catalog** — cross-session, relational, not hot. Also holds a lightweight
  `sessions` index (metadata + a small live projection) so listing + status + cheap
  rolling-timecode never wake a DO.
- **One Durable Object per session** (`SessionDO`, addressed by `idFromName(sessionId)`) =
  the live spine: events, transport, audio-segment metadata, recording lease (in-DO state +
  a 40s `alarm` auto-expiry), transcript words, topics, and the WebSocket fan-out. Single
  writer, so the Python `RLock` and `events_stream_revision` polling machinery disappear —
  the DO broadcasts instead. After each mutation the Worker mirrors a few live fields back
  to the D1 index (`projectSessionLive`), so the DO never needs a DB binding.
- **R2** = audio bytes at `audio/<session_id>/<ordinal>_<uuid>.<ext>`; the DO holds only
  metadata + R2 keys. Download streams R2 back with HTTP range support.
- **Transcription + YouTube import are unavailable** on this deployment (no Workers AI /
  Workflow / Queue / external box): the `…/generate`, `…/youtube-import`, and
  `transcribe.csv` endpoints return a clean `503 {detail}` the frontend toasts. Manual
  transcript-word/topic CRUD still works. The only bindings the whole roadmap adds beyond
  phases 1–2 are **DO + R2** (no `ai` / `workflows` / `queues`).

## Stack

- **Hono** — routing + middleware (mirrors `web/app.py` + routers)
- **Zod** — request validation at the route boundary (ports `web/schemas.py`)
- **jose** — Google ID-token verification against Google's JWKS
- **D1** (SQLite) — global catalog; **KV** — login sessions + OAuth CSRF + Companion
  presence (TTL); **Durable Objects** (SQLite) — per-session live data + WebSocket;
  **R2** — audio bytes

## Source layout

```
src/
  index.ts              Hono app + middleware chain + router mounts   (← web/app.py)
  env.ts                Typed env accessors                           (← auth_identity.py getters)
  schemas.ts            Zod request schemas                           (← web/schemas.py)
  studio.ts             Studios + palette/category + event enrichment (← studio.py)
  timecode.ts           SMPTE timecode math + UTC helpers             (← models.py)
  types.ts              Shared Hono generics (Bindings + Variables)
  durable/
    SessionDO.ts        Per-session DO: events, transport, audio meta, lease+alarm,
                        transcript words, topics, WebSocket fan-out   (← storage/db.py)
  db/
    d1.ts               D1 query layer + profile + sessions index + admin (← storage/db.py, deps.py)
    migrations/0001_init.sql            Catalog DDL + seeded built-in shows
    migrations/0002_sessions_live_split.sql   Sessions index metadata + live projection
  auth/
    oauth_google.ts     Authorize URL, code exchange, ID-token verify (← oauth_google.py)
    identity.ts         KV sessions + CSRF, bearer compare, gate rule (← auth_identity.py)
  middleware/
    auth.ts             Per-request context + REQUIRE_LOGIN gate      (← app.py auth_identity_and_gate)
    ipAllowlist.ts      CIDR allowlist on CF-Connecting-IP            (← app.py ip_allowlist_middleware)
  routers/
    _helpers.ts         ApiError, session access gate, DO stub, marked-at parsing
    auth.ts             /auth/google/start|callback, /auth/logout
    profile.ts          GET /api/studio, GET|PUT /api/profile
    shows.ts            GET|POST /api/shows
    sessions.ts         list/create/update/archive/restore/delete; youtube-import (503)
    events.ts           events CRUD, transport, status, lease, WebSocket upgrade
    audio.ts            R2 upload/list/range-download, waveform, sync-from-disk
    companion.ts        Companion presence (KV) + state + log/transport/command (WS relay)
    transcribe.ts       transcript-words + topics CRUD; generate/csv (503)
    exports.ts          export.csv / export.jsonl (← export.py)
    admin.ts            ADMIN_TOKEN-gated users + studio-definitions admin
```

## Endpoints

| Route | Python parity |
|-------|---------------|
| `GET /auth/google/start` · `/callback` · `GET\|POST /auth/logout` | `routers/auth.py` |
| `GET /api/studio` · `GET\|PUT /api/profile` · `GET\|POST /api/shows` | `routers/profile.py`, `shows.py` |
| `GET\|POST /api/sessions` · `PUT\|DELETE /api/sessions/{id}` · `…/archive\|restore` | `routers/sessions.py` |
| `GET\|POST /api/sessions/{id}/events` · `PUT\|DELETE …/events/{eid}` | `routers/events.py` |
| `GET …/status` · `POST …/transport/start\|stop` · `GET …/show-categories` | `routers/events.py` |
| `…/audio-recording-lease` (claim/heartbeat/release) · `GET …/ws` | `routers/events.py` |
| `GET\|POST …/audio/segments` · range `GET …/segments/{id}` · `PUT …/waveform` | `routers/audio.py` |
| `GET\|POST\|PATCH\|DELETE …/transcript-words` · `…/topics` | `routers/transcribe.py` |
| `…/transcript-words/generate` · `…/topics/generate` · `transcribe.csv` · `youtube-import` → **503** | (unavailable) |
| `GET …/export.csv` · `…/export.jsonl` | `routers/exports.py` / `export.py` |
| `/api/companion/presence\|state\|log\|transport\|command\|categories\|commands/*` | `routers/companion.py` |
| `/api/admin/users` · `/api/admin/studios` · `…/users/{id}/memberships\|disable\|enable` | `routers/admin.py` |

WebSocket messages broadcast by the DO: `event.changed` · `transport.changed` ·
`audio.changed` · `lease.changed` · `command` (Companion → browser). The frontend now
consumes these directly (`frontend/src/api/hooks/useSessionSocket.ts`): the fast status
poll, the `events_stream_revision` watcher, the `EventLogSheet` 3 s poll, and the
`/companion/commands/wait` long-poll are deleted. A single slow status poll (~1.2 s) runs
**only while rolling/recording** to advance the live timecode; the WS drives every discrete
change. The `commands/wait` endpoint still returns an immediate empty list so any stale
client degrades to a slow poll instead of a tight loop.

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

## Serving the SPA from the Worker (Assets)

The Worker serves the SPA itself via **Workers Assets** (`assets` binding `ASSETS` in
`wrangler.jsonc`, directory `./public`). The frontend's CF build emits into that directory:

```bash
cd ../autologger/frontend && AUTOLOGGER_CF_BUILD=1 npm run build   # → ../../autologger-cf/public
cp ../src/autologger/web/static/logo-autologger-{transparent,app}.png \
   ../../autologger-cf/public/static/                              # logos live outside react-dist
```

`AUTOLOGGER_CF_BUILD=1` flips the Vite `base` to `/` (HTML references `/assets/…`, which
Assets serves) and the `outDir` to this repo's `./public`; with the var unset the Python
build is byte-identical. `public/` is gitignored — it is a reproducible artifact.

`src/index.ts` routes HTML explicitly (there is no client-side router, so `not_found_handling`
is `"none"`): `GET /` and `GET /admin/users` read their built HTML from ASSETS, substitute
`__API_ROOT__` → `/api` (the Worker doing what Python's `_render_html` did), and return it;
a trailing `app.get('*', …)` streams hashed `/assets/*` + `/static/*` from ASSETS. The
`/api` + `/auth` routers are mounted first, so the API is never shadowed.

## Cutover — provision + deploy (login-gated, run by you)

The API surface (phases 3–7), the SPA hosting, and the frontend WS cutover are complete and
locally verified against `wrangler dev`. The final step provisions real resources and ships:

```bash
# 1. Build the SPA + copy logos (above).
# 2. Regenerate types after the wrangler.jsonc assets binding:
XDG_CONFIG_HOME=/tmp/wr-config npx wrangler types
# 3. Provision (paste each real id over "local" in wrangler.jsonc):
wrangler d1 create autologger
wrangler kv namespace create AUTH
wrangler r2 bucket create autologger-audio
wrangler d1 migrations apply autologger --remote
# 4. Secrets + prod vars:
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put API_TOKEN
wrangler secret put ADMIN_TOKEN
#    set prod vars GOOGLE_CLIENT_ID, REQUIRE_LOGIN, PUBLIC_BASE_URL, COOKIE_SECURE=1
# 5. Deploy (ships DO migration tag v1 + ASSETS on first deploy):
wrangler deploy
# 6. Register PUBLIC_BASE_URL as a Google OAuth redirect; point DNS/route at the Worker;
#    drain + decommission the FastAPI box.
```

Durable Objects + R2 are not emulated against production data; the DO migration
(`migrations` tag `v1` in `wrangler.jsonc`) ships `SessionDO` on first deploy.
