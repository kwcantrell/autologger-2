// The AI SDK turn (ai-sdk-agent-harness design D3, D5, D6; task 6.3). Every turn here runs the
// real `streamText` against a local fake OpenAI-compatible server (`test/fakeLlm.ts`), with the
// model built by the real `@ai-sdk/openai-compatible` factory on the test's own `fetch`, and the
// real tool builders on a fake session registry, through `driveAiTurn`'s SDK strategy.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Clock } from '@autologger/ports';
import { type SessionHubRegistryFacade, userCaller } from '@autologger/session-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiChatSseEvent } from './aiChatRelay';
import type { AiMcpTurnContext, SdkTurnRegistration } from './aiMcpServer';
import * as mcpModule from './aiMcpServer';
import { driveAiTurn } from './aiTurn';
import {
  SDK_TOOL_CALLS_PER_STEP,
  SDK_TOOL_CALLS_PER_TURN,
  SdkToolGuard,
  sdkTools,
  TOOL_FAILED_TEXT,
  TOOL_STEP_CAP_TEXT,
  TOOL_TURN_ENDED_TEXT,
} from './sdkTools';
import {
  buildSdkModel,
  historyToMessages,
  runSdkTurn,
  SDK_TURN_TOOLS,
  type SdkTurnDeps,
  SdkTurnFailure,
  type SdkTurnKind,
} from './sdkTurn';
import {
  answer,
  callTools,
  type FakeLlm,
  type FakeScript,
  sse,
  startFakeLlm,
} from './test/fakeLlm';

// Records whether any promise-valued property of a `streamText` result is awaited (a `then` with a
// fulfilment handler); a `.catch` alone (`then(undefined, fn)`) is not awaiting (design D3, A34).
const awaitedResultProps = new Set<string>();
// When set, `streamText` throws this marker-carrying AI SDK error synchronously, at the boundary.
const mockState = vi.hoisted(() => ({ throwSync: false }));
vi.mock('ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('ai')>();
  const watch = <T extends object>(result: T): T =>
    new Proxy(result, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target) as unknown;
        if (
          v !== null &&
          typeof v === 'object' &&
          typeof (v as PromiseLike<unknown>).then === 'function'
        ) {
          const p = v as Promise<unknown>;
          return {
            // biome-ignore lint/suspicious/noThenProperty: a thenable wrapper is the point
            then(onF?: (x: unknown) => unknown, onR?: (e: unknown) => unknown) {
              if (typeof onF === 'function') awaitedResultProps.add(String(prop));
              return p.then(onF, onR);
            },
            catch(onR?: (e: unknown) => unknown) {
              return p.then(undefined, onR);
            },
            finally(f?: () => void) {
              return p.finally(f);
            },
          };
        }
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  return {
    ...real,
    streamText: ((opts: Parameters<typeof real.streamText>[0]) => {
      if (mockState.throwSync) {
        throw new real.APICallError({
          message: 'SYNC-ERROR-MARKER',
          url: 'http://x',
          requestBodyValues: { prompt: 'SYNC-PROMPT-MARKER' },
          responseBody: 'SYNC-BODY-MARKER',
        });
      }
      return watch(real.streamText(opts));
    }) as typeof real.streamText,
  };
});

const clock: Clock = { now: () => Date.now() };
const caller = userCaller('user-1');
const SESSION = 'sess-1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface HubLogEntry {
  sessionId: string;
  method: string;
  callerUserId: string | undefined;
}

interface FakeHubOptions {
  insertDelayMs?: number;
  listTopicsThrows?: string;
}

function fakeRegistry(o: FakeHubOptions = {}) {
  const log: HubLogEntry[] = [];
  const topics: Array<Record<string, unknown>> = [];
  let active = 0;
  let maxActive = 0;
  let insertsStarted = 0;
  let insertsDone = 0;
  const registry = {
    get: async (sessionId: string) => ({
      as: (c: { kind: string; userId?: string }) => {
        const note = (method: string) =>
          log.push({ sessionId, method, callerUserId: c.kind === 'user' ? c.userId : undefined });
        return {
          listTranscriptWords: async () => {
            note('listTranscriptWords');
            return [{ word: 'hello', session_time: '00:00:01', speaker: '1' }];
          },
          listTopics: async () => {
            note('listTopics');
            if (o.listTopicsThrows) throw new Error(o.listTopicsThrows);
            return topics;
          },
          insertTopic: async (data: Record<string, unknown>) => {
            note('insertTopic');
            insertsStarted += 1;
            active += 1;
            maxActive = Math.max(maxActive, active);
            await sleep(o.insertDelayMs ?? 5);
            active -= 1;
            insertsDone += 1;
            const t = { id: `t${topics.length + 1}`, ...data };
            topics.push(t);
            return t;
          },
          createAnchoredEvent: async () => {
            note('createAnchoredEvent');
            return { event: { id: 'e1' } };
          },
        };
      },
    }),
  } as unknown as SessionHubRegistryFacade;
  return {
    registry,
    log,
    topics,
    stats: () => ({ maxActive, insertsStarted, insertsDone }),
  };
}

interface Counted {
  deps: SdkTurnDeps;
  log: Array<{ requestBytes: number; responseBytes: number }>;
}

