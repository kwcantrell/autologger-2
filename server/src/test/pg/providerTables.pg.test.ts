// byo-ai-providers design D1: `catalog.user_provider_credentials` and `catalog.provider_key_check`
// from `20261016000000_user_provider_credentials.sql`. Both are system-only, like kv and the
// Companion tables: catalog_user is refused with 42501 before any policy, catalog_system reads and
// writes every row. One credential per user and kind; deleting a user takes their credentials. The
// key check table holds one row only.

import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { type ConnOptions, createTestDatabase } from '../../../../test/pg/testDb';

const T = '2026-10-16T00:00:00.000Z';
const TABLES = ['user_provider_credentials', 'provider_key_check'] as const;

const open: postgres.Sql[] = [];
function connect(o: ConnOptions): postgres.Sql {
  const sql = postgres({ ...o, max: 1, onnotice: () => {} });
  open.push(sql);
  return sql;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.end()));
});

async function seedUser(sys: postgres.Sql, id: string): Promise<void> {
  await sys`insert into users (id, google_sub, email, created_at_utc)
            values (${id}, ${`${id}-sub`}, ${`${id}@example.com`}, ${T})`;
}
const insertCredential = (
  user: string,
  kind: string,
  over: { provider?: string; base_url?: string | null; base_origin?: string | null; model?: string; last4?: string } = {},
) => {
  const q = (v: string | null | undefined) => (v === null || v === undefined ? 'null' : `'${v}'`);
  const llm = kind === 'llm';
  const baseUrl = 'base_url' in over ? over.base_url : llm ? 'https://api.example.com/v1' : null;
  const baseOrigin =
    'base_origin' in over ? over.base_origin : llm ? 'https://api.example.com' : null;
  return `insert into user_provider_credentials
     (user_id, kind, provider, base_url, base_origin, model, key_nonce, key_ciphertext, key_tag,
      key_version, key_last4, created_at_utc, updated_at_utc)
   values ('${user}', '${kind}', ${q(over.provider ?? (llm ? 'openai-compatible' : 'deepgram'))},
     ${q(baseUrl)}, ${q(baseOrigin)}, ${q(over.model ?? 'm')}, '\\x00', '\\x01', '\\x02', 1,
     ${q(over.last4 ?? 'abcd')}, '${T}', '${T}')`;
};
const insertCheck = (id = 1) =>
  `insert into provider_key_check (id, check_value, created_at_utc) values (${id}, 'c', '${T}')`;

/** Runs `stmt` as catalog_user bound to `uid` in a transaction that rolls back; the error code or 'ok'. */
async function asUser(app: postgres.Sql, uid: string, stmt: string): Promise<string> {
  let out = 'ok';
  class Rollback extends Error {}
  await app
    .begin(async (tx) => {
      await tx`select set_config('role', 'catalog_user', true), set_config('app.user_id', ${uid}, true)`;
      try {
        await tx.unsafe(stmt);
      } catch (e) {
        out = String((e as { code?: unknown }).code);
      }
      throw new Rollback();
    })
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
  return out;
}

describe('the provider tables are system-only (catalog-database "Provider credentials are stored in the catalog")', () => {
  it('catalog_user holds no privilege and no policy on either table; catalog_system has the allow-all one', async () => {
    const db = await createTestDatabase();
    const admin = connect(db.admin);
    for (const table of TABLES) {
      for (const priv of ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) {
        const [r] =
          await admin`select has_table_privilege('catalog_user', ${`catalog.${table}`}, ${priv}) as p`;
        expect(r?.p, `${table} ${priv}`).toBe(false);
        for (const role of ['anon', 'authenticated']) {
          const [x] = await admin`select has_table_privilege(${role}, ${`catalog.${table}`}, ${priv}) as p`;
          expect(x?.p, `${role} ${table} ${priv}`).toBe(false);
        }
      }
      const [rls] = await admin`select relrowsecurity from pg_class
                                where oid = ${`catalog.${table}`}::regclass`;
      expect(rls?.relrowsecurity, table).toBe(true);
      const policies = await admin`select policyname, cmd, roles::text[] as roles, qual, with_check
                                   from pg_policies where schemaname = 'catalog' and tablename = ${table}`;
      expect(policies.map((p) => ({ ...p }))).toEqual([
        {
          policyname: `${table}_system_all`,
          cmd: 'ALL',
          roles: ['catalog_system'],
          qual: 'true',
          with_check: 'true',
        },
      ]);
    }
  });

  it('a catalog_user binding gets 42501 on select, insert, update and delete of both tables, even for its own rows', async () => {
    const db = await createTestDatabase();
    const sys = connect(db.system);
    await seedUser(sys, 'u1');
    await sys.unsafe(insertCredential('u1', 'stt'));
    await sys.unsafe(insertCheck());
    const app = connect(db.app);
    for (const stmt of [
      'select count(*) from user_provider_credentials',
      insertCredential('u1', 'llm'),
      `update user_provider_credentials set model = model where user_id = 'u1'`,
      `delete from user_provider_credentials where user_id = 'u1'`,
      'select count(*) from provider_key_check',
      `update provider_key_check set check_value = 'x'`,
      'delete from provider_key_check',
    ]) {
      expect(await asUser(app, 'u1', stmt), stmt).toBe('42501');
    }
    expect((await sys`select kind from user_provider_credentials`).map((r) => r.kind)).toEqual([
      'stt',
    ]);
    expect((await sys`select id from provider_key_check`).length).toBe(1);
  });

  it('catalog_system inserts, selects, updates and deletes rows of any user', async () => {
    const db = await createTestDatabase();
    const sys = connect(db.system);
    await seedUser(sys, 'u1');
    await seedUser(sys, 'u2');
    await sys.unsafe(insertCredential('u1', 'llm'));
    await sys.unsafe(insertCredential('u2', 'stt'));
    const rows = await sys`update user_provider_credentials set test_count = 2,
                             test_window_start_ms = 1000 returning user_id, test_count`;
    expect(rows.map((r) => r.user_id).sort()).toEqual(['u1', 'u2']);
    expect((await sys`delete from user_provider_credentials returning user_id`).length).toBe(2);
  });
});

