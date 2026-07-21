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

/** A generation-run paragraph (spec "Enrichment persistence and internal
 * read", design D3). `start_sec`/`end_sec` are nullable — NULL means "no
 * timeline position" (anchorless), distinct from a genuine `0`. */
export interface TranscriptParagraph {
  id: string;
  start_sec: number | null;
  end_sec: number | null;
  speaker: string;
  text: string;
  ordinal: number;
  created_at_utc: string;
}

/** A generation-run sentiment segment (spec "Enrichment persistence and
 * internal read", design D3). Same nullable-seconds convention as
 * `TranscriptParagraph`. */
export interface TranscriptSentimentSegment {
  id: string;
  start_sec: number | null;
  end_sec: number | null;
  sentiment: string;
  sentiment_score: number;
  text: string;
  ordinal: number;
  created_at_utc: string;
}

/** paragraphRow — pure row → TranscriptParagraph mapper. NULL-preserving:
 * a NULL start_sec/end_sec column reads back as `null`, never coerced to 0
 * (the never-zeros-as-data contract; `Number(x ?? 0)` would break it). */
export function paragraphRow(r: Row): TranscriptParagraph {
  return {
    id: String(r.id),
    start_sec: r.start_sec === null || r.start_sec === undefined ? null : Number(r.start_sec),
    end_sec: r.end_sec === null || r.end_sec === undefined ? null : Number(r.end_sec),
    speaker: String(r.speaker ?? ''),
    text: String(r.text ?? ''),
    ordinal: Number(r.ordinal ?? 0),
    created_at_utc: String(r.created_at_utc ?? ''),
  };
}

/** sentimentRow — pure row → TranscriptSentimentSegment mapper. Same
 * NULL-preserving convention as `paragraphRow`. */
export function sentimentRow(r: Row): TranscriptSentimentSegment {
  return {
    id: String(r.id),
    start_sec: r.start_sec === null || r.start_sec === undefined ? null : Number(r.start_sec),
    end_sec: r.end_sec === null || r.end_sec === undefined ? null : Number(r.end_sec),
    sentiment: String(r.sentiment ?? ''),
    sentiment_score: Number(r.sentiment_score ?? 0),
    text: String(r.text ?? ''),
    ordinal: Number(r.ordinal ?? 0),
    created_at_utc: String(r.created_at_utc ?? ''),
  };
}

/** Enrichment payload accepted by `replaceTranscriptWords` (design D4/D5).
 * Keys match the hub-read shape (`sentiment`, singular) so a router can pass
 * `remapTranscriptEnrichment(...)`'s output straight through. */
export interface TranscriptEnrichmentInput {
  paragraphs: Array<{
    start_sec: number | null;
    end_sec: number | null;
    speaker: string;
    text: string;
  }>;
  sentiment: Array<{
    start_sec: number | null;
    end_sec: number | null;
    sentiment: string;
    sentiment_score: number;
    text: string;
  }>;
}

const EMPTY_ENRICHMENT: TranscriptEnrichmentInput = { paragraphs: [], sentiment: [] };

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
      isoZ(new Date(this.core.now())),
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

  /** Replace the entire transcript-words set **and its persisted
   * enrichment** in one delete-then-insert pass across all three tables
   * (design D4/D10 / spec "Regeneration replaces the transcript atomically").
   * The caller (SessionHub) wraps this in a transaction; this method's body
   * itself has no transaction boundary of its own — it is the **only**
   * writer for enrichment (spec: "MUST NOT be a second writer"). Ordinals
   * are assigned contiguously from 0 by **array position** within each of
   * `words`/`enrichment.paragraphs`/`enrichment.sentiment` — callers (the
   * transcript-generation remapper) must pass each pre-sorted into its
   * final order; this method never re-sorts. `enrichment` defaults to empty,
   * so a replace with no enrichment argument clears any prior enrichment
   * (correct: enrichment is a snapshot of the run that produced it). */
  replaceTranscriptWords(
    words: Array<{
      session_time: string;
      speaker: string;
      word: string;
      start_sec: number;
      end_sec: number;
    }>,
    enrichment: TranscriptEnrichmentInput = EMPTY_ENRICHMENT,
  ): TranscriptWord[] {
    this.core.db.run('DELETE FROM session_transcript_words');
    this.core.db.run('DELETE FROM session_transcript_paragraphs');
    this.core.db.run('DELETE FROM session_transcript_sentiment');
    const createdAt = isoZ(new Date(this.core.now()));
    words.forEach((w, ordinal) => {
      this.core.db.run(
        `INSERT INTO session_transcript_words
           (id, session_time, speaker, word, start_sec, end_sec, ordinal, created_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        w.session_time,
        w.speaker,
        w.word,
        w.start_sec,
        w.end_sec,
        ordinal,
        createdAt,
      );
    });
    enrichment.paragraphs.forEach((p, ordinal) => {
      this.core.db.run(
        `INSERT INTO session_transcript_paragraphs
           (id, start_sec, end_sec, speaker, text, ordinal, created_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        p.start_sec,
        p.end_sec,
        p.speaker,
        p.text,
        ordinal,
        createdAt,
      );
    });
    enrichment.sentiment.forEach((s, ordinal) => {
      this.core.db.run(
        `INSERT INTO session_transcript_sentiment
           (id, start_sec, end_sec, sentiment, sentiment_score, text, ordinal, created_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        s.start_sec,
        s.end_sec,
        s.sentiment,
        s.sentiment_score,
        s.text,
        ordinal,
        createdAt,
      );
    });
    return this.listTranscriptWords();
  }

  /** Synchronous read of the last generation run's persisted enrichment
   * (design D5 / spec "Enrichment persistence and internal read"). Both
   * arrays are already in deterministic ordinal order; a never-generated
   * session (or one whose last run produced no enrichment) reads as empty
   * arrays, never an error. */
  listTranscriptEnrichment(): {
    paragraphs: TranscriptParagraph[];
    sentiment: TranscriptSentimentSegment[];
  } {
    return {
      paragraphs: this.core
        .all('SELECT * FROM session_transcript_paragraphs ORDER BY ordinal')
        .map(paragraphRow),
      sentiment: this.core
        .all('SELECT * FROM session_transcript_sentiment ORDER BY ordinal')
        .map(sentimentRow),
    };
  }
}
