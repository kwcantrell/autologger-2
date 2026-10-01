-- Adapted from supabase/supabase master docker/volumes/db/roles.sql (2026-09-30), supabase-services D6:
-- the service roles get SUPABASE_ROLES_PASSWORD, never the superuser password; the pgbouncer and
-- supabase_functions_admin lines are dropped (no pooler, no functions/webhooks here).
\set pgpass `printf %s "$SUPABASE_ROLES_PASSWORD"`

ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
