-- Adapted from supabase/supabase master docker/volumes/db/roles.sql (2026-09-30), supabase-services D6:
-- the service roles get SUPABASE_ROLES_PASSWORD, never the superuser password; the pgbouncer and
-- supabase_functions_admin lines are dropped (no pooler, no functions/webhooks here).
-- drop-unused-supabase-services D1: only GoTrue's role logs in; authenticator (PostgREST) and
-- supabase_storage_admin (Storage) keep the image default, no password.
\set pgpass `printf %s "$SUPABASE_ROLES_PASSWORD"`

ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
