-- Session tables (ADR 0021 slice 7b-1, OpenSpec change `session-tables`, design D1).
--
-- The nine per-session SQLite tables move into schema `catalog` as a faithful port (catalog-pg-schema
-- style: text COLLATE "C", bigint integers, double precision reals, text timestamps, JSON as text).
-- `events` and `meta` get the `session_` prefix; the others keep their names. Every table gains
-- `session_id`, a foreign key to `catalog.sessions` with no action (sessions are never deleted), and
-- every key and index leads with it. `session_transport` loses its `id = 1` column: one row per
-- session, keyed by `session_id`.
--
-- Row-level security is on with the allow-all `<table>_system_all` policy only. `catalog_user`'s
-- privileges on these tables are revoked (catalog-database "Row-level security is enabled on every
-- catalog table": a table without `catalog_user` policies has its privileges revoked), so a
-- user-bound statement fails with 42501 until slice 7b-2 adds the content policies.
--
-- Start empty (owner, 2026-10-03): no session content is imported (slice 11 imports the legacy
-- files), so the live projection of every existing session resets to match its empty content.
--
-- No transaction-control lines (migrate.sh refuses them).

create table catalog.session_events (
  session_id text collate "C" not null references catalog.sessions (id),
  id text collate "C" not null,
  wall_time_utc text collate "C" not null,
  frame_rate double precision not null,
  timecode_total_frames bigint,
  category text collate "C" not null,
  message text collate "C" not null,
  metadata_json text collate "C" not null default '{}',
  primary key (session_id, id)
);
create index idx_session_events_wall on catalog.session_events (session_id, wall_time_utc, id);

create table catalog.session_transport (
  session_id text collate "C" primary key references catalog.sessions (id),
  is_rolling bigint not null default 0,
  current_take bigint not null default 0,
  roll_started_at_utc text collate "C",
  elapsed_frames bigint not null default 0
);

create table catalog.session_audio_segments (
  session_id text collate "C" not null references catalog.sessions (id),
  id text collate "C" not null,
  ordinal bigint not null,
  started_at_utc text collate "C",
  ended_at_utc text collate "C",
  mime_type text collate "C" not null,
  r2_key text collate "C" not null,
  recording_ordinal bigint,
  waveform_peaks_json text collate "C",
  waveform_db_floor double precision,
  created_at_utc text collate "C" not null,
  primary key (session_id, id)
);
create index idx_session_audio_ordinal on catalog.session_audio_segments (session_id, ordinal);
create index idx_session_audio_r2_key on catalog.session_audio_segments (session_id, r2_key);

create table catalog.session_transcript_words (
  session_id text collate "C" not null references catalog.sessions (id),
  id text collate "C" not null,
  session_time text collate "C" not null default '',
  speaker text collate "C" not null default '',
  word text collate "C" not null default '',
  start_sec double precision not null default 0.0,
  end_sec double precision not null default 0.0,
  ordinal bigint not null,
  created_at_utc text collate "C" not null,
  primary key (session_id, id)
);
create index idx_session_words_ordinal on catalog.session_transcript_words (session_id, ordinal);

create table catalog.session_topics (
  session_id text collate "C" not null references catalog.sessions (id),
  id text collate "C" not null,
  session_time text collate "C" not null default '',
  duration_sec double precision not null default 0,
  topic_level bigint not null default 1,
  summary text collate "C" not null default '',
  ordinal bigint not null,
  created_at_utc text collate "C" not null,
  primary key (session_id, id)
);
create index idx_session_topics_ordinal on catalog.session_topics (session_id, ordinal);

create table catalog.session_transcript_paragraphs (
  session_id text collate "C" not null references catalog.sessions (id),
  id text collate "C" not null,
  start_sec double precision,
  end_sec double precision,
  speaker text collate "C" not null default '',
  text text collate "C" not null default '',
  ordinal bigint not null,
  created_at_utc text collate "C" not null,
  primary key (session_id, id)
);
create index idx_session_paragraphs_ordinal on catalog.session_transcript_paragraphs (session_id, ordinal);

create table catalog.session_transcript_sentiment (
  session_id text collate "C" not null references catalog.sessions (id),
  id text collate "C" not null,
  start_sec double precision,
  end_sec double precision,
  sentiment text collate "C" not null default '',
  sentiment_score double precision not null default 0,
  text text collate "C" not null default '',
  ordinal bigint not null,
  created_at_utc text collate "C" not null,
  primary key (session_id, id)
);
create index idx_session_sentiment_ordinal on catalog.session_transcript_sentiment (session_id, ordinal);

create table catalog.session_dashboards (
  session_id text collate "C" not null references catalog.sessions (id),
  id text collate "C" not null,
  config_json text collate "C" not null,
  created_by text collate "C",
  created_by_turn_id text collate "C",
  created_at_utc text collate "C" not null,
  updated_at_utc text collate "C" not null,
  primary key (session_id, id)
);
create index idx_session_dashboards_created on catalog.session_dashboards (session_id, created_at_utc);

create table catalog.session_meta (
  session_id text collate "C" not null references catalog.sessions (id),
  key text collate "C" not null,
  value text collate "C" not null,
  primary key (session_id, key)
);

-- Row-level security: the system policy only; catalog_user holds no privilege until 7b-2.
do $$
  declare t text;
  begin
    foreach t in array array['session_events', 'session_transport', 'session_audio_segments',
                             'session_transcript_words', 'session_topics',
                             'session_transcript_paragraphs', 'session_transcript_sentiment',
                             'session_dashboards', 'session_meta'] loop
      execute format('alter table catalog.%I enable row level security', t);
      execute format('create policy %I on catalog.%I for all to catalog_system using (true) with check (true)', t || '_system_all', t);
      execute format('revoke all on catalog.%I from catalog_user', t);
    end loop;
  end
$$;

-- Start empty: the live projection matches the (empty) session content.
update catalog.sessions
   set event_count = 0, max_timecode_total_frames = null, is_rolling = 0, current_take = 0,
       transport_elapsed_frames = 0, roll_started_at_utc = null;
