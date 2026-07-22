#!/usr/bin/env node
// topic-generation (task 3.2) — a hermetic double that, unlike
// fake-claude.mjs's `success` mode (which only prints a SIMULATED
// create_topic tool_use line, never actually calling the tool), makes a REAL
// MCP round trip: it reads the generated `--mcp-config` file's url + bearer
// token — exactly as the real `claude` CLI would — and issues genuine
// `create_topic` tool calls against the actual AiMcpListener the test
// process is running. This is what lets an integration test prove the
// route's crash-safe swap (design D3) against REAL rows in the session's
// DB (`newIds = after − preRunIds`) rather than merely a simulated stream.
//
// A SEPARATE fixture file (not a `FAKE_CLAUDE_MODE` value on
// fake-claude.mjs): the parent's minimal child-env whitelist (design D4)
// strips every env var except HOME/PATH/proxy-TLS before the child ever
// sees it, so mode selection has to happen via `cliPath` — mirrors
// `fake-claude-error.mjs`'s established precedent.
//
// Behavior: drains stdin, creates TOPIC_COUNT topics for real via the MCP
// `create_topic` tool, then emits a genuine stream-json `system/init` +
// terminal `result` (subtype success, is_error:false) and exits 0 — a
// real CLI-turn success with real topics attached.

import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_SESSION_ID = 'fixture-cli-session-id';
const TOPIC_COUNT = 2;

function resumeSessionId(argv) {
  const i = argv.indexOf('--resume');
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

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
  const client = new Client({ name: 'fake-claude-topics-success', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return { client, close: () => transport.close() };
}

async function createRealTopics(argv) {
  const cfg = JSON.parse(readFileSync(mcpConfigPath(argv), 'utf8'));
  const { url, headers } = cfg.mcpServers.autologger;
  const token = String(headers.Authorization).replace(/^Bearer /, '');
  const { client, close } = await connectMcp(url, token);
  try {
    for (let i = 0; i < TOPIC_COUNT; i += 1) {
      await client.callTool({
        name: 'create_topic',
        arguments: { summary: `Fresh fixture topic ${i}`, topic_level: 1 },
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

  const sessionId = resumeSessionId(argv) || DEFAULT_SESSION_ID;

  await createRealTopics(argv);

  line({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: sessionId,
    tools: ['mcp__autologger__create_topic'],
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
    result: `Created ${TOPIC_COUNT} fresh topics.`,
    session_id: sessionId,
    total_cost_usd: 0.0002,
  });
  process.exitCode = 0;
}

main();
