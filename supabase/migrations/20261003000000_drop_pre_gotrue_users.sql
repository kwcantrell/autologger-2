-- Drop the users that predate Supabase Auth (ADR 0021 slice 5a, gotrue-sign-in D8).
--
-- From slice 5a a catalog user's id is its Supabase Auth user id, and a sign-in whose id differs
-- is refused, so every earlier user would be locked out. ADR 0021 drops existing users and
-- memberships: deleting users cascades to user_studio_memberships and user_prefs. Pending invites
-- go too (they would grant memberships to re-registered people, and name deleted inviters), and
-- so do login sessions, which would otherwise resolve to no user. Studios, shows, settings and
-- other KV rows stay. Prod's catalog is created at cutover, so there this deletes nothing; the
-- slice 11 import must not bring these rows back.

delete from catalog.team_invites;
delete from catalog.users;
delete from catalog.kv where key like 'session:%';
