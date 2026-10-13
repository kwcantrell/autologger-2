// Show wiki (show-wiki task 4.1, design D6; api-contract-freeze "Wiki …" requirements and the
// show-wiki "Wiki pages belong to one show" limits): the request bodies and queries for every wiki
// route, and the strict response bodies. The routes themselves are pinned by
// `server/src/routers/wiki.int`.

import { describe, expect, it } from 'vitest';
import {
  WIKI_DETAIL,
  wikiCreatePageBodySchema,
  wikiDeleteQuerySchema,
  wikiListQuerySchema,
  wikiMergeBodySchema,
  wikiMergedConflictSchema,
  wikiMergeResponseSchema,
  wikiPageIdConflictSchema,
  wikiPageListItemSchema,
  wikiPageListResponseSchema,
  wikiPageSchema,
  wikiRestoreBodySchema,
  wikiRevisionListResponseSchema,
  wikiRevisionSchema,
  wikiRevisionsQuerySchema,
  wikiSplitBodySchema,
  wikiSplitResponseSchema,
  wikiUpdatePageBodySchema,
  wikiVersionConflictSchema,
} from './schemas';

const page = {
  id: 'p1',
  show_id: 'sh1',
  kind: 'person',
  title: 'Christina Ramos',
  body_md: 'Host.',
  aliases: ['Christina', 'CR'],
  session_id: null,
  revision: 1,
  merged_into: null,
  deleted: false,
  created_at_utc: '2026-10-13T12:00:00.000Z',
  created_by_name: 'Kalen Cantrell',
  updated_at_utc: '2026-10-13T12:00:00.000Z',
  updated_by_name: '',
};

const listItem = {
  id: 'p1',
  kind: 'person',
  title: 'Christina Ramos',
  aliases: ['CR'],
  session_id: null,
  revision: 3,
  updated_at_utc: '2026-10-13T12:00:00.000Z',
  updated_by_name: 'Kalen Cantrell',
};

const revisionItem = {
  revision: 2,
  title: 'Christina Ramos',
  kind: 'person',
  author_name: 'Kalen Cantrell',
  at_utc: '2026-10-13T12:00:00.000Z',
  note: 'restored r1',
};

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success;

/** Every response must reject an extra key at the top level. */
function rejectsExtraKey(
  schema: { safeParse: (v: unknown) => { success: boolean } },
  v: Record<string, unknown>,
) {
  expect(ok(schema, v)).toBe(true);
  expect(ok(schema, { ...v, extra: 1 })).toBe(false);
}

const CONTROL = ['\u0000', '\n', '\r', '\t', '\u001f', '\u007f'];

