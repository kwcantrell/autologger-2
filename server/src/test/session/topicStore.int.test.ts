import { describe, expect, it } from 'vitest';
import { boundCore } from './boundCore';
import { topicRow } from '@autologger/session-core/topicStore';

describe('topicRow', () => {
  it('maps a full topic row', () => {
    const r = {
      id: 't1',
      session_time: '00:01:00',
      duration_sec: 30,
      topic_level: 2,
      summary: 'intro',
      ordinal: 1,
      created_at_utc: '2026-06-25T00:00:00.000Z',
    };
    expect(topicRow(r)).toEqual({
      id: 't1',
      session_time: '00:01:00',
      duration_sec: 30,
      topic_level: 2,
      summary: 'intro',
      ordinal: 1,
      created_at_utc: '2026-06-25T00:00:00.000Z',
    });
  });

  it('applies defaults for missing fields (topic_level defaults to 1)', () => {
    expect(topicRow({ id: 't2', ordinal: 0 })).toEqual({
      id: 't2',
      session_time: '',
      duration_sec: 0,
      topic_level: 1,
      summary: '',
      ordinal: 0,
      created_at_utc: '',
    });
  });
});

// code-health-tail task 2.4 (design D12) — behavior pins over a REAL core
// (in-memory SQLite then; Postgres since session-tables, through the bound-core
// harness), written BEFORE the insert-ordinal seed and update
// patch-builder moved into the shared store helpers. These must pass
// unmodified across the extraction.
describe('TopicStore over a real core (D12 pins)', () => {
  const data = (summary: string) => ({
    session_time: '00:00:01',
    duration_sec: 5,
    topic_level: 1,
    summary,
  });

  it('insertTopic seeds ordinals 0,1,2… and reuses MAX+1 after the top row is deleted', async () => {
    const { run } = await boundCore();
    const a = await run((s) => s.topics.insertTopic(data('a')));
    const b = await run((s) => s.topics.insertTopic(data('b')));
    const c = await run((s) => s.topics.insertTopic(data('c')));
    expect([a.ordinal, b.ordinal, c.ordinal]).toEqual([0, 1, 2]);
    // COALESCE(MAX(ordinal), -1) + 1: deleting the max frees its ordinal.
    await run((s) => s.topics.deleteTopic(c.id));
    expect((await run((s) => s.topics.insertTopic(data('d')))).ordinal).toBe(2);
    // Deleting a NON-max row does not renumber; next insert continues past MAX.
    await run((s) => s.topics.deleteTopic(a.id));
    expect((await run((s) => s.topics.insertTopic(data('e')))).ordinal).toBe(3);
  });

  it('updateTopic patches only the provided fields and returns the fresh row', async () => {
    const { run } = await boundCore();
    const t = await run((s) => s.topics.insertTopic(data('orig')));
    const updated = await run((s) =>
      s.topics.updateTopic(t.id, { summary: 'edited', duration_sec: 9 }),
    );
    expect(updated).toEqual({ ...t, summary: 'edited', duration_sec: 9 });
  });

  it('updateTopic with an empty patch is a no-op returning the row; unknown id returns null', async () => {
    const { run } = await boundCore();
    const t = await run((s) => s.topics.insertTopic(data('orig')));
    expect(await run((s) => s.topics.updateTopic(t.id, {}))).toEqual(t);
    expect(await run((s) => s.topics.updateTopic('nope', { summary: 'x' }))).toBeNull();
  });
});
