// ai-topics-chat (task 2.1) — the in-process loopback MCP listener seam.
// SECURITY properties under test (gate-intent): loopback-only bind,
// token-required at the HTTP layer before dispatch, and no cross-talk between
// concurrent turns on distinct sessions. These assert the security boundary,
// not merely that the listener boots.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionHub, SessionHubRegistry } from '../session/SessionHub';
import {
  type AiGenerationRunContext,
  type AiGenerationSnapshotWord,
  AiMcpListener,
  type AiMcpTurnContext,
  allTranscriptPagesServed,
  GENERATION_LINE_MAX_WORDS,
  GENERATION_PAGE_SIZE_WORDS,
} from './aiMcpServer';

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

describe('AiMcpListener — per-turn tool registration (auto-generate-event-logs 3.1)', () => {
  // Spec (ai-topics-chat, "Chat turns cannot write events"): a chat turn's MCP
  // server does not register `create_event` — denial at the SERVER, independent
  // of CLI flags. Default (context-less) registration byte-identity to today is
  // additionally pinned by the pre-existing tests above ('accepts a live token
  // and exposes the three tool names' and every other context-less test here).
  it('chat (context-less) turn: create_event is not registered — a call fails at the server', async () => {
    const turn = listener.registerTurn('sessA');
    const { client, close } = await connectMcp(turn.url, turn.token);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).not.toContain('create_event');
      // Server-side denial: the call errors at the MCP server (tool not found
      // as a tool error or protocol error), and no event machinery runs.
      const denied = await client
        .callTool({ name: 'create_event', arguments: {} })
        .then((res) => res as ToolResult)
        .catch((err: Error) => err);
      if (denied instanceof Error) {
        expect(denied.message).toMatch(/create_event|not found|unknown/i);
      } else {
        expect(denied.isError).toBe(true);
      }
    } finally {
      await close();
      turn.dispose();
    }
  });

  it('a turn context naming only get_transcript_words registers exactly that one tool', async () => {
    registry
      .get('sessG')
      .replaceTranscriptWords([
        { session_time: '00:00:01', speaker: 'S1', word: 'solo', start_sec: 1, end_sec: 2 },
      ]);
    const turn = listener.registerTurn('sessG', { tools: ['get_transcript_words'] });
    const { client, close } = await connectMcp(turn.url, turn.token);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['get_transcript_words']);
      // The named tool works…
      const res = (await client.callTool({
        name: 'get_transcript_words',
        arguments: {},
      })) as ToolResult;
      expect(res.content[0].text).toBe('[00:00:01] speaker S1: solo');
      // …and an unnamed registry tool is denied at the server.
      const denied = await client
        .callTool({ name: 'create_topic', arguments: { summary: 'nope' } })
        .then((res2) => res2 as ToolResult)
        .catch((err: Error) => err);
      if (denied instanceof Error) {
        expect(denied.message).toMatch(/create_topic|not found|unknown/i);
      } else {
        expect(denied.isError).toBe(true);
      }
      expect(registry.get('sessG').listTopics()).toHaveLength(0);
    } finally {
      await close();
      turn.dispose();
    }
  });

  it('carries a generation run snapshot on the registration (3.2/3.3 consume it)', async () => {
    registry
      .get('sessH')
      .replaceTranscriptWords([
        { session_time: '00:00:02', speaker: 'S1', word: 'gen', start_sec: 2, end_sec: 3 },
      ]);
    // A generation-shaped registration: tool set + full run snapshot, threaded
    // through registration to the tool builders. `get_transcript_words` now
    // renders at generation density under a snapshot (task 3.3) — for this
    // single-word transcript the rendered page is identical to the chat line.
    const turn = listener.registerTurn('sessH', {
      tools: ['get_transcript_words'],
      generation: {
        runId: 'run-123',
        frameRate: 29.97,
        startOffsetFrames: 0,
        startedAtUtc: '2026-07-29T00:00:00Z',
        cap: 200,
        categories: [
          {
            id: 'cat1',
            name: 'SLATE',
            type: 'BUTTON',
            color: '#ff0000',
            auto_instruction: 'log every slate',
            dropdown_options: [],
          },
          {
            id: 'cat2',
            name: 'MIC',
            type: 'DROPDOWN',
            color: '#00ff00',
            dropdown_options: [
              { label: 'Lav', needs_context: true, auto_instruction: 'log lav swaps' },
              { label: 'Boom', needs_context: false },
            ],
          },
        ],
      },
    });
    const { client, close } = await connectMcp(turn.url, turn.token);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['get_transcript_words']);
      const res = (await client.callTool({
        name: 'get_transcript_words',
        arguments: {},
      })) as ToolResult;
      expect(res.content[0].text).toBe('[00:00:02] speaker S1: gen');
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

// ── create_event (auto-generate-event-logs task 3.2, design D4/D6) ──────────
//
// Spec anchors: "Events are anchored at transcript timecodes" (grammar/bounds,
// snapshot allowlist, `internal` denial, tool-error-never-throw) and
// "Generated events append, bounded and attributable" (per-run cap naming the
// cap, metadata attribution + UI snapshots, manual-insert side effects).
//
// The chat-side complement stays pinned by the 3.1 tests above: 'chat
// (context-less) turn: create_event is not registered' (server-side denial)
// and 'accepts a live token and exposes the three tool names' (the
// DEFAULT_TURN_TOOLS pin).

/** Frames helper at a given fps. */
const framesAt = (fps: number, h: number, m: number, s: number, f = 0): number =>
  (h * 3600 + m * 60 + s) * Math.round(fps) + f;

/** A generation turn context over two instruction-bearing categories.
 * `#FF0000` (uppercase) pins the snapshot-merge hex normalization. */
function genContext(overrides: Partial<AiGenerationRunContext> = {}): AiMcpTurnContext {
  return {
    tools: ['get_transcript_words', 'create_event'],
    generation: {
      runId: 'run-1',
      frameRate: 24,
      startOffsetFrames: 0,
      startedAtUtc: '2026-01-01T00:00:00.000Z',
      cap: 200,
      categories: [
        {
          id: 'cat1',
          name: 'SLATE',
          type: 'BUTTON',
          color: '#FF0000',
          auto_instruction: 'log slates',
          dropdown_options: [],
        },
        {
          id: 'cat2',
          name: 'MIC',
          type: 'DROPDOWN',
          color: '#00ff00',
          dropdown_options: [{ label: 'Lav', needs_context: true, auto_instruction: 'lav swaps' }],
        },
      ],
      ...overrides,
    },
  };
}

/** Drive one create_event MCP call; returns the raw tool result. */
async function createEventViaMcp(
  url: string,
  token: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const { client, close } = await connectMcp(url, token);
  try {
    return (await client.callTool({ name: 'create_event', arguments: args })) as ToolResult;
  } finally {
    await close();
  }
}

function listEventRows(sessionId: string): Array<{
  event_id: string;
  category: string;
  message: string;
  timecode: string | null;
  frame_rate: number | null;
  wall_time_utc: string;
  metadata_json: string;
}> {
  return registry.get(sessionId).listEvents({ limit: 1000, offset: 0 }).events;
}

describe('create_event — registration surface (3.2)', () => {
  it('a generation turn registers exactly its two tools', async () => {
    const turn = listener.registerTurn('gen-reg', genContext());
    const { client, close } = await connectMcp(turn.url, turn.token);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['create_event', 'get_transcript_words']);
    } finally {
      await close();
      turn.dispose();
    }
  });

  it('create_event exposes no session parameter (cannot address another session)', async () => {
    const turn = listener.registerTurn('gen-shape', genContext());
    const { client, close } = await connectMcp(turn.url, turn.token);
    try {
      const { tools } = await client.listTools();
      const createEvent = tools.find((t) => t.name === 'create_event');
      expect(createEvent).toBeDefined();
      const props = (createEvent?.inputSchema?.properties ?? {}) as Record<string, unknown>;
      expect(Object.keys(props).sort()).toEqual(['category', 'message', 'session_time']);
    } finally {
      await close();
      turn.dispose();
    }
  });

  it('registered WITHOUT a generation snapshot: tool error, no insert, no crash', async () => {
    // Defensive arm: a caller that registers create_event but omits the run
    // snapshot gets a tool error — never a thrown crash, never an insert.
    const turn = listener.registerTurn('gen-noctx', { tools: ['create_event'] });
    const res = await createEventViaMcp(turn.url, turn.token, {
      category: 'cat1',
      message: 'SLATE',
      session_time: '00:00:01:00',
    });
    expect(res.isError).toBe(true);
    expect(listEventRows('gen-noctx')).toHaveLength(0);
    turn.dispose();
  });
});

