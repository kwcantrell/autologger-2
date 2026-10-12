// Catalog search (catalog-search task 4.1, design D7; api-contract-freeze "Search endpoint"): the
// `GET /api/search` query (`q` 2–200 characters after trimming, `limit` a decimal 1–25 defaulting
// to 5, optional filters, unknown parameters ignored) and the strict 200 body (`sec` is null for
// topic and event moments). The route itself is pinned by `server/src/routers/search.int`.

import { describe, expect, it } from 'vitest';
import { searchQuerySchema, searchResponseSchema } from './schemas';

const q = (over: Record<string, unknown>) => searchQuerySchema.safeParse(over);

describe('searchQuerySchema', () => {
  it('trims q and defaults limit to 5, with no filters', () => {
    expect(searchQuerySchema.parse({ q: '  budget  ' })).toEqual({ q: 'budget', limit: 5 });
  });

  it('takes q of 2 and 200 characters after trimming, and refuses 1 or 201', () => {
    expect(q({ q: 'ab' }).success).toBe(true);
    expect(q({ q: ` ${'a'.repeat(200)} ` }).success).toBe(true);
    expect(q({ q: 'a' }).success).toBe(false);
    expect(q({ q: '  a  ' }).success).toBe(false);
    expect(q({ q: '    ' }).success).toBe(false);
    expect(q({ q: 'a'.repeat(201) }).success).toBe(false);
    expect(q({}).success).toBe(false);
  });

  it('takes limit as a decimal 1–25 and refuses anything else', () => {
    for (const [raw, n] of [
      ['1', 1],
      ['5', 5],
      ['25', 25],
    ] as const) {
      expect(searchQuerySchema.parse({ q: 'ab', limit: raw }).limit).toBe(n);
    }
    for (const raw of ['0', '26', '-1', '1.5', '1e1', '0x5', ' 5', '', 'five', '05', '100']) {
      expect(q({ q: 'ab', limit: raw }).success, raw).toBe(false);
    }
  });

  it('passes session_id through, an empty one included (catalog-search D11)', () => {
    expect(searchQuerySchema.parse({ q: 'ab', session_id: 'se1', limit: '25' })).toEqual({
      q: 'ab',
      session_id: 'se1',
      limit: 25,
    });
    expect(searchQuerySchema.parse({ q: 'ab', session_id: '' })).toEqual({
      q: 'ab',
      session_id: '',
      limit: 5,
    });
    expect(searchQuerySchema.parse({ q: 'ab', studio_id: '' })).toEqual({
      q: 'ab',
      studio_id: '',
      limit: 5,
    });
  });

  it('passes studio_id and show_id through, and ignores unknown parameters', () => {
    expect(
      searchQuerySchema.parse({ q: 'ab', studio_id: 'st1', show_id: 'sh1', page: '2', x: 'y' }),
    ).toEqual({ q: 'ab', studio_id: 'st1', show_id: 'sh1', limit: 5 });
  });
});

const body = (over: Record<string, unknown> = {}) => ({
  q: 'budget',
  studios: [{ id: 'st1', name: 'Studio' }],
  shows: [{ id: 'sh1', name: 'Show', studio_id: 'st1' }],
  sessions: [
    {
      id: 's1',
      title: 'Budget day',
      episode: '001',
      show_id: 'sh1',
      studio_id: 'st1',
      started_at_utc: '2026-10-12T00:00:00.000Z',
      archived: false,
      match: 'title',
      snippet: null,
    },
  ],
  moments: [
    {
      session_id: 's1',
      session_title: 'Budget day',
      show_id: 'sh1',
      kind: 'transcript',
      id: '2',
      sec: 75.5,
      speaker: 'A',
      snippet: 'the budget',
    },
    {
      session_id: 's1',
      session_title: 'Budget day',
      show_id: 'sh1',
      kind: 'topic',
      id: 't1',
      sec: null,
      speaker: '',
      snippet: 'budget',
    },
    {
      session_id: 's1',
      session_title: 'Budget day',
      show_id: 'sh1',
      kind: 'event',
      id: 'e1',
      sec: null,
      speaker: '',
      snippet: 'budget',
    },
  ],
  // catalog-search D11: each session in `moments` with its total matches.
  moment_sessions: [{ session_id: 's1', total: 12 }],
  ...over,
});
const ok = (b: unknown) => searchResponseSchema.safeParse(b).success;
const moment = (over: Record<string, unknown>) => ({ ...body().moments[0], ...over });
const session = (over: Record<string, unknown>) => ({ ...body().sessions[0], ...over });

describe('searchResponseSchema', () => {
  it('takes the full shape, and empty groups', () => {
    expect(ok(body())).toBe(true);
    expect(
      ok({ q: 'ab', studios: [], shows: [], sessions: [], moments: [], moment_sessions: [] }),
    ).toBe(true);
  });

  it('is strict: no extra or missing keys at any level', () => {
    expect(ok({ ...body(), extra: 1 })).toBe(false);
    const { moments: _m, ...noMoments } = body();
    expect(ok(noMoments)).toBe(false);
    expect(ok(body({ studios: [{ id: 'st1', name: 'S', extra: 1 }] }))).toBe(false);
    expect(ok(body({ shows: [{ id: 'sh1', name: 'S' }] }))).toBe(false);
    expect(ok(body({ sessions: [session({ notes: 'x' })] }))).toBe(false);
    expect(ok(body({ moments: [moment({ extra: 1 })] }))).toBe(false);
  });

  it('takes a transcript sec as a number or null, and only null for topic and event', () => {
    expect(ok(body({ moments: [moment({ sec: null })] }))).toBe(true);
    expect(ok(body({ moments: [moment({ sec: 0 })] }))).toBe(true);
    expect(ok(body({ moments: [moment({ sec: '1' })] }))).toBe(false);
    for (const kind of ['topic', 'event']) {
      expect(ok(body({ moments: [moment({ kind, sec: null })] })), kind).toBe(true);
      expect(ok(body({ moments: [moment({ kind, sec: 1.5 })] })), kind).toBe(false);
    }
    expect(ok(body({ moments: [moment({ kind: 'word' })] }))).toBe(false);
  });

  it('requires moment_sessions, strict entries of session_id and a numeric total (D11)', () => {
    const { moment_sessions: _ms, ...noTotals } = body();
    expect(ok(noTotals)).toBe(false);
    expect(ok(body({ moment_sessions: [{ session_id: 's1', total: 0 }] }))).toBe(true);
    expect(ok(body({ moment_sessions: [{ session_id: 's1', total: 1000 }] }))).toBe(true);
    expect(ok(body({ moment_sessions: [{ session_id: 's1' }] }))).toBe(false);
    expect(ok(body({ moment_sessions: [{ session_id: 's1', total: '3' }] }))).toBe(false);
    expect(ok(body({ moment_sessions: [{ session_id: 's1', total: 3, extra: 1 }] }))).toBe(false);
    expect(ok(body({ moment_sessions: [{ total: 3 }] }))).toBe(false);
  });

  it('takes match title or notes, and snippet a string or null', () => {
    expect(ok(body({ sessions: [session({ match: 'notes', snippet: 'x' })] }))).toBe(true);
    expect(ok(body({ sessions: [session({ match: 'transcript' })] }))).toBe(false);
    expect(ok(body({ sessions: [session({ archived: 0 })] }))).toBe(false);
    expect(ok(body({ moments: [moment({ snippet: null })] }))).toBe(false);
  });
});
