import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PartsUploadError } from '../../../api/uploads';
import { FakeLockRegistry } from '../../../test/fakes/locks';
import { type ChunkStore, createChunkStore } from './chunkStore';
import { createMemoryBackend } from './chunkStore/memoryBackend';
import {
  type ChunkInput,
  type ChunkUploadQueue,
  type Clock,
  createChunkUploadQueue,
  type ExistingSegment,
  getChunkUploadQueue,
  onChunkUploadQueueCreated,
  resetChunkUploadQueueForTesting,
  type UploadOutcome,
  uploadChunkViaParts,
} from './chunkUploadQueue';
import { chunkLockName, createRecorderLocks, takeLockName } from './recorderLocks';

// --- chunk-upload pipeline tests (chunked-live-recording, task 4.1) ---
//
// Covers the task's required list: ordering under slow uploads,
// Retry-vs-boundary race (single-flight re-entrancy), poison-pill
// drain-past, ambiguous-failure dedupe, discard consent — plus the spec's
// lost-response and slow-upload-defers-next-chunk scenarios, zero-byte
// rejection, and the idle/pendingOrdinals snapshot surface D8 needs.
//
// No real fetches: `upload`/`listSegments` are hand-rolled fakes the tests
// drive by resolving/rejecting deferred promises, so ordering is asserted
// deterministically rather than via fake timers (the module takes no timers
// itself — `pump()` is purely promise-driven).

function makeClock(): Clock {
  let t = 0;
  return { now: () => t++ };
}

function blob(bytes = 10): Blob {
  return new Blob([new Uint8Array(bytes)]);
}

function chunk(overrides: Partial<ChunkInput> = {}): ChunkInput {
  return {
    sessionId: 'sess-1',
    recordingOrdinal: 1,
    chunkIndex: 0,
    blob: blob(),
    startedAtUtc: '2026-08-12T00:00:00.000Z',
    endedAtUtc: '2026-08-12T00:10:00.000Z',
    mimeType: 'audio/webm',
    ...overrides,
  };
}

