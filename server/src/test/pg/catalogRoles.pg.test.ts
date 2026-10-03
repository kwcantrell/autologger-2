// catalog-roles design D1-D3: the two NOLOGIN catalog roles, the app role's two set-only
// memberships, the per-transaction user id helper, and the role guards of the 4a and 6b-1
// migrations. Roles are cluster-wide and `pg` files run in parallel, so the guard tests never touch
// `autologger_app`: they run each guard block with a scratch role in its place (design D3). The
// tests that list role members run in this file only, so no scratch role is visible to them.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { type ConnOptions, connOptions, createTestDatabase } from '../../../../test/pg/testDb';

const MIGRATIONS = resolve(import.meta.dirname, '../../../../supabase/migrations');
const SCHEMA_4A = resolve(MIGRATIONS, '20261001000000_catalog_schema.sql');
const ROLES_6B1 = resolve(MIGRATIONS, '20261006000000_catalog_roles.sql');
const ROLES = ['catalog_user', 'catalog_system'] as const;
const API_ROLES = ['authenticator', 'anon', 'authenticated', 'service_role'];

const open: postgres.Sql[] = [];
function connect(o: ConnOptions): postgres.Sql {
  const sql = postgres({ ...o, max: 1, onnotice: () => {} });
  open.push(sql);
  return sql;
}
const scratch: string[] = [];
afterEach(async () => {
  if (scratch.length) {
    const admin = connect(connOptions('postgres', 'postgres'));
    for (const r of scratch.splice(0)) await admin.unsafe(`drop role if exists ${r}`);
  }
  await Promise.all(open.splice(0).map((s) => s.end()));
});

describe('the catalog roles (catalog-roles D1)', () => {
  it('exist as NOLOGIN roles with no special attribute and no membership of their own', async () => {
    const sql = connect(connOptions('postgres', 'postgres'));
    for (const role of ROLES) {
      const [r] = await sql`select rolcanlogin, rolbypassrls, rolsuper, rolcreatedb, rolcreaterole,
                                   rolreplication
                            from pg_roles where rolname = ${role}`;
      expect(r, role).toEqual({
        rolcanlogin: false,
        rolbypassrls: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
      });
      const m = await sql`select count(*)::int as n from pg_auth_members
                          where member = ${role}::regrole`;
      expect(m[0]?.n, role).toBe(0);
    }
  });

  it('have only autologger_app and postgres as members', async () => {
    const sql = connect(connOptions('postgres', 'postgres'));
    for (const role of ROLES) {
      const rows = await sql`select distinct member::regrole::text as m from pg_auth_members
                             where roleid = ${role}::regrole order by 1`;
      expect(rows.map((r) => r.m).sort(), role).toEqual(['autologger_app', 'postgres']);
    }
  });

  it('cannot be assumed by authenticator or the API roles', async () => {
    const sql = connect(connOptions('postgres', 'postgres'));
    for (const api of API_ROLES) {
      for (const role of ROLES) {
        const r = await sql`select pg_has_role(${api}, ${role}, 'SET') as s`;
        expect(r[0]?.s, `${api} -> ${role}`).toBe(false);
      }
    }
  });
});

describe('catalog.app_user_id() and the per-transaction role (catalog-roles D1, D6)', () => {
  it('returns the id the transaction set, and null outside it', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.user);
    expect((await sql`select catalog.app_user_id() as id`)[0]?.id).toBeNull();
    const inside = await sql.begin(async (t) => {
      await t`select set_config('app.user_id', 'u-1', true)`;
      return (await t`select catalog.app_user_id() as id`)[0]?.id;
    });
    expect(inside).toBe('u-1');
    // After use the setting reads '' (design A8), which the helper maps to null.
    expect((await sql`select catalog.app_user_id() as id`)[0]?.id).toBeNull();
  });

  it('after commit, rollback and an error the connection is autologger_app with no user id', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.app);
    const preamble = (t: postgres.TransactionSql, role: string, id: string) =>
      t`select set_config('role', ${role}, true), set_config('app.user_id', ${id}, true)`;
    const sessionState = async () =>
      (await sql`select current_user as u, current_setting('app.user_id', true) as id`)[0] as {
        u: string;
        id: string | null;
      };

    await sql.begin(async (t) => {
      await preamble(t, 'catalog_user', 'u-1');
      expect((await t`select current_user as u, catalog.app_user_id() as id`)[0]).toEqual({
        u: 'catalog_user',
        id: 'u-1',
      });
    });
    expect(await sessionState()).toEqual({ u: 'autologger_app', id: '' });

    await expect(
      sql.begin(async (t) => {
        await preamble(t, 'catalog_system', '');
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(await sessionState()).toEqual({ u: 'autologger_app', id: '' });

    await expect(
      sql.begin(async (t) => {
        await preamble(t, 'catalog_user', 'u-2');
        await t`select 1 / 0`;
      }),
    ).rejects.toMatchObject({ code: '22012' });
    expect(await sessionState()).toEqual({ u: 'autologger_app', id: '' });
    // catalog-roles 6.2: back to the bare login role, a catalog table read is refused.
    await expect(sql`select count(*) from users`).rejects.toMatchObject({ code: '42501' });
  });

  it('no function in schema catalog is executable by public; the helper only by the catalog roles', async () => {
    const sql = connect(connOptions('postgres', 'postgres'));
    const fns = await sql`select p.oid::regprocedure::text as f from pg_proc p
                          where p.pronamespace = 'catalog'::regnamespace`;
    expect(fns.map((r) => r.f)).toContain('catalog.app_user_id()');
    for (const { f } of fns) {
      const r = await sql`select has_function_privilege('public', ${f}, 'execute') as x`;
      expect(r[0]?.x, f).toBe(false);
    }
    for (const [role, can] of [
      ['anon', false],
      ['authenticated', false],
      ['autologger_app', false],
      ['catalog_user', true],
      ['catalog_system', true],
    ] as const) {
      const r =
        await sql`select has_function_privilege(${role}, 'catalog.app_user_id()', 'execute') as x`;
      expect(r[0]?.x, role).toBe(can);
    }
  });
});

