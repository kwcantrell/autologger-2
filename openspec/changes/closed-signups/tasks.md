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

- [x] 1.1 Test first, new `server/src/test/pg/accountApprovals.pg.test.ts`, plus the recorded
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
- [x] 1.2 `supabase/migrations/20261024000000_account_approvals.sql`: the table, RLS, the
  system policy, the revokes (`catalog_user` all; `catalog_system` insert, update, truncate), the
  two functions with `execute` revoked from `public`, a header comment with the rollback steps
  (KV first, design Risks).
  Evidence (1.1, 1.2): red `cd server && npx vitest run --project pg
  src/test/pg/accountApprovals.pg.test.ts src/test/pg/catalogSchema.pg.test.ts
  src/test/pg/catalogPolicies.pg.test.ts` -> `20 failed` (`no-at-sign: expected '42883' to be
  '22023'`, `expected '42P01' to be '23514'`) (cs-1.1-red.log); green -> `Test Files 3 passed (3)`,
  `Tests 73 passed (73)` (cs-1.1-green.log); related pg files (catalogRoles, importLegacy.pg,
  companionTables) `33 passed` (cs-1.1-green-related.log); `docker/supabase/test_migrate.sh` `55
  passed` (cs-1.1-test_migrate.log). Two existing catalogSchema tests that insert/update every
  table as `catalog_system` now seed this table as `postgres` and expect `42501` on its update
  (D2). The plpgsql bodies are indented because `migrate.sh` refuses lines starting `begin`/`end`;
  the trim covers all ASCII whitespace, as `asciiEmailNorm`'s `trim()` does. **Outside the task
  list, recorded for the consistency read:** the new migration moves the legacy importer's pin
  (`server/scripts/legacyImportSql.ts` `TARGET_SCHEMA_VERSION` `20261023000000` ->
  `20261024000000`), which `server/src/test/importLegacy.test.ts` "is the newest migration"
  requires; the importer never touches `account_approvals`; importer unit tests `24 passed`
  (cs-1.1-importer-unit-green.log).

## 2. Setting (design D1)

- [x] 2.1 Test first:
  - `server/src/env.test.ts`: `signupsMode` for `open`, `closed`, ` Closed `, empty with stack
    `dev` (open), empty with `stage`, `prod` and no stack (closed), `opne` (invalid);
  - `server/src/bootGuard.test.ts`: `SIGNUPS=opne` refuses boot with a message naming `SIGNUPS`
    and not containing `opne`; `open`, `closed` and unset boot;
  - `docker/scripts/compose-run.test.mjs`: a KV secret with `SIGNUPS=opne` is refused before
    compose with a message naming `SIGNUPS` and not containing `opne`; `open`, `closed`, `Closed`,
    blank and absent pass;
  - a boot test that the server logs `sign-ups: closed` for stack `stage` with `SIGNUPS` unset and
    `sign-ups: open` for `dev`.
- [x] 2.2 `packages/ports/src/config.ts` (optional `SIGNUPS`, `AUTOLOGGER_STACK`),
  `server/src/env.ts` (`signupsMode`), `server/src/node/config.ts` (both keys, the boot log line),
  `server/src/bootGuard.ts`, `docker/scripts/compose-run.mjs` (`checkSignupsSetting` beside
  `checkSignInClient`); `docker/secrets-env.yaml` gains `SIGNUPS:` under "Sign-in and tokens".
  `make check` stays green.
  Evidence (2.1, 2.2): red `cd server && npx vitest run --project unit src/env.test.ts
  src/bootGuard.test.ts src/node/config.test.ts` -> `Tests 8 failed | 91 passed (99)`
  (`TypeError: signupsMode is not a function`, `expected undefined to be ''`); `node --test
  docker/scripts/compose-run.test.mjs` -> `checkSignupsSetting is not a function` (cs-2.1-red.log;
  the boots-with-open/closed/blank test and the `Closed` passthrough run already passed). Green ->
  `Test Files 3 passed (3)`, `Tests 99 passed (99)`; node --test `pass 90`, `fail 0`
  (cs-2.1-green.log). `make check` -> `check-envs: ok (all)` (cs-2.2-make-check.log); `npm run
  typecheck` exit 0; biome clean on the TS files.

