#!/usr/bin/env node
// auto-generate-event-logs (task 4.3) — the "partial events created, then the
// CLI turn fails" double: makes REAL `create_event` MCP calls (see
// fake-claude-events-success.mjs's header on why this is a real round trip
// via a separate fixture file), then exits non-zero with NO terminal `result`
// line — a CLI-signaled failure (`{ok:false, detail:'upstream-failed'}` via
// `relayAiChatTurn`), exactly fake-claude-error.mjs's failure shape.
//
// This is the fixture behind the spec's "Partial results survive a failed
// run" scenario: the route must answer 502 with the fixed scrubbed detail
// (and NO created-count anywhere in the body) while the events this fixture
// genuinely inserted before failing REMAIN persisted, and the catalog live
// projection still reflects them.

import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const EVENT_COUNT = 2;
const CATEGORY_ID = 'slate';
const SESSION_TIMES = ['00:00:02:00', '00:00:04:00'];

function mcpConfigPath(argv) {
  const i = argv.indexOf('--mcp-config');
  if (i === -1 || !argv[i + 1]) throw new Error('fixture requires --mcp-config in argv');
  return argv[i + 1];
}

async function drainStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function writeIfSet(envVar, defaultName, contents) {
  const path = process.env[envVar] || `${process.cwd()}/${defaultName}`;
  writeFileSync(path, contents);
}

async function connectMcp(url, token) {
  const client = new Client({ name: 'fake-claude-events-partial-fail', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return { client, close: () => transport.close() };
}

async function createRealEvents(argv) {
  const cfg = JSON.parse(readFileSync(mcpConfigPath(argv), 'utf8'));
  const { url, headers } = cfg.mcpServers.autologger;
  const token = String(headers.Authorization).replace(/^Bearer /, '');
  const { client, close } = await connectMcp(url, token);
  try {
    for (let i = 0; i < EVENT_COUNT; i += 1) {
      await client.callTool({
        name: 'create_event',
        arguments: { category: CATEGORY_ID, message: 'SLATE', session_time: SESSION_TIMES[i] },
      });
    }
  } finally {
    await close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  writeIfSet('FAKE_CLAUDE_PID_OUT', '.fixture-pid.txt', String(process.pid));
  writeIfSet('FAKE_CLAUDE_ARGV_OUT', '.fixture-argv.json', JSON.stringify(argv));

  const stdin = await drainStdin();
  writeIfSet('FAKE_CLAUDE_STDIN_OUT', '.fixture-stdin.txt', stdin);

  // Create the partial set for real, THEN fail — no result line at all.
  await createRealEvents(argv);
  process.exitCode = 1;
}

main();
