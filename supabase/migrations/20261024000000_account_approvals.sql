-- Account approvals for closed sign-ups (OpenSpec change `closed-signups`, design D2).
--
-- - `catalog.account_approvals`: one row per email a developer approved for a first sign-in.
--   `email_norm` is the ASCII-normalized email (printable ASCII, no spaces, `local@domain`, `A`-`Z`
--   folded), the same form as `asciiEmailNorm` in `server/src/env.ts`. `approved_at_utc` has the
--   server's `Date.toISOString()` shape (`YYYY-MM-DDTHH:MM:SS.sssZ`), so it compares as text
--   against the Clock; the callback uses an approval only within 7 days of it (design D3).
--   `note` is the operator's optional reminder (at most 200 characters).
-- - Row-level security: system-only, like `kv`. The allow-all `account_approvals_system_all`
--   policy for `catalog_system`, no `catalog_user` policy, and `catalog_user`'s privileges are
--   revoked. Runs as `postgres`, so the catalog's default privileges grant `catalog_system`
--   select, insert, update and delete; insert, update and truncate are revoked below, so the app
--   (the OAuth callback's system task `oauth-callback`) can read and consume an approval but never
--   create or extend one (panel M2). `anon`, `authenticated` and `public` get none, as with every
--   catalog table.
-- - `catalog.approve_account(email, note)` and `catalog.revoke_account_approval(email)` are the
--   operator commands, run as `postgres` over `psql` (design D7). Both trim ASCII whitespace,
--   refuse with SQLSTATE 22023 an email with a character outside `!`..`~` or not of the shape
--   `local@domain`, and fold `A`-`Z`. Approve inserts or refreshes the row (a re-approval restarts
--   the 7 days; a blank note is stored as null) and returns the normalized email; revoke deletes
--   it and returns whether a row went. Both are `security invoker` with a fixed `search_path`, and
--   `execute` is revoked from `public`, so no app role can run them.
-- - Rollback (documented steps, not a migration file), in this order:
--   1. Remove `SIGNUPS` from every `kv/autologger*/…` secret that holds it (a human step): the
--      reverted code's compose wrapper refuses a KV secret with an unknown key.
--   2. Revert the code.
--   3. `drop function catalog.approve_account(text, text);
--       drop function catalog.revoke_account_approval(text);
--       drop table catalog.account_approvals;`
--   Approvals are lost; no account changes.

create table catalog.account_approvals (
  email_norm      text collate "C" primary key
                  check (email_norm ~ '^[!-~]+@[!-~]+$' and email_norm = lower(email_norm)),
  approved_at_utc text collate "C" not null,   -- YYYY-MM-DDTHH:MM:SS.sssZ, as Date.toISOString()
  note            text collate "C" check (note is null or char_length(note) <= 200)
);

alter table catalog.account_approvals enable row level security;

drop policy if exists account_approvals_system_all on catalog.account_approvals;
create policy account_approvals_system_all on catalog.account_approvals
  for all to catalog_system using (true) with check (true);

revoke all on catalog.account_approvals from catalog_user;
revoke insert, update, truncate on catalog.account_approvals from catalog_system;

-- The function bodies are indented: the migrate runner refuses a line that starts with
-- `begin` or `end` (docker/supabase/migrate.sh).
create function catalog.approve_account(email text, note text default null) returns text
  language plpgsql
  security invoker
  set search_path = catalog, pg_temp
as $$
  declare
    ws constant text := E' \t\n\r\f' || chr(11);
    norm text collate "C" := btrim(approve_account.email, ws);
  begin
    if norm is null or norm !~ '^[!-~]+@[!-~]+$' then
      raise exception 'approve_account: the email must be printable ASCII of the shape local@domain'
        using errcode = '22023';
    end if;
    norm := lower(norm);
    insert into catalog.account_approvals (email_norm, approved_at_utc, note)
    values (
      norm,
      to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      case when btrim(approve_account.note, ws) = '' then null else approve_account.note end
    )
    on conflict (email_norm) do update
      set approved_at_utc = excluded.approved_at_utc, note = excluded.note;
    return norm;
  end;
$$;

create function catalog.revoke_account_approval(email text) returns boolean
  language plpgsql
  security invoker
  set search_path = catalog, pg_temp
as $$
  declare
    ws constant text := E' \t\n\r\f' || chr(11);
    norm text collate "C" := btrim(revoke_account_approval.email, ws);
    n bigint;
  begin
    if norm is null or norm !~ '^[!-~]+@[!-~]+$' then
      raise exception 'revoke_account_approval: the email must be printable ASCII of the shape local@domain'
        using errcode = '22023';
    end if;
    norm := lower(norm);
    delete from catalog.account_approvals where email_norm = norm;
    get diagnostics n = row_count;
    return n > 0;
  end;
$$;

revoke execute on function catalog.approve_account(text, text) from public;
revoke execute on function catalog.revoke_account_approval(text) from public;
