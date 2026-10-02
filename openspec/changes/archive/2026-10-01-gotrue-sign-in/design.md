# Design

## Context

The callback in `server/src/routers/auth.ts` (lines 84-247) runs these steps in order:
1. checks the provider error, configuration, parameters and state;
2. `exchangeCode` with Google;
3. `verifyIdToken` (jose, Google JWKS, audience = client id);
4. the NUL rules;
5. resolves the catalog user by Google subject: a new user is created by `authCreateUserGoogle`
   in a transaction, with prefs seeding and verified-email invites; if a concurrent first
   sign-in won, it re-reads;
6. the disabled check;
7. creates the KV login session and sets the `autologger_sid` cookie.

Today an unverified Google email can sign in, but it gets no invite memberships.
`catalog.users.id` is `text collate "C"`, minted with `crypto.randomUUID()`.

GoTrue v2.196.0 runs in every stack (`docker/supabase-services.yaml`):
- sign-up is disabled and no external provider is configured;
- its networks are `db` and `supabase`, both internal, so it has no egress;
- the app can't reach it.

Live data, 2026-10-02: dev and stage hold 0 catalog users, 0 `auth.users`, 0 invites and 0 login
sessions.

GoTrue facts, read from the v2.196.0 source by the panel:
- **id_token grant (`internal/api/token_oidc.go`):**
  - takes `{provider, id_token, nonce?}`;
  - needs no apikey (`api.go:268`; a live POST without one gets 400, not 401);
  - requires the provider to be enabled;
  - accepts the token only if its audience is a configured client id; an empty id is skipped,
    giving "Unacceptable audience";
  - checks a nonce only if the token or the request carries one;
  - returns `{access_token, refresh_token, user}`, and `user` includes `identities`.
- **`ValidateOAuth`** (secret and redirect URI) is called only by the redirect flow
  (`provider/google.go:41`), never at boot.
- **New identities** go through `createAccountFromExternalIdentity`, which refuses when
  `DISABLE_SIGNUP` is set.
- **Account linking** (`models/linking.go`, `DetermineAccountLinking`) links a new identity to an
  existing user with the same email when that email is verified, **or when `MAILER_AUTOCONFIRM` is
  on**.

## Goals / Non-Goals

**Goals:**
- Every signed-in user exists in `auth.users` with exactly one Google identity, whose subject is
  the one the server verified. The catalog user's id is that GoTrue id.
- The browser contract changes only by two additive error codes.
- GoTrue gets only the egress and the reach it needs.

**Non-Goals:** as listed in proposal.md.

## Decisions

**D1. The server bridges Google to GoTrue (owner).**
- The callback keeps steps 1-4. It then refuses an unverified email (D3) and calls
  `exchangeGoogleIdToken` with the same Google ID token it just verified.
- GoTrue verifies the token independently (signature, issuer, audience) and creates or finds its
  user.
- The exchange runs before any catalog read. So a refused or failed exchange never touches the
  catalog, and a GoTrue outage gives `identity_unavailable` with no cookie.
- Alternative: create users through GoTrue's admin API with the service-role key. Rejected,
  because the app would then hold a key that can do anything to any user, and GoTrue wouldn't
  verify Google itself. This reverses ADR 0021's "supabase-js on the server is for Auth admin";
  the ADR entry records the reversal.

**D2. One function, no new port.**
- `server/src/auth/gotrue.ts` exports
  `exchangeGoogleIdToken(idToken, googleSub, fetchImpl = fetch, timeoutMs = 5000)`.
- It posts to `http://auth:9999/token?grant_type=id_token` (a constant) with JSON
  `{provider: 'google', id_token}`.
- It returns `{id}` only when:
  - the response is 2xx JSON;
  - `user.id` is a non-empty string without NUL;
  - `user.identities` holds **exactly one** identity with `provider === 'google'`, and its
    `provider_id` (or `identity_data.sub`) equals `googleSub`.
- Otherwise it throws `IdentityUnavailableError(reason)`. The reason is one of `status <n>`,
  `timeout`, `network`, `malformed` or `identity mismatch`.
  - A 429 is reported as `status 429`, so rate limiting is visible in logs.
  - The response body and the token never appear in the error or a log.
- Tests fake it through the existing global fetch stub (`server/src/test/oauth.ts`). That stub's
  matching is fixed to key on **origin and path**: today it matches the path only, so Google's
  `POST /token` and GoTrue's would be told apart only by queue order.
