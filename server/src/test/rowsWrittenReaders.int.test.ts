// Characterization tests pinning the three affected-row-count readers before
// the session SQL seam is reshaped (de-cloudflare-strong-core task 2.1):
// setAudioSegmentWaveform (404 + audio.changed broadcast), deleteTopic (404),
// deleteTranscriptWord (404). These lock the observable behavior — status codes
// and broadcast emission — that the count drives.

import { describe, expect, it } from 'vitest';
import { app, env } from './harness';
import { seededSession } from './helpers';

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

describe('affected-row-count readers (characterization)', () => {
  it('waveform PUT on a missing segment → 404 and NO audio.changed broadcast', async () => {
    const s = seededSession().sessionId;
    const sent: string[] = [];
    env.ports.sessions.get(s).attachSocket({ send: (d: string) => sent.push(d) }, 'browser');

    const res = await app.request(
      `/api/sessions/${s}/audio/segments/no-such-segment/waveform`,
      json('PUT', { peaks: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] }),
      env,
    );
    expect(res.status).toBe(404);
    expect(sent.filter((d) => JSON.parse(d).type === 'audio.changed')).toHaveLength(0);
  });

  it('waveform PUT on an existing segment → 200 {ok:true} and one audio.changed broadcast', async () => {
    const s = seededSession().sessionId;
    const up = await app.request(
      `/api/sessions/${s}/audio/segments`,
      { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: new Uint8Array([1, 2]) },
      env,
    );
    expect(up.status).toBe(200);
    const seg = (await up.json()) as { id: string };

    const sent: string[] = [];
    env.ports.sessions.get(s).attachSocket({ send: (d: string) => sent.push(d) }, 'browser');

    const res = await app.request(
      `/api/sessions/${s}/audio/segments/${seg.id}/waveform`,
      json('PUT', { peaks: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent.filter((d) => JSON.parse(d).type === 'audio.changed')).toHaveLength(1);
  });

  it('DELETE topic: missing id → 404, existing id → 204', async () => {
    const s = seededSession().sessionId;
    const miss = await app.request(
      `/api/sessions/${s}/topics/no-such-topic`,
      { method: 'DELETE' },
      env,
    );
    expect(miss.status).toBe(404);

    const created = await app.request(
      `/api/sessions/${s}/topics`,
      json('POST', { session_time: '00:00:01', duration_sec: 5, topic_level: 1, summary: 'x' }),
      env,
    );
    expect(created.status).toBe(201);
    const topic = (await created.json()) as { id: string };
    const hit = await app.request(
      `/api/sessions/${s}/topics/${topic.id}`,
      { method: 'DELETE' },
      env,
    );
    expect(hit.status).toBe(204);
  });

  it('DELETE transcript word: missing id → 404, existing id → 204', async () => {
    const s = seededSession().sessionId;
    const miss = await app.request(
      `/api/sessions/${s}/transcript-words/no-such-word`,
      { method: 'DELETE' },
      env,
    );
    expect(miss.status).toBe(404);

    const created = await app.request(
      `/api/sessions/${s}/transcript-words`,
      json('POST', { session_time: '00:00:01', speaker: 'A', word: 'hello' }),
      env,
    );
    expect(created.status).toBe(201);
    const word = (await created.json()) as { id: string };
    const hit = await app.request(
      `/api/sessions/${s}/transcript-words/${word.id}`,
      { method: 'DELETE' },
      env,
    );
    expect(hit.status).toBe(204);
  });
});
