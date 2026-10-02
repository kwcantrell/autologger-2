# Sign-in through Supabase Auth: the server bridges Google to GoTrue

Tier: 2
Tier reason: authentication and user identity, network topology and secret scopes for the Supabase stack, a migration that deletes all users, and an additive change to the frozen OAuth callback contract.

Approved-by: Kalen 2026-10-01

## Why

ADR 0021 slice 5 moves identity to Supabase Auth (GoTrue), so that later slices can rely on it:
- slice 6's row level security (`auth.uid()`);
- slice 9's Realtime.

Today the app runs its own Google OAuth flow and keeps its own users. GoTrue runs in every stack
but:
- has no sign-in provider;
- has no internet access;
- can't be reached by the app, or by the browser from the app's origin.

The owner split slice 5 into three parts:
- 5a (this change): Supabase Auth becomes the identity of record;
- 5b: login becomes required;
- 5c: the owner role, the bootstrap owner, and dropping the built-in studios.

## What Changes

- **Server bridge (owner).** The browser flow is unchanged:
  - `/auth/google/start`;
  - `/auth/google/callback`;
  - `/auth/logout`;
  - the `autologger_sid` cookie;
  - the Google redirect URI.

  After the server verifies Google's ID token, it exchanges that token with GoTrue
  (`POST /token?grant_type=id_token`, provider `google`). GoTrue verifies it a second time and
  returns its user. The GoTrue user id becomes the catalog user's id. The server discards GoTrue's
  tokens, with no revocation call (owner).
- **Only verified Google emails sign in (owner).** An ID token without `email_verified: true` is
  refused before GoTrue is called, with the new additive code `login_error=email_unverified`.
  Today such an account signs in with no invites. GoTrue's auto-confirm stays off, so its
  email-based account linking only ever acts on verified addresses.
- **New callback failure code.** If GoTrue is unreachable or refuses the token, the callback
  redirects with `login_error=identity_unavailable`, sets no cookie, and creates no user. The code
  set is additive-open, and the web already shows any unrecognised code as the generic
  sign-in-failed message, so the web doesn't change.
- **Every identity mismatch is refused with `identity_unavailable` and a warning.** The cases are:
  - GoTrue's user doesn't hold exactly one Google identity with the verified subject (for example,
    GoTrue linked two Google accounts by email);
  - a catalog user's Google subject maps to a different GoTrue id;
  - GoTrue's id already belongs to a catalog user with another subject.

  The catalog is never re-keyed silently.
- **GoTrue configuration.**
  - The Google provider is enabled, with the app's `GOOGLE_CLIENT_ID` as the accepted audience.
  - Sign-up is open, but email, phone and anonymous sign-in stay disabled, so only a Google
    identity can create a user. Auto-confirm is off.
  - `GOOGLE_CLIENT_ID` is public, and it already reaches compose through the allowlist; it gets no
    new secret scope. Stage and prod refuse to start without it.
  - `GOOGLE_CLIENT_SECRET` stays app-only (design D3). If GoTrue turns out to need it, apply stops
    for the owner's decision.
- **Networks, in every stack, on pinned subnets.**
  - `auth-egress`: not internal, and only `auth` joins it, so GoTrue can fetch Google's keys.
    `edge` stays gateway-only.
  - `auth-app`: internal, with exactly two members, `auth` and the app. The app reaches
    `http://auth:9999` directly and holds no Supabase key.
  - The dev gate refuses the `auth-app` subnet, as it refuses `catalog`.
  - `check-envs.sh` enforces all of this, with guard cases in `test_check_envs.sh`.
- **Existing users are dropped (ADR 0021).** A migration deletes every catalog user (which
  cascades to memberships and prefs), every pending invite, and every login session in KV. Dev
  and stage started empty in 4c, so only test sign-ins are lost.
- **Docs:**
  - `docs/supabase.md` (networks, Google on GoTrue);
  - `docs/infisical-secrets.md` (`GOOGLE_CLIENT_ID` now also read by GoTrue; required on stage and prod);
  - README (sign-in flow, the new error code);
  - ADR 0021 (the slice 5 split and decisions, and revisit items).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `api-contract-freeze`:
  - "OAuth callback failure redirect" adds `email_unverified` and `identity_unavailable`, and the
    success path names the Supabase Auth exchange;
  - "Disabled-account sign-in redirect" narrows "change nothing" to the catalog account.
- `local-container-environments`:
  - "Supabase gateway routes and key checks" (sign-up open for Google only, Google enabled);
  - "Static invariant check" (the two new networks and the `api` network set);
  - "Stage coexists with prod; dev is disjoint by construction" (the new pinned subnets);
  - "Dev app binds loopback behind a Host/Origin gate" (the gate also refuses `auth-app`).
- `container-deployment`: "Compose topology is loopback-published, segmented, and operable"
  (`auth` joins `auth-egress` and `auth-app`; `api` reaches `auth` and no other Supabase service).

## Non-goals

- **5b:** requiring login, or removing `REQUIRE_LOGIN=0`, the anonymous branches or
  `oauth_configured`.
- **5c:** the `owner` role, `BOOTSTRAP_OWNER_EMAIL`, or removing the built-in studios.
- **The browser holding Supabase tokens, supabase-js, CORS, or public GoTrue routes.** Under the
  server bridge (owner), none of these is needed.
- **RLS, and per-request `set local role` claims.** These are slice 6.
- **Companion credentials.** `API_TOKEN` is unchanged (owner); the device credential is slice 9.
- **Restricting GoTrue's egress to Google hosts only.** This goes on the revisit list.
- **A foreign key from `catalog.users` to `auth.users`.** This goes on the revisit list.

## Impact

- **Server:**
  - `routers/auth.ts` (callback);
  - `server/src/auth/gotrue.ts` (one function, no new port).
- **Packages:** `catalog`: `authCreateUserGoogle` takes the id and uses a target-less
  `ON CONFLICT DO NOTHING`.
- **Compose and tooling:**
  - `compose.yaml`, `docker/compose.dev.yaml`, `docker/compose.stage.yaml`;
  - `docker/supabase-services.yaml`;
  - `docker/scripts/compose-run.mjs` (stage/prod require `GOOGLE_CLIENT_ID`), `check-envs.sh`
    (invariants 3 and 16), `test_check_envs.sh`;
  - `docker/dev-gate.Caddyfile` (the comment on the deny list);
  - `docker/supabase/test_gateway.sh` (the sign-up setting case).
- **Data:** a new migration in `supabase/migrations/` deletes users, invites and login sessions.
- **Owner steps:**
  - the live check is a real Google sign-in on stage (`http://localhost:8788`), which already has
    its Google client, run by the owner in a browser;
  - dev has no Google client today, so dev's GoTrue runs with Google enabled and an empty client
    id, and the grant refuses every token (design D3).
- **Size:** the panel estimates 280-340 counted lines.
- **Slice 11 (binding note in ADR 0021):** the SQLite import must not import users, memberships,
  prefs, invites or login sessions.
