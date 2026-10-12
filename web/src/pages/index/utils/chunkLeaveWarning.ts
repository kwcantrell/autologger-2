// Queue-scoped `beforeunload` leave warning (chunked-live-recording, design
// D6; spec: live-recording-chunks "Rescue and uploads are bound to their
// recording's session and survive component lifecycle" — "The page-leave
// warning SHALL cover, in addition to active recording, any state with a
// non-empty rescue queue or an in-flight chunk upload.").
//
// `AudioRecorder.tsx` already warns for `phase === 'recording'` via its own
// component-scoped listener. But the rescue queue outlives the component
// (module-owned, survives unmount/session-switch — design D6), so the "queue
// non-empty or upload in-flight" half of the guard cannot be a component
// effect: closing the tab minutes after `AudioRecorder` unmounted, with failed
// chunks still queued, must still warn. That much is unchanged.
//
// What changed (perf, bfcache): the listener is no longer installed for the
// lifetime of the module. A registered `beforeunload` listener makes the page
// permanently ineligible for the back/forward cache — the browser disqualifies
// on the listener's mere presence, never on what it does — so an unconditional
// module-scope install cost every route a restored-from-bfcache navigation,
// including the overwhelmingly common case where nothing has ever been
// recorded. Instead this module SUBSCRIBES to the queue and attaches the
// listener only while there is actually something to lose, detaching again the
// moment the queue drains. Multiple `beforeunload` listeners still compose
// fine; each gets a chance to call `preventDefault()`.
//
// Reads the queue via `peekChunkUploadQueue()` / the creation seam, never
// `getChunkUploadQueue()` — this module must never risk constructing the
// singleton (and winning the deps race against `AudioRecorder.tsx`'s real
// upload/listSegments deps). Before any recording ever starts the singleton
// doesn't exist yet, which is exactly "nothing to warn about" — and now also
// "nothing blocking bfcache".

import { useCallback } from 'react';
import { useConfirm } from '../../../shared/ui/ConfirmDialog';
import { type ChunkStore, getChunkStore } from './chunkStore';
import {
  type ChunkQueueSnapshot,
  type ChunkUploadQueue,
  onChunkUploadQueueCreated,
  peekChunkUploadQueue,
} from './chunkUploadQueue';

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

/** Idempotent: a repeated non-empty snapshot must not stack a second listener. */
function attach(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('beforeunload', handleBeforeUnload);
}

/** Symmetric counterpart to `attach()` — idempotent for the same reason. */
function detach(): void {
  if (!installed) return;
  installed = false;
  window.removeEventListener('beforeunload', handleBeforeUnload);
}

/** Per-queue subscription disposers, so the test seam below can fully unwind. */
const queueDisposers = new Set<() => void>();
let unsubscribeCreation: (() => void) | null = null;

function watchQueue(queue: ChunkUploadQueue): void {
  // The queue notifies its listeners SYNCHRONOUSLY from inside `enqueue()`
  // (and from every other mutation point — see `notify()` in
  // `chunkUploadQueue.ts`), so `attach()` runs in the same turn as the chunk
  // landing in the queue. There is no window in which a chunk is at risk but
  // the warning is not yet armed. `handleBeforeUnload` still re-reads the live
  // snapshot as race defense.
  const sync = (snapshot: ChunkQueueSnapshot) => {
    if (snapshot.chunks.length > 0 || snapshot.inFlight) attach();
    else detach();
  };
  queueDisposers.add(queue.subscribe(sync));
  sync(queue.getSnapshot());
}

/** Idempotent. Started once below, at import time (module evaluation runs once
 *  regardless of StrictMode's render/effect double-invocation). Installs the
 *  queue subscription, not the `beforeunload` listener — the listener comes and
 *  goes with the queue's contents. */
export function installChunkLeaveWarning(): void {
  if (unsubscribeCreation) return;
  unsubscribeCreation = onChunkUploadQueueCreated(watchQueue);
}

/** Test seam: undo the module-scope installation — the creation subscription,
 *  every per-queue subscription it opened, and the `beforeunload` listener
 *  itself — so tests can reinstall against a fresh queue / reassert
 *  idempotency. */