/** The text between `-- guard:begin` and `-- guard:end` in a migration, with `autologger_app`
 * replaced by `role` (design D3). */
function guardBlock(file: string, role: string): string {
  const text = readFileSync(file, 'utf8');
  const block = /-- guard:begin\n([\s\S]*?)-- guard:end/.exec(text)?.[1];
  if (!block) throw new Error(`no guard block in ${file}`);
  return block.replaceAll('autologger_app', role);
}

type Membership = { role: string; inherit?: boolean; admin?: boolean };

/** A scratch role holding `memberships`, dropped after the test. */
async function scratchRole(sql: postgres.Sql, memberships: Membership[]): Promise<string> {
  const name = `t_guard_${randomBytes(6).toString('hex')}`;
  scratch.push(name);
  await sql.unsafe(`create role ${name} nologin`);
  for (const m of memberships) {
    await sql.unsafe(
      `grant ${m.role} to ${name} with inherit ${m.inherit ? 'true' : 'false'}, set true` +
        `${m.admin ? ', admin true' : ''}`,
    );
  }
  return name;
}

const CONFORMING: Membership[] = [{ role: 'catalog_user' }, { role: 'catalog_system' }];

describe('the role guards (catalog-roles D3)', () => {
  for (const [label, file] of [
    ['4a', SCHEMA_4A],
    ['6b-1', ROLES_6B1],
  ] as const) {
    it(`the ${label} guard passes for the two set-only memberships`, async () => {
      const sql = connect(connOptions('postgres', 'postgres'));
      const role = await scratchRole(sql, CONFORMING);
      await sql.unsafe(guardBlock(file, role));
    });

    it(`the ${label} guard fails for a third membership`, async () => {
      const sql = connect(connOptions('postgres', 'postgres'));
      const extra = await scratchRole(sql, []);
      const role = await scratchRole(sql, [...CONFORMING, { role: extra }]);
      await expect(sql.unsafe(guardBlock(file, role))).rejects.toMatchObject({ code: 'P0001' });
    });

    it(`the ${label} guard fails for catalog_user with inherit true`, async () => {
      const sql = connect(connOptions('postgres', 'postgres'));
      const role = await scratchRole(sql, [
        { role: 'catalog_user', inherit: true },
        { role: 'catalog_system' },
      ]);
      await expect(sql.unsafe(guardBlock(file, role))).rejects.toMatchObject({ code: 'P0001' });
    });

    it(`the ${label} guard fails for catalog_system with the admin option`, async () => {
      const sql = connect(connOptions('postgres', 'postgres'));
      const role = await scratchRole(sql, [
        { role: 'catalog_user' },
        { role: 'catalog_system', admin: true },
      ]);
      await expect(sql.unsafe(guardBlock(file, role))).rejects.toMatchObject({ code: 'P0001' });
    });
  }

  it('the 4a guard passes with no membership (a fresh cluster)', async () => {
    const sql = connect(connOptions('postgres', 'postgres'));
    const role = await scratchRole(sql, []);
    await sql.unsafe(guardBlock(SCHEMA_4A, role));
  });

  it('the 6b-1 guard fails unless both memberships exist', async () => {
    const sql = connect(connOptions('postgres', 'postgres'));
    const role = await scratchRole(sql, [{ role: 'catalog_user' }]);
    await expect(sql.unsafe(guardBlock(ROLES_6B1, role))).rejects.toMatchObject({
      code: 'P0001',
    });
  });
});
