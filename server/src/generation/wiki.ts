// The wiki step (OpenSpec change `batch-autogenerate`, design D6, D7 wiki, D9; show-wiki-ai design
// D3, D5): the runner shared by `POST /api/sessions/:sessionId/wiki/generate` and the batch worker.
// Moved from the route: the principal's AI route, the approved-user rule, the transcript
// precondition, the shared per-session AI slot and its `ai-turn` lease, the one-shot wiki turn over
// the principal-bound `WikiToolPort`, and store-only-on-success. It returns a typed outcome; the
// route maps it to its unchanged status and detail. The run id is the caller's choice: a batch step
// records it on its item (`beforeRun`, fenced on the job lease) before the turn, so a resumed step
// can find the suggestions this run stored.

import { aiChatTurns } from '@autologger/ai-runtime/aiChatRegistry';
import { allTranscriptPagesServed } from '@autologger/ai-runtime/aiMcpServer';
import { sdkFailureSuffix, sdkFallbackSuffix } from '@autologger/ai-runtime/sdkTurn';
import { generateWikiTurn } from '@autologger/ai-runtime/wikiGenerate';
import type { Row, WikiSuggestion } from '@autologger/catalog';
import {
  runFeatureAllowed,
  wikiGenerateMaxBudgetUsd,
  wikiGenerateTimeoutSec,
  wikiSdkLimits,
} from '../env';
import { callerLlmRoute, sdkTurnSpec } from './aiRoute';
import { claimAiLeaseFor } from './aiSlot';
import {
  type GenerationPrincipal,
  hubFor,
  isProviderRefusal,
  isRateLimitStatus,
} from './principal';
import { createWikiToolPort } from './wikiToolPort';

export type WikiOutcome =
  | { kind: 'unconfigured' }
  | { kind: 'forbidden' }
  | { kind: 'precondition'; code: 'no-transcript' }
  | { kind: 'busy' }
  /** batch: `beforeRun` could not record the run id (the job lease is lost); nothing ran. */
  | { kind: 'stopped' }
  | { kind: 'failed'; rateLimited: boolean; providerFailed: boolean }
  | { kind: 'ok'; suggestions: WikiSuggestion[] };

export interface WikiRunOptions {
  /** The session's catalog row (its show and title). */
  row: Row;
  /** The run id its suggestions are stored under (a fresh one when absent). */
  runId?: string;
  batch?: { beforeRun: (runId: string) => Promise<'go' | 'stop'> };
}

export async function runWiki(
  p: GenerationPrincipal,
  sessionId: string,
  opts: WikiRunOptions,
): Promise<WikiOutcome> {
  const config = p.env.config;
  const showId = String(opts.row.show_id);
  // 2. The principal's AI route, resolved per run (before any slot, lease or spawn).
  const route = await callerLlmRoute(p.env, p.user);
  if (route === null) return { kind: 'unconfigured' };
  // 3. Approved users only.
  if (!runFeatureAllowed(config, p.user)) return { kind: 'forbidden' };

  // 4. The transcript precondition.
  const words = await (await hubFor(p, sessionId)).listTranscriptWords();
  if (words.length === 0) return { kind: 'precondition', code: 'no-transcript' };

  // 5. Single-flight: the shared per-session slot, then the session's `ai-turn` lease.
  const proc = aiChatTurns.tryAcquire(sessionId);
  if (!proc.ok) return { kind: 'busy' };
  const slot = await claimAiLeaseFor(() => hubFor(p, sessionId), sessionId, proc);
  if (slot === null) return { kind: 'busy' };

  try {
    const runId = opts.runId ?? crypto.randomUUID();
    if (opts.batch && (await opts.batch.beforeRun(runId)) === 'stop') return { kind: 'stopped' };
    const port = createWikiToolPort(
      { catalog: p.catalog, sessions: p.env.ports.sessions, caller: p.caller },
      showId,
      sessionId,
    );
    const common = {
      clock: p.env.ports.clock,
      registry: p.env.ports.sessions,
      caller: p.caller,
      sessionId,
      sessionTitle: opts.row.title == null ? '' : String(opts.row.title),
      port,
      timeoutMs: wikiGenerateTimeoutSec(config) * 1000,
    };
    // Resolves once no tool body of the turn is still running (generateWikiTurn drains them).
    const { outcome, proposals, pageCoverage } = await generateWikiTurn(
      route.kind === 'cli'
        ? {
            ...common,
            cliPath: config.CLAUDE_CLI_PATH.trim(),
            maxBudgetUsd: wikiGenerateMaxBudgetUsd(config),
          }
        : {
            ...common,
            sdk: {
              ...sdkTurnSpec(p.env, route, 'wiki', wikiSdkLimits(config)),
              kind: 'wiki' as const,
            },
          },
    );
    const fullyRead = allTranscriptPagesServed(pageCoverage);

    if (outcome.ok && fullyRead) {
      let stored: WikiSuggestion[];
      try {
        stored = await p.catalog.wiki.saveRun(showId, sessionId, runId, proposals);
      } catch {
        // Content-free: the store's error can carry proposal text, so only the count is logged.
        console.warn(
          `[wiki/generate] session=${sessionId}: storing ${proposals.length} suggestion(s) failed`,
        );
        return { kind: 'failed', rateLimited: false, providerFailed: false };
      }
      if (outcome.outputCapFallback !== undefined) {
        console.info(
          `[wiki/generate] session=${sessionId}: AI turn succeeded${sdkFallbackSuffix(outcome)}`,
        );
      }
      return { kind: 'ok', suggestions: stored };
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
    return {
      kind: 'failed',
      rateLimited:
        !outcome.ok &&
        outcome.failure?.kind === 'provider' &&
        isRateLimitStatus(outcome.failure.status),
      providerFailed: !outcome.ok && isProviderRefusal(outcome.failure),
    };
  } finally {
    // Lease, then slot, before the response (session-run-leases D4).
    await slot.release();
  }
}