export function uninstallChunkLeaveWarningForTesting(): void {
  unsubscribeCreation?.();
  unsubscribeCreation = null;
  for (const dispose of queueDisposers) dispose();
  queueDisposers.clear();
  detach();
}

installChunkLeaveWarning();

// ---------------------------------------------------------------------------
// Sign-out (media-worker design D10, panel A: shared machines). Stored chunks are per user; signing
// out first warns when that user has unsent chunks (the leave-warning's subject), then wipes that
// user's storage. Another user's entries are never read or touched.
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

export interface SignOutGuardDeps {
  userId: string | null;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  store?: Pick<ChunkStore, 'list' | 'wipe'>;
  /** The tab's queue (`peekChunkUploadQueue()` when omitted); `null` for none. */
  queue?: ChunkUploadQueue | null;
}

function spanSec(startedAtUtc: string, endedAtUtc: string | null, fallbackMs: number): number {
  const start = Date.parse(startedAtUtc);
  const end = endedAtUtc ? Date.parse(endedAtUtc) : fallbackMs;
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? (end - start) / 1000 : 0;
}

function amountPhrase(count: number, seconds: number): string {
  const word = count === 1 ? 'chunk' : 'chunks';
  if (seconds <= 0) return `${count} recorded audio ${word}`;
  const sec = Math.round(seconds);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const dur = m === 0 ? `${s}s` : s === 0 ? `${m}m` : `${m}m ${s}s`;
  return `${count} recorded audio ${word} (${dur})`;
}

/**
 * Resolve `true` when sign-out may proceed. Unsent chunks of `userId` (stored, or held by the
 * queue) ask for a confirmation naming them; on confirm, or when there are none, the user's
 * stored chunks are wiped and the queue's chunks discarded.
 */
export async function guardSignOut(deps: SignOutGuardDeps): Promise<boolean> {
  const { userId } = deps;
  if (!userId) return true;
  const store = deps.store ?? getChunkStore();
  const queue = deps.queue === undefined ? peekChunkUploadQueue() : deps.queue;

  let stored: Awaited<ReturnType<ChunkStore['list']>> = [];
  try {
    stored = (await store.list(userId)).filter((m) => m.kind === 'chunk');
  } catch {
    stored = [];
  }
  const storedIds = new Set(stored.map((m) => m.id));
  // Only this user's chunks: another user's are never counted, shown or discarded (A.8).
  const queued = (queue?.getSnapshot().chunks ?? []).filter(
    (c) => c.userId === userId && (!c.storeId || !storedIds.has(c.storeId)),
  );
  const count = stored.length + queued.length;
  if (count > 0) {
    const seconds =
      stored.reduce((t, m) => t + spanSec(m.startedAtUtc, m.endedAtUtc, m.updatedAt), 0) +
      queued.reduce((t, c) => t + spanSec(c.startedAtUtc, c.endedAtUtc, 0), 0);
    const ok = await deps.confirm({
      title: 'Sign out with unsent audio?',
      message: `${amountPhrase(count, seconds)} ${count === 1 ? 'has' : 'have'} not finished uploading. Signing out deletes ${count === 1 ? 'it' : 'them'} from this browser. Download ${count === 1 ? 'it' : 'them'} from the rescue banner first if you need ${count === 1 ? 'it' : 'them'}.`,
      confirmLabel: 'Sign out and delete',
      danger: true,
    });
    if (!ok) return false;
  }
  try {
    await store.wipe(userId);
  } catch {
    /* best effort: the 30-day cleanup is the backstop */
  }
  queue?.discardUser(userId);
  return true;
}

/**
 * The sign-out control's guard: `onSignOut(event)` holds the navigation, runs `guardSignOut`, and
 * then follows the link. Render `confirmElement` beside the control.
 */
export function useChunkSignOutGuard(userId: string | null, href = '/auth/logout') {
  const { confirm, confirmElement } = useConfirm();
  const onSignOut = useCallback(
    (event: { preventDefault(): void }) => {
      event.preventDefault();
      void guardSignOut({ userId, confirm }).then((ok) => {
        if (ok) window.location.assign(href);
      });
    },
    [userId, confirm, href],
  );
  return { onSignOut, confirmElement };
}
