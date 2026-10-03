// catalog-policies design D2, D3, D10: the catalog_user policies and narrowed privileges of
// `20261007000000_catalog_policies.sql`. The allow/deny matrix is generated from the
// catalog-database rule table ("User policies enforce the team permission model") applied to the
// fixture's memberships, shows and grants — not from the policies — so a policy typo fails it.
// Each case runs in its own transaction as `catalog_user` with the actor's id (or none) and rolls
// back, so cases don't interact.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../test/pg/testDb';
import { seedPolicyFixture, T, U, V } from './policyFixture';

// -- the fixture's facts (policyFixture.ts) -------------------------------------------------------

const MEMBERSHIPS: [user: string, team: string, role: string][] = [
  ['owner', T, 'owner'],
  ['admin', T, 'admin'],
  ['granted', T, 'member'],
  ['ungranted', T, 'member'],
  ['outsider', U, 'owner'],
  ['owner', V, 'owner'],
];
const SHOWS: Record<string, string> = { s1: T, s2: T, su: U };
const SESSIONS: Record<string, string> = { ss1: 's1', ss2: 's2', ssu: 'su' };
const GRANTS: [user: string, show: string][] = [['granted', 's1']];
const SETTINGS = [T, U];
const INVITES: [team: string, email: string][] = [
  [T, 'invitee-t@example.com'],
  [U, 'invitee-u@example.com'],
];
const PREFS = ['granted', 'outsider'];
const USER_IDS = ['owner', 'admin', 'granted', 'ungranted', 'outsider'];
const TEAMS = [T, U, V];

const ACTORS = ['owner', 'admin', 'granted', 'ungranted', 'outsider', null] as const;
type Actor = (typeof ACTORS)[number];
const label = (a: Actor) => a ?? 'no user id';

// -- the rule table, as functions of the actor ----------------------------------------------------

const memberTeams = (a: Actor) => MEMBERSHIPS.filter(([u]) => u === a).map(([, t]) => t);
const managedTeams = (a: Actor) =>
  MEMBERSHIPS.filter(([u, , r]) => u === a && (r === 'owner' || r === 'admin')).map(([, t]) => t);
const memberShows = (a: Actor) =>
  Object.keys(SHOWS).filter((s) => memberTeams(a).includes(SHOWS[s] as string));
const accessibleShows = (a: Actor) =>
  memberShows(a).filter(
    (s) =>
      managedTeams(a).includes(SHOWS[s] as string) ||
      GRANTS.some(([u, g]) => u === a && g === s),
  );
const coMembers = (a: Actor) =>
  USER_IDS.filter(
    (u) => u === a || MEMBERSHIPS.some(([m, t]) => m === u && memberTeams(a).includes(t)),
  );

type Rule = (a: Actor, key: string) => boolean;
const REFUSED = 'refused' as const; // no privilege: 42501 before any policy
const NONE: Rule = () => false; // no policy: no row

interface TableRules {
  /** The row key expression, so ids from different tables read alike. */
  key: string;
  /** A no-op SET for the UPDATE cases (the new row equals the old). */
  set: string;
  /** Every fixture row's key. */
  rows: string[];
  read: Rule | typeof REFUSED;
  insert: Rule | typeof REFUSED;
  update: Rule | typeof REFUSED;
  delete: Rule | typeof REFUSED;
  /** Write targets: a row of T, a row of U and one of the actor's own (deduplicated). */
  targets: (a: Actor) => string[];
  /** An INSERT of a new row in the target's team (same key space as `targets`). */
  insertSql: (target: string) => string;
  /** Insert targets: a new row in T, in U and one of the actor's own. */
  insertTargets: (a: Actor) => string[];
}

const teamOfShowKey = (s: string) => SHOWS[s] as string;
const ownTeam = (a: Actor) => memberTeams(a)[0] ?? T;
const uniq = (xs: string[]) => [...new Set(xs)];