/** A rejection shaped like `ApiError` (web/src/api/client.ts) — status-bearing. */
class FakeApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A rejection shaped like a raw fetch network failure — no `status`. */
class FakeNetworkError extends Error {}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createChunkUploadQueue', () => {
  describe('enqueue', () => {
    it('rejects zero-byte chunks outright — never added to the queue', () => {
      const upload = vi.fn();
      const listSegments = vi.fn();
      const q = createChunkUploadQueue({ upload, listSegments, clock: makeClock() });

      const ok = q.enqueue(chunk({ blob: blob(0) }));

      expect(ok).toBe(false);
      expect(q.getSnapshot().chunks).toHaveLength(0);
    });

    it('accepts a non-empty chunk and reflects it in the snapshot', () => {
      const q = createChunkUploadQueue({
        upload: vi.fn(),
        listSegments: vi.fn(),
        clock: makeClock(),
      });

      const ok = q.enqueue(chunk({ chunkIndex: 0 }));

      expect(ok).toBe(true);
      const snap = q.getSnapshot();
      expect(snap.chunks).toHaveLength(1);
      expect(snap.chunks[0].classification).toBe('queued');
      expect(snap.idle).toBe(false);
      expect(snap.pendingOrdinals).toEqual([1]);
    });
  });

  describe('ordering under slow uploads / single-flight', () => {
    it("a later chunk's upload never starts before the earlier chunk's outcome is known", async () => {
      const order: string[] = [];
      const first = deferred<UploadOutcome>();
      const upload = vi.fn((c: ChunkInput) => {
        order.push(`start:${c.chunkIndex}`);
        if (c.chunkIndex === 0) return first.promise;
        return Promise.resolve<UploadOutcome>({
          ok: true,
          segment: {
            id: 's2',
            recording_ordinal: c.recordingOrdinal,
            started_at_utc: c.startedAtUtc,
          },
        });
      });
      const q = createChunkUploadQueue({ upload, listSegments: vi.fn(), clock: makeClock() });

      q.enqueue(chunk({ chunkIndex: 0 }));
      q.enqueue(chunk({ chunkIndex: 1 }));

      const pumpPromise = q.pump();
      // Only chunk 0's attempt should have started so far.
      await Promise.resolve();
      await Promise.resolve();
      expect(order).toEqual(['start:0']);
      expect(q.getSnapshot().inFlight).toBe(true);

      first.resolve({
        ok: true,
        segment: { id: 's1', recording_ordinal: 1, started_at_utc: chunk().startedAtUtc },
      });
      await pumpPromise;

      expect(order).toEqual(['start:0', 'start:1']);
      expect(q.getSnapshot().chunks).toHaveLength(0);
      expect(q.getSnapshot().idle).toBe(true);
    });

    it('a slow chunk k upload defers chunk k+1 — a concurrent pump call observes k+1 not yet attempted', async () => {
      const kAttempt = deferred<UploadOutcome>();
      const attempted: number[] = [];
      const upload = vi.fn((c: ChunkInput) => {
        attempted.push(c.chunkIndex);
        if (c.chunkIndex === 0) return kAttempt.promise;
        return Promise.resolve<UploadOutcome>({
          ok: true,
          segment: { id: `s${c.chunkIndex}`, recording_ordinal: 1, started_at_utc: c.startedAtUtc },
        });
      });
      const q = createChunkUploadQueue({ upload, listSegments: vi.fn(), clock: makeClock() });
      q.enqueue(chunk({ chunkIndex: 0 }));
      q.enqueue(chunk({ chunkIndex: 1 }));

      const p1 = q.pump();
      await Promise.resolve();
      await Promise.resolve();
      // Simulate the rollover boundary firing its own pump() while chunk 0
      // is still in flight — single-flight must collapse this onto the
      // already-running attempt rather than starting chunk 1 early.
      const p2 = q.pump();

      expect(attempted).toEqual([0]);

      kAttempt.resolve({
        ok: true,
        segment: { id: 's0', recording_ordinal: 1, started_at_utc: chunk().startedAtUtc },
      });
      await Promise.all([p1, p2]);

      expect(attempted).toEqual([0, 1]);
    });
  });

  describe('Retry-vs-boundary race (single-flight re-entrancy)', () => {
    it('each queued chunk is uploaded at most once when two pump() calls race', async () => {
      const attempts: number[] = [];
      const gate = deferred<void>();
      const upload = vi.fn(async (c: ChunkInput) => {
        attempts.push(c.chunkIndex);
        await gate.promise;
        return {
          ok: true as const,
          segment: { id: `s${c.chunkIndex}`, recording_ordinal: 1, started_at_utc: c.startedAtUtc },
        };
      });
      const q = createChunkUploadQueue({ upload, listSegments: vi.fn(), clock: makeClock() });
      q.enqueue(chunk({ chunkIndex: 0 }));
      q.enqueue(chunk({ chunkIndex: 1 }));

      // Boundary trigger and Retry trigger racing "moments apart" — call
      // pump() twice before either resolves.
      const boundary = q.pump();
      const retry = q.pump();

      gate.resolve();
      await Promise.all([boundary, retry]);

      expect(upload).toHaveBeenCalledTimes(2);
      expect(attempts).toEqual([0, 1]);
      expect(q.getSnapshot().chunks).toHaveLength(0);
    });

    it('a collapsed pump() call returns the SAME promise as the running attempt, not an immediately-resolved one (F1)', async () => {
      const gate = deferred<void>();
      const upload = vi.fn(async (c: ChunkInput) => {
        await gate.promise;
        return {
          ok: true as const,
          segment: { id: `s${c.chunkIndex}`, recording_ordinal: 1, started_at_utc: c.startedAtUtc },
        };
      });
      const q = createChunkUploadQueue({ upload, listSegments: vi.fn(), clock: makeClock() });
      q.enqueue(chunk({ chunkIndex: 0 }));

      const first = q.pump();
      const collapsed = q.pump();
      expect(collapsed).toBe(first);

      let collapsedResolved = false;
      void collapsed.then(() => {
        collapsedResolved = true;
      });

      // Give microtasks a chance to run while the upload is still gated —
      // a false-immediate resolution (the pre-fix behavior) would flip
      // collapsedResolved here even though the drain hasn't finished.
      await Promise.resolve();
      await Promise.resolve();
      expect(collapsedResolved).toBe(false);

      gate.resolve();
      await first;
      expect(collapsedResolved).toBe(true);
    });

    it('pump() constructs a fresh promise for a call made after the prior pump settled', async () => {
      const upload = vi.fn(async (c: ChunkInput) => ({
        ok: true as const,
        segment: { id: `s${c.chunkIndex}`, recording_ordinal: 1, started_at_utc: c.startedAtUtc },
      }));
      const q = createChunkUploadQueue({ upload, listSegments: vi.fn(), clock: makeClock() });
      q.enqueue(chunk({ chunkIndex: 0 }));

      const first = q.pump();
      await first;

      q.enqueue(chunk({ chunkIndex: 1 }));
      const second = q.pump();
      expect(second).not.toBe(first);
      await second;

      expect(upload).toHaveBeenCalledTimes(2);
    });
  });

  describe('poison-pill drain-past (permanent 4xx head set aside, later chunks drain)', () => {
    it('a permanently-failing head chunk moves to rescue-only and later chunks upload normally', async () => {
      const upload = vi.fn((c: ChunkInput): Promise<UploadOutcome> => {
        if (c.chunkIndex === 0) {
          return Promise.reject(new FakeApiError(422, 'unprocessable'));
        }
        return Promise.resolve({
          ok: true,
          segment: { id: `s${c.chunkIndex}`, recording_ordinal: 1, started_at_utc: c.startedAtUtc },
        });
      });
      const q = createChunkUploadQueue({ upload, listSegments: vi.fn(), clock: makeClock() });
      q.enqueue(chunk({ chunkIndex: 0 }));
      q.enqueue(chunk({ chunkIndex: 1 }));
      q.enqueue(chunk({ chunkIndex: 2 }));

      await q.pump();

      const snap = q.getSnapshot();
      expect(snap.chunks).toHaveLength(1);
      expect(snap.chunks[0].chunkIndex).toBe(0);
      expect(snap.chunks[0].classification).toBe('permanent');
      expect(snap.chunks[0].lastError).toContain('unprocessable');
      // Chunks 1 and 2 drained (removed from the queue on success).
      expect(upload).toHaveBeenCalledTimes(3);
    });

    it('a transient (5xx) failure stays queued, not permanent, and does not drain past', async () => {
      const upload = vi.fn((c: ChunkInput): Promise<UploadOutcome> => {
        if (c.chunkIndex === 0) return Promise.reject(new FakeApiError(503, 'unavailable'));
        return Promise.resolve({
          ok: true,
          segment: { id: `s${c.chunkIndex}`, recording_ordinal: 1, started_at_utc: c.startedAtUtc },
        });
      });
      const q = createChunkUploadQueue({ upload, listSegments: vi.fn(), clock: makeClock() });
      q.enqueue(chunk({ chunkIndex: 0 }));
      q.enqueue(chunk({ chunkIndex: 1 }));

      await q.pump();

      const snap = q.getSnapshot();
      // Chunk 0 stays queued (transient), chunk 1 was never attempted this
      // pump because chunk 0's outcome, while known, keeps it at the head.
      expect(snap.chunks).toHaveLength(2);
      expect(snap.chunks[0].chunkIndex).toBe(0);
      expect(snap.chunks[0].classification).toBe('queued');
      expect(upload).toHaveBeenCalledTimes(1);

      // A later pump (boundary/Retry) re-attempts chunk 0 first, then drains chunk 1.
      const ok = q;
      void ok;
    });

    it('408 and 429 classify transient; 401/403 blocked (media-worker D11); other 4xx permanent', async () => {
      const statuses = [408, 429, 400, 401, 403, 404];
      for (const status of statuses) {
        const upload = vi.fn(() => Promise.reject(new FakeApiError(status, `status ${status}`)));
        const q = createChunkUploadQueue({ upload, listSegments: vi.fn(), clock: makeClock() });
        q.enqueue(chunk({ chunkIndex: 0 }));
        await q.pump();
        const c = q.getSnapshot().chunks[0];
        const expected =
          status === 408 || status === 429
            ? 'queued'
            : status === 401 || status === 403
              ? 'blocked'
              : 'permanent';
        expect(c.classification, `status ${status}`).toBe(expected);
      }
    });
  });

  describe('ambiguous-failure dedupe (lost-response scenario)', () => {
    it('a network-level failure followed by a listSegments match is treated as success — no re-upload', async () => {
      const upload = vi.fn(() => Promise.reject(new FakeNetworkError('network down')));
      const listSegments = vi.fn(
        async (): Promise<ExistingSegment[]> => [
          { recording_ordinal: 1, started_at_utc: chunk().startedAtUtc },
        ],
      );
      const q = createChunkUploadQueue({ upload, listSegments, clock: makeClock() });
      q.enqueue(chunk({ chunkIndex: 0 }));

      // First pump: network failure marks the chunk ambiguous, stays queued.
      await q.pump();
      expect(q.getSnapshot().chunks).toHaveLength(1);
      expect(upload).toHaveBeenCalledTimes(1);

      // Second pump: dedupe check runs before any re-upload attempt.
      await q.pump();

      expect(listSegments).toHaveBeenCalledWith('sess-1');
      expect(upload).toHaveBeenCalledTimes(1); // still 1 — no re-upload attempt
      expect(q.getSnapshot().chunks).toHaveLength(0); // treated as success, removed
    });

    it('a network-level failure with no matching segment re-attempts the upload as transient', async () => {
      let call = 0;
      const upload = vi.fn((c: ChunkInput): Promise<UploadOutcome> => {
        call += 1;
        if (call === 1) return Promise.reject(new FakeNetworkError('network down'));
        return Promise.resolve({
          ok: true,
          segment: { id: 's1', recording_ordinal: 1, started_at_utc: c.startedAtUtc },
        });
      });
      const listSegments = vi.fn(async (): Promise<ExistingSegment[]> => []);
      const q = createChunkUploadQueue({ upload, listSegments, clock: makeClock() });
      q.enqueue(chunk({ chunkIndex: 0 }));

      await q.pump();
      expect(q.getSnapshot().chunks).toHaveLength(1);

      await q.pump();

      expect(listSegments).toHaveBeenCalledTimes(1);
      expect(upload).toHaveBeenCalledTimes(2);
      expect(q.getSnapshot().chunks).toHaveLength(0);
    });

    it('matches dedupe strictly on recording_ordinal + started_at_utc, not just recording_ordinal', async () => {
      const upload = vi.fn(() => Promise.reject(new FakeNetworkError('down')));
      const listSegments = vi.fn(
        async (): Promise<ExistingSegment[]> => [
          { recording_ordinal: 1, started_at_utc: '2099-01-01T00:00:00.000Z' }, // different timestamp
        ],
      );
      const q = createChunkUploadQueue({ upload, listSegments, clock: makeClock() });
      q.enqueue(chunk({ chunkIndex: 0, startedAtUtc: '2026-08-12T00:00:00.000Z' }));

      await q.pump(); // ambiguous
      await q.pump(); // dedupe check: no match

      // No match → stays queued for re-attempt, not silently dropped.
      expect(q.getSnapshot().chunks).toHaveLength(1);
    });

    it('a failed dedupe lookup itself leaves the chunk queued rather than assuming success or duplicating', async () => {
      const upload = vi.fn(() => Promise.reject(new FakeNetworkError('down')));
      const listSegments = vi.fn(() => Promise.reject(new Error('list failed too')));
      const q = createChunkUploadQueue({ upload, listSegments, clock: makeClock() });
      q.enqueue(chunk({ chunkIndex: 0 }));

      await q.pump();
      await q.pump();

      expect(q.getSnapshot().chunks).toHaveLength(1);
      expect(upload).toHaveBeenCalledTimes(1); // no blind re-upload attempted either
    });
  });

  describe('discard consent', () => {
    it('nothing leaves the queue without success or an explicit discard call', async () => {
      const upload = vi.fn(() => Promise.reject(new FakeApiError(500, 'server error')));
      const q = createChunkUploadQueue({ upload, listSegments: vi.fn(), clock: makeClock() });
      q.enqueue(chunk({ chunkIndex: 0 }));

      await q.pump();
      await q.pump();
      await q.pump();

      // Repeated pumps against a persistently-failing transient chunk never
      // silently drop it.
      expect(q.getSnapshot().chunks).toHaveLength(1);
    });

    it('discard(recordingOrdinal, chunkIndex) removes exactly the named chunk', () => {
      const q = createChunkUploadQueue({
        upload: vi.fn(),
        listSegments: vi.fn(),
        clock: makeClock(),
      });
      q.enqueue(chunk({ chunkIndex: 0 }));
      q.enqueue(chunk({ chunkIndex: 1 }));

      q.discard(1, 0);

      const snap = q.getSnapshot();
      expect(snap.chunks).toHaveLength(1);
      expect(snap.chunks[0].chunkIndex).toBe(1);
    });

    it('discardAll() requires its own explicit call and clears every chunk', () => {
      const q = createChunkUploadQueue({
        upload: vi.fn(),
        listSegments: vi.fn(),
        clock: makeClock(),
      });
      q.enqueue(chunk({ chunkIndex: 0 }));
      q.enqueue(chunk({ chunkIndex: 1 }));
      q.enqueue(chunk({ chunkIndex: 2 }));

      expect(q.getSnapshot().chunks).toHaveLength(3);
      q.discardAll();
      expect(q.getSnapshot().chunks).toHaveLength(0);
      expect(q.getSnapshot().idle).toBe(true);
    });

    it('a permanently-classified chunk is only removed by explicit discard, never automatically', async () => {
      const upload = vi.fn(() => Promise.reject(new FakeApiError(400, 'bad request')));
      const q = createChunkUploadQueue({ upload, listSegments: vi.fn(), clock: makeClock() });
      q.enqueue(chunk({ chunkIndex: 0 }));

      await q.pump();
      expect(q.getSnapshot().chunks[0].classification).toBe('permanent');

      // Further pumps never touch a permanent chunk.
      await q.pump();
      expect(q.getSnapshot().chunks).toHaveLength(1);

      q.discard(1, 0);
      expect(q.getSnapshot().chunks).toHaveLength(0);
    });
  });

  describe('snapshot surface', () => {
    it('idle is true only with an empty queue and nothing in flight', async () => {
      const q = createChunkUploadQueue({
        upload: vi.fn(async () => ({
          ok: true as const,
          segment: { id: 's1', recording_ordinal: 1, started_at_utc: chunk().startedAtUtc },
        })),
        listSegments: vi.fn(),
        clock: makeClock(),
      });
      expect(q.getSnapshot().idle).toBe(true);

      q.enqueue(chunk({ chunkIndex: 0 }));
      expect(q.getSnapshot().idle).toBe(false);

      await q.pump();
      expect(q.getSnapshot().idle).toBe(true);
    });

    it('pendingOrdinals reflects distinct recording ordinals across queued and permanent chunks (D8 feed)', async () => {
      const upload = vi.fn((c: ChunkInput): Promise<UploadOutcome> => {
        if (c.recordingOrdinal === 2) return Promise.reject(new FakeApiError(400, 'bad'));
        return Promise.resolve({
          ok: false,
          status: 500,
          message: 'still failing',
        });
      });
      const q = createChunkUploadQueue({ upload, listSegments: vi.fn(), clock: makeClock() });
      q.enqueue(chunk({ recordingOrdinal: 1, chunkIndex: 0 }));
      q.enqueue(chunk({ recordingOrdinal: 2, chunkIndex: 0 }));

      await q.pump();

      expect(q.getSnapshot().pendingOrdinals).toEqual([1, 2]);
    });

    it('subscribe delivers a snapshot on every state change and the returned disposer stops delivery', async () => {
      const q = createChunkUploadQueue({
        upload: vi.fn(async () => ({
          ok: true as const,
          segment: { id: 's1', recording_ordinal: 1, started_at_utc: chunk().startedAtUtc },
        })),
        listSegments: vi.fn(),
        clock: makeClock(),
      });
      const seen: boolean[] = [];
      const unsubscribe = q.subscribe((snap) => seen.push(snap.idle));

      q.enqueue(chunk({ chunkIndex: 0 }));
      await q.pump();
      expect(seen.length).toBeGreaterThan(0);

      unsubscribe();
      const countBefore = seen.length;
      q.enqueue(chunk({ chunkIndex: 1 }));
      expect(seen.length).toBe(countBefore);
    });
  });

  describe('pump prologue hardening (fix-wave F6/D3)', () => {
    it('a listener that throws during the prologue notify does not permanently wedge pump — a subsequent pump still runs', async () => {
      const upload = vi.fn(async (c: ChunkInput) => ({
        ok: true as const,
        segment: { id: `s${c.chunkIndex}`, recording_ordinal: 1, started_at_utc: c.startedAtUtc },
      }));
      const q = createChunkUploadQueue({ upload, listSegments: vi.fn(), clock: makeClock() });
      q.enqueue(chunk({ chunkIndex: 0 }));

      let notifyCalls = 0;
      const unsubscribe = q.subscribe(() => {
        notifyCalls += 1;
        if (notifyCalls === 1) {
          throw new Error('listener blew up on the prologue notify');
        }
      });

      // Before the fix, a throw during the prologue `notify()` (called
      // BEFORE the try block) would propagate out of `runPump()` without
      // ever reaching the `finally` that resets `inFlight = false` — every
      // later `pump()` call would then see `inFlight` permanently stuck
      // `true` and just return the stale `current` promise forever.
      await expect(q.pump()).rejects.toThrow('listener blew up on the prologue notify');

      unsubscribe();

      // A fresh pump() must actually run (not collapse onto a wedged
      // inFlight) and drain the still-queued chunk.
      await q.pump();
      expect(upload).toHaveBeenCalledTimes(1);
      expect(q.getSnapshot().chunks).toHaveLength(0);
      expect(q.getSnapshot().idle).toBe(true);
    });

    it('collapsed pump() never returns null/undefined even when called synchronously from a notify listener', async () => {
      const gate = deferred<UploadOutcome>();
      const upload = vi.fn(() => gate.promise);
      const q = createChunkUploadQueue({ upload, listSegments: vi.fn(), clock: makeClock() });
      q.enqueue(chunk({ chunkIndex: 0 }));

      let reentrantResult: Promise<void> | undefined;
      const unsubscribe = q.subscribe(() => {
        // Fired synchronously from within the prologue notify — at this
        // exact point `inFlight` is already `true` (set before the
        // try/notify) but the outer `pump()` call has not yet assigned
        // `current` (that assignment happens only after `runPump()`
        // returns its pending promise). The collapsed branch's `current ??
        // Promise.resolve()` fallback exists for precisely this window —
        // without it, `current as Promise<void>` would hand back `null`
        // here, and a caller `await`-ing that cast value would crash
        // rather than degrade to a resolved no-op.
        if (!reentrantResult) {
          reentrantResult = q.pump();
        }
      });

      const outer = q.pump();

      expect(reentrantResult).toBeDefined();
      expect(reentrantResult).toBeInstanceOf(Promise);
      await expect(reentrantResult).resolves.toBeUndefined();

      unsubscribe();
      gate.resolve({
        ok: true,
        segment: { id: 's0', recording_ordinal: 1, started_at_utc: chunk().startedAtUtc },
      });
      await outer;
      expect(q.getSnapshot().idle).toBe(true);
    });
  });

  describe('module-owned singleton (survives component unmount)', () => {
    beforeEach(() => {
      resetChunkUploadQueueForTesting();
    });

    it('getChunkUploadQueue returns the same instance across calls, ignoring later deps', () => {
      const depsA = { upload: vi.fn(), listSegments: vi.fn(), clock: makeClock() };
      const depsB = { upload: vi.fn(), listSegments: vi.fn(), clock: makeClock() };

      const first: ChunkUploadQueue = getChunkUploadQueue(depsA);
      first.enqueue(chunk({ chunkIndex: 0 }));

      const second = getChunkUploadQueue(depsB);

      expect(second).toBe(first);
      // State survives — a fresh "component mount" call sees the chunk that
      // was queued before it "unmounted".
      expect(second.getSnapshot().chunks).toHaveLength(1);
    });

    it('resetChunkUploadQueueForTesting forces a fresh instance on next call', () => {
      const deps = { upload: vi.fn(), listSegments: vi.fn(), clock: makeClock() };
      const first = getChunkUploadQueue(deps);
      first.enqueue(chunk({ chunkIndex: 0 }));

      resetChunkUploadQueueForTesting();
      const second = getChunkUploadQueue(deps);

      expect(second).not.toBe(first);
      expect(second.getSnapshot().chunks).toHaveLength(0);
    });

    // The creation seam exists so `chunkLeaveWarning.ts` can start observing
    // the singleton the instant a real caller builds it, without ever
    // constructing (and mis-depping) it itself.
    describe('onChunkUploadQueueCreated', () => {
      it('fires when the singleton is constructed, with the instance', () => {
        const seen: ChunkUploadQueue[] = [];
        const dispose = onChunkUploadQueueCreated((q) => seen.push(q));
        try {
          expect(seen).toHaveLength(0); // nothing constructed yet

          const queue = getChunkUploadQueue({
            upload: vi.fn(),
            listSegments: vi.fn(),
            clock: makeClock(),
          });

          expect(seen).toEqual([queue]);

          // A later get() returns the existing instance and must not re-fire.
          getChunkUploadQueue({ upload: vi.fn(), listSegments: vi.fn(), clock: makeClock() });
          expect(seen).toHaveLength(1);
        } finally {
          dispose();
        }
      });

      it('calls a late registrant immediately with the existing singleton', () => {
        const queue = getChunkUploadQueue({
          upload: vi.fn(),
          listSegments: vi.fn(),
          clock: makeClock(),
        });

        const seen: ChunkUploadQueue[] = [];
        const dispose = onChunkUploadQueueCreated((q) => seen.push(q));
        try {
          expect(seen).toEqual([queue]);
        } finally {
          dispose();
        }
      });

      it('re-fires after a reset + reconstruction, and stops after unsubscribe', () => {
        const seen: ChunkUploadQueue[] = [];
        const dispose = onChunkUploadQueueCreated((q) => seen.push(q));
        const deps = { upload: vi.fn(), listSegments: vi.fn(), clock: makeClock() };
        try {
          const first = getChunkUploadQueue(deps);
          resetChunkUploadQueueForTesting();
          const second = getChunkUploadQueue(deps);

          // The reset seam drops the instance, not the observers — so the
          // rebuilt singleton is announced to the same listener.
          expect(seen).toEqual([first, second]);
        } finally {
          dispose();
        }

        resetChunkUploadQueueForTesting();
        getChunkUploadQueue(deps);
        expect(seen).toHaveLength(2);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// media-worker A.3: timed retry, offline/online, blocked, parts fallback, Retry
// reaching every class, store-backed recovery, dedupe normalisation, finalize.
// ---------------------------------------------------------------------------

/**
 * Window normalisation pairs (hand-off from B.3, pinned here until its fixture lands): the
 * server keys a recording window by `parseOptionalMarkedAt(started_at_utc)`, i.e.
 * `new Date(Date.parse(raw.trim().replace('+00:00', 'Z'))).toISOString()`. The client's
 * dedupe must normalise the same way on both sides.
 */
const WINDOW_NORMALISATION_FIXTURE: Array<[client: string, server: string]> = [
  ['2026-10-12T10:00:00.000Z', '2026-10-12T10:00:00.000Z'],
  ['2026-10-12T10:00:00Z', '2026-10-12T10:00:00.000Z'],
  ['2026-10-12T10:00:00+00:00', '2026-10-12T10:00:00.000Z'],
  ['2026-10-12T10:00:00.5Z', '2026-10-12T10:00:00.500Z'],
  [' 2026-10-12T12:00:00.000+02:00 ', '2026-10-12T10:00:00.000Z'],
];

function fakeScheduler() {
  const ticks: Array<() => void> = [];
  let running = 0;
  return {
    make: (_period: number, onTick: () => void) => {
      running += 1;
      ticks.push(onTick);
      let stopped = false;
      return {
        stop: () => {
          if (stopped) return;
          stopped = true;
          running -= 1;
          const i = ticks.indexOf(onTick);
          if (i >= 0) ticks.splice(i, 1);
        },
      };
    },
    tick: () => {
      for (const t of ticks.slice()) t();
    },
    get running() {
      return running;
    },
  };
}

function fakeNetwork(initiallyOnline = true) {
  let online = initiallyOnline;
  const listeners = new Set<{ on: () => void; off: () => void }>();
  return {
    dep: {
      isOnline: () => online,
      subscribe: (on: () => void, off: () => void) => {
        const l = { on, off };
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    goOffline() {
      online = false;
      for (const l of listeners) l.off();
    },
    goOnline() {
      online = true;
      for (const l of listeners) l.on();
    },
  };
}

function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function okFor(c: ChunkInput, id = 'seg'): UploadOutcome {
  return {
    ok: true,
    segment: { id, recording_ordinal: c.recordingOrdinal, started_at_utc: c.startedAtUtc },
  };
}

describe('media-worker A.3: timed retry (design D11)', () => {
  it('a scheduler tick pumps a due transient chunk without a rollover', async () => {
    const t = { now: 1_000_000 };
    const sched = fakeScheduler();
    let n = 0;
    const upload = vi.fn(async (c: ChunkInput): Promise<UploadOutcome> => {
      n += 1;
      if (n === 1) throw new FakeApiError(503, 'unavailable');
      return okFor(c);
    });
    const q = createChunkUploadQueue({
      upload,
      listSegments: vi.fn(),
      clock: { now: () => t.now },
      scheduler: sched.make,
      random: () => 0.5,
    });
    q.enqueue(chunk());
    expect(sched.running).toBe(1); // the tick runs while the queue is non-empty
    await q.pump();
    expect(q.getSnapshot().chunks[0].nextAttemptAt).toBe(1_002_000); // 2 s backoff
    t.now += 1_000;
    sched.tick();
    await settle();
    expect(upload).toHaveBeenCalledTimes(1); // not due yet
    t.now += 1_000;
    sched.tick();
    await settle();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(q.getSnapshot().chunks).toHaveLength(0);
    expect(sched.running).toBe(0); // stopped once empty
  });

  it('the delay doubles per failure: 2 s, 4 s, 8 s', async () => {
    const t = { now: 0 };
    const upload = vi.fn(async (): Promise<UploadOutcome> => {
      throw new FakeApiError(500, 'boom');
    });
    const q = createChunkUploadQueue({
      upload,
      listSegments: vi.fn(),
      clock: { now: () => t.now },
      random: () => 0.5,
    });
    q.enqueue(chunk());
    const delays: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      await q.pump();
      delays.push((q.getSnapshot().chunks[0].nextAttemptAt ?? 0) - t.now);
    }
    expect(delays).toEqual([2_000, 4_000, 8_000]);
  });

  it('offline suspends attempts and counts none; online pumps at once and resets the delay', async () => {
    const t = { now: 0 };
    const net = fakeNetwork(true);
    const sched = fakeScheduler();
    let fail = true;
    const upload = vi.fn(async (c: ChunkInput): Promise<UploadOutcome> => {
      if (fail) throw new FakeApiError(502, 'bad gateway');
      return okFor(c);
    });
    const q = createChunkUploadQueue({
      upload,
      listSegments: vi.fn(),
      clock: { now: () => t.now },
      network: net.dep,
      scheduler: sched.make,
      random: () => 0.5,
    });
    q.enqueue(chunk({ chunkIndex: 0 }));
    await q.pump();
    await q.pump();
    expect(upload).toHaveBeenCalledTimes(2);

    net.goOffline();
    expect(q.getSnapshot().offline).toBe(true);
    q.enqueue(chunk({ chunkIndex: 1, startedAtUtc: '2026-08-12T00:10:00.000Z' }));
    t.now += 20 * 60_000;
    sched.tick();
    await q.pump(); // a rollover while offline
    await settle();
    expect(upload).toHaveBeenCalledTimes(2); // no attempt while offline
    expect(q.getSnapshot().chunks.map((c) => c.attempts)).toEqual([2, 0]);

    fail = false;
    net.goOnline();
    await settle();
    expect(upload).toHaveBeenCalledTimes(4); // both, in order, right away
    expect(upload.mock.calls.map(([c]) => c.chunkIndex)).toEqual([0, 0, 0, 1]);
    expect(q.getSnapshot().chunks).toHaveLength(0);
  });
});

describe('media-worker A.3: classification', () => {
  it('401/403 → blocked: not auto-retried, later chunks also blocked rather than discarded', async () => {
    const t = { now: 0 };
    const sched = fakeScheduler();
    const upload = vi.fn(async (): Promise<UploadOutcome> => {
      throw new FakeApiError(401, 'Not signed in');
    });
    const q = createChunkUploadQueue({
      upload,
      listSegments: vi.fn(),
      clock: { now: () => t.now },
      scheduler: sched.make,
    });
    q.enqueue(chunk({ chunkIndex: 0 }));
    q.enqueue(chunk({ chunkIndex: 1 }));
    await q.pump();
    expect(q.getSnapshot().chunks.map((c) => c.classification)).toEqual(['blocked', 'blocked']);
    expect(q.getSnapshot().chunks[0].lastError).toBe('Not signed in');
    t.now += 3_600_000;
    sched.tick();
    await settle();
    expect(upload).toHaveBeenCalledTimes(2); // the scheduler never retries blocked
  });

  it('413 re-sends the chunk through the parts upload in segment mode and confirms it', async () => {
    const upload = vi.fn(async (): Promise<UploadOutcome> => {
      throw new FakeApiError(413, 'Audio payload too large');
    });
    const uploadSegmentParts = vi.fn(
      async (c: ChunkInput & { blob: Blob }): Promise<UploadOutcome> => okFor(c, 'seg-parts'),
    );
    const q = createChunkUploadQueue({
      upload,
      uploadSegmentParts,
      listSegments: vi.fn(),
      clock: makeClock(),
    });
    q.enqueue(chunk({ chunkIndex: 0, recordingOrdinal: 4, blob: blob(70) }));
    await q.pump();
    expect(uploadSegmentParts).toHaveBeenCalledTimes(1);
    const sent = uploadSegmentParts.mock.calls[0][0];
    expect(sent).toMatchObject({
      sessionId: 'sess-1',
      recordingOrdinal: 4,
      startedAtUtc: chunk().startedAtUtc,
      endedAtUtc: chunk().endedAtUtc,
    });
    expect(sent.blob.size).toBe(70);
    expect(q.getSnapshot().chunks).toHaveLength(0); // confirmed, never parked
  });

  it('a transient failure of the parts upload retries through parts, not the plain POST', async () => {
    const upload = vi.fn(async (): Promise<UploadOutcome> => {
      throw new FakeApiError(413, 'too large');
    });
    let n = 0;
    const uploadSegmentParts = vi.fn(async (c: ChunkInput): Promise<UploadOutcome> => {
      n += 1;
      if (n === 1) throw new FakeApiError(503, 'busy');
      return okFor(c);
    });
    const q = createChunkUploadQueue({
      upload,
      uploadSegmentParts,
      listSegments: vi.fn(),
      clock: makeClock(),
    });
    q.enqueue(chunk());
    await q.pump();
    expect(q.getSnapshot().chunks[0].classification).toBe('queued');
    await q.pump();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(uploadSegmentParts).toHaveBeenCalledTimes(2);
    expect(q.getSnapshot().chunks).toHaveLength(0);
  });
});

describe('media-worker A.3: Retry reaches every class', () => {
  it('retryAll re-attempts blocked and permanent chunks once each, in order', async () => {
    const statuses: Record<number, number> = { 0: 401, 1: 404, 2: 403 };
    let phase: 'fail' | 'ok' = 'fail';
    const upload = vi.fn(async (c: ChunkInput): Promise<UploadOutcome> => {
      if (phase === 'fail') throw new FakeApiError(statuses[c.chunkIndex], 'nope');
      if (c.chunkIndex === 1) throw new FakeApiError(404, 'still gone');
      return okFor(c);
    });
    const q = createChunkUploadQueue({ upload, listSegments: vi.fn(), clock: makeClock() });
    for (const i of [0, 1, 2]) q.enqueue(chunk({ chunkIndex: i }));
    await q.pump();
    expect(q.getSnapshot().chunks.map((c) => c.classification)).toEqual([
      'blocked',
      'permanent',
      'blocked',
    ]);
    phase = 'ok';
    await q.pump(); // a plain pump never touches them
    expect(upload).toHaveBeenCalledTimes(3);
    await q.retryAll();
    expect(upload.mock.calls.slice(3).map(([c]) => c.chunkIndex)).toEqual([0, 1, 2]);
    const left = q.getSnapshot().chunks;
    expect(left.map((c) => [c.chunkIndex, c.classification])).toEqual([[1, 'permanent']]);
    await q.pump();
    expect(upload).toHaveBeenCalledTimes(6); // the 404 got its one attempt, no more
  });

  it('retryChunk attempts one permanent chunk once', async () => {
    const upload = vi.fn(async (): Promise<UploadOutcome> => {
      throw new FakeApiError(400, 'bad');
    });
    const q = createChunkUploadQueue({ upload, listSegments: vi.fn(), clock: makeClock() });
    q.enqueue(chunk());
    await q.pump();
    const key = q.getSnapshot().chunks[0].key;
    await q.retryChunk(key);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(q.getSnapshot().chunks[0].classification).toBe('permanent');
  });
});

describe('media-worker A.3: dedupe uses the server window normalisation', () => {
  it.each(WINDOW_NORMALISATION_FIXTURE)('client %j matches server %j', async (client, server) => {
    const upload = vi.fn(() => Promise.reject(new FakeNetworkError('lost response')));
    const listSegments = vi.fn(
      async (): Promise<ExistingSegment[]> => [{ recording_ordinal: 1, started_at_utc: server }],
    );
    const q = createChunkUploadQueue({ upload, listSegments, clock: makeClock() });
    q.enqueue(chunk({ startedAtUtc: client }));
    await q.pump();
    await q.pump();
    expect(q.getSnapshot().chunks).toHaveLength(0);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('a window held by a seam of a merged segment counts as stored', async () => {
    const upload = vi.fn(() => Promise.reject(new FakeNetworkError('lost response')));
    const listSegments = vi.fn(
      async (): Promise<ExistingSegment[]> => [
        {
          recording_ordinal: 1,
          started_at_utc: '2026-08-12T00:00:00.000Z',
          seams: [
            { started_at_utc: '2026-08-12T00:00:00.000Z' },
            { started_at_utc: '2026-08-12T00:10:00.000Z' },
          ],
        },
      ],
    );
    const q = createChunkUploadQueue({ upload, listSegments, clock: makeClock() });
    q.enqueue(chunk({ chunkIndex: 1, startedAtUtc: '2026-08-12T00:10:00+00:00' }));
    await q.pump();
    await q.pump();
    expect(q.getSnapshot().chunks).toHaveLength(0);
  });
});

describe('media-worker A.3: store-backed chunks and recovery (design D10)', () => {
  const USER = 'user-a';
  const START = Date.parse('2026-10-12T10:00:00.000Z');
  const iso = (ms: number) => new Date(ms).toISOString();

  function memStore(clock: { t: number }): ChunkStore {
    return createChunkStore({
      backends: [() => createMemoryBackend()],
      now: () => clock.t,
      warn: () => {},
    });
  }

  /** Write a chunk as the recorder would: open, append slices `at` ms after start, finalize. */
  async function record(
    s: ChunkStore,
    clock: { t: number },
    opts: {
      ordinal: number;
      index: number;
      startMs: number;
      slices: number[];
      finalizeAtMs?: number;
      windows?: string[];
      userId?: string;
    },
  ) {
    clock.t = opts.startMs;
    const h = await s.openChunk({
      userId: opts.userId ?? USER,
      sessionId: 'sess-1',
      recordingOrdinal: opts.ordinal,
      chunkIndex: opts.index,
      startedAtUtc: iso(opts.startMs),
      mimeType: 'audio/webm',
      pendingFinalize: opts.windows ?? null,
    });
    for (const [i, size] of opts.slices.entries()) {
      clock.t = opts.startMs + (i + 1) * 5_000;
      await s.append(h, new Blob([new Uint8Array(size).fill(i + 1)], { type: 'audio/webm' }));
    }
    if (opts.finalizeAtMs !== undefined) await s.finalize(h, iso(opts.finalizeAtMs));
    return h;
  }

  function recoverDeps(s: ChunkStore, reg: FakeLockRegistry, extra: Record<string, unknown> = {}) {
    const posted: ChunkInput[] = [];
    const order: string[] = [];
    const deps = {
      upload: vi.fn(async (c: ChunkInput): Promise<UploadOutcome> => {
        posted.push(c);
        order.push(`upload:${c.chunkIndex}`);
        return okFor(c);
      }),
      listSegments: vi.fn(async (): Promise<ExistingSegment[]> => {
        order.push('list');
        return [];
      }),
      finalize: vi.fn(async (sid: string, ord: number, windows: string[]) => {
        order.push(`finalize:${sid}:${ord}:${windows.length}`);
        return { ok: true as const, merge: 'queued' as const };
      }),
      clock: { now: () => Date.now() },
      store: s,
      locks: createRecorderLocks({ locks: reg.tab(), now: () => Date.now() }),
      probeDuration: vi.fn(async () => null as number | null),
      ...extra,
    };
    return { deps, posted, order };
  }

  it('recovers only the signed-in user’s unlocked chunks, in capture order, starting ambiguous', async () => {
    const clock = { t: START };
    const s = memStore(clock);
    const reg = new FakeLockRegistry();
    // ordinal 3: two complete chunks and a partial third; another user's chunk; ordinal 5 is live
    // in another tab (its take lock is held).
    const w = [iso(START), iso(START + 600_000), iso(START + 1_200_000)];
    await record(s, clock, {
      ordinal: 3,
      index: 1,
      startMs: START + 600_000,
      slices: [4],
      finalizeAtMs: START + 1_200_000,
      windows: w.slice(0, 2),
    });
    await record(s, clock, {
      ordinal: 3,
      index: 0,
      startMs: START,
      slices: [3],
      finalizeAtMs: START + 600_000,
      windows: w.slice(0, 1),
    });
    await record(s, clock, {
      ordinal: 3,
      index: 2,
      startMs: START + 1_200_000,
      slices: [2, 2],
      windows: w,
    });
    await record(s, clock, {
      ordinal: 3,
      index: 0,
      startMs: START,
      slices: [9],
      finalizeAtMs: START + 1,
      userId: 'user-b',
    });
    await record(s, clock, { ordinal: 5, index: 0, startMs: START + 2_000_000, slices: [1] });
    const otherTab = createRecorderLocks({ locks: reg.tab(), now: () => clock.t });
    const releaseLive = await otherTab.holdTake('sess-1', 5);
    expect(reg.isHeld(takeLockName('sess-1', 5))).toBe(true);

    const { deps, posted, order } = recoverDeps(s, reg);
    const q = createChunkUploadQueue(deps);
    const result = await q.recover(USER);
    await q.pump();

    expect(result.recovered).toBe(3);
    expect(posted.map((c) => [c.recordingOrdinal, c.chunkIndex])).toEqual([
      [3, 0],
      [3, 1],
      [3, 2],
    ]);
    // The segments-list check runs before the first recovered upload.
    expect(order[0]).toBe('list');
    // Bytes come from the store; the partial chunk is cut at its last whole slice.
    expect(posted[0].blob?.size).toBe(3);
    expect(posted[2].blob?.size).toBe(4);
    // Confirmed chunks are removed from storage; the live take's chunk stays.
    const left = await s.list(USER);
    expect(left.map((m) => [m.recordingOrdinal, m.kind])).toEqual([[5, 'chunk']]);
    releaseLive();
  });

  it('marks recovered chunks in the snapshot (recovered, partial) with their byte counts', async () => {
    const clock = { t: START };
    const s = memStore(clock);
    const reg = new FakeLockRegistry();
    await record(s, clock, { ordinal: 2, index: 0, startMs: START, slices: [3, 3] });
    const { deps } = recoverDeps(s, reg, {
      upload: vi.fn(async () => {
        throw new FakeApiError(500, 'down');
      }),
    });
    const q = createChunkUploadQueue(deps);
    await q.recover(USER);
    const [c] = q.getSnapshot().chunks;
    expect(c).toMatchObject({ recovered: true, partial: true, bytes: 6, recordingOrdinal: 2 });
  });

  it("a partial chunk's ended_at_utc is its start plus the probed duration of its bytes", async () => {
    const clock = { t: START };
    const s = memStore(clock);
    const reg = new FakeLockRegistry();
    await record(s, clock, { ordinal: 1, index: 0, startMs: START, slices: [5, 5] });
    clock.t = START + 9 * 60_000; // the manifest says nine minutes…
    const { deps, posted } = recoverDeps(s, reg, { probeDuration: vi.fn(async () => 290) });
    const q = createChunkUploadQueue(deps);
    await q.recover(USER);
    await q.pump();
    // …the bytes say 4 min 50 s.
    expect(posted[0].endedAtUtc).toBe(iso(START + 290_000));
  });

  it('without a finite probe, the slice log rate gives the duration (Chromium WebM)', async () => {
    const clock = { t: START };
    const s = memStore(clock);
    const reg = new FakeLockRegistry();
    // Three 5 s slices: the log spans 15 s.
    await record(s, clock, { ordinal: 1, index: 0, startMs: START, slices: [10, 10, 10] });
    const { deps, posted } = recoverDeps(s, reg, {
      probeDuration: vi.fn(async () => Number.POSITIVE_INFINITY),
    });
    const q = createChunkUploadQueue(deps);
    await q.recover(USER);
    await q.pump();
    expect(posted[0].endedAtUtc).toBe(iso(START + 15_000));
  });

  it('a recovered chunk the server already holds is confirmed by the dedupe and removed, not re-sent', async () => {
    const clock = { t: START };
    const s = memStore(clock);
    const reg = new FakeLockRegistry();
    await record(s, clock, {
      ordinal: 2,
      index: 0,
      startMs: START,
      slices: [3],
      finalizeAtMs: START + 60_000,
    });
    const { deps, posted } = recoverDeps(s, reg, {
      listSegments: vi.fn(async () => [{ recording_ordinal: 2, started_at_utc: iso(START) }]),
    });
    const q = createChunkUploadQueue(deps);
    await q.recover(USER);
    await q.pump();
    expect(posted).toEqual([]);
    expect(await s.list(USER)).toEqual([]);
  });

  it("the server's existing-segment answer to a re-post counts as confirmed", async () => {
    const clock = { t: START };
    const s = memStore(clock);
    const reg = new FakeLockRegistry();
    await record(s, clock, {
      ordinal: 2,
      index: 0,
      startMs: START,
      slices: [3],
      finalizeAtMs: START + 60_000,
    });
    const { deps } = recoverDeps(s, reg, {
      // D18: the POST answers 200 with the merged segment that absorbed this window.
      upload: vi.fn(async () => ({
        ok: true as const,
        segment: { id: 'merged-7', recording_ordinal: 2, started_at_utc: iso(START - 600_000) },
      })),
    });
    const q = createChunkUploadQueue(deps);
    await q.recover(USER);
    await q.pump();
    expect(q.getSnapshot().chunks).toEqual([]);
    expect(await s.list(USER)).toEqual([]);
  });

  it('a confirmed chunk leaves storage before the next chunk is attempted', async () => {
    const clock = { t: START };
    const s = memStore(clock);
    const reg = new FakeLockRegistry();
    const h0 = await record(s, clock, {
      ordinal: 2,
      index: 0,
      startMs: START,
      slices: [1],
      finalizeAtMs: START + 1,
    });
    await record(s, clock, {
      ordinal: 2,
      index: 1,
      startMs: START + 1,
      slices: [1],
      finalizeAtMs: START + 2,
    });
    const seen: string[][] = [];
    const { deps } = recoverDeps(s, reg, {
      upload: vi.fn(async (c: ChunkInput) => {
        seen.push((await s.list(USER)).map((m) => m.id));
        return okFor(c);
      }),
    });
    const q = createChunkUploadQueue(deps);
    await q.recover(USER);
    await q.pump();
    expect(seen[1]).not.toContain(h0.id);
  });

  it('discarding a stored chunk removes it from storage too', async () => {
    const clock = { t: START };
    const s = memStore(clock);
    const reg = new FakeLockRegistry();
    await record(s, clock, {
      ordinal: 2,
      index: 0,
      startMs: START,
      slices: [1],
      finalizeAtMs: START + 1,
    });
    const { deps } = recoverDeps(s, reg, {
      upload: vi.fn(async () => {
        throw new FakeApiError(404, 'gone');
      }),
    });
    const q = createChunkUploadQueue(deps);
    await q.recover(USER);
    await q.pump();
    await q.discardChunk(q.getSnapshot().chunks[0].key);
    expect(await s.list(USER)).toEqual([]);
  });

  it('recovery runs once per user per page load', async () => {
    const clock = { t: START };
    const s = memStore(clock);
    const reg = new FakeLockRegistry();
    await record(s, clock, {
      ordinal: 2,
      index: 0,
      startMs: START,
      slices: [1],
      finalizeAtMs: START + 1,
    });
    const { deps } = recoverDeps(s, reg, {
      upload: vi.fn(async () => {
        throw new FakeApiError(500, 'down');
      }),
    });
    const q = createChunkUploadQueue(deps);
    const a = q.recover(USER);
    const b = q.recover(USER);
    expect(a).toBe(b);
    await a;
    await q.recover(USER);
    expect(q.getSnapshot().chunks).toHaveLength(1);
  });

  it('readChunk returns the stored bytes (Download)', async () => {
    const clock = { t: START };
    const s = memStore(clock);
    const reg = new FakeLockRegistry();
    await record(s, clock, {
      ordinal: 2,
      index: 0,
      startMs: START,
      slices: [2, 3],
      finalizeAtMs: START + 1,
    });
    const { deps } = recoverDeps(s, reg, {
      upload: vi.fn(async () => {
        throw new FakeApiError(500, 'down');
      }),
    });
    const q = createChunkUploadQueue(deps);
    await q.recover(USER);
    const b = await q.readChunk(q.getSnapshot().chunks[0].key);
    expect(b.size).toBe(5);
  });
});

describe('media-worker A.3: finalize (design D6/D11)', () => {
  const okFinalize = () => vi.fn(async () => ({ ok: true as const, merge: 'queued' as const }));

  it('finalize follows the last confirmation of the ordinal, once, with the windows', async () => {
    const order: string[] = [];
    const finalize = vi.fn(async (sid: string, ord: number, windows: string[]) => {
      order.push(`finalize:${sid}:${ord}:${windows.join(',')}`);
      return { ok: true as const, merge: 'queued' as const };
    });
    const q = createChunkUploadQueue({
      upload: vi.fn(async (c: ChunkInput) => {
        order.push(`upload:${c.chunkIndex}`);
        return okFor(c);
      }),
      listSegments: vi.fn(),
      finalize,
      clock: makeClock(),
    });
    q.enqueue(chunk({ chunkIndex: 0, startedAtUtc: 'w0' }));
    q.enqueue(chunk({ chunkIndex: 1, startedAtUtc: 'w1' }));
    q.enqueue(chunk({ chunkIndex: 2, startedAtUtc: 'w2' }));
    await q.requestFinalize({
      sessionId: 'sess-1',
      recordingOrdinal: 1,
      windows: ['w0', 'w1', 'w2'],
    });
    await q.pump();
    await q.pump();
    expect(order).toEqual(['upload:0', 'upload:1', 'upload:2', 'finalize:sess-1:1:w0,w1,w2']);
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("'waiting' counts as done; the finalize is not resent", async () => {
    const finalize = vi.fn(async () => ({ ok: true as const, merge: 'waiting' as const }));
    const q = createChunkUploadQueue({
      upload: vi.fn(async (c: ChunkInput) => okFor(c)),
      listSegments: vi.fn(),
      finalize,
      clock: makeClock(),
    });
    q.enqueue(chunk());
    await q.requestFinalize({ sessionId: 'sess-1', recordingOrdinal: 1, windows: ['w'] });
    await q.pump();
    await q.pump();
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(q.getSnapshot().pendingFinalizes).toEqual([]);
  });

  it('is not sent while a chunk of that ordinal is still queued, blocked or permanent', async () => {
    const finalize = okFinalize();
    const q = createChunkUploadQueue({
      upload: vi.fn(async () => {
        throw new FakeApiError(401, 'signed out');
      }),
      listSegments: vi.fn(),
      finalize,
      clock: makeClock(),
    });
    q.enqueue(chunk());
    await q.requestFinalize({ sessionId: 'sess-1', recordingOrdinal: 1, windows: ['w'] });
    await q.pump();
    expect(finalize).not.toHaveBeenCalled();
    expect(q.getSnapshot().pendingFinalizes).toEqual([
      { sessionId: 'sess-1', recordingOrdinal: 1 },
    ]);
  });

  it('a failed finalize is retried on the backoff by the scheduler until it succeeds', async () => {
    const t = { now: 0 };
    const sched = fakeScheduler();
    let n = 0;
    const finalize = vi.fn(async () => {
      n += 1;
      if (n < 3) throw new FakeNetworkError('offline-ish');
      return { ok: true as const, merge: 'already-queued' as const };
    });
    const q = createChunkUploadQueue({
      upload: vi.fn(),
      listSegments: vi.fn(),
      finalize,
      clock: { now: () => t.now },
      scheduler: sched.make,
      random: () => 0.5,
    });
    await q.requestFinalize({ sessionId: 'sess-1', recordingOrdinal: 7, windows: ['w'] });
    await settle();
    expect(finalize).toHaveBeenCalledTimes(1);
    t.now += 2_000;
    sched.tick();
    await settle();
    expect(finalize).toHaveBeenCalledTimes(2);
    t.now += 3_999;
    sched.tick();
    await settle();
    expect(finalize).toHaveBeenCalledTimes(2);
    t.now += 1;
    sched.tick();
    await settle();
    expect(finalize).toHaveBeenCalledTimes(3);
    expect(q.getSnapshot().pendingFinalizes).toEqual([]);
    expect(sched.running).toBe(0);
  });

  it('discarding a chunk drops its window; discarding the last one drops the finalize', async () => {
    const finalize = okFinalize();
    const q = createChunkUploadQueue({
      upload: vi.fn(async () => {
        throw new FakeApiError(404, 'gone');
      }),
      listSegments: vi.fn(),
      finalize,
      clock: makeClock(),
    });
    q.enqueue(chunk({ chunkIndex: 0, startedAtUtc: 'w0' }));
    await q.requestFinalize({ sessionId: 'sess-1', recordingOrdinal: 1, windows: ['w0'] });
    await q.pump();
    q.discard(1, 0);
    await settle();
    expect(finalize).not.toHaveBeenCalled();
    expect(q.getSnapshot().pendingFinalizes).toEqual([]);
  });

  it('a recovered recording is finalized after its last recovered chunk, with all its windows', async () => {
    const START = Date.parse('2026-10-12T10:00:00.000Z');
    const iso = (ms: number) => new Date(ms).toISOString();
    const clock = { t: START };
    const s = createChunkStore({ backends: [() => createMemoryBackend()], now: () => clock.t });
    const reg = new FakeLockRegistry();
    // Chunk 0 was uploaded before the crash (gone from storage); chunk 1 is a partial in storage
    // whose manifest carries both windows.
    const h = await s.openChunk({
      userId: 'u',
      sessionId: 'sess-1',
      recordingOrdinal: 4,
      chunkIndex: 1,
      startedAtUtc: iso(START + 600_000),
      mimeType: 'audio/webm',
      pendingFinalize: [iso(START), iso(START + 600_000)],
    });
    clock.t = START + 605_000;
    await s.append(h, new Blob([new Uint8Array(4)]));
    const finalize = vi.fn(async () => ({ ok: true as const, merge: 'queued' as const }));
    const q = createChunkUploadQueue({
      upload: vi.fn(async (c: ChunkInput) => okFor(c)),
      listSegments: vi.fn(async () => []),
      finalize,
      clock: { now: () => clock.t },
      store: s,
      locks: createRecorderLocks({ locks: reg.tab(), now: () => clock.t }),
      probeDuration: async () => 5,
    });
    await q.recover('u');
    await q.pump();
    await settle();
    expect(finalize).toHaveBeenCalledWith('sess-1', 4, [iso(START), iso(START + 600_000)]);
    expect(await s.list('u')).toEqual([]);
  });

  it('a persisted finalize record survives the page and is sent by the next load', async () => {
    const clock = { t: 0 };
    const s = createChunkStore({ backends: [() => createMemoryBackend()], now: () => clock.t });
    const reg = new FakeLockRegistry();
    const first = createChunkUploadQueue({
      upload: vi.fn(),
      listSegments: vi.fn(),
      finalize: vi.fn(async () => {
        throw new FakeApiError(503, 'down');
      }),
      clock: { now: () => clock.t },
      store: s,
      locks: createRecorderLocks({ locks: reg.tab(), now: () => clock.t }),
    });
    await first.requestFinalize({
      userId: 'u',
      sessionId: 'sess-1',
      recordingOrdinal: 2,
      windows: ['a', 'b'],
    });
    await settle();
    expect((await s.list('u')).map((m) => m.kind)).toEqual(['finalize']);

    const finalize = okFinalize();
    const second = createChunkUploadQueue({
      upload: vi.fn(),
      listSegments: vi.fn(),
      finalize,
      clock: { now: () => clock.t },
      store: s,
      locks: createRecorderLocks({ locks: reg.tab(), now: () => clock.t }),
    });
    await second.recover('u');
    await settle();
    expect(finalize).toHaveBeenCalledWith('sess-1', 2, ['a', 'b']);
    expect(await s.list('u')).toEqual([]);
  });
});

describe('media-worker A.3: the provider builds real deps', () => {
  beforeEach(() => resetChunkUploadQueueForTesting());

  it('getChunkUploadQueue() needs no deps (no fallback that throws)', () => {
    const q = getChunkUploadQueue();
    expect(q).toBe(getChunkUploadQueue());
    expect(q.getSnapshot().idle).toBe(true);
  });
});

describe('implementation panel fixes (A.8)', () => {
  const USER = 'user-a';
  const START = Date.parse('2026-10-12T10:00:00.000Z');
  const iso = (ms: number) => new Date(ms).toISOString();

  async function storedChunk(s: ChunkStore, userId = USER, index = 0) {
    const h = await s.openChunk({
      userId,
      sessionId: 'sess-1',
      recordingOrdinal: 2,
      chunkIndex: index,
      startedAtUtc: iso(START + index * 600_000),
      mimeType: 'audio/webm',
    });
    await s.append(h, new Blob([new Uint8Array(3)]));
    await s.finalize(h, iso(START + (index + 1) * 600_000));
    return h;
  }

  it('the queue holds a chunk lock for as long as it owns the chunk, so another tab never recovers it', async () => {
    const s = createChunkStore({ backends: [() => createMemoryBackend()] });
    const reg = new FakeLockRegistry();
    const h = await storedChunk(s);
    let fail = true;
    const q = createChunkUploadQueue({
      upload: vi.fn(async (c: ChunkInput) => {
        if (fail) throw new FakeApiError(503, 'down');
        return okFor(c);
      }),
      listSegments: vi.fn(async () => []),
      clock: { now: () => 0 },
      store: s,
      locks: createRecorderLocks({ locks: reg.tab(), now: () => 0 }),
    });
    q.enqueue({
      sessionId: 'sess-1',
      recordingOrdinal: 2,
      chunkIndex: 0,
      startedAtUtc: iso(START),
      endedAtUtc: iso(START + 600_000),
      mimeType: 'audio/webm',
      storeId: h.id,
      userId: USER,
      bytes: 3,
    });
    await q.whenOwned();
    await q.pump(); // fails: waiting in backoff
    expect(reg.isHeld(chunkLockName(h.id))).toBe(true);
    const tabB = createChunkUploadQueue({
      upload: vi.fn(),
      listSegments: vi.fn(async () => []),
      clock: { now: () => 0 },
      store: s,
      locks: createRecorderLocks({ locks: reg.tab(), now: () => 0 }),
    });
    expect((await tabB.recover(USER)).recovered).toBe(0);
    fail = false;
    await q.pump();
    expect(q.getSnapshot().chunks).toEqual([]);
    expect(reg.isHeld(chunkLockName(h.id))).toBe(false);
  });

  it('a recovered chunk is held by the recovering tab until it is confirmed', async () => {
    const s = createChunkStore({ backends: [() => createMemoryBackend()] });
    const reg = new FakeLockRegistry();
    const h = await storedChunk(s);
    const q = createChunkUploadQueue({
      upload: vi.fn(async () => {
        throw new FakeApiError(503, 'down');
      }),
      listSegments: vi.fn(async () => []),
      clock: { now: () => 0 },
      store: s,
      locks: createRecorderLocks({ locks: reg.tab(), now: () => 0 }),
    });
    await q.recover(USER);
    expect(reg.isHeld(chunkLockName(h.id))).toBe(true);
  });

  it('bytes that vanished because another tab uploaded them are confirmed by the server, not parked', async () => {
    const s = createChunkStore({ backends: [() => createMemoryBackend()] });
    const h = await storedChunk(s);
    const q = createChunkUploadQueue({
      upload: vi.fn(),
      listSegments: vi.fn(async () => [{ recording_ordinal: 2, started_at_utc: iso(START) }]),
      clock: { now: () => 0 },
      store: s,
    });
    q.enqueue({
      sessionId: 'sess-1',
      recordingOrdinal: 2,
      chunkIndex: 0,
      startedAtUtc: iso(START),
      endedAtUtc: iso(START + 600_000),
      mimeType: 'audio/webm',
      storeId: h.id,
      userId: USER,
      bytes: 3,
    });
    await s.remove(USER, h.id); // the other tab confirmed and removed it
    await q.pump();
    expect(q.getSnapshot().chunks).toEqual([]);
  });

  it('a 401 on the dedupe lookup marks the chunk blocked (signed out), not an endless lookup retry', async () => {
    const t = { now: 0 };
    const sched = fakeScheduler();
    const listSegments = vi.fn(async () => {
      throw new FakeApiError(401, 'Not authenticated.');
    });
    const q = createChunkUploadQueue({
      upload: vi.fn(() => Promise.reject(new FakeNetworkError('lost'))),
      listSegments,
      clock: { now: () => t.now },
      scheduler: sched.make,
    });
    q.enqueue(chunk());
    await q.pump(); // ambiguous
    await q.pump(); // lookup answers 401
    expect(q.getSnapshot().chunks[0].classification).toBe('blocked');
    t.now += 3_600_000;
    sched.tick();
    await settle();
    expect(listSegments).toHaveBeenCalledTimes(1);
  });

  it("never uploads another user's chunk", async () => {
    const upload = vi.fn(async (c: ChunkInput) => okFor(c));
    const q = createChunkUploadQueue({ upload, listSegments: vi.fn(), clock: makeClock() });
    q.setCurrentUser('user-b');
    q.enqueue({ ...chunk({ chunkIndex: 0 }), userId: 'user-a' });
    q.enqueue({ ...chunk({ chunkIndex: 1 }), userId: 'user-b' });
    await q.pump();
    expect(upload.mock.calls.map(([c]) => c.userId)).toEqual(['user-b']);
    expect(q.getSnapshot().chunks.map((c) => c.userId)).toEqual(['user-a']);
    q.discardUser('user-a');
    expect(q.getSnapshot().chunks).toEqual([]);
  });

  describe('uploadChunkViaParts (413 fallback)', () => {
    const live = (over: Partial<ChunkInput> = {}) =>
      ({ ...chunk(over), blob: blob(5), storeId: 'store-1' }) as ChunkInput & { blob: Blob };

    it('reuses one remembered upload per chunk (resume key), in segment mode', async () => {
      const uploader = vi.fn(async () => ({ segmentId: 'seg-9' }));
      const out = await uploadChunkViaParts(live(), uploader);
      expect(out).toMatchObject({ ok: true, segment: { id: 'seg-9' } });
      const opts = (uploader.mock.calls[0] as unknown as [Record<string, unknown>])[0];
      expect(opts.resumeKey).toBe('live-chunk:store-1');
      expect(opts.completion).toMatchObject({ mode: 'segment', recordingOrdinal: 1 });
    });

    it.each([
      [new PartsUploadError('failed', 'gone', null, false), 400],
      [new PartsUploadError('failed', 'network', null, true), 503],
      [new PartsUploadError('capacity', 'too many', 429, true), 429],
      [new PartsUploadError('disk', 'low disk', 507, true), 507],
      [new PartsUploadError('rejected', 'nope', 404, false), 404],
    ])('maps %s to a status-bearing failure (%i)', async (err, status) => {
      const uploader = vi.fn(async () => {
        throw err;
      });
      await expect(uploadChunkViaParts(live(), uploader)).rejects.toMatchObject({ status });
    });
  });
});

describe('A.9: dev diagnostics on a failed attempt', () => {
  it('reports the failure class and HTTP status (never bytes)', async () => {
    const debug = vi.fn();
    let n = 0;
    const q = createChunkUploadQueue({
      upload: vi.fn(async (c: ChunkInput) => {
        n += 1;
        if (n === 1) throw new FakeApiError(503, 'busy');
        if (n === 2) throw new FakeNetworkError('Failed to fetch');
        if (n === 3) throw new FakeApiError(401, 'signed out');
        return okFor(c);
      }),
      listSegments: vi.fn(async () => []),
      clock: makeClock(),
      debug,
    });
    q.enqueue(chunk());
    await q.pump();
    await q.pump();
    await q.pump();
    const lines = debug.mock.calls.map(([m]) => String(m));
    expect(lines[0]).toMatch(/transient.*503/);
    expect(lines[1]).toMatch(/network/);
    expect(lines[2]).toMatch(/blocked.*401/);
    for (const l of lines) expect(l).not.toMatch(/Blob|\[object/);
  });
});

describe('A.10: the queue never contends with its own pending chunk-lock hold', () => {
  const START = Date.parse('2026-10-12T10:00:00.000Z');
  async function stored(s: ChunkStore) {
    const h = await s.openChunk({
      userId: 'u',
      sessionId: 'sess-1',
      recordingOrdinal: 1,
      chunkIndex: 0,
      startedAtUtc: new Date(START).toISOString(),
      mimeType: 'audio/webm',
    });
    await s.append(h, new Blob([new Uint8Array(3)]));
    await s.finalize(h, new Date(START + 1).toISOString());
    return h;
  }
  const input = (id: string): ChunkInput => ({
    sessionId: 'sess-1',
    recordingOrdinal: 1,
    chunkIndex: 0,
    startedAtUtc: new Date(START).toISOString(),
    endedAtUtc: new Date(START + 1).toISOString(),
    mimeType: 'audio/webm',
    storeId: id,
    userId: 'u',
    bytes: 3,
  });

  it('enqueue + immediate pump (the rollover) uploads on the first pump with no error shown', async () => {
    const s = createChunkStore({ backends: [() => createMemoryBackend()] });
    const reg = new FakeLockRegistry();
    const h = await stored(s);
    const upload = vi.fn(async (c: ChunkInput) => okFor(c));
    const debug = vi.fn();
    const q = createChunkUploadQueue({
      upload,
      listSegments: vi.fn(async () => []),
      clock: { now: () => 0 },
      store: s,
      locks: createRecorderLocks({ locks: reg.tab(), now: () => 0 }),
      debug,
    });
    const errors: Array<string | null> = [];
    q.subscribe((snap) => {
      for (const c of snap.chunks) errors.push(c.lastError);
    });
    q.enqueue(input(h.id));
    await q.pump(); // no whenOwned(): the hold is still pending here
    expect(upload).toHaveBeenCalledTimes(1);
    expect(errors.every((e) => e === null)).toBe(true);
    expect(q.getSnapshot().chunks).toEqual([]);
    expect(debug).not.toHaveBeenCalled();
    expect(reg.heldNames()).toEqual([]);
  });

  it('a lock genuinely held by another tab takes the ambiguous path, is logged, and is not shown as failed', async () => {
    const s = createChunkStore({ backends: [() => createMemoryBackend()] });
    const reg = new FakeLockRegistry();
    const h = await stored(s);
    const otherTab = createRecorderLocks({ locks: reg.tab(), now: () => 0 });
    const release = await otherTab.holdChunk(h.id);
    const upload = vi.fn(async (c: ChunkInput) => okFor(c));
    const debug = vi.fn();
    const q = createChunkUploadQueue({
      upload,
      listSegments: vi.fn(async () => []),
      clock: { now: () => 0 },
      store: s,
      locks: createRecorderLocks({ locks: reg.tab(), now: () => 0 }),
      debug,
    });
    q.enqueue(input(h.id));
    await q.pump();
    expect(upload).not.toHaveBeenCalled();
    expect(debug.mock.calls.map(([m]) => String(m)).join('\n')).toMatch(/lock contention/);
    const [c] = q.getSnapshot().chunks;
    expect(c.lastError).toBeNull(); // contention is not a failure (A.10)
    expect(c.nextAttemptAt).not.toBeNull();
    release?.();
  });
});
