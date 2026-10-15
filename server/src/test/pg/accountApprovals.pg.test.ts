// closed-signups design D2: `catalog.account_approvals` and the operator functions
// `catalog.approve_account(email, note)` and `catalog.revoke_account_approval(email)` from
// `20261024000000_account_approvals.sql`. The table is system-only, like kv, and written only by
// `postgres`: catalog_user holds no privilege, catalog_system only select and delete, and no app
// role may run the functions.

import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { type ConnOptions, createTestDatabase } from '../../../../test/pg/testDb';

const ISO_MS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const APPROVE = 'catalog.approve_account(text,text)';
const REVOKE = 'catalog.revoke_account_approval(text)';

const open: postgres.Sql[] = [];
function connect(o: ConnOptions): postgres.Sql {
  const sql = postgres({ ...o, max: 1, onnotice: () => {} });
  open.push(sql);
  return sql;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.end()));
});

/** The SQLSTATE `stmt` fails with, or 'ok'. */
function code(sql: postgres.Sql, stmt: string, params: postgres.ParameterOrJSON<never>[] = []) {
  return sql.unsafe(stmt, params).then(
    () => 'ok',
    (e: { code?: unknown }) => String(e.code),
  );
}

async function rows(sql: postgres.Sql) {
  const r = await sql`select email_norm, approved_at_utc, note from catalog.account_approvals
                      order by email_norm`;
  return r.map((x) => ({ ...x }));
}

describe('approving an email (catalog-database "Account approvals are stored in the catalog")', () => {
  it('normalizes the email, writes the row and stamps approved_at_utc in the server format', async () => {
    const db = await createTestDatabase();
    const admin = connect(db.admin);
    const [r] = await admin`select catalog.approve_account('  Someone@Example.COM ') as e`;
    expect(r?.e).toBe('someone@example.com');
    const all = await rows(admin);
    expect(all).toHaveLength(1);
    expect(all[0]?.email_norm).toBe('someone@example.com');
    expect(all[0]?.note).toBeNull();
    expect(all[0]?.approved_at_utc).toMatch(ISO_MS);
    // The same instant as Date.toISOString(), give or take the round trip.
    const at = Date.parse(String(all[0]?.approved_at_utc));
    expect(Math.abs(at - Date.now())).toBeLessThan(60_000);
  });

  it('approving again keeps one row with the new note and a later approved_at_utc', async () => {
    const db = await createTestDatabase();
    const admin = connect(db.admin);
    await admin`select catalog.approve_account('someone@example.com', 'first')`;
    const [before] = await rows(admin);
    await new Promise((r) => setTimeout(r, 20));
    const [r] = await admin`select catalog.approve_account('SOMEONE@example.com', 'second') as e`;
    expect(r?.e).toBe('someone@example.com');
    const after = await rows(admin);
    expect(after).toHaveLength(1);
    expect(after[0]?.note).toBe('second');
    expect(String(after[0]?.approved_at_utc) > String(before?.approved_at_utc)).toBe(true);
  });

  it('stores a blank note as null', async () => {
    const db = await createTestDatabase();
    const admin = connect(db.admin);
    await admin`select catalog.approve_account('a@example.com', '')`;
    await admin`select catalog.approve_account('b@example.com', '   ')`;
    await admin`select catalog.approve_account('c@example.com', null)`;
    await admin`select catalog.approve_account('d@example.com', 'for X')`;
    expect((await rows(admin)).map((x) => [x.email_norm, x.note])).toEqual([
      ['a@example.com', null],
      ['b@example.com', null],
      ['c@example.com', null],
      ['d@example.com', 'for X'],
    ]);
  });

  it('refuses a malformed or non-ASCII email with 22023 and writes nothing', async () => {
    const db = await createTestDatabase();
    const admin = connect(db.admin);
    for (const email of [
      'no-at-sign',
      'a b@example.com',
      'ké@example.com',
      '',
      '   ',
      '@x',
      'x@',
    ]) {
      expect(await code(admin, 'select catalog.approve_account($1)', [email]), email).toBe('22023');
    }
    expect(await code(admin, 'select catalog.approve_account(null)')).toBe('22023');
    expect(await rows(admin)).toEqual([]);
  });

  it('the table refuses a direct insert of an unnormalized email (23514)', async () => {
    const db = await createTestDatabase();
    const admin = connect(db.admin);
    const insert = (email: string) =>
      code(
        admin,
        `insert into catalog.account_approvals (email_norm, approved_at_utc)
         values ($1, '2026-10-15T00:00:00.000Z')`,
        [email],
      );
    expect(await insert('Upper@example.com')).toBe('23514');
    expect(await insert('x y@example.com')).toBe('23514');
    expect(await insert('ké@example.com')).toBe('23514');
    expect(await insert('no-at-sign')).toBe('23514');
    expect(
      await code(
        admin,
        `insert into catalog.account_approvals (email_norm, approved_at_utc, note)
         values ('n@example.com', '2026-10-15T00:00:00.000Z', $1)`,
        ['n'.repeat(201)],
      ),
    ).toBe('23514');
    expect(await rows(admin)).toEqual([]);
  });
});

describe('revoking an approval', () => {
  it('returns true and removes the row, then false', async () => {
    const db = await createTestDatabase();
    const admin = connect(db.admin);
    await admin`select catalog.approve_account('someone@example.com')`;
    await admin`select catalog.approve_account('other@example.com')`;
    const [first] =
      await admin`select catalog.revoke_account_approval(' Someone@Example.com ') as r`;
    expect(first?.r).toBe(true);
    expect((await rows(admin)).map((x) => x.email_norm)).toEqual(['other@example.com']);
    const [second] =
      await admin`select catalog.revoke_account_approval('someone@example.com') as r`;
    expect(second?.r).toBe(false);
    expect((await rows(admin)).map((x) => x.email_norm)).toEqual(['other@example.com']);
  });
});

