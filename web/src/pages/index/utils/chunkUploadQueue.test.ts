import { beforeEach, describe, expect, it, vi } from 'vitest';
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
} from './chunkUploadQueue';

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

    it('408 and 429 classify transient; other 4xx (400, 401, 403, 404) classify permanent', async () => {
      const statuses = [408, 429, 400, 401, 403, 404];
      for (const status of statuses) {
        const upload = vi.fn(() => Promise.reject(new FakeApiError(status, `status ${status}`)));
        const q = createChunkUploadQueue({ upload, listSegments: vi.fn(), clock: makeClock() });
        q.enqueue(chunk({ chunkIndex: 0 }));
        await q.pump();
        const c = q.getSnapshot().chunks[0];
        const expected = status === 408 || status === 429 ? 'queued' : 'permanent';
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
