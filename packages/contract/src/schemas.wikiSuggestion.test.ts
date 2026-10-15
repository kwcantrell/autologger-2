// AI wiki suggestions (show-wiki-ai task 4.1, design D4/D5; api-contract-freeze "Wiki suggestion
// object", "Wiki update endpoint", "Wiki suggestion list, read, accept and dismiss endpoints";
// wiki-generation "Proposals are checked when they are made"): the strict response bodies, the
// list query and accept body, and `wikiProposalSchema`, the shape check of `propose_page`.

import { describe, expect, it } from 'vitest';
import {
  WIKI_ALIASES_MAX,
  WIKI_BODY_MAX,
  WIKI_PROPOSAL_BODY_MAX,
  WIKI_RATIONALE_MAX,
  WIKI_SUGGESTION_DETAIL,
  wikiGenerateResponseSchema,
  wikiProposalSchema,
  wikiSuggestionAcceptResponseSchema,
  wikiSuggestionAcceptSchema,
  wikiSuggestionDetailSchema,
  wikiSuggestionListQuerySchema,
  wikiSuggestionListSchema,
  wikiSuggestionResolvedConflictSchema,
  wikiSuggestionSchema,
} from './schemas';

const suggestion = {
  id: 'sg1',
  show_id: 'sh1',
  session_id: 'S1',
  status: 'pending',
  page_id: 'p1',
  base_revision: 3,
  kind: 'person',
  title: 'Christina Ramos',
  aliases: ['CR'],
  rationale: 'Adds the S1 interview.',
  page: { title: 'Christina Ramos', revision: 4, state: 'live' },
  stale: true,
  created_at_utc: '2026-10-13T12:00:00.000Z',
  created_by_name: 'Kalen Cantrell',
  resolved_at_utc: null,
  resolved_by_name: null,
  resolved_revision: null,
};

const newPageSuggestion = {
  ...suggestion,
  id: 'sg2',
  page_id: null,
  base_revision: null,
  page: null,
  stale: false,
};

const page = {
  id: 'p1',
  show_id: 'sh1',
  kind: 'person',
  title: 'Christina Ramos',
  body_md: 'Host.',
  aliases: ['CR'],
  session_id: null,
  revision: 5,
  merged_into: null,
  deleted: false,
  created_at_utc: '2026-10-13T12:00:00.000Z',
  created_by_name: 'Kalen Cantrell',
  updated_at_utc: '2026-10-13T12:00:00.000Z',
  updated_by_name: 'Kalen Cantrell',
};

const proposal = {
  title: 'Christina Ramos',
  kind: 'person',
  aliases: ['CR'],
  body_md: 'Host of the show.',
  rationale: 'New person from S1.',
};

