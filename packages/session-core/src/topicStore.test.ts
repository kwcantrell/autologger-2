import { describe, expect, it } from 'vitest';
import { fakeRuntime } from './test/fakeCore';
import { TopicStore, topicRow } from './topicStore';

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
// (in-memory SQLite), written BEFORE the insert-ordinal seed and update
// patch-builder moved into the shared store helpers. These must pass
// unmodified across the extraction.
describe('TopicStore over a real core (D12 pins)', () => {
  function store(): TopicStore {
    return new TopicStore(fakeRuntime().core);
  }
  const data = (summary: string) => ({
    session_time: '00:00:01',
    duration_sec: 5,
    topic_level: 1,
    summary,
  });

  it('insertTopic seeds ordinals 0,1,2… and reuses MAX+1 after the top row is deleted', () => {
    const topics = store();
    const a = topics.insertTopic(data('a'));
    const b = topics.insertTopic(data('b'));
    const c = topics.insertTopic(data('c'));
    expect([a.ordinal, b.ordinal, c.ordinal]).toEqual([0, 1, 2]);
    // COALESCE(MAX(ordinal), -1) + 1: deleting the max frees its ordinal.
    topics.deleteTopic(c.id);
    expect(topics.insertTopic(data('d')).ordinal).toBe(2);
    // Deleting a NON-max row does not renumber; next insert continues past MAX.
    topics.deleteTopic(a.id);
    expect(topics.insertTopic(data('e')).ordinal).toBe(3);
  });

  it('updateTopic patches only the provided fields and returns the fresh row', () => {
    const topics = store();
    const t = topics.insertTopic(data('orig'));
    const updated = topics.updateTopic(t.id, { summary: 'edited', duration_sec: 9 });
    expect(updated).toEqual({ ...t, summary: 'edited', duration_sec: 9 });
  });

  it('updateTopic with an empty patch is a no-op returning the row; unknown id returns null', () => {
    const topics = store();
    const t = topics.insertTopic(data('orig'));
    expect(topics.updateTopic(t.id, {})).toEqual(t);
    expect(topics.updateTopic('nope', { summary: 'x' })).toBeNull();
  });
});
