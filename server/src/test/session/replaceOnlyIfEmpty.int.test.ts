// batch-autogenerate task 3.2 (design D7 transcript): session-core's transcript replace with
// `onlyIfEmpty` re-counts the words inside its own transaction and, if any exist, throws the
// `TranscriptNotEmptyError` sentinel, which rolls the replace back.

import { TranscriptNotEmptyError, userCaller } from '@autologger/session-core';
import { describe, expect, it } from 'vitest';
import { defaultUser, env } from '../harness';
import { seededSession } from '../helpers';

const word = { word: 'gen', speaker: 'S', session_time: '', start_sec: 0, end_sec: 1 };

describe('replaceTranscriptWordsRemapped with onlyIfEmpty', () => {
  it('replaces an empty transcript', async () => {
    const { sessionId } = await seededSession();
    const userId = (await defaultUser()).id;
    const hub = (await env.ports.sessions.get(sessionId)).as(userCaller(userId));
    const out = await hub.replaceTranscriptWordsRemapped(
      () => ({ words: [word], enrichment: { paragraphs: [], sentiment: [] } }),
      {
        onlyIfEmpty: true,
      },
    );
    expect(out.map((w) => w.word)).toEqual(['gen']);
  });

  it('throws the sentinel and writes nothing when the transcript has words', async () => {
    const { sessionId } = await seededSession();
    const userId = (await defaultUser()).id;
    const hub = (await env.ports.sessions.get(sessionId)).as(userCaller(userId));
    await hub.insertTranscriptWord({ session_time: '', speaker: 'P', word: 'typed' });
    await expect(
      hub.replaceTranscriptWordsRemapped(
        () => ({ words: [word], enrichment: { paragraphs: [], sentiment: [] } }),
        { onlyIfEmpty: true },
      ),
    ).rejects.toBeInstanceOf(TranscriptNotEmptyError);
    expect((await hub.listTranscriptWords()).map((w) => w.word)).toEqual(['typed']);
    // Without the option the replace still replaces.
    await hub.replaceTranscriptWordsRemapped(() => ({
      words: [word],
      enrichment: { paragraphs: [], sentiment: [] },
    }));
    expect((await hub.listTranscriptWords()).map((w) => w.word)).toEqual(['gen']);
  });
});
