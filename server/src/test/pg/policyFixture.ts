// catalog-policies design D10: the fixture the helper and policy tests share. Seeded as
// `catalog_system` on a cloned database (the template's seed teams stay; no actor below is a
// member of them):
// - team T (`team-t`): `owner` (owner), `admin` (admin), `granted` (member, grant on S1),
//   `ungranted` (member);
// - team U (`team-u`): `outsider` (owner); team V (`team-v`): empty, owned by `owner`;
// - shows `s1`, `s2` in T and `su` in U; sessions `ss1` (s1), `ss2` (s2), `ssu` (su);
// - settings rows for T and U; invites in T and U; prefs for `granted` and `outsider`; one kv row;
// - session-content-policies D12: one content row (id or key `c`) in each of the nine session
//   tables for `ss1` (a session of S1) and `ssu` (a session of U's show).
import type postgres from 'postgres';

export const USERS = ['owner', 'admin', 'granted', 'ungranted', 'outsider'] as const;
export type Actor = (typeof USERS)[number];

export const T = 'team-t';
export const U = 'team-u';
export const V = 'team-v';

const NOW = '2026-10-03T00:00:00Z';

/** session-content-policies D12: an INSERT of one content row, per session table, for session `sid`
 * with row id (or meta key) `id`. `session_transport` is keyed by the session alone. */
export const CONTENT_INSERT: Record<string, (sid: string, id: string) => string> = {
  session_events: (s, id) =>
    `insert into session_events (session_id, id, wall_time_utc, frame_rate, category, message) values ('${s}', '${id}', '${NOW}', 24, 'c', 'm')`,
  session_transport: (s) => `insert into session_transport (session_id) values ('${s}')`,
  session_audio_segments: (s, id) =>
    `insert into session_audio_segments (session_id, id, ordinal, mime_type, r2_key, created_at_utc) values ('${s}', '${id}', 1, 'audio/webm', 'k', '${NOW}')`,
  session_transcript_words: (s, id) =>
    `insert into session_transcript_words (session_id, id, ordinal, created_at_utc) values ('${s}', '${id}', 0, '${NOW}')`,
  session_topics: (s, id) =>
    `insert into session_topics (session_id, id, ordinal, created_at_utc) values ('${s}', '${id}', 0, '${NOW}')`,
  session_transcript_paragraphs: (s, id) =>
    `insert into session_transcript_paragraphs (session_id, id, ordinal, created_at_utc) values ('${s}', '${id}', 0, '${NOW}')`,
  session_transcript_sentiment: (s, id) =>
    `insert into session_transcript_sentiment (session_id, id, ordinal, created_at_utc) values ('${s}', '${id}', 0, '${NOW}')`,
  session_dashboards: (s, id) =>
    `insert into session_dashboards (session_id, id, config_json, created_at_utc, updated_at_utc) values ('${s}', '${id}', '{}', '${NOW}', '${NOW}')`,
  session_meta: (s, id) =>
    `insert into session_meta (session_id, key, value) values ('${s}', '${id}', 'v')`,
};
/** The sessions holding fixture content rows. */
export const CONTENT_SESSIONS = ['ss1', 'ssu'] as const;

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
  for (const insert of Object.values(CONTENT_INSERT)) {
    for (const sid of CONTENT_SESSIONS) await sys.unsafe(insert(sid, 'c'));
  }
}
