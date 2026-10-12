/**
 * Cross-tab ownership of recordings and chunks (media-worker design D10, panel A blocker; spec
 * live-recording-chunks "Finished chunks are persisted locally until the server confirms them").
 *
 * - The recorder holds `autologger:recording:<sessionId>:<ordinal>` for the whole take.
 * - The uploader holds `autologger:chunk:<chunkId>` for each attempt.
 * - The recovery scan asks for both with `ifAvailable` and skips a stored entry when either is
 *   held, so a second tab never recovers what the first is still recording or uploading
 *   (spike 0.3: a second tab's `ifAvailable` request gets `null` in Chromium, Firefox and WebKit).
 *
 * Where `navigator.locks` is missing (or throws), the manifest's `heartbeatAt`, refreshed by the
 * owner, is a 30 s lease with the same rule.
 */

import type { ChunkManifest } from './chunkStore/types';

/** A heartbeat older than this means the owner is gone (design D10). */
export const HEARTBEAT_STALE_MS = 30_000;
/** How often an owner refreshes heartbeats where Web Locks are missing. */
export const HEARTBEAT_REFRESH_MS = 10_000;

export function takeLockName(sessionId: string, recordingOrdinal: number): string {
  return `autologger:recording:${sessionId}:${recordingOrdinal}`;
}

export function chunkLockName(chunkId: string): string {
  return `autologger:chunk:${chunkId}`;
}

/** The `LockManager` subset used here (exclusive locks only). */
export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: { name: string } | null) => unknown,
  ): Promise<unknown>;
}

export interface RecorderLocksDeps {
  /** `navigator.locks`, or null where unavailable. */
  locks: LockManagerLike | null;
  now: () => number;
}

export type ChunkLockOutcome<T> = { acquired: true; value: T } | { acquired: false };

export interface RecorderLocks {
  readonly mode: 'locks' | 'heartbeat';
  /** Take the take lock; resolves once held (or at once in heartbeat mode) with its release. */
  holdTake(sessionId: string, recordingOrdinal: number): Promise<() => void>;
  /** Run one upload attempt under the chunk's lock; `{acquired: false}` when another tab holds it. */
  withChunkLock<T>(chunkId: string, fn: () => Promise<T>): Promise<ChunkLockOutcome<T>>;
  /** False when the entry's take or chunk lock (or a fresh heartbeat) says another owner is live. */
  isRecoverable(manifest: ChunkManifest): Promise<boolean>;
}

export function createRecorderLocks(deps: RecorderLocksDeps): RecorderLocks {
  const { now } = deps;
  let locks = deps.locks;

  const heartbeatFresh = (m: ChunkManifest) => now() - m.heartbeatAt < HEARTBEAT_STALE_MS;

  /** True when nobody holds `name`. Throws only when the lock manager itself fails. */
  async function free(manager: LockManagerLike, name: string): Promise<boolean> {
    const result = await manager.request(name, { ifAvailable: true }, (lock) => lock !== null);
    return result === true;
  }

  return {
    get mode() {
      return locks ? 'locks' : 'heartbeat';
    },

    holdTake(sessionId, recordingOrdinal) {
      const manager = locks;
      if (!manager) return Promise.resolve(() => {});
      return new Promise<() => void>((resolveHeld) => {
        let release!: () => void;
        const released = new Promise<void>((r) => {
          release = r;
        });
        manager
          .request(takeLockName(sessionId, recordingOrdinal), { ifAvailable: true }, (lock) => {
            // Contended only if another tab records the same ordinal (never by design): recording
            // goes on regardless; the lock is advisory for the recovery scan.
            resolveHeld(release);
            return lock ? released : undefined;
          })
          .catch(() => resolveHeld(release));
      });
    },

    async withChunkLock(chunkId, fn) {
      const manager = locks;
      if (!manager) return { acquired: true, value: await fn() };
      let ran = false;
      let value: Awaited<ReturnType<typeof fn>> | undefined;
      try {
        await manager.request(chunkLockName(chunkId), { ifAvailable: true }, async (lock) => {
          if (!lock) return;
          ran = true;
          value = await fn();
        });
      } catch (err) {
        if (ran) throw err;
        // The lock manager failed before the attempt ran: drop to the heartbeat rule.
        locks = null;
        return { acquired: true, value: await fn() };
      }
      return ran
        ? { acquired: true, value: value as Awaited<ReturnType<typeof fn>> }
        : { acquired: false };
    },

    async isRecoverable(manifest) {
      const manager = locks;
      if (!manager) return !heartbeatFresh(manifest);
      try {
        if (!(await free(manager, takeLockName(manifest.sessionId, manifest.recordingOrdinal)))) {
          return false;
        }
        if (manifest.kind === 'chunk' && !(await free(manager, chunkLockName(manifest.id)))) {
          return false;
        }
        return true;
      } catch {
        locks = null;
        return !heartbeatFresh(manifest);
      }
    },
  };
}

/** `navigator.locks` when present. */
export function browserLockManager(): LockManagerLike | null {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  return nav?.locks && typeof nav.locks.request === 'function' ? nav.locks : null;
}
