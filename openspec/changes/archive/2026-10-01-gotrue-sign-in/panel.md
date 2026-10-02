# Panel: gotrue-sign-in
Tier: 2 · Reviewers: assumption tester, failure and abuse, scope and simplicity · Date: 2026-10-02

One critical finding, owner-decided. Every other finding is resolved in the artifacts.

## Assumption tester

- [x] [critical] `MAILER_AUTOCONFIRM=true` makes GoTrue's account linking treat every email as verified (`models/linking.go`: `if email.Verified || config.Mailer.Autoconfirm`), so a second Google subject with the same email is linked to the first user and the grant returns that user's id; D4 had no case for the resulting catalog collision (an unhandled 23505 → 500). Resolved: owner decision 2026-10-02 ("verified only + checks"): auto-confirm stays off; the callback refuses `email_verified !== true` before calling GoTrue (new code `email_unverified`); the exchange requires exactly one Google identity whose `provider_id` is the verified subject; D4 refuses a GoTrue id owned by another subject's row. Design D2-D4, D9; spec delta and tasks 4.1-4.2.
- [x] [major] A11's probe checked `refresh_tokens.revoked`, but GoTrue's `/logout` deletes the rows. Resolved: owner cut D5's revocation, so A11 is gone; revoking unused sessions is on the revisit list (slice 9).
- [x] [major] Concurrent first sign-ins now insert the same id, and `ON CONFLICT (google_sub)` doesn't arbitrate the primary key, giving a 23505 → 500 that breaks "Concurrent first sign-in succeeds"; the existing test serializes the two requests. Resolved: target-less `ON CONFLICT DO NOTHING`, then a re-read by subject and D4's table; task 4.3 adds a real overlapping-transaction pg test, red against the targeted clause.
- [x] [minor] GoTrue's `/logout` defaults to global scope. Resolved: D5 cut (owner).
- [x] [minor] The test fetch stub matches on path only, so Google's and GoTrue's `POST /token` are told apart only by queue order; every callback test needs a GoTrue mock. Resolved: task 4.2 fixes the stub to match origin+path and mocks GoTrue in the existing cases (D2).
- [x] [minor] "GoTrue's health check gates the stack" was false: `api`/`app` have no `depends_on`. Resolved: the risk text now states the 5 s timeout behaviour instead.
- [x] [minor] BusyBox `wget` doesn't verify TLS, so A9's probe proves only the network path. Resolved: A9 says so, and the stage sign-in (6.2) proves Go's TLS trust.
- [x] [minor] An unsigned JWT fails before the audience check, so the old A6 probe proved nothing about the empty client id. Resolved: A6 now cites the source (`if clientID == "" { continue }` → "Unacceptable audience"); the probe checks only that dev boots `healthy`.
- [x] [minor] `dashboards.created_by` keeps deleted user ids. Resolved: noted in D8 (audit-only).

## Failure and abuse

- [x] [major] GoTrue can attach a second Google identity to another user by email, and D4 checked only one direction of the mismatch. Resolved: same fix as the critical above (identity check plus the reverse D4 case); the residual GoTrue-internal merge of two *verified* Google accounts is on the revisit list for slice 9.
- [x] [major] The drop migration is a no-op on prod (its schema is created at cutover); if slice 11 imported users, every prod user would be refused. Resolved: D8 carries a binding slice 11 note (no user, membership, prefs, invite or `session:` import; parity expects them empty), recorded in ADR 0021 by task 6.1.
- [x] [major] Dev's Google config contradicted itself (proposal: enabled only with an id; design: always), the unsigned-token probe couldn't show a wrong audience is refused, and an empty stage/prod id would fail silently. Resolved: the proposal matches D3 (always enabled, empty id on dev refuses every token, per source A6); `compose-run.mjs` refuses stage/prod without `GOOGLE_CLIENT_ID` (task 3.1). A live foreign-audience probe would need an owner-minted token; the source evidence stands in for it.
- [x] [minor] Concurrent first sign-ins can 500 on the primary key. Resolved: as the assumption tester's race finding (task 4.3).
- [x] [minor] A sign-in during a stage deploy (migrate, then the old api still serving) could create a random-id user that D4 then refuses for good. Resolved: D8 accepts it for 5a (stage holds 0 users; the live check signs in after `stage-up` finishes).
- [x] [minor] GoTrue rate-limits `/token` per IP, and every exchange comes from the app's address. Resolved: 429 is reported as `status 429` (D2); a per-user limit is on the revisit list.
- [x] [minor] `auth-egress` gives GoTrue (holding `JWT_SECRET` and the auth DB password) internet, LAN and host reach; the D3 fallback would add the Google secret. Resolved: the revisit item names that reach; putting the secret in GoTrue is now an explicit owner decision (D3, task 6.2 stops to ask).
- [x] [minor] Revocation edge cases (global scope, a timeout before logout, latency). Resolved: D5 cut (owner).
- [x] [minor] An exchange that succeeds before a failing catalog transaction leaves an orphan `auth.users` row. Resolved: noted in D4 (it heals on the next sign-in).

