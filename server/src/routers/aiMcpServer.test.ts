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

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

/** Open an MCP client over real HTTP with the given bearer; caller closes. */
async function connectMcp(
  url: string,
  token: string,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return { client, close: () => transport.close() };
}

/** Drive one `list_topics` MCP call over real HTTP with the given bearer. */
async function listTopicsViaMcp(url: string, token: string): Promise<unknown[]> {
  const { client, close } = await connectMcp(url, token);
  try {
    const res = (await client.callTool({ name: 'list_topics', arguments: {} })) as ToolResult;
    return JSON.parse(res.content[0].text) as unknown[];
  } finally {
    await close();
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

describe('AiMcpListener — get_transcript_words returns COMPACT readable text', () => {
  it('renders speaker/timecode-prefixed text, NOT verbose per-word JSON', async () => {
    registry.get('sessA').replaceTranscriptWords([
      { session_time: '00:00:01', speaker: 'S1', word: 'hello', start_sec: 1, end_sec: 2 },
      { session_time: '00:00:02', speaker: 'S1', word: 'world', start_sec: 2, end_sec: 3 },
    ]);
    const turn = listener.registerTurn('sessA');
    const { client, close } = await connectMcp(turn.url, turn.token);
    try {
      const res = (await client.callTool({
        name: 'get_transcript_words',
        arguments: {},
      })) as ToolResult;
      const text = res.content[0].text;
      // Compact, readable text — the transcript words with a timecode + speaker
      // prefix (one line per speaker segment).
      expect(text).toBe('[00:00:01] speaker S1: hello world');
      // Load-bearing negatives (the overflow-causing regression this guards):
      // it must NOT be the verbose per-word JSON that produced a ~300KB single
      // line the CLI could not read.
      expect(text).not.toMatch(/"start_sec"|"created_at_utc"|"ordinal"|"session_id"/);
      expect(() => JSON.parse(text)).toThrow();
    } finally {
      await close();
      turn.dispose();
    }
  });

  it('handles an anchorless transcript (empty session_time) without a timecode prefix', async () => {
    registry.get('sessB').replaceTranscriptWords([
      { session_time: '', speaker: '0', word: 'rockets', start_sec: 0, end_sec: 0 },
      { session_time: '', speaker: '0', word: 'and', start_sec: 0, end_sec: 0 },
      { session_time: '', speaker: '0', word: 'coffee', start_sec: 0, end_sec: 0 },
    ]);
    const turn = listener.registerTurn('sessB');
    const { client, close } = await connectMcp(turn.url, turn.token);
    try {
      const res = (await client.callTool({
        name: 'get_transcript_words',
        arguments: {},
      })) as ToolResult;
      expect(res.content[0].text).toBe('speaker 0: rockets and coffee');
    } finally {
      await close();
      turn.dispose();
    }
  });

  it('renders a placeholder line for a session with no transcript', async () => {
    // No words inserted for sessC at all.
    const turn = listener.registerTurn('sessC');
    const { client, close } = await connectMcp(turn.url, turn.token);
    try {
      const res = (await client.callTool({
        name: 'get_transcript_words',
        arguments: {},
      })) as ToolResult;
      expect(res.content[0].text).toBe('(this session has no transcript)');
    } finally {
      await close();
      turn.dispose();
    }
  });

  it('keeps a speaker flip-back (A→B→A) as three separate segments, never merged', async () => {
    registry.get('sessD').replaceTranscriptWords([
      { session_time: '00:00:01', speaker: 'S1', word: 'hello', start_sec: 1, end_sec: 2 },
      { session_time: '00:00:02', speaker: 'S2', word: 'hi', start_sec: 2, end_sec: 3 },
      { session_time: '00:00:03', speaker: 'S1', word: 'bye', start_sec: 3, end_sec: 4 },
    ]);
    const turn = listener.registerTurn('sessD');
    const { client, close } = await connectMcp(turn.url, turn.token);
    try {
      const res = (await client.callTool({
        name: 'get_transcript_words',
        arguments: {},
      })) as ToolResult;
      expect(res.content[0].text).toBe(
        '[00:00:01] speaker S1: hello\n[00:00:02] speaker S2: hi\n[00:00:03] speaker S1: bye',
      );
    } finally {
      await close();
      turn.dispose();
    }
  });

  it('fills a segment timecode from a later word when the first word of the segment lacks one', async () => {
    registry.get('sessE').replaceTranscriptWords([
      { session_time: '', speaker: 'S1', word: 'foo', start_sec: 0, end_sec: 0 },
      { session_time: '00:00:05', speaker: 'S1', word: 'bar', start_sec: 5, end_sec: 6 },
    ]);
    const turn = listener.registerTurn('sessE');
    const { client, close } = await connectMcp(turn.url, turn.token);
    try {
      const res = (await client.callTool({
        name: 'get_transcript_words',
        arguments: {},
      })) as ToolResult;
      expect(res.content[0].text).toBe('[00:00:05] speaker S1: foo bar');
    } finally {
      await close();
      turn.dispose();
    }
  });

  it('emits no "speaker" prefix when the speaker field is blank', async () => {
    registry.get('sessF').replaceTranscriptWords([
      { session_time: '00:00:09', speaker: '', word: 'alpha', start_sec: 9, end_sec: 10 },
      { session_time: '00:00:09', speaker: '', word: 'beta', start_sec: 10, end_sec: 11 },
    ]);
    const turn = listener.registerTurn('sessF');
    const { client, close } = await connectMcp(turn.url, turn.token);
    try {
      const res = (await client.callTool({
        name: 'get_transcript_words',
        arguments: {},
      })) as ToolResult;
      // No dangling "speaker :" — just the timecode and the words.
      expect(res.content[0].text).toBe('[00:00:09] alpha beta');
    } finally {
      await close();
      turn.dispose();
    }
  });
});

describe('AiMcpListener — create_topic writes through SessionHub.insertTopic', () => {
  /** Drive one create_topic MCP call; returns the raw tool result. */
  async function createTopicViaMcp(
    url: string,
    token: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const { client, close } = await connectMcp(url, token);
    try {
      return (await client.callTool({ name: 'create_topic', arguments: args })) as ToolResult;
    } finally {
      await close();
    }
  }

  it('produces a row indistinguishable from a manual insert (server ordinal, no WS)', async () => {
    // Manual reference: two inserts straight through the hub.
    const manualHub = registry.get('manual');
    const payloads = [
      { session_time: '00:00:01', duration_sec: 5, topic_level: 2, summary: 'first' },
      { session_time: '00:00:09', duration_sec: 8, topic_level: 3, summary: 'second' },
    ];
    for (const p of payloads) manualHub.insertTopic(p);

    // AI path: same two payloads via the MCP create_topic tool on session 'ai'.
    // Attach a spy socket to prove create_topic emits NO WS message.
    const sent: string[] = [];
    registry.get('ai').attachSocket({ send: (d) => sent.push(d) }, 'browser');
    const turn = listener.registerTurn('ai');
    for (const p of payloads) {
      const res = await createTopicViaMcp(turn.url, turn.token, p);
      expect(res.isError).toBeFalsy();
    }
    turn.dispose();

    // No WS emission for topics — matching manual-insert behavior (topics have
    // no fan-out; the MCP path introduces none).
    expect(sent).toEqual([]);

    // Byte-identical rows apart from the non-deterministic id/created_at_utc:
    // both paths get server-assigned contiguous ordinals from 0.
    const strip = (t: { id: string; created_at_utc: string }): Record<string, unknown> => {
      const { id: _id, created_at_utc: _c, ...rest } = t;
      return rest;
    };
    const manualRows = manualHub.listTopics().map(strip);
    const aiRows = registry.get('ai').listTopics().map(strip);
    expect(aiRows).toEqual(manualRows);
    // Ordinals are server-assigned (0,1), not supplied by the tool caller.
    expect(aiRows.map((r) => r.ordinal)).toEqual([0, 1]);
  });

  it('rejects out-of-bounds input safely: isError, no insert, turn continues', async () => {
    const turn = listener.registerTurn('ai');
    // topic_level 99 violates topicCreateSchema's 1–10 bound.
    const bad = await createTopicViaMcp(turn.url, turn.token, {
      session_time: '00:00:01',
      duration_sec: 1,
      topic_level: 99,
      summary: 'too deep',
    });
    expect(bad.isError).toBe(true);
    expect(registry.get('ai').listTopics()).toHaveLength(0);

    // The turn continues — a subsequent valid call still works.
    const ok = await createTopicViaMcp(turn.url, turn.token, {
      session_time: '00:00:02',
      duration_sec: 2,
      topic_level: 5,
      summary: 'ok now',
    });
    expect(ok.isError).toBeFalsy();
    expect(registry.get('ai').listTopics()).toHaveLength(1);
    turn.dispose();
  });

  it('create_topic exposes no session parameter (cannot address another session)', async () => {
    const turn = listener.registerTurn('ai');
    const { client, close } = await connectMcp(turn.url, turn.token);
    try {
      const { tools } = await client.listTools();
      const createTopic = tools.find((t) => t.name === 'create_topic');
      expect(createTopic).toBeDefined();
      const props = (createTopic?.inputSchema?.properties ?? {}) as Record<string, unknown>;
      // The parameter surface is exactly the topic fields — no session id knob.
      expect(Object.keys(props).sort()).toEqual([
        'duration_sec',
        'session_time',
        'summary',
        'topic_level',
      ]);
    } finally {
      await close();
      turn.dispose();
    }
  });

  it('writes only the bound session, never a sibling (turn A cannot reach B)', async () => {
    registry.get('sessA'); // materialize
    registry.get('sessB');
    const turnA = listener.registerTurn('sessA');
    const res = await createTopicViaMcp(turnA.url, turnA.token, {
      session_time: '00:00:01',
      duration_sec: 1,
      topic_level: 1,
      summary: 'for A',
    });
    expect(res.isError).toBeFalsy();
    turnA.dispose();

    expect(registry.get('sessA').listTopics()).toHaveLength(1);
    // Session B is untouched — the write is hard-bound to the registration.
    expect(registry.get('sessB').listTopics()).toHaveLength(0);
  });
});
