// The route's AI SDK deps (ai-sdk-agent-harness D4 step 3, task 6.7): the guarded fetch that
// `sdkTurnSpec` builds for a turn cuts its responses at that turn's own derived cap,
// `steps × maxOutputTokens × 400` bytes (chat's output cap fixed at 4000).

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Context } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../appEnv';
import { OutboundFailure } from '../auth/providerOutbound';
import { type SdkLlmRoute, sdkTurnSpec } from './_aiRoute';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** A loopback server streaming `total` bytes of SSE-ish data in 64 KB chunks. */
async function streaming(total: number): Promise<string> {
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let sent = 0;
    const pump = () => {
      while (sent < total) {
        sent += chunk.length;
        if (!res.write(chunk)) {
          res.once('drain', pump);
          return;
        }
      }
      res.end();
    };
    pump();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const ctx = { env: { config: { PROVIDER_DEV_MODE: true } } } as unknown as Context<AppEnv>;

async function readAll(origin: string, spec: ReturnType<typeof sdkTurnSpec>) {
  const r = await spec.deps.fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    body: '{}',
    headers: { 'content-type': 'application/json' },
  });
  const reader = (r.body as ReadableStream<Uint8Array>).getReader();
  let got = 0;
  const err = await (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return null;
      got += value.length;
    }
  })().catch((e: unknown) => e);
  return { got, err };
}

describe('sdkTurnSpec: the response-byte cap is the turn’s own (D4 step 3, task 6.7)', () => {
  const routeAt = (origin: string): SdkLlmRoute => ({
    kind: 'sdk',
    provider: 'openai-compatible',
    baseUrl: `${origin}/v1`,
    baseOrigin: origin,
    model: 'qwen3',
    apiKey: 'sk-test',
  });

  it('chat: steps × 4000 × 400 (1 step: 1.6 MB), whatever maxOutputTokens says', async () => {
    const origin = await streaming(3 * 1024 * 1024);
    const spec = sdkTurnSpec(ctx, routeAt(origin), 'chat', {
      maxSteps: 1,
      maxTotalTokens: 1,
      maxOutputTokens: 128_000,
    });
    const { got, err } = await readAll(origin, spec);
    expect(err).toBeInstanceOf(OutboundFailure);
    expect(spec.deps.breach()).toBe('response-total');
    expect(got).toBeLessThanOrEqual(1_600_000);
    expect(got).toBeGreaterThan(1_400_000);
  });

  it('generation: steps × maxOutputTokens × 400 (2 steps × 1000: 800 KB)', async () => {
    const origin = await streaming(3 * 1024 * 1024);
    const spec = sdkTurnSpec(ctx, routeAt(origin), 'topics', {
      maxSteps: 2,
      maxTotalTokens: 1,
      maxOutputTokens: 1000,
    });
    const { got, err } = await readAll(origin, spec);
    expect(err).toBeInstanceOf(OutboundFailure);
    expect(spec.deps.breach()).toBe('response-total');
    expect(got).toBeLessThanOrEqual(800_000);
    expect(got).toBeGreaterThan(600_000);
  });

  it('a stream under the cap passes whole', async () => {
    const origin = await streaming(512 * 1024);
    const spec = sdkTurnSpec(ctx, routeAt(origin), 'events', {
      maxSteps: 2,
      maxTotalTokens: 1,
      maxOutputTokens: 1000,
    });
    const { got, err } = await readAll(origin, spec);
    expect(err).toBeNull();
    expect(got).toBe(512 * 1024);
    expect(spec.deps.breach()).toBeNull();
  });
});
