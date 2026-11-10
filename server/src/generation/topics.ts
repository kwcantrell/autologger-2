// The topics step (OpenSpec change `batch-autogenerate`, design D6, D7 topics, D9; topic-generation
// design D1-D7): the runner shared by `POST /api/sessions/:sessionId/topics/generate` and the batch
// worker. Moved from the route: the caller's route, the approved-user rule, the transcript
// precondition, the shared per-session AI slot and its `ai-turn` lease, the one-shot turn, the
// page-coverage gate and the crash-safe swap. It returns a typed outcome; the route maps it to its
// unchanged status and detail.
//
// A run's topics are the ids its own `create_topic` calls were given (an id allocator in the MCP
// context), never "the topics that appeared during the run" (A19): a failure deletes exactly
// those, so a topic a person adds meanwhile survives (R12). For a batch step (`batch`), the
// allocator first records each id on the job's item (fenced on the job lease); a refused record
// inserts nothing, latches the tool and ends the run `stopped`. A batch run never deletes topics
// that existed before it (its pre-run set is empty by the gap rule), and its own-topic deletes are
// per row with version 1, so a topic a person edited is kept and counted.

import { aiChatTurns } from '@autologger/ai-runtime/aiChatRegistry';
import { allTranscriptPagesServed } from '@autologger/ai-runtime/aiMcpServer';
import { sdkFailureSuffix, sdkFallbackSuffix } from '@autologger/ai-runtime/sdkTurn';
import { generateTopicsTurn } from '@autologger/ai-runtime/topicGenerate';
import type {
  SessionHubEntry,
  SessionHubFacade,
  SessionHubRegistryFacade,
  Topic,
} from '@autologger/session-core';
import {
  generateSdkLimits,
  runFeatureAllowed,
  topicGenerateMaxBudgetUsd,
  topicGenerateTimeoutSec,
} from '../env';
import { callerLlmRoute, sdkTurnSpec } from './aiRoute';
import { claimAiLeaseFor } from './aiSlot';
import {
  type GenerationPrincipal,
  hubFor,
  isProviderRefusal,
  isRateLimitStatus,
} from './principal';

export type TopicsOutcome =
  | { kind: 'unconfigured' }
  | { kind: 'forbidden' }
  | { kind: 'precondition'; code: 'no-transcript' }
  | { kind: 'busy' }
  /** batch: `beforeRun` found the output present under the slot. */
  | { kind: 'present' }
  /** batch: a topic id could not be recorded (the job lease is lost); the turn failed. */
  | { kind: 'stopped' }
  | { kind: 'failed'; rateLimited: boolean; providerFailed: boolean; keptEdited: number }
  | { kind: 'ok'; topics: Topic[]; keptEdited: number };

export interface TopicsBatchOptions {
  /** Under the slot, before the turn: re-check the gap. */
  beforeRun: () => Promise<'go' | 'present' | 'stop'>;
  /** Records a topic id on the item before its insert; false when the job lease is lost. */
  recordTopicId: (id: string) => Promise<boolean>;
}

/** Deletes `ids`, one row at a time with the insert-time version 1, as the principal (design D7
 * "Version-guarded deletes"): a topic a person edited is kept; a missing id is ignored. */
export async function deleteOwnTopics(
  p: GenerationPrincipal,
  sessionId: string,
  ids: readonly string[],
): Promise<{ deleted: number; keptEdited: number }> {
  let deleted = 0;
  let keptEdited = 0;
  for (const id of ids) {
    const r = await (await hubFor(p, sessionId)).deleteTopic(id, { version: 1, overwrite: false });
    if (typeof r === 'object') keptEdited += 1;
    else if (r) deleted += 1;
  }
  return { deleted, keptEdited };
}

/** Whether the session has its topics (design D7 topics): a topic other than unedited recorded
 * partial output (`recordedIds`, of any job's non-done item). */
export async function topicsPresent(
  p: GenerationPrincipal,
  sessionId: string,
  recordedIds: readonly string[],
): Promise<boolean> {
  const recorded = new Set(recordedIds);
  const topics = await (await hubFor(p, sessionId)).listTopics();
  return topics.some((t) => !(recorded.has(t.id) && t.version === 1));
}

