// ai-v2-dashboards (task 2.4) — in-process MCP aggregate tools.
// SECURITY properties under test (gate-intent, design D4 / spec "Session-
// scoped aggregate toolset"): sessionId is bound by the CLOSURE and is never
// a tool parameter (no schema declares one), the hub is resolved AT CALL
// TIME rather than held, and — the required test — two concurrent per-turn
// servers built for DIFFERENT sessions never cross. Hermetic: no live SDK
// turn, no Anthropic spend. Tools are exercised through a real in-process MCP
// client/server pair (`InMemoryTransport`) rather than by calling internal
// functions directly, so the assertions cover the actual wire-shaped tool
// behavior a design turn would see.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DashboardConfig } from '@autologger/contract';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionHubRegistry } from '../session/SessionHub';
import {
  AGGREGATE_TOOL_NAMES,
  type BuildAggregateMcpServerDeps,
  buildAggregateMcpServer,
} from './mcpTools';

let dir: string;
let registry: SessionHubRegistry;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-v2-mcp-'));
  registry = new SessionHubRegistry(join(dir, 'sessions'));
});

afterEach(() => {
  registry.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

/** Connect a fresh MCP client to one per-turn aggregate server over an
 * in-process transport pair (no HTTP, no subprocess). Caller closes. */
async function connectToTurn(
  sessionId: string,
  deps: BuildAggregateMcpServerDeps = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const { instance } = buildAggregateMcpServer(sessionId, registry, deps);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([instance.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await clientTransport.close();
      await instance.close();
    },
  };
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

describe('buildAggregateMcpServer — no session parameter on any tool', () => {
  it('advertises exactly the five aggregate tools, none accepting a session id', async () => {
    const { client, close } = await connectToTurn('sessA');
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...AGGREGATE_TOOL_NAMES].sort());
      for (const t of tools) {
        const props = Object.keys((t.inputSchema?.properties ?? {}) as Record<string, unknown>);
        // gate-intent: an agent CANNOT pass a session id — no such param exists
        // on any tool, so there is no argument through which to address
        // another session.
        expect(props.every((p) => !/session/i.test(p))).toBe(true);
      }
    } finally {
      await close();
    }
  });
});

describe('buildAggregateMcpServer — cross-session isolation (the required test)', () => {
  it('two concurrent per-turn servers for different sessions never cross', async () => {
    // Seed distinct, easily-distinguished data per session through the real
    // hub — same seeding style as aiMcpServer.test.ts's cross-talk test.
    registry.get('sessA').replaceTranscriptWords([
      { session_time: '00:00:00', speaker: 'A0', word: 'alpha', start_sec: 0, end_sec: 1 },
      { session_time: '00:00:01', speaker: 'A0', word: 'bravo', start_sec: 1, end_sec: 2 },
    ]);
    registry.get('sessA').insertTopic({
      session_time: '00:00:01',
      duration_sec: 5,
      topic_level: 1,
      summary: 'A-only topic',
    });

    registry.get('sessB').replaceTranscriptWords([
      { session_time: '00:00:00', speaker: 'B0', word: 'charlie', start_sec: 0, end_sec: 3 },
      { session_time: '00:00:03', speaker: 'B1', word: 'delta', start_sec: 3, end_sec: 4 },
      { session_time: '00:00:04', speaker: 'B1', word: 'echo', start_sec: 4, end_sec: 5 },
    ]);
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

    // Two per-turn servers, built for two different sessions, connected and
    // called CONCURRENTLY — proving the factory is per-turn (not a shared
    // module-scoped instance) and each tool call resolves only its own bound
    // session, never the other's.
    const turnA = await connectToTurn('sessA');
    const turnB = await connectToTurn('sessB');
    try {
      const [speakerA, speakerB, excerptA, excerptB, topicsA, topicsB] = await Promise.all([
        callJson(turnA.client, 'speaker_stats'),
        callJson(turnB.client, 'speaker_stats'),
        callJson(turnA.client, 'transcript_excerpt'),
        callJson(turnB.client, 'transcript_excerpt'),
        callJson(turnA.client, 'topic_timeline'),
        callJson(turnB.client, 'topic_timeline'),
      ]);

      expect(speakerA.bySpeaker).toEqual([{ speaker: 'A0', talkTimeSec: 2 }]);
      expect(speakerB.bySpeaker).toEqual(
        expect.arrayContaining([
          { speaker: 'B0', talkTimeSec: 3 },
          { speaker: 'B1', talkTimeSec: 2 },
        ]),
      );

      expect((excerptA.words as Array<{ word: string }>).map((w) => w.word)).toEqual([
        'alpha',
        'bravo',
      ]);
      expect((excerptB.words as Array<{ word: string }>).map((w) => w.word)).toEqual([
        'charlie',
        'delta',
        'echo',
      ]);

      expect((topicsA.entries as Array<{ summary: string }>).map((e) => e.summary)).toEqual([
        'A-only topic',
      ]);
      expect((topicsB.entries as Array<{ summary: string }>).map((e) => e.summary)).toEqual([
        'B-first',
        'B-second',
      ]);
    } finally {
      await turnA.close();
      await turnB.close();
    }
  });
});

