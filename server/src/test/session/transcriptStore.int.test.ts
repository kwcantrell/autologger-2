import { describe, expect, it } from 'vitest';
import { boundCore } from './boundCore';

// code-health-tail task 2.4 (design D12) — behavior pins over a REAL core
// (in-memory SQLite then; Postgres since session-tables, through the bound-core
// harness), written BEFORE the insert-ordinal seed and update
// patch-builder moved into the shared store helpers. These must pass
// unmodified across the extraction.
describe('TranscriptStore over a real core (D12 pins)', () => {
  const data = (word: string) => ({ session_time: '00:00:01', speaker: 'A', word });

  it('insertTranscriptWord seeds ordinals 0,1,2… and reuses MAX+1 after the top row is deleted', async () => {
    const { run } = await boundCore();
    const a = await run((s) => s.transcript.insertTranscriptWord(data('a')));
    const b = await run((s) => s.transcript.insertTranscriptWord(data('b')));
    const c = await run((s) => s.transcript.insertTranscriptWord(data('c')));
    expect([a.ordinal, b.ordinal, c.ordinal]).toEqual([0, 1, 2]);
    // COALESCE(MAX(ordinal), -1) + 1: deleting the max frees its ordinal.
    await run((s) => s.transcript.deleteTranscriptWord(c.id));
    expect((await run((s) => s.transcript.insertTranscriptWord(data('d')))).ordinal).toBe(2);
  });

  it('updateTranscriptWord patches only the provided fields and returns the fresh row', async () => {
    const { run } = await boundCore();
    const w = await run((s) => s.transcript.insertTranscriptWord(data('orig')));
    const updated = await run((s) =>
      s.transcript.updateTranscriptWord(w.id, { word: 'edited', speaker: 'B' }),
    );
    // session-row-versions D3: the update advances the version.
    expect(updated).toEqual({ ...w, word: 'edited', speaker: 'B', version: w.version + 1 });
  });

  it('updateTranscriptWord with an empty patch is a no-op returning the row; unknown id returns null', async () => {
    const { run } = await boundCore();
    const w = await run((s) => s.transcript.insertTranscriptWord(data('orig')));
    expect(await run((s) => s.transcript.updateTranscriptWord(w.id, {}))).toEqual(w);
    expect(await run((s) => s.transcript.updateTranscriptWord('nope', { word: 'x' }))).toBeNull();
  });
});
