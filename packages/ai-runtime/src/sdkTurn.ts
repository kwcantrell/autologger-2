// The AI SDK turn (ai-sdk-agent-harness design D3, D5, D6): one AI turn run in process by the
// Vercel AI SDK on the caller's own credential, as `driveAiTurn`'s second strategy beside the CLI
// spawn. It reuses `runOuterAiTurn` (timeout, abort, one ending event), the per-turn registration
// (`registerSdkTurn`) and the MCP server's tool bodies (`sdkTools.ts`).
//
// Inputs are injected (package-architecture: `ai-runtime` imports nothing under `server/src`).
// The route passes `SdkTurnDeps`, whose minimal shape is the guarded fetch's own result spread
// beside the credential:
//
//   { provider, baseURL, model, apiKey, ...guardedFetch(...) }   // fetch, byteLog, breach
//
// - `fetch` is the server's guarded fetch (D4); every model request goes through it.
// - `byteLog()` gives each request's request and response body bytes, in order, for the token
//   budget's estimate when a provider reports no usage.
// - `breach()` names the guarded-fetch cap the turn passed, or null; a non-null value makes the
//   turn end as a breach.
//
// Construction (`buildSdkModel`) throws `SdkTurnFailure` unless `fetch`, `byteLog` and `breach`
// are functions and `apiKey`, `baseURL` and `model` are non-empty strings: otherwise the AI SDK
// would fall back to `globalThis.fetch` or to `*_API_KEY` / `*_BASE_URL` in the environment (A17,
// A18). The model is always a provider factory's object, never a model-id string (a string routes
// through the gateway, A15).
//
// No AI SDK error leaves this module (D5): errors are classified to `upstream-failed` from the
// stream, every SDK call is inside a `try`, the result promises are never awaited (each gets a
// no-op `.catch` when the call is made, because they reject after an abort or an error, A34), and
// the only thing thrown is the property-free `SdkTurnFailure`. Nothing here logs.

import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { SessionCaller, SessionHubRegistryFacade } from '@autologger/session-core';
import {
  APICallError,
  extractReasoningMiddleware,
  isStepCount,
  type LanguageModel,
  type ModelMessage,
  RetryError,
  type StopCondition,
  streamText,
  wrapLanguageModel,
} from 'ai';
import type { AiChatErrorDetail, AiChatSseEvent } from './aiChatRelay';
import { AI_CHAT_SYSTEM_PROMPT_BRIEF } from './aiChatRunner';
import {
  type AiMcpPageCoverage,
  type AiMcpToolName,
  type AiMcpTurnContext,
  registerSdkTurn,
  type SdkTurnRegistration,
} from './aiMcpServer';
import { runOuterAiTurn } from './aiTurnOrchestrator';
import {
  decideSdkEnding,
  relaySdkStream,
  type SdkStepRecord,
  type SdkTurnEnding,
} from './sdkRelay';
import { SDK_TOOL_CALLS_PER_TURN, SdkToolGuard, sdkTools } from './sdkTools';

export type { SdkTurnEnding } from './sdkRelay';

/** The four key providers an AI SDK turn runs on. */
export type SdkProvider = 'anthropic' | 'openai' | 'google' | 'openai-compatible';
const SDK_PROVIDERS: ReadonlySet<string> = new Set<SdkProvider>([
  'anthropic',
  'openai',
  'google',
  'openai-compatible',
]);

/** The route's injected inputs (see the module header). */
export interface SdkTurnDeps {
  provider: SdkProvider;
  /** Computed server-side: the fixed host plus the provider's path, or the saved base URL. */
  baseURL: string;
  model: string;
  apiKey: string;
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  byteLog: () => ReadonlyArray<{ requestBytes: number; responseBytes: number }>;
  breach: () => string | null;
}

