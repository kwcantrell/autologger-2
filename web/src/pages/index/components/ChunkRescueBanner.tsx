import { useCallback, useEffect, useState } from 'react';
import { useConfirm } from '../../../shared/ui/ConfirmDialog';
// Side-effect import: installs the module-scope `beforeunload` listener that
// covers "queue non-empty or upload in-flight" (design D6) the moment this
// module is evaluated — independent of whether the banner ever renders
// visible content, and independent of `AudioRecorder`'s own lifecycle. See
// chunkLeaveWarning.ts for why this can't be a component effect.
import '../utils/chunkLeaveWarning';
import {
  type ChunkUploadQueue,
  getChunkUploadQueue,
  type QueuedChunk,
} from '../utils/chunkUploadQueue';

/**
 * True iff a chunk has actually FAILED at least one upload attempt — the
 * spec's "Upload failure is surfaced and recoverable" surface, not "is
 * present in the queue" (visual-gate finding, chunked-live-recording U9). A
 * chunk's clean first attempt is in flight with `classification: 'queued'`
 * and `lastError: null` — nothing has failed yet, so it must not render as
 * a red "could not be uploaded" banner. `classification: 'permanent'`
 * chunks have always failed (that's how they got classified). A `'queued'`
 * chunk with `lastError` set failed transiently at least once and stays
 * queued for boundary/final-stop re-attempts (design D6) — including while
 * a fresh retry attempt is in flight, so the banner does not flicker off
 * mid-retry (queue.pump() does not clear `lastError` until the attempt
 * resolves: success removes the chunk outright, another failure rewrites
 * `lastError`). Chunks merely waiting behind a failed head with no failure
 * of their own do not render.
 */
function hasFailed(chunk: QueuedChunk): boolean {
  return chunk.classification === 'permanent' || chunk.lastError !== null;
}

/**
 * Dedicated recorder-owned rescue surface (chunked-live-recording, design D6;
 * spec: live-recording-chunks "Upload failure is surfaced and recoverable").
 *
 * Deliberately NOT the legacy toast store (`shared/components/Toast.tsx`):
 * that store auto-dismisses non-persistent entries after 3.2 s and its
 * `hideToast()` pops the most recent persistent toast from unrelated code
 * paths (`AudioSaveOverlay` calls it on every leave transition) — either
 * would turn "dismissal-is-consent" into programmatic or timed data loss.
 * This component reads the module-owned chunk upload queue singleton
 * directly (`getChunkUploadQueue` — the SAME instance `AudioRecorder.tsx`
 * enqueues into) via `subscribe`/`getSnapshot`, so it is immune to every
 * toast-clearing path and survives `AudioRecorder` unmounting (the queue
 * lives outside any component's lifecycle by design). Render this ONCE at
 * `SessionWorkspace` level, unconditionally (not gated on `sessionId`,
 * since a straggler from a just-closed session must still be rescuable) —
 * never nested under `AudioRecorder` or `AudioSaveOverlay`.
 */

/** MIME family → filesystem extension (spec: "extension matching the blob's
 *  actual container type"). Safari's `MediaRecorder` records `audio/mp4`
 *  (design D6) — mapped to `.m4a` (the conventional extension for an
 *  AAC-in-MP4 audio-only container) rather than the ambiguous/video-flavored
 *  `.mp4`. Falls back to `.webm` (the Chromium/Firefox default) for an
 *  unrecognized or missing type rather than an extension-less filename. */
function extensionForMimeType(mimeType: string): string {
  const family = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (family === 'audio/mp4' || family === 'video/mp4') return 'm4a';
  if (family === 'audio/ogg' || family === 'video/ogg') return 'ogg';
  if (family === 'audio/webm' || family === 'video/webm') return 'webm';
  if (family === 'audio/wav' || family === 'audio/x-wav') return 'wav';
  if (family === 'audio/mpeg') return 'mp3';
  return 'webm';
}

/** Filesystem-safe filename identifying the session, recording ordinal,
 *  chunk index, and chunk start time (spec). No ISO colons or other
 *  filesystem-hostile characters — `[:.]` in the timestamp become `-`. */
