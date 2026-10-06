// Topics domain — manual CRUD over session_topics. Moved verbatim out of
// the original single-file session spine.

import { isoZ } from '@autologger/domain';
import type { Row, SessionCore, VersionExpectation } from './sessionCore';
import { buildPatch, nextOrdinal, staleVersion } from './storeHelpers';

export interface Topic {
  id: string;
  session_time: string;
  duration_sec: number;
  topic_level: number;
  summary: string;
  ordinal: number;
  created_at_utc: string;
  /** session-row-versions D3: 1 when created, plus one per change. */
  version: number;
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
    version: Number(r.version ?? 1),
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

  /** With `expect` (session-row-versions D4), a stale version returns the stored topic as a
   * conflict and writes nothing; with `expect.overwrite`, a patch that changes the row is audited
   * (D5). A patch with no fields writes nothing and records nothing. */
  async updateTopic(
    topicId: string,
    patch: { session_time?: string; duration_sec?: number; topic_level?: number; summary?: string },
    expect?: VersionExpectation,
  ): Promise<Topic | { conflict: Topic } | null> {
    const existing = await this.topic(topicId);
    if (existing === null) return null;
    if (staleVersion(expect, existing)) return { conflict: topicRow(existing) };
    const { cols, vals } = buildPatch(patch, [
      'session_time',
      'duration_sec',
      'topic_level',
      'summary',
    ] as const);
    if (cols.length === 0) return topicRow(existing);
    await this.core.db.run(
      `UPDATE session_topics SET ${cols.join(', ')}, version = version + 1 WHERE session_id = ? AND id = ?`,
      ...vals,
      this.core.sessionId,
      topicId,
    );
    const fresh = topicRow((await this.topic(topicId)) as Row);
    if (expect?.overwrite) {
      await this.core.recordOverwrite({
        table: 'session_topics',
        rowId: topicId,
        replacedVersion: Number(existing.version),
        before: topicRow(existing),
        after: fresh,
      });
    }
    return fresh;
  }

  /** With `expect` (session-row-versions D4), a stale version returns the stored topic as a
   * conflict and deletes nothing; with `expect.overwrite`, the delete is audited (D5). */
  async deleteTopic(topicId: string, expect?: VersionExpectation): Promise<boolean | { conflict: Topic }> {
    if (expect === undefined) {
      const r = await this.core.db.run(
        'DELETE FROM session_topics WHERE session_id = ? AND id = ?',
        this.core.sessionId,
        topicId,
      );
      return r.changes > 0;
    }
    const existing = await this.topic(topicId);
    if (existing === null) return false;
    if (staleVersion(expect, existing)) return { conflict: topicRow(existing) };
    await this.core.db.run(
      'DELETE FROM session_topics WHERE session_id = ? AND id = ?',
      this.core.sessionId,
      topicId,
    );
    if (expect.overwrite) {
      await this.core.recordOverwrite({
        table: 'session_topics',
        rowId: topicId,
        replacedVersion: Number(existing.version),
        before: topicRow(existing),
        after: null,
      });
    }
    return true;
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