/** The turn kinds and exactly their tool sets (D3). */
export type SdkTurnKind = 'chat' | 'topics' | 'events' | 'wiki';
export const SDK_TURN_TOOLS: Readonly<Record<SdkTurnKind, readonly AiMcpToolName[]>> =
  Object.freeze({
    chat: ['get_transcript_words', 'list_topics', 'create_topic'],
    topics: ['get_transcript_words', 'create_topic'],
    events: ['get_transcript_words', 'create_event'],
    // show-wiki-ai D3: the wiki turn reads the transcript and the show's wiki, and proposes pages.
    wiki: ['get_transcript_words', 'list_wiki_pages', 'read_wiki_page', 'propose_page'],
  });

/** Always sent: without it Anthropic requests 128 000 output tokens (A24). Chat's fixed per-step
 * output cap, and the smaller-model fallback's (D3 "Limits"). */
export const SDK_MAX_OUTPUT_TOKENS = 4000;
/** Generation's default per-step output cap (`GENERATE_MAX_OUTPUT_TOKENS`, D3 "Limits", A42). */
export const SDK_GENERATE_MAX_OUTPUT_TOKENS = 16_000;
/** Streamed bytes allowed per output token in the response-byte cap (D4 step 3): ~200 bytes of
 * SSE per token chunk, doubled for headroom. */
export const SDK_RESPONSE_BYTES_PER_TOKEN = 400;
/** AI SDK retries per request (A8: 3 requests for a `500`). */
export const SDK_MAX_RETRIES = 2;

/** `*_MAX_STEPS`, `*_MAX_TOKENS` and `GENERATE_MAX_OUTPUT_TOKENS` (D3 "Limits"), validated by
 * the server's config accessors. */
export interface SdkTurnLimits {
  maxSteps: number;
  maxTotalTokens: number;
  /** Generation's per-step output cap (default 16 000); chat ignores it (fixed 4000). */
  maxOutputTokens?: number;
}

/** The per-step output cap a turn of `kind` sends: chat's fixed 4000, else the generation cap. */
export function sdkMaxOutputTokens(kind: SdkTurnKind, limits: SdkTurnLimits): number {
  if (kind === 'chat') return SDK_MAX_OUTPUT_TOKENS;
  return limits.maxOutputTokens ?? SDK_GENERATE_MAX_OUTPUT_TOKENS;
}

/** The guarded fetch's response-byte cap for one turn (D4 step 3): `steps × maxOutputTokens ×
 * 400` bytes (12.8 MB chat, 256 MB generation at the defaults). A counter, not a buffer. */
export function sdkResponseByteCap(kind: SdkTurnKind, limits: SdkTurnLimits): number {
  return limits.maxSteps * sdkMaxOutputTokens(kind, limits) * SDK_RESPONSE_BYTES_PER_TOKEN;
}

/** The log note a route appends when a generation turn restarted at the smaller output cap (D3
 * "A smaller-model fallback"), or nothing. Content-free. */
export function sdkFallbackSuffix(result: { outputCapFallback?: number }): string {
  return result.outputCapFallback === undefined
    ? ''
    : ` (output-cap fallback ${result.outputCapFallback})`;
}

/** One prior chat message (D6), already bounded by the request schema. */
export interface SdkHistoryEntry {
  role: 'user' | 'assistant';
  text: string;
}

/** What the route asks of `driveAiTurn` for an AI SDK turn. */
export interface SdkTurnSpec {
  kind: SdkTurnKind;
  deps: SdkTurnDeps;
  limits: SdkTurnLimits;
  /** Chat only: the client's history, sent as real roles before the new message. */
  history?: readonly SdkHistoryEntry[];
}

/** The cap a breach passed (D5 diagnostic): the guarded fetch's four caps, or the tool-call cap. */
export type SdkBreach =
  | 'requests'
  | 'request-bytes'
  | 'request-total'
  | 'response-bytes'
  | 'tool-calls';

/** The only error that leaves this module, and a failed turn's content-free diagnostic (D5,
 * owner 2026-10-12). It carries a `kind` and, at most, the upstream HTTP `status` (a number; for a
 * `RetryError`, the last attempt's) or the `breach` name: no message text from the cause, no
 * cause, no other properties. The routes append `sdkFailureSuffix` to their failure line. */
