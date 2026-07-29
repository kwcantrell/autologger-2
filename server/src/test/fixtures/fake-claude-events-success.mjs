#!/usr/bin/env node
// auto-generate-event-logs (task 4.3) — hermetic double for a SUCCESSFUL
// event-generation CLI turn that, like fake-claude-topics-success.mjs (whose
// header explains why this is a separate fixture file rather than a
// FAKE_CLAUDE_MODE value: the parent's minimal child-env whitelist strips
// mode-selection env vars, so behavior selection happens via cliPath), makes
// REAL MCP round trips: it reads the generated `--mcp-config` url + bearer
// token exactly as the real `claude` CLI would and issues genuine
// `create_event` tool calls against the actual AiMcpListener the test
// process is running — so the route's `{created, cap_hit}` response and the
// persisted rows are proven against the real registration/counter/cap
// machinery, not simulated stream-json.
//
// Behavior: drains stdin, ATTEMPTS EVENT_ATTEMPTS (3) create_event calls for
// the category id 'slate' (the int test seeds a show whose instruction-
// bearing button has this id) at fixed timecodes, tolerating isError tool
// results (exactly like the real model at the cap: the tool errors, the turn
// continues), then emits a genuine stream-json `system/init` + terminal
// success `result` and exits 0. With the default cap the route reports
// created:3 cap_hit:false; with EVENT_GENERATE_MAX_CREATED_EVENTS=2 the
// third call is refused at the tool and the route reports created:2
// cap_hit:true — same fixture, both paths.

import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_SESSION_ID = 'fixture-cli-session-id';
const EVENT_ATTEMPTS = 3;
const CATEGORY_ID = 'slate';
const SESSION_TIMES = ['00:00:02:00', '00:00:04:00', '00:00:06:00'];

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

function line(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function connectMcp(url, token) {
  const client = new Client({ name: 'fake-claude-events-success', version: '0.0.0' });
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
    for (let i = 0; i < EVENT_ATTEMPTS; i += 1) {
      // isError tool results (e.g. the per-run cap) are tolerated — the real
      // model keeps its turn going after a refused call, and so does this.
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

  await createRealEvents(argv);

  line({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: DEFAULT_SESSION_ID,
    tools: ['mcp__autologger__get_transcript_words', 'mcp__autologger__create_event'],
    mcp_servers: [{ name: 'autologger', status: 'connected' }],
    model: 'fixture-model',
    permissionMode: 'default',
    apiKeySource: 'none',
    claude_code_version: 'fixture',
  });
  line({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: `Attempted ${EVENT_ATTEMPTS} events.`,
    session_id: DEFAULT_SESSION_ID,
    total_cost_usd: 0.0002,
  });
  process.exitCode = 0;
}

main();
