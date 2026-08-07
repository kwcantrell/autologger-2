#!/usr/bin/env node
// event-generate-hardening residual closure (2026-08-07) — a paused variant
// of fake-claude-events-success.mjs: makes ONE real create_event MCP call,
// then BLOCKS until the test signals it to continue, then makes the
// remaining two calls and exits exactly like the success fixture (genuine
// stream-json `system/init` + terminal success `result`, exit 0). This lets
// an int test interleave a REAL HTTP request against the running app WHILE a
// generate turn is still in flight — proving delete-after-success's
// mid-run-visibility and mid-run-manual-delete properties end-to-end,
// closing the residual the archived event-generate-hardening change recorded
// (events.generate.int.test.ts's header note; eventStore.test.ts's
// "mid-run manual delete" unit test comment) because the fake-CLI harness
// had no pause hook.
//
// Pause mechanism: two marker files, both living in THIS process's own cwd
// (the stable per-session cwd `stableSessionCwd(sessionId)` the test already
// knows) — the same file-based convention the FAKE_CLAUDE_*_OUT vars use,
// chosen because `spawnAiChatTurn`'s minimal child-env whitelist (HOME/PATH/
// proxy vars only — aiChatRunner.ts's `buildAiChatChildEnv`) never forwards
// test-only env vars to the child, so a pause CANNOT be signaled by env var;
// a well-known cwd-relative file the test can poll for / write directly can:
//   .fixture-paused.txt — written by THIS fixture once its first
//                         create_event call has landed and it is now
//                         waiting; the test polls for this before issuing
//                         its interleaved request.
//   .fixture-resume.txt — written by the TEST to unblock the fixture. If it
//                         never appears within PAUSE_TIMEOUT_MS the fixture
//                         gives up waiting and proceeds anyway — a test bug
//                         fails loudly on its own assertions rather than
//                         hanging a CI run forever.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_SESSION_ID = 'fixture-cli-session-id';
const EVENT_ATTEMPTS = 3;
const CATEGORY_ID = 'slate';
const SESSION_TIMES = ['00:00:02:00', '00:00:04:00', '00:00:06:00'];
const PAUSE_POLL_MS = 25;
const PAUSE_TIMEOUT_MS = 8000;

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
  const client = new Client({ name: 'fake-claude-events-paused', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return { client, close: () => transport.close() };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForResumeSignal() {
  const resumePath = `${process.cwd()}/.fixture-resume.txt`;
  const deadline = Date.now() + PAUSE_TIMEOUT_MS;
  while (!existsSync(resumePath) && Date.now() < deadline) {
    await sleep(PAUSE_POLL_MS);
  }
}

async function createRealEvents(argv) {
  const cfg = JSON.parse(readFileSync(mcpConfigPath(argv), 'utf8'));
  const { url, headers } = cfg.mcpServers.autologger;
  const token = String(headers.Authorization).replace(/^Bearer /, '');
  const { client, close } = await connectMcp(url, token);
  try {
    // The FIRST call lands for real before the pause — this is the mid-run
    // state an interleaved GET/DELETE must see.
    await client.callTool({
      name: 'create_event',
      arguments: { category: CATEGORY_ID, message: 'SLATE', session_time: SESSION_TIMES[0] },
    });

    writeFileSync(`${process.cwd()}/.fixture-paused.txt`, 'paused');
    await waitForResumeSignal();

    for (let i = 1; i < EVENT_ATTEMPTS; i += 1) {
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
