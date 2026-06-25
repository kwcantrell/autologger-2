import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '../index';
import { seedSession, seedShow, seedStudio } from '../test/helpers';

async function freshSession(): Promise<string> {
  const studio = await seedStudio();
  const show = await seedShow({ studioId: studio });
  return seedSession({ showId: show });
}

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
    const session = await freshSession();
    expect((await logEvent(session, 'Cut to 2')).status).toBe(200);
    const list = await app.request(`/api/sessions/${session}/events`, { method: 'GET' }, { ...env });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { events: unknown[] };
    expect(body.events.length).toBeGreaterThanOrEqual(1);
  });
});

describe('audio flow (R2 round-trip)', () => {
  it('uploads a segment, stores bytes in R2, and downloads them back', async () => {
    const session = await freshSession();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const up = await app.request(
      `/api/sessions/${session}/audio/segments`,
      { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: bytes },
      { ...env },
    );
    expect(up.status).toBe(200);
    const seg = (await up.json()) as { id: string; url: string };
    const down = await app.request(seg.url, { method: 'GET' }, { ...env });
    expect(down.status).toBe(200);
    expect(new Uint8Array(await down.arrayBuffer())).toEqual(bytes);
  });

  it('rejects an empty audio body with 400', async () => {
    const session = await freshSession();
    const res = await app.request(
      `/api/sessions/${session}/audio/segments`,
      { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: new Uint8Array(0) },
      { ...env },
    );
    expect(res.status).toBe(400);
  });
});

describe('exports flow', () => {
  it('returns CSV and JSONL after an event is logged', async () => {
    const session = await freshSession();
    await logEvent(session, 'm');
    const csv = await app.request(`/api/sessions/${session}/export.csv`, { method: 'GET' }, { ...env });
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