export class SdkTurnFailure extends Error {
  readonly kind: 'provider' | 'breach' | 'internal';
  declare readonly status?: number;
  declare readonly breach?: SdkBreach;
  constructor(kind: SdkTurnFailure['kind'], detail: { status?: number; breach?: SdkBreach } = {}) {
    super('AI SDK turn failed');
    this.kind = kind;
    if (typeof detail.status === 'number' && Number.isInteger(detail.status)) {
      Object.defineProperty(this, 'status', { value: detail.status, enumerable: true });
    } else if (detail.breach !== undefined) {
      Object.defineProperty(this, 'breach', { value: detail.breach, enumerable: true });
    }
    Object.defineProperty(this, 'name', { value: 'SdkTurnFailure', enumerable: false });
    Object.defineProperty(this, 'stack', { value: 'SdkTurnFailure', enumerable: false });
  }
}

/** The suffix a route appends to its failure line: ` (status=N)`, ` (breach=name)`, else for an
 * AI SDK ending ` (ending=…, steps=N, last=…)`, or nothing (a CLI turn). */
export function sdkFailureSuffix(
  failure: SdkTurnFailure | undefined,
  ending?: SdkTurnEnding,
  summary?: SdkTurnSummary,
): string {
  if (failure?.status !== undefined) return ` (status=${failure.status})`;
  if (failure?.breach !== undefined) return ` (breach=${failure.breach})`;
  // No status or breach (a capped or incomplete generation, a status-less provider error, an
  // abort): the ending and the step records' shape, still content-free.
  if (ending !== undefined && summary !== undefined) {
    return ` (ending=${ending}, steps=${summary.steps}, last=${summary.lastFinish})`;
  }
  return '';
}

/** A turn's content-free step summary (D5 diagnostic): how many steps finished, and the last
 * one's finish reason (`'none'` before any step finished). */
export interface SdkTurnSummary {
  steps: number;
  lastFinish: string;
}

/** The upstream HTTP status of an AI SDK error: an `APICallError`'s, or a `RetryError`'s last
 * attempt's. Reads only that number. */
function statusOf(error: unknown): number | undefined {
  if (RetryError.isInstance(error)) return statusOf(error.lastError);
  if (APICallError.isInstance(error) && typeof error.statusCode === 'number') {
    return error.statusCode;
  }
  return undefined;
}

/** A provider failure's diagnostic from the error (which is not kept). */
export function providerFailure(error: unknown): SdkTurnFailure {
  return new SdkTurnFailure('provider', { status: statusOf(error) });
}

/** The guarded fetch's breach names, as the diagnostic names them. */
const FETCH_BREACHES: Readonly<Record<string, SdkBreach>> = {
  requests: 'requests',
  'request-body': 'request-bytes',
  'request-total': 'request-total',
  'response-total': 'response-bytes',
};

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** The model and provider options for `deps` (D3 table). Throws `SdkTurnFailure` on bad deps. */
export function buildSdkModel(deps: SdkTurnDeps): {
  model: LanguageModel;
  providerOptions: Record<string, Record<string, boolean | { type: 'ephemeral' }>> | undefined;
} {
  if (
    deps === null ||
    typeof deps !== 'object' ||
    typeof deps.fetch !== 'function' ||
    typeof deps.byteLog !== 'function' ||
    typeof deps.breach !== 'function' ||
    !isNonEmptyString(deps.apiKey) ||
    !isNonEmptyString(deps.baseURL) ||
    !isNonEmptyString(deps.model) ||
    !SDK_PROVIDERS.has(deps.provider)
  ) {
    throw new SdkTurnFailure('internal');
  }
  // Every factory gets `apiKey`, `baseURL` and `fetch`, and no extra headers. The factories call
  // `fetch` with a URL string (A17); the guarded fetch refuses a `Request` object, hence the cast.
  const common = {
    apiKey: deps.apiKey,
    baseURL: deps.baseURL,
    fetch: deps.fetch as typeof globalThis.fetch,
  };
  try {
    switch (deps.provider) {
      case 'anthropic':
        // Automatic prompt caching (A41): each step re-reads the earlier context from cache.
        return {
          model: createAnthropic(common)(deps.model),
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        };
      case 'google':
        return { model: createGoogleGenerativeAI(common)(deps.model), providerOptions: undefined };
      case 'openai':
        // The Responses API; `store: false` so OpenAI does not retain the prompt (A19, A38).
        return {
          model: createOpenAI(common)(deps.model),
          providerOptions: { openai: { store: false } },
        };
      case 'openai-compatible':
        // Inline `<think>…</think>` becomes reasoning parts, which are never relayed (A20).
        return {
          model: wrapLanguageModel({
            model: createOpenAICompatible({ ...common, name: 'llm', includeUsage: true })(
              deps.model,
            ),
            middleware: extractReasoningMiddleware({ tagName: 'think' }),
          }),
          providerOptions: undefined,
        };
      default:
        throw new SdkTurnFailure('internal');
    }
  } catch {
    throw new SdkTurnFailure('internal');
  }
}

