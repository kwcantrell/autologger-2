// Audio-segment metadata domain — rows in session_audio_segments; the audio
// bytes themselves live in the blob store (the router layer owns it). Moved
// verbatim out of the original single-file session spine.

import { isoZ } from '@autologger/domain';
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

/** audioRowToMeta — pure segment-row → meta mapper. */
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

/** ONE bidirectional mime↔ext table (code-health-tail D12), replacing the
 * mime→ext if/else chain in addAudioSegment and the ext→mime nested ternary
 * in the blob-scan backfill. `tokens` are the mime substrings probed in
 * declaration order (matching the original chain: ogg, wav, then mp4/m4a);
 * `mime` is the canonical type the backfill restores for that extension.
 * webm is the fallback in both directions. */
const AUDIO_FORMATS = [
  { ext: 'ogg', tokens: ['ogg'], mime: 'audio/ogg' },
  { ext: 'wav', tokens: ['wav'], mime: 'audio/wav' },
  { ext: 'mp3', tokens: ['mp3', 'mpeg'], mime: 'audio/mpeg' },
  { ext: 'aiff', tokens: ['aif'], mime: 'audio/aiff' },
  { ext: 'm4a', tokens: ['mp4', 'm4a'], mime: 'audio/mp4' },
] as const;
const FALLBACK_FORMAT = { ext: 'webm', mime: 'audio/webm' } as const;

function extForMime(mimeType: string): string {
  const mt = mimeType.toLowerCase();
  for (const f of AUDIO_FORMATS) {
    if (f.tokens.some((t) => mt.includes(t))) return f.ext;
  }
  return FALLBACK_FORMAT.ext;
}

function mimeForExt(ext: string): string {
  for (const f of AUDIO_FORMATS) {
    if (f.ext === ext) return f.mime;
  }
  return FALLBACK_FORMAT.mime;
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
    const ext = extForMime(input.mimeType || 'audio/webm');
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
    this.core.db.run(
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
      isoZ(new Date(this.core.now())),
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
    this.core.db.run('DELETE FROM session_audio_segments WHERE id = ?', segmentId);
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
    const r = this.core.db.run(
      'UPDATE session_audio_segments SET waveform_peaks_json = ?, waveform_db_floor = ? WHERE id = ?',
      blob,
      -48.0,
      input.segmentId,
    );
    if (r.changes > 0) this.core.broadcast({ type: 'audio.changed' });
    return r.changes > 0;
  }

  /** Reconcile metadata against the blob keys the router layer found under the session prefix. */
  syncAudioFromBlobs(known: Array<{ r2_key: string; ordinal: number }>): {
    inserted: number;
  } {
    let inserted = 0;
    const now = isoZ(new Date(this.core.now()));
    for (const k of known) {
      const exists = this.core.first(
        'SELECT 1 AS x FROM session_audio_segments WHERE r2_key = ?',
        k.r2_key,
      );
      if (exists !== null) continue;
      const m = /\/(\d{4})_([0-9a-f-]{36})\.(webm|ogg|wav|m4a|mp3|aiff)$/i.exec(k.r2_key);
      if (m === null) continue;
      const segId = m[2];
      const mime = mimeForExt(m[3].toLowerCase());
      this.core.db.run(
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
