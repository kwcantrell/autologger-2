// Show wiki routes (show-wiki design D3, D6; api-contract-freeze "Wiki page object", "Wiki page
// list and create endpoints", "Wiki page read, edit, delete and restore endpoints", "Wiki revision
// endpoints", "Wiki merge and split endpoints").
//
// - List and create are show-scoped (`/api/shows/:showId/wiki/pages`): `requireShowAccess` gives
//   the masked `404 Show not found.`.
// - Everything else is page-scoped (`/api/wiki/pages/:pageId`): the page is loaded as the user
//   first, and under the wiki policies a page in a show the user can't access reads as missing,
//   so a missing and an inaccessible page both answer `404 Page not found.`. The access check runs
//   before the body or query is parsed, as the session routes do.
// - Every store call runs under the caller's binding (`c.get('catalog').wiki`); the store's errors
//   map to the delta's 409 and 422 bodies in `wikiError`. Zod failures are the app's
//   `422 {"detail": [issues]}`.
// - No route sets a cookie.

import {
  WikiConflictError,
  WikiDeletedError,
  WikiInvalidError,
  WikiMergedError,
  WikiNotDeletedError,
  type WikiPage,
  WikiSessionTakenError,
  WikiTitleTakenError,
} from '@autologger/catalog';
import {
  WIKI_DETAIL,
  wikiCreatePageBodySchema,
  wikiDeleteQuerySchema,
  wikiListQuerySchema,
  wikiMergeBodySchema,
  wikiRestoreBodySchema,
  wikiRevisionsQuerySchema,
  wikiSplitBodySchema,
  wikiUpdatePageBodySchema,
} from '@autologger/contract';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { AppEnv } from '../appEnv';
import { ApiError } from '../httpError';
import { requireShowAccess, requireUser } from './_helpers';

export const wikiRouter = new Hono<AppEnv>();

/** A decimal revision number in a path, as the query parameters spell one. */
const REVISION_PATH_RE = /^[1-9][0-9]{0,15}$/;

/** The page as the signed-in user sees it, or the masked `404 Page not found.`. */
async function requirePage(c: Context<AppEnv>, pageId: string): Promise<WikiPage> {
  requireUser(c);
  const page = await c.get('catalog').wiki.getPage(pageId);
  if (page === null) throw new ApiError(404, WIKI_DETAIL.pageNotFound);
  return page;
}

/** A store answer of `null`: the page (or merge target) vanished or is not accessible. */
function found<T>(v: T | null): T {
  if (v === null) throw new ApiError(404, WIKI_DETAIL.pageNotFound);
  return v;
}

/** The delta's 409 and 422 bodies for the wiki store's errors; anything else is rethrown. */
function wikiError(c: Context<AppEnv>, error: unknown): Response {
  if (error instanceof WikiConflictError) {
    return c.json({ detail: WIKI_DETAIL.versionConflict, current: error.current }, 409);
  }
  if (error instanceof WikiMergedError) {
    return c.json({ detail: WIKI_DETAIL.merged, merged_into: error.mergedInto }, 409);
  }
  if (error instanceof WikiDeletedError) return c.json({ detail: WIKI_DETAIL.deleted }, 409);
  if (error instanceof WikiNotDeletedError) return c.json({ detail: WIKI_DETAIL.notDeleted }, 409);
  if (error instanceof WikiTitleTakenError) {
    return c.json({ detail: WIKI_DETAIL.titleUsed, page_id: error.pageId }, 409);
  }
  if (error instanceof WikiSessionTakenError) {
    return c.json({ detail: WIKI_DETAIL.sessionHasPage, page_id: error.pageId }, 409);
  }
  if (error instanceof WikiInvalidError) return c.json({ detail: error.message }, 422);
  throw error;
}

wikiRouter.get('/api/shows/:showId/wiki/pages', async (c) => {
  const showId = c.req.param('showId');
  await requireShowAccess(c, showId, WIKI_DETAIL.showNotFound);
  const query = wikiListQuerySchema.parse(c.req.query());
  const result = await c.get('catalog').wiki.listPages(showId, {
    kind: query.kind,
    sessionId: query.session_id,
    deleted: query.deleted === true,
  });
  return c.json(result);
});