/** The chat history (D6) as model messages with real roles, followed by the new user message. */
export function historyToMessages(
  history: readonly SdkHistoryEntry[] | undefined,
  message: string,
): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const h of history ?? []) {
    out.push(
      h.role === 'assistant'
        ? { role: 'assistant', content: h.text }
        : { role: 'user', content: h.text },
    );
  }
  out.push({ role: 'user', content: message });
  return out;
}

export interface RunSdkTurnOptions {
  registry: SessionHubRegistryFacade;
  caller: SessionCaller;
  sessionId: string;
  message: string;
  /** The registration context: a generation snapshot or `pagedWords`. Its `tools` are replaced
   * by the kind's own set. */
  mcpContext?: AiMcpTurnContext;
  /** The turn kind's system prompt; omitted ⇒ the chat brief. */
  systemPrompt?: string;
  timeoutMs: number;
  emit: (event: AiChatSseEvent) => Promise<void> | void;
  abortSignal?: AbortSignal;
  spec: SdkTurnSpec;
}

/** An AI SDK turn's outcome, plus the registration's bookkeeping and the drain. */
export type SdkTurnResult = (
  | { ok: true; claudeSessionId: null }
  | { ok: false; detail: AiChatErrorDetail | 'timeout' | 'aborted' }
) & {
  ending: SdkTurnEnding;
  createdEvents: number;
  pageCoverage: AiMcpPageCoverage;
  /** Resolves once no tool body of the turn is running. The route awaits it before it acts on a
   * result, removes a failed run's topics, or releases the slot and lease (D3 "Draining"). */
  toolsDrained: () => Promise<void>;
  /** A provider or breach ending's content-free diagnostic (D5); absent otherwise. */
  failure?: SdkTurnFailure;
  /** The step count and last finish reason (D5 diagnostic). */
  summary: SdkTurnSummary;
  /** Set when a generation turn restarted at this smaller output cap after its first request got
   * `400` (D3 "A smaller-model fallback"). */
  outputCapFallback?: number;
};

type RelayOutcome =
  | { ok: true; claudeSessionId: null; ending: SdkTurnEnding }
  | { ok: false; detail: AiChatErrorDetail; ending: SdkTurnEnding };

const noop = (): void => {};

/**
 * Run one AI SDK turn to its ending. Throws only `SdkTurnFailure('internal')` (bad deps), before any
 * registration or request; otherwise resolves, having emitted at most one terminal event (none
 * for a client abort), with the registration released and the turn no longer live.
 */
