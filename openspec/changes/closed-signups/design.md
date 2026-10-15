# Design: closed-signups

## Context

The OAuth callback (`server/src/routers/auth.ts`) verifies Google's ID token, requires a verified
email, exchanges the token with Supabase Auth (whose user id becomes the account id), then looks
the Google subject up in `catalog.users`. With no account, the new-user branch creates one in a
catalog transaction and materializes pending team invites for the email. With an account, a
disabled one is refused (`account_disabled`); an enabled one has its profile refreshed. After
either branch the bootstrap owner claims ownerless teams, then the session cookie is issued.

Catalog transactions are `SERIALIZABLE` and re-run their body on `40001`/`40P01`
(`packages/storage/src/postgresCatalogStore.ts`); a body may run more than once, so it must not
log (`packages/catalog/src/catalog.ts:123`).

Allowlists by email already exist (`RUN_FEATURE_EMAILS`, `CLAUDE_CLI_EMAILS`), compared under the
bootstrap owner's exact-ASCII rule (`bootstrapEmailMatch`, owner-bootstrap D16). They live in the
KV secret and need a restart to change.

## Owner decisions after the panel (owner, 2026-10-15)

4. **Check before Supabase Auth.** While sign-ups are closed, a read-only check runs before the
   exchange, so a refused person never reaches Supabase Auth and leaves no record there (panel
   M3). This amends one sentence of "OAuth callback failure redirect".
5. **Approvals expire after 7 days** (panel M4).

## Goals / Non-Goals

Goals: while sign-ups are closed, only an existing account, the bootstrap owner, or an email a
developer approved in the last 7 days can sign in; a refused sign-in writes nothing anywhere; a
developer approves without a restart and without a secret write; open sign-ups are unchanged.

Non-goals: an approvals UI or HTTP route; invites as approval; any change on prod before the
release into `main`.

## Decisions

### D1. `SIGNUPS`: optional, default by stack, a typo refused twice

`SIGNUPS` joins `docker/secrets-env.yaml` (a null passthrough, like `RUN_FEATURE_EMAILS`). The
`Config` type (`packages/ports/src/config.ts`) gains optional `SIGNUPS` and `AUTOLOGGER_STACK`, so
the many test `Config` literals need no edit; `server/src/node/config.ts` fills both from
`procEnv`. `signupsMode(config)` in `server/src/env.ts`:

| `SIGNUPS` (trimmed, `A`-`Z` folded) | Result |
| --- | --- |
| `open` | open |
| `closed` | closed |
| empty | open if `AUTOLOGGER_STACK` is `dev`, else closed |
| anything else | invalid |

- An empty value with no stack (unit and integration test configs) is closed: fail closed. Tests
  that create accounts through the callback set `SIGNUPS: 'open'` (including
  `nulText.int.test.ts`).
- **Two refusals for an invalid value**, never printing it (panel M1):
  `docker/scripts/compose-run.mjs` gets `checkSignupsSetting`, called beside `checkSignInClient`,
  so `make <env>-up` refuses before compose starts and a working `api` is never replaced by a
  crash-looping one; `server/src/bootGuard.ts` refuses too, for any other start path.
- Boot logs `sign-ups: open` or `sign-ups: closed` once.

Why not a list in KV (like `RUN_FEATURE_EMAILS`)? Changing it needs a secret write and a restart,
and on prod only a human writes secrets. A table lets a developer approve with one command.

### D2. `catalog.account_approvals`: written only by `postgres`

```sql
create table catalog.account_approvals (
  email_norm      text collate "C" primary key
                  check (email_norm ~ '^[!-~]+@[!-~]+$' and email_norm = lower(email_norm)),
  approved_at_utc text collate "C" not null,   -- YYYY-MM-DDTHH:MM:SS.sssZ, as Date.toISOString()
  note            text collate "C" check (note is null or char_length(note) <= 200)
);
```

- RLS on; `account_approvals_system_all` for `catalog_system`; `catalog_user`'s privileges
  revoked. **`catalog_system` keeps only `select` and `delete`**: the catalog's default
  privileges grant it `arwd`, and the migration revokes `insert, update, truncate` (panel M2). The
  app can read and consume approvals but never create or extend one.
- `catalog.approve_account(email text, note text default null) returns text`: trims ASCII
  spaces, refuses (`22023`) anything with a character outside `!`..`~` or not of the
  `local@domain` shape, lowercases (`A`-`Z` only; under `collate "C"` `lower` folds only ASCII),
  then upserts with `approved_at_utc = to_char(now() at time zone 'utc',
  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` and the note (blank → null), and returns the normalized
  email. Re-approving restarts the 7 days.
- `catalog.revoke_account_approval(email text) returns boolean`: same normalization, deletes,
  returns whether a row went.
- Both are `security invoker`, `set search_path = catalog, pg_temp`, `execute` revoked from
  `public`; `postgres` (superuser, the operator over `psql`) runs them. No app role can.
- The normalization equals `asciiEmailNorm` in `server/src/env.ts` for every ASCII input (trim,
  fold `A`-`Z`). A non-ASCII token email is refused before any approval is read (D3).

### D3. The callback: a read-only check before the exchange, the consume in the account's transaction