const RULES: Record<string, TableRules> = {
  users: {
    key: 'id',
    set: 'given_name = given_name',
    rows: USER_IDS,
    read: (a, id) => a !== null && coMembers(a).includes(id),
    insert: REFUSED,
    update: (a, id) => a !== null && id === a,
    delete: REFUSED,
    targets: (a) => uniq(['ungranted', 'outsider', ...(a ? [a] : [])]),
    insertSql: (id) =>
      `insert into users (id, google_sub, email, created_at_utc) values ('${id}', '${id}-sub', '${id}@example.com', 'now')`,
    insertTargets: () => ['new-user'],
  },
  user_studio_memberships: {
    key: "user_id || '@' || studio_id",
    set: 'role = role',
    rows: MEMBERSHIPS.map(([u, t]) => `${u}@${t}`),
    read: (a, k) => memberTeams(a).includes(k.split('@')[1] as string),
    insert: REFUSED,
    update: (a, k) => memberTeams(a).includes(k.split('@')[1] as string),
    delete: (a, k) => memberTeams(a).includes(k.split('@')[1] as string),
    targets: (a) => uniq([`ungranted@${T}`, `outsider@${U}`, ...(a ? [`${a}@${ownTeam(a)}`] : [])]),
    insertSql: (k) => {
      const [u, t] = k.split('@');
      return `insert into user_studio_memberships (user_id, studio_id, role) values ('${u}', '${t}', 'member')`;
    },
    // The owner of T adding a member to T is refused too (owner decision B).
    insertTargets: () => [`outsider@${T}`, `ungranted@${U}`, `granted@${V}`],
  },
  user_prefs: {
    key: 'user_id',
    set: 'active_show_id = active_show_id',
    rows: PREFS,
    read: (a, u) => u === a,
    insert: (a, u) => u === a,
    update: (a, u) => u === a,
    delete: (a, u) => u === a,
    targets: (a) => uniq(['granted', 'outsider', ...(a ? [a] : [])]),
    insertSql: (u) =>
      `insert into user_prefs (user_id) values ('${u}') on conflict (user_id) do nothing`,
    insertTargets: (a) => uniq(['ungranted', 'outsider', ...(a ? [a] : [])]),
  },
  studio_definitions: {
    key: 'id',
    set: 'display_name = display_name',
    rows: TEAMS,
    read: (a, id) => memberTeams(a).includes(id),
    insert: NONE,
    update: (a, id) => memberTeams(a).includes(id),
    delete: (a, id) => memberTeams(a).includes(id),
    targets: () => [T, U, V],
    insertSql: (id) =>
      `insert into studio_definitions (id, display_name, created_at_utc) values ('${id}', 'New', 'now')`,
    insertTargets: () => ['team-new'],
  },
  shows: {
    key: 'id',
    set: 'name = name',
    rows: Object.keys(SHOWS),
    read: (a, s) => memberTeams(a).includes(teamOfShowKey(s)),
    insert: (a, k) => managedTeams(a).includes(k.split(':')[1] as string),
    update: (a, s) => managedTeams(a).includes(teamOfShowKey(s)),
    delete: NONE,
    targets: () => ['s1', 'su', 's2'],
    insertSql: (k) =>
      `insert into shows (id, studio_id, name, show_code, created_at_utc) values ('new-show', '${k.split(':')[1]}', 'N', 'N', 'now')`,
    insertTargets: () => [`show:${T}`, `show:${U}`, `show:${V}`],
  },
  sessions: {
    key: 'id',
    set: 'title = title',
    rows: Object.keys(SESSIONS),
    read: (a, ss) => memberShows(a).includes(SESSIONS[ss] as string),
    insert: (a, k) => accessibleShows(a).includes(k.split(':')[1] as string),
    update: (a, ss) => accessibleShows(a).includes(SESSIONS[ss] as string),
    delete: NONE,
    targets: () => ['ss1', 'ss2', 'ssu'],
    insertSql: (k) => `insert into sessions (id, show_id) values ('new-session', '${k.split(':')[1]}')`,
    insertTargets: () => ['session:s1', 'session:s2', 'session:su'],
  },
  app_settings: {
    key: 'key',
    set: 'value = value',
    rows: SETTINGS.map((t) => `studio_config:${t}`),
    read: (a, k) => memberTeams(a).some((t) => k === `studio_config:${t}`),
    insert: (a, k) => managedTeams(a).some((t) => k === `studio_config:${t}`),
    update: (a, k) => managedTeams(a).some((t) => k === `studio_config:${t}`),
    delete: (a, k) => managedTeams(a).some((t) => k === `studio_config:${t}`),
    targets: () => [`studio_config:${T}`, `studio_config:${U}`],
    insertSql: (k) =>
      `insert into app_settings (key, value) values ('${k}', '{}') on conflict (key) do nothing`,
    insertTargets: () => [`studio_config:${T}`, `studio_config:${U}`, `studio_config:${V}`],
  },
  team_invites: {
    key: "studio_id || '/' || email_norm",
    set: 'invited_at_utc = invited_at_utc',
    rows: INVITES.map(([t, e]) => `${t}/${e}`),
    read: (a, k) => memberTeams(a).includes(k.split('/')[0] as string),
    insert: REFUSED,
    update: (a, k) => memberTeams(a).includes(k.split('/')[0] as string),
    delete: (a, k) => memberTeams(a).includes(k.split('/')[0] as string),
    targets: () => INVITES.map(([t, e]) => `${t}/${e}`),
    insertSql: (t) =>
      `insert into team_invites (studio_id, email_norm, invited_by_user_id, invited_at_utc) values ('${t}', 'new@example.com', 'owner', 'now')`,
    insertTargets: () => [T, U, V],
  },
  show_grants: {
    key: "user_id || '>' || show_id",
    set: 'can_write = can_write',
    rows: GRANTS.map(([u, s]) => `${u}>${s}`),
    read: (a, k) => memberShows(a).includes(k.split('>')[1] as string),
    insert: (a, k) => memberShows(a).includes(k.split('>')[1] as string),
    update: (a, k) => memberShows(a).includes(k.split('>')[1] as string),
    delete: (a, k) => memberShows(a).includes(k.split('>')[1] as string),
    targets: () => ['granted>s1'],
    insertSql: (k) => {
      const [u, s] = k.split('>');
      return `insert into show_grants (user_id, show_id, granted_at_utc) values ('${u}', '${s}', 'now')`;
    },
    insertTargets: () => ['ungranted>s2', 'outsider>su'],
  },
  kv: {
    key: 'key',
    set: 'value = value',
    rows: ['fixture-kv'],
    read: REFUSED,
    insert: REFUSED,
    update: REFUSED,
    delete: REFUSED,
    targets: () => ['fixture-kv'],
    insertSql: () => `insert into kv (key, value) values ('new-kv', 'v')`,
    insertTargets: () => ['new-kv'],
  },
};

