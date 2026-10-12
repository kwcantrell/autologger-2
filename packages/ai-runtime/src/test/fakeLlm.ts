// A local fake OpenAI-compatible chat-completions server for the AI SDK turn tests
// (ai-sdk-agent-harness task 6.3). Each request is answered by a script `(n, body) => FakeReply`,
// `n` counting from 1, so a test scripts tool calls, finish reasons, usage, errors, a dropped
// stream or a stream that never ends. It records every parsed request body and which upstream
// sockets closed. Loopback only. Imports no vitest, so it needs no test-infrastructure exemption.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeReply {
  /** HTTP status (default 200). A non-200 answers `body` as JSON. */
  status?: number;
  /** A non-200 answer's body. */
  body?: string;
  /** SSE `data:` payloads, written in order (`[DONE]` is appended unless `hang` or `drop`). */
  frames?: readonly unknown[];
  /** Write the frames, then destroy the socket mid-response. */
  drop?: boolean;
  /** Write the frames, then never end the response. */
  hang?: boolean;
}

export type FakeScript = (n: number, body: Record<string, unknown>) => FakeReply;

export interface FakeLlm {
  /** `http://127.0.0.1:<port>/v1` */
  readonly baseURL: string;
  /** Every request body, parsed, in order. */
  readonly requests: Array<Record<string, unknown>>;
  /** Every request's path and headers, in order. */
  readonly meta: Array<{ path: string; headers: http.IncomingHttpHeaders }>;
  /** How many request sockets have closed. */
  closed(): number;
  close(): Promise<void>;
}

export async function startFakeLlm(script: FakeScript): Promise<FakeLlm> {
  const requests: Array<Record<string, unknown>> = [];
  const meta: Array<{ path: string; headers: http.IncomingHttpHeaders }> = [];
  let closed = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    res.on('close', () => {
      closed += 1;
    });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = {};
      }
      requests.push(body);
      meta.push({ path: req.url ?? '', headers: req.headers });
      const reply = script(requests.length, body);
      const status = reply.status ?? 200;
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(reply.body ?? '{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const f of reply.frames ?? []) res.write(`data: ${JSON.stringify(f)}\n\n`);
      if (reply.drop) {
        res.socket?.destroy();
        return;
      }
      if (reply.hang) return;
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    meta,
    closed: () => closed,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: 'c',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

/** SSE payload builders in the OpenAI chat-completions streaming shape. */
export const sse = {
  text: (t: string) => chunk({ role: 'assistant', content: t }),
  reasoning: (t: string) => chunk({ role: 'assistant', reasoning_content: t }),
  /** One chunk carrying `calls` tool calls; `step` keeps the call ids unique across steps. */
  toolCalls: (step: number, calls: ReadonlyArray<{ name: string; args?: unknown }>) =>
    chunk({
      role: 'assistant',
      tool_calls: calls.map((c, i) => ({
        index: i,
        id: `call_${step}_${i}`,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      })),
    }),
  /** The final chunk; `usage` omitted means the server reports none. */
  finish: (reason: string, usage?: { prompt: number; completion: number }) => ({
    ...chunk({}, reason),
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.prompt,
            completion_tokens: usage.completion,
            total_tokens: usage.prompt + usage.completion,
          },
        }
      : {}),
  }),
};

/** A natural final answer: text, then `stop` with usage. */
export const answer = (t: string): FakeReply => ({
  frames: [sse.text(t), sse.finish('stop', { prompt: 10, completion: 5 })],
});

/** One step of tool calls, finished `tool_calls` with usage (`usage: null` reports none). */
export const callTools = (
  step: number,
  calls: ReadonlyArray<{ name: string; args?: unknown }>,
  reason = 'tool_calls',
  usage: { prompt: number; completion: number } | null = { prompt: 10, completion: 5 },
): FakeReply => ({ frames: [sse.toolCalls(step, calls), sse.finish(reason, usage ?? undefined)] });
