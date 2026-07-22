#!/usr/bin/env node
// topic-generation (task 3.2) — the "partial new set, then the CLI turn
// fails" double: makes REAL `create_topic` MCP calls (see
// fake-claude-topics-success.mjs's header note on why this is a real round
// trip, not simulated stream-json) so some new-run topics genuinely exist in
// the session's DB, then exits non-zero with NO terminal `result` line — a
// CLI-signaled failure (`{ok:false, detail:'upstream-failed'}` via
// `relayAiChatTurn`), exactly `fake-claude-error.mjs`'s failure shape.
//
// This is the fixture that makes the byte-for-byte prior-topics assertion
// non-trivial: it proves `deleteTopics(newIds)` on the failure path removes
// ONLY the topics THIS run created (the ones this fixture just inserted for
// real), leaving the session's pre-run topics — seeded by the test before
// the request — completely untouched (same ids/ordinals/created_at).

import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const TOPIC_COUNT = 2;

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
  const client = new Client({ name: 'fake-claude-topics-partial-fail', version: '0.0.0' });
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
        arguments: { summary: `Partial fixture topic ${i}`, topic_level: 1 },
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

  // Create the partial-new set for real, THEN fail — no result line at all,
  // matching fake-claude-error.mjs's CLI-signaled-failure shape.
  await createRealTopics(argv);
  process.exitCode = 1;
}

main();