export async function runSdkTurn(o: RunSdkTurnOptions): Promise<SdkTurnResult> {
  const { model, providerOptions } = buildSdkModel(o.spec.deps);
  const { deps, limits, kind } = o.spec;
  const generation = kind !== 'chat';
  let maxOutputTokens = sdkMaxOutputTokens(kind, limits);
  let outputCapFallback: number | undefined;
  const toolNames = SDK_TURN_TOOLS[kind];
  const registration: SdkTurnRegistration = registerSdkTurn(o.registry, o.sessionId, o.caller, {
    ...o.mcpContext,
    tools: toolNames,
  });
  const internal = new AbortController();
  const guard = new SdkToolGuard({
    perTurnCap: generation ? SDK_TOOL_CALLS_PER_TURN.generation : SDK_TOOL_CALLS_PER_TURN.chat,
    onBreach: () => internal.abort(),
  });
  let ending: SdkTurnEnding = 'error';

  try {
    const tools = sdkTools(registration, guard);
    const steps: SdkStepRecord[] = [];
    /** `byteLog()` length when each step started: that step's requests follow it. */
    const stepMarks: number[] = [];
    let stepCapFired = false;
    let failure: SdkTurnFailure | undefined;
    let budgetFired = false;

    const stepCap = isStepCount(limits.maxSteps);
    const stopAtStepCap: StopCondition<typeof tools> = async (a) => {
      const hit = await stepCap(a);
      if (hit) stepCapFired = true;
      return hit;
    };
    /** The per-turn token budget (D3): reported usage less cache reads, or (request + response bytes) ÷ 4 for a
     * step whose provider reports none (A26), so the budget never silently turns off. */
    const tokenBudget: StopCondition<typeof tools> = ({ steps: done }) => {
      const log = deps.byteLog();
      let total = 0;
      done.forEach((s, i) => {
        const reported = s.usage?.totalTokens;
        if (typeof reported === 'number' && Number.isFinite(reported)) {
          // Billable tokens (A41): cache reads don't count toward rate limits and cost a
          // fraction of input; uncached input, cache writes and output do count.
          const cacheRead = s.usage?.inputTokenDetails?.cacheReadTokens;
          total +=
            reported -
            (typeof cacheRead === 'number' && Number.isFinite(cacheRead) ? cacheRead : 0);
          return;
        }
        const from = stepMarks[i] ?? 0;
        const to = stepMarks[i + 1] ?? log.length;
        let bytes = 0;
        for (const e of log.slice(from, to)) bytes += e.requestBytes + e.responseBytes;
        total += Math.ceil(bytes / 4);
      });
      if (total >= limits.maxTotalTokens) budgetFired = true;
      return total >= limits.maxTotalTokens;
    };

    const runRelay = async (guardedEmit: (event: AiChatSseEvent) => Promise<void>) => {
      let errored = false;
      let status: number | undefined;
      for (;;) {
        errored = false;
        status = undefined;
        try {
          const result = streamText({
            model,
            system: o.systemPrompt ?? AI_CHAT_SYSTEM_PROMPT_BRIEF,
            messages: historyToMessages(kind === 'chat' ? o.spec.history : undefined, o.message),
            tools,
            stopWhen: [stopAtStepCap, tokenBudget],
            maxOutputTokens,
            maxRetries: SDK_MAX_RETRIES,
            abortSignal: internal.signal,
            providerOptions,
            prepareStep: ({ stepNumber }) => {
              guard.setStep(stepNumber);
              stepMarks[stepNumber] = deps.byteLog().length;
              return undefined;
            },
            onStepEnd: (step) => {
              steps.push({
                toolCalls: step.toolCalls.length,
                toolResults: step.toolResults.length,
                finishReason: String(step.finishReason),
              });
            },
            // A no-op: the SDK otherwise prints the provider body to stderr (A31). The error is
            // classified from the stream instead.
            onError: () => {},
          });
          // Never awaited; each gets a rejection handler, as it rejects after an abort or an error (A34).
          result.steps.then(undefined, noop);
          result.text.then(undefined, noop);
          result.finishReason.then(undefined, noop);
          result.totalUsage.then(undefined, noop);
          ({ errored, status } = await relaySdkStream(result.fullStream, {
            emit: guardedEmit,
            toolNames: new Set(toolNames),
            statusOf,
          }));
        } catch (thrown) {
          errored = true;
          status = statusOf(thrown);
        }
        // The smaller-model fallback (D3 "Limits"): a generation turn whose FIRST model request was
        // answered 400 at a cap above 4000 starts again once at 4000. Nothing has run yet: no step
        // finished, no tool was called, one request was sent, and no cap or abort fired.
        if (
          generation &&
          outputCapFallback === undefined &&
          maxOutputTokens > SDK_MAX_OUTPUT_TOKENS &&
          errored &&
          status === 400 &&
          steps.length === 0 &&
          guard.calls === 0 &&
          deps.byteLog().length === 1 &&
          deps.breach() === null &&
          !guard.breached &&
          !internal.signal.aborted
        ) {
          maxOutputTokens = SDK_MAX_OUTPUT_TOKENS;
          outputCapFallback = SDK_MAX_OUTPUT_TOKENS;
          stepMarks.length = 0;
          continue;
        }
        break;
      }
      guard.end();
      ending = decideSdkEnding({
        breach: guard.breached || deps.breach() !== null,
        aborted: internal.signal.aborted,
        errored,
        stepCapFired,
        budgetFired,
        steps,
      });
      if (ending === 'breach') {
        const fetchBreach = deps.breach();
        failure = new SdkTurnFailure('breach', {
          breach: guard.breached
            ? 'tool-calls'
            : fetchBreach === null
              ? undefined
              : FETCH_BREACHES[fetchBreach],
        });
      } else if (ending === 'error') {
        failure = new SdkTurnFailure('provider', { status });
      }
      return emitEnding(ending, generation, guardedEmit);
    };

    const outcome = await runOuterAiTurn<AiChatSseEvent, RelayOutcome>({
      runRelay: (guardedEmit) => ({ relay: runRelay(guardedEmit), drain: 'await-settle' }),
      terminate: async () => {
        guard.end();
        internal.abort();
      },
      scrub: (event) => event,
      timeoutMs: o.timeoutMs,
      emit: o.emit,
      abortSignal: o.abortSignal,
    });
    const last = steps.at(-1);
    const base = {
      summary: { steps: steps.length, lastFinish: last === undefined ? 'none' : last.finishReason },
      createdEvents: registration.createdEvents(),
      pageCoverage: registration.pageCoverage(),
      toolsDrained: () => guard.drained(),
      ...(outputCapFallback === undefined ? {} : { outputCapFallback }),
    };
    if (outcome.ok) return { ...base, ok: true, claudeSessionId: null, ending: outcome.ending };
    // `runOuterAiTurn`'s own timeout or abort outcome carries no ending of the relay's.
    if (!('ending' in outcome))
      return { ...base, ok: false, detail: outcome.detail, ending: 'abort' };
    return {
      ...base,
      ok: false,
      detail: outcome.detail,
      ending: outcome.ending,
      ...(failure === undefined ? {} : { failure }),
    };
  } finally {
    guard.end();
    internal.abort();
    registration.dispose();
  }
}

/** Emit the ending's terminal event (D3 table) and give the relay's outcome. */
async function emitEnding(
  ending: SdkTurnEnding,
  generation: boolean,
  emit: (event: AiChatSseEvent) => Promise<void>,
): Promise<RelayOutcome> {
  const fail = async (): Promise<RelayOutcome> => {
    await emit({ event: 'error', data: { detail: 'upstream-failed' } });
    return { ok: false, detail: 'upstream-failed', ending };
  };
  const done = async (): Promise<RelayOutcome> => {
    await emit({ event: 'done', data: { claude_session_id: null } });
    return { ok: true, claudeSessionId: null, ending };
  };
  switch (ending) {
    case 'breach':
    case 'error':
      return fail();
    case 'abort':
      // The route's abort or timeout: `runOuterAiTurn` owns that ending's event.
      return { ok: false, detail: 'upstream-failed', ending };
    case 'capped':
    case 'incomplete':
      return generation ? fail() : done();
    case 'natural':
      return done();
  }
}
