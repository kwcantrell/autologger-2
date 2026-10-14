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

import { aiChatTurns } from '@autologger/ai-runtime/aiChatRegistry';
import { allTranscriptPagesServed } from '@autologger/ai-runtime/aiMcpServer';
import { sdkFailureSuffix, sdkFallbackSuffix } from '@autologger/ai-runtime/sdkTurn';
import { generateWikiTurn } from '@autologger/ai-runtime/wikiGenerate';
import type { WikiSuggestion, WikiSuggestionDetail } from '@autologger/catalog';
import {
  WIKI_DETAIL,
  WIKI_SUGGESTION_DETAIL,
  wikiSuggestionAcceptSchema,
  wikiSuggestionListQuerySchema,
} from '@autologger/contract';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { AppEnv } from '../appEnv';
import { wikiGenerateMaxBudgetUsd, wikiGenerateTimeoutSec, wikiSdkLimits } from '../env';
import { ApiError } from '../httpError';
import { callerLlmRoute, sdkTurnSpec } from './_aiRoute';
import { claimAiLease } from './_aiSlot';
import {
  getSessionHub,
  requireRunFeature,
  requireSession,
  requireShowAccess,
  requireUser,
  sessionCaller,
} from './_helpers';
import { wikiToolPortFor } from './_wikiToolPort';
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
  const showId = String(session.show_id);

  // 2. The caller's AI route, resolved per request (503 before any slot, lease or spawn).
  const route = await callerLlmRoute(c);
  if (route === null) throw new ApiError(503, D.noLanguageModel);
  // 3. Approved users only (403).
  requireRunFeature(c);

  // 4. The transcript precondition (400).
  const words = await (await getSessionHub(c, sessionId)).listTranscriptWords();
  if (words.length === 0) throw new ApiError(400, D.noTranscript);

  // 5. Single-flight: the shared per-session slot, then the session's `ai-turn` lease (409).
  const proc = aiChatTurns.tryAcquire(sessionId);
  if (!proc.ok) throw new ApiError(409, D.busy);
  const slot = await claimAiLease(c, sessionId, proc);
  if (slot === null) throw new ApiError(409, D.busy);

  try {
    const runId = crypto.randomUUID();
    const port = wikiToolPortFor(c, showId, sessionId);
    const common = {
      clock: c.env.ports.clock,
      registry: c.env.ports.sessions,
      caller: sessionCaller(c),
      sessionId,
      port,
      timeoutMs: wikiGenerateTimeoutSec(c.env.config) * 1000,
    };
    // Resolves once no tool body of the turn is still running (generateWikiTurn drains them).
    const { outcome, proposals, pageCoverage } = await generateWikiTurn(
      route.kind === 'cli'
        ? {
            ...common,
            cliPath: c.env.config.CLAUDE_CLI_PATH.trim(),
            maxBudgetUsd: wikiGenerateMaxBudgetUsd(c.env.config),
          }
        : {
            ...common,
            sdk: {
              ...sdkTurnSpec(c, route, 'wiki', wikiSdkLimits(c.env.config)),
              kind: 'wiki' as const,
            },
          },
    );
    const fullyRead = allTranscriptPagesServed(pageCoverage);

    if (outcome.ok && fullyRead) {
      let stored: WikiSuggestion[];
      try {
        stored = await c.get('catalog').wiki.saveRun(showId, sessionId, runId, proposals);
      } catch {
        // Content-free: the store's error can carry proposal text, so only the count is logged.
        console.warn(
          `[wiki/generate] session=${sessionId}: storing ${proposals.length} suggestion(s) failed`,
        );
        throw new ApiError(502, D.failed);
      }
      if (outcome.outputCapFallback !== undefined) {
        console.info(
          `[wiki/generate] session=${sessionId}: AI turn succeeded${sdkFallbackSuffix(outcome)}`,
        );
      }
      return c.json({ suggestions: stored });
    }

    // Any other ending stores nothing. Logged for the operator, content-free; never the response.
    console.warn(
      `[wiki/generate] session=${sessionId}: wiki update failed — ` +
        (!outcome.ok
          ? `AI turn failed (${outcome.detail})` +
            sdkFailureSuffix(outcome.failure, outcome.ending, outcome.summary) +
            sdkFallbackSuffix(outcome)
          : `AI turn read only ${pageCoverage.servedPages} of ${pageCoverage.totalPages} ` +
            `transcript page(s)${sdkFallbackSuffix(outcome)}`),
    );
    throw new ApiError(502, D.failed);
  } finally {
    // Lease, then slot, before the response (session-run-leases D4).
    await slot.release();
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