## 3. Callback (design D3, D4, D5)

- [x] 3.1 Test first, `server/src/routers/auth.int.test.ts` (closed unless a test says open):
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
- [x] 3.2 `packages/catalog/src/authStore.ts`: `authHasUsableAccountApproval(emailNorm, cutoff)`
  and `authConsumeAccountApproval(emailNorm, cutoff)` (`DELETE … RETURNING`);
  `server/src/routers/auth.ts`: the pre-check before the exchange, the consume after the user
  insert with the `SignupRefused` rollback, the re-lookup and the single log line outside the
  transaction body.
  Evidence (3.1, 3.2): red `cd server && npx vitest run --project integration
  src/routers/auth.int.test.ts src/routers/nulText.int.test.ts` -> `9 failed | 58 passed`
  (`expected '/' to be '/?login_error=signup_closed'`, `expected [ 'someone@example.com' ] to
  deeply equal []`, `Test timed out in 5000ms` for the revoke and approved-concurrent holds that
  never fired) (cs-3.1-red.log; bootstrap, existing enabled/disabled and both open cases already
  passed). Green -> `2 passed`, `67 passed (67)` (cs-3.1-green.log). Concurrent: A held after
  `DELETE FROM account_approvals`, B started unawaited until its user insert blocked, then A
  released -> one user, two cookies, approval gone, B saw `40001` on 4 of 4 runs. "Supabase Auth
  not called" = its `/token` mock still pending. Full integration project `108 files`, `1636
  passed` (cs-3.2-integration-all.log); unit `615 passed | 5 skipped` (cs-3.2-unit-all.log); `npm
  run typecheck` exit 0; biome clean on the touched lines (authStore.ts format issues predate this
  change). `server/src/env.ts` now exports `asciiEmailNorm`.

## 4. Login page (design D5)

- [x] 4.1 Test first, `web/src/pages/index/components/LoginPage.test.tsx`: `signup_closed`
  shows the no-access-yet message with the retry control; the message contains none of
  `SIGNUPS`, `closed`, `stage`, `prod`.
- [x] 4.2 `LoginPage.tsx`: the message in `LOGIN_ERROR_MESSAGES`; the comment says four groups.
  Evidence (4.1, 4.2): red `cd web && npx vitest run src/pages/index/components/LoginPage.test.tsx`
  -> `expected 'Sign-in didn't complete.Try again' to contain 'This Google account doesn't have
  acc…'`, `1 failed | 14 passed` (cs-4.1-red.log); green -> `Test Files 1 passed (1)`, `Tests 15
  passed (15)` (cs-4.1-green.log); `node_modules/.bin/biome check` on both files -> `Checked 2
  files`, no fixes.

## 5. Docs (design D7)

- [x] 5.1 README: `SIGNUPS` in the settings table (default by stack, a typo refused); a "Closed
  sign-ups" section with approve, revoke and list commands for dev, stage and prod (statement on
  stdin, `-v ON_ERROR_STOP=1`, always `-v note=…`), the 7-day expiry and "approve shortly before
  sending the link"; the rollback order (remove `SIGNUPS` from KV first); `signup_closed` in the
  login-error notes. `docs/openbao-secrets.md` lists `SIGNUPS` if it lists optional keys.
  Evidence: README `### Closed sign-ups` (who signs in, invites, 7-day approvals, approve/revoke/list
  for `autologger-dev-db-1`, `autologger-stage-db-1`, `autologger-db-1` with `-v ON_ERROR_STOP=1`
  and `-v note`, 22023, deploy note, rollback order), `SIGNUPS` rows in the settings and prod-keys
  tables, `signup_closed` in the callback failure-redirect list; `docs/openbao-secrets.md` "SIGNUPS
  is optional" bullet. `scripts/check-change.sh --only guide-size,yaml` -> PASS.

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
