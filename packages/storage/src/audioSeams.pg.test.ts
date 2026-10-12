// media-worker design D7, D18 (task S.5): the recording seams of `audioSeams.ts` on a
// `catalog_system` binding of the Postgres catalog adapter.
import type { CatalogDb } from '@autologger/ports';
import type { AudioSeam } from '@autologger/ports/media';
import { afterEach, describe, expect, it } from 'vitest';
import { audioSeams } from './audioSeams';
import { PostgresCatalogDb } from './postgresCatalogStore';
import { createTestDatabase } from './test/pgDb';

const roots: PostgresCatalogDb[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => r.close()));
});

const T = (m: number) => `2026-10-19T00:${String(m).padStart(2, '0')}:00.000Z`;

async function env() {
  const root = new PostgresCatalogDb((await createTestDatabase()).app);
  roots.push(root);
  const sys: CatalogDb = root.bindSystem('test');
  await sys.run(`INSERT INTO sessions (id) VALUES ('s1'), ('s2')`);
  const segment = (sid: string, id: string) =>
    sys.run(
      `INSERT INTO session_audio_segments (session_id, id, ordinal, mime_type, r2_key,
         created_at_utc, recording_ordinal) VALUES (?, ?, 1, 'audio/webm', ?, 't', 3)`,
      sid,
      id,
      `audio/${sid}/3_${id}.webm`,
    );
  const chunk = async (sid: string, id: string, minute: number): Promise<AudioSeam> => {
    await segment(sid, id);
    const seam: AudioSeam = {
      sessionId: sid,
      recordingOrdinal: 3,
      startedAtUtc: T(minute),
      endedAtUtc: T(minute + 10),
      segmentId: id,
      offsetMs: 0,
      sourceKey: `audio/${sid}/3_${id}.webm`,
    };
    await audioSeams.insert(sys, seam);
    return seam;
  };
  return { sys, segment, chunk };
}

describe('recording seams (D7, D18)', () => {
  it('a window is found by session, recording ordinal and start, with its segment and offset', async () => {
    const { sys, chunk } = await env();
    const a = await chunk('s1', 'a', 0);
    expect(await audioSeams.findWindow(sys, 's1', 3, T(0))).toEqual(a);
    expect(await audioSeams.findWindow(sys, 's1', 3, T(10))).toBeNull();
    expect(await audioSeams.findWindow(sys, 's1', 4, T(0))).toBeNull();
    expect(await audioSeams.findWindow(sys, 's2', 3, T(0))).toBeNull();
  });

  it('a duplicate window is refused with 23505', async () => {
    const { sys, chunk } = await env();
    const a = await chunk('s1', 'a', 0);
    await expect(audioSeams.insert(sys, { ...a, segmentId: 'a' })).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('lists a recording by start, and repoints windows at a merged segment with offsets', async () => {
    const { sys, segment, chunk } = await env();
    await chunk('s1', 'c', 20);
    await chunk('s1', 'a', 0);
    await chunk('s1', 'b', 10);
    await chunk('s2', 'z', 0);
    expect((await audioSeams.windowsOf(sys, 's1', 3)).map((s) => s.segmentId)).toEqual([
      'a',
      'b',
      'c',
    ]);
    await segment('s1', 'merged');
    expect(
      await audioSeams.repoint(sys, 's1', 3, 'merged', [
        { startedAtUtc: T(0), offsetMs: 0 },
        { startedAtUtc: T(10), offsetMs: 600_020 },
        { startedAtUtc: T(20), offsetMs: 1_200_051 },
        { startedAtUtc: T(30), offsetMs: 1 }, // no such window
      ]),
    ).toBe(3);
    const seams = await audioSeams.seamsOfSegment(sys, 's1', 'merged');
    expect(seams.map((s) => [s.startedAtUtc, s.offsetMs, s.sourceKey])).toEqual([
      [T(0), 0, 'audio/s1/3_a.webm'],
      [T(10), 600_020, 'audio/s1/3_b.webm'],
      [T(20), 1_200_051, 'audio/s1/3_c.webm'],
    ]);
    // Deleting the merged inputs keeps the repointed seams; the window now answers with the merge.
    await sys.run(
      `DELETE FROM session_audio_segments WHERE session_id = 's1' AND id IN ('a', 'b', 'c')`,
    );
    expect(await audioSeams.findWindow(sys, 's1', 3, T(10))).toMatchObject({
      segmentId: 'merged',
      offsetMs: 600_020,
    });
    expect(await audioSeams.seamsOfSegment(sys, 's1', 'a')).toEqual([]);
    expect((await audioSeams.windowsOf(sys, 's2', 3)).map((s) => s.segmentId)).toEqual(['z']);
    expect(await audioSeams.repoint(sys, 's1', 3, 'merged', [])).toBe(0);
  });
});
