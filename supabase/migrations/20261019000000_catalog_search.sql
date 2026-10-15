-- Catalog search (OpenSpec change `catalog-search`, design D2-D5, D8; ADR 0029).
--
-- Lexical search in Postgres: `pg_trgm` and `unaccent` in schema `extensions`, an English
-- text-search configuration that folds accents (`catalog.search_english`), a name normaliser for
-- trigram matching (`catalog.search_norm`), stored generated `tsvector` columns with GIN indexes,
-- trigram indexes on the normalised session title, show name and studio name, and
-- `catalog.session_transcript_chunks`: the transcript in fixed blocks of 40 word ordinals, kept
-- equal to the words by statement-level triggers (design D4). One SECURITY DEFINER function,
-- `catalog.search`, runs the whole search as one statement and applies the access sets from the
-- policy helpers in every branch (design D5).
--
-- Function privileges (design D2): every function here is revoked from public. `search_norm` is
-- executable by both catalog roles (index expressions call it on every write), `search` by
-- `catalog_user` only, and the chunk refresh and trigger functions by no one.
--
-- Rewrite cost (design D3): adding the stored generated columns rewrites `sessions`,
-- `session_topics` and `session_events` under an ACCESS EXCLUSIVE lock.
--
-- Upgrade note (ADR 0029): the unaccent rules are part of the pinned Postgres image. If an image
-- upgrade changes them, rewrite the generated columns and REINDEX the search indexes.
--
-- No transaction-control lines: every `begin`/`end` inside a function body stays indented
-- (migrate.sh refuses a line that starts with one).

-- Extensions (design D2). The pg test template has no `extensions` schema; Supabase has one.
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;
-- Index and generated-column expressions that call `extensions` objects run as the writing role.
grant usage on schema extensions to catalog_user, catalog_system;

-- English stemming with accent folding, for every search vector and query (design D2).
do $$
  begin
    if not exists (select 1 from pg_catalog.pg_ts_config c
                   where c.cfgname = 'search_english' and c.cfgnamespace = 'catalog'::regnamespace) then
      create text search configuration catalog.search_english (copy = pg_catalog.english);
    end if;
  end
$$;
alter text search configuration catalog.search_english
  alter mapping for word, hword, hword_part with extensions.unaccent, pg_catalog.english_stem;

-- The name normaliser, for trigram matching only: accents removed, lowercased (non-ASCII too).
create or replace function catalog.search_norm(t text) returns text
  language sql immutable parallel safe
  set search_path = pg_catalog
  as $$ select lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(t, '')) collate "und-x-icu") $$;

-- Generated search columns (design D3).
alter table catalog.sessions
  add column if not exists search_meta tsvector generated always as (
    setweight(to_tsvector('catalog.search_english'::regconfig, title), 'A') ||
    setweight(to_tsvector('catalog.search_english'::regconfig, episode), 'B')) stored,
  add column if not exists search_notes tsvector generated always as (
    to_tsvector('catalog.search_english'::regconfig, notes)) stored;
alter table catalog.session_topics
  add column if not exists search_tsv tsvector generated always as (
    to_tsvector('catalog.search_english'::regconfig, summary)) stored;
alter table catalog.session_events
  add column if not exists search_tsv tsvector generated always as (
    to_tsvector('catalog.search_english'::regconfig, message)) stored;

-- Transcript chunks (design D4): the words with ordinal in [bucket*40, bucket*40+40).
create table if not exists catalog.session_transcript_chunks (
  session_id text collate "C" not null references catalog.sessions (id),
  bucket bigint not null,
  start_sec double precision,
  end_sec double precision,
  speaker text collate "C" not null default '',
  text text collate "C" not null,
  search_tsv tsvector generated always as (to_tsvector('catalog.search_english'::regconfig, text)) stored,
  primary key (session_id, bucket)
);
alter table catalog.session_transcript_chunks enable row level security;
drop policy if exists session_transcript_chunks_system_all on catalog.session_transcript_chunks;
create policy session_transcript_chunks_system_all on catalog.session_transcript_chunks
  for all to catalog_system using (true) with check (true);
drop policy if exists session_transcript_chunks_user_select on catalog.session_transcript_chunks;
create policy session_transcript_chunks_user_select on catalog.session_transcript_chunks
  for select to catalog_user
  using (exists (select 1 from catalog.sessions s where s.id = session_id
                 and s.show_id in (select catalog.accessible_shows(catalog.app_user_id()))));
-- New catalog tables get `arwd` for catalog_user by default (design A22): a direct write fails
-- with 42501 instead of affecting no row.
revoke insert, update, delete on catalog.session_transcript_chunks from catalog_user;

