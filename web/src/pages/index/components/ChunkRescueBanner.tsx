import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription } from '../../../shared/components/ui/alert';
import { Button } from '../../../shared/components/ui/button';
import { useConfirm } from '../../../shared/ui/ConfirmDialog';
// Side-effect import: starts the module-scope queue subscription that covers
// "queue non-empty or upload in-flight" (design D6) the moment this module is
// evaluated — independent of whether the banner ever renders visible content,
// and independent of `AudioRecorder`'s own lifecycle. The `beforeunload`
// listener itself is attached only while the queue actually holds something
// (bfcache). See chunkLeaveWarning.ts for why this can't be a component effect.
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
  return chunk.classification !== 'queued' || chunk.lastError !== null;
}

/** Shown on the surface: failed chunks, and every chunk recovered from a previous page (D10). */
function isShown(chunk: QueuedChunk): boolean {
  return chunk.recovered || hasFailed(chunk);
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

function saveBlob(chunk: QueuedChunk, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = chunkDownloadFilename(chunk);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Trigger a browser download of one chunk's bytes, then revoke the object URL (spec). In-memory
 *  bytes download synchronously; stored bytes are read back from the chunk store first. */
function downloadChunk(chunk: QueuedChunk, queue: ChunkUploadQueue): void {
  if (chunk.blob) {
    saveBlob(chunk, chunk.blob);
    return;
  }
  void queue
    .readChunk(chunk.key)
    .then((b) => saveBlob(chunk, b))
    .catch(() => {
      /* best-effort — the chunk stays in the queue either way */
    });
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
      downloadChunk(chunk, queue);
    } catch {
      /* best-effort — the chunk stays in the queue either way */
    }
  }, [chunk, queue]);

  // One attempt for this chunk whatever its class (media-worker D11: Retry reaches every class).
  const handleRetry = useCallback(() => {
    void queue.retryChunk(chunk.key).catch(() => {
      /* the snapshot reflects the outcome */
    });
  }, [queue, chunk.key]);

  const handleDiscard = useCallback(async () => {
    const ok = await confirm({
      title: 'Discard this chunk?',
      message: `This will permanently discard ${describeAmount([chunk])}. This cannot be undone.`,
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!ok) return;
    void queue.discardChunk(chunk.key);
  }, [chunk, confirm, queue]);

  const detail = chunk.lastError ? chunk.lastError : null;
  const statusLabel =
    chunk.classification === 'permanent'
      ? 'Failed permanently'
      : chunk.classification === 'blocked'
        ? 'Signed out'
        : chunk.lastError !== null
          ? 'Retrying…'
          : 'Recovered';

  return (
    <li className="flex flex-col gap-1 rounded-v5-sm border border-v5-border px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[0.82rem] font-medium text-v5-text">
          Recording {chunk.recordingOrdinal} · chunk {chunk.chunkIndex + 1}
          {chunk.partial ? ' (partial)' : ''}
        </span>
        <span className="text-[0.72rem] text-[#ffb4b4]">{statusLabel}</span>
      </div>
      {detail && <p className="m-0 text-[0.76rem] text-v5-muted wrap-break-word">{detail}</p>}
      {chunk.classification === 'blocked' && (
        <p className="m-0 text-[0.76rem] text-v5-muted">
          Sign in again in another tab, then press Retry.
        </p>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button variant="outline" size="sm" onClick={handleDownload}>
          Download
        </Button>
        <Button variant="outline" size="sm" onClick={handleRetry}>
          Retry
        </Button>
        <Button variant="destructive" size="sm" onClick={handleDiscard}>
          Discard
        </Button>
      </div>
    </li>
  );
}

export function ChunkRescueBanner() {
  // Built with its real deps by the provider whichever component renders first (media-worker A.3).
  const queue = getChunkUploadQueue();
  const snapshot = useQueueSnapshot(queue);
  const { confirm, confirmElement } = useConfirm();

  // The banner (and its bulk actions) are scoped to chunks that have
  // actually FAILED (visual-gate finding, U9) — a healthy chunk mid-first-
  // attempt, or one merely queued behind a failed head with no failure of
  // its own, is neither shown nor swept up by "Discard remaining".
  const failedChunks = snapshot.chunks.filter(isShown);
  const recovered = snapshot.chunks.filter((c) => c.recovered);
  const recoveredMin = Math.max(
    1,
    Math.round(recovered.reduce((t, c) => t + (chunkDurationSec(c) ?? 0), 0) / 60),
  );
  const safariNote = recovered.some((c) => c.safari);

  const handleRetryAll = useCallback(() => {
    void queue.retryAll().catch(() => {});
  }, [queue]);

  const handleDownloadRecovered = useCallback(() => {
    for (const c of recovered) downloadChunk(c, queue);
  }, [queue, recovered]);

  const handleDiscardRecovered = useCallback(async () => {
    const ok = await confirm({
      title: 'Discard the recovered recording audio?',
      message: `This will permanently discard ${describeAmount(recovered)}. This cannot be undone.`,
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!ok) return;
    for (const c of recovered) void queue.discardChunk(c.key);
  }, [confirm, queue, recovered]);

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
      void queue.discardChunk(chunk.key);
    }
  }, [confirm, queue, failedChunks]);

  if (failedChunks.length === 0) return null;

  return (
    <>
      {/* shadcn-port-shell D6: the destructive Alert (role="alert" — still the one assertive
          surface; never a toast, never auto-dismissed). `block` replaces Alert's icon grid so the
          header row + chunk list lay out as before. */}
      <Alert
        variant="destructive"
        aria-live="assertive"
        className="fixed inset-x-0 top-0 z-(--z-toast) mx-auto mt-2 block w-[min(640px,94vw)] shadow-[0_8px_32px_rgba(0,0,0,0.35)]"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <AlertDescription className="m-0 block font-medium">
            {failedChunks.length} recorded audio {failedChunks.length === 1 ? 'chunk' : 'chunks'}{' '}
            could not be uploaded. Keep this tab open until they are retried, downloaded, or
            discarded.
          </AlertDescription>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleRetryAll}>
              Retry all
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDiscardAll}>
              Discard remaining
            </Button>
          </div>
        </div>
        {recovered.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="m-0 text-[0.82rem]">
              Recovered {recovered.length} {recovered.length === 1 ? 'chunk' : 'chunks'} (≈
              {recoveredMin} min) from a previous session.
              {safariNote &&
                ' Safari keeps unsent recordings for 7 days without a visit; upload them before then.'}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleRetryAll}>
                Upload all
              </Button>
              <Button variant="outline" size="sm" onClick={handleDownloadRecovered}>
                Download all
              </Button>
              <Button variant="destructive" size="sm" onClick={handleDiscardRecovered}>
                Discard recovered
              </Button>
            </div>
          </div>
        )}
        <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
          {failedChunks.map((chunk) => (
            <ChunkRow key={chunk.key} chunk={chunk} queue={queue} confirm={confirm} />
          ))}
        </ul>
      </Alert>
      {confirmElement}
    </>
  );
}