/** Deps on the fake server, with a counting `fetch` standing in for the guarded fetch's byte log. */
function depsFor(llm: FakeLlm, over: Partial<SdkTurnDeps> = {}): Counted {
  const log: Array<{ requestBytes: number; responseBytes: number }> = [];
  const countingFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const entry = { requestBytes: Buffer.byteLength(String(init?.body ?? '')), responseBytes: 0 };
    log.push(entry);
    const r = await fetch(input, init);
    if (!r.body) return r;
    const counted = r.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(c, ctl) {
          entry.responseBytes += c.byteLength;
          ctl.enqueue(c);
        },
      }),
    );
    return new Response(counted, {
      status: r.status,
      statusText: r.statusText,
      headers: r.headers,
    });
  };
  return {
    log,
    deps: {
      provider: 'openai-compatible',
      baseURL: llm.baseURL,
      model: 'test-model',
      apiKey: 'sk-test-KEY-MARKER',
      fetch: countingFetch,
      byteLog: () => log,
      breach: () => null,
      ...over,
    },
  };
}

const GEN_CONTEXT: AiMcpTurnContext = {
  tools: ['get_transcript_words', 'create_event'],
  generation: {
    runId: 'run-1',
    frameRate: 25,
    startOffsetFrames: 0,
    startedAtUtc: '2026-01-01T00:00:00.000Z',
    cap: 200,
    categories: [
      { id: 'cat1', name: 'Cat', type: 'standard' as never, color: '#fff', dropdown_options: [] },
    ],
  },
};

interface RunOpts {
  kind?: SdkTurnKind;
  maxSteps?: number;
  maxTotalTokens?: number;
  history?: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>;
  message?: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  context?: AiMcpTurnContext;
  deps?: SdkTurnDeps;
  hub?: ReturnType<typeof fakeRegistry>;
}