describe('suggestion responses are strict', () => {
  it('the suggestion object parses, for a page target and a new page', () => {
    expect(wikiSuggestionSchema.parse(suggestion)).toEqual(suggestion);
    expect(wikiSuggestionSchema.parse(newPageSuggestion)).toEqual(newPageSuggestion);
    for (const status of ['accepted', 'dismissed', 'superseded']) {
      expect(wikiSuggestionSchema.safeParse({ ...suggestion, status }).success).toBe(true);
    }
    expect(
      wikiSuggestionSchema.safeParse({
        ...suggestion,
        status: 'accepted',
        resolved_at_utc: '2026-10-13T13:00:00.000Z',
        resolved_by_name: 'Kalen Cantrell',
        resolved_revision: 5,
      }).success,
    ).toBe(true);
  });

  it('an extra or missing key, an unknown status, kind or page state is refused', () => {
    expect(wikiSuggestionSchema.safeParse({ ...suggestion, body_md: 'x' }).success).toBe(false);
    const { stale: _stale, ...missing } = suggestion;
    expect(wikiSuggestionSchema.safeParse(missing).success).toBe(false);
    expect(wikiSuggestionSchema.safeParse({ ...suggestion, status: 'open' }).success).toBe(false);
    expect(wikiSuggestionSchema.safeParse({ ...suggestion, kind: 'place' }).success).toBe(false);
    expect(
      wikiSuggestionSchema.safeParse({ ...suggestion, page: { ...suggestion.page, state: 'gone' } })
        .success,
    ).toBe(false);
    expect(
      wikiSuggestionSchema.safeParse({ ...suggestion, page: { ...suggestion.page, extra: 1 } })
        .success,
    ).toBe(false);
  });

  it('the detail object is the suggestion plus body_md', () => {
    const detail = { ...suggestion, body_md: 'Host of the show.' };
    expect(wikiSuggestionDetailSchema.parse(detail)).toEqual(detail);
    expect(wikiSuggestionDetailSchema.safeParse(suggestion).success).toBe(false);
    expect(wikiSuggestionDetailSchema.safeParse({ ...detail, extra: 1 }).success).toBe(false);
  });

  it('the list, generate, accept and resolved-conflict bodies are strict', () => {
    const list = { suggestions: [suggestion, newPageSuggestion], truncated: false };
    expect(wikiSuggestionListSchema.parse(list)).toEqual(list);
    expect(wikiSuggestionListSchema.safeParse({ suggestions: [] }).success).toBe(false);
    expect(wikiSuggestionListSchema.safeParse({ ...list, extra: 1 }).success).toBe(false);

    expect(wikiGenerateResponseSchema.parse({ suggestions: [] })).toEqual({ suggestions: [] });
    expect(
      wikiGenerateResponseSchema.safeParse({ suggestions: [], truncated: false }).success,
    ).toBe(false);

    const accepted = { page, suggestion: { ...suggestion, status: 'accepted' } };
    expect(wikiSuggestionAcceptResponseSchema.parse(accepted)).toEqual(accepted);
    expect(wikiSuggestionAcceptResponseSchema.safeParse({ page }).success).toBe(false);
    expect(
      wikiSuggestionAcceptResponseSchema.safeParse({ ...accepted, created: true }).success,
    ).toBe(false);

    const resolved = { detail: 'Suggestion already resolved.', status: 'accepted' };
    expect(wikiSuggestionResolvedConflictSchema.parse(resolved)).toEqual(resolved);
    expect(
      wikiSuggestionResolvedConflictSchema.safeParse({ ...resolved, status: 'pending2' }).success,
    ).toBe(false);
    expect(
      wikiSuggestionResolvedConflictSchema.safeParse({ ...resolved, detail: 'Nope.' }).success,
    ).toBe(false);
  });

  it('the fixed details', () => {
    expect(WIKI_SUGGESTION_DETAIL).toEqual({
      suggestionNotFound: 'Suggestion not found.',
      resolved: 'Suggestion already resolved.',
      expectedRevisionRequired: 'expected_revision is required.',
      noLanguageModel: 'Add a language model in Settings → Advanced to update the wiki.',
      noTranscript: 'This session has no transcript words to update the wiki from.',
      busy:
        'A turn (AI chat, AI v2, topic generation, event generation, or wiki update) is already ' +
        'in progress for this session; wait for it to finish before updating the wiki again. ' +
        'These features share one per-session AI slot by design.',
      failed: 'Wiki update failed.',
    });
  });
});

describe('list query', () => {
  it('status defaults to pending; page_id is optional; unknown parameters are ignored', () => {
    expect(wikiSuggestionListQuerySchema.parse({})).toEqual({ status: 'pending' });
    expect(wikiSuggestionListQuerySchema.parse({ status: 'superseded', page_id: 'p1' })).toEqual({
      status: 'superseded',
      page_id: 'p1',
    });
    expect(wikiSuggestionListQuerySchema.parse({ other: 'x' })).toEqual({ status: 'pending' });
    expect(wikiSuggestionListQuerySchema.safeParse({ status: 'open' }).success).toBe(false);
  });
});

describe('accept body', () => {
  it('every field is optional; unknown keys, including kind, are stripped', () => {
    expect(wikiSuggestionAcceptSchema.parse({})).toEqual({});
    expect(wikiSuggestionAcceptSchema.parse({ expected_revision: 4, kind: 'topic' })).toEqual({
      expected_revision: 4,
    });
    expect(
      wikiSuggestionAcceptSchema.parse({
        expected_revision: 4,
        title: '  Christina  ',
        body_md: 'x',
        aliases: [' CR '],
      }),
    ).toEqual({ expected_revision: 4, title: 'Christina', body_md: 'x', aliases: ['CR'] });
  });

  it('expected_revision is a positive integer', () => {
    for (const bad of [0, -1, 1.5, '4', Number.MAX_SAFE_INTEGER + 1]) {
      expect(wikiSuggestionAcceptSchema.safeParse({ expected_revision: bad }).success).toBe(false);
    }
    expect(wikiSuggestionAcceptSchema.safeParse({ expected_revision: 1 }).success).toBe(true);
  });

  it('the overrides have the wiki page limits', () => {
    const ok = (b: unknown) => wikiSuggestionAcceptSchema.safeParse(b).success;
    expect(ok({ title: 'x'.repeat(200) })).toBe(true);
    expect(ok({ title: 'x'.repeat(201) })).toBe(false);
    expect(ok({ title: '   ' })).toBe(false);
    expect(ok({ title: 'a\nb' })).toBe(false);
    expect(ok({ body_md: 'x'.repeat(WIKI_BODY_MAX) })).toBe(true);
    expect(ok({ body_md: 'x'.repeat(WIKI_BODY_MAX + 1) })).toBe(false);
    expect(ok({ body_md: 'a\u0000b' })).toBe(false);
    expect(ok({ aliases: Array.from({ length: WIKI_ALIASES_MAX + 1 }, (_, i) => `a${i}`) })).toBe(
      false,
    );
    expect(ok({ aliases: ['x'.repeat(201)] })).toBe(false);
  });
});

