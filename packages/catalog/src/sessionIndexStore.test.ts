// Pure-function coverage for the yt-dlp upload_date normalizer (design D4).
// The DB-backed setSessionEpisodeDate round-trip lives in the integration
// tier (changesReaders.int.test.ts) alongside its setSessionArchived /
// setSessionUiHidden siblings.

import type { Row } from '@autologger/domain';
import type { CatalogDb } from '@autologger/ports';
import { describe, expect, it } from 'vitest';
import { normalizeUploadDate, SessionIndexStore } from './sessionIndexStore';
import type { ShowsStore } from './showsStore';
import type { StudioRegistry } from './studioRegistry';

describe('normalizeUploadDate (yt-dlp YYYYMMDD -> catalog YYYY-MM-DD)', () => {
  it('converts a well-formed YYYYMMDD string', () => {
    expect(normalizeUploadDate('20240115')).toBe('2024-01-15');
    expect(normalizeUploadDate('20240101')).toBe('2024-01-01');
    expect(normalizeUploadDate('20241231')).toBe('2024-12-31');
  });

  it('is a no-op (returns null) for null/undefined/blank input', () => {
    expect(normalizeUploadDate(null)).toBeNull();
    expect(normalizeUploadDate(undefined)).toBeNull();
    expect(normalizeUploadDate('')).toBeNull();
    expect(normalizeUploadDate('   ')).toBeNull();
  });

  it('is a no-op (returns null) for malformed input', () => {
    expect(normalizeUploadDate('2024-01-15')).toBeNull(); // already-formatted, wrong shape
    expect(normalizeUploadDate('202401')).toBeNull(); // too short
    expect(normalizeUploadDate('2024011599')).toBeNull(); // too long
    expect(normalizeUploadDate('abcdefgh')).toBeNull(); // non-numeric
    expect(normalizeUploadDate('20241301')).toBeNull(); // month 13
    expect(normalizeUploadDate('20240132')).toBeNull(); // day 32
    expect(normalizeUploadDate('20240000')).toBeNull(); // month/day 00
  });

  it('trims surrounding whitespace before validating', () => {
    expect(normalizeUploadDate('  20240115  ')).toBe('2024-01-15');
  });
});

// owner-bootstrap D10: with no global active studio, a session whose show's team is unknown gets a
// team-less profile (empty id and name) carrying the show's categories, or the default categories
// when the session has no show. It never reads a global setting.
describe('studioProfileForSession without a known team (owner-bootstrap D10)', () => {
  const showCats = [
    { id: 'c1', name: 'Clap', color: '#112233', type: 'BUTTON', dropdown_options: [] },
  ];
  function store(rows: { session: Row | null; studioId: string | null; show: Row | null }) {
    const db = {
      first: async (sql: string) => {
        if (sql.includes('LEFT JOIN shows')) {
          return rows.session === null ? null : { studio_id: rows.studioId };
        }
        if (sql.startsWith('SELECT * FROM sessions')) return rows.session;
        throw new Error(`unexpected query: ${sql}`);
      },
    } as unknown as CatalogDb;
    const never = (what: string) => () => {
      throw new Error(`${what} must not be read`);
    };
    const studios = {
      isKnownStudio: () => false,
      studioNamesDict: () => ({}),
      getSetting: never('a global setting'),
      loadStudioProfile: never('a team profile'),
    } as unknown as StudioRegistry;
    const shows = { getShowRow: async () => rows.show } as unknown as ShowsStore;
    return new SessionIndexStore(db, studios, shows);
  }

  it("an unknown team gets id '', name '' and the show's categories", async () => {
    const s = store({
      session: { id: 's1', show_id: 'sh1' },
      studioId: 'gone-team',
      show: { id: 'sh1', name: 'Show', show_code: 'S', categories_json: JSON.stringify(showCats) },
    });
    const p = await s.studioProfileForSession('s1');
    expect(p.id).toBe('');
    expect(p.name).toBe('');
    expect(p.categories.map((c) => c.label)).toEqual(['Clap']);
  });

  it('a session with no show gets the default categories', async () => {
    const s = store({ session: { id: 's1', show_id: null }, studioId: null, show: null });
    const p = await s.studioProfileForSession('s1');
    expect(p.id).toBe('');
    expect(p.name).toBe('');
    expect(p.categories.map((c) => c.label)).toEqual(['Scene', 'Audio issue', 'Note']);
  });

  it('an unknown session gets the default categories, not an error', async () => {
    const s = store({ session: null, studioId: null, show: null });
    const p = await s.studioProfileForSession('nope');
    expect(p.id).toBe('');
    expect(p.categories.map((c) => c.label)).toEqual(['Scene', 'Audio issue', 'Note']);
  });
});

// catalog-policies D8: a session update whose UPDATE changes no row (a policy refused it after a
// revoke raced the route's gate) reports no session, which the route answers with 404.
describe('updateSessionIndex with a zero-row UPDATE (catalog-policies D8)', () => {
  it('returns null when the UPDATE reports 0 changes', async () => {
    const db: CatalogDb = {
      all: async () => [],
      first: async <T>() => ({ id: 's1', title: 'Old', start_offset_frames: 0 }) as T,
      run: async () => ({ changes: 0 }),
      tx: async (fn) => fn(db),
    };
    const shows = { withDb: () => shows } as unknown as ShowsStore;
    const studios = { withDb: () => studios } as unknown as StudioRegistry;
    const store = new SessionIndexStore(db, studios, shows);
    expect(await store.updateSessionIndex('s1', { title: 'New' })).toBeNull();
  });
});