// -- running statements as an actor ---------------------------------------------------------------

let db: TestDatabase;
let sql: postgres.Sql;
let admin: postgres.Sql;
beforeAll(async () => {
  db = await createTestDatabase();
  const sys = postgres({ ...db.system, max: 1, onnotice: () => {} });
  try {
    await seedPolicyFixture(sys);
  } finally {
    await sys.end();
  }
  sql = postgres({ ...db.app, max: 1, onnotice: () => {} });
  admin = postgres({ ...db.admin, max: 1, onnotice: () => {} });
});
afterAll(async () => {
  await sql?.end();
  await admin?.end();
});

class Rollback extends Error {}
type Outcome = { rows: Record<string, unknown>[] } | { code: string };

/** Run `stmts` in one transaction as `role` with the actor's id, then roll back. The outcome is
 * the last statement's rows, or the first error's code. */
async function as(actor: Actor, stmts: string[], role = 'catalog_user'): Promise<Outcome> {
  let out!: Outcome;
  await sql
    .begin(async (tx) => {
      await tx`select set_config('role', ${role}, true), set_config('app.user_id', ${actor ?? ''}, true)`;
      for (const s of stmts) {
        try {
          out = { rows: [...(await tx.unsafe(s))] };
        } catch (e) {
          out = { code: String((e as { code?: unknown }).code) };
          break;
        }
      }
      throw new Rollback();
    })
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
  return out;
}

const keysOf = (o: Outcome) =>
  'code' in o ? o : { keys: o.rows.map((r) => String(r.k)).sort() };
const countOf = (o: Outcome) => ('code' in o ? o : { count: o.rows.length });
const inList = (keys: string[]) => keys.map((k) => `'${k.replaceAll("'", "''")}'`).join(', ');

// -- the allow/deny matrix ------------------------------------------------------------------------