-- Rebuilds the given buckets of one session from its words. The per-session advisory lock keeps
-- two transactions from interleaving a delete-and-reinsert of the same buckets.
create or replace function catalog.refresh_transcript_chunks(p_session text, p_buckets bigint[])
  returns void
  language plpgsql security definer
  set search_path = pg_catalog, pg_temp
  as $$
    begin
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('transcript_chunks:' || p_session, 0));
      delete from catalog.session_transcript_chunks c
       where c.session_id = p_session and c.bucket = any(p_buckets);
      insert into catalog.session_transcript_chunks (session_id, bucket, start_sec, end_sec, speaker, text)
      select p_session, b.bucket,
             min(w.start_sec) filter (where w.start_sec > 0),
             max(w.end_sec),
             (array_agg(w.speaker order by w.ordinal, w.id))[1],
             string_agg(w.word, ' ' order by w.ordinal, w.id)
        from (select distinct u.bucket from unnest(p_buckets) as u(bucket)) b
        join catalog.session_transcript_words w
          on w.session_id = p_session
         and w.ordinal >= b.bucket * 40 and w.ordinal < b.bucket * 40 + 40
       where w.word <> ''
       group by b.bucket;
    end
  $$;

-- The statement-level trigger body: each distinct (session, bucket) the statement touched, one
-- refresh per session, in session order.
create or replace function catalog.sync_transcript_chunks() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, pg_temp
  as $$
    declare r record;
    begin
      if tg_op = 'INSERT' then
        for r in select n.session_id, array_agg(distinct pg_catalog.floor(n.ordinal::numeric / 40)::bigint) as buckets
                   from new_rows n group by n.session_id order by n.session_id loop
          perform catalog.refresh_transcript_chunks(r.session_id, r.buckets);
        end loop;
      elsif tg_op = 'UPDATE' then
        for r in select x.session_id, array_agg(distinct pg_catalog.floor(x.ordinal::numeric / 40)::bigint) as buckets
                   from (select o.session_id, o.ordinal from old_rows o
                         union all
                         select n.session_id, n.ordinal from new_rows n) x
                  group by x.session_id order by x.session_id loop
          perform catalog.refresh_transcript_chunks(r.session_id, r.buckets);
        end loop;
      else
        for r in select o.session_id, array_agg(distinct pg_catalog.floor(o.ordinal::numeric / 40)::bigint) as buckets
                   from old_rows o group by o.session_id order by o.session_id loop
          perform catalog.refresh_transcript_chunks(r.session_id, r.buckets);
        end loop;
      end if;
      return null;
    end
  $$;

drop trigger if exists session_transcript_words_chunks_insert on catalog.session_transcript_words;
create trigger session_transcript_words_chunks_insert
  after insert on catalog.session_transcript_words
  referencing new table as new_rows
  for each statement execute function catalog.sync_transcript_chunks();
drop trigger if exists session_transcript_words_chunks_update on catalog.session_transcript_words;
create trigger session_transcript_words_chunks_update
  after update on catalog.session_transcript_words
  referencing old table as old_rows new table as new_rows
  for each statement execute function catalog.sync_transcript_chunks();
drop trigger if exists session_transcript_words_chunks_delete on catalog.session_transcript_words;
create trigger session_transcript_words_chunks_delete
  after delete on catalog.session_transcript_words
  referencing old table as old_rows
  for each statement execute function catalog.sync_transcript_chunks();