describe('buildAggregateMcpServer — degraded data is never zeros-as-data', () => {
  it('speaker_stats reports unavailable, not zero, for a manually-entered transcript', async () => {
    // Manual insert path never writes start_sec/end_sec — schema default 0.0
    // for every word (design D2a). speaker_stats must surface this as
    // `available: false`, never as a measured 0-second talk time.
    registry
      .get('manualSess')
      .replaceTranscriptWords([
        { session_time: '00:00:00', speaker: 'S1', word: 'hi', start_sec: 0, end_sec: 0 },
      ]);
    const { client, close } = await connectToTurn('manualSess');
    try {
      const result = await callJson(client, 'speaker_stats');
      expect(result.available).toBe(false);
      expect(result.reason).toBeTruthy();
      expect(result.durationSec).toBeNull();
      expect(result.bySpeaker).toEqual([]);
    } finally {
      await close();
    }
  });

  it('utterance_stats/event_stats degrade independently without paragraphs/timings', async () => {
    registry
      .get('sessNoParagraphs')
      .replaceTranscriptWords([
        { session_time: '00:00:00', speaker: 'S1', word: 'um', start_sec: 0, end_sec: 0 },
      ]);
    const { client, close } = await connectToTurn('sessNoParagraphs');
    try {
      const utterance = await callJson(client, 'utterance_stats');
      const utterances = utterance.utterances as { available: boolean; utteranceCount: unknown };
      const fillers = utterance.fillers as { available: boolean; fillerCount: unknown };
      // No persisted paragraphs -> utterances unavailable...
      expect(utterances.available).toBe(false);
      expect(utterances.utteranceCount).toBeNull();
      // ...but filler counting only needs non-empty words, so it IS available
      // and correctly counts the one filler word ("um").
      expect(fillers.available).toBe(true);
      expect(fillers.fillerCount).toBe(1);

      const eventStats = await callJson(client, 'event_stats');
      const density = eventStats.density as { available: boolean; eventsPerMinute: unknown };
      // Degenerate (all-zero) timings -> duration unavailable -> density
      // unavailable too, never reported as a measured 0.
      expect(density.available).toBe(false);
      expect(density.eventsPerMinute).toBeNull();
    } finally {
      await close();
    }
  });
});

describe('buildAggregateMcpServer — bounded lists state their own truncation', () => {
  it('transcript_excerpt clamps an oversized limit and reports truncated: true', async () => {
    const words = Array.from({ length: 30 }, (_, i) => ({
      session_time: `00:00:${String(i).padStart(2, '0')}`,
      speaker: 'S1',
      word: `w${i}`,
      start_sec: i,
      end_sec: i + 1,
    }));
    registry.get('bigSess').replaceTranscriptWords(words);
    const { client, close } = await connectToTurn('bigSess');
    try {
      const page = await callJson(client, 'transcript_excerpt', { offset: 0, limit: 10 });
      expect(page.returned).toBe(10);
      expect(page.totalWords).toBe(30);
      expect(page.truncated).toBe(true);

      const rest = await callJson(client, 'transcript_excerpt', { offset: 10, limit: 20 });
      expect(rest.returned).toBe(20);
      expect(rest.truncated).toBe(false);
    } finally {
      await close();
    }
  });

  it('topic_timeline is available/empty (not unavailable) for a session with no topics', async () => {
    registry.get('noTopics'); // materialize, no topics inserted
    const { client, close } = await connectToTurn('noTopics');
    try {
      const timeline = await callJson(client, 'topic_timeline');
      expect(timeline.entries).toEqual([]);
      expect(timeline.truncated).toBe(false);
    } finally {
      await close();
    }
  });
});

