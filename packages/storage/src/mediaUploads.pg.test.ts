// media-worker design D12 (task S.4): the resumable upload rows of `mediaUploads.ts` on a
// `catalog_system` binding of the Postgres catalog adapter.
import type { CatalogDb } from '@autologger/ports';
import { afterEach, describe, expect, it } from 'vitest';
import { UPLOAD_PART_BYTES, UPLOAD_TTL_MS } from './mediaLimits';
import { mediaUploads } from './mediaUploads';
import { PostgresCatalogDb } from './postgresCatalogStore';
import { createTestDatabase } from './test/pgDb';

const roots: PostgresCatalogDb[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => r.close()));
});

const hash = (c: string) => c.repeat(64);
const NOW = 1_760_000_000_000;

async function env() {
  const root = new PostgresCatalogDb((await createTestDatabase()).app);
  roots.push(root);
  const sys: CatalogDb = root.bindSystem('test');
  for (const u of ['u1', 'u2']) {
    await sys.run(
      `INSERT INTO users (id, google_sub, email, created_at_utc) VALUES (?, ?, ?, 't')`,
      u,
      `${u}-sub`,
      `${u}@example.com`,
    );
  }
  await sys.run(`INSERT INTO sessions (id) VALUES ('s1')`);
  const create = (id: string, user = 'u1', sizeBytes = 3 * UPLOAD_PART_BYTES - 5, nowMs = NOW) =>
    mediaUploads.create(sys, {
      id,
      sessionId: 's1',
      createdByUserId: user,
      contentType: 'audio/wav',
      sizeBytes,
      partSize: UPLOAD_PART_BYTES,
      partSha256: ['a', 'b', 'c'].map(hash),
      nowMs,
    });
  return { sys, create };
}

