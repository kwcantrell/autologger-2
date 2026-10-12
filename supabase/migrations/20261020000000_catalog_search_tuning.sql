-- Catalog search tuning (OpenSpec change `catalog-search`, design D11; ADR 0029). A new file, so the
-- applied 20261019000000_catalog_search.sql stays unchanged.
--
-- 1. Stricter typo matching: the trigram word-similarity threshold rises from 0.4 to 0.5.
-- 2. Exact-phrase fallback for stop-word queries: `catalog.search_phrase_norm` (search_norm, then
--    whitespace runs to one space, then everything but letters, digits and spaces removed, then
--    spaces collapsed and trimmed), trigram GIN indexes on it for transcript chunks, topic summaries
--    and event messages, and a fallback in `catalog.search` that runs only when the full-text query
--    is empty and the normalised phrase has at least 2 words and 6 characters. It matches whole
--    words, reads at most 2,000 candidate rows per source (visible sessions on accessible shows,
--    filtered before the cap), ranks by session start (newest first)
--    then ordinal, and builds its snippet on the original tokens.
-- 3. `p_session text default null`: one session's moments only (no per-session cap; the other
--    groups empty), and `moment_sessions`, each listed session's total matches, at most 1000.
--    The default keeps 4-argument calls from a server not yet upgraded working.
--
-- Access is applied exactly as in 20261019000000: the function is a definer, so every branch uses
-- the policy helpers' sets; hidden and showless sessions never match.
--
-- Function privileges: `search_phrase_norm` is revoked from public and executable by both catalog
-- roles (index expressions call it on every write); the new `search` is revoked from public (a new
-- function is executable by PUBLIC) and executable by `catalog_user` only.
--
-- No transaction-control lines: every `begin`/`end` inside a function body stays indented.

-- The phrase normaliser (design D11.2). The regular expressions run under the ICU collation, so
-- letters and digits are Unicode-wide and whitespace includes tabs, newlines and no-break spaces.
create or replace function catalog.search_phrase_norm(t text) returns text
  language sql immutable parallel safe
  set search_path = pg_catalog
  as $$
    select pg_catalog.btrim(pg_catalog.regexp_replace(
             pg_catalog.regexp_replace(
               pg_catalog.regexp_replace(catalog.search_norm(t) collate "und-x-icu", '\s+', ' ', 'g'),
               '[^[:alnum:] ]', '', 'g'),
             ' {2,}', ' ', 'g'))
  $$;

revoke all on function catalog.search_phrase_norm(text) from public;
grant execute on function catalog.search_phrase_norm(text) to catalog_user, catalog_system;

-- The phrase indexes (design D11.2).
create index if not exists idx_session_chunks_phrase_trgm on catalog.session_transcript_chunks
  using gin (catalog.search_phrase_norm(text) extensions.gin_trgm_ops);
create index if not exists idx_session_topics_phrase_trgm on catalog.session_topics
  using gin (catalog.search_phrase_norm(summary) extensions.gin_trgm_ops);
create index if not exists idx_session_events_phrase_trgm on catalog.session_events
  using gin (catalog.search_phrase_norm(message) extensions.gin_trgm_ops);

-- The search (design D5, D6, D8, D11), replacing the 4-argument function.
drop function if exists catalog.search(text, text, text, integer);