describe('create_event — category allowlist + internal denial (3.2)', () => {
  it('rejects a category id outside the run snapshot: tool error, no insert', async () => {
    const turn = listener.registerTurn('gen-cat', genContext());
    const res = await createEventViaMcp(turn.url, turn.token, {
      category: 'not-in-snapshot',
      message: 'hi',
      session_time: '00:00:01:00',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/category/i);
    expect(listEventRows('gen-cat')).toHaveLength(0);

    // The turn continues — a valid call after the rejection still works.
    const ok = await createEventViaMcp(turn.url, turn.token, {
      category: 'cat1',
      message: 'SLATE',
      session_time: '00:00:01:00',
    });
    expect(ok.isError).toBeFalsy();
    expect(listEventRows('gen-cat')).toHaveLength(1);
    turn.dispose();
  });

  it("rejects 'internal' in ANY casing even when the snapshot itself carries such an id", async () => {
    // Belt-and-braces: even a (mis-built) snapshot containing an
    // internal-cased id must not make transport rows writable.
    const ctx = genContext({
      categories: [
        {
          id: 'INTERNAL',
          name: 'sneaky',
          type: 'BUTTON',
          color: '#123456',
          auto_instruction: 'x',
          dropdown_options: [],
        },
      ],
    });
    const turn = listener.registerTurn('gen-internal', ctx);
    for (const casing of ['internal', 'INTERNAL', 'Internal', 'iNtErNaL']) {
      const res = await createEventViaMcp(turn.url, turn.token, {
        category: casing,
        message: 'Recording 9 Started',
        session_time: '00:00:01:00',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/internal/i);
    }
    expect(listEventRows('gen-internal')).toHaveLength(0);
    turn.dispose();
  });
});

describe('create_event — timecode grammar/bounds (3.2, trust boundary)', () => {
  it.each([
    ['malformed text', 'not-a-timecode'],
    ['negative-ish form', '-1:00:00'],
    ['≥ 24h', '24:00:00'],
    ['minutes out of range', '00:61:00'],
    ['seconds out of range', '00:00:61'],
    ['frames at/over the rate (24fps)', '00:00:00:24'],
    ['empty', ''],
  ])('rejects %s (%j): tool error, no insert, no crash', async (_label, sessionTime) => {
    const turn = listener.registerTurn('gen-tc', genContext());
    const res = await createEventViaMcp(turn.url, turn.token, {
      category: 'cat1',
      message: 'SLATE',
      session_time: sessionTime,
    });
    expect(res.isError).toBe(true);
    expect(listEventRows('gen-tc')).toHaveLength(0);
    turn.dispose();
  });

  it('accepts the drop-frame `;` grammar at 29.97 and round-trips the timecode', async () => {
    const turn = listener.registerTurn('gen-df', genContext({ frameRate: 29.97 }));
    const res = await createEventViaMcp(turn.url, turn.token, {
      category: 'cat1',
      message: 'SLATE',
      session_time: '00:14:03;12',
    });
    expect(res.isError).toBeFalsy();
    const rows = listEventRows('gen-df');
    expect(rows).toHaveLength(1);
    // formatSmpte round-trip: 29.97 renders with the `;` separator.
    expect(rows[0].timecode).toBe('00:14:03;12');
    expect(rows[0].frame_rate).toBe(29.97);
    turn.dispose();
  });
});

describe('create_event — message bounds mirror logBodySchema (3.2)', () => {
  it.each([
    ['empty message', ''],
    ['over-long message (8001 chars)', 'x'.repeat(8001)],
  ])('rejects %s: tool error, no insert', async (_label, message) => {
    const turn = listener.registerTurn('gen-msg', genContext());
    const res = await createEventViaMcp(turn.url, turn.token, {
      category: 'cat1',
      message,
      session_time: '00:00:01:00',
    });
    expect(res.isError).toBe(true);
    expect(listEventRows('gen-msg')).toHaveLength(0);
    turn.dispose();
  });

  it('accepts a message at exactly the 8000-char bound', async () => {
    const turn = listener.registerTurn('gen-msg8k', genContext());
    const res = await createEventViaMcp(turn.url, turn.token, {
      category: 'cat1',
      message: 'y'.repeat(8000),
      session_time: '00:00:01:00',
    });
    expect(res.isError).toBeFalsy();
    expect(listEventRows('gen-msg8k')).toHaveLength(1);
    turn.dispose();
  });
});

describe('create_event — success path (3.2)', () => {
  it('creates the event with zero anchors from snapshot session fields, returning the row', async () => {
    const turn = listener.registerTurn('gen-ok', genContext());
    const res = await createEventViaMcp(turn.url, turn.token, {
      category: 'cat1',
      message: 'SLATE',
      session_time: '01:00:00:00',
    });
    expect(res.isError).toBeFalsy();
    const created = JSON.parse(res.content[0].text) as Record<string, unknown>;
    expect(created.event_id).toBeTruthy();
    expect(created.category).toBe('cat1');
    expect(created.message).toBe('SLATE');
    expect(created.timecode).toBe('01:00:00:00');
    // Zero-anchor arm: wall = snapshot started_at_utc + (tc − offset)/fps —
    // 1h of timecode at 24fps from 2026-01-01T00:00:00Z.
    expect(created.wall_time_utc).toBe('2026-01-01T01:00:00.000Z');
    // And it is the persisted row, via the one insert path.
    const rows = listEventRows('gen-ok');
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBe(created.event_id);
    turn.dispose();
  });

  it('composes metadata with EXACTLY the attribution + UI-snapshot keys', async () => {
    const turn = listener.registerTurn('gen-meta', genContext());
    const res = await createEventViaMcp(turn.url, turn.token, {
      category: 'cat1',
      message: 'SLATE',
      session_time: '00:00:05:00',
    });
    expect(res.isError).toBeFalsy();
    const rows = listEventRows('gen-meta');
    const meta = JSON.parse(rows[0].metadata_json) as Record<string, unknown>;
    // Exact composition: attribution pair + the SAME snapshot keys the manual
    // route writes (label from the snapshot's name, hex color normalized).
    expect(meta).toEqual({
      auto_generated: true,
      auto_generate_run_id: 'run-1',
      al_category_label_snapshot: 'SLATE',
      al_category_color_snapshot: '#ff0000',
    });
    turn.dispose();
  });

  it('emits one event.changed broadcast per insert (manual-insert semantics, not suppressed)', async () => {
    const sent: string[] = [];
    registry.get('gen-ws').attachSocket({ send: (d) => sent.push(d) }, 'browser');
    const turn = listener.registerTurn('gen-ws', genContext());
    for (const t of ['00:00:01:00', '00:00:02:00']) {
      const res = await createEventViaMcp(turn.url, turn.token, {
        category: 'cat1',
        message: 'SLATE',
        session_time: t,
      });
      expect(res.isError).toBeFalsy();
    }
    const frames = sent.map((d) => JSON.parse(d) as { type: string });
    expect(frames.filter((f) => f.type === 'event.changed')).toHaveLength(2);
    turn.dispose();
  });
});

describe('create_event — per-run cap (3.2)', () => {
  it('at the cap: tool error NAMING the cap, no insert; counter visible on the turn', async () => {
    const turn = listener.registerTurn('gen-cap', genContext({ cap: 2 }));
    for (const t of ['00:00:01:00', '00:00:02:00']) {
      const res = await createEventViaMcp(turn.url, turn.token, {
        category: 'cat1',
        message: 'SLATE',
        session_time: t,
      });
      expect(res.isError).toBeFalsy();
    }
    const denied = await createEventViaMcp(turn.url, turn.token, {
      category: 'cat1',
      message: 'SLATE',
      session_time: '00:00:03:00',
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain('2'); // names the cap value
    expect(denied.content[0].text).toMatch(/cap/i);
    expect(listEventRows('gen-cap')).toHaveLength(2);
    expect(turn.createdEvents()).toBe(2);
    turn.dispose();
  });

  it('failed calls never consume the cap — the counter increments only on successful insert', async () => {
    const turn = listener.registerTurn('gen-cap1', genContext({ cap: 1 }));
    // Two failures first (bad category, bad timecode)…
    const badCat = await createEventViaMcp(turn.url, turn.token, {
      category: 'nope',
      message: 'x',
      session_time: '00:00:01:00',
    });
    expect(badCat.isError).toBe(true);
    const badTc = await createEventViaMcp(turn.url, turn.token, {
      category: 'cat1',
      message: 'x',
      session_time: '99:99:99',
    });
    expect(badTc.isError).toBe(true);
    expect(turn.createdEvents()).toBe(0);
    // …the single capped slot is still available…
    const ok = await createEventViaMcp(turn.url, turn.token, {
      category: 'cat1',
      message: 'SLATE',
      session_time: '00:00:01:00',
    });
    expect(ok.isError).toBeFalsy();
    expect(turn.createdEvents()).toBe(1);
    // …and now the cap holds.
    const denied = await createEventViaMcp(turn.url, turn.token, {
      category: 'cat1',
      message: 'SLATE',
      session_time: '00:00:02:00',
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain('1');
    expect(listEventRows('gen-cap1')).toHaveLength(1);
    turn.dispose();
  });
});

describe('create_event — counter reflects only successful inserts (3.2)', () => {
  it(
    'an insert-time failure (hub.createAnchoredEvent throws) returns isError and leaves the per-run ' +
      'counter unchanged; a subsequent real success reports a count that excludes the failed attempt',
    async () => {
      const turn = listener.registerTurn('gen-fault', genContext({ cap: 5 }));
      // Force the ONE insert path itself to fail — distinct from the
      // pre-insert validation failures covered by the "per-run cap" describe
      // above, which never reach `hub.createAnchoredEvent` at all and so
      // can't tell apart an increment placed before vs. after the insert
      // call. package-split-foundation D6: the tool body now calls the
      // transactional `createAnchoredEvent` RPC directly (not the
      // `SessionHub.addEvent` delegate), so the spy targets that RPC.
      const spy = vi
        .spyOn(SessionHub.prototype, 'createAnchoredEvent')
        .mockImplementationOnce(() => {
          throw new Error('simulated insert fault');
        });
      try {
        const faulted = await createEventViaMcp(turn.url, turn.token, {
          category: 'cat1',
          message: 'SLATE',
          session_time: '00:00:01:00',
        });
        expect(faulted.isError).toBe(true);
        expect(turn.createdEvents()).toBe(0);
        expect(listEventRows('gen-fault')).toHaveLength(0);

        // The mock only fires once — this call hits the real (transactional)
        // createAnchoredEvent and must succeed, reporting a count of 1, not
        // 2: the failed attempt above must not have incremented the counter.
        const ok = await createEventViaMcp(turn.url, turn.token, {
          category: 'cat1',
          message: 'SLATE',
          session_time: '00:00:02:00',
        });
        expect(ok.isError).toBeFalsy();
        expect(turn.createdEvents()).toBe(1);
        expect(listEventRows('gen-fault')).toHaveLength(1);
      } finally {
        spy.mockRestore();
        turn.dispose();
      }
    },
  );
});

describe('create_event — bracketing placement over a real store (3.2, spec invariant)', () => {
  const FPS = 24;
  const CTX = { frameRate: FPS, startOffsetFrames: 0 };

  /** Seed a paused/multi-take-shaped session: 10 minutes of timecode spread
   * across 60 minutes of wall clock (the shape that breaks naive
   * session-start arithmetic). Mirrors the eventAnchors.test.ts fixtures. */
  function seedAnchors(sessionId: string): void {
    const hub = registry.get(sessionId);
    hub.addEvent({
      category: 'internal',
      message: 'Recording 1 Started',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx: CTX,
      explicitAnchor: {
        timecodeTotalFrames: framesAt(FPS, 0, 10, 0),
        wallTimeUtc: '2026-01-01T10:00:00.000Z',
      },
    });
    hub.addEvent({
      category: 'cat1',
      message: 'manual note',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx: CTX,
      explicitAnchor: {
        timecodeTotalFrames: framesAt(FPS, 0, 20, 0),
        wallTimeUtc: '2026-01-01T11:00:00.000Z',
      },
    });
  }

  it('a generated event at 00:15:00:00 sorts BETWEEN the bracketing anchor events', async () => {
    seedAnchors('gen-brk');
    const turn = listener.registerTurn('gen-brk', genContext());
    const res = await createEventViaMcp(turn.url, turn.token, {
      category: 'cat1',
      message: 'SLATE',
      session_time: '00:15:00:00',
    });
    expect(res.isError).toBeFalsy();
    const rows = listEventRows('gen-brk'); // feed order: wall_time_utc ASC, id ASC
    expect(rows.map((r) => r.message)).toEqual(['Recording 1 Started', 'SLATE', 'manual note']);
    // Midpoint of the tc span maps to the midpoint of the wall span.
    expect(rows[1].wall_time_utc).toBe('2026-01-01T10:30:00.000Z');
    turn.dispose();
  });

  it('anchors are rebuilt per call: out-of-order creates still sort among themselves in timecode order', async () => {
    seedAnchors('gen-brk2');
    const turn = listener.registerTurn('gen-brk2', genContext());
    // Create at 00:15 first, THEN back at 00:12 — the second call re-reads the
    // store (now containing the 00:15 row as an anchor) and must still land
    // between the 00:10 anchor and the 00:15 generated row.
    for (const t of ['00:15:00:00', '00:12:00:00']) {
      const res = await createEventViaMcp(turn.url, turn.token, {
        category: 'cat1',
        message: `gen@${t}`,
        session_time: t,
      });
      expect(res.isError).toBeFalsy();
    }
    const rows = listEventRows('gen-brk2');
    expect(rows.map((r) => r.message)).toEqual([
      'Recording 1 Started',
      'gen@00:12:00:00',
      'gen@00:15:00:00',
      'manual note',
    ]);
    turn.dispose();
  });

  // event-generate-hardening task 2.3 — design D3's anchor-basis exclusion:
  // a regenerate run's pre-spawn snapshot ids must be filtered out of
  // `timecodeWallAnchors`'s live `hub.exportEvents()` read, or the doomed old
  // rows would steer the replacement rows' persisted wall times right up
  // until the post-success delete removes them.
  it('regenerateSnapshotIds excludes a doomed old-auto row from the anchor basis (D3)', async () => {
    seedAnchors('gen-brk3');
    const hub = registry.get('gen-brk3');
    // A doomed old-auto anchor BETWEEN the two seeded anchors — left in,
    // it would steer the 00:15:00:00 placement toward its own wall time
    // instead of the clean two-anchor midpoint.
    const { event: oldAuto } = hub.addEvent({
      category: 'cat1',
      message: 'Old generated slate',
      metadataJson: '{"auto_generated":true,"auto_generate_run_id":"old-run"}',
      markedAtUtc: null,
      ctx: CTX,
      explicitAnchor: {
        timecodeTotalFrames: framesAt(FPS, 0, 12, 0),
        wallTimeUtc: '2026-01-01T10:05:00.000Z',
      },
    });

    const turn = listener.registerTurn(
      'gen-brk3',
      genContext({ regenerateSnapshotIds: new Set([oldAuto.event_id]) }),
    );
    const res = await createEventViaMcp(turn.url, turn.token, {
      category: 'cat1',
      message: 'SLATE',
      session_time: '00:15:00:00',
    });
    expect(res.isError).toBeFalsy();
    const rows = listEventRows('gen-brk3');
    const generated = rows.find((r) => r.message === 'SLATE');
    // Same placement as the clean two-anchor bracketing test above —
    // 2026-01-01T10:30:00.000Z, the midpoint of the UN-doomed anchors — proof
    // the excluded old-auto row never entered the interpolation basis, even
    // though it is still physically present in the store (delete-after-
    // success has not run yet; this is the run's live create_event call).
    expect(generated?.wall_time_utc).toBe('2026-01-01T10:30:00.000Z');
    // And it's still there, undeleted — this tool call never deletes.
    expect(rows.some((r) => r.message === 'Old generated slate')).toBe(true);
    turn.dispose();
  });
});

// ── create_event characterization pins (package-split-foundation task 5.1) ──
//
// Pins current pre-reshape `create_event` behavior NOT already covered by the
// blocks above, ahead of the `createAnchoredEvent` hub-RPC reshape (task 5.2,
// design D6). These must stay green across the reshape — a byte-identical
// behavior parity requirement (delta spec "Behavior parity with the prior
// insert path").

describe('create_event — broadcast emission is per SUCCESSFUL insert only (delta spec: "exactly one event.changed per successful insert")', () => {
  it('failed calls (bad category, bad timecode) emit zero event.changed frames; only the two successful inserts do', async () => {
    const sent: string[] = [];
    registry.get('gen-ws-fail').attachSocket({ send: (d) => sent.push(d) }, 'browser');
    const turn = listener.registerTurn('gen-ws-fail', genContext());

    const badCat = await createEventViaMcp(turn.url, turn.token, {
      category: 'not-in-snapshot',
      message: 'x',
      session_time: '00:00:01:00',
    });
    expect(badCat.isError).toBe(true);

    const ok1 = await createEventViaMcp(turn.url, turn.token, {
      category: 'cat1',
      message: 'SLATE',
      session_time: '00:00:01:00',
    });
    expect(ok1.isError).toBeFalsy();

    const badTc = await createEventViaMcp(turn.url, turn.token, {
      category: 'cat1',
      message: 'x',
      session_time: 'not-a-timecode',
    });
    expect(badTc.isError).toBe(true);

    const ok2 = await createEventViaMcp(turn.url, turn.token, {
      category: 'cat1',
      message: 'SLATE',
      session_time: '00:00:02:00',
    });
    expect(ok2.isError).toBeFalsy();

    const frames = sent.map((d) => JSON.parse(d) as { type: string });
    // Exactly two frames — one per successful insert — despite four calls,
    // two of which failed and must produce none.
    expect(frames.filter((f) => f.type === 'event.changed')).toHaveLength(2);
    turn.dispose();
  });
});

describe('create_event — cap holds under concurrent calls (delta spec scenario "Cap holds under concurrent calls")', () => {
  it('two overlapping create_event calls at cap-1 created events: at most one succeeds, {created} never exceeds the cap', async () => {
    const turn = listener.registerTurn('gen-cap-race', genContext({ cap: 2 }));
    // Seed to cap-1 (one already created) sequentially first.
    const seed = await createEventViaMcp(turn.url, turn.token, {
      category: 'cat1',
      message: 'SLATE',
      session_time: '00:00:01:00',
    });
    expect(seed.isError).toBeFalsy();
    expect(turn.createdEvents()).toBe(1);

    // Fire two overlapping calls for the LAST remaining slot. Today's handler
    // has zero awaits, so — however the two HTTP requests interleave at the
    // transport layer — each tool invocation runs to completion on Node's
    // single thread before the other's cap-check/insert/increment sequence
    // can begin: this is the property the reshape (5.2) must preserve.
    const [a, b] = await Promise.all([
      createEventViaMcp(turn.url, turn.token, {
        category: 'cat1',
        message: 'race-a',
        session_time: '00:00:02:00',
      }),
      createEventViaMcp(turn.url, turn.token, {
        category: 'cat1',
        message: 'race-b',
        session_time: '00:00:03:00',
      }),
    ]);
    const results = [a, b];
    const successes = results.filter((r) => !r.isError);
    const failures = results.filter((r) => r.isError);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].content[0].text).toMatch(/cap/i);
    // {created} — surfaced here via the turn's counter — never exceeds cap.
    expect(turn.createdEvents()).toBe(2);
    expect(listEventRows('gen-cap-race')).toHaveLength(2);
    turn.dispose();
  });
});

describe('create_event — anchor basis is clamped monotone before interpolation (D4 fallback, pinned through create_event)', () => {
  it('an inverted (later timecode, earlier wall) anchor pair is clamped before placement, not interpolated raw', async () => {
    const FPS = 24;
    const CTX = { frameRate: FPS, startOffsetFrames: 0 };
    const sessionId = 'gen-clamp';
    const hub = registry.get(sessionId);
    // Anchor A: 10min timecode, LATE wall (12:00).
    hub.addEvent({
      category: 'internal',
      message: 'Recording 1 Started',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx: CTX,
      explicitAnchor: {
        timecodeTotalFrames: framesAt(FPS, 0, 10, 0),
        wallTimeUtc: '2026-01-01T12:00:00.000Z',
      },
    });
    // Anchor B: 20min timecode, EARLIER wall (11:00) — inverted vs. A, so a
    // raw (un-clamped) interpolation would run wall time BACKWARD across the
    // segment.
    hub.addEvent({
      category: 'cat1',
      message: 'manual note',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx: CTX,
      explicitAnchor: {
        timecodeTotalFrames: framesAt(FPS, 0, 20, 0),
        wallTimeUtc: '2026-01-01T11:00:00.000Z',
      },
    });

    const turn = listener.registerTurn(sessionId, genContext());
    const res = await createEventViaMcp(turn.url, turn.token, {
      category: 'cat1',
      message: 'SLATE',
      session_time: '00:15:00:00', // exact midpoint between the two anchors
    });
    expect(res.isError).toBeFalsy();
    const rows = listEventRows(sessionId);
    const generated = rows.find((r) => r.message === 'SLATE');
    // A raw (un-clamped) interpolation would land at 2026-01-01T11:30:00.000Z
    // (halfway from 12:00 down to 11:00). Clamped/monotone anchors raise B's
    // wall up to A's (both pin at 12:00), so the midpoint is 12:00 exactly —
    // proof the reshape still normalizes the anchor basis before
    // interpolating, matching `eventAnchors.test.ts`'s unit-level pin at the
    // `create_event` call surface.
    expect(generated?.wall_time_utc).toBe('2026-01-01T12:00:00.000Z');
    turn.dispose();
  });
});

/** Strip `//` and `/* *\/` comments while preserving string/template literal
 * content verbatim — the same dependency-free regex idiom
 * `packageBoundaries.repo.test.ts` uses for source inspection without a real
 * parser. Comments in the `create_event` handler literally contain the word
 * "await" in prose ("never held across an await"), so comments MUST be
 * stripped before a substring search for the keyword, or the pin below would
 * false-positive on its own documentation. */
function stripComments(src: string): string {
  return src.replace(
    /`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/.*|\/\*[\s\S]*?\*\//g,
    (m) => (m.startsWith('//') || m.startsWith('/*') ? '' : m),
  );
}

describe('create_event handler — zero-await invariant (package-split-foundation D6 / delta spec "Handler is uninterruptible")', () => {
  const AI_MCP_SERVER_SRC = join(dirname(fileURLToPath(import.meta.url)), 'aiMcpServer.ts');

  it('stripComments removes a comment containing the word "await" (mutation check — proves the predicate is not vacuous)', () => {
    const sample = 'const x = 1; // never held across an await\nconst y = 2;';
    const stripped = stripComments(sample);
    expect(stripped).not.toMatch(/await/);
    expect(stripped).toContain('const y = 2;');
  });

  it('the create_event tool-builder registration contains zero `await` expressions', () => {
    const source = readFileSync(AI_MCP_SERVER_SRC, 'utf8');
    const startMarker =
      'create_event: (server, { registry, sessionId, generation, createdEvents }) => {';
    const startIdx = source.indexOf(startMarker);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    // The unique two-line close of TOOL_BUILDERS ("  },\n};") — create_event
    // is TOOL_BUILDERS' last key, so this is the entry's own close too.
    const endMarker = '\n  },\n};';
    const endIdx = source.indexOf(endMarker, startIdx);
    expect(endIdx).toBeGreaterThan(startIdx);
    const handlerSource = source.slice(startIdx, endIdx);
    expect(stripComments(handlerSource)).not.toMatch(/\bawait\b/);
  });
});

// ── get_transcript_words at generation density (task 3.3, design D5) ────────
//
// Spec anchor: "Generation-density transcript rendering". The CHAT rendering
// stays byte-identical and is pinned by the pre-existing tests above
// ('get_transcript_words returns COMPACT readable text' describe block, all
// context-less) — this block covers only the generation-turn branch. The
// density/paging/measurement semantics themselves are pure-function-tested in
// aiMcpGenerationRendering.test.ts; here we pin the TOOL WIRING: per-context
// input shape, paged calls over real MCP, and error mapping.

describe('get_transcript_words — generation-density paged rendering (3.3)', () => {
  it('generation turn advertises the page input + paging guidance; chat keeps the zero-arg shape', async () => {
    const genTurn = listener.registerTurn('gen-shape-33', genContext());
    const chatTurn = listener.registerTurn('chat-shape-33');
    const gen = await connectMcp(genTurn.url, genTurn.token);
    const chat = await connectMcp(chatTurn.url, chatTurn.token);
    try {
      const genTool = (await gen.client.listTools()).tools.find(
        (t) => t.name === 'get_transcript_words',
      );
      expect(genTool).toBeDefined();
      const genProps = (genTool?.inputSchema?.properties ?? {}) as Record<string, unknown>;
      expect(Object.keys(genProps)).toEqual(['page']);
      // The description must tell the model pages exist, how to fetch the
      // next, and never to treat one page as the whole transcript.
      expect(genTool?.description).toMatch(/page=0/);
      expect(genTool?.description).toContain('never treat one page as the whole transcript');

      const chatTool = (await chat.client.listTools()).tools.find(
        (t) => t.name === 'get_transcript_words',
      );
      const chatProps = (chatTool?.inputSchema?.properties ?? {}) as Record<string, unknown>;
      expect(Object.keys(chatProps)).toEqual([]);
    } finally {
      await gen.close();
      await chat.close();
      genTurn.dispose();
      chatTurn.dispose();
    }
  });

  it('generation turn renders periodic anchors where the chat turn collapses to one line', async () => {
    // 2.5·N anchored single-speaker words: the chat rendering is ONE
    // speaker-segment line; generation density must break it up.
    const count = Math.floor(2.5 * GENERATION_LINE_MAX_WORDS);
    const words = Array.from({ length: count }, (_, i) => ({
      session_time: `00:00:${String(i).padStart(2, '0')}`,
      speaker: 'S1',
      word: `w${i}`,
      start_sec: i,
      end_sec: i + 1,
    }));
    registry.get('gen-density').replaceTranscriptWords(words);

    const genTurn = listener.registerTurn('gen-density', genContext());
    const chatTurn = listener.registerTurn('gen-density');
    const gen = await connectMcp(genTurn.url, genTurn.token);
    const chat = await connectMcp(chatTurn.url, chatTurn.token);
    try {
      // Zero-arg call on a generation turn defaults to page 0.
      const genRes = (await gen.client.callTool({
        name: 'get_transcript_words',
        arguments: {},
      })) as ToolResult;
      const genLines = genRes.content[0].text.split('\n');
      expect(genLines).toHaveLength(3);
      for (const line of genLines) expect(line).toMatch(/^\[00:00:\d\d\] speaker S1: /);

      // Chat turn on the SAME session: the unchanged one-anchor-per-speaker-
      // turn rendering (byte-identity pinned by the pre-existing tests).
      const chatRes = (await chat.client.callTool({
        name: 'get_transcript_words',
        arguments: {},
      })) as ToolResult;
      expect(chatRes.content[0].text.split('\n')).toHaveLength(1);
    } finally {
      await gen.close();
      await chat.close();
      genTurn.dispose();
      chatTurn.dispose();
    }
  });

  it('pages an over-page-size transcript over real MCP: marker on page 0, page=1 fetches the rest', async () => {
    // Two pages at the real constants. (The CHAR cap is what binds here since
    // topic-generate-paged-transcript task 1.1 — this word count sits above
    // both caps; the packing semantics themselves belong to the rendering
    // suite, this test only pins the tool wiring over real MCP.)
    const count = GENERATION_PAGE_SIZE_WORDS + GENERATION_LINE_MAX_WORDS + 2;
    const words = Array.from({ length: count }, (_, i) => ({
      session_time: i % 10 === 0 ? '00:10:00' : '',
      speaker: '1',
      word: `w${i}`,
      start_sec: i,
      end_sec: i + 1,
    }));
    registry.get('gen-paged').replaceTranscriptWords(words);
    const turn = listener.registerTurn('gen-paged', genContext());
    const { client, close } = await connectMcp(turn.url, turn.token);
    try {
      const page0 = (await client.callTool({
        name: 'get_transcript_words',
        arguments: {},
      })) as ToolResult;
      expect(page0.isError).toBeFalsy();
      expect(page0.content[0].text).toMatch(
        /--- transcript continues: call get_transcript_words with page=1 of 2 ---$/,
      );

      const page1 = (await client.callTool({
        name: 'get_transcript_words',
        arguments: { page: 1 },
      })) as ToolResult;
      expect(page1.isError).toBeFalsy();
      expect(page1.content[0].text).not.toContain('transcript continues');
      expect(page1.content[0].text.length).toBeGreaterThan(0);

      // Deterministic: re-fetching page 0 returns byte-identical text.
      const again = (await client.callTool({
        name: 'get_transcript_words',
        arguments: { page: 0 },
      })) as ToolResult;
      expect(again.content[0].text).toBe(page0.content[0].text);
    } finally {
      await close();
      turn.dispose();
    }
  });

  it('out-of-range page is a TOOL ERROR (isError), never empty text', async () => {
    registry
      .get('gen-oor')
      .replaceTranscriptWords([
        { session_time: '00:00:01', speaker: 'S1', word: 'solo', start_sec: 1, end_sec: 2 },
      ]);
    const turn = listener.registerTurn('gen-oor', genContext());
    const { client, close } = await connectMcp(turn.url, turn.token);
    try {
      const res = (await client.callTool({
        name: 'get_transcript_words',
        arguments: { page: 5 },
      })) as ToolResult;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/page/i);
    } finally {
      await close();
      turn.dispose();
    }
  });
});

// ── auto-generate-event-logs task 4.3 (Phase-3 review carry, BINDING): the
// run-start WORD SNAPSHOT. A generation registration may carry
// `generation.words` — the transcript rows frozen by the route at run start.
// When present, the paged generation rendering reads the SNAPSHOT, never the
// live hub, so a concurrent transcript regeneration (replaceTranscriptWords)
// cannot reshuffle the paged rendering (content OR page boundaries) mid-run.
// Absent ⇒ the live hub read — every 3.3 test above registers snapshot-less
// and must stay green unchanged.

describe('get_transcript_words — run-start word snapshot (4.3, phase-3 carry)', () => {
  it(
    'replaceTranscriptWords mid-run changes neither page content nor page boundaries ' +
      'for a turn registered with a word snapshot',
    async () => {
      // Two pages at the real constants (mirrors the 3.3 paging fixture).
      const count = GENERATION_PAGE_SIZE_WORDS + GENERATION_LINE_MAX_WORDS + 2;
      const snapshot = Array.from({ length: count }, (_, i) => ({
        word: `orig${i}`,
        session_time: i % 10 === 0 ? '00:10:00' : '',
        speaker: '1',
      }));
      const turn = listener.registerTurn('gen-snap', genContext({ words: snapshot }));
      const { client, close } = await connectMcp(turn.url, turn.token);
      try {
        const before0 = (await client.callTool({
          name: 'get_transcript_words',
          arguments: { page: 0 },
        })) as ToolResult;
        expect(before0.isError).toBeFalsy();
        expect(before0.content[0].text).toMatch(
          /--- transcript continues: call get_transcript_words with page=1 of 2 ---$/,
        );
        const before1 = (await client.callTool({
          name: 'get_transcript_words',
          arguments: { page: 1 },
        })) as ToolResult;

        // Mid-run transcript regeneration: an entirely different (single-word,
        // single-page) transcript lands in the hub.
        registry
          .get('gen-snap')
          .replaceTranscriptWords([
            { session_time: '00:59:59', speaker: 'Z', word: 'replaced', start_sec: 0, end_sec: 1 },
          ]);

        // The registered turn's rendering is BYTE-IDENTICAL: same content,
        // same 2-page boundary — the run cannot see the mid-run replace.
        const after0 = (await client.callTool({
          name: 'get_transcript_words',
          arguments: { page: 0 },
        })) as ToolResult;
        expect(after0.content[0].text).toBe(before0.content[0].text);
        const after1 = (await client.callTool({
          name: 'get_transcript_words',
          arguments: { page: 1 },
        })) as ToolResult;
        expect(after1.content[0].text).toBe(before1.content[0].text);
        expect(after0.content[0].text).not.toContain('replaced');
        expect(after0.content[0].text).toContain('orig0');
      } finally {
        await close();
        turn.dispose();
      }
    },
  );

  it('a snapshot-less generation registration still reads the live hub (3.3 fallback intact)', async () => {
    registry
      .get('gen-snap-live')
      .replaceTranscriptWords([
        { session_time: '00:00:01', speaker: 'S1', word: 'live-word', start_sec: 1, end_sec: 2 },
      ]);
    const turn = listener.registerTurn('gen-snap-live', genContext());
    const { client, close } = await connectMcp(turn.url, turn.token);
    try {
      const res = (await client.callTool({
        name: 'get_transcript_words',
        arguments: {},
      })) as ToolResult;
      expect(res.content[0].text).toContain('live-word');
      // Live means live: a replace IS visible to a snapshot-less turn.
      registry
        .get('gen-snap-live')
        .replaceTranscriptWords([
          { session_time: '00:00:02', speaker: 'S1', word: 'swapped', start_sec: 2, end_sec: 3 },
        ]);
      const res2 = (await client.callTool({
        name: 'get_transcript_words',
        arguments: {},
      })) as ToolResult;
      expect(res2.content[0].text).toContain('swapped');
      expect(res2.content[0].text).not.toContain('live-word');
    } finally {
      await close();
      turn.dispose();
    }
  });
});

// ── topic-generate-paged-transcript task 2.1 (design D1/D6) — the words-only
// `pagedWords` snapshot, and the registration's page-coverage bookkeeping.
//
// KEYING and TRACKING only: what a page CONTAINS (packing, markers,
// determinism, out-of-range wording) is owned by
// aiMcpGenerationRendering.test.ts and is not re-asserted here. What this
// block pins is (a) which registrations get the paged tool shape and where
// their words come from, and (b) that the served-page counter the
// `topics/generate` swap gate reads counts only VALID pages actually served.
//
// Byte-identity of the two pre-existing registration kinds is pinned by the
// untouched suites above: chat (context-less) by 'get_transcript_words returns
// COMPACT readable text' + 'accepts a live token and exposes the three tool
// names', event generation by the 3.3/4.3 blocks.

describe('get_transcript_words — pagedWords keying + page coverage (2.1)', () => {
  /** A snapshot that spans several generation-density pages at the REAL
   * constants (200-char words ⇒ the char cap pages it after ~40 lines). */
  function multiPageSnapshot(): AiGenerationSnapshotWord[] {
    return Array.from({ length: 600 }, (_, i) => ({
      word: `w${i}`.padEnd(200, 'x'),
      session_time: '00:00:01',
      speaker: 'S1',
    }));
  }

  const ONE_WORD_SNAPSHOT: AiGenerationSnapshotWord[] = [
    { word: 'snapshot-only', session_time: '00:00:07', speaker: 'S1' },
  ];

  /** Fetch one page over real MCP. */
  async function fetchPage(
    turn: { url: string; token: string },
    page?: number,
  ): Promise<ToolResult> {
    const { client, close } = await connectMcp(turn.url, turn.token);
    try {
      return (await client.callTool({
        name: 'get_transcript_words',
        arguments: page === undefined ? {} : { page },
      })) as ToolResult;
    } finally {
      await close();
    }
  }

  it('a pagedWords registration exposes the `page` input and serves the SNAPSHOT, not the live hub', async () => {
    // The live hub holds something ELSE entirely: a snapshot-sourced read can
    // never show it (D1 — the pages come only from the captured list).
    registry.get('paged-src').replaceTranscriptWords([
      {
        session_time: '00:00:01',
        speaker: 'S1',
        word: 'live-hub-word',
        start_sec: 1,
        end_sec: 2,
      },
    ]);
    const turn = listener.registerTurn('paged-src', {
      tools: ['get_transcript_words', 'create_topic'],
      pagedWords: ONE_WORD_SNAPSHOT,
    });
    const { client, close } = await connectMcp(turn.url, turn.token);
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === 'get_transcript_words');
      const props = (tool?.inputSchema?.properties ?? {}) as Record<string, unknown>;
      // The PAGED shape — the same one an event-generation turn advertises —
      // on a turn carrying no generation run at all.
      expect(Object.keys(props)).toEqual(['page']);

      const res = (await client.callTool({
        name: 'get_transcript_words',
        arguments: {},
      })) as ToolResult;
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain('snapshot-only');
      expect(res.content[0].text).not.toContain('live-hub-word');

      // A mid-run replacement cannot reach it either.
      registry
        .get('paged-src')
        .replaceTranscriptWords([
          { session_time: '00:59:59', speaker: 'Z', word: 'replaced', start_sec: 0, end_sec: 1 },
        ]);
      const again = (await client.callTool({
        name: 'get_transcript_words',
        arguments: { page: 0 },
      })) as ToolResult;
      expect(again.content[0].text).toBe(res.content[0].text);
    } finally {
      await close();
      turn.dispose();
    }
  });

  it("the event run's own snapshot still wins when a registration carries both", async () => {
    // Sourcing precedence (D1): `generation?.words ?? pagedWords ?? live hub`.
    const turn = listener.registerTurn('paged-precedence', {
      ...genContext({
        words: [{ word: 'run-snapshot-word', session_time: '00:00:03', speaker: 'S1' }],
      }),
      pagedWords: ONE_WORD_SNAPSHOT,
    });
    try {
      const res = await fetchPage(turn);
      expect(res.content[0].text).toContain('run-snapshot-word');
      expect(res.content[0].text).not.toContain('snapshot-only');
    } finally {
      turn.dispose();
    }
  });

  it('the one-shot tool pair registers exactly get_transcript_words + create_topic', async () => {
    const turn = listener.registerTurn('paged-tools', {
      tools: ['get_transcript_words', 'create_topic'],
      pagedWords: ONE_WORD_SNAPSHOT,
    });
    const { client, close } = await connectMcp(turn.url, turn.token);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      // The snapshot keys the RENDERING, never the tool set: no create_event
      // (still keyed by `tools` alone) and no list_topics (D3's withholding).
      expect(names).toEqual(['create_topic', 'get_transcript_words']);
    } finally {
      await close();
      turn.dispose();
    }
  });

  it('tracks DISTINCT served pages against the snapshot total; full coverage only after the last page', async () => {
    const turn = listener.registerTurn('paged-cov', {
      tools: ['get_transcript_words'],
      pagedWords: multiPageSnapshot(),
    });
    try {
      // Known before a single call — a run that never reads the transcript
      // must still be measurable against a real total.
      const { totalPages } = turn.pageCoverage();
      expect(totalPages).toBeGreaterThanOrEqual(3);
      expect(turn.pageCoverage()).toEqual({ totalPages, servedPages: 0 });
      expect(allTranscriptPagesServed(turn.pageCoverage())).toBe(false);

      // Page 0 only — the motivating partial-prefix read.
      expect((await fetchPage(turn, 0)).isError).toBeFalsy();
      expect(turn.pageCoverage()).toEqual({ totalPages, servedPages: 1 });
      expect(allTranscriptPagesServed(turn.pageCoverage())).toBe(false);

      // Re-reading a page does not inflate coverage.
      await fetchPage(turn, 0);
      expect(turn.pageCoverage().servedPages).toBe(1);

      // Every page but the LAST: still not full coverage.
      for (let p = 1; p < totalPages - 1; p += 1) await fetchPage(turn, p);
      expect(turn.pageCoverage()).toEqual({ totalPages, servedPages: totalPages - 1 });
      expect(allTranscriptPagesServed(turn.pageCoverage())).toBe(false);

      const last = await fetchPage(turn, totalPages - 1);
      expect(last.isError).toBeFalsy();
      expect(last.content[0].text).not.toContain('transcript continues');
      expect(turn.pageCoverage()).toEqual({ totalPages, servedPages: totalPages });
      expect(allTranscriptPagesServed(turn.pageCoverage())).toBe(true);
    } finally {
      turn.dispose();
    }
  });

  it('an out-of-range or malformed page is a tool error that marks NO coverage', async () => {
    const turn = listener.registerTurn('paged-cov-err', {
      tools: ['get_transcript_words'],
      pagedWords: ONE_WORD_SNAPSHOT, // exactly one page
    });
    try {
      expect(turn.pageCoverage()).toEqual({ totalPages: 1, servedPages: 0 });
      const past = await fetchPage(turn, 5);
      expect(past.isError).toBe(true);
      const negative = await fetchPage(turn, -1);
      expect(negative.isError).toBe(true);
      const fractional = await fetchPage(turn, 0.5);
      expect(fractional.isError).toBe(true);
      // Three tool errors, zero pages served — an errored call can never
      // satisfy the swap gate.
      expect(turn.pageCoverage()).toEqual({ totalPages: 1, servedPages: 0 });
      expect(allTranscriptPagesServed(turn.pageCoverage())).toBe(false);

      // …and the real page still counts.
      expect((await fetchPage(turn, 0)).isError).toBeFalsy();
      expect(allTranscriptPagesServed(turn.pageCoverage())).toBe(true);
    } finally {
      turn.dispose();
    }
  });

  it('a chat (context-less) registration reports zero pages and makes no coverage claim', async () => {
    registry
      .get('chat-cov')
      .replaceTranscriptWords([
        { session_time: '00:00:01', speaker: 'S1', word: 'hello', start_sec: 1, end_sec: 2 },
      ]);
    const turn = listener.registerTurn('chat-cov');
    try {
      expect(turn.pageCoverage()).toEqual({ totalPages: 0, servedPages: 0 });
      const res = await fetchPage(turn);
      // Unpaged chat rendering (zero-arg), unchanged…
      expect(res.content[0].text).toBe('[00:00:01] speaker S1: hello');
      // …and reading it still claims no coverage, so a chat/topic turn whose
      // registration carries no snapshot can never FAIL the gate.
      expect(turn.pageCoverage()).toEqual({ totalPages: 0, servedPages: 0 });
      expect(allTranscriptPagesServed(turn.pageCoverage())).toBe(true);
    } finally {
      turn.dispose();
    }
  });

  it('a snapshot-less GENERATION registration (live hub) also makes no coverage claim', async () => {
    registry
      .get('gen-cov-live')
      .replaceTranscriptWords([
        { session_time: '00:00:01', speaker: 'S1', word: 'live', start_sec: 1, end_sec: 2 },
      ]);
    const turn = listener.registerTurn('gen-cov-live', genContext());
    try {
      expect((await fetchPage(turn, 0)).content[0].text).toContain('live');
      expect(turn.pageCoverage()).toEqual({ totalPages: 0, servedPages: 0 });
      expect(allTranscriptPagesServed(turn.pageCoverage())).toBe(true);
    } finally {
      turn.dispose();
    }
  });
});
