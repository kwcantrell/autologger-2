# add-login-screen — design

## Context

On `REQUIRE_LOGIN=1` + OAuth-configured deployments, the unauthenticated index page today
renders the full app shell around an empty profile; the sign-in affordance is a rail
button (`V6Rail.tsx`, predicate `oauth_configured && !logged_in`) that navigates to
`/auth/google/start`. Callback failures return frozen JSON `400`/`503` bodies to a
top-level navigation, stranding the user on a raw JSON page. The callback success path
always `302`s to `/`.

Relevant structure: the web app is a Vite **MPA with no client-side router** (two entries:
`pages/index`, `pages/admin-users`). `GET /api/profile` is the only anonymous `/api`
route under strict login (`/api/admin/*` is separately exempt from the login gate because
it is ADMIN_TOKEN-gated per route) and already carries
`auth.{logged_in, oauth_configured, user}`. The frozen contract (`api-contract-freeze`)
covers the `/auth/*` rows in the README endpoint table.

**Roadmap context (2026-07-14):** the follow-on **session-deep-links** change (SPA
conversion — a client router, `/sessions/:id` URLs, a narrow server HTML-route delta,
and the return of post-login redirect-back with the panel's hardened validator) informs
shapes here without expanding this change's scope. (A **teams-self-serve** change is
also planned but has no bearing on this change's shapes.) This change ships first, on
the current MPA.

## Goals / Non-Goals

**Goals:**
- Branded full-screen login page gating the index app shell for anonymous visitors on
  OAuth-configured deployments, with specified loading and profile-error states.
- Friendly, retryable error rendering for every OAuth callback failure class.
- Zero change to dev anonymous mode (`REQUIRE_LOGIN=0`, no OAuth config).

**Non-Goals:**
- No post-login redirect-back (gate decision 2026-07-14 — see Panel & review log; the
  callback's frozen `302 /` already returns users to the only gated page).
- No client-side router, no new pages/entries.
- No new server surface beyond the authorized callback delta.
- No changes to cookie/session/KV semantics, `/auth/google/start`, `/auth/logout`, or any
  `/api/*` route.
- No `/admin/users` redesign.

## Decisions

### D1 — Gate predicate: `auth.oauth_configured && !auth.logged_in` from `/api/profile`
The login gate keys off the same anonymous-allowed profile payload and the same predicate
the rail button already uses. **Alternatives rejected:** exposing `REQUIRE_LOGIN` in the
profile payload (an observable contract addition; unnecessary because the hybrid config
`REQUIRE_LOGIN=0`+OAuth already presents as signed-out with an empty profile); sniffing
401s from other queries (racy, and the profile query is already the boot signal).
Consequence, accepted deliberately: in the hybrid config the login page replaces today's
empty shell. Dev anonymous mode takes the `oauth_configured: false` branch and is
untouched. Side-effect: the rail sign-in button's render predicate is identical to the
gate's, so the button becomes unreachable — it is removed as part of this change.

### D2 — Gate placement: a root switch above `AppShell`, not inside it
`pages/index/main.tsx` mounts a small root component that runs `useProfile()` and renders
one of four states: neutral loading (query in flight — the existing brand loading
treatment, never a bare blank screen), a retryable error state (query failed),
`<LoginPage/>` (gate predicate true), or `<AppShell/>`. This guarantees no authenticated
child hooks (`useSessions`, sockets, …) mount behind the gate — the "no authenticated
traffic" requirement falls out structurally, including in the error state.
**Alternative rejected:** branching inside `AppShell` (its children own the authenticated
queries; auditing every mount point is fragile). `AppShell` keeps its own `useProfile()`
— same query key, served from the page-lifetime cache.

Shape note for the planned SPA conversion: build the switch as a self-contained wrapper
component (it derives profile state via its own `useProfile()` and renders one of four
children) so that when session-deep-links introduces a router, the wrapper relocates to
sit *above* the routing shell unchanged — the gate must cover every future URL
(including deep links), so it stays a render switch, never a route.

Switch semantics (second-panel fixes): the profile query is **live** (window-focus
refetches, invalidations), so the switch keys on **query status + data**, not on a
latched boot decision — a successful refetch reporting signed-out flips the shell to the
login view (the mid-session sign-out transition; unsaved UI state loss accepted, and
necessary since the rail sign-in button is removed), while a refetch *error* with prior
data present keeps rendering from that data (react-query keeps the data on background
failures; the error state is for the no-data initial-load case only). Also by
construction: `/api/profile` is never 401 (login-exempt), and an IP-allowlist rejection
403s `GET /` itself before any bundle loads — so the error state cannot be reached via
401s or allowlist blocks; do not add handling for those.

**Accepted trade (explicit):** the app is an MPA — every full navigation constructs a
fresh in-memory `QueryClient`, so **every boot blocks first paint of shell-or-login on
one `/api/profile` round-trip**, including for authenticated users (today the shell
paints immediately). On a local/LAN single-process deployment this is one fast query;
the brand loading treatment covers it. There is no cross-navigation cache; the 30 s
`staleTime` on the profile query only dedupes hooks within a single page lifetime.

### D4 — Callback failures: `302 → /?login_error=<code>`, sanitized details to server log
All failure return sites of `GET /auth/google/callback` (eight sites, six code classes —
the three id_token-cluster sites share `token_invalid`) redirect with a stable short code
(`provider_error`, `oauth_not_configured`, `missing_params`, `state_invalid`,
`exchange_failed`, `token_invalid`); the former `detail` strings (including operator
guidance like the `PUBLIC_BASE_URL` hint) move to `console.warn`. Hardenings from panel
review: (a) **log sanitization** — any request- or provider-derived value logged on
these paths (the `error` param, exchange response bodies, offending `state`/`code`
values) is sanitized before logging because a response body was auto-escaped JSON but a
terminal log line is a new injection sink. Normative mechanics (they live here and in
the tests, deliberately NOT in the contract delta — log format is not observable frozen
surface): strip C0 controls (U+0000–U+001F), U+007F, **C1 controls (U+0080–U+009F —
covers 8-bit CSI, which C0-only stripping misses)**, line/paragraph separators
(U+2028/U+2029), and bidi overrides (U+202A–U+202E, U+2066–U+2069); cap at **256
characters**; removal or a visible printable placeholder — never a reversible escape
(JSON/`\u` escaping re-expands to live control bytes downstream). (b) Unexpected
internal errors stay ordinary 500s — no blanket try/catch-to-302; the delta's boundary
rule pins `state_invalid` to a *completed* lookup reporting the state absent (a thrown
KV read propagates to 500).
Note: a failed JWKS fetch surfaces as a `verifyIdToken` throw and thus `token_invalid`;
the log line is what tells the operator it was infrastructure, not the token.
**Contract posture (gate decision):** the mechanism and the meaning/stability of the six
codes are frozen; the set is additive-open (clients must tolerate unknown codes), so a
future code needs no new delta.
**Alternatives rejected:** keeping JSON and content-negotiating HTML on `Accept:` (still
a contract change, more code, and no legitimate machine client ever hits the callback —
verified: no consumer in `web/`, `companion/`, or `e2e/` reads the callback's status);
rendering a server-side HTML error page (duplicates branding outside the web workspace).
This is the change's only observable contract delta, authorized by
`specs/api-contract-freeze/spec.md`.

### D5 — Error rendering lives only in the login view, with grouped copy
Gate decision: three message groups, not six strings — `state_invalid` → "attempt
expired, try again"; `provider_error` → "sign-in was cancelled or refused"; everything
else (including unrecognized codes) → generic sign-in-failed. Rationale: the remaining
codes are indistinguishable not-your-fault failures a user can't act on differently;
`oauth_not_configured` copy is unreachable by construction (the login view only renders
when the profile says OAuth *is* configured) and config-cause copy would leak deployment
state. All six codes remain in the URL for operator diagnostics. An authenticated boot
ignores a stale `login_error` param. The retry control starts a fresh
`/auth/google/start`.

### D6 — Branding and test strategy
The login page reuses the app's existing dark theme tokens and brand assets (wordmark /
loading-video aesthetic) — one new component + CSS in `pages/index/`, no new
dependencies; the Google button follows Google's sign-in branding. Tests:
- **Server** (vitest `*.int.test.ts`): the callback tests in
  `server/src/routers/auth.int.test.ts` currently pin the 400/503 **statuses** (no test
  asserts a body today) — seven assertions in the `callback — error branches` block,
  including the existing unconfigured-callback 503 test, flip to `302` +
  `Location: /?login_error=<code>` + no `Set-Cookie`, using the existing **global-fetch
  Google mocks** (`server/src/test/oauth.ts` — `mockGoogleToken`/`mockGoogleJwks`; the
  established harness mechanism — `envWith` overlays only `config`, and no existing test
  fakes the identity port). New coverage: the missing-`id_token` sub-branch (the one
  `token_invalid` path currently untested — bad-signature and missing-`sub` already have
  tests), an **unexpected-error-stays-500 test** (stub a post-verification write to
  throw; assert 500, no `Location`, no cookie — this is what makes the delta's
  no-blanket-catch rule executable), and log sanitization of a hostile `error` param.
  The existing happy-path test already locks the success path (302 + `Location: /` + 
  cookie) — it is confirmed, not new. The `/start` 503 test is untouched. Known test-file
  hazards: the `runCallback` helper unconditionally mints an `id_token` and queues a
  JWKS mock, so the missing-`id_token` case must be written without it, and the suite
  needs the `afterEach(resetMockAgent)` that `test/oauth.ts` prescribes (it is currently
  missing from this file).
- **e2e** (web rendering): the shared hermetic `webServer` in `playwright.config.ts`
  deliberately forces OAuth **off** (empty creds) and the whole existing suite depends on
  that — so the login-gate smoke gets a **second server config** as an additional
  Playwright project/webServer entry with: dummy `GOOGLE_CLIENT_ID/SECRET/
  PUBLIC_BASE_URL`, **`REQUIRE_LOGIN=1`** (the change's headline posture — this is what
  a profile-payload stub could never verify: that `/api/profile` stays anonymous-allowed
  under strict login), a distinct port **and its own `DATA_DIR`** (e.g.
  `e2e/.data-oauth`) with its own atomic wipe-then-start (webServer entries boot
  concurrently; sharing `e2e/.data` would race the existing server's rm-and-recreate),
  and a per-project `use.baseURL`. Test collection: the new spec is scoped to the new
  project via `testMatch`, and the existing `chromium` project gains one `testIgnore`
  entry for it — so "existing projects untouched" is one line shy of true, and that line
  is deliberate. The spec asserts: login page instead of shell, the Google control's
  href is `/auth/google/start` (**assert href only — never click**; additionally block
  or fail any navigation to `accounts.google.com` so a future "improvement" into a click
  can't hit Google from CI), `?login_error=state_invalid` → expired message, unknown
  code → generic message, and no authenticated `/api/*` requests **or WebSocket
  connections** while gated. The existing OAuth-unconfigured suites remain the
  dev-anonymous regression guard.

## Invariants a future reader might "helpfully" undo

- **Within this change the web stays router-less** — do not introduce a router for the
  login view. When the planned session-deep-links change brings a router, the durable
  form of this invariant is: the login gate remains a render switch mounted *above* the
  routing shell (it must cover every URL, deep links included), never a `/login` route.
- **`/api/profile` stays the only anonymous API** under strict login (`/api/admin/*` is
  exempt from the login gate for a different reason — it is ADMIN_TOKEN-gated per route;
  do not "fix" that exemption). The login page must not need any other endpoint.
- **The callback success path is frozen byte-for-byte** (cookie + `302 /`, no query
  params). Only the failure branches carry `login_error`.
- **`login_error` codes never change meaning once emitted.** Adding codes is allowed
  without a new delta; renaming/reusing is not.
- **Unexpected callback errors stay 500** — do not wrap the handler in a catch-all that
  redirects everything.
- **Redirect-back was dropped deliberately** (gate 2026-07-14): the app has no
  URL-addressed state and the login page only renders at `/`. Do not reintroduce a stash
  "for completeness" in this change; it is planned to return in the session-deep-links
  change (which creates URL-addressed state), hardened per the panel's recipe
  (URL-parse same-origin validation, bypass-case tests, a web test tier).

## Risks / Trade-offs

- [Hybrid config (`REQUIRE_LOGIN=0` + OAuth configured) now shows the login page instead
  of an empty shell] → Intentional (D1); current UI already presents that state as
  signed-out. Recorded in proposal Non-Goals.
- [Every boot blocks on the profile round-trip (MPA, no cross-navigation cache)] →
  Accepted trade, made explicit in D2; brand loading treatment covers the gap; single
  local round-trip in practice.
- [Profile query failure] → Specified: retryable error state, no shell, no authenticated
  traffic (spec requirement "Profile-fetch failure state").
- [Log injection via attacker-controlled callback params] → Sanitization is normative in
  the delta (control chars stripped, length capped) and tested.
- [Losing operator diagnostics from callback JSON bodies] → Former detail strings move to
  the server log (sanitized); operators debugging OAuth misconfig read logs instead of
  the victim's browser.
- [e2e can't exercise a real Google round-trip] → Accepted; server int tests cover the
  callback state machine via the fetch-mocks, e2e covers the renderable web states.
- [Mid-session sign-out unmounts the workspace] → Accepted trade (spec "Mid-session
  sign-out transition"): a revoked/expired session flips the shell to the login view,
  losing unsaved in-page UI state — necessary because the rail sign-in button is removed
  and a latched gate would otherwise strand the user in a 401-ing shell.
- [CSRF-state KV growth via `/start`] → Known pre-existing residual, recorded here
  because this change makes `/auth/google/start` a prominent one-click affordance:
  every hit writes a 30-minute-TTL `csrf:` KV row, `purgeExpired` runs only at startup,
  and there is no rate limit — unbounded-until-restart under flooding. Out of scope to
  fix (would exceed the authorized delta); flagged for a future rate-limit/sweep change.

## Migration Plan

No data migration. Server change is stateless behavior; deploy is a normal restart.
Rollback = revert the commit(s). Stale `?login_error` URLs after a rollback render the
old app shell harmlessly (verified: the index boot path reads no query params).

## Open Questions

None blocking; visual design specifics (exact layout/copy wording) are resolved at apply
time under the frontend-design skill within D5/D6's constraints.

## Panel & review log

### 2026-07-14 — Adversarial panel (4 reviewers: requirements, assumptions, failure & abuse, scope) + gate

**Blockers/majors fixed in place:**
- Profile-query failure state was unspecified (3 reviewers) → new spec requirement
  "Profile-fetch failure state" + D2 fourth state.
- Design claimed react-query caching makes warm navigations instant — false in an MPA
  (fresh QueryClient per boot) → corrected; every-boot profile round-trip recorded as an
  explicit accepted trade; neutral loading state pinned to the brand loading treatment.
- Moving attacker-controlled strings (provider `error` param, exchange bodies) into
  `console.warn` created a new log-injection sink → normative sanitization added to the
  delta + D4, with test coverage.
- Seven assertions in `auth.int.test.ts` pin the old 400/503 JSON behavior → explicitly
  enumerated as rewrites in D6/tasks; added missing coverage (the missing-`id_token`
  sub-branch, a success-path lock, log sanitization).
- D6 described a "faked IdentityVerifier port" that has no injection seam in the int-test
  harness → corrected to the existing global-fetch Google mocks
  (`server/src/test/oauth.ts`).
- The shared e2e `webServer` deliberately forces OAuth off; "flip env vars" would break
  the whole existing suite → e2e plan rewritten as a second Playwright project/server;
  proposal Impact corrected (e2e is touched).
- Delta overclaimed "every failure" → scoped to enumerated classes; unexpected errors
  stay 500 (new scenario).
- Spec wording: WebSocket traffic added to the no-authenticated-traffic requirement;
  redundant scenario folded; `/api/admin/*` caveat added to the anonymous-API invariant.
- Rail sign-in button becomes unreachable under the gate (identical predicate) → removed
  as part of the change rather than left as dead code.

**Escalated to the gate (owner decisions, 2026-07-14):**
- Redirect-back: all four reviewers found the stash could only ever contain `/` (login
  page is the sole writer and only renders at `/`; `/admin/users` is token-gated outside
  the Google world; no URL-addressed state), the drafted string validator was bypassable
  (`/\evil.com`), and no test tier could execute it. **Decision: dropped**; recorded in
  proposal Non-Goals + Invariants. Revisit only when URL-addressed state exists.
- Error-code contract: strict enum freeze vs mechanism freeze. **Decision: freeze the
  mechanism and the meaning/stability of the six codes; the set is additive-open**
  (clients must tolerate unknown codes — which the web spec already required).
- Error copy: six distinct messages vs grouped. **Decision: grouped, three messages**
  (expired / cancelled-or-refused / generic); no config-cause copy (also resolves the
  unreachable `oauth_not_configured` message and the config-state leak).

**Minors accepted as residual:**
- `oauth_not_configured` redirects remain emitted by the server though the login view
  renders them as generic copy — the code stays for URL-level diagnostics; reachable only
  in a configured-at-gate/unconfigured-at-callback race.
- Cross-checks that held up (recorded for the implementer): failure-class table matches
  `auth.ts` branch order exactly; no cookie is set on any failure path today; no
  consumer of callback status codes exists outside the server tests; dev anonymous mode
  provably bypasses the gate; `oauthConfigured()` needs exactly the three env vars.

### 2026-07-14 — Roadmap fold-in + re-panel

Owner set the follow-on roadmap (session-deep-links SPA conversion, then
teams-self-serve). Artifacts updated to stop encoding soon-to-be-wrong assumptions:
router-less invariant scoped to this change with its durable post-router form stated
(gate stays a render switch above the routing shell), D2 gains the wrapper-shape note,
redirect-back non-goal now points at its planned return home. A second full adversarial
panel was run on the updated artifact set — warranted because the post-gate fold added
normative content the first panel never reviewed (profile-error state, mechanism-freeze
wording, grouped copy, 500-stays-500, log sanitization, second e2e server). Results
below.

### 2026-07-14 — Second adversarial panel (4 reviewers, post-fold artifacts)

No escalations — nothing touched the three gate rulings. Dispositions:

**Blockers/majors fixed in place:**
- Mid-session sign-out was unspecified: the profile query is live, so a naive switch
  unmounts the shell unspecified, while a latched gate plus the removed rail button
  strands a signed-out user with no affordance → new spec requirement "Mid-session
  sign-out transition" + D2 switch semantics (key on status+data; refetch errors with
  data present never flip; error state is initial-load-only) + Risks entry.
- e2e second-server plan under-specified in ways that corrupt state (three reviewers
  convergent): shared `DATA_DIR` wipe race between concurrently-booting webServers, new
  spec collected by the existing `chromium` project (its `testIgnore` doesn't exclude
  it), global `baseURL` pinned to :8791, `REQUIRE_LOGIN` unset (hybrid config — forfeits
  the one property a stub can't verify) → D6/tasks rewritten: own `DATA_DIR` + atomic
  wipe, per-project `baseURL`, `testMatch` + one `chromium` `testIgnore` line,
  `REQUIRE_LOGIN=1`, WebSocket-silence assertion, and a block on `accounts.google.com`
  navigation.
- Log-sanitization rule was C0-only (missed 8-bit CSI U+009B and other C1 controls,
  U+2028/2029, bidi overrides), had an unpinned "cap length" and a reversible-escape
  loophole, and lived in the frozen-contract delta though log format is not observable
  surface (two reviewers, opposite directions) → mechanics strengthened (C0+C1+separators
  +bidi, 256-char cap, non-reversible replacement, scope widened to any request/
  provider-derived value) and moved to D4 + tasks; the delta keeps only the observable
  clause (no detail in any response).
- `state_invalid` wording invited over-catching a thrown KV read into a false "expired"
  (a KV outage must stay 500) → delta boundary rule made mechanism-anchored (explicit
  branch returns; only a completed lookup reporting absent is `state_invalid`).
- The no-blanket-catch rule had zero test coverage (a catch-all-to-302 would pass every
  planned gate) → unexpected-error-stays-500 test added to task 1.1.
- Profile-error retry was unbounded (hot-loop risk against the single Node process) →
  retry disabled while in flight, no automatic unbounded retries (spec).
- Test-inventory corrections: the seven assertions pin statuses, not bodies; the
  success-path lock already exists (happy-path test) and is confirmed-not-new; the
  "no ports.identity seam" claim was overstated (the seam exists; `envWith` just has no
  helper and no test uses it) — reworded; `runCallback`/`resetMockAgent` hazards for the
  new tests recorded in D6.
- `missing_params` was the only code without a scenario → added.
- `V6Rail`'s `showSettings` (exact complement of the removed button's predicate) becomes
  constant-true → simplified in the same edit (task 2.3).
- Roadmap context overclaimed: teams-self-serve informs nothing here → demoted.
- D2 wrapper wording was internally inconsistent (hook-inside vs props-in) → pinned to
  hook-inside.

**Escalated to the gate:** none.

**Minors accepted as residual:**
- CSRF-state KV growth via `/start` (pre-existing, more discoverable post-change) —
  recorded in Risks, deferred to a future rate-limit/sweep change.
- Refuted-by-evidence worries recorded for posterity: IP-allowlist 403 blocks `/` itself
  so the error state is unreachable via allowlist; no env config race can strand a
  signed-out user; an attacker-minted `?login_error` link is harmless (retry target is
  server-fixed, no redirect primitive — load-bearing on redirect-back staying dropped);
  a stray e2e click through to Google with dummy creds fails harmlessly.

### 2026-07-14 — Owner addition post-panels: create-account affordance

Owner requested a "create account" control on the login page. Zero server/contract
impact by construction: first-time Google sign-in already auto-creates the account
(the callback's new-user branch), so the affordance navigates to the same
`/auth/google/start` — it is copy/affordance only. Spec "Google sign-in entry" extended
(second control + scenario, copy must not promise a separate registration form), task
2.1 updated, proposal wording aligned. Note for the roadmap: this makes the fresh
account's empty no-membership state more reachable, which the planned teams-self-serve
onboarding ("create your first team / pending invites") is designed to absorb.

### 2026-07-14 — Post-gate consistency read (light tier)

Clean except two factual corrections against the live test file, fixed across all four
artifacts: the callback failure block holds **seven** locking assertions (an earlier
panel entry miscounted nine), and the "new coverage" list wrongly included branches that
already have tests — the unconfigured-callback 503 test exists (it is one of the seven
rewrites) and two of the three `token_invalid` sub-branches are already covered; only
the missing-`id_token` path is genuinely new.
