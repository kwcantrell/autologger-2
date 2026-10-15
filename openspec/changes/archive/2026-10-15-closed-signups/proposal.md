# Close sign-ups: new accounts only for emails a developer approved

Tier: 2
Tier reason: sign-in (a new refusal in the OAuth callback's new-user branch), a catalog migration
(a new system-only table and two operator functions), a new KV setting read at boot, and an
addition to the frozen HTTP contract (a new `login_error` code); touches
`server/src/routers/**` and `supabase/migrations/**`.

Approved-by: Kalen 2026-10-15

## Why

Today any Google account with a verified email that completes sign-in gets an account: the
OAuth callback's new-user branch creates it on the first sign-in
(`server/src/routers/auth.ts`, "Design D2: the whole new-user branch"). Prod (`nrvo.ai`) is
public, so anyone can create an account there. The owner wants that closed for now: a developer
creates an account for a person by hand, and nobody else can make one.

## Owner decisions (owner, 2026-10-15)

1. **Pre-approve an email.** A developer runs an operator command that approves an email. That
   person's first Google sign-in then creates their account as today; any other new email is
   refused. No account row is made ahead of time, because an account's id is the Supabase Auth
   user id, which exists only after a sign-in (api-contract-freeze "OAuth callback failure
   redirect").
2. **A setting, closed on stage and prod.** `SIGNUPS` is `open` or `closed`. Unset, it is `open`
   on dev and `closed` on stage and prod. Existing accounts and the bootstrap owner's email can
   always sign in.
3. **On `supabase-migration`.** Prod gets it with the next release into `main`; prod stays open
   until then.
4. **Check before Supabase Auth** (after the panel). While closed, a read-only check runs before
   the Supabase Auth exchange, so a refused person leaves no record anywhere.
5. **Approvals expire after 7 days** (after the panel).

## What changes

- **Setting.** A new optional KV key `SIGNUPS` (`open` | `closed`) in the container allowlist
  (`docker/secrets-env.yaml`). Unset or blank: `open` on dev, `closed` on stage and prod. Any
  other value is refused by the compose wrapper before compose starts, and by the server at boot.
  Boot logs the effective mode once.
- **Approvals table.** Migration `20261024000000_account_approvals.sql` creates
  `catalog.account_approvals` (an ASCII-normalized email, when, an optional note), system-only
  like `kv` and writable only by `postgres` (the app may read and delete), plus two functions
  only `postgres` may run: `catalog.approve_account(email, note)` and
  `catalog.revoke_account_approval(email)`. An approval is usable for 7 days.
- **Callback.** While sign-ups are closed, a read-only check before the Supabase Auth exchange
  refuses a Google subject with no account whose email is neither the bootstrap owner's nor
  approved: `302 /?login_error=signup_closed`, no cookie, nothing written anywhere. An approved
  email gets its account, and its approval is consumed in the same transaction. Existing accounts
  (enabled or disabled) are unaffected; open sign-ups behave exactly as today.
- **Login page.** `signup_closed` gets its own message, which names no configuration.
- **Docs.** README: the setting and the operator commands (approve, revoke, list) for each stack.

## Capabilities

- `api-contract-freeze`: ADDED "Closed sign-up redirect" (the `signup_closed` code, who may
  still create an account, the 7-day expiry, the `SIGNUPS` setting and its refusals); MODIFIED
  "OAuth callback failure redirect" (a table row, and the closed check runs before the exchange)
  and "Concurrent first sign-in succeeds" (only for subjects allowed to create an account).
- `catalog-database`: ADDED "Account approvals are stored in the catalog"; MODIFIED "Row-level
  security is enabled on every catalog table" (the new table joins the system-only list).
- `web-login-experience`: MODIFIED "Login-error rendering" (a fourth message group).
- `team-management`: MODIFIED "Email invites" (an invite does not open closed sign-ups).

## Out of scope

- Team invites do not approve an email (owner decision 1 chose pre-approval only). An admin can
  still invite any email; the invite waits until a developer approves that email, then
  materializes on the first sign-in as today.
- No HTTP route or UI for approvals: the operator commands run as `postgres` through `psql`.
- Prod: nothing changes there until `supabase-migration` is released into `main`.

## Impact

- `server/src/routers/auth.ts`, `server/src/env.ts`, `server/src/node/config.ts`,
  `server/src/bootGuard.ts`, `packages/ports/src/config.ts`, `packages/catalog/src/authStore.ts`,
  `docker/scripts/compose-run.mjs`.
- `supabase/migrations/20261024000000_account_approvals.sql` and the recorded schema
  expectation.
- `docker/secrets-env.yaml`; `web/src/pages/index/components/LoginPage.tsx`; README.

## After merge

- Dev stays open unless `SIGNUPS=closed` is set in `kv/autologger/dev`.
- Stage closes on the deploy that also creates the approvals table. Right after that deploy,
  approve any stage tester who has no account yet.
- Prod closes when it gets this release; approve new people right after it. Every existing prod
  account keeps working.
- Rollback: first remove `SIGNUPS` from every KV secret that holds it (design Risks).
