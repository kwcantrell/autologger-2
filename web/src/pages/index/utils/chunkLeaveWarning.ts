// Queue-scoped `beforeunload` leave warning (chunked-live-recording, design
// D6; spec: live-recording-chunks "Rescue and uploads are bound to their
// recording's session and survive component lifecycle" — "The page-leave
// warning SHALL cover, in addition to active recording, any state with a
// non-empty rescue queue or an in-flight chunk upload.").
//
// `AudioRecorder.tsx` already warns for `phase === 'recording'` via its own
// component-scoped listener — that one is fine as-is (it only needs to live
// as long as a recording CAN be active, which is exactly the component's
// mount span). But the rescue queue outlives the component (module-owned,
// survives unmount/session-switch — design D6), so the "queue non-empty or
// upload in-flight" half of the guard cannot be a component effect: closing
// the tab minutes after `AudioRecorder` unmounted, with failed chunks still
// queued, must still warn. This installs a SECOND, independent listener at
// module scope (mirrors `departureWatcher.ts`'s idempotent-install
// convention) — multiple `beforeunload` listeners compose fine; each gets a
// chance to call `preventDefault()`.
//
// Reads the queue via `peekChunkUploadQueue()`, never `getChunkUploadQueue()`
// — this module must never risk constructing the singleton (and winning the
// deps race against `AudioRecorder.tsx`'s real upload/listSegments deps).
// Before any recording ever starts the singleton doesn't exist yet, which is
// exactly "nothing to warn about".

import { peekChunkUploadQueue } from './chunkUploadQueue';

const LEAVE_WARNING_MESSAGE =
  'Some recorded audio has not finished uploading. Leaving now may lose it.';

function handleBeforeUnload(e: BeforeUnloadEvent): void {
  const queue = peekChunkUploadQueue();
  if (!queue) return;
  const snapshot = queue.getSnapshot();
  if (snapshot.chunks.length === 0 && !snapshot.inFlight) return;
  e.preventDefault();
  e.returnValue = LEAVE_WARNING_MESSAGE;
}

let installed = false;

/** Idempotent. Installed once below, at import time (module evaluation runs
 *  once regardless of StrictMode's render/effect double-invocation). */
export function installChunkLeaveWarning(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('beforeunload', handleBeforeUnload);
}

/** Test seam: undo the module-scope installation so tests can reinstall
 *  against a fresh `window` / reassert idempotency. */
export function uninstallChunkLeaveWarningForTesting(): void {
  window.removeEventListener('beforeunload', handleBeforeUnload);
  installed = false;
}

installChunkLeaveWarning();
