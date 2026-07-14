// Transcript-words domain — manual CRUD over session_transcript_words
// (generation is stubbed in the router). Moved verbatim out of the original single-file session spine.

import { isoZ } from '../timecode';
import type { Row, SessionCore, SqlValue } from './sessionCore';

export interface TranscriptWord {
  id: string;
  session_time: string;
  speaker: string;
  word: string;
  start_sec: number;
  end_sec: number;
  ordinal: number;
  created_at_utc: string;
}

/** wordRow — pure row → TranscriptWord mapper. */
export function wordRow(r: Row): TranscriptWord {
  return {
    id: String(r.id),
    session_time: String(r.session_time ?? ''),
    speaker: String(r.speaker ?? ''),
    word: String(r.word ?? ''),
    start_sec: Number(r.start_sec ?? 0),
    end_sec: Number(r.end_sec ?? 0),
    ordinal: Number(r.ordinal ?? 0),
    created_at_utc: String(r.created_at_utc ?? ''),
  };
}

export class TranscriptStore {
  constructor(private core: SessionCore) {}

  listTranscriptWords(): TranscriptWord[] {
    return this.core.all('SELECT * FROM session_transcript_words ORDER BY ordinal').map(wordRow);
  }

  insertTranscriptWord(data: {
    session_time: string;
    speaker: string;
    word: string;
  }): TranscriptWord {
    const id = crypto.randomUUID();
    const ordinal = Number(
      this.core.first(
        'SELECT COALESCE(MAX(ordinal), -1) + 1 AS n FROM session_transcript_words',
      )?.n ?? 0,
    );
    this.core.db.run(
      `INSERT INTO session_transcript_words (id, session_time, speaker, word, ordinal, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      data.session_time,
      data.speaker,
      data.word,
      ordinal,
      isoZ(new Date()),
    );
    return wordRow(
      this.core.first('SELECT * FROM session_transcript_words WHERE id = ?', id) as Row,
    );
  }

  updateTranscriptWord(
    wordId: string,
    patch: { session_time?: string; speaker?: string; word?: string },
  ): TranscriptWord | null {
    const existing = this.core.first('SELECT * FROM session_transcript_words WHERE id = ?', wordId);
    if (existing === null) return null;
    const cols: string[] = [];
    const vals: SqlValue[] = [];
    for (const key of ['session_time', 'speaker', 'word'] as const) {
      if (patch[key] !== undefined) {
        cols.push(`${key} = ?`);
        vals.push(patch[key] as string);
      }
    }
    if (cols.length) {
      this.core.db.run(
        `UPDATE session_transcript_words SET ${cols.join(', ')} WHERE id = ?`,
        ...vals,
        wordId,
      );
    }
    return wordRow(
      this.core.first('SELECT * FROM session_transcript_words WHERE id = ?', wordId) as Row,
    );
  }

  deleteTranscriptWord(wordId: string): boolean {
    const r = this.core.db.run('DELETE FROM session_transcript_words WHERE id = ?', wordId);
    return r.changes > 0;
  }
}
