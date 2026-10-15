# Tasks

The first commit on `closed-signups` holds only `openspec/changes/closed-signups/`. The PR
targets `supabase-migration`, and the gates run with `GITHUB_BASE_REF=supabase-migration`.

Logs: keep every test and gate run under the session scratchpad as `cs-<task>-<red|green>.log`,
and name the log in each `Evidence:` line. Each "test first" item is red before its change (record
the failure line) and green after; if a new test already passes, record that.

Test commands: server tiers are `cd server && npx vitest run --project <unit|integration|pg>
<files>`; web is `cd web && npx vitest run <files>`; compose-run is
`node --test docker/scripts/compose-run.test.mjs`; static checks are `make check`.

## 1. Migration: the approvals table and the operator functions (design D2)

- [ ] 1.1 Test first, new `server/src/test/pg/accountApprovals.pg.test.ts`, plus the recorded
  expectation in `catalogSchema.pg.test.ts` and the system-only list in the RLS listing test
  (`catalogPolicies.pg.test.ts` or wherever it lives):
  - approve `'  Someone@Example.COM '` returns `someone@example.com`, writes the row, and
    `approved_at_utc` matches `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$`; approving again with
    another note keeps one row with the new note and a later `approved_at_utc`; a blank note is
    stored as null;
  - `no-at-sign`, `a b@example.com`, `ké@example.com` and `''` each fail `22023`, writing nothing;
  - revoke returns `true` then `false`;
  - a direct insert (as `postgres`) of `Upper@example.com` or `x y@example.com` fails `23514`;
  - `catalog_user` select / insert / delete fail `42501`; `catalog_system` insert and update fail
    `42501`, select and delete work; `autologger_app` under `catalog_user` and under
    `catalog_system` executing `catalog.approve_account` fails `42501`;
  - the RLS listing names `account_approvals` as system-only (no `catalog_user` policy).
- [ ] 1.2 `supabase/migrations/20261024000000_account_approvals.sql`: the table, RLS, the
  system policy, the revokes (`catalog_user` all; `catalog_system` insert, update, truncate), the
  two functions with `execute` revoked from `public`, a header comment with the rollback steps
  (KV first, design Risks).

## 2. Setting (design D1)

- [ ] 2.1 Test first:
  - `server/src/env.test.ts`: `signupsMode` for `open`, `closed`, ` Closed `, empty with stack
    `dev` (open), empty with `stage`, `prod` and no stack (closed), `opne` (invalid);
  - `server/src/bootGuard.test.ts`: `SIGNUPS=opne` refuses boot with a message naming `SIGNUPS`
    and not containing `opne`; `open`, `closed` and unset boot;
  - `docker/scripts/compose-run.test.mjs`: a KV secret with `SIGNUPS=opne` is refused before
    compose with a message naming `SIGNUPS` and not containing `opne`; `open`, `closed`, `Closed`,
    blank and absent pass;
  - a boot test that the server logs `sign-ups: closed` for stack `stage` with `SIGNUPS` unset and
    `sign-ups: open` for `dev`.
- [ ] 2.2 `packages/ports/src/config.ts` (optional `SIGNUPS`, `AUTOLOGGER_STACK`),
  `server/src/env.ts` (`signupsMode`), `server/src/node/config.ts` (both keys, the boot log line),
  `server/src/bootGuard.ts`, `docker/scripts/compose-run.mjs` (`checkSignupsSetting` beside
  `checkSignInClient`); `docker/secrets-env.yaml` gains `SIGNUPS:` under "Sign-in and tokens".
  `make check` stays green.

## 3. Callback (design D3, D4, D5)

- [ ] 3.1 Test first, `server/src/routers/auth.int.test.ts` (closed unless a test says open):
  - unapproved new email → `302 /?login_error=signup_closed`, no `Set-Cookie`, the Supabase Auth
    fake was not called, no `users` row, pending invites for that email untouched (this is also
    the team-management scenario "An invite does not open closed sign-ups");
  - approved a day ago (`someone@example.com`, token email `Someone@Example.com`) → signed in,
    account created, invites materialized, approval row gone;
  - approved 8 days ago (fake Clock) → `signup_closed`, Supabase Auth not called, row stays;
  - revoked between the check and the account (hold after the pre-check's approval `SELECT`,
    delete the row, release) → `signup_closed`, no account;
  - bootstrap owner, nothing approved → signed in and the claim ran;
  - an existing enabled account with no approval → signed in; a disabled one →
    `account_disabled`;
  - a non-ASCII token email → `signup_closed`, and no `account_approvals` statement ran
    (`gated.count`);
  - open: a new unapproved email is created as before, and an approval row for an approved email
    stays;
  - concurrent first sign-ins of one approved subject: a NEW test that holds A with
    `holdAfter(/DELETE FROM account_approvals/)` (or after A's user insert), starts B without
    awaiting it, releases A once B is blocked or has retried, awaits both → one user, two cookies,
    the approval gone; the root wrapped in `RetryCountingRoot` records whether B saw `40001`.
    Plus closed and unapproved concurrent → both `signup_closed`;
  - the refusal log line holds no email and is written once per refusal.
  Existing tests that create accounts through the callback (including
  `server/src/routers/nulText.int.test.ts`) set `SIGNUPS: 'open'` in their config.
- [ ] 3.2 `packages/catalog/src/authStore.ts`: `authHasUsableAccountApproval(emailNorm, cutoff)`
  and `authConsumeAccountApproval(emailNorm, cutoff)` (`DELETE … RETURNING`);
  `server/src/routers/auth.ts`: the pre-check before the exchange, the consume after the user
  insert with the `SignupRefused` rollback, the re-lookup and the single log line outside the
  transaction body.

## 4. Login page (design D5)

- [ ] 4.1 Test first, `web/src/pages/index/components/LoginPage.test.tsx`: `signup_closed`
  shows the no-access-yet message with the retry control; the message contains none of
  `SIGNUPS`, `closed`, `stage`, `prod`.
- [ ] 4.2 `LoginPage.tsx`: the message in `LOGIN_ERROR_MESSAGES`; the comment says four groups.

## 5. Docs (design D7)

- [ ] 5.1 README: `SIGNUPS` in the settings table (default by stack, a typo refused); a "Closed
  sign-ups" section with approve, revoke and list commands for dev, stage and prod (statement on
  stdin, `-v ON_ERROR_STOP=1`, always `-v note=…`), the 7-day expiry and "approve shortly before
  sending the link"; the rollback order (remove `SIGNUPS` from KV first); `signup_closed` in the
  login-error notes. `docs/openbao-secrets.md` lists `SIGNUPS` if it lists optional keys.

## V. Verify

- [ ] V.1 `scripts/check-change.sh` green (tests, typecheck, audit, openspec, tests-with-code);
  `openspec validate closed-signups --strict`; CI db shards for the pg tiers.
- [ ] V.2 On the dev stack with `SIGNUPS=closed` set in `kv/autologger/dev` by the owner: a
  Google account with no account and no approval gets the no-access-yet page and no
  `auth.users` row appears; after `approve_account` it signs in and the row is gone; the owner's
  existing account signs in. Then the owner removes `SIGNUPS` again before the dev VM runs any
  branch without this change.
- [ ] V.3 Tier 2 consistency read (`consistency-read` skill) over the whole branch; `panel.md`
  section for any scope change.
