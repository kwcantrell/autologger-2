# Tasks 7.1 / 7.2 — Dev-server parity + docs

## 7.1 — Vite dev-only middleware

**File:** `web/vite.config.ts` — new `sessionDeepLinkDevShell()` plugin, added to the
`plugins` array alongside `react()`/`tailwindcss()`.

**Matcher:** `SESSIONS_ROUTE_RE = /^\/sessions\/([^/]+)$/`, applied to the pathname only
(query/hash stripped via `url.split('?')[0].split('#')[0]` before testing). This is a
verbatim mirror of `isSessionRoutePathname` in
`web/src/shared/utils/loginReturnPath.ts` (same "exactly one non-empty segment" rule),
kept as an independent regex — this file loads under Vite/Node config-loading, not the
app's module graph, so importing the app source isn't viable. The route matches exactly
`/` or `/sessions/<single-segment>`; everything else calls `next()` immediately and is
untouched.

**Placement — pre-hook, not post-hook (empirically determined):** I first wrote this as
the documented "post middleware" pattern (`configureServer` returning a function). That
made `GET /` 404 — this workspace's Vite `root` has no `index.html` at its root (the
real entry lives nested at `src/pages/index/index.html`), so Vite's own built-in
index-fallback middleware 404s on `/` *before* a post-hook ever runs. Switched to
installing the middleware inline (a "pre" hook) in `configureServer`, which runs before
Vite's internals. The design doc explicitly permits this alternative ("post middleware
order **or** careful pathname guard — verify empirically") — since the matcher is exact
(not a broad SPA-fallback), running early doesn't shadow `/@vite/*`, `/src/*`,
`/assets`, or the `/api`/`/auth` proxies; they all fail the exact match and fall through
to `next()`.

**Second bug found + fixed empirically — relative asset path:** `server.transformIndexHtml`
injects the HMR/React-refresh preamble but does **not** rewrite the source HTML's
document-relative `<script src="./main.tsx">` into an absolute path. The browser
resolves that relative reference against the *actual request URL* — verified by curling
`/` and `/sessions/abc` and diffing the returned bodies (byte-identical, both still
containing `src="./main.tsx"`). Serving that as-is at `/sessions/abc` would have the
browser fetch `/sessions/main.tsx` → 404 → dead app, exactly the failure design D7 warns
against for raw file bytes — `transformIndexHtml` alone does not prevent it. Fix: before
calling `transformIndexHtml`, the middleware rewrites same-directory relative
`src="./"` / `href="./"` references to the entry's real root-absolute dev path
(`/src/pages/index/`) — the same path the raw entry URL resolves them to. Confirmed via
Playwright: navigating to `http://127.0.0.1:5199/sessions/abc` renders the actual React
app (RootGate's "couldn't reach the server" state, because no backend was running in
this isolated dev-server-only check — proving `main.tsx` loaded and executed, not a dead
page). Console showed only the expected `502` on `/api/profile` (no backend), no 404 on
any JS module.

**Content-Type:** set explicitly to `text/html` on the response.

**Dev-only / build-unaffected:** the plugin declares `apply: 'serve'` and only
registers a `configureServer` hook (never referenced during `vite build`).
`npm run build -w web` was run with `dist/` removed first; output was the normal hashed
MPA build (`dist/src/pages/index/index.html` with `<script src="/assets/index-*.js">`,
`dist/src/pages/admin-users/index.html` unaffected) — the dev shell had zero effect.

## 7.2 — README dev instructions

`README.md` "Dev flow" section: `Browse http://127.0.0.1:5173/src/pages/index/index.html`
→ `Browse http://127.0.0.1:5173/`, with a note that `/sessions/<id>` deep links also
work in dev via the new middleware, that the raw entry path still works, and the admin
page's dev URL (`http://127.0.0.1:5173/src/pages/admin-users/index.html`) is unchanged
(added explicitly since 7.1's precise-matcher invariant is exactly what keeps it
unaffected).

## Verification gates

1. **`npm run typecheck` + `npm test`** — both green (server 252/252, web 123/123,
   companion 20/20 tests; typecheck clean across server/web/companion/e2e).

2. **Empirical dev-server check** — ran `npx vite --port 5199 --strictPort` from `web/`
   (not the configured 5173, to avoid colliding with any other instance), curled:

   | Request | Result |
   |---|---|
   | `GET /` | `200`, transformed HTML, script src `/src/pages/index/main.tsx` (root-absolute) |
   | `GET /sessions/abc` | `200`, byte-identical body to `/` |
   | `GET /sessions/abc?x=1` | `200` |
   | `GET /admin/users` (dev, this change) | `404` |
   | `GET /admin/users` (baseline, `git stash` to pre-change) | `404` — **unchanged** |
   | `GET /` (baseline, pre-change) | `404` — confirms this task *fixes* a real gap |
   | `GET /sessions/abc` (baseline, pre-change) | `404` — same |
   | `GET /src/pages/index/index.html` (raw entry) | `200` — still works |
   | `GET /sessions/a/b` (nested, must not match) | `404` — falls through correctly |
   | `GET /sessions` (no id) | `404` |
   | `GET /src/pages/index/main.tsx` (module fetch) | `200`, `content-type: text/javascript` |
   | `GET /@vite/client` | `200`, `content-type: text/javascript` |

   Browser check (Playwright) at `/sessions/abc`: page title "AutoLogger", React
   rendered (RootGate error state due to no backend in this isolated check — confirms
   the module graph loaded, not a dead page). Server killed after.

3. **`npm run build -w web`** — succeeded; `dist/` output unaffected (hashed asset
   paths as normal); `git status` shows only `README.md` and `web/vite.config.ts`
   changed (`dist/` is gitignored).

## Note on the verification process

Mid-verification, `git stash` (used to capture pre-change baseline curl behavior) was
followed by a `git stash pop` in a command chain that got interrupted by a background
`pkill`/exit-144 quirk, leaving the edits sitting in `stash@{0}` for a few tool calls
with a clean working tree. Caught via `git diff --stat` returning empty unexpectedly;
`git stash pop` recovered both files with zero loss (confirmed via `git stash list`
empty afterward and full content diff matching what was authored). Full gate suite
(typecheck/test/build) was re-run after recovery to be safe.

## Fix round 1 (branch review)

**Minor finding:** the relative-src rewrite (`rawHtml.replace(/((?:src|href)=")\.\//g, ...)`)
was a silent no-op if the entry HTML's script tag ever stopped matching (renamed src,
absolute path, different quotes) — the middleware would then serve HTML whose
`./main.tsx` reference 404s at `/sessions/<id>`, a quietly dead dev app with no signal.

**Fix:** after the replace, assert the rewrite actually did something — either the string
changed, or it no longer contains a stray `src="./` — and throw a descriptive error
(`sessionDeepLinkDevShell: entry HTML shape changed — relative-src rewrite matched
nothing; update the middleware`) into the existing `next(err)` catch path if not, so a
future entry-HTML edit fails loudly in dev instead of silently serving a dead shell.

**Verification:** `npm run typecheck` and `npm test` both green (server 252/252, web
123/123, companion 20/20). Empirical smoke: `vite --port 5199 --strictPort` in `web/`,
curled `/` and `/sessions/abc123` — both `200`, both bodies contain
`src="/src/pages/index/main.tsx"` (root-absolute, confirming the rewrite still fires and
the new assertion doesn't false-positive on the unmodified-shape case). Server killed
after.

**Diff:** `web/vite.config.ts` only, +11/-0.
