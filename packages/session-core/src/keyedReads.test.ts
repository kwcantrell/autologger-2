// The keyed reads behind `/mcp`'s list tools (custom session dashboards J5; design 5.2;
// mcp-session-data "Keyed session reads"): every statement a page sends either reads at most
// `limit` rows (a `LIMIT` bound to the page's limit) or counts, in the store's own order, so no
// page reads a whole transcript, topic list or event log.

import { describe, expect, it } from 'vitest';
import { EventStore } from './eventStore';
import type { SessionCore, SqlValue } from './sessionCore';
import { TopicStore } from './topicStore';
import { TranscriptStore } from './transcriptStore';

interface Sent {
  sql: string;
  binds: SqlValue[];
}

/** A core that records each statement and answers with no rows (a count answers 0). */
function recordingCore(): { core: SessionCore; sent: Sent[] } {
  const sent: Sent[] = [];
  const all = async (sql: string, ...binds: SqlValue[]) => {
    sent.push({ sql: sql.replace(/\s+/g, ' ').trim(), binds });
    return /COUNT\(\*\)/i.test(sql) ? [{ c: 0 }] : [];
  };
  const core = {
    sessionId: 'S1',
    all,
    first: async (sql: string, ...binds: SqlValue[]) => (await all(sql, ...binds))[0] ?? null,
    eventCounts: async () => {
      sent.push({
        sql: 'SELECT COUNT(*) AS c FROM session_events WHERE session_id = ?',
        binds: ['S1'],
      });
      return { total: 0, logged: 0 };
    },
    revision: async () => 7,
  } as unknown as SessionCore;
  return { core, sent };
}

/** Every row-reading statement is limited to `limit`; the rest are counts. */
function expectBounded(sent: Sent[], table: string, limit: number, order: string) {
  const reads = sent.filter((s) => !/COUNT\(\*\)/i.test(s.sql));
  expect(reads.length).toBe(1);
  const read = reads[0] as Sent;
  expect(read.sql).toContain(`FROM ${table} WHERE session_id = ?`);
  expect(read.sql).toContain(`ORDER BY ${order} LIMIT ?`);
  expect(read.binds.at(-1)).toBe(limit);
  for (const s of sent) expect(s.sql).toMatch(/LIMIT \?$|COUNT\(\*\)/);
}

describe('keyed reads send one bounded read per page', () => {
  it('events: (wall_time_utc, id), from the start and after a key', async () => {
    for (const after of [null, { wall_time_utc: '2026-01-01T00:00:00.000Z', id: 'e1' }]) {
      const { core, sent } = recordingCore();
      const out = await new EventStore(core).listEventsAfter({ after, limit: 25 });
      expect(out.revision).toBe(7);
      expectBounded(sent, 'session_events', 25, 'wall_time_utc, id');
      if (after) {
        expect(sent[0]?.sql).toContain('(wall_time_utc, id) > (?::text, ?::text)');
        expect(sent[0]?.binds).toEqual(['S1', after.wall_time_utc, after.id, 25]);
      }
    }
  });

  it('words and paragraphs: (ordinal, id)', async () => {
    for (const after of [null, { ordinal: 4, id: 'w4' }]) {
      let rec = recordingCore();
      await new TranscriptStore(rec.core).listTranscriptWordsAfter({ after, limit: 300 });
      expectBounded(rec.sent, 'session_transcript_words', 300, 'ordinal, id');
      rec = recordingCore();
      await new TranscriptStore(rec.core).listTranscriptParagraphsAfter({ after, limit: 30 });
      expectBounded(rec.sent, 'session_transcript_paragraphs', 30, 'ordinal, id');
      if (after) expect(rec.sent[0]?.sql).toContain('(ordinal, id) > (?::bigint, ?::text)');
    }
  });

  it('topics: (ordinal, id)', async () => {
    const { core, sent } = recordingCore();
    await new TopicStore(core).listTopicsAfter({ after: { ordinal: 2, id: 't2' }, limit: 9 });
    expectBounded(sent, 'session_topics', 9, 'ordinal, id');
  });
});