describe('wiki response schemas', () => {
  it('takes the page object and rejects extra or missing keys', () => {
    rejectsExtraKey(wikiPageSchema, page);
    const { updated_by_name: _omit, ...missing } = page;
    expect(ok(wikiPageSchema, missing)).toBe(false);
  });

  it('takes a session page, a merged page and a deleted page', () => {
    expect(ok(wikiPageSchema, { ...page, kind: 'session', session_id: 'se1', aliases: [] })).toBe(
      true,
    );
    expect(ok(wikiPageSchema, { ...page, merged_into: 'p2' })).toBe(true);
    expect(ok(wikiPageSchema, { ...page, deleted: true })).toBe(true);
  });

  it('refuses an unknown kind, a non-integer revision and a missing nullable', () => {
    expect(ok(wikiPageSchema, { ...page, kind: 'place' })).toBe(false);
    expect(ok(wikiPageSchema, { ...page, revision: 1.5 })).toBe(false);
    expect(ok(wikiPageSchema, { ...page, revision: 0 })).toBe(false);
    const { session_id: _s, ...noSession } = page;
    expect(ok(wikiPageSchema, noSession)).toBe(false);
  });

  it('takes the list response with pages and truncated, each strict', () => {
    rejectsExtraKey(wikiPageListItemSchema, listItem);
    rejectsExtraKey(wikiPageListResponseSchema, { pages: [listItem], truncated: false });
    expect(ok(wikiPageListResponseSchema, { pages: [] })).toBe(false);
    expect(
      ok(wikiPageListResponseSchema, { pages: [{ ...listItem, body_md: '' }], truncated: true }),
    ).toBe(false);
    // A list item is not the full page object.
    expect(ok(wikiPageListItemSchema, page)).toBe(false);
  });

  it('takes the revisions list with next_before, a number or null', () => {
    rejectsExtraKey(wikiRevisionListResponseSchema, {
      revisions: [revisionItem],
      next_before: 71,
    });
    expect(ok(wikiRevisionListResponseSchema, { revisions: [], next_before: null })).toBe(true);
    expect(ok(wikiRevisionListResponseSchema, { revisions: [] })).toBe(false);
    expect(
      ok(wikiRevisionListResponseSchema, {
        revisions: [{ ...revisionItem, body_md: '' }],
        next_before: null,
      }),
    ).toBe(false);
  });

  it('takes a single revision with body_md and aliases', () => {
    rejectsExtraKey(wikiRevisionSchema, { ...revisionItem, body_md: 'Host.', aliases: ['CR'] });
    expect(ok(wikiRevisionSchema, revisionItem)).toBe(false);
    expect(ok(wikiRevisionSchema, { ...revisionItem, body_md: 'x' })).toBe(false);
  });

  it('takes the merge response {page} and the split response {page,new_page}', () => {
    rejectsExtraKey(wikiMergeResponseSchema, { page });
    expect(ok(wikiMergeResponseSchema, { page: { ...page, extra: 1 } })).toBe(false);
    rejectsExtraKey(wikiSplitResponseSchema, { page, new_page: { ...page, id: 'p2' } });
    expect(ok(wikiSplitResponseSchema, { page })).toBe(false);
  });

  it('takes the version conflict body with current', () => {
    rejectsExtraKey(wikiVersionConflictSchema, { detail: 'Version conflict.', current: page });
    expect(WIKI_DETAIL.versionConflict).toBe('Version conflict.');
    expect(ok(wikiVersionConflictSchema, { detail: 'Conflict.', current: page })).toBe(false);
    expect(ok(wikiVersionConflictSchema, { detail: 'Version conflict.' })).toBe(false);
  });

  it('takes the title-used and session-has-page bodies with page_id', () => {
    rejectsExtraKey(wikiPageIdConflictSchema, { detail: 'Title already used.', page_id: 'p2' });
    rejectsExtraKey(wikiPageIdConflictSchema, {
      detail: 'Session already has a page.',
      page_id: 'p2',
    });
    expect(WIKI_DETAIL.titleUsed).toBe('Title already used.');
    expect(WIKI_DETAIL.sessionHasPage).toBe('Session already has a page.');
    expect(ok(wikiPageIdConflictSchema, { detail: 'Title already used.' })).toBe(false);
    expect(ok(wikiPageIdConflictSchema, { detail: 'Page is deleted.', page_id: 'p2' })).toBe(false);
  });

  it('takes the merged body with merged_into', () => {
    rejectsExtraKey(wikiMergedConflictSchema, { detail: 'Page was merged.', merged_into: 'p2' });
    expect(WIKI_DETAIL.merged).toBe('Page was merged.');
    expect(ok(wikiMergedConflictSchema, { detail: 'Page was merged.' })).toBe(false);
  });

  it('names the other wiki details', () => {
    expect(WIKI_DETAIL).toMatchObject({
      showNotFound: 'Show not found.',
      pageNotFound: 'Page not found.',
      revisionNotFound: 'Revision not found.',
      deleted: 'Page is deleted.',
      notDeleted: 'Page is not deleted.',
    });
  });
});

const create = (over: Record<string, unknown>) =>
  wikiCreatePageBodySchema.safeParse({ kind: 'person', title: 'Christina Ramos', ...over });