describe('the allow/deny matrix (catalog-database "User policies enforce the team permission model")', () => {
  for (const [table, r] of Object.entries(RULES)) {
    it(`${table}: select, insert, update and delete for each actor`, async () => {
      for (const actor of ACTORS) {
        const who = `${table} as ${label(actor)}`;
        // SELECT: exactly the rows the read rule allows (every fixture or template row).
        const sel = await as(actor, [`select ${r.key} as k from ${table}`]);
        expect(keysOf(sel), `select ${who}`).toEqual(
          r.read === REFUSED
            ? { code: '42501' }
            : { keys: r.rows.filter((k) => (r.read as Rule)(actor, k)).sort() },
        );
        // INSERT: one new row at a time.
        for (const target of r.insertTargets(actor)) {
          const ins = await as(actor, [r.insertSql(target)]);
          const allowed = r.insert !== REFUSED && r.insert(actor, target);
          expect('code' in ins ? ins.code : 'ok', `insert ${target} into ${who}`).toBe(
            allowed ? 'ok' : '42501',
          );
        }
        // UPDATE and DELETE: a row of T, a row of U and one of the actor's own.
        const targets = r.targets(actor);
        for (const [cmd, rule, stmt] of [
          ['update', r.update, `update ${table} set ${r.set} where ${r.key} in (${inList(targets)}) returning 1`],
          ['delete', r.delete, `delete from ${table} where ${r.key} in (${inList(targets)}) returning 1`],
        ] as const) {
          const res = await as(actor, [stmt]);
          expect(countOf(res), `${cmd} ${who} on ${targets.join(',')}`).toEqual(
            rule === REFUSED
              ? { code: '42501' }
              : { count: targets.filter((k) => r.rows.includes(k) && rule(actor, k)).length },
          );
        }
      }
    });
  }

  it('an update whose new row leaves the rule fails with 42501', async () => {
    expect(await as('admin', [`update shows set studio_id = '${U}' where id = 's1'`])).toEqual({
      code: '42501',
    });
    expect(await as('owner', [`update sessions set show_id = 'su' where id = 'ss1'`])).toEqual({
      code: '42501',
    });
    expect(
      await as('ungranted', [`update user_studio_memberships set studio_id = '${U}' where user_id = 'ungranted'`]),
    ).toEqual({ code: '42501' });
  });

  it('a member reads the sessions of an ungranted show but cannot change them', async () => {
    expect(keysOf(await as('ungranted', [`select id as k from sessions where show_id = 's1'`]))).toEqual({
      keys: ['ss1'],
    });
    expect(
      countOf(await as('ungranted', [`update sessions set title = 'x' where id = 'ss1' returning 1`])),
    ).toEqual({ count: 0 });
  });
});

// -- privileges (design D2) -----------------------------------------------------------------------

describe("catalog_user's narrowed privileges (design D2)", () => {
  it("own users row: the name columns update; other columns, insert and delete are refused", async () => {
    expect(
      countOf(
        await as('granted', [
          `update users set given_name = 'G', family_name = 'F' where id = 'granted' returning 1`,
        ]),
      ),
    ).toEqual({ count: 1 });
    for (const col of ['email', 'google_sub', 'picture_url', 'disabled_at_utc']) {
      expect(
        await as('granted', [`update users set ${col} = 'x' where id = 'granted'`]),
        col,
      ).toEqual({ code: '42501' });
    }
    expect(
      await as('granted', [
        `insert into users (id, google_sub, email, created_at_utc) values ('n', 'n', 'n', 'now')`,
      ]),
    ).toEqual({ code: '42501' });
    expect(await as('granted', [`delete from users where id = 'granted'`])).toEqual({
      code: '42501',
    });
  });

  it('inserts into memberships and invites are refused for every actor, the owner of the team included', async () => {
    for (const actor of ACTORS) {
      expect(
        await as(actor, [
          `insert into user_studio_memberships (user_id, studio_id) values ('outsider', '${T}')`,
        ]),
        label(actor),
      ).toEqual({ code: '42501' });
      expect(
        await as(actor, [
          `insert into team_invites (studio_id, email_norm, invited_by_user_id, invited_at_utc) values ('${T}', 'x@example.com', 'owner', 'now')`,
        ]),
        label(actor),
      ).toEqual({ code: '42501' });
    }
  });

  it('a member raising their own membership to owner fails on the one-owner index; to admin succeeds', async () => {
    expect(
      await as('ungranted', [
        `update user_studio_memberships set role = 'owner' where user_id = 'ungranted' and studio_id = '${T}'`,
      ]),
    ).toEqual({ code: '23505' });
    // The recorded within-team escalation (design Risks): the app's in-transaction gates hold it.
    expect(
      countOf(
        await as('ungranted', [
          `update user_studio_memberships set role = 'admin' where user_id = 'ungranted' and studio_id = '${T}' returning 1`,
        ]),
      ),
    ).toEqual({ count: 1 });
  });

  it('kv is refused to catalog_user on all four commands and allowed to catalog_system', async () => {
    const stmts = [
      'select count(*) from kv',
      `insert into kv (key, value) values ('k2', 'v')`,
      `update kv set value = value`,
      'delete from kv',
    ];
    for (const s of stmts) {
      expect(await as('owner', [s]), s).toEqual({ code: '42501' });
      expect('rows' in (await as(null, [s], 'catalog_system')), `${s} as system`).toBe(true);
    }
  });
});

// -- locked reads and the multi-step writes (design D3, D5) --------------------------------------

