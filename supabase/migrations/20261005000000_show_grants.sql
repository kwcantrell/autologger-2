-- Per-show grants (ADR 0021 slice 6a, show-grants design D1).
--
-- A (user, show) row gives a team member full session access in that show; owners and admins
-- reach every show of their team without one. can_write is a 0/1 flag, always 1 for now.
-- granted_by_user_id has no foreign key, so a grant outlives the admin who made it. Memberships
-- have no foreign key to shows, so the application deletes a member's grants in a team in the
-- same transaction as the membership delete.

create table catalog.show_grants (
  user_id text collate "C" not null references catalog.users (id) on delete cascade,
  show_id text collate "C" not null references catalog.shows (id) on delete cascade,
  can_write bigint not null default 1,
  granted_by_user_id text collate "C",
  granted_at_utc text collate "C" not null,
  primary key (user_id, show_id)
);
create index idx_show_grants_show on catalog.show_grants (show_id);