-- The search (design D5, D6, D8). It bypasses RLS (owner `postgres`), so every branch applies the
-- caller's access sets from the policy helpers: studios and shows of the caller's teams
-- (member_studios, member_shows); session titles and episodes of member shows; notes and moments
-- only of accessible shows (accessible_shows). Hidden and showless sessions never match. Snippets
-- are plain text with U+E000/U+E001 around hits; those characters are stripped from the source
-- first. Only transcript moments carry `sec`.
create or replace function catalog.search(q text, p_studio text, p_show text, p_limit integer)
  returns jsonb
  language plpgsql stable security definer
  set search_path = pg_catalog, pg_temp
  set pg_trgm.word_similarity_threshold = 0.4
  as $$
    declare
      v_uid text := catalog.app_user_id();
      v_q text := pg_catalog.btrim(coalesce(q, ''));
      v_norm text;
      v_like text;
      v_tsq tsquery;
      v_lim integer := greatest(1, least(coalesce(p_limit, 5), 25));
      v_sentinels text := pg_catalog.chr(57344) || pg_catalog.chr(57345);
      v_opts text;
      v_studio_ids text[];
      v_member_shows text[];
      v_access_shows text[];
      v_studios jsonb;
      v_shows jsonb;
      v_sessions jsonb;
      v_moments jsonb;
    begin
      if v_uid is null or v_q = '' then
        return jsonb_build_object('q', v_q, 'studios', '[]'::jsonb, 'shows', '[]'::jsonb,
                                  'sessions', '[]'::jsonb, 'moments', '[]'::jsonb);
      end if;
      v_norm := catalog.search_norm(v_q);
      v_like := '%' || replace(replace(replace(v_norm, '\', '\\'), '%', '\%'), '_', '\_') || '%';
      v_tsq := websearch_to_tsquery('catalog.search_english'::regconfig, v_q);
      v_opts := 'StartSel="' || pg_catalog.chr(57344) || '", StopSel="' || pg_catalog.chr(57345)
                || '", MaxWords=24, MinWords=8, MaxFragments=1, FragmentDelimiter=" … "';
      select coalesce(array_agg(x), '{}') into v_studio_ids from catalog.member_studios(v_uid) x;
      select coalesce(array_agg(x), '{}') into v_member_shows from catalog.member_shows(v_uid) x;
      select coalesce(array_agg(x), '{}') into v_access_shows from catalog.accessible_shows(v_uid) x;

      -- Studios of the caller's teams, by name (substring or close misspelling).
      select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.display_name)
                                order by r.sim desc, r.display_name, r.id), '[]'::jsonb)
        into v_studios
        from (select d.id, d.display_name,
                     extensions.word_similarity(v_norm, catalog.search_norm(d.display_name)) as sim
                from catalog.studio_definitions d
               where d.id = any(v_studio_ids)
                 and (p_studio is null or d.id = p_studio)
                 and (p_show is null or exists (
                       select 1 from catalog.shows f
                        where f.id = p_show and f.studio_id = d.id and f.id = any(v_member_shows)))
                 and (catalog.search_norm(d.display_name) like v_like
                      or v_norm operator(extensions.<%) catalog.search_norm(d.display_name))
               order by sim desc, d.display_name, d.id
               limit v_lim) r;

      -- Shows of the caller's teams, matched and ranked the same way.
      select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'studio_id', r.studio_id)
                                order by r.sim desc, r.name, r.id), '[]'::jsonb)
        into v_shows
        from (select s.id, s.name, s.studio_id,
                     extensions.word_similarity(v_norm, catalog.search_norm(s.name)) as sim
                from catalog.shows s
               where s.id = any(v_member_shows)
                 and (p_studio is null or s.studio_id = p_studio)
                 and (p_show is null or s.id = p_show)
                 and (catalog.search_norm(s.name) like v_like
                      or v_norm operator(extensions.<%) catalog.search_norm(s.name))
               order by sim desc, s.name, s.id
               limit v_lim) r;

      -- Sessions of member shows. Title and episode match for every member; notes only on
      -- accessible shows. For any other show, match, rank and snippet come from search_meta and
      -- the trigram title score alone.
      select coalesce(jsonb_agg(jsonb_build_object(
                 'id', r.id, 'title', r.title, 'episode', r.episode, 'show_id', r.show_id,
                 'studio_id', r.studio_id, 'started_at_utc', r.started_at_utc,
                 'archived', r.archived <> 0,
                 'match', case when r.title_hit then 'title' else 'notes' end,
                 'snippet', case when r.title_hit then null
                                 else ts_headline('catalog.search_english'::regconfig,
                                                  translate(r.notes, v_sentinels, ''), v_tsq, v_opts)
                            end)
               order by r.fts_hit desc, r.fts_rank desc, r.sim desc, r.started_at_utc desc, r.id), '[]'::jsonb)
        into v_sessions
        from (select m.*,
                     (m.meta_hit or m.trgm_hit) as title_hit,
                     (m.meta_hit or m.notes_hit) as fts_hit,
                     greatest(case when m.meta_hit then ts_rank_cd(m.search_meta, v_tsq) else 0 end,
                              case when m.notes_hit then ts_rank_cd(m.search_notes, v_tsq) else 0 end) as fts_rank,
                     case when m.trgm_hit
                          then extensions.word_similarity(v_norm, catalog.search_norm(m.title))
                          else 0 end as sim
                from (select s.id, s.title, s.episode, s.show_id, sh.studio_id, s.started_at_utc,
                             s.archived, s.search_meta,
                             case when s.show_id = any(v_access_shows) then s.notes else '' end as notes,
                             case when s.show_id = any(v_access_shows) then s.search_notes end as search_notes,
                             (s.search_meta @@ v_tsq) as meta_hit,
                             (catalog.search_norm(s.title) like v_like
                              or v_norm operator(extensions.<%) catalog.search_norm(s.title)) as trgm_hit,
                             (s.show_id = any(v_access_shows) and s.search_notes @@ v_tsq) as notes_hit
                        from catalog.sessions s
                        join catalog.shows sh on sh.id = s.show_id
                       where s.ui_hidden = 0
                         and s.show_id = any(v_member_shows)
                         and (p_studio is null or sh.studio_id = p_studio)
                         and (p_show is null or s.show_id = p_show)
                         and (s.search_meta @@ v_tsq
                              or catalog.search_norm(s.title) like v_like
                              or v_norm operator(extensions.<%) catalog.search_norm(s.title)
                              or (s.show_id = any(v_access_shows) and s.search_notes @@ v_tsq))) m
               order by fts_hit desc, fts_rank desc, sim desc, m.started_at_utc desc, m.id
               limit v_lim) r;

      -- Moments: transcript chunks, topics and events of visible sessions on accessible shows, at
      -- most 3 per session.
      select coalesce(jsonb_agg(jsonb_build_object(
                 'session_id', r.session_id, 'session_title', r.session_title, 'show_id', r.show_id,
                 'kind', r.kind, 'id', r.id, 'sec', r.sec, 'speaker', r.speaker,
                 'snippet', ts_headline('catalog.search_english'::regconfig,
                                        translate(r.body, v_sentinels, ''), v_tsq, v_opts))
               order by r.rank desc, r.started_at_utc desc, r.session_id, r.kind, r.id), '[]'::jsonb)
        into v_moments
        from (select j.*
                from (select h.*, s.title as session_title, s.show_id, s.started_at_utc,
                             row_number() over (partition by h.session_id
                                                order by h.rank desc, h.kind, h.id) as rn
                        from (select c.session_id, 'transcript'::text as kind, c.bucket::text as id,
                                     c.start_sec as sec, c.speaker, c.text as body,
                                     ts_rank_cd(c.search_tsv, v_tsq) as rank
                                from catalog.session_transcript_chunks c
                               where c.search_tsv @@ v_tsq
                              union all
                              select t.session_id, 'topic', t.id, null, '', t.summary,
                                     ts_rank_cd(t.search_tsv, v_tsq)
                                from catalog.session_topics t
                               where t.search_tsv @@ v_tsq
                              union all
                              select e.session_id, 'event', e.id, null, '', e.message,
                                     ts_rank_cd(e.search_tsv, v_tsq)
                                from catalog.session_events e
                               where e.search_tsv @@ v_tsq) h
                        join catalog.sessions s on s.id = h.session_id
                        join catalog.shows sh on sh.id = s.show_id
                       where s.ui_hidden = 0
                         and s.show_id = any(v_access_shows)
                         and (p_studio is null or sh.studio_id = p_studio)
                         and (p_show is null or s.show_id = p_show)) j
               where j.rn <= 3
               order by j.rank desc, j.started_at_utc desc, j.session_id, j.kind, j.id
               limit v_lim) r;

      return jsonb_build_object('q', v_q, 'studios', v_studios, 'shows', v_shows,
                                'sessions', v_sessions, 'moments', v_moments);
    end
  $$;

