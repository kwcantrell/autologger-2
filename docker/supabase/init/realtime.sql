-- Verbatim from supabase/supabase master docker/volumes/db/realtime.sql (2026-09-30).
\set pguser `echo "$POSTGRES_USER"`

create schema if not exists _realtime;
alter schema _realtime owner to :pguser;