// ── Task 5.4 — propose_dashboard (design D10, spec "Dashboards are edited ──
// directly, not only by conversation" + "Dashboard persistence"). Gate-intent
// property: this tool is the SINGLE commit point, and it validates the WHOLE
// config against the SAME validator (validateDashboardConfig, ./catalog.ts)
// a user write is held to — an invalid/unknown/dangling/markup-bearing
// proposal is rejected at the tool boundary and `onProposeDashboard` is
// PROVABLY never invoked for it.
describe('buildAggregateMcpServer — propose_dashboard (design D10)', () => {
  function validConfig(): DashboardConfig {
    return {
      widgets: [
        { id: 'w1', type: 'session_duration', title: 'Duration', x: 0, y: 0, w: 4, h: 2 },
        { id: 'w2', type: 'talk_time_by_speaker', title: 'Talk time', x: 4, y: 0, w: 4, h: 2 },
      ],
      interactions: [],
    };
  }

  it('accepts a valid proposal and hands the VALIDATED config to onProposeDashboard, nothing else', async () => {
    const proposed: DashboardConfig[] = [];
    const { client, close } = await connectToTurn('proposeOk', {
      onProposeDashboard: (config) => {
        proposed.push(config);
      },
    });
    try {
      const cfg = validConfig();
      const res = (await client.callTool({
        name: 'propose_dashboard',
        arguments: cfg,
      })) as ToolResult;
      expect(res.isError).toBeFalsy();
      expect(JSON.parse(res.content[0].text)).toEqual({ accepted: true });
      expect(proposed).toEqual([cfg]);
    } finally {
      await close();
    }
  });

  it('rejects a config naming an unknown widget type — nothing is proposed', async () => {
    const proposed: DashboardConfig[] = [];
    const { client, close } = await connectToTurn('proposeUnknownType', {
      onProposeDashboard: (config) => {
        proposed.push(config);
      },
    });
    try {
      const res = (await client.callTool({
        name: 'propose_dashboard',
        arguments: {
          widgets: [
            { id: 'w1', type: 'sentiment_series', title: 'Sentiment', x: 0, y: 0, w: 4, h: 2 },
          ],
          interactions: [],
        },
      })) as ToolResult;
      expect(res.isError).toBe(true);
      const parsed = JSON.parse(res.content[0].text) as { accepted: boolean };
      expect(parsed.accepted).toBe(false);
      expect(proposed).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('rejects a config with a dangling interaction reference — nothing is proposed', async () => {
    const proposed: DashboardConfig[] = [];
    const { client, close } = await connectToTurn('proposeDangling', {
      onProposeDashboard: (config) => {
        proposed.push(config);
      },
    });
    try {
      const res = (await client.callTool({
        name: 'propose_dashboard',
        arguments: {
          widgets: [
            { id: 'w1', type: 'session_duration', title: 'Duration', x: 0, y: 0, w: 4, h: 2 },
          ],
          interactions: [
            { kind: 'highlight_speaker', sourceWidgetId: 'w1', targetWidgetId: 'ghost' },
          ],
        },
      })) as ToolResult;
      expect(res.isError).toBe(true);
      const parsed = JSON.parse(res.content[0].text) as { accepted: boolean };
      expect(parsed.accepted).toBe(false);
      expect(proposed).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('rejects a markup/URL-bearing title (javascript: URI) — nothing is proposed', async () => {
    const proposed: DashboardConfig[] = [];
    const { client, close } = await connectToTurn('proposeMarkup', {
      onProposeDashboard: (config) => {
        proposed.push(config);
      },
    });
    try {
      const res = (await client.callTool({
        name: 'propose_dashboard',
        arguments: {
          widgets: [
            {
              id: 'w1',
              type: 'session_duration',
              title: '<img src=x onerror="javascript:alert(1)">',
              x: 0,
              y: 0,
              w: 4,
              h: 2,
            },
          ],
          interactions: [],
        },
      })) as ToolResult;
      expect(res.isError).toBe(true);
      const parsed = JSON.parse(res.content[0].text) as { accepted: boolean };
      expect(parsed.accepted).toBe(false);
      expect(proposed).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('rejects a duplicate widget id — nothing is proposed', async () => {
    const proposed: DashboardConfig[] = [];
    const { client, close } = await connectToTurn('proposeDup', {
      onProposeDashboard: (config) => {
        proposed.push(config);
      },
    });
    try {
      const res = (await client.callTool({
        name: 'propose_dashboard',
        arguments: {
          widgets: [
            { id: 'w1', type: 'session_duration', title: 'A', x: 0, y: 0, w: 4, h: 2 },
            { id: 'w1', type: 'talk_time_by_speaker', title: 'B', x: 4, y: 0, w: 4, h: 2 },
          ],
          interactions: [],
        },
      })) as ToolResult;
      expect(res.isError).toBe(true);
      const parsed = JSON.parse(res.content[0].text) as { accepted: boolean };
      expect(parsed.accepted).toBe(false);
      expect(proposed).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('does not accept a sessionId argument — no such property on the tool schema', async () => {
    const { client, close } = await connectToTurn('proposeNoSession');
    try {
      const { tools } = await client.listTools();
      const proposeTool = tools.find((t) => t.name === 'propose_dashboard');
      expect(proposeTool).toBeTruthy();
      const props = Object.keys(
        (proposeTool?.inputSchema?.properties ?? {}) as Record<string, unknown>,
      );
      expect(props.every((p) => !/session/i.test(p))).toBe(true);
    } finally {
      await close();
    }
  });
});