describe('wikiCreatePageBodySchema', () => {
  it('trims the title and defaults body_md and aliases', () => {
    expect(wikiCreatePageBodySchema.parse({ kind: 'topic', title: '  Budget  ' })).toEqual({
      kind: 'topic',
      title: 'Budget',
      body_md: '',
      aliases: [],
    });
  });

  it('takes a title of 1 and 200 characters after trimming, and refuses 0 or 201', () => {
    expect(create({ title: 'a' }).success).toBe(true);
    expect(create({ title: ` ${'a'.repeat(200)} ` }).success).toBe(true);
    expect(create({ title: '' }).success).toBe(false);
    expect(create({ title: '   ' }).success).toBe(false);
    expect(create({ title: 'a'.repeat(201) }).success).toBe(false);
    expect(create({ title: undefined }).success).toBe(false);
  });

  it('refuses control characters in the title, at its ends too', () => {
    for (const c of CONTROL) {
      expect(create({ title: `Christina${c}Ramos` }).success, JSON.stringify(c)).toBe(false);
      expect(create({ title: `Christina${c}` }).success, JSON.stringify(c)).toBe(false);
    }
    expect(create({ title: 'Ramón – café' }).success).toBe(true);
  });

  it('takes a body up to 100000 characters, and refuses NUL', () => {
    expect(create({ body_md: 'a'.repeat(100_000) }).success).toBe(true);
    expect(create({ body_md: 'a'.repeat(100_001) }).success).toBe(false);
    expect(create({ body_md: 'line\nline\ttab' }).success).toBe(true);
    expect(create({ body_md: 'a\u0000b' }).success).toBe(false);
  });

  it('takes up to 50 aliases, each 1–200 characters after trimming, trimmed', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `a${i}`);
    expect(create({ aliases: fifty }).success).toBe(true);
    expect(create({ aliases: [...fifty, 'x'] }).success).toBe(false);
    expect(wikiCreatePageBodySchema.parse({ kind: 'bit', title: 't', aliases: [' CR '] })).toEqual({
      kind: 'bit',
      title: 't',
      body_md: '',
      aliases: ['CR'],
    });
    expect(create({ aliases: [` ${'a'.repeat(200)} `] }).success).toBe(true);
    expect(create({ aliases: ['a'.repeat(201)] }).success).toBe(false);
    expect(create({ aliases: [''] }).success).toBe(false);
    expect(create({ aliases: ['  '] }).success).toBe(false);
    expect(create({ aliases: 'CR' }).success).toBe(false);
  });

  it('refuses control characters in aliases', () => {
    for (const c of CONTROL) {
      expect(create({ aliases: [`C${c}R`] }).success, JSON.stringify(c)).toBe(false);
      expect(create({ aliases: [`CR${c}`] }).success, JSON.stringify(c)).toBe(false);
    }
  });

  it('takes the four kinds and refuses any other', () => {
    for (const kind of ['person', 'topic', 'bit']) expect(create({ kind }).success).toBe(true);
    expect(create({ kind: 'session', session_id: 'se1' }).success).toBe(true);
    expect(create({ kind: 'place' }).success).toBe(false);
    expect(create({ kind: undefined }).success).toBe(false);
  });

  it('requires session_id exactly when kind is session', () => {
    expect(
      wikiCreatePageBodySchema.parse({ kind: 'session', title: 'Ep 1', session_id: 'se1' }),
    ).toEqual({ kind: 'session', title: 'Ep 1', session_id: 'se1', body_md: '', aliases: [] });
    expect(create({ kind: 'session' }).success).toBe(false);
    expect(create({ kind: 'session', session_id: '' }).success).toBe(false);
    expect(create({ kind: 'session', session_id: null }).success).toBe(false);
    for (const kind of ['person', 'topic', 'bit']) {
      expect(create({ kind, session_id: 'se1' }).success, kind).toBe(false);
      expect(create({ kind, session_id: null }).success, kind).toBe(false);
    }
  });

  it('refuses aliases on a session page', () => {
    expect(create({ kind: 'session', session_id: 'se1', aliases: [] }).success).toBe(true);
    expect(create({ kind: 'session', session_id: 'se1', aliases: ['Ep'] }).success).toBe(false);
  });

  it('ignores unknown keys', () => {
    expect(wikiCreatePageBodySchema.parse({ kind: 'topic', title: 't', revision: 9 })).toEqual({
      kind: 'topic',
      title: 't',
      body_md: '',
      aliases: [],
    });
  });
});

