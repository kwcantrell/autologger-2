import { describe, expect, it, vi } from 'vitest';
import { guardSignOut } from './chunkLeaveWarning';
import { createChunkStore } from './chunkStore';
import { createMemoryBackend } from './chunkStore/memoryBackend';
import { createChunkUploadQueue } from './chunkUploadQueue';

// --- media-worker A.6: sign-out warns about unsent chunks, then wipes the user's storage ---

async function storeWithChunk(userId: string) {
  const store = createChunkStore({ backends: [() => createMemoryBackend()] });
  const h = await store.openChunk({
    userId,
    sessionId: 'sess-1',
    recordingOrdinal: 2,
    chunkIndex: 0,
    startedAtUtc: '2026-10-12T10:00:00.000Z',
    mimeType: 'audio/webm',
  });
  await store.append(h, new Blob([new Uint8Array(4)]));
  await store.finalize(h, '2026-10-12T10:05:00.000Z');
  return store;
}

describe('guardSignOut', () => {
  it('unsent chunks → a confirmation naming them; confirmed → that user’s storage is wiped', async () => {
    const store = await storeWithChunk('user-a');
    const other = await store.openChunk({
      userId: 'user-b',
      sessionId: 's',
      recordingOrdinal: 1,
      chunkIndex: 0,
      startedAtUtc: '2026-10-12T09:00:00.000Z',
      mimeType: 'audio/webm',
    });
    await store.append(other, new Blob([new Uint8Array(1)]));
    const confirm = vi.fn(async () => true);
    const ok = await guardSignOut({ userId: 'user-a', confirm, store, queue: null });
    expect(ok).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    const opts = (confirm.mock.calls[0] as unknown as [{ message: string }])[0];
    expect(opts.message).toMatch(/1 recorded audio chunk/);
    expect(opts.message).toMatch(/5m/);
    expect(await store.list('user-a')).toEqual([]);
    expect(await store.list('user-b')).toHaveLength(1); // never another user's
  });

  it('cancelled → sign-out is aborted and nothing is wiped', async () => {
    const store = await storeWithChunk('user-a');
    const ok = await guardSignOut({
      userId: 'user-a',
      confirm: async () => false,
      store,
      queue: null,
    });
    expect(ok).toBe(false);
    expect(await store.list('user-a')).toHaveLength(1);
  });

  it('nothing unsent → no confirmation, sign-out proceeds', async () => {
    const store = createChunkStore({ backends: [() => createMemoryBackend()] });
    const confirm = vi.fn(async () => true);
    expect(await guardSignOut({ userId: 'user-a', confirm, store, queue: null })).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('counts in-memory chunks held by the queue too, and discards them on confirm', async () => {
    const store = createChunkStore({ backends: [() => createMemoryBackend()] });
    const queue = createChunkUploadQueue({
      upload: async () => ({ ok: false, status: 503, message: 'down' }),
      listSegments: async () => [],
      clock: { now: () => 0 },
    });
    queue.enqueue({
      sessionId: 's',
      recordingOrdinal: 1,
      chunkIndex: 0,
      startedAtUtc: '2026-10-12T10:00:00.000Z',
      endedAtUtc: '2026-10-12T10:01:00.000Z',
      mimeType: 'audio/webm',
      blob: new Blob([new Uint8Array(3)]),
      userId: 'user-a',
    });
    const confirm = vi.fn(async () => true);
    expect(await guardSignOut({ userId: 'user-a', confirm, store, queue })).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().chunks).toEqual([]);
  });

  it('no signed-in user → proceeds silently', async () => {
    const confirm = vi.fn(async () => true);
    expect(await guardSignOut({ userId: null, confirm, queue: null })).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("counts and discards only the signing-out user's queued chunks", async () => {
    const store = createChunkStore({ backends: [() => createMemoryBackend()] });
    const queue = createChunkUploadQueue({
      upload: async () => ({ ok: false, status: 503, message: 'down' }),
      listSegments: async () => [],
      clock: { now: () => 0 },
    });
    const base = {
      sessionId: 's',
      recordingOrdinal: 1,
      startedAtUtc: '2026-10-12T10:00:00.000Z',
      endedAtUtc: '2026-10-12T10:01:00.000Z',
      mimeType: 'audio/webm',
      blob: new Blob([new Uint8Array(3)]),
    };
    queue.enqueue({ ...base, chunkIndex: 0, userId: 'user-b' });
    const confirm = vi.fn(async () => true);
    expect(await guardSignOut({ userId: 'user-a', confirm, store, queue })).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(queue.getSnapshot().chunks).toHaveLength(1); // user-b's stays
  });
});
