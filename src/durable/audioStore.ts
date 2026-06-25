// Audio-segment metadata domain — rows in session_audio_segments; the audio
// bytes themselves live in R2 (the Worker owns the binding). Moved verbatim out
// of SessionDO.ts.

import { isoZ } from '../timecode';
import type { Row, SessionCore } from './sessionCore';

export interface AudioSegmentMeta {
  id: string;
  ordinal: number;
  started_at_utc: string | null;
  ended_at_utc: string | null;
  mime_type: string;
  r2_key: string;
  recording_ordinal: number | null;
  waveform_peaks: number[] | null;
  waveform_db_floor: number | null;
}

/** audioRowToMeta — pure segment-row → meta mapper (was SessionDO.audioRowToMeta). */
export function audioRowToMeta(r: Row): AudioSegmentMeta {
  let peaks: number[] | null = null;
  const wf = r.waveform_peaks_json;
  if (wf) {
    try {
      const parsed = JSON.parse(String(wf));
      if (Array.isArray(parsed) && parsed.length) peaks = parsed.map((x) => Number(x));
    } catch {
      peaks = null;
    }
  }
  const floor = r.waveform_db_floor;
  const ro = r.recording_ordinal;
  return {
    id: String(r.id),
    ordinal: Number(r.ordinal),
    started_at_utc: (r.started_at_utc as string | null) ?? null,
    ended_at_utc: (r.ended_at_utc as string | null) ?? null,
    mime_type: String(r.mime_type),
    r2_key: String(r.r2_key),
    recording_ordinal: ro === null || ro === undefined ? null : Number(ro),
    waveform_peaks: peaks,
    waveform_db_floor: floor === null || floor === undefined ? null : Number(floor),
  };
}

export class AudioStore {
  constructor(private core: SessionCore) {}

  addAudioSegment(input: {
    sessionId: string;
    mimeType: string;
    startedAtUtc: string | null;
    endedAtUtc: string | null;
    recordingOrdinal: number | null;
  }): AudioSegmentMeta {
    const segId = crypto.randomUUID();
    const mt = (input.mimeType || 'audio/webm').toLowerCase();
    let ext = 'webm';
    if (mt.includes('ogg')) ext = 'ogg';
    else if (mt.includes('wav')) ext = 'wav';
    else if (mt.includes('mp4') || mt.includes('m4a')) ext = 'm4a';
    const ordinal = Number(
      this.core.first('SELECT COALESCE(MAX(ordinal), 0) + 1 AS n FROM session_audio_segments')?.n ??
        1,
    );
    const r2Key = `audio/${input.sessionId}/${String(ordinal).padStart(4, '0')}_${segId}.${ext}`;
    let ro: number | null = null;
    if (input.recordingOrdinal !== null && Number.isFinite(input.recordingOrdinal)) {
      const ri = Math.trunc(input.recordingOrdinal);
      if (ri >= 1) ro = ri;
    }
    this.core.db.exec(
      `INSERT INTO session_audio_segments
         (id, ordinal, started_at_utc, ended_at_utc, mime_type, r2_key, recording_ordinal, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      segId,
      ordinal,
      input.startedAtUtc,
      input.endedAtUtc,
      input.mimeType || 'audio/webm',
      r2Key,
      ro,
      isoZ(new Date()),
    );
    this.core.broadcast({ type: 'audio.changed' });
    return {
      id: segId,
      ordinal,
      started_at_utc: input.startedAtUtc,
      ended_at_utc: input.endedAtUtc,
      mime_type: input.mimeType || 'audio/webm',
      r2_key: r2Key,
      recording_ordinal: ro,
      waveform_peaks: null,
      waveform_db_floor: null,
    };
  }

  listAudioSegments(): AudioSegmentMeta[] {
    const rows = this.core.all('SELECT * FROM session_audio_segments ORDER BY ordinal ASC');
    return rows.map((r) => audioRowToMeta(r));
  }

  deleteAudioSegment(segmentId: string): void {
    this.core.db.exec('DELETE FROM session_audio_segments WHERE id = ?', segmentId);
  }

  getAudioSegmentKey(segmentId: string): { r2_key: string; mime_type: string } | null {
    const r = this.core.first(
      'SELECT r2_key, mime_type FROM session_audio_segments WHERE id = ?',
      segmentId,
    );
    return r ? { r2_key: String(r.r2_key), mime_type: String(r.mime_type) } : null;
  }

  setAudioSegmentWaveform(input: { segmentId: string; peaks: number[] }): boolean {
    const blob = JSON.stringify(input.peaks);
    const r = this.core.db.exec(
      'UPDATE session_audio_segments SET waveform_peaks_json = ?, waveform_db_floor = ? WHERE id = ?',
      blob,
      -48.0,
      input.segmentId,
    );
    if (r.rowsWritten > 0) this.core.broadcast({ type: 'audio.changed' });
    return r.rowsWritten > 0;
  }

  /** Reconcile metadata against the R2 keys the Worker found under the session prefix. */
  syncAudioFromR2(known: Array<{ r2_key: string; ordinal: number }>): {
    inserted: number;
  } {
    let inserted = 0;
    const now = isoZ(new Date());
    for (const k of known) {
      const exists = this.core.first(
        'SELECT 1 AS x FROM session_audio_segments WHERE r2_key = ?',
        k.r2_key,
      );
      if (exists !== null) continue;
      const m = /\/(\d{4})_([0-9a-f-]{36})\.(webm|ogg|wav|m4a)$/i.exec(k.r2_key);
      if (m === null) continue;
      const segId = m[2];
      const ext = m[3].toLowerCase();
      const mime =
        ext === 'ogg'
          ? 'audio/ogg'
          : ext === 'wav'
            ? 'audio/wav'
            : ext === 'm4a'
              ? 'audio/mp4'
              : 'audio/webm';
      this.core.db.exec(
        `INSERT INTO session_audio_segments
           (id, ordinal, started_at_utc, ended_at_utc, mime_type, r2_key, recording_ordinal, created_at_utc)
         VALUES (?, ?, NULL, NULL, ?, ?, NULL, ?)`,
        segId,
        k.ordinal,
        mime,
        k.r2_key,
        now,
      );
      inserted += 1;
    }
    return { inserted };
  }
}
