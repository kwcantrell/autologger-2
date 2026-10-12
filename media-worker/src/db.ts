// The worker's database side (media-worker design D1, D2): one postgres.js client as
// `autologger_media`, configured only by the five libpq variables compose sets (PGHOST, PGPORT,
// PGDATABASE, PGUSER, PGPASSWORD), which postgres.js reads itself. The queue statements are
// @autologger/storage's `mediaJobs` (the same module the API uses); the reads are the SELECTs
// the role is granted on `session_audio_segments` and `session_audio_seams`.

import type { MediaSql } from '@autologger/ports/media';
import { audioSeams } from '@autologger/storage/audioSeams';
import { postgresMediaSql } from '@autologger/storage/mediaJobs';
import postgres from 'postgres';
import type { SegmentRow, WorkerReads } from './jobs/types';

/** The role's connection limit is 4: two lanes share a pool of 2, LISTEN holds one more. */
const POOL = 2;

export interface WorkerDb {
  sql: postgres.Sql;
  db: MediaSql;
  listen(onWake: () => void): Promise<void>;
  close(): Promise<void>;
}

export function connectWorkerDb(): WorkerDb {
  const sql = postgres({
    max: POOL,
    idle_timeout: 60,
    connect_timeout: 30,
    prepare: true,
    onnotice: () => {},
    connection: { application_name: 'autologger-media-worker' },
  });
  return {
    sql,
    db: postgresMediaSql(sql),
    async listen(onWake) {
      // payload-free wake-up; the receiver re-reads the table (D2)
      await sql.listen('media_jobs', () => onWake());
    },
    close: () => sql.end({ timeout: 5 }),
  };
}

type Row = Record<string, unknown>;

const segmentFromRow = (r: Row): SegmentRow => ({
  id: String(r.id),
  ordinal: Number(r.ordinal),
  startedAtUtc: String(r.started_at_utc),
  endedAtUtc:
    r.ended_at_utc === null || r.ended_at_utc === undefined ? null : String(r.ended_at_utc),
  mimeType: String(r.mime_type),
  r2Key: String(r.r2_key),
});

const SEGMENT_COLS = 'id, ordinal, started_at_utc, ended_at_utc, mime_type, r2_key';

export function workerReads(db: MediaSql): WorkerReads {
  return {
    async segment(sessionId, id) {
      const [r] = await db.all<Row>(
        `SELECT ${SEGMENT_COLS} FROM session_audio_segments WHERE session_id = ? AND id = ?`,
        sessionId,
        id,
      );
      return r ? segmentFromRow(r) : null;
    },
    async recordingSegments(sessionId, recordingOrdinal) {
      const rows = await db.all<Row>(
        `SELECT ${SEGMENT_COLS} FROM session_audio_segments
          WHERE session_id = ? AND recording_ordinal = ?
          ORDER BY started_at_utc, ordinal, id`,
        sessionId,
        recordingOrdinal,
      );
      return rows.map(segmentFromRow);
    },
    recordingSeams: (sessionId, recordingOrdinal) =>
      audioSeams.windowsOf(db, sessionId, recordingOrdinal),
  };
}
