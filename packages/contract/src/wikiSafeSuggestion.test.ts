// The safe-suggestion rule of a batch accept (batch-autogenerate task 2.3, design D12; show-wiki "A
// batch job accepts suggestions as its initiator", owner decision 8a): a new page, or an
// additions-only rewrite (title unchanged after trim, every old alias kept exactly, the old body's
// lines an in-order, byte-exact subsequence of the new body's lines, CRLF read as LF).

import { describe, expect, it } from 'vitest';
import { isSafeSuggestion } from './wikiSafeSuggestion';

const page = { title: 'Café Noir', aliases: ['CN', 'The Café'], body_md: 'A\nB\nC' };
const rewrite = (over: Partial<{ title: string; aliases: string[]; body_md: string }>) => ({
  page_id: 'p1',
  title: page.title,
  aliases: page.aliases,
  body_md: page.body_md,
  ...over,
});

describe('isSafeSuggestion', () => {
  it('a new page is safe', () => {
    expect(
      isSafeSuggestion(null, { page_id: null, title: 'New', aliases: [], body_md: 'anything' }),
    ).toBe(true);
  });

  it('inserted lines anywhere are safe', () => {
    expect(isSafeSuggestion(page, rewrite({ body_md: 'A\nB\nnew\nC' }))).toBe(true);
    expect(isSafeSuggestion(page, rewrite({ body_md: 'new\nA\nB\nC\nend' }))).toBe(true);
    expect(isSafeSuggestion(page, rewrite({}))).toBe(true);
  });

  it('a changed, dropped or reordered line is unsafe', () => {
    expect(isSafeSuggestion(page, rewrite({ body_md: 'A\nB more\nC' }))).toBe(false);
    expect(isSafeSuggestion(page, rewrite({ body_md: 'A\nC' }))).toBe(false);
    expect(isSafeSuggestion(page, rewrite({ body_md: 'B\nA\nC' }))).toBe(false);
    // A trailing-space change on a line is a change.
    expect(isSafeSuggestion(page, rewrite({ body_md: 'A \nB\nC' }))).toBe(false);
  });

  it('compares CRLF bodies as LF', () => {
    expect(
      isSafeSuggestion({ ...page, body_md: 'A\r\nB\r\nC' }, rewrite({ body_md: 'A\nB\nx\nC' })),
    ).toBe(true);
    expect(isSafeSuggestion(page, rewrite({ body_md: 'A\r\nB\r\nnew\r\nC' }))).toBe(true);
  });

  it('a title changed beyond trimming is unsafe; trimming alone is not a change', () => {
    expect(isSafeSuggestion(page, rewrite({ title: 'Cafe Noir' }))).toBe(false);
    expect(isSafeSuggestion(page, rewrite({ title: '  Café Noir ' }))).toBe(true);
  });

  it('a dropped alias is unsafe; an added alias is safe', () => {
    expect(isSafeSuggestion(page, rewrite({ aliases: ['CN'] }))).toBe(false);
    expect(isSafeSuggestion(page, rewrite({ aliases: ['cn', 'The Café'] }))).toBe(false);
    expect(isSafeSuggestion(page, rewrite({ aliases: ['The Café', 'CN', 'Noir'] }))).toBe(true);
  });

  it('an empty old body takes any new body', () => {
    expect(isSafeSuggestion({ ...page, body_md: '' }, rewrite({ body_md: 'X\nY' }))).toBe(true);
    expect(isSafeSuggestion({ ...page, body_md: '' }, rewrite({ body_md: '' }))).toBe(true);
  });
});