- Alternative: an `IdentityProvider` port plus a configurable URL. Rejected: that is two seams for
  one call. The core-ports type list stays unchanged.

**D3. The verified-email rule and GoTrue's configuration (owner).**
- **Server rule.** The callback refuses a token whose `email_verified` claim is not `true`, or whose
  email is empty, with the new additive code `login_error=email_unverified`. The check runs after
  the NUL checks and before the exchange.
  - GoTrue therefore only ever sees verified Google emails, and its email-based linking can only
    act on verified addresses.
  - This replaces today's "unverified emails sign in with no invites".
- **GoTrue settings:**
  - `GOTRUE_EXTERNAL_GOOGLE_ENABLED: "true"`;
  - `GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID:-}`. The allowlist key is already in
    compose's environment, because `compose-run.mjs` copies every allowlist key into the child
    env. No new compose key or secret scope is needed: the client id is public, since it travels
    in the browser's Google URL;
  - `GOTRUE_DISABLE_SIGNUP: "false"`, with email, phone and anonymous left `false`;
  - `GOTRUE_MAILER_AUTOCONFIRM` is left unset (false), so GoTrue's linking treats only verified
    emails as verified.
- **Dev** has no Google client. Its GoTrue runs with Google enabled and an empty client id, so the
  grant refuses every token ("Unacceptable audience", per the source above). Dev's server never
  calls it, because OAuth is not configured there.
- **Stage and prod.** `compose-run.mjs` refuses to start when `GOOGLE_CLIENT_ID` is empty. A missing
  value then fails loudly, instead of giving `identity_unavailable` on every sign-in.
- **No client secret in GoTrue.** GoTrue never gets `GOOGLE_CLIENT_SECRET`, because `ValidateOAuth`
  runs only in the redirect flow, which this design doesn't use. If the stage sign-in shows
  otherwise, apply goes back to the owner. Putting the secret in an internet-facing container is
  the owner's call, not a panel note.
- **Who can reach the grant.** Only the app over `auth-app`, and anyone through the loopback gateway
  with the anon key.
  - So any Google user can get an `auth.users` row, just as anyone can get a catalog user today.
  - Slice 6 RLS must grant nothing to a bare `authenticated` role. This goes on the revisit list.

**D4. The catalog id is the GoTrue id, and any mismatch is refused.**
- After the exchange returns `id` (whose single Google identity is the verified subject), the
  router reads the catalog user by Google subject (all rows) and, when needed, by id:

  | Catalog state | Outcome |
  | --- | --- |
  | no row for the subject, no row with `id` | create with `id` |
  | row for the subject with `id` equal | continue (disabled check, profile update) |
  | row for the subject with a different id | refuse `identity_unavailable`, warn with both ids |
  | no row for the subject, but a row with `id` and another subject | refuse `identity_unavailable`, warn |

- `authCreateUserGoogle({id, googleSub, …})` inserts the given id with `ON CONFLICT DO NOTHING` and
  no conflict target.
  - A race on either the primary key or `google_sub` then returns `null`, never a 23505.
  - The router re-reads by subject and applies the table above, which keeps "Concurrent first
    sign-in succeeds".
- **Disabled accounts** stay a catalog fact.
  - A disabled user's sign-in still reaches GoTrue, which records it in `auth.users`.
  - The router then refuses with `account_disabled` and changes no catalog account.
  - The api-contract-freeze delta narrows "change nothing" to the catalog account.
- **Orphans.** If the exchange succeeds and the catalog transaction then throws (500), an
  `auth.users` row is left without a catalog user. The next sign-in gets the same id and creates
  the catalog row, so this heals itself. Accepted.

**D5. GoTrue's tokens are discarded, not revoked (owner).**
- The grant's access and refresh tokens never leave the server process. The server keeps only
  `user.id`.
- No logout call is made: GoTrue's default logout scope is global, and the call would add a
  failure path.
- Revoking unused GoTrue sessions goes on the revisit list with slice 9's browser-token decision.
- Until then, `auth.sessions` and `auth.refresh_tokens` gain one row per sign-in. Only the database
  superuser and the auth role can reach them.

**D6. Networks.**

