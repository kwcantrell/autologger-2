# Tasks — session-deep-links

Plan of record (post-panel, post-gate — see design.md "Panel & review log"). Every
code-bearing task lands with its tests; `npm run typecheck` + `npm test` gate each
commit. `file:line` anchors are orientation only — locate the quoted code by content
before editing.

## 1. Server: the two authorized deltas

- [x] 1.1 Integration tests first — HTML route: `GET /sessions/<id>` returns 200 with
      the index HTML (same body as `/`) for an arbitrary id, anonymous client, no
      `Set-Cookie`; real vs. nonexistent id responses are byte-identical; `GET
      /sessions` and `GET /sessions/a/b` still 404 when no asset matches; do NOT
      assert 404 for `/sessions/a%2Fb` (it is one raw segment and serves the shell)
      (spec: api-contract-freeze delta, HTML-route scenarios)
- [x] 1.2 Add `app.get('/sessions/:id', …)` to the serve block in `server/src/app.ts`
      reusing `serveHtml` with the index page path; update the serve-block comment
      (drop "no client-side router")
- [x] 1.3 Integration tests first — detail endpoint: `GET /api/sessions/<id>` 200 with
      field-for-field list-entry shape parity (compare against the same session's
      entry in `GET /api/sessions`); 200 for an authorized session outside the
      requester's active show/studio prefs; 200 for an archived session; one masked
      404 (same shape) for nonexistent, `ui_hidden`, and foreign-studio ids
      (spec: api-contract-freeze delta, detail-endpoint scenarios)
- [x] 1.4 Implement the detail endpoint in `server/src/routers/sessions.ts` beside the
      other per-session routes, reusing the existing per-session auth helper
      (`requireSession`) and the list serializer (shape parity by construction —
      design D5/D7)
- [x] 1.5 README endpoint table: add the two rows (`GET /sessions/:id` HTML,
      `GET /api/sessions/:id` JSON)

## 2. Web test tier bootstrap

- [x] 2.1 Add `web/vitest.config.ts` (jsdom environment), `@testing-library/react` +
      jsdom dev-deps in `web/package.json`, a `test` script, and extend the root
      `test` script to include `-w web`; prove the tier with one trivial rendering
      test; test renders run under StrictMode (design D8)
- [x] 2.2 RootGate gate-state tests (paying down the add-login-screen residual): the
      four states — loading, initial-load error (retry control), login view when
      `oauth_configured && !logged_in`, shell otherwise — mocking `useProfile`

## 3. Router + URL-driven session state

- [x] 3.1 Add `wouter`; introduce the single navigation wrapper (`navigate(path,
      {replace?})` helper — the only exported navigation API; design D1/D4); rewire
      `AppShell`: `activeSessionId` from `useRoute('/sessions/:id')`, select and
      create push `/sessions/:id`, re-selecting the active session is a no-op (no
      duplicate history entry), close (and the settings-modal studio-switch branch,
      via prop or navigation replacing its `window.V3_closeSession?.()` call) pushes
      `/` (design D2/D3)
