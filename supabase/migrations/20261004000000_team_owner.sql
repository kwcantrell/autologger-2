-- Team owners and the seed teams (ADR 0021 slice 5c, owner-bootstrap design D1).
--
-- Roles are owner, admin and member. The database allows at most one owner per team; the
-- application keeps "at least one" (creation inserts the owner, transfer and the support owner
-- upsert demote and promote in one transaction). No statement assigns an owner: the bootstrap
-- owner claims ownerless teams at sign-in.
--
-- The former built-in studios become studio_definitions rows with the same ids and names, sorted
-- before self-serve teams (sort_order 1000), so their shows, sessions and settings survive. The
-- global active team and show settings are retired with them.

alter table catalog.user_studio_memberships
  add constraint user_studio_memberships_role_check check (role in ('owner', 'admin', 'member'));
create unique index idx_user_studio_memberships_one_owner
  on catalog.user_studio_memberships (studio_id) where role = 'owner';
insert into catalog.studio_definitions (id, display_name, sort_order, created_at_utc) values
  ('test-studios', 'Test Studio', 0, '2024-01-01T00:00:00Z'),
  ('test-studio-2', 'Test Studio 2', 1, '2024-01-01T00:00:00Z')
on conflict (id) do nothing;
delete from catalog.app_settings where key in ('active_studio_id', 'active_show_id');