| Network | Internal | Members | prod | stage | dev |
| --- | --- | --- | --- | --- | --- |
| `auth-egress` | no | `auth` | 172.28.16.0/24 | 172.28.27.0/24 | 172.28.35.0/24 |
| `auth-app` | yes, host-isolated | `auth` + the app (`api`/`app`) | 172.28.17.0/24 | 172.28.28.0/24 | 172.28.36.0/24 |

- `auth` joins `db`, `supabase`, `auth-egress` and `auth-app`. `edge` stays gateway-only.
- Stage skips .26, which `test_check_envs.sh` uses as an off-pin value.
- `check-envs.sh` invariant 16 gains these checks:
  - auth's networks are exactly those four;
  - `auth-egress`'s only member is `auth`;
  - `auth-app`'s members are exactly `auth` and the app;
  - `auth-app` is internal and host-isolated;
  - both new networks are on their pinned subnets;
  - the prod/stage `api` networks are exactly `back`, `catalog` and `auth-app`.
- Invariant 3's dev `app` network set becomes `catalog`, `dev` and `auth-app`.
- `test_check_envs.sh` gets one guard case per rule.

**D7. Who can reach the app over `auth-app`.**
- **Dev.**
  - The app's port is served by `app-gate`, which shares the app's network namespace; only the
    gate listens off loopback, on `:8787`.
  - The gate refuses `GATE_DENY_SUBNET`, which becomes a space-separated list of the `catalog`
    and `auth-app` subnets. Caddy's `remote_ip` accepts the list: `caddy adapt` gives
    `"ranges":["172.28.34.0/24","172.28.36.0/24"]`.
  - `check-envs.sh` checks that the list is exactly those two subnets, and the Caddyfile's
    "one CIDR" comment is updated.
- **Prod and stage.** `api` listens on its own port, and `auth` can reach it over `auth-app`, just
  as `db` can over `catalog` (accepted in 4a). There `REQUIRE_LOGIN` is `1`, so the API still
  requires a login cookie or token. Accepted, and added to the revisit list.

**D8. Existing users are dropped (ADR 0021).**
- Migration `supabase/migrations/<ts>_drop_pre_gotrue_users.sql`. It has no BEGIN/COMMIT, because
  `migrate.sh` wraps each file in one transaction. It deletes:
  - `catalog.team_invites`. An invite from the old identities could otherwise grant a membership to
    a re-registered person, and its `invited_by_user_id` would name a user who no longer exists;
  - `catalog.users`, which cascades to `user_studio_memberships` and `user_prefs`;
  - `catalog.kv` rows where `key like 'session:%'`.
- Existing cookies then resolve to no user, so their holders are signed out. Built-in studios and
  `app_settings` stay (5c handles them).
- Per-session `dashboards.created_by` values keep the deleted ids. They are audit-only, with one
  write at `aiV2.ts:541`. Accepted.
- **Prod.** The prod schema is created at cutover, so this migration runs there on an empty database
  and is recorded as applied.
  - **Binding note for slice 11:** the SQLite import must not import `users`,
    `user_studio_memberships`, `user_prefs`, `team_invites` or `session:` KV rows, or it must
    re-key them through GoTrue. Its parity check expects those tables to be empty.
  - ADR 0021's slice 11 entry records this.
- **Deploy window.** `make stage-up` migrates before the new `api` replaces the old one, so a
  sign-in during that window would create a random-id user that D4 then refuses. Stage holds 0
  users, and the live check signs in only after `stage-up` finishes. Accepted for 5a.

**D9. The two new codes.**
- `email_unverified` is evaluated after `token_invalid`. `identity_unavailable` is evaluated after
  `email_unverified`.
- Both come before `account_disabled`, so a disabled user with an unverified email sees
  `email_unverified`.
- The web needs no change: web-login-experience "Login-error rendering" already shows every code
  other than `state_invalid` and `provider_error`, including unrecognised ones, as the generic
  sign-in-failed message with a retry.

## Assumptions

Known from source, the repo and the running stacks (panel 2026-10-02):