wikiRouter.post('/api/shows/:showId/wiki/pages', async (c) => {
  const showId = c.req.param('showId');
  await requireShowAccess(c, showId, WIKI_DETAIL.showNotFound);
  const body = wikiCreatePageBodySchema.parse(await c.req.json());
  try {
    const page = await c.get('catalog').wiki.createPage(showId, {
      kind: body.kind,
      title: body.title,
      bodyMd: body.body_md,
      aliases: body.aliases,
      sessionId: body.session_id ?? null,
    });
    return c.json(page, 201);
  } catch (error) {
    return wikiError(c, error);
  }
});

wikiRouter.get('/api/wiki/pages/:pageId', async (c) => {
  return c.json(await requirePage(c, c.req.param('pageId')));
});

wikiRouter.put('/api/wiki/pages/:pageId', async (c) => {
  const pageId = c.req.param('pageId');
  await requirePage(c, pageId);
  const body = wikiUpdatePageBodySchema.parse(await c.req.json());
  try {
    const page = await c.get('catalog').wiki.updatePage(pageId, {
      expectedRevision: body.expected_revision,
      title: body.title,
      kind: body.kind,
      bodyMd: body.body_md,
      aliases: body.aliases,
      restoredFrom: body.restored_from,
    });
    return c.json(found(page));
  } catch (error) {
    return wikiError(c, error);
  }
});

wikiRouter.delete('/api/wiki/pages/:pageId', async (c) => {
  const pageId = c.req.param('pageId');
  await requirePage(c, pageId);
  const query = wikiDeleteQuerySchema.parse(c.req.query());
  try {
    return c.json(found(await c.get('catalog').wiki.deletePage(pageId, query.expected_revision)));
  } catch (error) {
    return wikiError(c, error);
  }
});

wikiRouter.post('/api/wiki/pages/:pageId/restore', async (c) => {
  const pageId = c.req.param('pageId');
  await requirePage(c, pageId);
  const body = wikiRestoreBodySchema.parse(await c.req.json());
  try {
    return c.json(found(await c.get('catalog').wiki.restorePage(pageId, body.expected_revision)));
  } catch (error) {
    return wikiError(c, error);
  }
});

wikiRouter.get('/api/wiki/pages/:pageId/revisions', async (c) => {
  const pageId = c.req.param('pageId');
  await requirePage(c, pageId);
  const query = wikiRevisionsQuerySchema.parse(c.req.query());
  const result = found(
    await c.get('catalog').wiki.listRevisions(pageId, {
      limit: query.limit,
      before: query.before ?? null,
    }),
  );
  return c.json({ revisions: result.revisions, next_before: result.nextBefore });
});

wikiRouter.get('/api/wiki/pages/:pageId/revisions/:rev', async (c) => {
  const pageId = c.req.param('pageId');
  await requirePage(c, pageId);
  const raw = c.req.param('rev');
  const rev = REVISION_PATH_RE.test(raw) ? Number(raw) : Number.NaN;
  const revision = Number.isSafeInteger(rev)
    ? await c.get('catalog').wiki.getRevision(pageId, rev)
    : null;
  if (revision === null) throw new ApiError(404, WIKI_DETAIL.revisionNotFound);
  return c.json(revision);
});

wikiRouter.post('/api/wiki/pages/:pageId/merge', async (c) => {
  const pageId = c.req.param('pageId');
  await requirePage(c, pageId);
  const body = wikiMergeBodySchema.parse(await c.req.json());
  try {
    const page = await c
      .get('catalog')
      .wiki.mergePage(
        pageId,
        body.into_page_id,
        body.expected_revision,
        body.into_expected_revision,
      );
    return c.json({ page: found(page) });
  } catch (error) {
    return wikiError(c, error);
  }
});

wikiRouter.post('/api/wiki/pages/:pageId/split', async (c) => {
  const pageId = c.req.param('pageId');
  await requirePage(c, pageId);
  const body = wikiSplitBodySchema.parse(await c.req.json());
  try {
    const result = found(
      await c.get('catalog').wiki.splitPage(pageId, {
        expectedRevision: body.expected_revision,
        remainingBodyMd: body.remaining_body_md,
        newPage: {
          kind: body.new_page.kind,
          title: body.new_page.title,
          bodyMd: body.new_page.body_md,
          aliases: body.new_page.aliases,
        },
      }),
    );
    return c.json({ page: result.page, new_page: result.newPage }, 201);
  } catch (error) {
    return wikiError(c, error);
  }
});