create or replace function catalog.search(q text, p_studio text, p_show text, p_limit integer,
                                          p_session text default null)
  returns jsonb
  language plpgsql stable security definer
  set search_path = pg_catalog, pg_temp
  set pg_trgm.word_similarity_threshold = 0.5
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
      v_moments jsonb := '[]'::jsonb;
      v_moment_sessions jsonb := '[]'::jsonb;
      -- The phrase fallback (D11.2): v_fts is false when the full-text query is empty; v_phrase is
      -- then the normalised phrase, or null when it is too short to search.
      v_fts boolean;
      v_phrase text;
      v_pwords text[];
      v_pin text;
      v_pword text;
      -- Snippet building for the fallback.
      v_i integer;
      v_k integer;
      v_t integer;
      v_a integer;
      v_z integer;
      v_at integer;
      v_w text;
      v_toks text[];
      v_fw text[];
      v_own integer[];
      v_snip text;
    begin
      if v_uid is null or v_q = '' then
        return jsonb_build_object('q', v_q, 'studios', '[]'::jsonb, 'shows', '[]'::jsonb,
                                  'sessions', '[]'::jsonb, 'moments', '[]'::jsonb,
                                  'moment_sessions', '[]'::jsonb);
      end if;
      v_norm := catalog.search_norm(v_q);
      v_like := '%' || replace(replace(replace(v_norm, '\', '\\'), '%', '\%'), '_', '\_') || '%';
      v_tsq := websearch_to_tsquery('catalog.search_english'::regconfig, v_q);
      v_fts := numnode(v_tsq) > 0;
      if not v_fts then
        v_phrase := catalog.search_phrase_norm(v_q);
        v_pwords := string_to_array(v_phrase, ' ');
        if cardinality(v_pwords) < 2 or char_length(v_phrase) < 6 then
          v_phrase := null;
        else
          -- Only letters, digits and single spaces remain, so neither pattern has a wildcard of
          -- its own; the padded form matches whole words.
          v_pin := '%' || v_phrase || '%';
          v_pword := '% ' || v_phrase || ' %';
        end if;
      end if;
      v_opts := 'StartSel="' || pg_catalog.chr(57344) || '", StopSel="' || pg_catalog.chr(57345)
                || '", MaxWords=24, MinWords=8, MaxFragments=1, FragmentDelimiter=" … "';
      select coalesce(array_agg(x), '{}') into v_studio_ids from catalog.member_studios(v_uid) x;
      select coalesce(array_agg(x), '{}') into v_member_shows from catalog.member_shows(v_uid) x;
      select coalesce(array_agg(x), '{}') into v_access_shows from catalog.accessible_shows(v_uid) x;

      -- Studios of the caller's teams, by name (substring or close misspelling). None when the
      -- search is filtered to one session.
      select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.display_name)
                                order by r.sim desc, r.display_name, r.id), '[]'::jsonb)
        into v_studios
        from (select d.id, d.display_name,
                     extensions.word_similarity(v_norm, catalog.search_norm(d.display_name)) as sim
                from catalog.studio_definitions d
               where p_session is null
                 and d.id = any(v_studio_ids)
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
               where p_session is null
                 and s.id = any(v_member_shows)
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
                       where p_session is null
                         and s.ui_hidden = 0
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
      -- most 3 per session unless filtered to one session, with each listed session's total.
      -- Candidates come from the full-text indexes, or, for the phrase fallback, from the phrase
      -- indexes with at most 2,000 rows per source, counted after the access set and the
      -- hidden-session rule, so other teams' rows can't use them up. Each source has a branch for
      -- every session and one for `p_session`, which reads that session's rows by primary key.
      if v_fts or v_phrase is not null then
        with h as (
          -- Full text, every session.
          select c.session_id, 'transcript'::text as kind, c.bucket::text as id, c.bucket as ord,
                 c.start_sec as sec, c.speaker, c.text as body,
                 ts_rank_cd(c.search_tsv, v_tsq) as rank
            from catalog.session_transcript_chunks c
           where v_fts and p_session is null and c.search_tsv @@ v_tsq
          union all
          select t.session_id, 'topic', t.id, t.ordinal, null, '', t.summary,
                 ts_rank_cd(t.search_tsv, v_tsq)
            from catalog.session_topics t
           where v_fts and p_session is null and t.search_tsv @@ v_tsq
          union all
          select e.session_id, 'event', e.id, null, null, '', e.message,
                 ts_rank_cd(e.search_tsv, v_tsq)
            from catalog.session_events e
           where v_fts and p_session is null and e.search_tsv @@ v_tsq
          -- Full text, one session.
          union all
          select c.session_id, 'transcript', c.bucket::text, c.bucket, c.start_sec, c.speaker,
                 c.text, ts_rank_cd(c.search_tsv, v_tsq)
            from catalog.session_transcript_chunks c
           where v_fts and c.session_id = p_session and c.search_tsv @@ v_tsq
          union all
          select t.session_id, 'topic', t.id, t.ordinal, null, '', t.summary,
                 ts_rank_cd(t.search_tsv, v_tsq)
            from catalog.session_topics t
           where v_fts and t.session_id = p_session and t.search_tsv @@ v_tsq
          union all
          select e.session_id, 'event', e.id, null, null, '', e.message,
                 ts_rank_cd(e.search_tsv, v_tsq)
            from catalog.session_events e
           where v_fts and e.session_id = p_session and e.search_tsv @@ v_tsq
          -- Phrase, every session: whole words, at most 2,000 accessible candidates per source.
          union all
          select * from (
            select c.session_id, 'transcript'::text, c.bucket::text, c.bucket, c.start_sec,
                   c.speaker, c.text, 0::real
              from catalog.session_transcript_chunks c
             where v_phrase is not null and p_session is null
               and catalog.search_phrase_norm(c.text) like v_pin
               and ' ' || catalog.search_phrase_norm(c.text) || ' ' like v_pword
               and exists (select 1 from catalog.sessions s
                            where s.id = c.session_id and s.ui_hidden = 0
                              and s.show_id = any(v_access_shows))
             limit 2000) pc
          union all
          select * from (
            select t.session_id, 'topic'::text, t.id, t.ordinal, null::float8, ''::text,
                   t.summary, 0::real
              from catalog.session_topics t
             where v_phrase is not null and p_session is null
               and catalog.search_phrase_norm(t.summary) like v_pin
               and ' ' || catalog.search_phrase_norm(t.summary) || ' ' like v_pword
               and exists (select 1 from catalog.sessions s
                            where s.id = t.session_id and s.ui_hidden = 0
                              and s.show_id = any(v_access_shows))
             limit 2000) pt
          union all
          select * from (
            select e.session_id, 'event'::text, e.id, null::bigint, null::float8, ''::text,
                   e.message, 0::real
              from catalog.session_events e
             where v_phrase is not null and p_session is null
               and catalog.search_phrase_norm(e.message) like v_pin
               and ' ' || catalog.search_phrase_norm(e.message) || ' ' like v_pword
               and exists (select 1 from catalog.sessions s
                            where s.id = e.session_id and s.ui_hidden = 0
                              and s.show_id = any(v_access_shows))
             limit 2000) pe
          -- Phrase, one session.
          union all
          select * from (
            select c.session_id, 'transcript'::text, c.bucket::text, c.bucket, c.start_sec,
                   c.speaker, c.text, 0::real
              from catalog.session_transcript_chunks c
             where v_phrase is not null and c.session_id = p_session
               and ' ' || catalog.search_phrase_norm(c.text) || ' ' like v_pword
               and exists (select 1 from catalog.sessions s
                            where s.id = c.session_id and s.ui_hidden = 0
                              and s.show_id = any(v_access_shows))
             limit 2000) sc
          union all
          select * from (
            select t.session_id, 'topic'::text, t.id, t.ordinal, null::float8, ''::text,
                   t.summary, 0::real
              from catalog.session_topics t
             where v_phrase is not null and t.session_id = p_session
               and ' ' || catalog.search_phrase_norm(t.summary) || ' ' like v_pword
               and exists (select 1 from catalog.sessions s
                            where s.id = t.session_id and s.ui_hidden = 0
                              and s.show_id = any(v_access_shows))
             limit 2000) st
          union all
          select * from (
            select e.session_id, 'event'::text, e.id, null::bigint, null::float8, ''::text,
                   e.message, 0::real
              from catalog.session_events e
             where v_phrase is not null and e.session_id = p_session
               and ' ' || catalog.search_phrase_norm(e.message) || ' ' like v_pword
               and exists (select 1 from catalog.sessions s
                            where s.id = e.session_id and s.ui_hidden = 0
                              and s.show_id = any(v_access_shows))
             limit 2000) se
        ),
        j as (
          select h.*, s.title as session_title, s.show_id, s.started_at_utc,
                 row_number() over (partition by h.session_id
                                    order by h.rank desc, h.kind,
                                             case when v_phrase is not null then h.ord end, h.id) as rn,
                 count(*) over (partition by h.session_id) as total
            from h
            join catalog.sessions s on s.id = h.session_id
            join catalog.shows sh on sh.id = s.show_id
           where s.ui_hidden = 0
             and s.show_id = any(v_access_shows)
             and (p_studio is null or sh.studio_id = p_studio)
             and (p_show is null or s.show_id = p_show)
        ),
        top as (
          select j.*,
                 row_number() over (order by j.rank desc, j.started_at_utc desc, j.session_id,
                                             j.kind, case when v_phrase is not null then j.ord end,
                                             j.id) as pos
            from j
           where p_session is not null or j.rn <= 3
           order by pos
           limit v_lim
        )
        select coalesce((select jsonb_agg(jsonb_build_object(
                            'session_id', r.session_id, 'session_title', r.session_title,
                            'show_id', r.show_id, 'kind', r.kind, 'id', r.id, 'sec', r.sec,
                            'speaker', r.speaker,
                            'snippet', case when v_fts
                                            then ts_headline('catalog.search_english'::regconfig,
                                                             translate(r.body, v_sentinels, ''),
                                                             v_tsq, v_opts)
                                            else translate(r.body, v_sentinels, '') end)
                          order by r.pos)
                           from top r), '[]'::jsonb),
               coalesce((select jsonb_agg(jsonb_build_object('session_id', g.session_id,
                                                             'total', least(g.total, 1000))
                                          order by g.first)
                           from (select r.session_id, max(r.total) as total, min(r.pos) as first
                                   from top r group by r.session_id) g), '[]'::jsonb)
          into v_moments, v_moment_sessions;
      end if;

      -- Fallback snippets (D11.2): the forged-sentinel-free text split on whitespace into tokens;
      -- each token folded on its own, keeping which token every folded word came from; the
      -- sentinels around the original tokens that cover the phrase; 12 tokens on each side.
      if v_phrase is not null then
        for v_i in 0 .. jsonb_array_length(v_moments) - 1 loop
          select coalesce(array_agg(x.tok order by x.n), '{}') into v_toks
            from regexp_split_to_table((v_moments -> v_i ->> 'snippet') collate "und-x-icu", '\s+')
                 with ordinality as x(tok, n)
           where x.tok <> '';
          v_fw := '{}';
          v_own := '{}';
          for v_t in 1 .. cardinality(v_toks) loop
            foreach v_w in array string_to_array(catalog.search_phrase_norm(v_toks[v_t]), ' ') loop
              v_fw := v_fw || v_w;
              v_own := v_own || v_t;
            end loop;
          end loop;
          v_at := null;
          for v_k in 1 .. cardinality(v_fw) - cardinality(v_pwords) + 1 loop
            if v_fw[v_k:v_k + cardinality(v_pwords) - 1] = v_pwords then
              v_at := v_k;
              exit;
            end if;
          end loop;
          if v_at is null then
            -- The phrase spans tokens differently than in the whole text: no highlight.
            v_snip := array_to_string(v_toks[1:24], ' ');
          else
            v_a := v_own[v_at];
            v_z := v_own[v_at + cardinality(v_pwords) - 1];
            v_toks[v_a] := pg_catalog.chr(57344) || v_toks[v_a];
            v_toks[v_z] := v_toks[v_z] || pg_catalog.chr(57345);
            v_snip := array_to_string(
              v_toks[greatest(1, v_a - 12):least(cardinality(v_toks), v_z + 12)], ' ');
          end if;
          v_moments := jsonb_set(v_moments, array[v_i::text, 'snippet'], to_jsonb(v_snip));
        end loop;
      end if;

      return jsonb_build_object('q', v_q, 'studios', v_studios, 'shows', v_shows,
                                'sessions', v_sessions, 'moments', v_moments,
                                'moment_sessions', v_moment_sessions);
    end
  $$;

-- Function privileges (design D2, D11.3): a new function is executable by PUBLIC until revoked.
revoke all on function catalog.search(text, text, text, integer, text) from public;
grant execute on function catalog.search(text, text, text, integer, text) to catalog_user;
