import { describe, expect, it } from 'vitest';
import { FakeLockRegistry } from '../../../test/fakes/locks';
import type { ChunkManifest } from './chunkStore/types';
import {
  chunkLockName,
  createRecorderLocks,
  HEARTBEAT_STALE_MS,
  takeLockName,
} from './recorderLocks';

// --- media-worker A.2: cross-tab ownership of takes and chunks (design D10, panel A blocker) ---

const T0 = 1_000_000;

function manifest(over: Partial<ChunkManifest> = {}): ChunkManifest {
  return {
    kind: 'chunk',
    id: 'chunk-1',
    userId: 'u',
    sessionId: 'sess-1',
    recordingOrdinal: 2,
    chunkIndex: 0,
    startedAtUtc: '2026-10-12T10:00:00.000Z',
    endedAtUtc: null,
    mimeType: 'audio/webm',
    bytes: 1,
    sliceLog: [],
    finalized: false,
    pendingFinalize: null,
    createdAt: T0,
    updatedAt: T0,
    heartbeatAt: T0,
    safari: false,
    ...over,
  };
}

describe('recorderLocks with Web Locks', () => {
  it('names locks per take and per chunk', () => {
    expect(takeLockName('sess-1', 2)).toBe('autologger:recording:sess-1:2');
    expect(chunkLockName('chunk-1')).toBe('autologger:chunk:chunk-1');
  });

  it('holds the take lock for the take and releases it on stop', async () => {
    const reg = new FakeLockRegistry();
    const tabA = createRecorderLocks({ locks: reg.tab(), now: () => T0 });
    const release = await tabA.holdTake('sess-1', 2);
    expect(reg.isHeld('autologger:recording:sess-1:2')).toBe(true);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(reg.isHeld('autologger:recording:sess-1:2')).toBe(false);
  });

  it('holds a chunk lock only for the duration of one attempt', async () => {
    const reg = new FakeLockRegistry();
    const tabA = createRecorderLocks({ locks: reg.tab(), now: () => T0 });
    let heldDuring = false;
    const out = await tabA.withChunkLock('chunk-1', async () => {
      heldDuring = reg.isHeld('autologger:chunk:chunk-1');
      return 42;
    });
    expect(heldDuring).toBe(true);
    expect(out).toEqual({ acquired: true, value: 42 });
    expect(reg.isHeld('autologger:chunk:chunk-1')).toBe(false);
  });

  it("a second tab's attempt on a chunk being uploaded is refused, not queued", async () => {
    const reg = new FakeLockRegistry();
    const tabA = createRecorderLocks({ locks: reg.tab(), now: () => T0 });
    const tabB = createRecorderLocks({ locks: reg.tab(), now: () => T0 });
    let finishA!: () => void;
    const aDone = tabA.withChunkLock('chunk-1', () => new Promise<void>((r) => (finishA = r)));
    await Promise.resolve();
    const b = await tabB.withChunkLock('chunk-1', async () => 'ran');
    expect(b).toEqual({ acquired: false });
    finishA();
    await aDone;
  });

  it('the scan skips a chunk whose chunk lock is held, and one whose take lock is held', async () => {
    const reg = new FakeLockRegistry();
    const tabA = createRecorderLocks({ locks: reg.tab(), now: () => T0 });
    const tabB = createRecorderLocks({ locks: reg.tab(), now: () => T0 });

    // Tab A records take (sess-1, 2).
    const release = await tabA.holdTake('sess-1', 2);
    expect(await tabB.isRecoverable(manifest())).toBe(false);
    // A chunk of another take is recoverable…
    expect(await tabB.isRecoverable(manifest({ id: 'c9', recordingOrdinal: 7 }))).toBe(true);
    release();
    await Promise.resolve();
    await Promise.resolve();
    // …and after the take ends, so is this one, unless its upload is in flight.
    let finish!: () => void;
    const uploading = tabA.withChunkLock('chunk-1', () => new Promise<void>((r) => (finish = r)));
    await Promise.resolve();
    expect(await tabB.isRecoverable(manifest())).toBe(false);
    finish();
    await uploading;
    expect(await tabB.isRecoverable(manifest())).toBe(true);
  });

  it('checking a chunk does not leave its locks held', async () => {
    const reg = new FakeLockRegistry();
    const tabB = createRecorderLocks({ locks: reg.tab(), now: () => T0 });
    await tabB.isRecoverable(manifest());
    expect(reg.heldNames()).toEqual([]);
  });

  it('a finalize record is skipped only while its take lock is held', async () => {
    const reg = new FakeLockRegistry();
    const tabA = createRecorderLocks({ locks: reg.tab(), now: () => T0 });
    const tabB = createRecorderLocks({ locks: reg.tab(), now: () => T0 });
    const fin = manifest({ kind: 'finalize', id: 'fin.sess-1.2', chunkIndex: -1 });
    expect(await tabB.isRecoverable(fin)).toBe(true);
    const release = await tabA.holdTake('sess-1', 2);
    expect(await tabB.isRecoverable(fin)).toBe(false);
    release();
  });
});

describe('recorderLocks without navigator.locks (heartbeat lease)', () => {
  it('reports heartbeat mode and runs the attempt without a lock', async () => {
    const locks = createRecorderLocks({ locks: null, now: () => T0 });
    expect(locks.mode).toBe('heartbeat');
    expect(await locks.withChunkLock('c', async () => 'x')).toEqual({ acquired: true, value: 'x' });
    const release = await locks.holdTake('s', 1);
    release();
  });

  it('a fresh heartbeat is skipped; a 30 s-stale one is recovered', async () => {
    let t = T0;
    const locks = createRecorderLocks({ locks: null, now: () => t });
    t = T0 + HEARTBEAT_STALE_MS - 1;
    expect(await locks.isRecoverable(manifest({ heartbeatAt: T0 }))).toBe(false);
    t = T0 + HEARTBEAT_STALE_MS + 1;
    expect(await locks.isRecoverable(manifest({ heartbeatAt: T0 }))).toBe(true);
  });

  it('a lock manager that throws degrades to the heartbeat rule', async () => {
    const broken = {
      request: async () => {
        throw new Error('SecurityError');
      },
    };
    const locks = createRecorderLocks({ locks: broken, now: () => T0 + HEARTBEAT_STALE_MS + 5 });
    expect(await locks.isRecoverable(manifest({ heartbeatAt: T0 }))).toBe(true);
    expect(await locks.isRecoverable(manifest({ heartbeatAt: T0 + HEARTBEAT_STALE_MS }))).toBe(
      false,
    );
  });
});

describe('holdChunk (A.8: the queue owns a chunk for its whole stay)', () => {
  it('holds the chunk lock until released; a second holder gets null', async () => {
    const reg = new FakeLockRegistry();
    const a = createRecorderLocks({ locks: reg.tab(), now: () => T0 });
    const b = createRecorderLocks({ locks: reg.tab(), now: () => T0 });
    const release = await a.holdChunk('c1');
    expect(release).not.toBeNull();
    expect(reg.isHeld('autologger:chunk:c1')).toBe(true);
    expect(await b.holdChunk('c1')).toBeNull();
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(reg.isHeld('autologger:chunk:c1')).toBe(false);
  });

  it('heartbeat mode returns a no-op release', async () => {
    const locks = createRecorderLocks({ locks: null, now: () => T0 });
    const release = await locks.holdChunk('c1');
    expect(typeof release).toBe('function');
  });
});
