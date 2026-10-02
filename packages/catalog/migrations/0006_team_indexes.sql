-- Per-team indexes, kept in step with the Postgres catalog (supabase/migrations/
-- 20261002000000_catalog_team_indexes.sql; catalog-concurrency-hazards D12) until ADR 0021
-- slice 4e retires this schema.
CREATE INDEX IF NOT EXISTS idx_user_studio_memberships_studio ON user_studio_memberships (studio_id);
CREATE INDEX IF NOT EXISTS idx_shows_studio ON shows (studio_id);