describe('wikiProposalSchema (propose_page shape)', () => {
  const ok = (over: Record<string, unknown>) =>
    wikiProposalSchema.safeParse({ ...proposal, ...over }).success;

  it('a proposal parses, trimming the title and aliases; page_id and kind are optional', () => {
    expect(wikiProposalSchema.parse({ ...proposal, title: ' Christina Ramos ' })).toEqual(proposal);
    expect(ok({ kind: undefined, page_id: 'p1' })).toBe(true);
    expect(wikiProposalSchema.parse({ ...proposal, aliases: undefined }).aliases).toEqual([]);
  });

  it('title: 1–200 characters after trimming, a single line with no control characters', () => {
    expect(ok({ title: 'x'.repeat(200) })).toBe(true);
    expect(ok({ title: 'x'.repeat(201) })).toBe(false);
    expect(ok({ title: '' })).toBe(false);
    expect(ok({ title: '  ' })).toBe(false);
    expect(ok({ title: 'a\nb' })).toBe(false);
    expect(ok({ title: 'trailing\n' })).toBe(false);
    expect(ok({ title: 'a\tb' })).toBe(false);
    expect(ok({ title: 'a\u007fb' })).toBe(false);
    expect(ok({ title: 'a\u0000b' })).toBe(false);
  });

  it('aliases: at most 50, each 1–200 characters with no control characters', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `alias ${i}`);
    expect(ok({ aliases: many(WIKI_ALIASES_MAX) })).toBe(true);
    expect(ok({ aliases: many(WIKI_ALIASES_MAX + 1) })).toBe(false);
    expect(ok({ aliases: ['x'.repeat(200)] })).toBe(true);
    expect(ok({ aliases: ['x'.repeat(201)] })).toBe(false);
    expect(ok({ aliases: [' '] })).toBe(false);
    expect(ok({ aliases: ['a\nb'] })).toBe(false);
    expect(ok({ aliases: ['a\u0000'] })).toBe(false);
  });

  it('a session page has no aliases', () => {
    expect(ok({ kind: 'session', aliases: [] })).toBe(true);
    expect(ok({ kind: 'session', aliases: ['S1'] })).toBe(false);
  });

  it('body: at most 30,000 characters, no NUL', () => {
    expect(WIKI_PROPOSAL_BODY_MAX).toBe(30_000);
    expect(ok({ body_md: '' })).toBe(true);
    expect(ok({ body_md: 'x'.repeat(WIKI_PROPOSAL_BODY_MAX) })).toBe(true);
    expect(ok({ body_md: 'x'.repeat(WIKI_PROPOSAL_BODY_MAX + 1) })).toBe(false);
    expect(ok({ body_md: 'a\u0000b' })).toBe(false);
    expect(ok({ body_md: undefined })).toBe(false);
  });

  it('rationale: 1–500 characters', () => {
    expect(WIKI_RATIONALE_MAX).toBe(500);
    expect(ok({ rationale: 'x' })).toBe(true);
    expect(ok({ rationale: 'x'.repeat(500) })).toBe(true);
    expect(ok({ rationale: 'x'.repeat(501) })).toBe(false);
    expect(ok({ rationale: '' })).toBe(false);
    expect(ok({ rationale: '   ' })).toBe(false);
    expect(ok({ rationale: undefined })).toBe(false);
  });

  it('an unknown kind and an empty page_id are refused', () => {
    expect(ok({ kind: 'place' })).toBe(false);
    expect(ok({ page_id: '' })).toBe(false);
  });
});
