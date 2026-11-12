// batch-autogenerate task 3.2 (design D6, D7 transcript, D9, D17): `runTranscript`, the transcript
// step shared by `POST …/transcript-words/generate` and the batch worker, returns a typed outcome
// for each refusal and result; with `onlyIfEmpty`, a transcript that gained words while the
// provider ran is discarded (`present`) and the words stay. Integration (real hub and Postgres):
// the replace sentinel runs inside the hub transaction.

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TRANSCRIPTION_FIXTURES_DIR, TranscriptGenerateError } from '@autologger/transcription';
import { transcriptGenerationLock } from '@autologger/transcription/transcriptGenerationLock';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { principalFor } from '../test/generationPrincipal';
import { app, env, envWith, testDirs } from '../test/harness';
import { catalogFor, NOT_APPROVED_EMAIL, seededSession, seedUser } from '../test/helpers';
import { hubFor } from './principal';
import { runTranscript, transcriptOutcomeOf } from './transcript';

const SEG1 = join(TRANSCRIPTION_FIXTURES_DIR, 'audio', 'seg1.webm');
const CORRUPT = join(TRANSCRIPTION_FIXTURES_DIR, 'audio', 'seg-corrupt.bin');
const configured = () =>
  envWith({ DEEPGRAM_API_KEY: 'test-deepgram-key', DEEPGRAM_MODEL: 'nova-3' });

function deepgram(words: unknown[], status = 200) {
  const fetchMock = vi.fn(async () =>
    status === 200
      ? new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ words }] }] } }), {
          status,
        })
      : new Response('{"err":"x"}', { status }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function upload(sessionId: string, file: string): Promise<void> {
  const res = await app.request(
    `/api/sessions/${sessionId}/events`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'internal', message: 'Recording 1 Started', metadata: {} }),
    },
    { ...env },
  );
  expect(res.status).toBe(200);
  const up = await app.request(
    `/api/sessions/${sessionId}/audio/segments?recording_ordinal=1`,
    { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: readFileSync(file) },
    { ...env },
  );
  expect(up.status).toBe(200);
}

/** A session of the default user's team, with an admin principal of that team. */
async function setup(opts: { audio?: string; email?: string } = {}) {
  const { sessionId, studioId } = await seededSession();
  if (opts.audio) await upload(sessionId, opts.audio);
  const uid = await seedUser({ email: opts.email });
  await catalogFor().auth.authAddMembershipWithRole(uid, studioId, 'admin');
  return { sessionId, uid };
}

async function run(
  sessionId: string,
  uid: string,
  opts: { onlyIfEmpty?: boolean } = {},
  e = configured(),
) {
  const p = await principalFor(uid, e);
  const row = await p.catalog.sessions.getSessionIndexRow(sessionId);
  if (!row) throw new Error('no session row');
  return runTranscript(p, sessionId, { row, ...opts });
}

describe('runTranscript (design D6)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    transcriptGenerationLock.reset();
  });

  it('unconfigured: no speech-to-text credential, no provider call', async () => {
    const { sessionId, uid } = await setup({ audio: SEG1 });
    const f = deepgram([]);
    expect(await run(sessionId, uid, {}, envWith({ DEEPGRAM_API_KEY: '' }))).toEqual({
      kind: 'unconfigured',
    });
    expect(f).not.toHaveBeenCalled();
  });

  it('forbidden: not an approved user', async () => {
    const { sessionId, uid } = await setup({ audio: SEG1, email: NOT_APPROVED_EMAIL });
    expect(await run(sessionId, uid)).toEqual({ kind: 'forbidden' });
  });

  it('busy: the session run is held', async () => {
    const { sessionId, uid } = await setup({ audio: SEG1 });
    expect(transcriptGenerationLock.tryAcquire(sessionId)).toBe(true);
    const out = await run(sessionId, uid);
    expect(out.kind).toBe('busy');
  });

  it('no audio, no speech, upstream, rate-limited, missing file and unreadable', async () => {
    const a = await setup();
    expect(await run(a.sessionId, a.uid)).toMatchObject({ kind: 'error', code: 'no_audio' });

    const b = await setup({ audio: SEG1 });
    deepgram([]);
    expect(await run(b.sessionId, b.uid)).toMatchObject({ kind: 'error', code: 'no_speech' });

    deepgram([], 500);
    expect(await run(b.sessionId, b.uid)).toMatchObject({ kind: 'error', code: 'upstream' });

    deepgram([], 429);
    expect(await run(b.sessionId, b.uid)).toMatchObject({ kind: 'error', code: 'rate-limited' });

    const c = await setup({ audio: CORRUPT });
    expect(await run(c.sessionId, c.uid)).toMatchObject({ kind: 'error', code: 'unreadable' });

    const d = await setup({ audio: SEG1 });
    const [seg] = await (await hubFor(await principalFor(d.uid), d.sessionId)).listAudioSegments();
    rmSync(join(testDirs().blobDir, String(seg?.r2_key)), { force: true });
    expect(await run(d.sessionId, d.uid)).toMatchObject({ kind: 'error', code: 'missing_blob' });
  });

  it('maps an oversize group (and every generation error code) to its outcome', () => {
    expect(transcriptOutcomeOf(new TranscriptGenerateError('oversize', 'big'))).toEqual({
      kind: 'error',
      code: 'oversize',
      detail: 'big',
    });
    expect(
      transcriptOutcomeOf(
        Object.assign(new TranscriptGenerateError('upstream', 'x'), { upstreamStatus: 429 }),
      ),
    ).toMatchObject({ kind: 'error', code: 'rate-limited' });
  });

  it('ok: the words are written', async () => {
    const { sessionId, uid } = await setup({ audio: SEG1 });
    deepgram([{ word: 'hi', start: 0.5, end: 0.9, speaker: 0 }]);
    const out = await run(sessionId, uid, { onlyIfEmpty: true });
    expect(out.kind).toBe('ok');
    expect(out.kind === 'ok' && out.words.map((w) => w.word)).toEqual(['hi']);
  });

  it('onlyIfEmpty: a word added while the provider runs makes it present; the replace rolls back', async () => {
    const { sessionId, uid } = await setup({ audio: SEG1 });
    const p = await principalFor(uid);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await (await hubFor(p, sessionId)).insertTranscriptWord({
          session_time: '',
          speaker: 'P',
          word: 'typed',
        });
        return new Response(
          JSON.stringify({
            results: {
              channels: [
                { alternatives: [{ words: [{ word: 'gen', start: 0, end: 1, speaker: 0 }] }] },
              ],
            },
          }),
          { status: 200 },
        );
      }),
    );
    expect(await run(sessionId, uid, { onlyIfEmpty: true })).toEqual({ kind: 'present' });
    const words = await (await hubFor(p, sessionId)).listTranscriptWords();
    expect(words.map((w) => w.word)).toEqual(['typed']);
    // The run and its lease are free afterwards.
    expect(transcriptGenerationLock.startedAt(sessionId)).toBeNull();
  });
});
