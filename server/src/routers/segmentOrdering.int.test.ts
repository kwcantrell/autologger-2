// media-worker (coordinator decision 2026-10-12, closes panel C minor 7): every path that creates
// a segment writes its blob, under its final key, BEFORE the row commits, so a listed row always
// has its bytes and a transcript generation never meets a row without one (D9's `missing_blob` →
// 502 stays a true error). A request that ends without a row (a replay of a held window, a lost
// race) leaves no blob behind. Each blob write is observed: at that moment no row may name the key.

import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MediaBlobStore } from '@autologger/ports/media';
import { describe, expect, it } from 'vitest';
import { app, env, envWith, testDirs } from '../test/harness';
import { seededSession } from '../test/helpers';
import { catalogRoot } from '../test/session/sessionRows';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function rowNaming(key: string): Promise<boolean> {
  const rows = await catalogRoot()
    .bindSystem('test-seed')
    .all('SELECT 1 FROM session_audio_segments WHERE r2_key = ?', key);
  return rows.length > 0;
}

/** An env whose blob writes record whether a row already named the key when the bytes landed. */
function observed() {
  const writes: { key: string; rowExisted: boolean }[] = [];
  const audio = env.ports.audio;
  const media = env.ports.mediaBlobs;
  const e = envWith(
    {},
    {
      audio: new Proxy(audio, {
        get(t, p) {
          if (p === 'put') {
            return async (key: string, ...rest: unknown[]) => {
              writes.push({ key, rowExisted: await rowNaming(key) });
              return (t.put as (...a: unknown[]) => Promise<void>).call(t, key, ...rest);
            };
          }
          const v = Reflect.get(t, p, t);
          return typeof v === 'function' ? v.bind(t) : v;
        },
      }),
      mediaBlobs: new Proxy(media, {
        get(t, p) {
          if (p === 'adoptStaging') {
            return async (id: string, key: string) => {
              writes.push({ key, rowExisted: await rowNaming(key) });
              return t.adoptStaging(id, key);
            };
          }
          const v = Reflect.get(t, p, t);
          return typeof v === 'function' ? v.bind(t) : v;
        },
      }) as MediaBlobStore,
    },
  );
  return { e, writes };
}

const files = (sid: string) => {
  try {
    return readdirSync(join(testDirs().blobDir, 'audio', sid)).sort();
  } catch {
    return [];
  }
};

async function listedKeys(sid: string): Promise<string[]> {
  const rows = await catalogRoot()
    .bindSystem('test-seed')
    .all<{ r2_key: string }>('SELECT r2_key FROM session_audio_segments WHERE session_id = ?', sid);
  return rows.map((r) => r.r2_key.split('/').pop() as string).sort();
}

describe('the blob is written before its row (every create path)', () => {
  it('segment POST: blob first; a replay writes no blob; a race leaves one blob per row', async () => {
    const { sessionId: sid } = await seededSession();
    const { e, writes } = observed();
    const q = 'recording_ordinal=1&started_at_utc=2026-10-12T10:00:00Z';
    const post = () =>
      app.request(
        `/api/sessions/${sid}/audio/segments?${q}`,
        { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: new Uint8Array([1, 2]) },
        { ...e },
      );
    expect((await post()).status).toBe(200);
    expect(writes).toEqual([{ key: expect.any(String), rowExisted: false }]);
    expect((await post()).status).toBe(200);
    expect(writes).toHaveLength(1);
    const [a, b] = await Promise.all([
      app.request(
        `/api/sessions/${sid}/audio/segments?recording_ordinal=1&started_at_utc=2026-10-12T10:10:00Z`,
        { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: new Uint8Array([3]) },
        { ...e },
      ),
      app.request(
        `/api/sessions/${sid}/audio/segments?recording_ordinal=1&started_at_utc=2026-10-12T10:10:00Z`,
        { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: new Uint8Array([3]) },
        { ...e },
      ),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(writes.every((w) => !w.rowExisted)).toBe(true);
    expect(files(sid)).toEqual(await listedKeys(sid));
    expect(files(sid)).toHaveLength(2);
  });

  it('local-audio-import: blob first', async () => {
    const { sessionId: sid } = await seededSession();
    const { e, writes } = observed();
    const res = await app.request(
      `/api/sessions/${sid}/local-audio-import?duration_s=1`,
      { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array([1, 2, 3]) },
      { ...e },
    );
    expect(res.status).toBe(200);
    expect(writes).toEqual([{ key: expect.any(String), rowExisted: false }]);
    expect(files(sid)).toEqual(await listedKeys(sid));
  });

  it('upload complete, both modes: the staged file is adopted before the row; a replayed window leaves no blob', async () => {
    const { sessionId: sid } = await seededSession();
    const { e, writes } = observed();
    const file = new Uint8Array([9, 8, 7]);
    const upload = async () => {
      const c = await app.request(
        `/api/sessions/${sid}/audio/uploads`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            content_type: 'audio/webm',
            size_bytes: 3,
            part_sha256: [sha(file)],
          }),
        },
        { ...e },
      );
      const { upload_id } = (await c.json()) as { upload_id: string };
      const p = await app.request(
        `/api/sessions/${sid}/audio/uploads/${upload_id}/parts/1`,
        { method: 'PUT', body: file },
        { ...e },
      );
      expect(p.status).toBe(204);
      return upload_id;
    };
    const imp = await app.request(
      `/api/sessions/${sid}/audio/uploads/${await upload()}/complete?duration_s=1`,
      { method: 'POST' },
      { ...e },
    );
    expect(imp.status).toBe(200);
    const seg =
      'recording_ordinal=5&started_at_utc=2026-10-12T11:00:00Z&ended_at_utc=2026-10-12T11:10:00Z';
    for (let i = 0; i < 2; i += 1) {
      const res = await app.request(
        `/api/sessions/${sid}/audio/uploads/${await upload()}/complete?${seg}`,
        { method: 'POST' },
        { ...e },
      );
      expect(res.status).toBe(200);
    }
    expect(writes).toHaveLength(2);
    expect(writes.every((w) => !w.rowExisted)).toBe(true);
    expect(files(sid)).toEqual(await listedKeys(sid));
  });
});
