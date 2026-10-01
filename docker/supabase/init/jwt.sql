-- Verbatim from supabase/supabase master docker/volumes/db/jwt.sql (2026-09-30).
\set jwt_exp `echo "$JWT_EXP"`

ALTER DATABASE postgres SET "app.settings.jwt_exp" TO :'jwt_exp';
