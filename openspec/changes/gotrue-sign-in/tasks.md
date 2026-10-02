# Tasks

The first commit on `supabase-5a-gotrue-sign-in` holds only `openspec/changes/gotrue-sign-in/`.
The PR targets `supabase-migration`, and the gates run with
`GITHUB_BASE_REF=supabase-migration`. Every `make stage-up` needs the owner's permission. The live
Google sign-in (6.2) is done by the owner in a browser.

Logs: keep every test and gate run under the session scratchpad as `5a-<task>-<red|green>.log`,
and name the log in each `Evidence:` line. Each "test first" item is red before its change (record
the failure line) and green after.

## 1. Probe (design A9, A10, A12) before any code

- [x] 1.1 On dev, apply the D3 GoTrue env and the D6 networks as an uncommitted override and run
  `make dev-up`. Check:
  - auth is `healthy` with Google enabled, an empty client id and no secret (A10);
  - from `auth`, Google's OIDC config is fetched over `auth-egress` (A9's network half);
  - from the app, `auth:9999/health` answers over `auth-app`;
  - from `auth`, a request to the app's gate port is refused (A12).
  Revert the override.
  Evidence: `5a-1.1-probe.log` (dev, override applied via `compose-run.mjs dev resolved 'compose
  up -d'`, since `check-envs.sh` refuses it until task 2: `5a-1.1-checkenvs-override.log`):
  auth `healthy`, `GOOGLE_ENABLED=true CLIENT_ID_len=0 SIGNUP_DISABLED=false`, networks
  `auth-app auth-egress db supabase`; `/settings` -> `"google":true`, `"disable_signup":false`,
  `"mailer_autoconfirm":false`, `"email":false`; from auth, Google's OIDC config ->
  `"issuer": "https://accounts.google.com"`; from app, `auth:9999/health` -> `200 {"version":
  "v2.196.0"`; grant with a bogus token -> `400 ... "Bad ID token"`; auth -> gate `app:8787` ->
  connection aborted, no response (same as db's catalog peer: curl `000 exit=52`; dev peer
  companion -> `status 200`). Override reverted (`git checkout`), `make dev-up` -> exit 0 (auth back
  on `db supabase`), probe networks removed.

## 2. Networks and static checks (design D6, D7)

- [ ] 2.1 Test first: add `test_check_envs.sh` guard cases, each red before the rule exists:
  - `rest` joins `auth-egress`;
  - the app joins `auth-egress`;
  - `rest` joins `auth-app`;
  - dev `companion` joins `auth-app`;
  - `auth-app` is not internal;
  - `auth-egress` is off its pinned subnet;
  - auth leaves `auth-app`;
  - prod `api` joins `supabase`;
  - the gate's deny list lacks the `auth-app` subnet.
  Then make the changes:
  - add the networks to `compose.yaml`, `docker/compose.stage.yaml` and `docker/compose.dev.yaml`,
    with auth's networks in `docker/supabase-services.yaml` and the app joined to `auth-app`;
  - make `GATE_DENY_SUBNET` the two-subnet list, and update the `dev-gate.Caddyfile` comment;
  - in `check-envs.sh`, update invariant 3 (the dev app network set) and add the invariant 16
    rules (auth, `auth-egress`, `auth-app`, the `api` network set, subnets, the gate list).
  Green: `check-envs.sh all` passes, and `test_check_envs.sh` passes every case.

## 3. GoTrue configuration (design D3)

- [ ] 3.1 Test first: a `compose-run.mjs` unit test shows that `checkResolved` (or the env check)
  refuses stage and prod when `GOOGLE_CLIENT_ID` is empty and accepts dev. Then:
  - set GoTrue's Google and sign-up env (auto-confirm stays unset);
  - add the stage/prod requirement to `compose-run.mjs`;
  - update `docker/supabase/test_gateway.sh`'s settings case: sign-up enabled, `google` enabled,
    email off. It runs against dev in 6.2.

## 4. Server bridge (design D1-D4, D9)

