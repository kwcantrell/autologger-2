// shared-blob-volume (core-ports-architecture "Audio blobs are shared by every server process"): two
// server processes on one database and one BLOB_DIR, each with its own DATA_DIR, as a stack's
// processes run. Audio uploaded through one is served, with the same Range semantics and bytes,
// and found by sync-from-disk, through the other.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultUser } from '../harness';
import { seededSession } from '../helpers';
import { type BusProcess, busProcess, closeBusProcesses } from './busProcesses';

const BYTES = new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

let shared: string | null = null;
afterEach(async () => {
  await closeBusProcesses();
  if (shared) rmSync(shared, { recursive: true, force: true });
  shared = null;
});

async function twoProcessesOneBlobDir(): Promise<[BusProcess, BusProcess]> {
  shared = mkdtempSync(join(tmpdir(), 'autologger-shared-blobs-'));
  return [await busProcess({ blobDir: shared }), await busProcess({ blobDir: shared })];
}

async function on(
  p: BusProcess,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: Uint8Array } = {},
): Promise<Response> {
  const { cookie } = await defaultUser();
  return fetch(`http://127.0.0.1:${p.port}${path}`, {
    method: init.method ?? 'GET',
    headers: { cookie, ...init.headers },
    body: init.body,
  });
}

const HEADERS = ['content-type', 'accept-ranges', 'content-length', 'content-range'];
const headersOf = (res: Response) =>
  Object.fromEntries(HEADERS.map((h) => [h, res.headers.get(h)]));

describe('two server processes share BLOB_DIR (shared-blob-volume)', () => {
  it('a segment uploaded through A plays through B, with the same Range answer and bytes', async () => {
    const [a, b] = await twoProcessesOneBlobDir();
    const { sessionId } = await seededSession();
    const up = await on(a, `/api/sessions/${sessionId}/audio/segments`, {
      method: 'POST',
      headers: { 'content-type': 'audio/webm' },
      body: BYTES,
    });
    expect(up.status).toBe(200);
    const seg = (await up.json()) as { id: string };
    const path = `/api/sessions/${sessionId}/audio/segments/${seg.id}`;

    const rangedB = await on(b, path, { headers: { range: 'bytes=2-5' } });
    expect(rangedB.status).toBe(206);
    expect(headersOf(rangedB)).toEqual({
      'content-type': 'audio/webm',
      'accept-ranges': 'bytes',
      'content-length': '4',
      'content-range': 'bytes 2-5/10',
    });
    expect(new Uint8Array(await rangedB.arrayBuffer())).toEqual(BYTES.slice(2, 6));
    const rangedA = await on(a, path, { headers: { range: 'bytes=2-5' } });
    expect(rangedA.status).toBe(206);
    expect(headersOf(rangedA)).toEqual(headersOf(rangedB));
    await rangedA.arrayBuffer();

    const fullB = await on(b, path);
    expect(fullB.status).toBe(200);
    expect(fullB.headers.get('content-length')).toBe('10');
    expect(new Uint8Array(await fullB.arrayBuffer())).toEqual(BYTES);
  });

  it('sync-from-disk on B finds A’s segment without duplicating its row, and adds a row-less blob', async () => {
    const [a, b] = await twoProcessesOneBlobDir();
    const { sessionId } = await seededSession();
    const up = await on(a, `/api/sessions/${sessionId}/audio/segments`, {
      method: 'POST',
      headers: { 'content-type': 'audio/webm' },
      body: BYTES,
    });
    expect(up.status).toBe(200);
    const sync = () =>
      on(b, `/api/sessions/${sessionId}/audio/segments/sync-from-disk`, { method: 'POST' });
    const listOnB = async () =>
      (
        (await (await on(b, `/api/sessions/${sessionId}/audio/segments`)).json()) as {
          segments: Array<{ id: string }>;
        }
      ).segments.map((s) => s.id);

    const first = await sync();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ inserted: 0, updated: 0, scanned: 1, has_audio: true });
    expect(await listOnB()).toHaveLength(1);

    // A blob with no row, written by A's store (as a crash between put and row would leave it).
    const orphanId = randomUUID();
    await a.bindings.ports.audio.put(`audio/${sessionId}/0002_${orphanId}.webm`, BYTES);
    const second = await sync();
    expect(await second.json()).toEqual({ inserted: 1, updated: 0, scanned: 2, has_audio: true });
    expect(await listOnB()).toContain(orphanId);
    const third = await sync();
    expect(await third.json()).toEqual({ inserted: 0, updated: 0, scanned: 2, has_audio: true });
    expect(await listOnB()).toHaveLength(2);
  });
});
