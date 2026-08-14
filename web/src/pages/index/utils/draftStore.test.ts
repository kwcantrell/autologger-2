import { describe, expect, it } from 'vitest';
import { createDraftStore, presentFields, retainDivergentFields } from './draftStore';

// --- The one rule the two virtualized feeds share (review finding 1) ---
//
// `clearMatching` decides WHEN a draft field stops being live, and both feeds
// go through it so they cannot drift apart on it. The colocated feed suites
// only ever exercised it one field at a time, which is exactly why a
// multi-field draft cleared by a ONE-field save went unnoticed: the reference
// answered both "what text is spent" and (implicitly, through its keys) "which
// fields this clear speaks for", and a caller that built the reference from the
// whole stored draft got the second answer silently wrong. The covered set is
// now stated separately, so these are the cases that pin it.

interface Draft {
  a?: string;
  b?: string;
  c?: string;
}

const FIELDS = ['a', 'b', 'c'] as const satisfies ReadonlyArray<keyof Draft>;

describe('retainDivergentFields', () => {
  it('drops a covered field whose text still matches the reference', () => {
    expect(retainDivergentFields<Draft>({ a: 'x' }, { a: 'x' }, FIELDS)).toBeUndefined();
  });

  it('keeps a covered field whose text has moved on', () => {
    expect(retainDivergentFields<Draft>({ a: 'typed more' }, { a: 'x' }, FIELDS)).toEqual({
      a: 'typed more',
    });
  });

  it('keeps a field the clear does NOT cover, even when it matches the reference', () => {
    // The single-field save at the heart of finding 1: `b` was never persisted,
    // so nothing about the save says its draft is spent — matching text or not.
    expect(retainDivergentFields<Draft>({ a: 'x', b: 'x' }, { a: 'x', b: 'x' }, ['a'])).toEqual({
      b: 'x',
    });
  });

  it('covers only the named fields when several are spent at once', () => {
    const current: Draft = { a: 'x', b: 'y', c: 'still typing' };
    expect(retainDivergentFields<Draft>(current, { a: 'x', b: 'y', c: 'z' }, FIELDS)).toEqual({
      c: 'still typing',
    });
  });

  it('has nothing to retain for a row with no draft', () => {
    expect(retainDivergentFields<Draft>(undefined, { a: 'x' }, FIELDS)).toBeUndefined();
  });
});

describe('presentFields', () => {
  it('names exactly the fields a patch carries', () => {
    expect(presentFields<Draft>({ b: 'y' }, FIELDS)).toEqual(['b']);
    expect(presentFields<Draft>({ a: '', c: 'z' }, FIELDS)).toEqual(['a', 'c']);
  });

  it('counts an empty string as a real edited value', () => {
    // A cleared control is a value, not an absence — clearing a field then
    // saving it must still spend its draft.
    expect(presentFields<Draft>({ a: '' }, FIELDS)).toEqual(['a']);
  });
});

describe('createDraftStore', () => {
  it('merges writes and forgets only what a clear covers', () => {
    const store = createDraftStore<Draft>();
    store.write('row-1', { a: 'typed a' });
    store.write('row-1', { b: 'typed b' });
    expect(store.read('row-1')).toEqual({ a: 'typed a', b: 'typed b' });

    // A save that persisted `a` alone.
    store.clearMatching('row-1', { a: 'typed a' }, ['a']);
    expect(store.read('row-1')).toEqual({ b: 'typed b' });

    store.clearMatching('row-1', { b: 'typed b' }, ['b']);
    expect(store.read('row-1')).toBeUndefined();
  });

  it('keeps rows independent, and clearAll forgets every one', () => {
    const store = createDraftStore<Draft>();
    store.write('row-1', { a: '1' });
    store.write('row-2', { a: '2' });
    store.clear('row-1');
    expect(store.read('row-1')).toBeUndefined();
    expect(store.read('row-2')).toEqual({ a: '2' });
    store.clearAll();
    expect(store.read('row-2')).toBeUndefined();
  });
});
