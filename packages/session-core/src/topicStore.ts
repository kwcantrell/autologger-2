// Topics domain — manual CRUD over session_topics. Moved verbatim out of
// the original single-file session spine.

import { isoZ } from '@autologger/domain';
import type { Row, SessionCore } from './sessionCore';
import { buildPatch, nextOrdinal } from './storeHelpers';

export interface Topic {
  id: string;
  session_time: string;
  duration_sec: number;
  topic_level: number;
  summary: string;
  ordinal: number;
  created_at_utc: string;
}

/** topicRow — pure row → Topic mapper. */
export function topicRow(r: Row): Topic {
  return {
    id: String(r.id),
    session_time: String(r.session_time ?? ''),
    duration_sec: Number(r.duration_sec ?? 0),
    topic_level: Number(r.topic_level ?? 1),
    summary: String(r.summary ?? ''),
    ordinal: Number(r.ordinal ?? 0),
    created_at_utc: String(r.created_at_utc ?? ''),
  };
}

export class TopicStore {
  constructor(private core: SessionCore) {}

  async listTopics(): Promise<Topic[]> {
    return (
      await this.core.all(
        'SELECT * FROM session_topics WHERE session_id = ? ORDER BY ordinal, id',
        this.core.sessionId,
      )
    ).map(topicRow);
  }

  private topic(topicId: string): Promise<Row | null> {
    return this.core.first(
      'SELECT * FROM session_topics WHERE session_id = ? AND id = ?',
      this.core.sessionId,
      topicId,
    );
  }

  async insertTopic(data: {
    session_time: string;
    duration_sec: number;
    topic_level: number;
    summary: string;
  }): Promise<Topic> {
    const id = crypto.randomUUID();
    const ordinal = await nextOrdinal(this.core, 'session_topics');
    await this.core.db.run(
      `INSERT INTO session_topics (session_id, id, session_time, duration_sec, topic_level, summary, ordinal, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      this.core.sessionId,
      id,
      data.session_time,
      data.duration_sec,
      data.topic_level,
      data.summary,
      ordinal,
      isoZ(new Date(this.core.now())),
    );
    return topicRow((await this.topic(id)) as Row);
  }

  async updateTopic(
    topicId: string,
    patch: { session_time?: string; duration_sec?: number; topic_level?: number; summary?: string },
  ): Promise<Topic | null> {
    const existing = await this.core.first(
      'SELECT 1 AS x FROM session_topics WHERE session_id = ? AND id = ?',
      this.core.sessionId,
      topicId,
    );
    if (existing === null) return null;
    const { cols, vals } = buildPatch(patch, [
      'session_time',
      'duration_sec',
      'topic_level',
      'summary',
    ] as const);
    if (cols.length) {
      await this.core.db.run(
        `UPDATE session_topics SET ${cols.join(', ')} WHERE session_id = ? AND id = ?`,
        ...vals,
        this.core.sessionId,
        topicId,
      );
    }
    return topicRow((await this.topic(topicId)) as Row);
  }

  async deleteTopic(topicId: string): Promise<boolean> {
    const r = await this.core.db.run(
      'DELETE FROM session_topics WHERE session_id = ? AND id = ?',
      this.core.sessionId,
      topicId,
    );
    return r.changes > 0;
  }

  /** Bulk delete by id (topic-generation design D3's crash-safe swap
   * primitive) — deletes ONLY the given ids, leaving every other topic row
   * untouched (ordinal/created_at/etc. unchanged). Empty array is a no-op
   * (no query issued). NOT a clear-all/restore path. One statement, the ids
   * as one JSON text bind (session-tables D5). */
  async deleteTopics(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.core.db.run(
      'DELETE FROM session_topics WHERE session_id = ? AND id IN (SELECT json_array_elements_text(?::text::json))',
      this.core.sessionId,
      JSON.stringify(ids),
    );
  }
}
