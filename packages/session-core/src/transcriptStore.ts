// Transcript-words domain — manual CRUD over session_transcript_words
// (generation is stubbed in the router). Moved verbatim out of the original single-file session spine.

import { isoZ } from '@autologger/domain';
import type { Row, SessionCore } from './sessionCore';
import { buildPatch, nextOrdinal } from './storeHelpers';

export interface TranscriptWord {
  id: string;
  session_time: string;
  speaker: string;
  word: string;
  start_sec: number;
  end_sec: number;
  ordinal: number;
  created_at_utc: string;
  /** session-row-versions D3: 1 when created, plus one per change. */
  version: number;
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
    version: Number(r.version ?? 1),
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

  async listTranscriptWords(): Promise<TranscriptWord[]> {
    return (
      await this.core.all(
        'SELECT * FROM session_transcript_words WHERE session_id = ? ORDER BY ordinal, id',
        this.core.sessionId,
      )
    ).map(wordRow);
  }

  private word(wordId: string): Promise<Row | null> {
    return this.core.first(
      'SELECT * FROM session_transcript_words WHERE session_id = ? AND id = ?',
      this.core.sessionId,
      wordId,
    );
  }

  async insertTranscriptWord(data: {
    session_time: string;
    speaker: string;
    word: string;
  }): Promise<TranscriptWord> {
    const id = crypto.randomUUID();
    const ordinal = await nextOrdinal(this.core, 'session_transcript_words');
    await this.core.db.run(
      `INSERT INTO session_transcript_words (session_id, id, session_time, speaker, word, ordinal, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      this.core.sessionId,
      id,
      data.session_time,
      data.speaker,
      data.word,
      ordinal,
      isoZ(new Date(this.core.now())),
    );
    return wordRow((await this.word(id)) as Row);
  }

  async updateTranscriptWord(
    wordId: string,
    patch: { session_time?: string; speaker?: string; word?: string },
  ): Promise<TranscriptWord | null> {
    const existing = await this.core.first(
      'SELECT 1 AS x FROM session_transcript_words WHERE session_id = ? AND id = ?',
      this.core.sessionId,
      wordId,
    );
    if (existing === null) return null;
    const { cols, vals } = buildPatch(patch, ['session_time', 'speaker', 'word'] as const);
    if (cols.length) {
      await this.core.db.run(
        `UPDATE session_transcript_words SET ${cols.join(', ')}, version = version + 1 WHERE session_id = ? AND id = ?`,
        ...vals,
        this.core.sessionId,
        wordId,
      );
    }
    return wordRow((await this.word(wordId)) as Row);
  }

  async deleteTranscriptWord(wordId: string): Promise<boolean> {
    const r = await this.core.db.run(
      'DELETE FROM session_transcript_words WHERE session_id = ? AND id = ?',
      this.core.sessionId,
      wordId,
    );
    return r.changes > 0;
  }

  /** Replace the entire transcript-words set **and its persisted
   * enrichment** in one delete-then-insert pass across all three tables, the
   * session's rows only
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
  async replaceTranscriptWords(
    words: Array<{
      session_time: string;
      speaker: string;
      word: string;
      start_sec: number;
      end_sec: number;
    }>,
    enrichment: TranscriptEnrichmentInput = EMPTY_ENRICHMENT,
  ): Promise<TranscriptWord[]> {
    const sid = this.core.sessionId;
    await this.core.db.run('DELETE FROM session_transcript_words WHERE session_id = ?', sid);
    await this.core.db.run('DELETE FROM session_transcript_paragraphs WHERE session_id = ?', sid);
    await this.core.db.run('DELETE FROM session_transcript_sentiment WHERE session_id = ?', sid);
    const createdAt = isoZ(new Date(this.core.now()));
    // One statement per table, the rows as one JSON text bind (session-tables D5, A8): ids drawn
    // here, ordinals by array position.
    if (words.length > 0) {
      await this.core.db.run(
        `INSERT INTO session_transcript_words
           (session_id, id, session_time, speaker, word, start_sec, end_sec, ordinal, created_at_utc)
         SELECT ?, r.id, r.session_time, r.speaker, r.word, r.start_sec, r.end_sec, r.ordinal, ?
         FROM json_to_recordset(?::text::json) AS r(id text, session_time text, speaker text,
           word text, start_sec double precision, end_sec double precision, ordinal bigint)`,
        sid,
        createdAt,
        JSON.stringify(
          words.map((w, ordinal) => ({
            id: crypto.randomUUID(),
            session_time: w.session_time,
            speaker: w.speaker,
            word: w.word,
            start_sec: w.start_sec,
            end_sec: w.end_sec,
            ordinal,
          })),
        ),
      );
    }
    if (enrichment.paragraphs.length > 0) {
      await this.core.db.run(
        `INSERT INTO session_transcript_paragraphs
           (session_id, id, start_sec, end_sec, speaker, text, ordinal, created_at_utc)
         SELECT ?, r.id, r.start_sec, r.end_sec, r.speaker, r.text, r.ordinal, ?
         FROM json_to_recordset(?::text::json) AS r(id text, start_sec double precision,
           end_sec double precision, speaker text, text text, ordinal bigint)`,
        sid,
        createdAt,
        JSON.stringify(
          enrichment.paragraphs.map((p, ordinal) => ({
            id: crypto.randomUUID(),
            start_sec: p.start_sec,
            end_sec: p.end_sec,
            speaker: p.speaker,
            text: p.text,
            ordinal,
          })),
        ),
      );
    }
    if (enrichment.sentiment.length > 0) {
      await this.core.db.run(
        `INSERT INTO session_transcript_sentiment
           (session_id, id, start_sec, end_sec, sentiment, sentiment_score, text, ordinal, created_at_utc)
         SELECT ?, r.id, r.start_sec, r.end_sec, r.sentiment, r.sentiment_score, r.text, r.ordinal, ?
         FROM json_to_recordset(?::text::json) AS r(id text, start_sec double precision,
           end_sec double precision, sentiment text, sentiment_score double precision, text text,
           ordinal bigint)`,
        sid,
        createdAt,
        JSON.stringify(
          enrichment.sentiment.map((x, ordinal) => ({
            id: crypto.randomUUID(),
            start_sec: x.start_sec,
            end_sec: x.end_sec,
            sentiment: x.sentiment,
            sentiment_score: x.sentiment_score,
            text: x.text,
            ordinal,
          })),
        ),
      );
    }
    return this.listTranscriptWords();
  }

  /** Read of the last generation run's persisted enrichment
   * (design D5 / spec "Enrichment persistence and internal read"). Both
   * arrays are already in deterministic ordinal order; a never-generated
   * session (or one whose last run produced no enrichment) reads as empty
   * arrays, never an error. */
  async listTranscriptEnrichment(): Promise<{
    paragraphs: TranscriptParagraph[];
    sentiment: TranscriptSentimentSegment[];
  }> {
    const paragraphs = await this.core.all(
      'SELECT * FROM session_transcript_paragraphs WHERE session_id = ? ORDER BY ordinal, id',
      this.core.sessionId,
    );
    const sentiment = await this.core.all(
      'SELECT * FROM session_transcript_sentiment WHERE session_id = ? ORDER BY ordinal, id',
      this.core.sessionId,
    );
    return { paragraphs: paragraphs.map(paragraphRow), sentiment: sentiment.map(sentimentRow) };
  }
}