describe('locked reads and multi-step writes (design D3, D5)', () => {
  const share = (where: string, table = 'user_studio_memberships') =>
    `select 1 as k from ${table} where ${where} for share`;

  it('FOR SHARE works on own and target membership rows and an own grant; a non-member gets none', async () => {
    const own = share(`user_id = 'ungranted' and studio_id = '${T}'`);
    const target = share(`user_id = 'admin' and studio_id = '${T}'`);
    const grant = share(`user_id = 'granted' and show_id = 's1'`, 'show_grants');
    expect(countOf(await as('ungranted', [own]))).toEqual({ count: 1 });
    expect(countOf(await as('ungranted', [target]))).toEqual({ count: 1 });
    expect(countOf(await as('granted', [grant]))).toEqual({ count: 1 });
    for (const s of [own, target, grant]) {
      expect(countOf(await as('outsider', [s])), s).toEqual({ count: 0 });
    }
  });

  it('the transfer demotes the owner and promotes an admin', async () => {
    const res = await as('owner', [
      `update user_studio_memberships set role = 'admin' where studio_id = '${T}' and user_id = 'owner' and role = 'owner'`,
      `update user_studio_memberships set role = 'owner' where studio_id = '${T}' and user_id = 'admin'`,
      `select user_id || ':' || role as k from user_studio_memberships where studio_id = '${T}' and role in ('owner', 'admin')`,
    ]);
    expect(keysOf(res)).toEqual({ keys: ['admin:owner', 'owner:admin'] });
  });

  const counted = (s: string) => `with d as (${s} returning 1) select count(*)::int as k from d`;

  it('the team delete in the D5 order removes every row of the team', async () => {
    const res = await as('owner', [
      `insert into app_settings (key, value) values ('studio_config:${V}', '{}')`,
      counted(`delete from team_invites where studio_id = '${V}'`),
      counted(`delete from studio_definitions where id = '${V}'`),
      counted(`delete from app_settings where key = 'studio_config:${V}'`),
      counted(`delete from user_studio_memberships where studio_id = '${V}'`),
      `select (select count(*) from studio_definitions where id = '${V}')
            + (select count(*) from app_settings where key = 'studio_config:${V}')
            + (select count(*) from user_studio_memberships where studio_id = '${V}') as k`,
    ]);
    expect(keysOf(res)).toEqual({ keys: ['0'] });
    // Each delete affected its row (checked one by one).
    for (const [stmt, n] of [
      [counted(`delete from studio_definitions where id = '${V}'`), '1'],
      [counted(`delete from user_studio_memberships where studio_id = '${V}'`), '1'],
    ] as const) {
      expect(keysOf(await as('owner', [stmt])), stmt).toEqual({ keys: [n] });
    }
  });

  it('the old order (memberships first) leaves the definition behind', async () => {
    const res = await as('owner', [
      counted(`delete from user_studio_memberships where studio_id = '${V}'`),
      counted(`delete from studio_definitions where id = '${V}'`),
    ]);
    expect(keysOf(res)).toEqual({ keys: ['0'] });
  });

  it("a leave deletes the member's grants in the team, then the membership", async () => {
    const res = await as('granted', [
      counted(
        `delete from show_grants g using shows s where g.show_id = s.id and s.studio_id = '${T}' and g.user_id = 'granted'`,
      ),
      counted(`delete from user_studio_memberships where user_id = 'granted' and studio_id = '${T}'`),
    ]);
    expect(keysOf(res)).toEqual({ keys: ['1'] });
    expect(
      keysOf(
        await as('granted', [
          counted(
            `delete from show_grants g using shows s where g.show_id = s.id and s.studio_id = '${T}' and g.user_id = 'granted'`,
          ),
        ]),
      ),
    ).toEqual({ keys: ['1'] });
  });
});

// -- the policy catalog ---------------------------------------------------------------------------

describe('the catalog_user policies as installed', () => {
  it('no catalog_user policy is the constant true, and there are 23', async () => {
    const rows = await admin`select tablename, policyname, qual, with_check from pg_policies
                             where schemaname = 'catalog' and 'catalog_user' = any(roles)`;
    expect(rows).toHaveLength(23);
    for (const p of rows) {
      expect(p.qual, `${p.policyname} using`).not.toBe('true');
      expect(p.with_check, `${p.policyname} with check`).not.toBe('true');
    }
  });

  it('every table except kv has a catalog_user policy, and every table a catalog_system one', async () => {
    for (const table of Object.keys(RULES)) {
      const rows = await admin`select roles::text[] as roles from pg_policies
                               where schemaname = 'catalog' and tablename = ${table}`;
      const roles = rows.flatMap((r) => r.roles as string[]);
      expect(roles.includes('catalog_user'), table).toBe(table !== 'kv');
      expect(roles.includes('catalog_system'), table).toBe(true);
    }
  });
});
