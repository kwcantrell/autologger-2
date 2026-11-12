// `AiMcpListener.close()` returns promptly while clients still hold connections to it, and never
// cuts off a request that is already in flight. These run over Node's built-in `fetch` (behind the
// MCP client) with its default keep-alive settings; nothing here or in a setup file installs a
// custom undici dispatcher.
//
// The slow case: two MCP clients at once make undici open a connection it never sends a request on
// (it connects for the standalone GET stream that `transport.close()` has just aborted). Node's
// `server.close()` counts such a connection as active, not idle, so it used to wait about 4 s for
// undici's keep-alive timer to drop it.

import net from 'node:net';
import { type SessionHubRegistryFacade, userCaller } from '@autologger/session-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { AiMcpListener } from './aiMcpServer';

const CALLER = userCaller('user-1');
const TOPIC = { id: 7, session_time: '00:00:01', summary: 'a topic' };
const CLOSE_BUDGET_MS = 500;

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

/** A registry whose sessions list one topic, optionally only after `gate` resolves. */
function fakeRegistry(gate?: { entered: () => void; release: Promise<void> }) {
  return {
    get: async () => ({
      as: () => ({
        listTopics: async () => {
          if (gate) {
            gate.entered();
            await gate.release;
          }
          return [TOPIC];
        },
      }),
    }),
  } as unknown as SessionHubRegistryFacade;
}

/** Connect an MCP client over real HTTP (`fetch`) with the turn's bearer. */
async function connectMcp(url: string, token: string) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return { client, transport };
}

/** One full MCP `list_topics` call; returns the parsed topics. */
async function listTopics(url: string, token: string): Promise<unknown[]> {
  const { client, transport } = await connectMcp(url, token);
  try {
    const res = (await client.callTool({ name: 'list_topics', arguments: {} })) as ToolResult;
    return JSON.parse(res.content[0].text) as unknown[];
  } finally {
    await transport.close();
  }
}

/** Resolve with how long `close()` took, in ms. */
async function timeClose(listener: AiMcpListener): Promise<number> {
  const t0 = performance.now();
  await listener.close();
  return performance.now() - t0;
}

/** Whether a TCP connection to `port` on loopback is refused. */
function connectionRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'ECONNREFUSED'));
  });
}

let listener: AiMcpListener | null = null;

afterEach(async () => {
  await listener?.close();
  listener = null;
});

describe('AiMcpListener.close() with clients still connected', () => {
  it('resolves promptly after real MCP requests over fetch with default keep-alive', async () => {
    listener = new AiMcpListener(fakeRegistry());
    await listener.start();
    const a = listener.registerTurn('sessA', CALLER);
    const b = listener.registerTurn('sessB', CALLER);

    const [topicsA, topicsB] = await Promise.all([
      listTopics(a.url, a.token),
      listTopics(b.url, b.token),
    ]);
    expect(topicsA).toEqual([TOPIC]);
    expect(topicsB).toEqual([TOPIC]);

    expect(await timeClose(listener)).toBeLessThan(CLOSE_BUDGET_MS);
  });

  it('resolves promptly while a client holds a connection it never sent a byte on', async () => {
    listener = new AiMcpListener(fakeRegistry());
    await listener.start();
    const turn = listener.registerTurn('sessA', CALLER);
    expect(await listTopics(turn.url, turn.token)).toEqual([TOPIC]);

    const port = listener.address?.port ?? 0;
    const silent = net.connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => silent.once('connect', () => resolve()));
    const silentClosed = new Promise<void>((resolve) => silent.once('close', () => resolve()));
    silent.on('error', () => {});

    expect(await timeClose(listener)).toBeLessThan(CLOSE_BUDGET_MS);
    await silentClosed;
  });

  it('lets an in-flight request finish with its whole response, then refuses new connections', async () => {
    let entered!: () => void;
    const inHandler = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    listener = new AiMcpListener(fakeRegistry({ entered, release: released }));
    await listener.start();
    const port = listener.address?.port ?? 0;
    const turn = listener.registerTurn('sessA', CALLER);
    const { client, transport } = await connectMcp(turn.url, turn.token);

    const call = client.callTool({ name: 'list_topics', arguments: {} }) as Promise<ToolResult>;
    await inHandler;

    let closeDone = false;
    const closing = listener.close().then(() => {
      closeDone = true;
    });
    // The request is still running: close() must not resolve, nor cut the request off.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closeDone).toBe(false);

    release();
    const res = await call;
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text)).toEqual([TOPIC]);

    // The client's standalone GET stream is in flight too; it ends when the client closes.
    const t0 = performance.now();
    await transport.close();
    await closing;
    expect(performance.now() - t0).toBeLessThan(CLOSE_BUDGET_MS);

    expect(await connectionRefused(port)).toBe(true);
    await expect(fetch(turn.url, { method: 'POST' })).rejects.toThrow();
  });
});
