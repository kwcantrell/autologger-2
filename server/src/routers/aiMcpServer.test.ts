// ai-topics-chat (task 2.1) — the in-process loopback MCP listener seam.
// SECURITY properties under test (gate-intent): loopback-only bind,
// token-required at the HTTP layer before dispatch, and no cross-talk between
// concurrent turns on distinct sessions. These assert the security boundary,
// not merely that the listener boots.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SessionHubRegistry } from '../session/SessionHub';
import { AiMcpListener } from './aiMcpServer';

let dir: string;
let registry: SessionHubRegistry;
let listener: AiMcpListener;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ai-mcp-'));
  registry = new SessionHubRegistry(join(dir, 'sessions'));
  listener = new AiMcpListener(registry);
  await listener.start();
});

afterEach(async () => {
  await listener.close();
  registry.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

/** Drive one `list_topics` MCP call over real HTTP with the given bearer. */
async function listTopicsViaMcp(url: string, token: string): Promise<unknown[]> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  try {
    await client.connect(transport);
    const res = (await client.callTool({ name: 'list_topics', arguments: {} })) as {
      content: Array<{ type: string; text: string }>;
    };
    return JSON.parse(res.content[0].text) as unknown[];
  } finally {
    await transport.close();
  }
}

describe('AiMcpListener — loopback bind', () => {
  it('binds 127.0.0.1, never a non-loopback address', () => {
    const addr = listener.address;
    expect(addr).not.toBeNull();
    expect(addr?.address).toBe('127.0.0.1');
    expect(addr?.port).toBeGreaterThan(0);
  });
});

describe('AiMcpListener — HTTP-layer bearer check', () => {
  it('mints a ≥128-bit bearer token per turn', () => {
    const turn = listener.registerTurn('sessA');
    // hex-encoded 32 bytes = 64 chars = 256 bits (≥128).
    expect(turn.token).toMatch(/^[0-9a-f]{64}$/);
    turn.dispose();
  });

  it('rejects a request with NO Authorization header (401), no dispatch', async () => {
    const turn = listener.registerTurn('sessA');
    const res = await fetch(turn.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    turn.dispose();
  });

  it('rejects an unknown/garbage bearer token (401)', async () => {
    const turn = listener.registerTurn('sessA');
    const res = await fetch(turn.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer not-a-real-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    turn.dispose();
  });

  it('rejects a stale (dropped) token after dispose() (401)', async () => {
    const turn = listener.registerTurn('sessA');
    const { url, token } = turn;
    turn.dispose();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(listener.registrationCount).toBe(0);
  });

  it('accepts a live token and exposes the three tool names', async () => {
    const turn = listener.registerTurn('sessA');
    const client = new Client({ name: 'test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(turn.url), {
      requestInit: { headers: { Authorization: `Bearer ${turn.token}` } },
    });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'create_topic',
        'get_transcript_words',
        'list_topics',
      ]);
    } finally {
      await transport.close();
      turn.dispose();
    }
  });
});

describe('AiMcpListener — no cross-talk between concurrent turns', () => {
  it('two turns on distinct sessions each resolve to their own session', async () => {
    // Seed distinct topic data per session through the real hub.
    registry.get('sessA').insertTopic({
      session_time: '00:00:01',
      duration_sec: 5,
      topic_level: 1,
      summary: 'A-only topic',
    });
    registry.get('sessB').insertTopic({
      session_time: '00:00:02',
      duration_sec: 6,
      topic_level: 2,
      summary: 'B-first',
    });
    registry.get('sessB').insertTopic({
      session_time: '00:00:03',
      duration_sec: 7,
      topic_level: 3,
      summary: 'B-second',
    });

    const turnA = listener.registerTurn('sessA');
    const turnB = listener.registerTurn('sessB');

    // Concurrent calls, one per turn — the session is bound by the token's
    // registration, not by any tool parameter.
    const [topicsA, topicsB] = await Promise.all([
      listTopicsViaMcp(turnA.url, turnA.token),
      listTopicsViaMcp(turnB.url, turnB.token),
    ]);

    expect(topicsA).toHaveLength(1);
    expect((topicsA[0] as { summary: string }).summary).toBe('A-only topic');

    expect(topicsB).toHaveLength(2);
    expect((topicsB as Array<{ summary: string }>).map((t) => t.summary)).toEqual([
      'B-first',
      'B-second',
    ]);

    turnA.dispose();
    turnB.dispose();
  });
});