/** The run's registry handle: every topic inserted through it without an id gets one from
 * `allocate` first, so any topic the turn writes is the run's own (an explicit id, the tool's, is
 * kept). A person's insert goes through the app's own registry and is never the run's. */
function allocatingRegistry(
  registry: SessionHubRegistryFacade,
  allocate: () => Promise<string>,
): SessionHubRegistryFacade {
  const bind = <T extends object>(target: T, key: PropertyKey) => {
    const v = Reflect.get(target, key);
    return typeof v === 'function' ? v.bind(target) : v;
  };
  const view = (v: SessionHubFacade): SessionHubFacade =>
    new Proxy(v, {
      get: (target, key) =>
        key === 'insertTopic'
          ? async (data: Parameters<SessionHubFacade['insertTopic']>[0], id?: string) =>
              target.insertTopic(data, id ?? (await allocate()))
          : bind(target, key),
    });
  const entry = (e: SessionHubEntry): SessionHubEntry =>
    new Proxy(e, {
      get: (target, key) =>
        key === 'as'
          ? (caller: Parameters<SessionHubEntry['as']>[0]) => view(target.as(caller))
          : bind(target, key),
    });
  return new Proxy(registry, {
    get: (target, key) =>
      key === 'get' ? async (id: string) => entry(await target.get(id)) : bind(target, key),
  });
}

