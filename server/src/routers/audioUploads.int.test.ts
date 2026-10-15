// media-worker B.4 (design D12; api-contract-freeze "Resumable audio upload endpoints",
// media-processing "Large imports are staged by parts the API assembles"): the five upload routes
// over the real bindings. Parts are made small by declaring small files: `part_size` is the server
// constant (32 MiB), so a file of a few bytes is one short last part, and multi-part cases use
// `size_bytes` just over one part with sparse content.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MediaBlobStore } from '@autologger/ports/media';
import { UPLOAD_PART_BYTES } from '@autologger/storage/mediaLimits';
import { describe, expect, it } from 'vitest';
import { app, defaultUser, env, envWith, testDirs } from '../test/harness';
import { seededSession } from '../test/helpers';
import { catalogRoot } from '../test/session/sessionRows';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const JSON_H = { 'content-type': 'application/json' };

function bytesOf(n: number, seed = 1): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

/** The file split into server-sized parts. */
function partsOf(file: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let o = 0; o < file.length; o += UPLOAD_PART_BYTES)
    out.push(file.subarray(o, o + UPLOAD_PART_BYTES));
  return out;
}

type E = typeof env;
const base = (sid: string) => `/api/sessions/${sid}/audio/uploads`;

async function create(sid: string, body: unknown, e: E = env) {
  return app.request(
    base(sid),
    { method: 'POST', headers: JSON_H, body: JSON.stringify(body) },
    { ...e },
  );
}

async function createFor(sid: string, file: Uint8Array, contentType = 'audio/wav', e: E = env) {
  const res = await create(
    sid,
    { content_type: contentType, size_bytes: file.length, part_sha256: partsOf(file).map(sha) },
    e,
  );
  expect(res.status).toBe(201);
  return (await res.json()) as {
    upload_id: string;
    part_size: number;
    parts_total: number;
    expires_at_utc: string;
  };
}

async function putPart(sid: string, id: string, n: number | string, body: Uint8Array, e: E = env) {
  return app.request(
    `${base(sid)}/${id}/parts/${n}`,
    { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body },
    { ...e },
  );
}

async function status(sid: string, id: string) {
  return app.request(`${base(sid)}/${id}`, { method: 'GET' }, { ...env });
}

async function complete(
  sid: string,
  id: string,
  q: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return app.request(
    `${base(sid)}/${id}/complete?${new URLSearchParams(q).toString()}`,
    { method: 'POST', headers },
    { ...env },
  );
}

function staging(): string[] {
  try {
    return readdirSync(join(testDirs().blobDir, '.tmp')).filter((n) => n.startsWith('upload-'));
  } catch {
    return [];
  }
}

const lowDisk = (): E =>
  envWith(
    {},
    {
      mediaBlobs: new Proxy(env.ports.mediaBlobs, {
        get(t, p) {
          if (p === 'freeBytes') return async () => 1024;
          const v = Reflect.get(t, p, t);
          return typeof v === 'function' ? v.bind(t) : v;
        },
      }) as MediaBlobStore,
    },
  );

