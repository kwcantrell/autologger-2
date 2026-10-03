import type { CatalogDb, CatalogRoot } from '@autologger/ports';
import { describe, expect, it } from 'vitest';
import { Catalog, CatalogUnboundError } from './catalog';
import { createCatalog } from './index';

// A stub CatalogDb — construction must not touch it (init() is never called here).
const stubDb = {} as unknown as CatalogDb;

describe('Catalog facade', () => {
  const catalog = new Catalog(stubDb);

  it('exposes the domain stores as readonly props (the sole API surface)', () => {
    for (const key of ['studios', 'auth', 'shows', 'sessions', 'profile'] as const) {
      expect(catalog[key]).toBeDefined();
    }
  });

  it('carries no flat delegate methods (the compat shim is gone)', () => {
    expect(Object.keys(catalog).sort()).toEqual([
      'auth',
      'profile',
      'sessions',
      'shows',
      'studios',
    ]);
    for (const legacy of [
      'getShowRow',
      'authGetUserById',
      'setSessionArchived',
      'profilePayload',
    ]) {
      expect((catalog as unknown as Record<string, unknown>)[legacy]).toBeUndefined();
    }
  });
});

// catalog-roles task 4.1 (design D7): createCatalog returns an unbound catalog; forUser and system
// derive bound catalogs from its root, each carrying the registry snapshot without a query.
interface Sent {
  binding: string;
  sql: string;
}

/** A fake root: each handle records its binding and statements; the registry query answers one
 * team. */
function fakeRoot() {
  const sent: Sent[] = [];
  const handle = (binding: string): CatalogDb => {
    const record = async (sql: string) => {
      sent.push({ binding, sql });
      return sql.includes('FROM studio_definitions')
        ? [{ id: 'st', display_name: 'Studio', sort_order: 0 }]
        : [];
    };
    const db: CatalogDb = {
      all: async <T>(sql: string) => (await record(sql)) as T[],
      first: async <T>(sql: string) => ((await record(sql))[0] as T | undefined) ?? null,
      run: async (sql: string) => {
        await record(sql);
        return { changes: 0 };
      },
      tx: async (fn) => {
        sent.push({ binding, sql: 'TX' });
        return fn(db);
      },
    };
    return db;
  };
  const root: CatalogRoot = {
    bindUser: (id) => handle(`user:${id}`),
    bindSystem: (reason) => handle(`system:${reason}`),
    close: async () => {},
  };
  return { root, sent };
}

describe('createCatalog and the bindings (catalog-roles D7)', () => {
  it('an unbound catalog rejects every store call, tx and init() and sends nothing', async () => {
    const f = fakeRoot();
    const cat = createCatalog(f.root);
    for (const call of [
      () => cat.init(),
      () => cat.tx(async () => 1),
      () => cat.auth.authGetUserById('u-1'),
      () => cat.shows.getShowRow('s'),
      () => cat.sessions.listSessionsForShow('s'),
      () => cat.studios.getSetting('k'),
      () => cat.unbound().auth.authGetUserById('u-1'),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(CatalogUnboundError);
    }
    expect(f.sent).toEqual([]);
  });

  it('forUser and system run statements on bindUser / bindSystem handles', async () => {
    const f = fakeRoot();
    const cat = createCatalog(f.root);
    await cat.forUser('u-1').auth.authGetUserById('u-1');
    await cat.system('x').shows.getShowRow('s');
    expect(f.sent.map((s) => s.binding)).toEqual(['user:u-1', 'system:x']);
  });

  it('each derived catalog carries the registry snapshot init() loaded, with no extra query', async () => {
    const f = fakeRoot();
    const sys = createCatalog(f.root).system('auth-resolve');
    await sys.init();
    expect(f.sent).toEqual([
      { binding: 'system:auth-resolve', sql: expect.stringContaining('FROM studio_definitions') },
    ]);
    for (const derived of [sys.forUser('u-1'), sys.system('other'), sys.unbound()]) {
      expect(derived.studios.studioOrderTuple()).toEqual(['st']);
      expect(derived.studios.isKnownStudio('st')).toBe(true);
    }
    expect(f.sent).toHaveLength(1);
  });

  it('tx on a bound catalog runs on that handle, and the body catalog keeps the binding', async () => {
    const f = fakeRoot();
    const sys = createCatalog(f.root).system('auth-resolve');
    await sys.init();
    f.sent.length = 0;
    const user = sys.forUser('u-1');
    await user.tx(async (cat) => {
      await cat.auth.authGetUserById('u-1');
      expect(cat.studios.studioOrderTuple()).toEqual(['st']);
      // A catalog derived inside the body still binds from the root.
      await cat.system('y').auth.authGetUserById('u-2');
    });
    expect(f.sent.map((s) => `${s.binding} ${s.sql === 'TX' ? 'TX' : 'stmt'}`)).toEqual([
      'user:u-1 TX',
      'user:u-1 stmt',
      'system:y stmt',
    ]);
  });

  it('a Catalog built without a root throws on forUser and system', () => {
    const cat = new Catalog({} as CatalogDb);
    expect(() => cat.forUser('u-1')).toThrow(TypeError);
    expect(() => cat.system('x')).toThrow(TypeError);
  });
});
