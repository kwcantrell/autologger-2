// What a job sees and returns (media-worker design D2-D8). Jobs read rows through `WorkerReads`
// (SELECTs the `autologger_media` role is granted) and blobs through the checked opener; they
// write only files under `BLOB_DIR/media/<job id>/` and return an outcome the main loop turns
// into a fenced finish, fail or release.

import type { AudioSeam, MediaErrorCode, MediaJobResult } from '@autologger/ports/media';

export type JobOutcome =
  | { kind: 'done'; result: MediaJobResult }
  /** `final`: no retry can help (the attempt cap is not waited for). */
  | { kind: 'fail'; error: MediaErrorCode; final: boolean }
  /** Put back without counting the attempt (low disk). */
  | { kind: 'release'; error: 'low-disk'; runAfterMs: number };

export interface SegmentRow {
  id: string;
  ordinal: number;
  startedAtUtc: string;
  endedAtUtc: string | null;
  mimeType: string;
  r2Key: string;
}

export interface WorkerReads {
  segment(sessionId: string, id: string): Promise<SegmentRow | null>;
  /** A recording's segments by `started_at_utc`, then `ordinal`. */
  recordingSegments(sessionId: string, recordingOrdinal: number): Promise<SegmentRow[]>;
  /** A recording's seams by `started_at_utc`. */
  recordingSeams(sessionId: string, recordingOrdinal: number): Promise<AudioSeam[]>;
}

export interface JobCtx {
  blobDir: string;
  ffmpegPath: string;
  /** Per ffmpeg run (MEDIA_FFMPEG_TIMEOUT_MS in production). */
  timeoutMs: number;
  /** Aborted when the lease is lost or on shutdown: kills ffmpeg, the result is dropped. */
  signal?: AbortSignal;
  freeBytes(): Promise<number>;
  now(): number;
  reads: WorkerReads;
}

/** A classified failure inside a job; `final` skips the remaining attempts. */
export class JobFailure extends Error {
  override name = 'JobFailure';
  constructor(
    readonly code: MediaErrorCode,
    message: string,
    readonly final = false,
  ) {
    super(message);
  }
}