const servers: FakeLlm[] = [];
async function llmWith(script: FakeScript): Promise<FakeLlm> {
  const s = await startFakeLlm(script);
  servers.push(s);
  return s;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function run(llm: FakeLlm, o: RunOpts = {}) {
  const hub = o.hub ?? fakeRegistry();
  const events: AiChatSseEvent[] = [];
  const kind = o.kind ?? 'chat';
  const res = await driveAiTurn({
    clock,
    registry: hub.registry,
    caller,
    sessionId: SESSION,
    message: o.message ?? 'What topics are there?',
    mcpContext: o.context ?? (kind === 'events' ? GEN_CONTEXT : undefined),
    timeoutMs: o.timeoutMs ?? 20_000,
    emit: (e) => {
      events.push(e);
    },
    abortSignal: o.abortSignal,
    sdk: {
      kind,
      deps: o.deps ?? depsFor(llm).deps,
      limits: { maxSteps: o.maxSteps ?? 8, maxTotalTokens: o.maxTotalTokens ?? 400_000 },
      history: o.history,
    },
  });
  const terminals = events.filter((e) => e.event === 'done' || e.event === 'error');
  return { res, events, terminals, hub };
}

const toolNamesOf = (body: Record<string, unknown>) =>
  ((body.tools as Array<{ function: { name: string } }> | undefined) ?? []).map(
    (t) => t.function.name,
  );

/** The tool-role message contents of a request body, in order. */
const toolMessages = (body: Record<string, unknown>) =>
  (body.messages as Array<{ role: string; content: unknown }>)
    .filter((m) => m.role === 'tool')
    .map((m) => String(m.content));

describe('deps: no fallback to globalThis.fetch or environment keys (D3, A17, A18)', () => {
  const base: SdkTurnDeps = {
    provider: 'openai-compatible',
    baseURL: 'http://127.0.0.1:1/v1',
    model: 'm',
    apiKey: 'k',
    fetch: async () => new Response(''),
    byteLog: () => [],
    breach: () => null,
  };
  it('construction throws with no fetch, a non-function fetch, or an empty or non-string apiKey', () => {
    expect(() => buildSdkModel(base)).not.toThrow();
    for (const bad of [
      { fetch: undefined },
      { fetch: 'fetch' },
      { fetch: null },
      { apiKey: '' },
      { apiKey: undefined },
      { apiKey: 42 },
    ]) {
      expect(() => buildSdkModel({ ...base, ...(bad as object) } as SdkTurnDeps)).toThrow(
        SdkTurnFailure,
      );
    }
  });
  it('a missing byte log or breach reader, an empty baseURL or model, or an unknown provider also throws', () => {
    for (const bad of [
      { byteLog: undefined },
      { breach: undefined },
      { baseURL: '' },
      { model: '' },
      { provider: 'gateway' },
    ]) {
      expect(() => buildSdkModel({ ...base, ...(bad as object) } as SdkTurnDeps)).toThrow(
        SdkTurnFailure,
      );
    }
  });
});

describe('tools (D3)', () => {
  it('each turn kind gets exactly its tool set', async () => {
    expect(SDK_TURN_TOOLS).toEqual({
      chat: ['get_transcript_words', 'list_topics', 'create_topic'],
      topics: ['get_transcript_words', 'create_topic'],
      events: ['get_transcript_words', 'create_event'],
    });
    for (const kind of ['chat', 'topics', 'events'] as const) {
      const llm = await llmWith(() => answer('ok'));
      // A context naming a wider set never widens the kind's own set.
      const context: AiMcpTurnContext =
        kind === 'events'
          ? {
              ...GEN_CONTEXT,
              tools: ['get_transcript_words', 'list_topics', 'create_topic', 'create_event'],
            }
          : { tools: ['get_transcript_words', 'list_topics', 'create_topic', 'create_event'] };
      await run(llm, { kind, context });
      expect(toolNamesOf(llm.requests[0] ?? {}).sort()).toEqual([...SDK_TURN_TOOLS[kind]].sort());
    }
  });

  it("a call runs the shared body on the registration's session and caller", async () => {
    const llm = await llmWith((n) =>
      n === 1
        ? callTools(1, [{ name: 'get_transcript_words' }, { name: 'list_topics' }])
        : answer('done'),
    );
    const { res, hub } = await run(llm);
    expect(res.ok).toBe(true);
    expect(hub.log).toEqual([
      { sessionId: SESSION, method: 'listTranscriptWords', callerUserId: 'user-1' },
      { sessionId: SESSION, method: 'listTopics', callerUserId: 'user-1' },
    ]);
    // The chat rendering of the transcript reached the model.
    expect(toolMessages(llm.requests[1] ?? {})[0]).toContain('hello');
  });

  it("a create_topic validation failure returns the body's tool error and the turn continues", async () => {
    const llm = await llmWith((n) =>
      n === 1
        ? callTools(1, [{ name: 'create_topic', args: { topic_level: 99 } }])
        : answer('fixed'),
    );
    const { res, hub, events } = await run(llm);
    expect(res.ok).toBe(true);
    expect(hub.topics).toEqual([]);
    expect(toolMessages(llm.requests[1] ?? {})[0]).toContain('Invalid topic input: topic_level');
    expect(events.at(-1)).toEqual({ event: 'done', data: { claude_session_id: null } });
  });

  it('a thrown body error returns "Tool failed.", never its message', async () => {
    const llm = await llmWith((n) =>
      n === 1 ? callTools(1, [{ name: 'list_topics' }]) : answer('ok'),
    );
    const { res } = await run(llm, {
      hub: fakeRegistry({ listTopicsThrows: 'INTERNAL-DB-SECRET at /srv/x' }),
    });
    expect(res.ok).toBe(true);
    const sent = JSON.stringify(llm.requests[1]);
    expect(toolMessages(llm.requests[1] ?? {})[0]).toContain(TOOL_FAILED_TEXT);
    expect(sent).not.toContain('INTERNAL-DB-SECRET');
    expect(TOOL_FAILED_TEXT).toBe('Tool failed.');
  });

  it('the 17th call in one step gets the "too many tool calls" tool error and the turn continues', async () => {
    expect(SDK_TOOL_CALLS_PER_STEP).toBe(16);
    const calls = Array.from({ length: 17 }, () => ({ name: 'list_topics' }));
    const llm = await llmWith((n) => (n === 1 ? callTools(1, calls) : answer('ok')));
    const { res, hub } = await run(llm);
    expect(res.ok).toBe(true);
    expect(hub.log.filter((e) => e.method === 'listTopics')).toHaveLength(16);
    const results = toolMessages(llm.requests[1] ?? {});
    expect(results).toHaveLength(17);
    expect(results.filter((t) => t.includes(TOOL_STEP_CAP_TEXT))).toHaveLength(1);
    expect(TOOL_STEP_CAP_TEXT).toBe('Too many tool calls in one step; continue in the next step.');
    expect(llm.requests).toHaveLength(2);
  });

  it('more calls than the per-turn cap set the breach flag and end the turn as a breach, with nothing past the cap run', async () => {
    expect(SDK_TOOL_CALLS_PER_TURN).toEqual({ chat: 32, generation: 300 });
    const sixteen = Array.from({ length: 16 }, () => ({ name: 'list_topics' }));
    const llm = await llmWith((n) => callTools(n, sixteen));
    const { res, hub, terminals } = await run(llm, { maxSteps: 8 });
    expect(hub.log.filter((e) => e.method === 'listTopics')).toHaveLength(32);
    expect(res.ok).toBe(false);
    expect(res.ending).toBe('breach');
    // A breach is not a client abort: a chat breach ends with exactly one error event.
    expect(terminals).toEqual([{ event: 'error', data: { detail: 'upstream-failed' } }]);
    expect(llm.requests).toHaveLength(3);
  });

  it('parallel calls run one at a time', async () => {
    const llm = await llmWith((n) =>
      n === 1
        ? callTools(1, [
            { name: 'create_topic', args: { summary: 'a' } },
            { name: 'create_topic', args: { summary: 'b' } },
            { name: 'create_topic', args: { summary: 'c' } },
          ])
        : answer('ok'),
    );
    const hub = fakeRegistry({ insertDelayMs: 60 });
    const { res } = await run(llm, { hub });
    expect(res.ok).toBe(true);
    expect(hub.stats()).toEqual({ maxActive: 1, insertsStarted: 3, insertsDone: 3 });
  });

  it('a call arriving after the turn ended (abort, timeout or its end) runs nothing', async () => {
    const hub = fakeRegistry();
    const reg = mcpModule.registerSdkTurn(hub.registry, SESSION, caller, {
      tools: SDK_TURN_TOOLS.chat,
    });
    const guard = new SdkToolGuard({ perTurnCap: 32, onBreach: () => {} });
    const tools = sdkTools(reg, guard);
    guard.end();
    const exec = (tools.list_topics as { execute: (a: unknown, o: unknown) => Promise<unknown> })
      .execute;
    await expect(exec({}, { toolCallId: 'x', messages: [] })).rejects.toThrow(TOOL_TURN_ENDED_TEXT);
    expect(hub.log).toEqual([]);
    expect(guard.breached).toBe(false);
  });

  it('the drain set holds every in-flight body, and the turn exposes it for the route to await', async () => {
    const llm = await llmWith(() =>
      callTools(1, [{ name: 'create_topic', args: { summary: 'slow' } }]),
    );
    const hub = fakeRegistry({ insertDelayMs: 400 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const { res } = await run(llm, { hub, abortSignal: ac.signal });
    expect(res.ok).toBe(false);
    expect(hub.stats().insertsStarted).toBe(1);
    expect(hub.stats().insertsDone).toBe(0);
    expect(typeof res.toolsDrained).toBe('function');
    await res.toolsDrained?.();
    expect(hub.stats().insertsDone).toBe(1);
  });
});

describe('mapping (D3 stream mapping)', () => {
  it('text-delta becomes delta, and finish becomes done with claude_session_id null', async () => {
    const llm = await llmWith(() => ({
      frames: [
        sse.text('Hello '),
        sse.text('world'),
        sse.finish('stop', { prompt: 1, completion: 1 }),
      ],
    }));
    const { res, events } = await run(llm);
    expect(events).toEqual([
      { event: 'delta', data: { text: 'Hello ' } },
      { event: 'delta', data: { text: 'world' } },
      { event: 'done', data: { claude_session_id: null } },
    ]);
    expect(res).toMatchObject({ ok: true, claudeSessionId: null, ending: 'natural' });
  });

  it("tool-call becomes tool {name} only for valid names in the set; an undefined tool's call is not relayed", async () => {
    const llm = await llmWith((n) =>
      n === 1
        ? callTools(1, [
            { name: 'list_topics' },
            { name: 'bash', args: { cmd: 'id' } },
            { name: 'create_event' },
          ])
        : answer('ok'),
    );
    const { events } = await run(llm);
    const tools = events.filter((e) => e.event === 'tool');
    expect(tools).toEqual([{ event: 'tool', data: { name: 'list_topics' } }]);
    expect(JSON.stringify(events)).not.toContain('bash');
    expect(JSON.stringify(events)).not.toContain('create_event');
  });

  it('reasoning parts are not relayed, including inline <think>…</think> split across chunks', async () => {
    const llm = await llmWith(() => ({
      frames: [
        sse.reasoning('FIELD-REASON'),
        sse.text('<thi'),
        sse.text('nk>SECRET-REASON</th'),
        sse.text('ink>Answer'),
        sse.finish('stop', { prompt: 1, completion: 1 }),
      ],
    }));
    const { events } = await run(llm);
    const text = events
      .filter((e) => e.event === 'delta')
      .map((e) => String(e.data.text))
      .join('');
    expect(text).toBe('Answer');
    expect(JSON.stringify(events)).not.toMatch(/REASON|think/);
  });
});

describe('endings (D3 table)', () => {
  const loop =
    (reason = 'tool_calls'): FakeScript =>
    (n) =>
      callTools(n, [{ name: 'get_transcript_words' }], reason);

  it('the step cap ends a generation turn as capped (failure), and a chat turn done', async () => {
    const gen = await run(await llmWith(loop()), { kind: 'topics', maxSteps: 3 });
    expect(gen.res).toMatchObject({ ok: false, detail: 'upstream-failed', ending: 'capped' });
    const chat = await run(await llmWith(loop()), { kind: 'chat', maxSteps: 3 });
    expect(chat.res).toMatchObject({ ok: true, claudeSessionId: null, ending: 'capped' });
    expect(chat.terminals).toEqual([{ event: 'done', data: { claude_session_id: null } }]);
  });

  it('the token budget ends a generation turn as capped (failure), and a chat turn done', async () => {
    // 15 tokens per step (usage reported); a budget of 40 stops after the third step.
    const llmG = await llmWith(loop());
    const gen = await run(llmG, { kind: 'topics', maxSteps: 40, maxTotalTokens: 40 });
    expect(gen.res).toMatchObject({ ok: false, ending: 'capped' });
    expect(llmG.requests).toHaveLength(3);
    const llmC = await llmWith(loop());
    const chat = await run(llmC, { kind: 'chat', maxSteps: 40, maxTotalTokens: 40 });
    expect(chat.res).toMatchObject({ ok: true, ending: 'capped' });
    expect(llmC.requests).toHaveLength(3);
  });

  it('tool calls reported with finish_reason "stop" that hit the step cap still count as capped', async () => {
    const llm = await llmWith(loop('stop'));
    const { res } = await run(llm, { kind: 'topics', maxSteps: 3 });
    expect(llm.requests).toHaveLength(3);
    expect(res).toMatchObject({ ok: false, ending: 'capped' });
  });

  it('length with an unexecuted call is incomplete (generation failure)', async () => {
    const llm = await llmWith(() => ({
      frames: [
        sse.text('partial'),
        sse.toolCalls(1, [{ name: 'create_topic', args: { summary: 'x' } }]),
        sse.finish('length', { prompt: 1, completion: 1 }),
      ],
    }));
    const { res, hub } = await run(llm, { kind: 'topics' });
    expect(res).toMatchObject({ ok: false, detail: 'upstream-failed', ending: 'incomplete' });
    expect(hub.topics).toEqual([]);
    expect(llm.requests).toHaveLength(1);
    // As chat, a length ending is done with the text so far.
    const chat = await run(
      await llmWith(() => ({ frames: [sse.text('partial'), sse.finish('length')] })),
    );
    expect(chat.res).toMatchObject({ ok: true, ending: 'incomplete' });
    expect(chat.events.map((e) => e.event)).toEqual(['delta', 'done']);
  });

  it('tool_calls with no calls on the last step is natural', async () => {
    const llm = await llmWith(() => ({
      frames: [sse.text('answer'), sse.finish('tool_calls', { prompt: 1, completion: 1 })],
    }));
    const { res } = await run(llm, { kind: 'topics' });
    expect(res).toMatchObject({ ok: true, ending: 'natural' });
  });

  it('a guarded-fetch cap breach is reported as a breach, not a client abort or a plain error', async () => {
    const llm = await llmWith((n) => callTools(n, [{ name: 'list_topics' }]));
    const counted = depsFor(llm);
    let breach: string | null = null;
    const deps: SdkTurnDeps = {
      ...counted.deps,
      fetch: async (u, i) => {
        if (counted.log.length >= 2) {
          breach = 'requests';
          throw new Error('cap');
        }
        return counted.deps.fetch(u, i);
      },
      breach: () => breach,
    };
    const { res, terminals } = await run(llm, { deps });
    expect(res).toMatchObject({ ok: false, detail: 'upstream-failed', ending: 'breach' });
    expect(terminals).toEqual([{ event: 'error', data: { detail: 'upstream-failed' } }]);
  });

  it('after an abort or an error no unhandled rejection occurs, and no result promise is awaited', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      awaitedResultProps.clear();
      const hang = await llmWith(() => ({ frames: [sse.text('slow')], hang: true }));
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 100);
      const aborted = await run(hang, { abortSignal: ac.signal });
      expect(aborted.res).toMatchObject({ ok: false, detail: 'aborted' });
      const failing = await llmWith(() => ({ status: 401, body: '{"error":"BODY-MARKER"}' }));
      const errored = await run(failing);
      expect(errored.res).toMatchObject({ ok: false, detail: 'upstream-failed', ending: 'error' });
      const capped = await run(await llmWith((n) => callTools(n, [{ name: 'list_topics' }])), {
        maxSteps: 2,
      });
      expect(capped.res.ok).toBe(true);
      await sleep(100);
      expect(unhandled).toEqual([]);
      expect([...awaitedResultProps]).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('no AISDKError leaves the turn: callers only ever see SdkTurnFailure or a scrubbed outcome', async () => {
    expect(new SdkTurnFailure('internal-error')).toMatchObject({
      name: 'SdkTurnFailure',
      kind: 'internal-error',
    });
    expect(Object.keys(new SdkTurnFailure('upstream-failed'))).toEqual(['kind']);
    const MARKERS = /MARKER|requestBodyValues|responseBody|APICallError|AI_/;
    const llm = await llmWith(() => answer('x'));
    // An AI SDK error thrown synchronously by streamText itself.
    mockState.throwSync = true;
    try {
      const sync = await run(llm);
      expect(sync.res).toMatchObject({ ok: false, detail: 'upstream-failed', ending: 'error' });
      expect(sync.terminals).toEqual([{ event: 'error', data: { detail: 'upstream-failed' } }]);
      expect(JSON.stringify(sync)).not.toMatch(MARKERS);
      // runSdkTurn itself resolves rather than throwing the SDK error.
      const direct = await runSdkTurn({
        registry: fakeRegistry().registry,
        caller,
        sessionId: SESSION,
        message: 'hi',
        timeoutMs: 5_000,
        emit: () => {},
        spec: {
          kind: 'chat',
          deps: depsFor(llm).deps,
          limits: { maxSteps: 2, maxTotalTokens: 1000 },
        },
      });
      expect(JSON.stringify(direct)).not.toMatch(MARKERS);
    } finally {
      mockState.throwSync = false;
    }
    // An AI SDK error from inside the call (the fetch throws one carrying the prompt).
    const { APICallError } = await import('ai');
    const fromFetch = depsFor(llm, {
      fetch: async () => {
        throw new APICallError({
          message: 'FETCH-ERROR-MARKER',
          url: 'http://x',
          requestBodyValues: { prompt: 'FETCH-PROMPT-MARKER' },
          responseBody: 'FETCH-BODY-MARKER',
          isRetryable: false,
        });
      },
    }).deps;
    const inner = await run(llm, { deps: fromFetch });
    expect(inner.res).toMatchObject({ ok: false, detail: 'upstream-failed', ending: 'error' });
    expect(JSON.stringify(inner)).not.toMatch(MARKERS);
    // Bad deps: the only throw is SdkTurnFailure, which driveAiTurn turns into internal-error.
    let thrown: unknown;
    try {
      await runSdkTurn({
        registry: fakeRegistry().registry,
        caller,
        sessionId: SESSION,
        message: 'hi',
        timeoutMs: 5_000,
        emit: () => {},
        spec: {
          kind: 'chat',
          deps: { ...depsFor(llm).deps, apiKey: '' },
          limits: { maxSteps: 2, maxTotalTokens: 1 },
        },
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SdkTurnFailure);
    const bad = await run(llm, { deps: { ...depsFor(llm).deps, fetch: undefined as never } });
    expect(bad.res).toMatchObject({ ok: false, detail: 'internal-error' });
    expect(bad.terminals).toEqual([{ event: 'error', data: { detail: 'internal-error' } }]);
  });
});

describe('errors (D5): every model-side error is upstream-failed and carries nothing out', () => {
  const PROMPT_MARKER = 'PROMPT-MARKER-7f3a';
  const BODY_MARKER = 'PROVIDER-BODY-MARKER-91c2';

  async function captured(fn: () => Promise<void>): Promise<string> {
    const chunks: string[] = [];
    const grab = (...a: unknown[]) => {
      chunks.push(
        a.map((x) => (typeof x === 'string' ? x : (JSON.stringify(x) ?? String(x)))).join(' '),
      );
    };
    const spies = [
      vi.spyOn(console, 'error').mockImplementation(grab),
      vi.spyOn(console, 'warn').mockImplementation(grab),
      vi.spyOn(console, 'log').mockImplementation(grab),
      vi.spyOn(console, 'info').mockImplementation(grab),
      vi.spyOn(console, 'debug').mockImplementation(grab),
      vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
        chunks.push(String(c));
        return true;
      }),
      vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
        chunks.push(String(c));
        return true;
      }),
    ];
    try {
      await fn();
    } finally {
      for (const s of spies) s.mockRestore();
    }
    return chunks.join('\n');
  }

  for (const [name, script] of [
    [
      'an APICallError 500 (retried, then a RetryError)',
      () => ({ status: 500, body: `{"error":"${BODY_MARKER}"}` }),
    ],
    [
      'an APICallError 401 with a body',
      () => ({ status: 401, body: `{"error":{"message":"${BODY_MARKER}"}}` }),
    ],
    ['a mid-stream drop (fullStream throws)', () => ({ frames: [sse.text('part')], drop: true })],
  ] as const) {
    it(`${name} becomes upstream-failed, and its body, request values and message reach no event or output`, {
      timeout: 30_000,
    }, async () => {
      const llm = await llmWith(script as FakeScript);
      let out: Awaited<ReturnType<typeof run>> | undefined;
      const output = await captured(async () => {
        out = await run(llm, { message: `please ${PROMPT_MARKER}` });
      });
      expect(out?.res).toMatchObject({ ok: false, detail: 'upstream-failed', ending: 'error' });
      expect(out?.terminals).toEqual([{ event: 'error', data: { detail: 'upstream-failed' } }]);
      const seen = JSON.stringify(out) + output;
      expect(seen).not.toContain(PROMPT_MARKER);
      expect(seen).not.toContain(BODY_MARKER);
      expect(seen).not.toContain('sk-test-KEY-MARKER');
      expect(seen).not.toMatch(/requestBodyValues|responseBody|APICallError|RetryError/);
    });
  }
});

describe('bounds (D3 limits)', () => {
  it('an endless tool loop stops at the step cap', async () => {
    const llm = await llmWith((n) => callTools(n, [{ name: 'get_transcript_words' }]));
    await run(llm, { maxSteps: 4 });
    expect(llm.requests).toHaveLength(4);
  });

  it('the token budget stops a loop whose provider reports no usage, through the byte estimate', async () => {
    const llm = await llmWith((n) =>
      callTools(n, [{ name: 'get_transcript_words' }], 'tool_calls', null),
    );
    const counted = depsFor(llm);
    // Each step's request and response bytes ÷ 4 is a few hundred tokens; 600 stops it in a few steps.
    const { res } = await run(llm, {
      deps: counted.deps,
      kind: 'topics',
      maxSteps: 40,
      maxTotalTokens: 600,
    });
    expect(res).toMatchObject({ ok: false, ending: 'capped' });
    expect(llm.requests.length).toBeGreaterThan(1);
    expect(llm.requests.length).toBeLessThan(10);
    const perStep = counted.log.map((e) => (e.requestBytes + e.responseBytes) / 4);
    const before = perStep.slice(0, -1).reduce((a, b) => a + b, 0);
    expect(before).toBeLessThan(600);
    expect(before + (perStep.at(-1) ?? 0)).toBeGreaterThanOrEqual(600);
  });

  it('maxRetries 2 gives at most 3 requests for a 500', { timeout: 30_000 }, async () => {
    const llm = await llmWith(() => ({ status: 500, body: '{}' }));
    await run(llm);
    expect(llm.requests).toHaveLength(3);
  });

  it('maxOutputTokens 4000 reaches the request', async () => {
    const llm = await llmWith(() => answer('x'));
    await run(llm);
    expect(llm.requests[0]?.max_tokens).toBe(4000);
  });

  it('OpenAI requests carry store: false', { timeout: 30_000 }, async () => {
    const llm = await llmWith(() => ({ status: 400, body: '{"error":{"message":"no"}}' }));
    const { deps } = depsFor(llm, { provider: 'openai', model: 'gpt-test' });
    const { res } = await run(llm, { deps });
    expect(res.ok).toBe(false);
    expect(llm.meta[0]?.path).toBe('/v1/responses');
    expect(llm.requests[0]?.store).toBe(false);
  });
});

describe('ending: timeout and abort', () => {
  async function spyRegistrations(): Promise<SdkTurnRegistration[]> {
    const regs: SdkTurnRegistration[] = [];
    const real = mcpModule.registerSdkTurn;
    vi.spyOn(mcpModule, 'registerSdkTurn').mockImplementation((...a) => {
      const r = real(...a);
      regs.push(r);
      return r;
    });
    return regs;
  }

  it('the timeout ends the turn with one ending event, closes the upstream socket and releases the registration', async () => {
    const regs = await spyRegistrations();
    const llm = await llmWith(() => ({ frames: [sse.text('slow')], hang: true }));
    const { res, terminals } = await run(llm, { timeoutMs: 200 });
    expect(res).toMatchObject({ ok: false, detail: 'timeout' });
    expect(terminals).toEqual([{ event: 'error', data: { detail: 'timeout' } }]);
    await sleep(50);
    expect(llm.closed()).toBe(1);
    expect(regs).toHaveLength(1);
    expect(regs[0]?.disposed).toBe(true);
  });

  it('a client abort ends the turn with no more than one ending event, closes the upstream socket and releases the registration', async () => {
    const regs = await spyRegistrations();
    const llm = await llmWith(() => ({ frames: [sse.text('slow')], hang: true }));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const { res, terminals } = await run(llm, { abortSignal: ac.signal });
    expect(res).toMatchObject({ ok: false, detail: 'aborted' });
    expect(terminals.length).toBeLessThanOrEqual(1);
    await sleep(50);
    expect(llm.closed()).toBe(1);
    expect(regs[0]?.disposed).toBe(true);
  });
});

describe('history (D6)', () => {
  it('history entries reach the provider as user/assistant messages in order, followed by the new message', async () => {
    expect(
      historyToMessages(
        [
          { role: 'user', text: 'first question' },
          { role: 'assistant', text: 'first answer' },
        ],
        'second question',
      ),
    ).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ]);
    expect(historyToMessages(undefined, 'only')).toEqual([{ role: 'user', content: 'only' }]);
    const llm = await llmWith(() => answer('ok'));
    await run(llm, {
      history: [
        { role: 'user', text: 'first question' },
        { role: 'assistant', text: 'first answer' },
      ],
      message: 'second question',
    });
    const msgs = (
      (llm.requests[0]?.messages ?? []) as Array<{ role: string; content: unknown }>
    ).map((m) => [m.role, typeof m.content === 'string' ? m.content : JSON.stringify(m.content)]);
    expect(msgs.map((m) => m[0])).toEqual(['system', 'user', 'assistant', 'user']);
    expect(msgs.slice(1).map((m) => m[1])).toEqual([
      expect.stringContaining('first question'),
      expect.stringContaining('first answer'),
      expect.stringContaining('second question'),
    ]);
  });
});

