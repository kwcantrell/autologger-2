// catalog-policies design D2 (A29): the user path's name edit updates only the two name columns,
// which is all `catalog_user` may update in `users`; the four-column profile update stays for the
// `oauth-callback` system path.

import type { CatalogDb } from '@autologger/ports';
import { describe, expect, it } from 'vitest';
import { AuthStore } from './authStore';

/** A recording fake: `tx` runs the body once on the same handle; `run` reports `changes`. */
function recordingDb(changes: number): { db: CatalogDb; log: { sql: string; binds: unknown[] }[] } {
  const log: { sql: string; binds: unknown[] }[] = [];
  const db: CatalogDb = {
    all: async (sql, ...binds) => {
      log.push({ sql, binds });
      return [];
    },
    first: async <T>(sql: string, ...binds: unknown[]) => {
      log.push({ sql, binds });
      return {
        id: 'u',
        email: 'e@example.com',
        given_name: 'g',
        family_name: 'f',
        picture_url: 'p',
      } as T;
    },
    run: async (sql, ...binds) => {
      log.push({ sql, binds });
      return { changes };
    },
    tx: async (fn) => fn(db),
  };
  return { db, log };
}

describe('authUpdateUserNames (catalog-policies D2)', () => {
  it('issues one two-column UPDATE and reports whether a row changed', async () => {
    const one = recordingDb(1);
    expect(await new AuthStore(one.db).authUpdateUserNames('u', 'G', 'F')).toBe(true);
    expect(one.log).toEqual([
      {
        sql: 'UPDATE users SET given_name = ?, family_name = ? WHERE id = ? AND disabled_at_utc IS NULL',
        binds: ['G', 'F', 'u'],
      },
    ]);
    const none = recordingDb(0);
    expect(await new AuthStore(none.db).authUpdateUserNames('u', 'G', 'F')).toBe(false);
    expect(none.log).toHaveLength(1);
  });

  it('authUpdateUserProfile still issues its four-column update', async () => {
    const { db, log } = recordingDb(1);
    expect(await new AuthStore(db).authUpdateUserProfile('u', { givenName: 'G' })).toBe(true);
    expect(log.at(-1)).toEqual({
      sql: 'UPDATE users SET email = ?, given_name = ?, family_name = ?, picture_url = ? WHERE id = ?',
      binds: ['e@example.com', 'G', 'f', 'p', 'u'],
    });
  });
});
