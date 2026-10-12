// REAL end-to-end test of the AI SDK route on Anthropic (ai-sdk-agent-harness task 9.3, design D3,
// D4). The hermetic SDK route tests (routers/ai.int.test.ts, routers/transcribe.int.test.ts) drive
// a local fake provider; this one saves a real `anthropic` llm credential through the providers
// route and runs the production path end to end: the caller's route, `sdkTurnSpec`, the guarded
// fetch to api.anthropic.com, the AI SDK turn and the shared tool bodies.
//
// It checks:
//   (a) a chat turn over a small seeded transcript calls `get_transcript_words`, streams at least
//       one `delta`, and ends with `done {claude_session_id: null}`;
//   (b) one topic generation answers 200 with at least one topic;
//   (c) each turn ended naturally (the turn's own ending, read from `runSdkTurn`'s result) and the
//       token usage Anthropic reported on the turn's requests (read from a tee of each response
//       body the guarded fetch returns) stayed under the turn kind's budget
//       (`aiChatSdkLimits` / `generateSdkLimits` defaults).
//
// The key is never printed: nothing here logs the environment, and everything written to stdout
// and stderr while the test runs, plus every response body, is asserted not to contain it.
//
// GATED: costs real Anthropic spend, so it never runs in `npm test` (the `unit` project collects
// this file and reports it skipped). It runs only under vitest.real-sdk.config.ts (which sets
// AI_SDK_REAL_HARNESS=1 and wires the integration harness; needs a docker daemon) with
// REAL_LLM_ANTHROPIC_KEY set. Optional REAL_LLM_ANTHROPIC_MODEL (default `claude-haiku-5-5`).
//
//   cd server && REAL_LLM_ANTHROPIC_KEY=... npx vitest run --config vitest.real-sdk.config.ts

import * as sdkTurnModule from '@autologger/ai-runtime/sdkTurn';
import type { Config } from '@autologger/ports';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiChatSdkLimits, generateSdkLimits } from '../env';
import { app, env } from './harness';
import { parseSse, seededSession } from './helpers';
import { harnessHub } from './session/sessionRows';

const KEY = process.env.REAL_LLM_ANTHROPIC_KEY ?? '';
const MODEL = (process.env.REAL_LLM_ANTHROPIC_MODEL ?? '').trim() || 'claude-haiku-5-5';
const RUN = KEY.length > 0 && process.env.AI_SDK_REAL_HARNESS === '1';

const EMPTY_CONFIG = {} as unknown as Config;
const CHAT_BUDGET = aiChatSdkLimits(EMPTY_CONFIG).maxTotalTokens;
const GENERATE_BUDGET = generateSdkLimits(EMPTY_CONFIG).maxTotalTokens;
const CASE_TIMEOUT_MS = 300_000;

/** One SDK turn as observed from outside: its ending (D3 "How a turn ends", from `runSdkTurn`'s
 * result) and the token usage Anthropic reported on each model request of the turn. */
interface ObservedTurn {
  ending: string;
  requests: number;
  /** Requests whose stream carried a usage report. */
  reported: number;
  /** Sum over the turn's requests of input (cache included) plus output tokens, as reported. */
  tokens: number;
}

type Usage = Record<string, unknown>;
const tokensOf = (u: Usage | undefined, k: string): number =>
  typeof u?.[k] === 'number' ? (u[k] as number) : 0;

/** Read one Anthropic SSE response body (a tee'd copy) and add its reported usage to `turn`:
 * `message_start` carries the input side, the last `message_delta` the cumulative output. */
async function readUsage(body: ReadableStream<Uint8Array>, turn: ObservedTurn): Promise<void> {
  const decoder = new TextDecoder();
  let buf = '';
  let input = 0;
  let output = 0;
  let seen = false;
  const onData = (raw: string) => {
    let data: { type?: string; message?: { usage?: Usage }; usage?: Usage };
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      return;
    }
    if (data.type === 'message_start' && data.message?.usage) {
      const u = data.message.usage;
      seen = true;
      input =
        tokensOf(u, 'input_tokens') +
        tokensOf(u, 'cache_creation_input_tokens') +
        tokensOf(u, 'cache_read_input_tokens');
      output = tokensOf(u, 'output_tokens');
    } else if (data.type === 'message_delta' && data.usage) {
      seen = true;
      output = Math.max(output, tokensOf(data.usage, 'output_tokens'));
    }
  };
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) onData(line.slice(5).trim());
      }
    }
  } catch {
    // An aborted stream: count what arrived.
  }
  if (seen) {
    turn.reported += 1;
    turn.tokens += input + output;
  }
}

/** (c): exactly one SDK turn, ended naturally, every request reported usage, and the turn's
 * reported total stayed under the turn kind's budget. Prints only token counts. */
function expectNaturalUnderBudget(turns: ObservedTurn[], budget: number): void {
  expect(turns).toHaveLength(1);
  const [turn] = turns as [ObservedTurn];
  console.log(
    `[real sdk] model=${MODEL} ending=${turn.ending} requests=${turn.requests} ` +
      `reported=${turn.reported} tokens=${turn.tokens} budget=${budget}`,
  );
  expect(turn.ending).toBe('natural');
  expect(turn.requests).toBeGreaterThanOrEqual(1);
  expect(turn.reported, 'every model request reported its usage').toBe(turn.requests);
  expect(turn.tokens).toBeGreaterThan(0);
  expect(turn.tokens).toBeLessThan(budget);
}