export async function runTopics(
  p: GenerationPrincipal,
  sessionId: string,
  opts: { batch?: TopicsBatchOptions } = {},
): Promise<TopicsOutcome> {
  const config = p.env.config;
  // Configuration gate, before any spawn or model request: the principal's route
  // (ai-sdk-agent-harness D1), the Claude CLI or the AI SDK on the principal's own credential.
  const route = await callerLlmRoute(p.env, p.user);
  if (route === null) return { kind: 'unconfigured' };
  // Approved users only (run-status-and-sweeper D9), before any slot, lease or spawn.
  if (!runFeatureAllowed(config, p.user)) return { kind: 'forbidden' };

  // Transcript precondition (design D4), before any spawn.
  const transcriptWords = await (await hubFor(p, sessionId)).listTranscriptWords();
  if (transcriptWords.length === 0) return { kind: 'precondition', code: 'no-transcript' };

  // Single-flight (per session), spawning nothing. There is no process-wide ceiling
  // (run-status-and-sweeper D2). Acquired here (not inside generateTopicsTurn) and released in
  // this runner's own finally.
  const proc = aiChatTurns.tryAcquire(sessionId);
  if (!proc.ok) return { kind: 'busy' };
  // The session's `ai-turn` lease (session-run-leases D4), behind the slot: a refusal means
  // another process runs a turn here, so it reads as session-busy.
  const slot = await claimAiLeaseFor(() => hubFor(p, sessionId), sessionId, proc);
  if (slot === null) return { kind: 'busy' };

  try {
    const batch = opts.batch;
    if (batch) {
      const go = await batch.beforeRun();
      if (go === 'present') return { kind: 'present' };
      if (go === 'stop') return { kind: 'stopped' };
    }
    // Record pre-run topic ids BEFORE the run (design D3's crash-safe swap): nothing below ever
    // mutates these topics until the atomic delete-on-success. A batch run replaces none.
    const preRunIds = batch
      ? new Set<string>()
      : new Set((await (await hubFor(p, sessionId)).listTopics()).map((t) => t.id));

    // The run's own topic ids, handed to `create_topic` before each insert (batch-autogenerate
    // D7): for a batch step recorded on the item first.
    const allocated = new Set<string>();
    let refused = false;
    const topicIds = {
      allocate: async (): Promise<string> => {
        const id = crypto.randomUUID();
        if (batch && !(await batch.recordTopicId(id))) {
          refused = true;
          throw new Error('topic id not recorded');
        }
        allocated.add(id);
        return id;
      },
    };

    const common = {
      clock: p.env.ports.clock,
      registry: allocatingRegistry(p.env.ports.sessions, topicIds.allocate),
      caller: p.caller,
      sessionId,
      timeoutMs: topicGenerateTimeoutSec(config) * 1000,
      topicIds,
    };
    const outcome = await generateTopicsTurn(
      route.kind === 'cli'
        ? {
            ...common,
            cliPath: config.CLAUDE_CLI_PATH.trim(),
            maxBudgetUsd: topicGenerateMaxBudgetUsd(config),
          }
        : { ...common, sdk: sdkTurnSpec(p.env, route, 'topics', generateSdkLimits(config)) },
    );
    // An AI SDK run's tool bodies may still be running after a timeout: wait for them before
    // reading the run's topics, so none lands after the cleanup below (D3 "Draining tool
    // bodies"). The lease keeps renewing meanwhile.
    await outcome.toolsDrained?.();

    // A refused id record: the turn failed, and this worker writes nothing more (the job's new
    // holder cleans up what the item recorded).
    if (refused) return { kind: 'stopped' };

    // Re-acquire the hub after the async, potentially multi-minute turn above — the idle sweeper
    // may have closed the prior handle in the meantime (async-session-hub design D6).
    const hub = await hubFor(p, sessionId);
    const after = await hub.listTopics();
    const newIds = after.filter((t) => allocated.has(t.id)).map((t) => t.id);

    // Page-coverage gate (topic-generate-paged-transcript D6): a run that
    // created topics from only SOME of its transcript pages must not replace
    // a full-session topic set with partial-coverage ones — a corruption
    // strictly less detectable than the oversized-payload bug paging fixes.
    // This is the server's own bookkeeping (it served the pages), never
    // model-output inference; a turn whose registration carried no word
    // snapshot claims no coverage and cannot fail here.
    const fullyRead = allTranscriptPagesServed(outcome.pageCoverage);

    if (outcome.ok && newIds.length >= 1 && fullyRead) {
      // A run that restarted at the smaller output cap (D3 "A smaller-model fallback") is noted,
      // content-free, so an operator can see the model rejected the larger cap.
      if (outcome.outputCapFallback !== undefined) {
        console.info(
          `[topics/generate] session=${sessionId}: AI turn succeeded${sdkFallbackSuffix(outcome)}`,
        );
      }
      // Success: delete the pre-run topics, leaving only the fresh set.
      await hub.deleteTopics([...preRunIds]);
      return { kind: 'ok', topics: await hub.listTopics(), keptEdited: 0 };
    }

    // Failure (turn error/timeout/CLI error, a run that created no topics, or
    // one that never read the whole transcript): delete only the topics THIS
    // run created — the pre-run topics were never touched and remain exactly
    // as they were, and so does any topic a person added meanwhile (R12).
    let keptEdited = 0;
    if (batch) keptEdited = (await deleteOwnTopics(p, sessionId, newIds)).keptEdited;
    else await hub.deleteTopics(newIds);
    // Operator-facing diagnostic: the `502` body is deliberately opaque to the
    // client (a fixed, non-sensitive string), but a self-hosted operator needs
    // the real reason to debug — an exceeded `--max-budget-usd` surfaces as the
    // outcome detail `upstream-failed`, a slow turn as `timeout`, an auth
    // problem as `not-logged-in`, a turn that ran clean but made no topics
    // as `ok` with zero new topics, and a model that stopped reading pages
    // early as incomplete page coverage. Logged to the server console only;
    // never the response.
    console.warn(
      `[topics/generate] session=${sessionId}: generation failed — ` +
        (!outcome.ok
          ? `AI turn failed (${outcome.detail})` +
            sdkFailureSuffix(outcome.failure, outcome.ending, outcome.summary) +
            sdkFallbackSuffix(outcome)
          : newIds.length === 0
            ? 'AI turn succeeded but created 0 topics'
            : `AI turn created ${newIds.length} topic(s) after reading only ` +
              `${outcome.pageCoverage.servedPages} of ${outcome.pageCoverage.totalPages} ` +
              'transcript page(s)') +
        (outcome.ok ? sdkFallbackSuffix(outcome) : ''),
    );
    return {
      kind: 'failed',
      rateLimited:
        !outcome.ok &&
        outcome.failure?.kind === 'provider' &&
        isRateLimitStatus(outcome.failure.status),
      providerFailed: !outcome.ok && isProviderRefusal(outcome.failure),
      keptEdited,
    };
  } finally {
    // Lease, then slot, before the response (session-run-leases D4).
    await slot.release();
  }
}
