// Recording seams (OpenSpec change `media-worker`, design D7, D18): the AudioSeamsPort over
// `catalog.session_audio_seams`, one row per accepted chunk window, keyed by `(session_id,
// recording_ordinal, started_at_utc)`. The segment POST looks a window up before storing anything
// and inserts its seam with the segment row (a duplicate from a concurrent upload fails with
// `23505`, which the caller answers with the existing segment); the merge apply repoints a
// recording's windows at the merged segment with each window's media offset. Runs in the caller's
// transaction (`MediaSql`); `?` placeholders, unqualified names.

import type { AudioSeam, AudioSeamsPort } from '@autologger/ports/media';

type Row = Record<string, unknown>;

export function audioSeamFromRow(r: Row): AudioSeam {
  return {
    sessionId: String(r.session_id),
    recordingOrdinal: Number(r.recording_ordinal),
    startedAtUtc: String(r.started_at_utc),
    endedAtUtc:
      r.ended_at_utc === null || r.ended_at_utc === undefined ? null : String(r.ended_at_utc),
    segmentId: String(r.segment_id),
    offsetMs: Number(r.offset_ms),
    sourceKey: String(r.source_key),
  };
}

const COLUMNS =
  'session_id, recording_ordinal, started_at_utc, ended_at_utc, segment_id, offset_ms, source_key';

export const audioSeams: AudioSeamsPort = {
  async insert(db, s) {
    await db.run(
      `INSERT INTO session_audio_seams (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      s.sessionId,
      s.recordingOrdinal,
      s.startedAtUtc,
      s.endedAtUtc,
      s.segmentId,
      s.offsetMs,
      s.sourceKey,
    );
  },

  async findWindow(db, sessionId, recordingOrdinal, startedAtUtc) {
    const [r] = await db.all<Row>(
      `SELECT ${COLUMNS} FROM session_audio_seams
        WHERE session_id = ? AND recording_ordinal = ? AND started_at_utc = ?`,
      sessionId,
      recordingOrdinal,
      startedAtUtc,
    );
    return r ? audioSeamFromRow(r) : null;
  },

  async windowsOf(db, sessionId, recordingOrdinal) {
    const rows = await db.all<Row>(
      `SELECT ${COLUMNS} FROM session_audio_seams
        WHERE session_id = ? AND recording_ordinal = ? ORDER BY started_at_utc`,
      sessionId,
      recordingOrdinal,
    );
    return rows.map(audioSeamFromRow);
  },

  async seamsOfSegment(db, sessionId, segmentId) {
    const rows = await db.all<Row>(
      `SELECT ${COLUMNS} FROM session_audio_seams
        WHERE session_id = ? AND segment_id = ? ORDER BY offset_ms, started_at_utc`,
      sessionId,
      segmentId,
    );
    return rows.map(audioSeamFromRow);
  },

  async repoint(db, sessionId, recordingOrdinal, segmentId, windows) {
    if (windows.length === 0) return 0;
    const values = windows.map(() => '(?::text, ?::bigint)').join(', ');
    const { changes } = await db.run(
      `UPDATE session_audio_seams AS s SET segment_id = ?, offset_ms = v.offset_ms
         FROM (VALUES ${values}) AS v (started_at_utc, offset_ms)
        WHERE s.session_id = ? AND s.recording_ordinal = ? AND s.started_at_utc = v.started_at_utc`,
      segmentId,
      ...windows.flatMap((w) => [w.startedAtUtc, w.offsetMs]),
      sessionId,
      recordingOrdinal,
    );
    return changes;
  },
};