const UTTERANCES: ReadonlyArray<readonly [string, string]> = [
  ['Host', 'Welcome back everyone, today we are planning the harbour shoot for next Tuesday.'],
  ['Guest', 'I scouted the pier yesterday and the morning light is best before eight.'],
  ['Host', 'Good, then we book the drone operator for a seven o clock call time.'],
  ['Guest', 'Also the fish market opens at six, so parking will be tight by the quay.'],
  ['Host', 'Next topic: the sound team wants a second boom for the interview on the boat.'],
  ['Guest', 'Agreed, the engine noise will be a problem, so we record a wild track too.'],
];

async function seedTranscript(sessionId: string): Promise<void> {
  const hub = await harnessHub(sessionId);
  let sec = 1;
  const p2 = (n: number) => String(n).padStart(2, '0');
  for (const [speaker, line] of UTTERANCES) {
    for (const word of line.split(/\s+/)) {
      const s = Math.floor(sec);
      await hub.insertTranscriptWord({
        session_time: `00:${p2(Math.floor(s / 60))}:${p2(s % 60)}`,
        speaker,
        word,
      });
      sec += 0.5;
    }
    sec += 1;
  }
}

/** Save the real `anthropic` credential for the default user through the providers route. */
async function saveAnthropicCredential(): Promise<void> {
  const res = await app.request(
    '/api/me/providers/llm',
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic', model: MODEL, api_key: KEY }),
    },
    env,
  );
  const text = await res.text();
  expect(text.includes(KEY)).toBe(false);
  expect(res.status).toBe(200);
}

describe.skipIf(!RUN)(
  'REAL Anthropic on the AI SDK route (opt-in: REAL_LLM_ANTHROPIC_KEY + vitest.real-sdk.config.ts)',
  () => {
    let captured = '';
    let turns: ObservedTurn[] = [];

    beforeEach(() => {
      captured = '';
      turns = [];
      // Capture (and still pass through) everything written to stdout and stderr, so the test can
      // assert the key never reached them.
      for (const stream of [process.stdout, process.stderr]) {
        const original = stream.write.bind(stream);
        vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
          captured +=
            typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString();
          return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
        }) as typeof stream.write);
      }
      // Observe each SDK turn without changing it: its ending from `runSdkTurn`'s result, and
      // Anthropic's reported usage from a tee of each response body the guarded fetch returns (the
      // guarded fetch still sees, caps and counts every byte).
      const runSdkTurn = sdkTurnModule.runSdkTurn;
      vi.spyOn(sdkTurnModule, 'runSdkTurn').mockImplementation(async (o) => {
        const turn: ObservedTurn = { ending: '', requests: 0, reported: 0, tokens: 0 };
        const readers: Array<Promise<void>> = [];
        const guarded = o.spec.deps.fetch;
        const fetch: typeof guarded = async (input, init) => {
          const res = await guarded(input, init);
          turn.requests += 1;
          if (!res.body) return res;
          const [mine, theirs] = res.body.tee();
          readers.push(readUsage(mine, turn));
          return new Response(theirs, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          });
        };
        const result = await runSdkTurn({
          ...o,
          spec: { ...o.spec, deps: { ...o.spec.deps, fetch } },
        });
        await Promise.all(readers);
        turn.ending = result.ending;
        turns.push(turn);
        return result;
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      expect(captured.includes(KEY), 'the key reached stdout or stderr').toBe(false);
    });

    it(
      '(a) a chat turn calls get_transcript_words, streams deltas and ends done with a null session id; (c) natural, under the chat budget',
      async () => {
        const { sessionId } = await seededSession();
        await seedTranscript(sessionId);
        await saveAnthropicCredential();

        const res = await app.request(
          `/api/sessions/${sessionId}/ai/chat`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              message:
                'Read the session transcript with your transcript tool, then tell me in one ' +
                'sentence what time the drone operator is booked for.',
            }),
          },
          env,
        );
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text.includes(KEY)).toBe(false);
        const events = parseSse(text);

        const tools = events.filter((e) => e.event === 'tool');
        expect(tools.map((e) => (e.data as { name: string }).name)).toContain(
          'get_transcript_words',
        );
        expect(events.some((e) => e.event === 'delta')).toBe(true);
        expect(events.at(-1)).toEqual({ event: 'done', data: { claude_session_id: null } });
        expect(events.filter((e) => e.event === 'done' || e.event === 'error')).toHaveLength(1);

        expectNaturalUnderBudget(turns, CHAT_BUDGET);
      },
      CASE_TIMEOUT_MS,
    );

    it(
      '(b) one topic generation answers 200 with at least one topic; (c) natural, under the generation budget',
      async () => {
        const { sessionId } = await seededSession();
        await seedTranscript(sessionId);
        await saveAnthropicCredential();

        const res = await app.request(
          `/api/sessions/${sessionId}/topics/generate`,
          { method: 'POST' },
          env,
        );
        const text = await res.text();
        expect(text.includes(KEY)).toBe(false);
        expect(res.status).toBe(200);
        const body = JSON.parse(text) as { topics: Array<{ summary: string }> };
        expect(body.topics.length).toBeGreaterThanOrEqual(1);
        for (const t of body.topics) expect(t.summary.trim().length).toBeGreaterThan(0);
        expect(await (await harnessHub(sessionId)).listTopics()).toHaveLength(body.topics.length);

        expectNaturalUnderBudget(turns, GENERATE_BUDGET);
      },
      CASE_TIMEOUT_MS,
    );
  },
);