describe('app roles can neither create approvals nor run the functions', () => {
  it('catalog_user gets 42501 on select, insert and delete', async () => {
    const db = await createTestDatabase();
    await connect(db.admin)`select catalog.approve_account('someone@example.com')`;
    const user = connect(db.user);
    for (const stmt of [
      'select count(*) from catalog.account_approvals',
      `insert into catalog.account_approvals (email_norm, approved_at_utc)
       values ('x@example.com', '2026-10-15T00:00:00.000Z')`,
      `update catalog.account_approvals set note = 'n'`,
      'delete from catalog.account_approvals',
    ]) {
      expect(await code(user, stmt), stmt).toBe('42501');
    }
    expect(await rows(connect(db.admin))).toHaveLength(1);
  });

  it('catalog_system gets 42501 on insert and update, and can select and delete', async () => {
    const db = await createTestDatabase();
    const admin = connect(db.admin);
    await admin`select catalog.approve_account('someone@example.com')`;
    await admin`select catalog.approve_account('other@example.com')`;
    const sys = connect(db.system);
    expect(
      await code(
        sys,
        `insert into catalog.account_approvals (email_norm, approved_at_utc)
         values ('x@example.com', '2026-10-15T00:00:00.000Z')`,
      ),
    ).toBe('42501');
    expect(
      await code(sys, `update catalog.account_approvals set approved_at_utc = approved_at_utc`),
    ).toBe('42501');
    expect(await code(sys, 'truncate catalog.account_approvals')).toBe('42501');
    const seen = await sys`select email_norm from catalog.account_approvals
                           where email_norm = 'someone@example.com'`;
    expect(seen.map((r) => r.email_norm)).toEqual(['someone@example.com']);
    const gone = await sys`delete from catalog.account_approvals
                           where email_norm = 'someone@example.com' returning email_norm`;
    expect(gone.map((r) => r.email_norm)).toEqual(['someone@example.com']);
    expect((await rows(admin)).map((x) => x.email_norm)).toEqual(['other@example.com']);
  });

  it('autologger_app under catalog_user or catalog_system cannot execute either function', async () => {
    const db = await createTestDatabase();
    for (const conn of [db.user, db.system, db.app]) {
      const sql = connect(conn);
      expect(await code(sql, `select catalog.approve_account('x@example.com')`)).toBe('42501');
      expect(await code(sql, `select catalog.revoke_account_approval('x@example.com')`)).toBe(
        '42501',
      );
    }
    expect(await rows(connect(db.admin))).toEqual([]);
  });

  it('privileges and policy are exactly as designed', async () => {
    const db = await createTestDatabase();
    const admin = connect(db.admin);
    const privs = ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'];
    const want: Record<string, string[]> = {
      catalog_user: [],
      catalog_system: ['select', 'delete'],
      autologger_app: [],
      autologger_media: [],
      anon: [],
      authenticated: [],
      service_role: [],
      public: [],
    };
    for (const [role, granted] of Object.entries(want)) {
      for (const priv of privs) {
        const [r] =
          await admin`select has_table_privilege(${role}, 'catalog.account_approvals', ${priv}) as p`;
        expect(r?.p, `${role} ${priv}`).toBe(granted.includes(priv));
      }
    }
    const [rls] = await admin`select relrowsecurity from pg_class
                              where oid = 'catalog.account_approvals'::regclass`;
    expect(rls?.relrowsecurity).toBe(true);
    const policies = await admin`select policyname, cmd, roles::text[] as roles, qual, with_check
                                 from pg_policies
                                 where schemaname = 'catalog' and tablename = 'account_approvals'`;
    expect(policies.map((p) => ({ ...p }))).toEqual([
      {
        policyname: 'account_approvals_system_all',
        cmd: 'ALL',
        roles: ['catalog_system'],
        qual: 'true',
        with_check: 'true',
      },
    ]);
  });

  it('both functions are security invoker with a fixed search_path, executable by no app role', async () => {
    const db = await createTestDatabase();
    const admin = connect(db.admin);
    const fns = await admin`select p.oid::regprocedure::text as f, p.prosecdef, p.proconfig,
                                   p.pronargdefaults as d, format_type(p.prorettype, null) as ret
                            from pg_proc p
                            where p.pronamespace = 'catalog'::regnamespace
                              and p.proname in ('approve_account', 'revoke_account_approval')
                            order by f`;
    expect(fns.map((r) => ({ ...r }))).toEqual([
      {
        f: APPROVE,
        prosecdef: false,
        proconfig: ['search_path=catalog, pg_temp'],
        d: 1,
        ret: 'text',
      },
      {
        f: REVOKE,
        prosecdef: false,
        proconfig: ['search_path=catalog, pg_temp'],
        d: 0,
        ret: 'boolean',
      },
    ]);
    for (const f of [APPROVE, REVOKE]) {
      for (const role of [
        'public',
        'anon',
        'authenticated',
        'service_role',
        'autologger_app',
        'autologger_media',
        'catalog_user',
        'catalog_system',
      ]) {
        const [r] = await admin`select has_function_privilege(${role}, ${f}, 'execute') as x`;
        expect(r?.x, `${role} on ${f}`).toBe(false);
      }
    }
  });
});
