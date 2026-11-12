// Wiki suggestion routes and the wiki update (show-wiki-ai design D3, D5; api-contract-freeze
// "Wiki suggestion object", "Wiki update endpoint", "Wiki suggestion list, read, accept and dismiss
// endpoints"; wiki-generation).
//
// - `POST /api/sessions/:sessionId/wiki/generate` follows `topics/generate` (transcribe.ts) step
//   by step: the masked session 404 (a session with no show included), the caller's AI route
//   (503), the approved-user 403, the no-transcript 400, then the shared per-session AI slot and
//   its run lease (409). The one-shot turn (`generateWikiTurn`) reads the catalog through the
//   caller-bound `WikiToolPort` (`_wikiToolPort.ts`) and returns its checked proposals once no tool
//   body runs. Only a run that ended on its own, served every transcript page and stored its
//   proposals in one transaction answers 200; anything else is the fixed 502 and stores nothing.
//   The slot and lease are released before the response, after every tool body finished.
// - The list is show-scoped (`requireShowAccess`: the masked `404 Show not found.`); the read,
//   accept and dismiss routes load the suggestion as the caller first, so a missing and an
//   inaccessible suggestion both answer `404 Suggestion not found.`, before any body is parsed.
// - The store's errors map through the wiki routes' `wikiError`. No route sets a cookie.

import type { WikiSuggestionDetail } from '@autologger/catalog';
import {
  WIKI_DETAIL,
  WIKI_SUGGESTION_DETAIL,
  wikiSuggestionAcceptSchema,
  wikiSuggestionListQuerySchema,
} from '@autologger/contract';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { AppEnv } from '../appEnv';
import { runWiki } from '../generation/wiki';
import { ApiError } from '../httpError';
import {
  principalOf,
  RUN_FEATURE_FORBIDDEN_DETAIL,
  requireSession,
  requireShowAccess,
  requireUser,
} from './_helpers';
import { wikiError } from './wiki';

export const wikiSuggestionsRouter = new Hono<AppEnv>();

const D = WIKI_SUGGESTION_DETAIL;

/** The suggestion as the signed-in user sees it, or the masked `404 Suggestion not found.`. */
async function requireSuggestion(c: Context<AppEnv>, id: string): Promise<WikiSuggestionDetail> {
  requireUser(c);
  const s = await c.get('catalog').wiki.getSuggestion(id);
  if (s === null) throw new ApiError(404, D.suggestionNotFound);
  return s;
}

/** A store answer of `null`: the suggestion vanished or is no longer accessible. */
function found<T>(v: T | null): T {
  if (v === null) throw new ApiError(404, D.suggestionNotFound);
  return v;
}

// ── the wiki update ──────────────────────────────────────────────────────────────────────────────

wikiSuggestionsRouter.post('/api/sessions/:sessionId/wiki/generate', async (c) => {
  const sessionId = c.req.param('sessionId');
  // 1. The masked 404, also for a session with no show (requireSession).
  const session = await requireSession(c, sessionId);
  // 2-5. The shared runner (batch-autogenerate D6): the caller's AI route (503), the approved-user
  // 403, the transcript 400, the shared slot and its lease (409), then the turn.
  const out = await runWiki(principalOf(c), sessionId, { row: session });
  switch (out.kind) {
    case 'ok':
      return c.json({ suggestions: out.suggestions });
    case 'unconfigured':
      throw new ApiError(503, D.noLanguageModel);
    case 'forbidden':
      throw new ApiError(403, RUN_FEATURE_FORBIDDEN_DETAIL);
    case 'precondition':
      throw new ApiError(400, D.noTranscript);
    case 'busy':
      throw new ApiError(409, D.busy);
    case 'failed':
      throw new ApiError(502, D.failed);
    case 'stopped':
      // Only a batch step (with `batch` options) ends here.
      throw new Error('wiki route: unexpected stopped outcome');
  }
});

// ── list, read, accept, dismiss ──────────────────────────────────────────────────────────────────

wikiSuggestionsRouter.get('/api/shows/:showId/wiki/suggestions', async (c) => {
  const showId = c.req.param('showId');
  await requireShowAccess(c, showId, WIKI_DETAIL.showNotFound);
  const query = wikiSuggestionListQuerySchema.parse(c.req.query());
  return c.json(
    await c.get('catalog').wiki.listSuggestions(showId, {
      status: query.status,
      pageId: query.page_id,
    }),
  );
});

wikiSuggestionsRouter.get('/api/wiki/suggestions/:suggestionId', async (c) => {
  return c.json(await requireSuggestion(c, c.req.param('suggestionId')));
});

wikiSuggestionsRouter.post('/api/wiki/suggestions/:suggestionId/accept', async (c) => {
  const id = c.req.param('suggestionId');
  await requireSuggestion(c, id);
  const body = wikiSuggestionAcceptSchema.parse(await c.req.json());
  try {
    const result = found(
      await c.get('catalog').wiki.acceptSuggestion(id, {
        expectedRevision: body.expected_revision,
        title: body.title,
        bodyMd: body.body_md,
        aliases: body.aliases,
      }),
    );
    return c.json({ page: result.page, suggestion: result.suggestion }, result.created ? 201 : 200);
  } catch (error) {
    return wikiError(c, error);
  }
});

wikiSuggestionsRouter.post('/api/wiki/suggestions/:suggestionId/dismiss', async (c) => {
  const id = c.req.param('suggestionId');
  await requireSuggestion(c, id);
  try {
    return c.json(found(await c.get('catalog').wiki.dismissSuggestion(id)));
  } catch (error) {
    return wikiError(c, error);
  }
});
