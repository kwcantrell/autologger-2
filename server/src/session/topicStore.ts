// Topics domain — manual CRUD over session_topics. Moved verbatim out of
// the original single-file session spine.

import { isoZ } from '../timecode';
import type { Row, SessionCore, SqlValue } from './sessionCore';

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

  listTopics(): Topic[] {
    return this.core.all('SELECT * FROM session_topics ORDER BY ordinal').map(topicRow);
  }

  insertTopic(data: {
    session_time: string;
    duration_sec: number;
    topic_level: number;
    summary: string;
  }): Topic {
    const id = crypto.randomUUID();
    const ordinal = Number(
      this.core.first('SELECT COALESCE(MAX(ordinal), -1) + 1 AS n FROM session_topics')?.n ?? 0,
    );
    this.core.db.exec(
      `INSERT INTO session_topics (id, session_time, duration_sec, topic_level, summary, ordinal, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      data.session_time,
      data.duration_sec,
      data.topic_level,
      data.summary,
      ordinal,
      isoZ(new Date()),
    );
    return topicRow(this.core.first('SELECT * FROM session_topics WHERE id = ?', id) as Row);
  }

  updateTopic(
    topicId: string,
    patch: { session_time?: string; duration_sec?: number; topic_level?: number; summary?: string },
  ): Topic | null {
    const existing = this.core.first('SELECT * FROM session_topics WHERE id = ?', topicId);
    if (existing === null) return null;
    const cols: string[] = [];
    const vals: SqlValue[] = [];
    for (const key of ['session_time', 'duration_sec', 'topic_level', 'summary'] as const) {
      if (patch[key] !== undefined) {
        cols.push(`${key} = ?`);
        vals.push(patch[key] as SqlValue);
      }
    }
    if (cols.length) {
      this.core.db.exec(
        `UPDATE session_topics SET ${cols.join(', ')} WHERE id = ?`,
        ...vals,
        topicId,
      );
    }
    return topicRow(this.core.first('SELECT * FROM session_topics WHERE id = ?', topicId) as Row);
  }

  deleteTopic(topicId: string): boolean {
    const r = this.core.db.exec('DELETE FROM session_topics WHERE id = ?', topicId);
    return r.rowsWritten > 0;
  }
}
