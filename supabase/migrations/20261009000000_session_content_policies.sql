-- Session content policies (ADR 0021 slice 7b-2, OpenSpec change `session-content-policies`,
-- design D1).
--
-- Each of the nine session tables gets one `<table>_user_all` policy for every command: a row is
-- the user's when its session belongs to one of the user's accessible shows (the owner or an admin
-- of the show's team, or a member holding a grant), the rule `requireSession` applies (owner
-- decision 1; catalog-database "User policies enforce the team permission model"). The check is a
-- correlated `exists` on `catalog.sessions` by primary key against the existing
-- `accessible_shows` helper, so its cost does not grow with the number of sessions the user can
-- reach (design A6, panel finding 4). `catalog.sessions`' own `catalog_user` read policy applies
-- inside it; it is wider (`member_shows`) than `accessible_shows`, so it removes nothing.
-- `catalog_user`'s privileges come back. The 7b-1 `<table>_system_all` policies stay.
--
-- One SECURITY DEFINER helper in the 6b-2 pattern (owner `postgres`, `search_path` pinned,
-- `enable_seqscan = off`, executable by `catalog_user` only): `session_exists(id)`, whether a
-- `catalog.sessions` row with that id exists, so the session adapter can tell a refused row lock or
-- read probe (no access) from a missing session (owner decision 3).
--
-- No transaction-control lines: every `begin`/`end` inside a DO block stays indented (migrate.sh
-- refuses a line that starts with one).

-- Whether a session exists, whoever asks (the existence half of a refused row lock or probe).
create or replace function catalog.session_exists(id text) returns boolean
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  set enable_seqscan = off
  as $$ select exists (select 1 from catalog.sessions s where s.id = session_exists.id) $$;

revoke all on function catalog.session_exists(text) from public;
grant execute on function catalog.session_exists(text) to catalog_user;

do $$
  declare t text;
  declare rule text := 'exists (select 1 from catalog.sessions s where s.id = session_id '
                       'and s.show_id in (select catalog.accessible_shows(catalog.app_user_id())))';
  begin
    foreach t in array array['session_events', 'session_transport', 'session_audio_segments',
                             'session_transcript_words', 'session_topics',
                             'session_transcript_paragraphs', 'session_transcript_sentiment',
                             'session_dashboards', 'session_meta'] loop
      execute format('drop policy if exists %I on catalog.%I', t || '_user_all', t);
      execute format('create policy %I on catalog.%I for all to catalog_user using (%s) with check (%s)',
                     t || '_user_all', t, rule, rule);
      execute format('grant select, insert, update, delete on catalog.%I to catalog_user', t);
    end loop;
  end
$$;