export function chunkDownloadFilename(chunk: QueuedChunk): string {
  const safeSession = chunk.sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  const safeStart = chunk.startedAtUtc.replace(/[:.]/g, '-');
  const ext = extensionForMimeType(chunk.mimeType);
  return `autologger_${safeSession}_rec${chunk.recordingOrdinal}_chunk${chunk.chunkIndex}_${safeStart}.${ext}`;
}

/** Trigger a browser download of one chunk's blob, then revoke the object
 *  URL (spec: "object URL revoked after the download click"). */
function downloadChunk(chunk: QueuedChunk): void {
  const url = URL.createObjectURL(chunk.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = chunkDownloadFilename(chunk);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Duration in whole seconds spanned by a chunk, or null when either
 *  timestamp is missing/unparseable (falls back to a chunk-count phrase). */
function chunkDurationSec(chunk: QueuedChunk): number | null {
  const start = Date.parse(chunk.startedAtUtc);
  const end = Date.parse(chunk.endedAtUtc);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/** Human-readable "amount of audio" phrase for a confirm dialog (spec:
 *  "a confirmation naming the amount discarded" — duration when derivable
 *  from the chunk(s)' own timestamps, else a chunk count). */
function describeAmount(chunks: readonly QueuedChunk[]): string {
  let totalSec = 0;
  let allKnown = true;
  for (const c of chunks) {
    const d = chunkDurationSec(c);
    if (d == null) {
      allKnown = false;
      break;
    }
    totalSec += d;
  }
  const chunkWord = chunks.length === 1 ? 'chunk' : 'chunks';
  if (allKnown && chunks.length > 0) {
    return `${formatDuration(totalSec)} of audio (${chunks.length} ${chunkWord})`;
  }
  return `${chunks.length} ${chunkWord} of recorded audio`;
}

/**
 * Subscribes to the queue's snapshot stream. Deliberately NOT
 * `useSyncExternalStore` — `queue.getSnapshot()` builds a fresh object on
 * every call (see `chunkUploadQueue.ts`'s `toSnapshot()`), which is not
 * referentially stable across repeated calls with no state change, and
 * `useSyncExternalStore` requires exactly that stability (its `getSnapshot`
 * is called on every render to detect tearing) or it loops. A plain
 * subscribe-into-state effect has no such requirement: it only updates state
 * when the queue itself calls back via `notify()`.
 */
function useQueueSnapshot(queue: ChunkUploadQueue) {
  const [snapshot, setSnapshot] = useState(queue.getSnapshot);
  useEffect(() => {
    // Re-sync on mount too: the queue may have changed between this
    // component's initial state capture and the effect attaching (mirrors
    // AudioRecorder.tsx's D2 fix-wave re-check for the same class of gap).
    setSnapshot(queue.getSnapshot());
    return queue.subscribe(setSnapshot);
  }, [queue]);
  return snapshot;
}

interface ChunkRowProps {
  chunk: QueuedChunk;
  queue: ChunkUploadQueue;
  confirm: (opts: {
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
  }) => Promise<boolean>;
}

function ChunkRow({ chunk, queue, confirm }: ChunkRowProps) {
  const handleDownload = useCallback(() => {
    try {
      downloadChunk(chunk);
    } catch {
      /* best-effort — the chunk stays in the queue either way */
    }
  }, [chunk]);

  const handleRetry = useCallback(() => {
    void queue.pump().catch(() => {
      /* pump() reflects failures via the snapshot; nothing to do with the rejection itself */
    });
  }, [queue]);

  const handleDiscard = useCallback(async () => {
    const ok = await confirm({
      title: 'Discard this chunk?',
      message: `This will permanently discard ${describeAmount([chunk])}. This cannot be undone.`,
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!ok) return;
    queue.discard(chunk.recordingOrdinal, chunk.chunkIndex);
  }, [chunk, confirm, queue]);

  const detail = chunk.lastError ? chunk.lastError : null;
  const statusLabel = chunk.classification === 'permanent' ? 'Failed permanently' : 'Retrying…';

  return (
    <li className="flex flex-col gap-1 rounded-v5-sm border border-v5-border px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[0.82rem] font-medium text-v5-text">
          Recording {chunk.recordingOrdinal} · chunk {chunk.chunkIndex + 1}
        </span>
        <span className="text-[0.72rem] text-[#ffb4b4]">{statusLabel}</span>
      </div>
      {detail && <p className="m-0 text-[0.76rem] text-v5-muted wrap-break-word">{detail}</p>}
      <div className="flex flex-wrap gap-2 pt-1">
        <button type="button" className="btn" onClick={handleDownload}>
          Download
        </button>
        <button type="button" className="btn" onClick={handleRetry}>
          Retry
        </button>
        <button type="button" className="btn danger" onClick={handleDiscard}>
          Discard
        </button>
      </div>
    </li>
  );
}

export function ChunkRescueBanner() {
  // `getChunkUploadQueue`'s `deps` are consulted only on the singleton's
  // FIRST construction anywhere in the tab (module doc comment) — real
  // upload/listSegments deps come from `AudioRecorder.tsx`'s `buildQueueDeps`.
  // These placeholders are a landmine-avoidance fallback only, never expected
  // to run: `SessionWorkspace` renders `<AudioRecorder>` before
  // `<ChunkRescueBanner>` in the same JSX parent, and React renders siblings
  // in document order within one commit, so `AudioRecorder`'s render always
  // constructs the singleton (with real deps) first. If that ordering were
  // ever violated, failing loudly here (rather than silently swallowing
  // uploads) is deliberate — an unexpected pump() rejection surfaces via the
  // Retry button's own catch below, not a data-loss no-op.
  const queue = getChunkUploadQueue({
    upload: async () => {
      throw new Error(
        'chunkUploadQueue: ChunkRescueBanner constructed the singleton before AudioRecorder',
      );
    },
    listSegments: async () => {
      throw new Error(
        'chunkUploadQueue: ChunkRescueBanner constructed the singleton before AudioRecorder',
      );
    },
    clock: { now: () => Date.now() },
  });
  const snapshot = useQueueSnapshot(queue);
  const { confirm, confirmElement } = useConfirm();

  // The banner (and its bulk actions) are scoped to chunks that have
  // actually FAILED (visual-gate finding, U9) — a healthy chunk mid-first-
  // attempt, or one merely queued behind a failed head with no failure of
  // its own, is neither shown nor swept up by "Discard remaining".
  const failedChunks = snapshot.chunks.filter(hasFailed);

  const handleRetryAll = useCallback(() => {
    void queue.pump().catch(() => {});
  }, [queue]);

  const handleDiscardAll = useCallback(async () => {
    const ok = await confirm({
      title: 'Discard all remaining chunks?',
      message: `This will permanently discard ${describeAmount(
        failedChunks,
      )}. This cannot be undone.`,
      confirmLabel: 'Discard all',
      danger: true,
    });
    if (!ok) return;
    // Scoped discard (not queue.discardAll()): discardAll() would also drop
    // any healthy, not-yet-failed chunk sitting behind a failed head (e.g. a
    // later rollover chunk enqueued while an earlier one is mid-retry) —
    // never named in this confirmation's amount, never shown in the list
    // above it.
    for (const chunk of failedChunks) {
      queue.discard(chunk.recordingOrdinal, chunk.chunkIndex);
    }
  }, [confirm, queue, failedChunks]);

  if (failedChunks.length === 0) return null;

  return (
    <>
      <div
        role="alert"
        aria-live="assertive"
        className="glass-face-strong fixed inset-x-0 top-0 z-(--z-toast) mx-auto mt-2 w-[min(640px,94vw)] rounded-v5-md border border-danger p-3 shadow-[0_8px_32px_rgba(0,0,0,0.35)]"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="m-0 text-[0.85rem] font-medium text-v5-text">
            {failedChunks.length} recorded audio{' '}
            {failedChunks.length === 1 ? 'chunk' : 'chunks'} could not be uploaded. Keep this tab
            open until they are retried, downloaded, or discarded.
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn" onClick={handleRetryAll}>
              Retry all
            </button>
            <button type="button" className="btn danger" onClick={handleDiscardAll}>
              Discard remaining
            </button>
          </div>
        </div>
        <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
          {failedChunks.map((chunk) => (
            <ChunkRow
              key={`${chunk.recordingOrdinal}:${chunk.chunkIndex}`}
              chunk={chunk}
              queue={queue}
              confirm={confirm}
            />
          ))}
        </ul>
      </div>
      {confirmElement}
    </>
  );
}
