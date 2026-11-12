// batch-autogenerate task 3.4 (design D7 topics, "Fenced write-ahead"): `create_topic` with a
// per-turn topic id allocator in its MCP context calls the allocator first, then inserts the topic
// with the allocated id; an allocator that throws makes the tool return an error without inserting,
// and every later call of the turn refuses too.

import { AiMcpListener } from '@autologger/ai-runtime/aiMcpServer';
import { SessionHubView } from '@autologger/session-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_CALLER, type TestRegistry, testRegistry } from './sessionRows';

let registry: TestRegistry;
let listener: AiMcpListener;
beforeEach(async () => {
  registry = testRegistry({ autoCreate: true });
  listener = new AiMcpListener(registry);
  await listener.start();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await listener.close();
  await registry.closeAll();
});

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
const topic = (summary: string) => ({
  session_time: '00:00:01',
  duration_sec: 5,
  topic_level: 2,
  summary,
});

async function call(url: string, token: string, args: Record<string, unknown>) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    return (await client.callTool({ name: 'create_topic', arguments: args })) as ToolResult;
  } finally {
    await transport.close();
  }
}

describe('create_topic with a topic id allocator', () => {
  it('allocates before inserting and inserts with the allocated id', async () => {
    const steps: string[] = [];
    const insert = SessionHubView.prototype.insertTopic;
    vi.spyOn(SessionHubView.prototype, 'insertTopic').mockImplementation(function (
      this: SessionHubView,
      ...args: Parameters<SessionHubView['insertTopic']>
    ) {
      steps.push('insert');
      return insert.apply(this, args);
    });
    let n = 0;
    const turn = listener.registerTurn('alloc-a', TEST_CALLER, {
      tools: ['create_topic'],
      topicIds: {
        allocate: async () => {
          steps.push('allocate');
          n += 1;
          return `allocated-${n}`;
        },
      },
    });
    expect((await call(turn.url, turn.token, topic('one'))).isError).toBeFalsy();
    expect((await call(turn.url, turn.token, topic('two'))).isError).toBeFalsy();
    turn.dispose();
    expect(steps).toEqual(['allocate', 'insert', 'allocate', 'insert']);
    const rows = await (await registry.get('alloc-a')).listTopics();
    expect(rows.map((t) => [t.id, t.summary])).toEqual([
      ['allocated-1', 'one'],
      ['allocated-2', 'two'],
    ]);
  });

  it('a refusing allocator inserts nothing, and every later call of the turn refuses', async () => {
    let calls = 0;
    const turn = listener.registerTurn('alloc-b', TEST_CALLER, {
      tools: ['create_topic'],
      topicIds: {
        allocate: async () => {
          calls += 1;
          if (calls === 1) throw new Error('lease lost');
          return 'never-used';
        },
      },
    });
    const first = await call(turn.url, turn.token, topic('refused'));
    expect(first.isError).toBe(true);
    const second = await call(turn.url, turn.token, topic('also refused'));
    expect(second.isError).toBe(true);
    turn.dispose();
    expect(calls).toBe(1);
    expect(await (await registry.get('alloc-b')).listTopics()).toEqual([]);
  });
});