-- Function privileges (design D2).
revoke all on function catalog.search_norm(text) from public;
revoke all on function catalog.refresh_transcript_chunks(text, bigint[]) from public;
revoke all on function catalog.sync_transcript_chunks() from public;
revoke all on function catalog.search(text, text, text, integer) from public;
grant execute on function catalog.search_norm(text) to catalog_user, catalog_system;
grant execute on function catalog.search(text, text, text, integer) to catalog_user;

-- Backfill (design D4): every existing session's chunks, by the same function the triggers use.
select catalog.refresh_transcript_chunks(w.session_id,
         array_agg(distinct floor(w.ordinal::numeric / 40)::bigint))
  from catalog.session_transcript_words w
 group by w.session_id;

-- Indexes (design D3), after the backfill.
create index if not exists idx_sessions_search_meta on catalog.sessions using gin (search_meta);
create index if not exists idx_sessions_search_notes on catalog.sessions using gin (search_notes);
create index if not exists idx_session_topics_search on catalog.session_topics using gin (search_tsv);
create index if not exists idx_session_events_search on catalog.session_events using gin (search_tsv);
create index if not exists idx_session_chunks_search on catalog.session_transcript_chunks using gin (search_tsv);
create index if not exists idx_sessions_title_trgm on catalog.sessions
  using gin (catalog.search_norm(title) extensions.gin_trgm_ops);
create index if not exists idx_shows_name_trgm on catalog.shows
  using gin (catalog.search_norm(name) extensions.gin_trgm_ops);
create index if not exists idx_studio_definitions_name_trgm on catalog.studio_definitions
  using gin (catalog.search_norm(display_name) extensions.gin_trgm_ops);
