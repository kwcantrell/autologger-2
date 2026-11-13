// The paging contract's pure parts (custom session dashboards J5; design 5.2): limits, cursors and
// the 40,000-character page cap.

import { describe, expect, it } from 'vitest';
import {
  buildPage,
  clampLimit,
  decodeCursor,
  encodeCursor,
  INVALID_CURSOR,
  OVERSIZE_NOTE,
  PAGE_MAX_CHARS,
  QueryError,
  TOOL_LIMITS,
} from './query';

const isStr = (k: unknown): k is string => typeof k === 'string';

describe('clampLimit', () => {
  it('defaults, clamps to the maximum and never goes below 1', () => {
    expect(clampLimit(undefined, TOOL_LIMITS.list_events)).toBe(200);
    expect(clampLimit(10_000, TOOL_LIMITS.list_events)).toBe(500);
    expect(clampLimit(0, TOOL_LIMITS.list_events)).toBe(1);
    expect(clampLimit(-3, TOOL_LIMITS.list_events)).toBe(1);
    expect(clampLimit(7.9, TOOL_LIMITS.list_events)).toBe(7);
  });

  it('pins each tool limit (section 13.3 item 9)', () => {
    expect(TOOL_LIMITS).toEqual({
      list_shows: { def: 50, max: 200 },
      list_sessions: { def: 50, max: 200 },
      list_events: { def: 200, max: 500 },
      list_transcript_paragraphs: { def: 100, max: 300 },
      list_transcript_words: { def: 1000, max: 3000 },
      list_topics: { def: 200, max: 500 },
      list_wiki_pages: { def: 20, max: 50 },
    });
    expect(PAGE_MAX_CHARS).toBe(40_000);
  });
});

describe('cursors', () => {
  it('round-trips and refuses another tool, scope, version or key shape', () => {
    const c = encodeCursor('list_x', 'S1', 'k9', 3);
    expect(decodeCursor(c, 'list_x', 'S1', isStr)).toEqual({ key: 'k9', revision: 3 });
    const refuse = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(QueryError);
        expect((e as Error).message).toBe(INVALID_CURSOR);
        return;
      }
      throw new Error('accepted');
    };
    refuse(() => decodeCursor(c, 'list_y', 'S1', isStr));
    refuse(() => decodeCursor(c, 'list_x', 'S2', isStr));
    refuse(() => decodeCursor(c, 'list_x', 'S1', (k): k is number => typeof k === 'number'));
    refuse(() => decodeCursor('not base64!', 'list_x', 'S1', isStr));
    refuse(() => decodeCursor(Buffer.from('[]').toString('base64url'), 'list_x', 'S1', isStr));
    const v2 = Buffer.from(JSON.stringify({ v: 2, t: 'list_x', s: 'S1', k: 'a', r: 1 })).toString(
      'base64url',
    );
    refuse(() => decodeCursor(v2, 'list_x', 'S1', isStr));
  });
});

describe('buildPage', () => {
  const opts = (limit: number, total: number) => ({
    tool: 't',
    scope: 's',
    limit,
    total,
    revision: 1,
    keyOf: (r: { id: string }) => r.id,
  });
  const rows = (n: number, size: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `r${i}`, text: 'x'.repeat(size) }));

  it('ends a short read with no cursor and a full one with a cursor', () => {
    const short = buildPage(rows(2, 1), opts(5, 2));
    expect(short).toEqual({ items: rows(2, 1), next_cursor: null, total: 2, truncated: false });
    const full = buildPage(rows(5, 1), opts(5, 9));
    expect(full.next_cursor).not.toBeNull();
    expect(decodeCursor(full.next_cursor as string, 't', 's', isStr).key).toBe('r4');
  });

  it('stops at 40,000 characters with truncated set and the last included key', () => {
    const page = buildPage(rows(10, 9000), opts(10, 10));
    expect(page.truncated).toBe(true);
    expect(page.items.length).toBe(4);
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(PAGE_MAX_CHARS);
    expect(decodeCursor(page.next_cursor as string, 't', 's', isStr).key).toBe('r3');
  });

  it('skips one row over the cap on its own with a note, so the walk advances', () => {
    const page = buildPage([{ id: 'big', text: 'x'.repeat(50_000) }, ...rows(1, 1)], opts(5, 2));
    expect(page.items).toEqual([]);
    expect(page.truncated).toBe(true);
    expect(page.note).toBe(OVERSIZE_NOTE);
    expect(decodeCursor(page.next_cursor as string, 't', 's', isStr).key).toBe('big');
  });
});