| # | Assumption | Command | Observed |
| --- | --- | --- | --- |
| A1 | The grant takes provider + id_token; issuer is Google; no nonce when the token has none | WebFetch `supabase/auth` v2.196.0 `internal/api/token_oidc.go` | params `IdToken, Nonce, Provider, ClientID, Issuer`; `IssuerGoogle = "https://accounts.google.com"` (go-oidc also accepts the scheme-less form); "Passed nonce and id_token should either both exist or not" |
| A2 | Google enabled with no secret or redirect URI still serves the grant | source: `ValidateOAuth` is called only from `provider/google.go:41` (redirect flow); `GlobalConfiguration.Validate` doesn't check External | redirect flow only |
| A3 | `DISABLE_SIGNUP` blocks external sign-up; autoconfirm widens linking | source `external.go`, `models/linking.go` | "Signups not allowed for this instance"; `if email.Verified \|\| config.Mailer.Autoconfirm` |
| A4 | The app's Google URL sends no nonce | `rg -n nonce server/src/auth/oauth_google.ts` | no hits |
| A5 | Dev has no Google client; stage has one | `docker exec … '[ -n "$GOOGLE_CLIENT_ID" ]'` | dev unset; stage set |
| A6 | An empty client id refuses every token | source `token_oidc.go`: `if clientID == "" { continue }` | then "Unacceptable audience" |
| A7 | The chosen subnets are free | `rg -n "172\.28\.(16\|17\|27\|28\|35\|36)\."`; `docker network inspect` | no hits; live networks use .20-.25, .30-.34 |
| A8 | `/token` needs no apikey on `auth:9999` | from dev `auth`: POST `/token?grant_type=id_token` | HTTP 400 (not 401) |
| A13 | `${GOOGLE_CLIENT_ID:-}` resolves in `auth` | `compose-run.mjs`: `for (const [k,v] of secrets) childEnv[k]=v` | allowlist keys are in compose's env |
| A14 | The gate takes several deny ranges | `GATE_DENY_SUBNET="172.28.34.0/24 172.28.36.0/24" caddy adapt` | `"ranges":["172.28.34.0/24","172.28.36.0/24"]` |
| A15 | Deleting users cascades as claimed; nothing else references them | migration FKs; `rg` | memberships and prefs `on delete cascade`; `invited_by_user_id` has no FK; only `dashboards.created_by` (audit) |

Proven by task 1.1's probe on dev, before any code:

| # | Assumption | Probe |
| --- | --- | --- |
| A9 | GoTrue reaches Google over `auth-egress` | from `auth`: a TCP and HTTP fetch of Google's OIDC config. BusyBox `wget` doesn't verify TLS, so Go's TLS trust is proven by the stage sign-in (6.2) |
| A10 | Dev GoTrue boots `healthy` with Google enabled and an empty client id | `make dev-up` with the override; auth `healthy` |
| A12 | The dev gate refuses a peer on the `auth-app` subnet | from `auth`: a request to `app:8787` is refused by the gate |

Proven by the owner's stage sign-in (6.2):
- a real Google token is accepted with no secret (A2, live half);
- the GoTrue user has exactly one Google identity, with the verified subject.

## Risks / Trade-offs

- **Sign-in depends on GoTrue.**
  - The app has no `depends_on` on `auth`, so a GoTrue outage gives `identity_unavailable` after at
    most the 5 s timeout.
  - Existing login sessions keep working, because cookie resolution never calls GoTrue.
- **GoTrue rate-limits `/token` per IP,** and every exchange comes from the app's address.
  - Sign-ins are rare, because the cookie lasts the session TTL, and a 429 is logged as such.
  - A per-user limit goes on the revisit list.
- **Email linking for two verified Google accounts with one address.**
  - It can't reach the catalog: D2's single-identity check and D4 refuse it.
  - But it could still merge the two inside GoTrue, where a gateway grant for the second account
    would yield the first's GoTrue session.
  - It goes on the revisit list for slice 9, together with GoTrue's manual-linking setting.
- **Open sign-up.** See D3. A sign-up allowlist or rate limit goes on the revisit list.
- **Unrestricted egress for GoTrue.**
  - `auth-egress` reaches the internet, the LAN, and host services on the bridge gateway.
  - GoTrue holds `JWT_SECRET` and the auth DB password, and before this change it had no way out.
  - A host firewall or an egress proxy limited to Google goes on the revisit list.
- **Mismatch refusals (D4) need a manual fix.** They occur only after manual GoTrue edits.
- **Unverified Google emails can no longer sign in (D3, owner).** Google personal accounts are
  verified, so this is expected to be rare.
- **Size.** The panel estimates 280-340 counted lines.