- [ ] 4.1 Test first: `server/src/auth/gotrue.test.ts` against an injected fake `fetch`. Each case
  is red, then implement `server/src/auth/gotrue.ts`:
  - a 200 with one matching Google identity returns `{id}`;
  - zero, two, or a non-matching Google identity → `identity mismatch`;
  - a 400, 429 or 500 → `status <n>`, with no body text in the message;
  - a timeout → `timeout`;
  - a network error → `network`;
  - a missing, empty or NUL `user.id` → `malformed`.
- [ ] 4.2 Test first, in `routers/auth.int.test.ts`. First fix `server/src/test/oauth.ts` so its
  fetch stub keys on origin and path, and add `mockGoTrue`. Then:
  - a new user's catalog id is the GoTrue id;
  - `email_verified` false or absent → `email_unverified`, GoTrue is never called, and no user is
    created;
  - GoTrue down, 4xx or timeout → `identity_unavailable`, no cookie, no user row;
  - an existing row with a different id → `identity_unavailable`, and the row is unchanged;
  - GoTrue's id owned by another subject's row → `identity_unavailable`;
  - a disabled user is still `account_disabled`, and no catalog row changes;
  - every existing callback and NUL case stays green, with GoTrue mocked.
  Then change the callback and `authCreateUserGoogle({id, …})` with a target-less
  `ON CONFLICT DO NOTHING`. Test helpers (`seedUser`) pass an id.
- [ ] 4.3 Test first: a `server/src/test/pg/` race test. Two `authCreateUserGoogle` calls with the
  same id and subject run in overlapping transactions, held by a barrier. One returns the id, the
  other returns `null`, and there is no 23505. It is red against the targeted
  `ON CONFLICT (google_sub)`.

## 5. Drop pre-GoTrue users (design D8)

- [ ] 5.1 Test first: a `server/src/test/pg/` test seeds a clone with a user, a membership, prefs, an
  invite, a `session:` KV row, a `csrf:` KV row, a studio and a show, then applies the new
  migration's SQL:
  - the first five are gone;
  - the `csrf:` row, the studio and the show remain;
  - a second application deletes nothing more.
  Then add `supabase/migrations/<ts>_drop_pre_gotrue_users.sql` (no BEGIN/COMMIT) and run
  `docker/supabase/test_migrate.sh`.

## 6. Docs, live checks, gates

- [ ] 6.1 Update the docs:
  - `docs/supabase.md`: the networks table, Google on GoTrue, auth egress and its reach;
  - `docs/infisical-secrets.md`: `GOOGLE_CLIENT_ID` is also read by GoTrue and required on stage
    and prod;
  - README: the sign-in flow, `email_unverified` and `identity_unavailable` in the `login_error`
    list.
  - ADR 0021:
    - the slice 5 split and owner decisions (5a/5b/5c; server bridge; bootstrap by email;
      Companion unchanged; verified emails only; no GoTrue token revocation);
    - the reversal of "supabase-js on the server is for Auth admin";
    - the 5a entry;
    - the binding slice 11 note (no user, membership, prefs, invite or login-session import);
    - these revisit items:
      - a foreign key from `catalog.users` to `auth.users`;
      - a GoTrue egress allowlist (internet, LAN and host reach today);
      - a sign-up allowlist and a per-user rate limit on the grant;
      - revoking unused GoTrue sessions (slice 9);
      - GoTrue email linking of two verified Google accounts (slice 9);
      - slice 6 RLS must grant nothing to a bare `authenticated` role;
      - a service on a two-member app network can reach the app's port.
- [ ] 6.2 Live checks:
  - `make dev-up`:
    - auth is `healthy`;
    - `test_gateway.sh dev` passes;
    - the gate refuses the auth subnet.
  - `make stage-up` (with the owner's permission), then once it finishes, the owner signs in with
    Google at `http://localhost:8788`:
    - `auth.users` and `catalog.users` hold one row with the same id;
    - `auth.identities` holds one Google identity with the verified subject (A2's live half, and
      Go's TLS trust for A9);
    - `/api/profile` reports `logged_in: true`;
    - logout works;
    - with `auth` stopped, sign-in redirects with `login_error=identity_unavailable`;
    - `test_gateway.sh stage` passes.
    If the real token is refused for lack of a GoTrue secret, stop and ask the owner (design D3).
- [ ] 6.3 Gates:
  - `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook` passes;
  - `openspec validate gotrue-sign-in --strict` passes;
  - append the consistency read to `panel.md`.