- [x] 3.2 Retire the legacy spine: remove `syncChrome`, all `body.dataset.sessionId`
      writes, and the `window.V3_selectSession`/`V3_closeSession` globals (declaration
      site in `AppShell`, caller in `HomeSettingsModal`'s studio-switch save branch).
      `syncChrome` owns TWO behaviors that must move to route-driven rendering (design
      D9): the `#v3-session-placeholder` ↔ `#v3-session-grid` visibility swap (the
      grid is statically `hidden` in `SessionWorkspace` JSX today — without this the
      workspace never appears; `smoke.spec.ts` and `visual.spec.ts` assert on it) and
      the title reset to "AutoLogger" when no session is active
- [x] 3.3 Unit tests (wouter memory-location where needed): select/create/close/Back
      drive URL + workspace mount; re-select adds no history entry; the studio-switch
      save path navigates to `/` like the close control; no dataset writes and no
      `V3_*` globals defined after any transition (spec: web-session-routing,
      URL-addressed state + legacy spine requirements, incl. "Studio-switch close
      path still works")

## 4. Deep-link resolution states

- [x] 4.1 `useSession(id)` per-id react-query hook against `GET /api/sessions/:id` —
      fetch on route entry, NO polling (latched by construction; design D5)
- [x] 4.2 Resolution component rendering the five states: loading (brand treatment) →
      workspace (200, not archived) / archived interstitial (200 archived: identifies
      the session, existing Restore mutation — whose success invalidates the per-id
      query so the same URL re-resolves to the workspace — and a way to leave) /
      not-found (404; identical for nonexistent, deleted, unauthorized; way to leave)
      / retryable error (non-404; distinct from not-found). Workspace mount is gated
      on resolution (arbitrary ids must not drive per-session fetches)
- [x] 4.3 Unit tests for all five states plus: no not-found flash while loading;
      created-session navigation resolves without not-found; transient failure shows
      error (not not-found) and retry re-issues the query; a mounted workspace is not
      evicted when the session vanishes from the polled list (spec:
      web-session-routing, deep-link resolution requirement, all six scenarios)

## 5. Originator-scoped transport stop on departure

- [x] 5.1 Track roll origination: set a flag when THIS client issues transport-start
      during the current workspace mount (cleared on departure/unmount); departure
      watcher on the navigation wrapper + a raw `popstate` listener (never wouter's
      hook — design D4) fires `window.AutoLogger_stopTransportIfNeeded?.()` exactly
      once when leaving `/sessions/:id` IFF the flag is set; remove the direct calls
      in the close handlers; `SessionWorkspace`'s global definition/cleanup stays
      untouched
- [x] 5.2 Unit tests: mock the global; originator's departure fires exactly once for
      close, popstate, and session-switch; a non-originator (deep-linked into a
      rolling session) never fires on any departure; no stop on mount under
      StrictMode double-invoke (spec: web-session-routing, transport-stop requirement)

## 6. Post-login deep-link return

- [x] 6.1 Validator util in `web/src/shared/utils/` (URL-parse, reject-by-default,
      router-known paths only) with exhaustive unit tests: accepts `/sessions/abc?x=1`;
      rejects `//evil.com`, `/\evil.com`, `https://evil.com/x`, values with `\` or
      ASCII control chars, non-strings, empty, anything not resolving to the current
      origin, and same-origin non-router paths like `/admin/users`
      (spec: web-login-experience delta, validation clause)
- [x] 6.2 Stash write riding the three LoginPage anchors (sign-in, create-account,
      error-retry) via synchronous `onClick` — the anchors keep their
      `/auth/google/start` hrefs (login-gate e2e asserts them); write the current
      path+query IFF the location matches `/sessions/:id`, otherwise leave any
      existing stash untouched (design D6)
- [x] 6.3 Consume effect keyed explicitly on `auth.logged_in === true` (NOT on
      AppShell mounting — dev anonymous mode mounts the shell logged-out and must
      never consume): validate → `replace`-navigate via the router → clear; stash
      cleared on every exit path (valid, invalid, navigation throw)
- [x] 6.4 Unit tests: full round-trip (stash → consume → cleared), malicious and
      out-of-router stash discarded without navigation, retry-from-error-page does not
      clobber the stash and the original path survives, no-stash boot navigates
      nowhere, anonymous-shell boot never consumes (spec: all post-login scenarios)

## 7. Dev-server parity + docs

- [x] 7.1 Vite dev-only middleware serving the index entry for exactly `/` and
      `/sessions/<single-segment>` — precise matcher (must not touch `/admin/users`,
      the `/api`+`/auth` proxies, `/@vite/*`, `/src/*`, `/assets`), and must return
      `server.transformIndexHtml` output, not raw file bytes (the source HTML's
      relative `./main.tsx` would otherwise 404 at nested paths — design D7)
- [x] 7.2 README dev instructions: browse `http://127.0.0.1:5173/` (replacing the raw
      entry path), note deep links work in dev

## 8. e2e

- [x] 8.1 Flip the `smoke.spec.ts` session assertion from `body.dataset.sessionId` to
      the URL (`/sessions/<id>`); confirm the existing `#v3-session-grid` visibility
      assertions in `smoke.spec.ts` and `visual.spec.ts` stay green (design D9)
- [x] 8.2 Deep-link smoke: create a session via the UI, capture its URL, `page.goto`
      it fresh, assert the workspace mounts; a garbage-id visit renders the not-found
      state
- [x] 8.3 Login-gate project: anonymous visit to `/sessions/<id>` renders the login
      view with the address bar still at `/sessions/<id>` (spec: web-login-experience
      "Anonymous deep link keeps its URL")

## 9. Final gates

- [x] 9.1 `npm run typecheck` + `npm test` + `npm run e2e` + `npm run lint` green at
      branch tip
- [x] 9.2 Whole-branch review (per SDLC), then merge readiness: conventional commits,
      no stray worktrees, no secrets
