// catalog-policies design D5: the team delete removes the memberships last. While the caller is
// still a member, each earlier delete passes the member-team rules; deleting the memberships
// first would leave the definition and settings rows behind without an error.

import { ValidationError } from '@autologger/domain';
import type { CatalogDb } from '@autologger/ports';
import { describe, expect, it } from 'vitest';
import { StudioRegistry } from './studioRegistry';

/** A recording fake: `tx` runs the body once on the same handle; the show count is `shows`. */
function recordingDb(shows: number): { db: CatalogDb; log: string[] } {
  const log: string[] = [];
  const db: CatalogDb = {
    all: async (sql) => {
      log.push(sql);
      return [];
    },
    first: async <T>(sql: string) => {
      log.push(sql);
      return (sql.includes('COUNT(*)') ? { c: shows } : null) as T | null;
    },
    run: async (sql) => {
      log.push(sql);
      return { changes: 1 };
    },
    tx: async (fn) => fn(db),
  };
  return { db, log };
}

describe('adminDeleteStudio (catalog-policies D5)', () => {
  it('counts shows, then deletes invites, the definition, the settings and the memberships last', async () => {
    const { db, log } = recordingDb(0);
    await new StudioRegistry(db).adminDeleteStudio('team-a');
    expect(log).toEqual([
      'SELECT COUNT(*) AS c FROM shows WHERE studio_id = ?',
      'DELETE FROM team_invites WHERE studio_id = ?',
      'DELETE FROM studio_definitions WHERE id = ?',
      'DELETE FROM app_settings WHERE key = ?',
      'DELETE FROM user_studio_memberships WHERE studio_id = ?',
    ]);
  });

  it('refuses a team with shows and deletes nothing', async () => {
    const { db, log } = recordingDb(2);
    await expect(new StudioRegistry(db).adminDeleteStudio('team-a')).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(log.filter((sql) => sql.startsWith('DELETE'))).toEqual([]);
  });
});