describe('the factory table (D3, task 6.4)', () => {
  // The guarded fetch's destination rule (server/src/auth/providerOutbound.ts, D4 step 1), as a
  // stub transport: the package may not import server code, so the rule is restated here.
  const FIXED: Record<
    string,
    { origin: string; path: (model: string) => string; queries: string[] }
  > = {
    anthropic: { origin: 'https://api.anthropic.com', path: () => '/v1/messages', queries: [''] },
    openai: { origin: 'https://api.openai.com', path: () => '/v1/responses', queries: [''] },
    google: {
      origin: 'https://generativelanguage.googleapis.com',
      path: (m) => `/v1beta/models/${m}:streamGenerateContent`,
      queries: ['', '?alt=sse'],
    },
  };
  const SAVED_BASE = 'https://llm.example.test/sub/v1';
  const destinationAllowed = (provider: string, model: string, raw: string): boolean => {
    const u = new URL(raw);
    if (provider === 'openai-compatible') {
      const base = new URL(SAVED_BASE);
      return (
        u.origin === base.origin &&
        u.pathname === `${base.pathname}/chat/completions` &&
        u.search === ''
      );
    }
    const f = FIXED[provider];
    return (
      f !== undefined &&
      u.origin === f.origin &&
      u.pathname === f.path(model) &&
      f.queries.includes(u.search)
    );
  };
  const KEY_HEADER: Record<string, (h: Record<string, string>) => string | undefined> = {
    anthropic: (h) => h['x-api-key'],
    openai: (h) => h.authorization,
    google: (h) => h['x-goog-api-key'],
    'openai-compatible': (h) => h.authorization,
  };

  for (const [provider, baseURL, model, wantKey] of [
    ['anthropic', 'https://api.anthropic.com/v1', 'claude-test', 'sk-ant-KEY'],
    ['openai', 'https://api.openai.com/v1', 'gpt-test', 'Bearer sk-oai-KEY'],
    ['google', 'https://generativelanguage.googleapis.com/v1beta', 'gemini-test', 'g-KEY'],
    ['openai-compatible', SAVED_BASE, 'qwen-test', 'Bearer oc-KEY'],
  ] as const) {
    it(`${provider} builds its model through its factory with apiKey and our fetch, and its first request reaches ${provider === 'openai-compatible' ? 'the saved origin' : 'its fixed host'}`, async () => {
      const seen: Array<{ url: string; allowed: boolean; key: string | undefined }> = [];
      const stub = async (input: string | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const headers = Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        );
        seen.push({
          url,
          allowed: destinationAllowed(provider, model, url),
          key: KEY_HEADER[provider]?.(headers),
        });
        return new Response('{"error":{"message":"stub"}}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      };
      const apiKey = wantKey.replace(/^Bearer /, '');
      const deps: SdkTurnDeps = {
        provider,
        baseURL,
        model,
        apiKey,
        fetch: stub,
        byteLog: () => [],
        breach: () => null,
      };
      expect(() => buildSdkModel(deps)).not.toThrow();
      const llm = await llmWith(() => answer('unused'));
      const { res } = await run(llm, { deps });
      expect(res).toMatchObject({ ok: false, detail: 'upstream-failed' });
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen[0]?.allowed).toBe(true);
      expect(seen[0]?.key).toBe(wantKey);
      expect(llm.requests).toHaveLength(0);
    });
  }
});

