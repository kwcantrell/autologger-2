// Audio-segment metadata domain — rows in session_audio_segments; the audio
// bytes themselves live in the blob store (the router layer owns it). Moved
// verbatim out of the original single-file session spine.

import { createHash } from 'node:crypto';
import { isoZ } from '@autologger/domain';
import type { AudioSeam, AudioSeamsPort, MediaJobsPort } from '@autologger/ports/media';
import type { Row, SessionCore } from './sessionCore';

/** A segment's media processing state (media-worker D5): `pending` until the worker's result is
 * applied, `done` after, `failed` when its job failed for good; null on rows that predate it. */
export type MediaStatus = 'pending' | 'done' | 'failed';

/** One seam of a merged segment as the segment dict lists it (media-worker D7, D16). */
export interface AudioSegmentSeam {
  offset_ms: number;
  started_at_utc: string;
  ended_at_utc: string | null;
}

/** The media statements a hub's audio store runs inside its transaction (media-worker D2, D18):
 * `@autologger/storage`'s `mediaJobs` and `audioSeams`, injected by the composition root (session-core
 * does not depend on storage), and the size of a stored blob for a merge job's `input_bytes`
 * (0 when missing). A hub without them (test registries) writes plain rows, as before. */
export interface SessionMediaPorts {
  jobs: MediaJobsPort;
  seams: AudioSeamsPort;
  blobBytes(key: string): Promise<number>;
}

const MEDIA_STATUSES: readonly MediaStatus[] = ['pending', 'done', 'failed'];

/** The session_meta key of a recording's pending finalize (media-worker D6): the window list the
 * client finalized while a straggler was still missing. */
export function finalizeMetaKey(recordingOrdinal: number): string {
  return `media_finalize:${recordingOrdinal}`;
}

/** The session_meta key recording the input set a recording's merge failed on for good
 * (`mixed-codecs`, `interleaved-input`): the reconcile skips that recording while its segments are
 * still exactly that set (implementation panel B.9). */
export function mergeBlockedMetaKey(recordingOrdinal: number): string {
  return `media_merge_blocked:${recordingOrdinal}`;
}

/** The merge failure codes that repeat for the same inputs (B.9). */
export const DETERMINISTIC_MERGE_ERRORS: readonly string[] = ['mixed-codecs', 'interleaved-input'];

/** The marker value for a set of segment ids: sorted, comma-joined. */
export function mergeInputSetValue(ids: readonly string[]): string {
  return [...ids].sort().join(',');
}

/** The segment dict's `seams` (D16): null for a segment with no seam or with only its own window at
 * offset 0 (a plain chunk), else every seam in media order. */
export function dictSeams(seams: readonly AudioSeam[]): AudioSegmentSeam[] | null {
  if (seams.length === 0) return null;
  if (seams.length === 1 && (seams[0] as AudioSeam).offsetMs === 0) return null;
  return [...seams]
    .sort((a, b) => a.offsetMs - b.offsetMs || a.startedAtUtc.localeCompare(b.startedAtUtc))
    .map((x) => ({
      offset_ms: x.offsetMs,
      started_at_utc: x.startedAtUtc,
      ended_at_utc: x.endedAtUtc,
    }));
}

/** RFC 4122 namespace of merged segment ids (a fixed random uuid). */
const MERGED_SEGMENT_NAMESPACE = '6f1c3a52-1d0e-4b7e-9a51-5b0f6d2c8e47';

/** The merged segment's id, derived from its merge job's id (media-worker D3: `uuidv5(job id)`), so a
 * retried apply finds the blob it already copied under the same key. */