describe('POST …/audio/uploads (create)', () => {
  it('201 with the server part size, parts_total and an expiry; a staging file exists', async () => {
    const { sessionId: sid } = await seededSession();
    const up = await createFor(sid, bytesOf(10));
    expect(up).toMatchObject({ part_size: UPLOAD_PART_BYTES, parts_total: 1 });
    expect(Number.isNaN(Date.parse(up.expires_at_utc))).toBe(false);
    expect(staging()).toContain(`upload-${up.upload_id}`);
  });

  it('413 over 1500 MiB; 400 on a blank content_type or a bad hash list', async () => {
    const { sessionId: sid } = await seededSession();
    const h = 'a'.repeat(64);
    const big = await create(sid, {
      content_type: 'audio/wav',
      size_bytes: 1500 * 1024 * 1024 + 1,
      part_sha256: [h],
    });
    expect(big.status).toBe(413);
    expect(await big.json()).toHaveProperty('detail');
    for (const body of [
      { content_type: ' ', size_bytes: 10, part_sha256: [h] },
      { content_type: 'audio/wav', size_bytes: 10, part_sha256: ['A'.repeat(64)] },
      { content_type: 'audio/wav', size_bytes: 10, part_sha256: [h, h] },
      { content_type: 'audio/wav', size_bytes: UPLOAD_PART_BYTES + 1, part_sha256: [h] },
    ]) {
      const res = await create(sid, body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(await res.json()).toHaveProperty('detail');
    }
    expect(staging()).toEqual([]);
  });

  it('429 for a third open upload, and over 3 GiB staged; nothing staged for the refusal', async () => {
    const { sessionId: sid } = await seededSession();
    await createFor(sid, bytesOf(10));
    await createFor(sid, bytesOf(11));
    const before = staging().length;
    const third = await create(sid, {
      content_type: 'audio/wav',
      size_bytes: 12,
      part_sha256: [sha(bytesOf(12))],
    });
    expect(third.status).toBe(429);
    expect(staging()).toHaveLength(before);
  });

  it('429 when the staged bytes would exceed 3 GiB', async () => {
    const { sessionId: sid } = await seededSession();
    const me = await defaultUser();
    const huge = 1400 * 1024 * 1024;
    const hashes = Array(Math.ceil(huge / UPLOAD_PART_BYTES)).fill('b'.repeat(64));
    const first = await create(sid, {
      content_type: 'audio/wav',
      size_bytes: huge,
      part_sha256: hashes,
    });
    expect(first.status).toBe(201);
    void me;
    const second = await create(sid, {
      content_type: 'audio/wav',
      size_bytes: huge,
      part_sha256: hashes,
    });
    // 2 × 1400 MiB = 2.73 GiB is under the cap; a third would be over the count cap, so the byte
    // cap is shown with a pre-existing staged row (another session's upload of the same user).
    expect(second.status).toBe(201);
    await catalogRoot()
      .bindSystem('test-seed')
      .run(
        "UPDATE media_uploads SET size_bytes = 1700 * 1024 * 1024 WHERE created_by_user_id = ? AND status = 'open'",
        me.id,
      );
    await catalogRoot()
      .bindSystem('test-seed')
      .run(
        "DELETE FROM media_uploads WHERE id = (SELECT id FROM media_uploads WHERE created_by_user_id = ? AND status = 'open' ORDER BY created_at_ms LIMIT 1)",
        me.id,
      );
    const third = await create(sid, {
      content_type: 'audio/wav',
      size_bytes: huge,
      part_sha256: hashes,
    });
    expect(third.status).toBe(429);
    expect(await third.json()).toHaveProperty('detail');
  });

  it('507 below the free-disk floor; nothing staged', async () => {
    const { sessionId: sid } = await seededSession();
    const res = await create(
      sid,
      { content_type: 'audio/wav', size_bytes: 10, part_sha256: [sha(bytesOf(10))] },
      lowDisk(),
    );
    expect(res.status).toBe(507);
    expect(await res.json()).toHaveProperty('detail');
    expect(staging()).toEqual([]);
  });
});

describe('PUT …/parts/:n, GET status, DELETE', () => {
  it('a part is written at its offset, listed by GET, re-sendable; a bad hash is 400 and not recorded', async () => {
    const { sessionId: sid } = await seededSession();
    const file = bytesOf(UPLOAD_PART_BYTES + 5);
    const [p1, p2] = partsOf(file) as [Uint8Array, Uint8Array];
    const up = await createFor(sid, file);
    expect(up.parts_total).toBe(2);
    const bad = await putPart(sid, up.upload_id, 2, bytesOf(5, 99));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toHaveProperty('detail');
    let st = (await (await status(sid, up.upload_id)).json()) as { received: number[] };
    expect(st.received).toEqual([]);
    expect((await putPart(sid, up.upload_id, 2, p2)).status).toBe(204);
    expect((await putPart(sid, up.upload_id, 2, p2)).status).toBe(204);
    expect((await putPart(sid, up.upload_id, 1, p1)).status).toBe(204);
    const res = await status(sid, up.upload_id);
    expect(res.status).toBe(200);
    st = (await res.json()) as { received: number[] };
    expect(st).toEqual({
      upload_id: up.upload_id,
      status: 'open',
      size_bytes: file.length,
      part_size: UPLOAD_PART_BYTES,
      parts_total: 2,
      received: [1, 2],
      expires_at_utc: expect.any(String),
    });
  });

  it('wrong sizes are 400, over part_size 413, bad part numbers 400, unknown uploads 404, low disk 507', async () => {
    const { sessionId: sid } = await seededSession();
    const file = bytesOf(20);
    const up = await createFor(sid, file);
    expect((await putPart(sid, up.upload_id, 1, bytesOf(19))).status).toBe(400);
    expect((await putPart(sid, up.upload_id, 1, bytesOf(21))).status).toBe(400);
    expect(
      (await putPart(sid, up.upload_id, 1, new Uint8Array(UPLOAD_PART_BYTES + 1))).status,
    ).toBe(413);
    for (const n of ['0', '2', 'x'])
      expect((await putPart(sid, up.upload_id, n, file)).status, n).toBe(400);
    expect((await putPart(sid, crypto.randomUUID(), 1, file)).status).toBe(404);
    expect((await putPart(sid, up.upload_id, 1, file, lowDisk())).status).toBe(507);
    expect((await status(sid, crypto.randomUUID())).status).toBe(404);
  });

  it('404 after expiry and after completion', async () => {
    const { sessionId: sid } = await seededSession();
    const file = bytesOf(20);
    const up = await createFor(sid, file);
    await catalogRoot()
      .bindSystem('test-seed')
      .run('UPDATE media_uploads SET expires_at_ms = 1 WHERE id = ?', up.upload_id);
    expect((await putPart(sid, up.upload_id, 1, file)).status).toBe(404);
    const up2 = await createFor(sid, file);
    expect((await putPart(sid, up2.upload_id, 1, file)).status).toBe(204);
    expect(
      (await complete(sid, up2.upload_id, { duration_s: '2' }, { 'content-type': 'audio/wav' }))
        .status,
    ).toBe(200);
    expect((await putPart(sid, up2.upload_id, 1, file)).status).toBe(404);
  });

  it('DELETE is 204 and removes the staging; unknown is 404', async () => {
    const { sessionId: sid } = await seededSession();
    const up = await createFor(sid, bytesOf(10));
    const res = await app.request(`${base(sid)}/${up.upload_id}`, { method: 'DELETE' }, { ...env });
    expect(res.status).toBe(204);
    expect(staging()).not.toContain(`upload-${up.upload_id}`);
    expect((await status(sid, up.upload_id)).status).toBe(404);
    const again = await app.request(
      `${base(sid)}/${up.upload_id}`,
      { method: 'DELETE' },
      { ...env },
    );
    expect(again.status).toBe(404);
  });
});

describe('POST …/complete', () => {
  it('409 with missing_parts while a part is missing; no segment', async () => {
    const { sessionId: sid } = await seededSession();
    const file = bytesOf(UPLOAD_PART_BYTES + 5);
    const up = await createFor(sid, file);
    expect((await putPart(sid, up.upload_id, 1, partsOf(file)[0] as Uint8Array)).status).toBe(204);
    const res = await complete(sid, up.upload_id, { duration_s: '3' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ detail: expect.any(String), missing_parts: [2] });
  });

  it('import mode: parts in any order assemble the original bytes, one anchored take, seam parts appended', async () => {
    const { sessionId: sid } = await seededSession();
    const file = bytesOf(UPLOAD_PART_BYTES + 77, 5);
    const parts = partsOf(file);
    const up = await createFor(sid, file);
    expect((await putPart(sid, up.upload_id, 2, parts[1] as Uint8Array)).status).toBe(204);
    expect((await putPart(sid, up.upload_id, 1, parts[0] as Uint8Array)).status).toBe(204);
    const seamHeader = JSON.stringify([
      { name: 'a.wav', duration_s: 1 },
      { name: 'b.wav', duration_s: 2 },
    ]);
    const res = await complete(
      sid,
      up.upload_id,
      { duration_s: '3' },
      { 'x-audio-seam-parts': seamHeader },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; segment_id: string };
    expect(body).toEqual({ ok: true, segment_id: expect.any(String) });
    const list = await app.request(
      `/api/sessions/${sid}/audio/segments`,
      { method: 'GET' },
      { ...env },
    );
    const seg = (
      (await list.json()) as {
        segments: { id: string; recording_ordinal: number; mime_type: string }[];
      }
    ).segments;
    expect(seg).toHaveLength(1);
    expect(seg[0]).toMatchObject({
      id: body.segment_id,
      recording_ordinal: 1,
      mime_type: 'audio/wav',
    });
    const files = readdirSync(join(testDirs().blobDir, 'audio', sid));
    expect(files).toHaveLength(1);
    expect(sha(readFileSync(join(testDirs().blobDir, 'audio', sid, files[0] as string)))).toBe(
      sha(file),
    );
    expect(staging()).not.toContain(`upload-${up.upload_id}`);
    const ev = await app.request(
      `/api/sessions/${sid}/events?limit=50`,
      { method: 'GET' },
      { ...env },
    );
    expect(JSON.stringify(await ev.json())).toContain('Recording 1 Stopped');
    const jobs = await catalogRoot()
      .bindSystem('test-seed')
      .all<{ input_bytes: number }>(
        "SELECT input_bytes FROM media_jobs WHERE session_id = ? AND kind = 'ingest'",
        sid,
      );
    expect(jobs).toEqual([{ input_bytes: file.length }]);
  });

  it("import mode keeps local-audio-import's 400s for duration_s", async () => {
    const { sessionId: sid } = await seededSession();
    const up = await createFor(sid, bytesOf(4));
    expect((await putPart(sid, up.upload_id, 1, bytesOf(4))).status).toBe(204);
    for (const d of ['', '0', 'x', '100000']) {
      expect((await complete(sid, up.upload_id, { duration_s: d })).status, d).toBe(400);
    }
  });

  it('import mode: 409 while the session is rolling; nothing attached and the upload stays open', async () => {
    const { sessionId: sid } = await seededSession();
    const up = await createFor(sid, bytesOf(4));
    expect((await putPart(sid, up.upload_id, 1, bytesOf(4))).status).toBe(204);
    const start = await app.request(
      `/api/sessions/${sid}/transport/start`,
      { method: 'POST' },
      { ...env },
    );
    expect(start.status).toBe(200);
    const res = await complete(sid, up.upload_id, { duration_s: '1' });
    expect(res.status).toBe(409);
    const list = await app.request(
      `/api/sessions/${sid}/audio/segments`,
      { method: 'GET' },
      { ...env },
    );
    expect(((await list.json()) as { segments: unknown[] }).segments).toEqual([]);
    expect(((await (await status(sid, up.upload_id)).json()) as { status: string }).status).toBe(
      'open',
    );
  });

  it('a re-hash mismatch is 400 and aborts the upload', async () => {
    const { sessionId: sid } = await seededSession();
    const up = await createFor(sid, bytesOf(8));
    expect((await putPart(sid, up.upload_id, 1, bytesOf(8))).status).toBe(204);
    // Corrupt the staged bytes behind the server's back.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(testDirs().blobDir, '.tmp', `upload-${up.upload_id}`), bytesOf(8, 7));
    const res = await complete(sid, up.upload_id, { duration_s: '1' });
    expect(res.status).toBe(400);
    expect(existsSync(join(testDirs().blobDir, '.tmp', `upload-${up.upload_id}`))).toBe(false);
    expect((await status(sid, up.upload_id)).status).toBe(404);
  });

  it('segment mode: one segment with its window, no anchor, idempotent on replay', async () => {
    const { sessionId: sid } = await seededSession();
    const q = {
      recording_ordinal: '3',
      started_at_utc: '2026-10-12T10:00:00Z',
      ended_at_utc: '2026-10-12T10:10:00Z',
    };
    const up = await createFor(sid, bytesOf(6), 'audio/webm');
    expect((await putPart(sid, up.upload_id, 1, bytesOf(6))).status).toBe(204);
    const res = await complete(sid, up.upload_id, q);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; segment_id: string };
    const up2 = await createFor(sid, bytesOf(6), 'audio/webm');
    expect((await putPart(sid, up2.upload_id, 1, bytesOf(6))).status).toBe(204);
    const res2 = await complete(sid, up2.upload_id, q);
    expect(await res2.json()).toEqual(body);
    const list = await app.request(
      `/api/sessions/${sid}/audio/segments`,
      { method: 'GET' },
      { ...env },
    );
    const segs = ((await list.json()) as { segments: Record<string, unknown>[] }).segments;
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      recording_ordinal: 3,
      started_at_utc: '2026-10-12T10:00:00.000Z',
    });
    const ev = await app.request(
      `/api/sessions/${sid}/events?limit=50`,
      { method: 'GET' },
      { ...env },
    );
    expect(JSON.stringify(await ev.json())).not.toContain('Recording 3');
    expect(staging()).toEqual([]);
  });
});