describe('Anthropic prompt caching and the cache-aware budget (D3, A41, task 6.5)', () => {
  // A fake Anthropic Messages stream: every step calls `get_transcript_words`, reporting the
  // given usage, so only the step cap or the budget ends the loop.
  async function fakeAnthropic(usage: Record<string, number>) {
    const bodies: Array<Record<string, unknown>> = [];
    const ev = (t: string, d: Record<string, unknown>) =>
      `event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`;
    const server = http.createServer((q, r) => {
      let b = '';
      q.on('data', (c) => {
        b += c;
      });
      q.on('end', () => {
        bodies.push(JSON.parse(b) as Record<string, unknown>);
        const n = bodies.length;
        r.writeHead(200, { 'content-type': 'text/event-stream' });
        r.write(
          ev('message_start', {
            message: {
              id: `m${n}`,
              type: 'message',
              role: 'assistant',
              model: 'claude-test',
              content: [],
              stop_reason: null,
              usage: { ...usage, output_tokens: 1 },
            },
          }),
        );
        r.write(
          ev('content_block_start', {
            index: 0,
            content_block: {
              type: 'tool_use',
              id: `toolu_${n}`,
              name: 'get_transcript_words',
              input: {},
            },
          }),
        );
        r.write(
          ev('content_block_delta', {
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{}' },
          }),
        );
        r.write(ev('content_block_stop', { index: 0 }));
        r.write(
          ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }),
        );
        r.end(ev('message_stop', {}));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { baseURL: `http://127.0.0.1:${port}/v1`, bodies };
  }
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((c) => c()));
  });
  const anthropicDeps = (baseURL: string, llm: FakeLlm): SdkTurnDeps =>
    depsFor(llm, { provider: 'anthropic', baseURL, model: 'claude-test' }).deps;

  it('Anthropic requests carry the top-level cache_control {type: ephemeral}', async () => {
    const fake = await fakeAnthropic({ input_tokens: 50 });
    const llm = await llmWith(() => answer('unused'));
    await run(llm, { deps: anthropicDeps(fake.baseURL, llm), maxSteps: 1 });
    expect(fake.bodies.length).toBeGreaterThanOrEqual(1);
    expect(fake.bodies[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('the other providers’ requests carry no cache_control', async () => {
    const compat = await llmWith(() => answer('ok'));
    await run(compat);
    expect(JSON.stringify(compat.requests[0])).not.toContain('cache_control');
    const oai = await llmWith(() => ({ status: 400, body: '{"error":{"message":"no"}}' }));
    await run(oai, { deps: depsFor(oai, { provider: 'openai', model: 'gpt-test' }).deps });
    expect(JSON.stringify(oai.requests[0])).not.toContain('cache_control');
    const seen: string[] = [];
    const google: SdkTurnDeps = {
      ...depsFor(compat).deps,
      provider: 'google',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-test',
      fetch: async (_u, init) => {
        seen.push(String(init?.body ?? ''));
        return new Response('{"error":{"message":"stub"}}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      },
    };
    await run(compat, { deps: google });
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]).not.toMatch(/cache_?control|cachedContent/i);
  });

  it('large cache reads do not fire the budget, while the same total as uncached input does', async () => {
    // Per step: 9 255 total tokens. Cached: 50 uncached + 200 written + 9 000 read + 5 output, so
    // 255 billable; uncached: all 9 255 billable. Budget 2 000, step cap 5.
    const cached = await fakeAnthropic({
      input_tokens: 50,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 9000,
    });
    const llm = await llmWith(() => answer('unused'));
    const a = await run(llm, {
      kind: 'topics',
      deps: anthropicDeps(cached.baseURL, llm),
      maxSteps: 5,
      maxTotalTokens: 2000,
    });
    expect(a.res).toMatchObject({ ok: false, ending: 'capped' });
    expect(cached.bodies).toHaveLength(5);

    const uncached = await fakeAnthropic({ input_tokens: 9250 });
    const b = await run(llm, {
      kind: 'topics',
      deps: anthropicDeps(uncached.baseURL, llm),
      maxSteps: 5,
      maxTotalTokens: 2000,
    });
    expect(b.res).toMatchObject({ ok: false, ending: 'capped' });
    expect(uncached.bodies).toHaveLength(1);
  });
});