Order of the callback while sign-ups are closed (open: steps 1 and 4's consume are skipped, the
rest is today's code):

1. **Pre-check**, after the verified-email check and before the exchange, as the system task
   `oauth-callback`, reads only:
   - bootstrap owner's email (`bootstrapEmailMatch === true`) → pass;
   - `authGetUserByGoogleSubAny(sub)` finds an account (any state) → pass (today's path decides
     disabled or not);
   - the token email has a character above U+007F → refuse, no further read;
   - `authHasUsableAccountApproval(norm, cutoff)` (`select 1 … where email_norm = $1 and
     approved_at_utc >= $cutoff`, `cutoff = Clock.now() − 7 days` as an ISO string) → pass, else
     refuse.
   Refuse = `302 /?login_error=signup_closed`, no cookie, no Supabase Auth call, nothing written.
2. **Exchange** with Supabase Auth, unchanged.
3. **Lookup** by subject, unchanged.
4. **New-user transaction**, closed and not the bootstrap owner:
   1. `authCreateUserGoogle(...)`; `null` (a concurrent first sign-in made it) → return `null`
      as today, **nothing consumed**;
   2. `authConsumeAccountApproval(norm, cutoff)` (`DELETE … WHERE email_norm = $1 AND
      approved_at_utc >= $2 RETURNING`); no row → throw the `SignupRefused` sentinel, which
      rolls the user insert back;
   3. invites, unchanged.
   The callback catches `SignupRefused` outside the transaction, looks the subject up once more,
   continues as an existing account if one exists, else redirects `signup_closed`. The refusal is
   logged once there, outside the body (subject sanitized, no email).

**Concurrent first sign-ins of one approved subject.** Both pass the pre-check and the exchange
(same Supabase Auth user). Under `SERIALIZABLE`, the second transaction's user insert or approval
delete conflicts with the first: it gets a unique violation (`authCreateUserGoogle` → `null`, the
existing path) or `40001` (the adapter re-runs the body, whose insert then returns `null`). Either
way one user exists, the approval is consumed once, and both callbacks sign in.

**Revoke or expiry between steps 1 and 4.** The consume finds no row, the insert rolls back, the
re-lookup finds nothing, and the person gets `signup_closed`. Only this narrow race leaves a
Supabase Auth record (the exchange already ran); it is the same record a disabled account's
sign-in leaves.

### D4. The bootstrap owner always passes

With sign-ups closed and no approvals, a new prod or stage database could otherwise never get its
first account. The bootstrap owner's email passes step 1 and skips step 4.2, matched under the
same exact-ASCII rule as the claim.

### D5. `signup_closed`: a new code, its own message

`signup_closed` joins the code set under its additive-open rule and gets a row in the failure
table (after `email_unverified`). The login page shows: "This Google account doesn't have access
yet. Ask the person who gave you the link to set it up." It names no setting.

A refusal tells the visitor only about their own Google account, so it reveals neither which
emails are approved nor which accounts exist.

### D6. Invites

A pending team invite does not approve an email (team-management delta). Approved emails
materialize their invites on the first sign-in, as today. Nothing warns an admin who invites an
unapproved email; that is a later change if it bites.

### D7. Operator commands

The operator runs `psql` as `postgres` in the stack's `db` container, feeding the statement on
stdin so `psql` variables quote the values (`-c` does not interpolate them), always passing
`note` (an unset variable is a syntax error) and `ON_ERROR_STOP` (else a refused email still
exits 0):

```sh
echo "select catalog.approve_account(:'email', :'note');" \
  | docker exec -i autologger-dev-db-1 psql -X -U postgres -At -v ON_ERROR_STOP=1 \
      -v email=someone@example.com -v note='for X'
```

The README documents approve, revoke and list for dev (`autologger-dev-db-1`), stage
(`autologger-stage-db-1`) and prod (`autologger-db-1`), and tells the operator to approve shortly
before sending the link: an approval for a non-Gmail address can be used by any Google account
that verified that address. No Makefile target is added.

## Assumptions (each with the command that tests it)

- A1. Only the callback creates accounts: `grep -rn "authCreateUserGoogle\|INSERT INTO users"
  server/src packages/*/src scripts docker/scripts | grep -v test` → `auth.ts:223`,
  `authStore.ts:149` only (panel).
- A2. `lower()` under `collate "C"` folds only `A`-`Z`: `select lower('ÀK' collate "C")` → `Àk`.
- A3. The catalog's default privileges grant `catalog_system` `arwd` on new tables and no function
  `execute`: `pg_default_acl` → `{catalog_user=arwd,catalog_system=arwd}` (panel).
- A4. GoTrue is reachable only from the app's networks, so nobody reaches it without the
  callback: `docker/supabase-services.yaml` `auth` has no `ports` (panel).
- A5. `Date.toISOString()` and the `to_char` format above produce the same shape, so the text
  comparison orders correctly: `select to_char(now() at time zone 'utc',
  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` vs `node -p 'new Date().toISOString()'`.

## Risks / Trade-offs

- **New testers wait for the deploy.** The approvals table exists only once the deploy's migrate
  step has run, and the same deploy closes stage (prod when it is released). New people sign in
  after an approval made right after that deploy; existing accounts are unaffected.
- **Fail closed in tests.** A test config without `SIGNUPS` and stack is closed; account-creating
  tests set `SIGNUPS: 'open'`. A missed one fails loudly (`signup_closed`).
- **A non-Gmail approval can be used by another Google account** that verified the same address.
  Bounded by the 7-day expiry and the README's "approve shortly before" advice.
- **Rollback.** (1) Remove `SIGNUPS` from every `kv/autologger*/…` secret that holds it (a human
  step): reverted code's compose wrapper refuses a KV secret with an unknown key. (2) Revert the
  code. (3) `drop function catalog.approve_account(text, text); drop function
  catalog.revoke_account_approval(text); drop table catalog.account_approvals;`. Approvals are
  lost; accounts are untouched.