const BAD_REVISIONS = [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1];

describe('wikiUpdatePageBodySchema', () => {
  it('needs only expected_revision, and leaves unsent fields absent', () => {
    expect(wikiUpdatePageBodySchema.parse({ expected_revision: 3 })).toEqual({
      expected_revision: 3,
    });
  });

  it('refuses an expected_revision that is not a positive integer', () => {
    expect(wikiUpdatePageBodySchema.safeParse({}).success).toBe(false);
    for (const n of BAD_REVISIONS) {
      expect(wikiUpdatePageBodySchema.safeParse({ expected_revision: n }).success, String(n)).toBe(
        false,
      );
    }
  });

  it('takes every editable field under the create limits', () => {
    expect(
      wikiUpdatePageBodySchema.parse({
        expected_revision: 4,
        title: ' New ',
        kind: 'bit',
        body_md: 'b',
        aliases: [' x '],
        restored_from: 2,
      }),
    ).toEqual({
      expected_revision: 4,
      title: 'New',
      kind: 'bit',
      body_md: 'b',
      aliases: ['x'],
      restored_from: 2,
    });
    const put = (over: Record<string, unknown>) =>
      wikiUpdatePageBodySchema.safeParse({ expected_revision: 1, ...over }).success;
    expect(put({ title: '' })).toBe(false);
    expect(put({ title: 'a\nb' })).toBe(false);
    expect(put({ title: 'a'.repeat(201) })).toBe(false);
    expect(put({ body_md: 'a'.repeat(100_001) })).toBe(false);
    expect(put({ body_md: '\u0000' })).toBe(false);
    expect(put({ aliases: Array.from({ length: 51 }, (_, i) => `a${i}`) })).toBe(false);
    expect(put({ aliases: ['a\tb'] })).toBe(false);
    expect(put({ kind: 'place' })).toBe(false);
    // A kind change to session is a rule the router checks (422), so the schema takes the kind.
    expect(put({ kind: 'session' })).toBe(true);
  });

  it('takes restored_from as a positive integer only', () => {
    for (const n of BAD_REVISIONS) {
      expect(
        wikiUpdatePageBodySchema.safeParse({ expected_revision: 3, restored_from: n }).success,
        String(n),
      ).toBe(false);
    }
  });
});

describe('wikiRestoreBodySchema and wikiDeleteQuerySchema', () => {
  it('takes the restore body', () => {
    expect(wikiRestoreBodySchema.parse({ expected_revision: 2 })).toEqual({
      expected_revision: 2,
    });
    for (const n of BAD_REVISIONS) {
      expect(wikiRestoreBodySchema.safeParse({ expected_revision: n }).success, String(n)).toBe(
        false,
      );
    }
    expect(wikiRestoreBodySchema.safeParse({}).success).toBe(false);
  });

  it('takes the DELETE expected_revision as a decimal positive integer, ignoring other params', () => {
    expect(wikiDeleteQuerySchema.parse({ expected_revision: '7', x: 'y' })).toEqual({
      expected_revision: 7,
    });
    expect(wikiDeleteQuerySchema.parse({ expected_revision: '9007199254740991' })).toEqual({
      expected_revision: Number.MAX_SAFE_INTEGER,
    });
    for (const raw of ['0', '-1', '1.5', '01', '1e1', '', ' 1', 'one', '9007199254740992']) {
      expect(wikiDeleteQuerySchema.safeParse({ expected_revision: raw }).success, raw).toBe(false);
    }
    expect(wikiDeleteQuerySchema.safeParse({}).success).toBe(false);
  });
});

describe('wikiMergeBodySchema', () => {
  it('takes the target id and both expected revisions', () => {
    const body = { into_page_id: 'p2', expected_revision: 2, into_expected_revision: 5 };
    expect(wikiMergeBodySchema.parse(body)).toEqual(body);
    expect(wikiMergeBodySchema.safeParse({ ...body, into_page_id: '' }).success).toBe(false);
    expect(wikiMergeBodySchema.safeParse({ ...body, into_page_id: undefined }).success).toBe(false);
    for (const n of BAD_REVISIONS) {
      expect(wikiMergeBodySchema.safeParse({ ...body, expected_revision: n }).success).toBe(false);
      expect(wikiMergeBodySchema.safeParse({ ...body, into_expected_revision: n }).success).toBe(
        false,
      );
    }
  });
});