export function mergedSegmentId(jobId: string): string {
  const ns = Buffer.from(MERGED_SEGMENT_NAMESPACE.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(ns).update(jobId, 'utf8').digest();
  h[6] = ((h[6] as number) & 0x0f) | 0x50;
  h[8] = ((h[8] as number) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** The blob key of a segment: `audio/<session>/<ordinal, 4 digits>_<id>.<ext of mime>`. */
export function segmentBlobKey(
  sessionId: string,
  ordinal: number,
  segmentId: string,
  mimeType: string,
): string {
  return `audio/${sessionId}/${String(ordinal).padStart(4, '0')}_${segmentId}.${extForMime(mimeType || 'audio/webm')}`;
}

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
  // media-worker D16. Always set by `audioRowToMeta`; optional so hand-built literals that predate
  // the change still type-check.
  duration_ms?: number | null;
  media_status?: MediaStatus | null;
  /** The classified error of a failed job (media-worker D5); never a path. Not in the dict. */
  media_error?: string | null;
  seams?: AudioSegmentSeam[] | null;
}

/** audioRowToMeta — pure segment-row → meta mapper; `seams` are the rows of
 * `session_audio_seams` pointing at this segment (media-worker D16). */
export function audioRowToMeta(r: Row, seams: readonly AudioSeam[] = []): AudioSegmentMeta {
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
    duration_ms:
      r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
    media_status: MEDIA_STATUSES.includes(r.media_status as MediaStatus)
      ? (r.media_status as MediaStatus)
      : null,
    media_error:
      r.media_error === null || r.media_error === undefined ? null : String(r.media_error),
    seams: dictSeams(seams),
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
  // supabase-11a-legacy-import follow-up C: PCM blobs are stored losslessly as FLAC.
  { ext: 'flac', tokens: ['flac'], mime: 'audio/flac' },
] as const;
const FALLBACK_FORMAT = { ext: 'webm', mime: 'audio/webm' } as const;

export function extForMime(mimeType: string): string {
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

/** What `addAudioSegment` answers: the stored segment, or with `existing` the segment that already
 * holds the request's recording window (media-worker D18), in which case nothing was written. */
export type AddedAudioSegment = AudioSegmentMeta & { existing: boolean };

/** The finalize route's answer (media-worker D6). */
export type FinalizeOutcome = 'queued' | 'not-needed' | 'already-queued' | 'waiting';

/** A validated ingest result to apply (media-worker D5); `flac` is the already-copied blob. */
export interface IngestApply {
  segmentId: string;
  durationMs: number;
  peaks: number[];
  flac: { key: string; mime: string } | null;
}

/** A validated merge result to apply (media-worker D7); `key` is the already-copied blob. */
export interface MergeApply {
  recordingOrdinal: number;
  mergedId: string;
  key: string;
  mime: string;
  durationMs: number;
  peaks: number[];
  seams: { offsetMs: number; startedAtUtc: string; endedAtUtc: string | null; sourceKey: string }[];
  inputIds: string[];
}

export type MergeApplyOutcome =
  | { kind: 'applied'; trashKeys: string[] }
  | { kind: 'inputs-changed' }
  | { kind: 'invalid' };

/** The waveform floor the server's peaks are computed against (media-worker D5, the browser's). */
const PEAKS_DB_FLOOR = -48.0;

export class AudioStore {
  constructor(
    private core: SessionCore,
    private media: SessionMediaPorts | null = null,
  ) {}

  /** A usable recording ordinal (a positive integer), else null. */
  private static ordinalOf(n: number | null): number | null {
    if (n === null || !Number.isFinite(n)) return null;
    const ri = Math.trunc(n);
    return ri >= 1 ? ri : null;
  }

  /** Stores a segment row (media-worker D5, D18). With a recording ordinal and a window start, a
   * window the session already holds (its seam points at a chunk or a merged segment) answers that
   * segment and writes nothing. Otherwise the row (`media_status = 'pending'` when media ports are
   * wired), its seam (offset 0, its own key) and an `ingest` job with `inputBytes` are written in
   * this transaction; a concurrent duplicate fails the transaction with `23505` on the seam key,
   * which the hub answers with the holder. A new chunk of a recording with a pending finalize
   * enqueues the merge once every finalized window is held. */
  async addAudioSegment(input: {
    sessionId: string;
    mimeType: string;
    startedAtUtc: string | null;
    endedAtUtc: string | null;
    recordingOrdinal: number | null;
    /** The blob's size, for the ingest job's lane (media-worker D2). */
    inputBytes?: number;
    /** The id and key the caller already wrote the blob under (`planAudioSegment`): the blob
     * lands before the row, so a listed row always has its bytes (media-worker, coordinator
     * decision 2026-10-12). Omitted: a fresh id and key (callers that write no blob first). */
    segmentId?: string;
    r2Key?: string;
  }): Promise<AddedAudioSegment> {
    const ro = AudioStore.ordinalOf(input.recordingOrdinal);
    const media = this.media;
    if (media && ro !== null && input.startedAtUtc !== null) {
      const held = await this.heldWindow(ro, input.startedAtUtc);
      if (held) return { ...held, existing: true };
    }
    const segId = input.segmentId ?? crypto.randomUUID();
    const ordinal = await this.nextOrdinal();
    const mime = input.mimeType || 'audio/webm';
    const r2Key = input.r2Key ?? segmentBlobKey(input.sessionId, ordinal, segId, mime);
    const status: MediaStatus | null = media ? 'pending' : null;
    await this.core.db.run(
      `INSERT INTO session_audio_segments
         (session_id, id, ordinal, started_at_utc, ended_at_utc, mime_type, r2_key, recording_ordinal, created_at_utc, media_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.core.sessionId,
      segId,
      ordinal,
      input.startedAtUtc,
      input.endedAtUtc,
      mime,
      r2Key,
      ro,
      isoZ(new Date(this.core.now())),
      status,
    );
    const ownSeam: AudioSeam | null =
      media && ro !== null && input.startedAtUtc !== null
        ? {
            sessionId: this.core.sessionId,
            recordingOrdinal: ro,
            startedAtUtc: input.startedAtUtc,
            endedAtUtc: input.endedAtUtc,
            segmentId: segId,
            offsetMs: 0,
            sourceKey: r2Key,
          }
        : null;
    if (media) {
      if (ownSeam) await media.seams.insert(this.core.db, ownSeam);
      await this.enqueueIngest(segId, input.inputBytes ?? 0);
    }
    this.core.broadcast({ type: 'audio.changed' });
    const meta: AudioSegmentMeta = {
      id: segId,
      ordinal,
      started_at_utc: input.startedAtUtc,
      ended_at_utc: input.endedAtUtc,
      mime_type: mime,
      r2_key: r2Key,
      recording_ordinal: ro,
      waveform_peaks: null,
      waveform_db_floor: null,
      duration_ms: null,
      media_status: status,
      media_error: null,
      seams: ownSeam ? dictSeams([ownSeam]) : null,
    };
    if (media && ro !== null) await this.mergeIfFinalized(ro);
    return { ...meta, existing: false };
  }

  private async nextOrdinal(): Promise<number> {
    return Number(
      (
        await this.core.first(
          'SELECT COALESCE(MAX(ordinal), 0) + 1 AS n FROM session_audio_segments WHERE session_id = ?',
          this.core.sessionId,
        )
      )?.n ?? 1,
    );
  }

  /** A new segment's id and blob key, for a caller that writes the blob before the row. The key's
   * ordinal is the next one at this read; the row takes the next one at its insert (they differ
   * only under a concurrent insert, and the key's ordinal is a file-name hint). */
  async planAudioSegment(mimeType: string): Promise<{ segmentId: string; r2Key: string }> {
    const segmentId = crypto.randomUUID();
    return {
      segmentId,
      r2Key: segmentBlobKey(this.core.sessionId, await this.nextOrdinal(), segmentId, mimeType),
    };
  }

  /** The segment holding window `(recordingOrdinal, startedAtUtc)`, or null (media-worker D18). */
  async heldWindow(
    recordingOrdinal: number,
    startedAtUtc: string,
  ): Promise<AudioSegmentMeta | null> {
    if (!this.media) return null;
    const seam = await this.media.seams.findWindow(
      this.core.db,
      this.core.sessionId,
      recordingOrdinal,
      startedAtUtc,
    );
    if (seam === null) return null;
    return this.getAudioSegment(seam.segmentId);
  }

  private async enqueueIngest(segmentId: string, inputBytes: number): Promise<void> {
    if (!this.media) return;
    const now = this.core.now();
    await this.media.jobs.enqueue(this.core.uncountedDb, {
      id: crypto.randomUUID(),
      kind: 'ingest',
      sessionId: this.core.sessionId,
      target: segmentId,
      inputBytes: Math.max(0, Math.trunc(inputBytes)),
      nowMs: now,
    });
  }

  /** Enqueues a merge of the recording (media-worker D6) with the inputs' total size; false when a
   * live merge already exists. */
  async enqueueMerge(recordingOrdinal: number): Promise<boolean> {
    if (!this.media) return false;
    let bytes = 0;
    for (const seg of await this.segmentsOfRecording(recordingOrdinal)) {
      bytes += await this.media.blobBytes(seg.r2_key);
    }
    return this.media.jobs.enqueue(this.core.uncountedDb, {
      id: crypto.randomUUID(),
      kind: 'merge',
      sessionId: this.core.sessionId,
      target: String(recordingOrdinal),
      inputBytes: bytes,
      nowMs: this.core.now(),
    });
  }

  /** The recording's segments in merge input order: `started_at_utc`, then `ordinal`. */
  async segmentsOfRecording(recordingOrdinal: number): Promise<AudioSegmentMeta[]> {
    const rows = await this.core.all(
      `SELECT * FROM session_audio_segments WHERE session_id = ? AND recording_ordinal = ?
        ORDER BY started_at_utc ASC NULLS FIRST, ordinal ASC, id ASC`,
      this.core.sessionId,
      recordingOrdinal,
    );
    return this.withSeams(rows);
  }

  /** Which of `windows` the session holds for the recording, as a seam or as a segment row's own
   * `started_at_utc` (rows that predate seams), and which are missing (media-worker D6). */
  async windowsHeld(
    recordingOrdinal: number,
    windows: readonly string[],
  ): Promise<{ held: string[]; missing: string[] }> {
    const have = new Set<string>();
    if (this.media) {
      for (const w of await this.media.seams.windowsOf(
        this.core.db,
        this.core.sessionId,
        recordingOrdinal,
      )) {
        have.add(w.startedAtUtc);
      }
    }
    for (const seg of await this.segmentsOfRecording(recordingOrdinal)) {
      if (seg.started_at_utc !== null) have.add(seg.started_at_utc);
    }
    const held: string[] = [];
    const missing: string[] = [];
    for (const w of new Set(windows)) (have.has(w) ? held : missing).push(w);
    return { held, missing };
  }

  /** The finalize (media-worker D6): `waiting` (and the window list kept) while a listed window is
   * not held, `not-needed` for fewer than two segments, `already-queued` while a merge is live,
   * else the merge is enqueued (`queued`). Writes no segment row. */
  async finalizeRecording(
    recordingOrdinal: number,
    windows: readonly string[],
  ): Promise<FinalizeOutcome> {
    if (!this.media) return 'not-needed';
    const key = finalizeMetaKey(recordingOrdinal);
    const { missing } = await this.windowsHeld(recordingOrdinal, windows);
    if (missing.length > 0) {
      const prior = await this.pendingFinalize(recordingOrdinal);
      const all = [...new Set([...(prior ?? []), ...windows])].sort();
      await this.core.metaSetUncounted(key, JSON.stringify(all));
      return 'waiting';
    }
    await this.clearFinalize(recordingOrdinal);
    if ((await this.segmentsOfRecording(recordingOrdinal)).length < 2) return 'not-needed';
    const live = await this.media.jobs.liveJob(
      this.core.db,
      'merge',
      this.core.sessionId,
      String(recordingOrdinal),
    );
    if (live) return 'already-queued';
    return (await this.enqueueMerge(recordingOrdinal)) ? 'queued' : 'already-queued';
  }

  private async pendingFinalize(recordingOrdinal: number): Promise<string[] | null> {
    const raw = await this.core.metaGet(finalizeMetaKey(recordingOrdinal));
    if (raw === null) return null;
    try {
      const v = JSON.parse(raw) as unknown;
      return Array.isArray(v) ? v.map((x) => String(x)) : null;
    } catch {
      return null;
    }
  }

  private async clearFinalize(recordingOrdinal: number): Promise<void> {
    await this.core.uncountedDb.run(
      'DELETE FROM session_meta WHERE session_id = ? AND key = ?',
      this.core.sessionId,
      finalizeMetaKey(recordingOrdinal),
    );
  }

  /** A straggler arrived (media-worker D6): when the recording has a pending finalize and every
   * window it listed is now held, enqueue the merge and clear the marker. */
  private async mergeIfFinalized(recordingOrdinal: number): Promise<void> {
    const windows = await this.pendingFinalize(recordingOrdinal);
    if (windows === null) return;
    const { missing } = await this.windowsHeld(recordingOrdinal, windows);
    if (missing.length > 0) return;
    await this.clearFinalize(recordingOrdinal);
    if ((await this.segmentsOfRecording(recordingOrdinal)).length >= 2) {
      await this.enqueueMerge(recordingOrdinal);
    }
  }

  /** Attaches each row's seams (one read for the set). */
  private async withSeams(rows: Row[]): Promise<AudioSegmentMeta[]> {
    if (rows.length === 0) return [];
    if (!this.media) return rows.map((r) => audioRowToMeta(r));
    const seams = await this.core.all(
      `SELECT session_id, recording_ordinal, started_at_utc, ended_at_utc, segment_id, offset_ms,
              source_key
         FROM session_audio_seams WHERE session_id = ?`,
      this.core.sessionId,
    );
    const bySegment = new Map<string, AudioSeam[]>();
    for (const r of seams) {
      const seam: AudioSeam = {
        sessionId: String(r.session_id),
        recordingOrdinal: Number(r.recording_ordinal),
        startedAtUtc: String(r.started_at_utc),
        endedAtUtc: r.ended_at_utc === null ? null : String(r.ended_at_utc),
        segmentId: String(r.segment_id),
        offsetMs: Number(r.offset_ms),
        sourceKey: String(r.source_key),
      };
      const list = bySegment.get(seam.segmentId) ?? [];
      list.push(seam);
      bySegment.set(seam.segmentId, list);
    }
    return rows.map((r) => audioRowToMeta(r, bySegment.get(String(r.id)) ?? []));
  }

  async listAudioSegments(): Promise<AudioSegmentMeta[]> {
    const rows = await this.core.all(
      'SELECT * FROM session_audio_segments WHERE session_id = ? ORDER BY ordinal ASC, id ASC',
      this.core.sessionId,
    );
    return this.withSeams(rows);
  }

  /** One segment with its seams, or null. */
  async getAudioSegment(segmentId: string): Promise<AudioSegmentMeta | null> {
    const rows = await this.core.all(
      'SELECT * FROM session_audio_segments WHERE session_id = ? AND id = ?',
      this.core.sessionId,
      segmentId,
    );
    return (await this.withSeams(rows))[0] ?? null;
  }

  async deleteAudioSegment(segmentId: string): Promise<void> {
    await this.core.db.run(
      'DELETE FROM session_audio_segments WHERE session_id = ? AND id = ?',
      this.core.sessionId,
      segmentId,
    );
  }

  async getAudioSegmentKey(
    segmentId: string,
  ): Promise<{ r2_key: string; mime_type: string } | null> {
    const r = await this.core.first(
      'SELECT r2_key, mime_type FROM session_audio_segments WHERE session_id = ? AND id = ?',
      this.core.sessionId,
      segmentId,
    );
    return r ? { r2_key: String(r.r2_key), mime_type: String(r.mime_type) } : null;
  }

  async setAudioSegmentWaveform(input: { segmentId: string; peaks: number[] }): Promise<boolean> {
    const blob = JSON.stringify(input.peaks);
    const r = await this.core.db.run(
      'UPDATE session_audio_segments SET waveform_peaks_json = ?, waveform_db_floor = ? WHERE session_id = ? AND id = ?',
      blob,
      PEAKS_DB_FLOOR,
      this.core.sessionId,
      input.segmentId,
    );
    if (r.changes > 0) this.core.broadcast({ type: 'audio.changed' });
    return r.changes > 0;
  }

  /** Applies an ingest result (media-worker D5): duration, peaks (floor −48 dB), `done`, and for a
   * verified FLAC the swapped key and mime. Null when the row is gone (the job is cancelled);
   * else the replaced key to trash (the re-read row's, never the result's), if any. */
  async applyIngest(a: IngestApply): Promise<{ replacedKey: string | null } | null> {
    const row = await this.core.first(
      'SELECT r2_key FROM session_audio_segments WHERE session_id = ? AND id = ?',
      this.core.sessionId,
      a.segmentId,
    );
    if (row === null) return null;
    const peaks = JSON.stringify(a.peaks);
    if (a.flac) {
      await this.core.db.run(
        `UPDATE session_audio_segments
            SET duration_ms = ?, waveform_peaks_json = ?, waveform_db_floor = ?,
                media_status = 'done', media_error = NULL, r2_key = ?, mime_type = ?
          WHERE session_id = ? AND id = ?`,
        a.durationMs,
        peaks,
        PEAKS_DB_FLOOR,
        a.flac.key,
        a.flac.mime,
        this.core.sessionId,
        a.segmentId,
      );
    } else {
      await this.core.db.run(
        `UPDATE session_audio_segments
            SET duration_ms = ?, waveform_peaks_json = ?, waveform_db_floor = ?,
                media_status = 'done', media_error = NULL
          WHERE session_id = ? AND id = ?`,
        a.durationMs,
        peaks,
        PEAKS_DB_FLOOR,
        this.core.sessionId,
        a.segmentId,
      );
    }
    this.core.broadcast({ type: 'audio.changed' });
    const old = String(row.r2_key);
    return { replacedKey: a.flac && old !== a.flac.key ? old : null };
  }

  /** Records that the recording's merge failed deterministically on its current segments (B.9). */
  async blockMerge(recordingOrdinal: number): Promise<void> {
    const ids = (await this.segmentsOfRecording(recordingOrdinal)).map((x) => x.id);
    await this.core.metaSetUncounted(
      mergeBlockedMetaKey(recordingOrdinal),
      mergeInputSetValue(ids),
    );
  }

  /** A failed job's segment (media-worker D5): `failed` with the classified code. False when the
   * row is gone. */
  async markMediaFailed(segmentId: string, error: string): Promise<boolean> {
    const r = await this.core.db.run(
      `UPDATE session_audio_segments SET media_status = 'failed', media_error = ?
        WHERE session_id = ? AND id = ?`,
      error.slice(0, 64),
      this.core.sessionId,
      segmentId,
    );
    if (r.changes > 0) this.core.broadcast({ type: 'audio.changed' });
    return r.changes > 0;
  }

  /** Applies a merge result (media-worker D7) when the recording's segments are still exactly the
   * job's inputs: inserts the merged row (`done`, the merge's peaks and duration, no job), points
   * every result seam at it (repointing the existing windows before the inputs are deleted, since
   * deleting a segment cascades its seams), deletes the inputs and answers their keys (re-read
   * rows) to trash. `invalid` when the result would drop a window the inputs hold. */
  async applyMerge(a: MergeApply): Promise<MergeApplyOutcome> {
    const media = this.media;
    if (!media) return { kind: 'inputs-changed' };
    const inputs = await this.segmentsOfRecording(a.recordingOrdinal);
    const ids = inputs.map((x) => x.id);
    if (
      ids.length !== a.inputIds.length ||
      [...ids].sort().join('\n') !== [...a.inputIds].sort().join('\n')
    ) {
      return { kind: 'inputs-changed' };
    }
    const first = inputs[0] as AudioSegmentMeta;
    const last = inputs[inputs.length - 1] as AudioSegmentMeta;
    const existing = await media.seams.windowsOf(
      this.core.db,
      this.core.sessionId,
      a.recordingOrdinal,
    );
    // The result's windows must be exactly the inputs' windows: every seam held by an input, plus
    // the `started_at_utc` of an input row with no seam (rows that predate seams). Each window's
    // `ended_at_utc` and `source_key` come from the database, never the result; offsets lie in
    // [0, duration] and strictly increase in window order (implementation panel B.9: a forged
    // window would make D18 answer a later real chunk as already stored).
    const inputSet = new Set(ids);
    const expected = new Map<
      string,
      { endedAtUtc: string | null; sourceKey: string; held: boolean }
    >();
    for (const w of existing) {
      if (inputSet.has(w.segmentId)) {
        expected.set(w.startedAtUtc, {
          endedAtUtc: w.endedAtUtc,
          sourceKey: w.sourceKey,
          held: true,
        });
      }
    }
    const seamed = new Set(
      existing.filter((w) => inputSet.has(w.segmentId)).map((w) => w.segmentId),
    );
    for (const seg of inputs) {
      if (seamed.has(seg.id)) continue;
      if (seg.started_at_utc === null) return { kind: 'invalid' };
      if (!expected.has(seg.started_at_utc)) {
        expected.set(seg.started_at_utc, {
          endedAtUtc: seg.ended_at_utc,
          sourceKey: seg.r2_key,
          held: false,
        });
      }
    }
    const given = new Map(a.seams.map((x) => [x.startedAtUtc, x.offsetMs]));
    if (given.size !== a.seams.length || given.size !== expected.size) return { kind: 'invalid' };
    for (const w of expected.keys()) if (!given.has(w)) return { kind: 'invalid' };
    const ordered = [...given.entries()].sort((x, y) => x[0].localeCompare(y[0]));
    let prev = -1;
    for (const [, off] of ordered) {
      if (!Number.isSafeInteger(off) || off < 0 || off > a.durationMs || off <= prev) {
        return { kind: 'invalid' };
      }
      prev = off;
    }
    await this.core.db.run(
      `INSERT INTO session_audio_segments
         (session_id, id, ordinal, started_at_utc, ended_at_utc, mime_type, r2_key, recording_ordinal,
          created_at_utc, waveform_peaks_json, waveform_db_floor, duration_ms, media_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done')`,
      this.core.sessionId,
      a.mergedId,
      first.ordinal,
      first.started_at_utc,
      last.ended_at_utc,
      a.mime,
      a.key,
      a.recordingOrdinal,
      isoZ(new Date(this.core.now())),
      JSON.stringify(a.peaks),
      PEAKS_DB_FLOOR,
      a.durationMs,
    );
    // Repoint the held windows before the inputs are deleted (deleting a segment cascades its seams).
    await media.seams.repoint(
      this.core.db,
      this.core.sessionId,
      a.recordingOrdinal,
      a.mergedId,
      ordered
        .filter(([w]) => expected.get(w)?.held)
        .map(([w, off]) => ({ startedAtUtc: w, offsetMs: off })),
    );
    for (const [w, off] of ordered) {
      const e = expected.get(w);
      if (!e || e.held) continue;
      await media.seams.insert(this.core.db, {
        sessionId: this.core.sessionId,
        recordingOrdinal: a.recordingOrdinal,
        startedAtUtc: w,
        endedAtUtc: e.endedAtUtc,
        segmentId: a.mergedId,
        offsetMs: off,
        sourceKey: e.sourceKey,
      });
    }
    for (const id of ids) {
      await this.core.db.run(
        'DELETE FROM session_audio_segments WHERE session_id = ? AND id = ?',
        this.core.sessionId,
        id,
      );
    }
    this.core.broadcast({ type: 'audio.changed' });
    return { kind: 'applied', trashKeys: inputs.map((x) => x.r2_key) };
  }

  /** Reconcile metadata against the blob keys the router layer found under the session prefix.
   * The segment id comes from the file name, so a key whose id already has a row is a sibling of
   * that segment (a WAV and the FLAC it was converted to, before the cleanup) and is skipped.
   * Each inserted row is `pending` with an `ingest` job (media-worker D5) when media ports are
   * wired. */
  async syncAudioFromBlobs(
    known: Array<{ r2_key: string; ordinal: number; bytes?: number }>,
  ): Promise<{
    inserted: number;
  }> {
    let inserted = 0;
    const now = isoZ(new Date(this.core.now()));
    const status: MediaStatus | null = this.media ? 'pending' : null;
    for (const k of known) {
      const exists = await this.core.first(
        'SELECT 1 AS x FROM session_audio_segments WHERE session_id = ? AND r2_key = ?',
        this.core.sessionId,
        k.r2_key,
      );
      if (exists !== null) continue;
      const m = /\/(\d{4})_([0-9a-f-]{36})\.(webm|ogg|wav|m4a|mp3|aiff|flac)$/i.exec(k.r2_key);
      if (m === null) continue;
      const segId = m[2] as string;
      const sameId = await this.core.first(
        'SELECT 1 AS x FROM session_audio_segments WHERE session_id = ? AND id = ?',
        this.core.sessionId,
        segId,
      );
      if (sameId !== null) continue;
      const mime = mimeForExt((m[3] as string).toLowerCase());
      await this.core.db.run(
        `INSERT INTO session_audio_segments
           (session_id, id, ordinal, started_at_utc, ended_at_utc, mime_type, r2_key, recording_ordinal, created_at_utc, media_status)
         VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?)`,
        this.core.sessionId,
        segId,
        k.ordinal,
        mime,
        k.r2_key,
        now,
        status,
      );
      await this.enqueueIngest(segId, k.bytes ?? 0);
      inserted += 1;
    }
    return { inserted };
  }
}
