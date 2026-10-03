// A session without a catalog row (session-tables design D1, D9; core-ports-architecture "A write
// to an unknown session is refused"): the hub does not open, nothing is stored, and the database
// refuses a content row for it.

import { SessionNotFoundError } from '@autologger/storage';
import { describe, expect, it } from 'vitest';
import { catalogRoot, testRegistry } from './sessionRows';

const TABLES = [
  'session_events',
  'session_transport',
  'session_audio_segments',
  'session_transcript_words',
  'session_topics',
  'session_transcript_paragraphs',
  'session_transcript_sentiment',
  'session_dashboards',
  'session_meta',
];

describe('an unknown session', () => {
  it('get rejects with SessionNotFoundError, leaves no row, and the registry keeps nothing', async () => {
    const registry = testRegistry();
    await expect(registry.get('no-such-session')).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(registry.get('no-such-session')).rejects.toBeInstanceOf(SessionNotFoundError);
    const db = catalogRoot().bindSystem('test');
    for (const table of TABLES) {
      expect(
        await db.all(`SELECT 1 FROM ${table} WHERE session_id = ?`, 'no-such-session'),
        table,
      ).toEqual([]);
    }
    await registry.closeAll();
  });

  it('a raw catalog_system insert of a content row for it fails 23503', async () => {
    const db = catalogRoot().bindSystem('test');
    await expect(
      db.run(
        "INSERT INTO session_meta (session_id, key, value) VALUES (?, 'k', 'v')",
        'no-such-session',
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});