describe('the provider tables keep their constraints (design D1)', () => {
  it('stores the key only as bytea parts and defaults the test window to empty', async () => {
    const db = await createTestDatabase();
    const sys = connect(db.system);
    await seedUser(sys, 'u1');
    await sys.unsafe(insertCredential('u1', 'llm'));
    const [r] = await sys`select key_nonce, key_ciphertext, key_tag, key_version, key_last4,
                                 test_window_start_ms, test_count from user_provider_credentials`;
    expect(Buffer.isBuffer(r?.key_nonce)).toBe(true);
    expect(Buffer.isBuffer(r?.key_ciphertext)).toBe(true);
    expect(Buffer.isBuffer(r?.key_tag)).toBe(true);
    expect({ v: r?.key_version, last4: r?.key_last4, w: r?.test_window_start_ms, n: r?.test_count }).toEqual({
      v: 1,
      last4: 'abcd',
      w: null,
      n: 0,
    });
  });

  it('a deleted user takes their credentials; other users keep theirs', async () => {
    const db = await createTestDatabase();
    const sys = connect(db.system);
    await seedUser(sys, 'u1');
    await seedUser(sys, 'u2');
    await sys.unsafe(insertCredential('u1', 'llm'));
    await sys.unsafe(insertCredential('u1', 'stt'));
    await sys.unsafe(insertCredential('u2', 'stt'));
    await sys`delete from users where id = 'u1'`;
    const rows = await sys`select user_id, kind from user_provider_credentials`;
    expect(rows.map((r) => `${r.user_id}:${r.kind}`)).toEqual(['u2:stt']);
  });

  it('refuses a second credential of a kind, an unknown user, and out-of-range values', async () => {
    const db = await createTestDatabase();
    const sys = connect(db.system);
    await seedUser(sys, 'u1');
    await sys.unsafe(insertCredential('u1', 'stt'));
    const code = (stmt: string) =>
      sys.unsafe(stmt).then(
        () => 'ok',
        (e: { code?: unknown }) => String(e.code),
      );
    expect(await code(insertCredential('u1', 'stt'))).toBe('23505');
    expect(await code(insertCredential('nobody', 'llm'))).toBe('23503');
    expect(await code(insertCredential('u1', 'tts'))).toBe('23514');
    expect(await code(insertCredential('u1', 'llm', { provider: '' }))).toBe('23514');
    expect(await code(insertCredential('u1', 'llm', { provider: 'p'.repeat(65) }))).toBe('23514');
    expect(await code(insertCredential('u1', 'llm', { model: '' }))).toBe('23514');
    expect(await code(insertCredential('u1', 'llm', { model: 'm'.repeat(201) }))).toBe('23514');
    expect(await code(insertCredential('u1', 'llm', { last4: '' }))).toBe('23514');
    expect(await code(insertCredential('u1', 'llm', { last4: 'abcde' }))).toBe('23514');
    expect(
      await code(insertCredential('u1', 'llm', { base_url: `https://a.example/${'x'.repeat(2048)}` })),
    ).toBe('23514');
    // base_origin is null exactly when base_url is.
    expect(await code(insertCredential('u1', 'llm', { base_origin: null }))).toBe('23514');
    expect(
      await code(insertCredential('u1', 'llm', { base_url: null, base_origin: 'https://a.example' })),
    ).toBe('23514');
    expect(await code(insertCredential('u1', 'llm'))).toBe('ok');
  });

  it('the key check table holds at most one row, with id 1', async () => {
    const db = await createTestDatabase();
    const sys = connect(db.system);
    const code = (stmt: string) =>
      sys.unsafe(stmt).then(
        () => 'ok',
        (e: { code?: unknown }) => String(e.code),
      );
    expect(await code(insertCheck(2))).toBe('23514');
    expect(await code(insertCheck(1))).toBe('ok');
    expect(await code(insertCheck(1))).toBe('23505');
  });
});
