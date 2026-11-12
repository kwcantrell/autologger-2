import { describe, expect, it } from 'vitest';
import { app, env } from '../test/harness';
import { seededSession } from '../test/helpers';

async function logEvent(session: string, message: string): Promise<Response> {
  return app.request(
    `/api/sessions/${session}/events`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'cam', message }),
    },
    { ...env },
  );
}

describe('events flow', () => {
  it('logs an event then lists it', async () => {
    const session = (await seededSession()).sessionId;
    expect((await logEvent(session, 'Cut to 2')).status).toBe(200);
    const list = await app.request(
      `/api/sessions/${session}/events`,
      { method: 'GET' },
      { ...env },
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as { events: unknown[] };
    expect(body.events.length).toBeGreaterThanOrEqual(1);
  });
});

describe('audio flow (blob-store round-trip)', () => {
  it('rejects an empty audio body with 400', async () => {
    const session = (await seededSession()).sessionId;
    const res = await app.request(
      `/api/sessions/${session}/audio/segments`,
      { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: new Uint8Array(0) },
      { ...env },
    );
    expect(res.status).toBe(400);
  });

  it('returns 416 (not 500) for a suffix Range against a zero-byte blob', async () => {
    const session = (await seededSession()).sessionId;
    // Zero-byte blobs can't arrive via upload (empty bodies are 400); they
    // reach the store the way they do in the field — bytes already on disk,
    // registered via sync-from-disk.
    await env.ports.audio.put(
      `audio/${session}/0001_${crypto.randomUUID()}.webm`,
      new Uint8Array(0),
    );
    const sync = await app.request(
      `/api/sessions/${session}/audio/segments/sync-from-disk`,
      { method: 'POST' },
      { ...env },
    );
    expect(sync.status).toBe(200);
    // The sync response carries counts only — segment metadata (urls included)
    // comes from the segments list route.
    expect(await sync.json()).toEqual({
      inserted: 1,
      updated: 0,
      scanned: 1,
      has_audio: true,
    });
    const list = await app.request(
      `/api/sessions/${session}/audio/segments`,
      { method: 'GET' },
      { ...env },
    );
    expect(list.status).toBe(200);
    const { segments } = (await list.json()) as { segments: Array<{ url: string }> };
    expect(segments).toHaveLength(1);
    const res = await app.request(
      segments[0].url,
      { method: 'GET', headers: { range: 'bytes=-1' } },
      { ...env },
    );
    expect(res.status).toBe(416);
    expect(await res.json()).toEqual({ detail: 'Requested range not satisfiable.' });
  });
});

describe('exports flow', () => {
  it('returns CSV and JSONL after an event is logged', async () => {
    const session = (await seededSession()).sessionId;
    await logEvent(session, 'm');
    const csv = await app.request(
      `/api/sessions/${session}/export.csv`,
      { method: 'GET' },
      { ...env },
    );
    expect(csv.status).toBe(200);
    expect(await csv.text()).toContain(',');
    const jsonl = await app.request(
      `/api/sessions/${session}/export.jsonl`,
      { method: 'GET' },
      { ...env },
    );
    expect(jsonl.status).toBe(200);
    expect((await jsonl.text()).length).toBeGreaterThan(0);
  });
});