describe('wikiSplitBodySchema', () => {
  const body = {
    expected_revision: 3,
    remaining_body_md: 'kept',
    new_page: { kind: 'bit', title: ' Running bit ', body_md: 'moved' },
  };

  it('takes the remaining body and the new page, defaulting its aliases', () => {
    expect(wikiSplitBodySchema.parse(body)).toEqual({
      ...body,
      new_page: { kind: 'bit', title: 'Running bit', body_md: 'moved', aliases: [] },
    });
  });

  it('applies the page limits to both halves', () => {
    const split = (over: Record<string, unknown>, np: Record<string, unknown> = {}) =>
      wikiSplitBodySchema.safeParse({ ...body, ...over, new_page: { ...body.new_page, ...np } })
        .success;
    expect(split({ remaining_body_md: 'a'.repeat(100_001) })).toBe(false);
    expect(split({ remaining_body_md: '\u0000' })).toBe(false);
    expect(split({ remaining_body_md: undefined })).toBe(false);
    expect(split({}, { title: '' })).toBe(false);
    expect(split({}, { title: 'a\u007f' })).toBe(false);
    expect(split({}, { body_md: undefined })).toBe(false);
    expect(split({}, { body_md: 'a'.repeat(100_001) })).toBe(false);
    expect(split({}, { aliases: ['a\nb'] })).toBe(false);
    for (const n of BAD_REVISIONS) expect(split({ expected_revision: n })).toBe(false);
  });

  it('refuses a session kind for the new page, and takes the other three', () => {
    const kinds = (kind: string) =>
      wikiSplitBodySchema.safeParse({ ...body, new_page: { ...body.new_page, kind } }).success;
    expect(kinds('session')).toBe(false);
    expect(kinds('place')).toBe(false);
    for (const k of ['person', 'topic', 'bit']) expect(kinds(k), k).toBe(true);
  });
});

describe('wikiListQuerySchema', () => {
  it('takes no parameters', () => {
    expect(wikiListQuerySchema.parse({})).toEqual({});
  });

  it('takes kind, session_id and deleted=1, and ignores unknown parameters', () => {
    expect(
      wikiListQuerySchema.parse({ kind: 'session', session_id: 'se1', deleted: '1', q: 'x' }),
    ).toEqual({ kind: 'session', session_id: 'se1', deleted: true });
  });

  it('refuses an unknown kind and any deleted value but 1', () => {
    expect(wikiListQuerySchema.safeParse({ kind: 'place' }).success).toBe(false);
    for (const raw of ['0', 'true', '', 'yes']) {
      expect(wikiListQuerySchema.safeParse({ deleted: raw }).success, raw).toBe(false);
    }
  });
});

describe('wikiRevisionsQuerySchema', () => {
  it('defaults limit to 50 with no cursor, and ignores unknown parameters', () => {
    expect(wikiRevisionsQuerySchema.parse({ x: 'y' })).toEqual({ limit: 50 });
  });

  it('takes limit as a decimal 1–100', () => {
    for (const [raw, n] of [
      ['1', 1],
      ['50', 50],
      ['100', 100],
    ] as const) {
      expect(wikiRevisionsQuerySchema.parse({ limit: raw }).limit).toBe(n);
    }
    for (const raw of ['0', '101', '-1', '1.5', '1e1', '05', ' 5', '', 'ten']) {
      expect(wikiRevisionsQuerySchema.safeParse({ limit: raw }).success, raw).toBe(false);
    }
  });

  it('takes before as a decimal positive integer', () => {
    expect(wikiRevisionsQuerySchema.parse({ limit: '50', before: '71' })).toEqual({
      limit: 50,
      before: 71,
    });
    for (const raw of ['0', '-1', '1.5', '01', '', 'x', '9007199254740992']) {
      expect(wikiRevisionsQuerySchema.safeParse({ before: raw }).success, raw).toBe(false);
    }
  });
});
