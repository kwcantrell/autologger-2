import { app, env } from '../test/harness';
import { describe, expect, it } from 'vitest';
import { seedSession, seedShow, seedStudio } from '../test/helpers';

async function seededSession(): Promise<string> {
  const studio = await seedStudio();
  const show = await seedShow({ studioId: studio });
  return seedSession({ showId: show });
}
const J = { 'content-type': 'application/json' };

describe('unavailable endpoints (503)', () => {
  it('transcribe.csv, transcript-words/generate, topics/generate are 503', async () => {
    const s = await seededSession();
    for (const path of [
      `/api/sessions/${s}/transcribe.csv`,
      `/api/sessions/${s}/transcript-words/generate`,
      `/api/sessions/${s}/topics/generate`,
    ]) {
      const method = path.endsWith('.csv') ? 'GET' : 'POST';
      const res = await app.request(path, { method }, { ...env });
      expect(res.status).toBe(503);
    }
  });
});

describe('transcript-words CRUD', () => {
  it('create → list → patch → delete', async () => {
    const s = await seededSession();
    const create = await app.request(
      `/api/sessions/${s}/transcript-words`,
      { method: 'POST', headers: J, body: JSON.stringify({ speaker: 'Host', word: 'hello' }) },
      { ...env },
    );
    expect(create.status).toBe(201);
    const wordId = ((await create.json()) as { id: string }).id;

    const list = await app.request(
      `/api/sessions/${s}/transcript-words`,
      { method: 'GET' },
      { ...env },
    );
    expect(((await list.json()) as { words: unknown[] }).words.length).toBe(1);

    const patch = await app.request(
      `/api/sessions/${s}/transcript-words/${wordId}`,
      { method: 'PATCH', headers: J, body: JSON.stringify({ word: 'world' }) },
      { ...env },
    );
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { word: string }).word).toBe('world');

    const del = await app.request(
      `/api/sessions/${s}/transcript-words/${wordId}`,
      { method: 'DELETE' },
      { ...env },
    );
    expect(del.status).toBe(204);
  });

  it('404 patching an unknown word', async () => {
    const s = await seededSession();
    const res = await app.request(
      `/api/sessions/${s}/transcript-words/nope`,
      { method: 'PATCH', headers: J, body: JSON.stringify({ word: 'x' }) },
      { ...env },
    );
    expect(res.status).toBe(404);
  });
});

describe('topics CRUD', () => {
  it('create → list → patch → delete', async () => {
    const s = await seededSession();
    const create = await app.request(
      `/api/sessions/${s}/topics`,
      { method: 'POST', headers: J, body: JSON.stringify({ summary: 'Intro', topic_level: 1 }) },
      { ...env },
    );
    expect(create.status).toBe(201);
    const topicId = ((await create.json()) as { id: string }).id;

    const list = await app.request(`/api/sessions/${s}/topics`, { method: 'GET' }, { ...env });
    expect(((await list.json()) as { topics: unknown[] }).topics.length).toBe(1);

    const patch = await app.request(
      `/api/sessions/${s}/topics/${topicId}`,
      { method: 'PATCH', headers: J, body: JSON.stringify({ summary: 'Outro' }) },
      { ...env },
    );
    expect(patch.status).toBe(200);

    const del = await app.request(
      `/api/sessions/${s}/topics/${topicId}`,
      { method: 'DELETE' },
      { ...env },
    );
    expect(del.status).toBe(204);
  });

  it('404 deleting an unknown topic', async () => {
    const s = await seededSession();
    const res = await app.request(`/api/sessions/${s}/topics/nope`, { method: 'DELETE' }, { ...env });
    expect(res.status).toBe(404);
  });
});