describe('media uploads (D12)', () => {
  it('creates an open upload with its part hash list and a 24 h expiry', async () => {
    const { sys, create } = await env();
    const up = await create('up1');
    const expected = {
      id: 'up1',
      sessionId: 's1',
      createdByUserId: 'u1',
      contentType: 'audio/wav',
      sizeBytes: 3 * UPLOAD_PART_BYTES - 5,
      partSize: UPLOAD_PART_BYTES,
      partsTotal: 3,
      partSha256: [hash('a'), hash('b'), hash('c')],
      received: [],
      status: 'open',
      expiresAtMs: NOW + UPLOAD_TTL_MS,
      createdAtMs: NOW,
    };
    expect(up).toEqual(expected);
    expect(await mediaUploads.get(sys, 'up1')).toEqual(expected);
    expect(await mediaUploads.get(sys, 'nope')).toBeNull();
  });

  it('records parts idempotently, in any order, pushing the expiry; refuses bad or late parts', async () => {
    const { sys, create } = await env();
    await create('up1');
    expect(await mediaUploads.recordPart(sys, 'up1', 3, NOW + 10)).toBe(true);
    expect(await mediaUploads.recordPart(sys, 'up1', 1, NOW + 20)).toBe(true);
    expect(await mediaUploads.recordPart(sys, 'up1', 3, NOW + 30)).toBe(true);
    expect(await mediaUploads.get(sys, 'up1')).toMatchObject({
      received: [1, 3],
      expiresAtMs: NOW + 30 + UPLOAD_TTL_MS,
    });
    for (const n of [0, 4, -1]) {
      expect(await mediaUploads.recordPart(sys, 'up1', n, NOW + 40), `part ${n}`).toBe(false);
    }
    expect(await mediaUploads.recordPart(sys, 'nope', 1, NOW)).toBe(false);
    // Expired: refused.
    expect(await mediaUploads.recordPart(sys, 'up1', 2, NOW + 30 + UPLOAD_TTL_MS)).toBe(false);
    expect((await mediaUploads.get(sys, 'up1'))?.received).toEqual([1, 3]);
  });

  it('concurrent parts all land', async () => {
    const { sys, create } = await env();
    await create('up1');
    await Promise.all([1, 2, 3].map((n) => mediaUploads.recordPart(sys, 'up1', n, NOW + n)));
    expect((await mediaUploads.get(sys, 'up1'))?.received).toEqual([1, 2, 3]);
  });

  it('marks complete once; a complete upload takes no parts', async () => {
    const { sys, create } = await env();
    await create('up1');
    expect(await mediaUploads.markComplete(sys, 'up1', NOW + 1)).toBe(true);
    expect(await mediaUploads.markComplete(sys, 'up1', NOW + 2)).toBe(false);
    expect((await mediaUploads.get(sys, 'up1'))?.status).toBe('complete');
    expect(await mediaUploads.recordPart(sys, 'up1', 1, NOW + 3)).toBe(false);
    expect(await mediaUploads.remove(sys, 'up1')).toBe(true);
    expect(await mediaUploads.remove(sys, 'up1')).toBe(false);
  });

  it('the sweep deletes uploads whose expiry passed and names them', async () => {
    const { sys, create } = await env();
    await create('old', 'u1', 10, NOW - UPLOAD_TTL_MS);
    await create('done', 'u1', 10, NOW - UPLOAD_TTL_MS - 5);
    await mediaUploads.markComplete(sys, 'done', NOW - UPLOAD_TTL_MS);
    await create('fresh', 'u1', 10, NOW - 1000);
    expect((await mediaUploads.deleteExpired(sys, NOW)).sort()).toEqual(['done', 'old']);
    expect(await mediaUploads.get(sys, 'fresh')).not.toBeNull();
    expect(await mediaUploads.deleteExpired(sys, NOW)).toEqual([]);
  });

  it("counts a user's open, unexpired uploads and their declared bytes", async () => {
    const { sys, create } = await env();
    await create('a', 'u1', 100);
    await create('b', 'u1', 250);
    await create('c', 'u1', 999, NOW - UPLOAD_TTL_MS); // expired
    await create('d', 'u1', 777);
    await mediaUploads.markComplete(sys, 'd', NOW);
    await create('e', 'u2', 5);
    expect(await mediaUploads.openUsage(sys, 'u1', NOW)).toEqual({ count: 2, bytes: 350 });
    expect(await mediaUploads.openUsage(sys, 'u2', NOW)).toEqual({ count: 1, bytes: 5 });
    expect(await mediaUploads.openUsage(sys, 'u3', NOW)).toEqual({ count: 0, bytes: 0 });
  });

  it('runs as the uploading user under its policies', async () => {
    const db = await createTestDatabase();
    const root = new PostgresCatalogDb(db.app);
    roots.push(root);
    const sys = root.bindSystem('test');
    await sys.run(
      `INSERT INTO users (id, google_sub, email, created_at_utc) VALUES ('u1', 'g', 'e', 't')`,
    );
    await sys.run(`INSERT INTO studio_definitions (id, display_name, created_at_utc)
                   VALUES ('st', 'S', 't')`);
    await sys.run(`INSERT INTO user_studio_memberships (user_id, studio_id, role)
                   VALUES ('u1', 'st', 'owner')`);
    await sys.run(`INSERT INTO shows (id, studio_id, name, show_code, created_at_utc)
                   VALUES ('sh', 'st', 'N', 'C', 't')`);
    await sys.run(`INSERT INTO sessions (id, show_id) VALUES ('s1', 'sh')`);
    const user = root.bindUser('u1');
    await mediaUploads.create(user, {
      id: 'up',
      sessionId: 's1',
      createdByUserId: 'u1',
      contentType: 'audio/wav',
      sizeBytes: 10,
      partSize: UPLOAD_PART_BYTES,
      partSha256: [hash('f')],
      nowMs: NOW,
    });
    expect(await mediaUploads.recordPart(user, 'up', 1, NOW)).toBe(true);
    expect(await mediaUploads.openUsage(user, 'u1', NOW)).toEqual({ count: 1, bytes: 10 });
    expect(await mediaUploads.markComplete(user, 'up', NOW)).toBe(true);
  });
});