## Scope and simplicity

- [x] [major] Scoping the public `GOOGLE_CLIENT_ID` as a "Supabase secret" contradicted the invariant 16 table header and the "Allowed names" rule. Resolved: dropped; the allowlist key already reaches compose (A13), and there's no scope row or `SECRET_SCOPE`/`SB_SCOPE`/`COMPOSE_KEYS` edit.
- [x] [major] The proposal and design disagreed on dev's Google provider. Resolved: as the failure-and-abuse major above.
- [x] [minor] D5's immediate `/logout` can be cut. Resolved: cut (owner).
- [x] [minor] A new port plus a URL fake is two seams for one call, and the port would stale the core-ports type list. Resolved: one function `exchangeGoogleIdToken` with an injected `fetch` and a constant URL; no port, no `SUPABASE_AUTH_URL`, no core-ports delta (D2).
- [x] [minor] "Disabled-account sign-in redirect" says "change nothing", but GoTrue now records the attempt. Resolved: a MODIFIED block scopes it to the catalog account (D4).
- [x] [minor] The concurrent first sign-in race. Resolved: task 4.3.
- [x] [minor] Tasks and Impact missed invariant 3's dev `app` network set, the Caddyfile's "one CIDR" comment, and an enforcing check for the `api` network scenario. Resolved: all three are in task 2.1, D6 and the static-invariant delta.
- [x] [minor] Parts of the migration are optional (the KV delete; `team_invites` goes beyond the ADR's wording). Resolved: the KV delete stays as one line; the invite delete is justified in D8 (it stops an old invite granting a membership to a re-registered person).
- [x] [minor] ADR 0021 says "supabase-js on the server is for Auth admin", which D1 reverses. Resolved: the reversal is recorded in D1 and by task 6.1.

## Consistency read 2026-10-02
Edits since approval (`6440edb`): tasks.md only (ticks and evidence; blank lines inside items removed for the evidence gate).
Scope change: no
- [x] [minor] Every delta requirement has a task and a test: the api-contract-freeze callback rows (`email_unverified`, `identity_unavailable`, the account id is the Supabase Auth id, both mismatch directions, the disabled account changes no catalog row) → 4.1/4.2/4.3; the gateway settings (Google only, auto-confirm off) → 3.1 `test_gateway.sh`; the static invariant, the stage subnets, the dev gate and the container-deployment topology and `api` network set → 2.1 guard cases plus the 1.1/6.2 live gate checks. Resolved: no gaps.
- [x] [minor] Task 4.3's overlapping same-subject case passes under both the old and the new conflict clause (Postgres's arbiter wait catches it); only the id-held-by-another-account case is red against the old clause. Resolved: recorded in 4.3's evidence; the overlapping case stays as a guard.
- [x] [minor] In 6.2 the owner saw the generic "Sign-in didn't complete" message rather than reading `login_error=identity_unavailable` from the URL. Resolved: the api log shows the `identity_unavailable` branch (`Supabase Auth exchange failed network`), and 4.2's integration tests pin the redirect code; that the account was signed in is the owner's report on a `REQUIRE_LOGIN=1` stack, plus the KV session row.
