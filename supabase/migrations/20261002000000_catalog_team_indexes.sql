-- Per-team indexes (ADR 0021 slice 4d, catalog-concurrency-hazards D12).
--
-- Team-scoped statements filter by studio_id. Without an index led by studio_id they scan the
-- whole table, and under SERIALIZABLE a scan takes a predicate lock on all of it, so writes in
-- unrelated teams abort each other. team_invites is already keyed (studio_id, email_norm).

create index idx_user_studio_memberships_studio on catalog.user_studio_memberships (studio_id);
create index idx_shows_studio on catalog.shows (studio_id);
