// catalog-policies design D10: the fixture the helper and policy tests share. Seeded as
// `catalog_system` on a cloned database (the template's seed teams stay; no actor below is a
// member of them):
// - team T (`team-t`): `owner` (owner), `admin` (admin), `granted` (member, grant on S1),
//   `ungranted` (member);
// - team U (`team-u`): `outsider` (owner); team V (`team-v`): empty, owned by `owner`;
// - shows `s1`, `s2` in T and `su` in U; sessions `ss1` (s1), `ss2` (s2), `ssu` (su);
// - settings rows for T and U; invites in T and U; prefs for `granted` and `outsider`; one kv row.
import type postgres from 'postgres';

export const USERS = ['owner', 'admin', 'granted', 'ungranted', 'outsider'] as const;
export type Actor = (typeof USERS)[number];

export const T = 'team-t';
export const U = 'team-u';
export const V = 'team-v';

const NOW = '2026-10-03T00:00:00Z';

export async function seedPolicyFixture(sys: postgres.Sql): Promise<void> {
  for (const u of USERS) {
    await sys`insert into users (id, google_sub, email, given_name, family_name, created_at_utc)
              values (${u}, ${`${u}-sub`}, ${`${u}@example.com`}, ${u}, 'Fixture', ${NOW})`;
  }
  for (const [id, name] of [
    [T, 'Team T'],
    [U, 'Team U'],
    [V, 'Team V'],
  ]) {
    await sys`insert into studio_definitions (id, display_name, sort_order, created_at_utc)
              values (${id}, ${name}, 10, ${NOW})`;
  }
  for (const [user, team, role] of [
    ['owner', T, 'owner'],
    ['admin', T, 'admin'],
    ['granted', T, 'member'],
    ['ungranted', T, 'member'],
    ['outsider', U, 'owner'],
    ['owner', V, 'owner'],
  ]) {
    await sys`insert into user_studio_memberships (user_id, studio_id, role)
              values (${user}, ${team}, ${role})`;
  }
  for (const [id, team] of [
    ['s1', T],
    ['s2', T],
    ['su', U],
  ]) {
    await sys`insert into shows (id, studio_id, name, show_code, created_at_utc)
              values (${id}, ${team}, ${`Show ${id}`}, ${id.toUpperCase()}, ${NOW})`;
  }
  await sys`insert into show_grants (user_id, show_id, can_write, granted_by_user_id, granted_at_utc)
            values ('granted', 's1', 1, 'owner', ${NOW})`;
  for (const [id, show] of [
    ['ss1', 's1'],
    ['ss2', 's2'],
    ['ssu', 'su'],
  ]) {
    await sys`insert into sessions (id, show_id, title) values (${id}, ${show}, ${`Session ${id}`})`;
  }
  for (const team of [T, U]) {
    await sys`insert into app_settings (key, value) values (${`studio_config:${team}`}, '{}')`;
  }
  await sys`insert into team_invites (studio_id, email_norm, invited_by_user_id, invited_at_utc)
            values (${T}, 'invitee-t@example.com', 'owner', ${NOW}),
                   (${U}, 'invitee-u@example.com', 'outsider', ${NOW})`;
  await sys`insert into user_prefs (user_id, active_studio_id, active_show_id)
            values ('granted', ${T}, 's1'), ('outsider', ${U}, 'su')`;
  await sys`insert into kv (key, value) values ('fixture-kv', 'v')`;
}
