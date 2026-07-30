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
// Behavior: drains stdin, reads the transcript to its LAST page via the MCP
// `get_transcript_words` tool (following each page's continuation marker, as
// the prompt directs a real model to), creates TOPIC_COUNT topics for real via
// the MCP `create_topic` tool, then emits a genuine stream-json `system/init` +
// terminal `result` (subtype success, is_error:false) and exits 0 — a
// real CLI-turn success with real topics attached.
//
// The paging loop is load-bearing, not decoration (topic-generate-paged-
// transcript D6): the route's crash-safe swap only replaces the prior topics
// when the run fetched EVERY page of its snapshot, so a double that created
// topics without reading the transcript would take the 502-and-restore path.

import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_SESSION_ID = 'fixture-cli-session-id';
const TOPIC_COUNT = 2;
/** Runaway guard on the paging loop (a fixture must never hang the suite). */
const MAX_PAGES = 100;

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

/** Follow the continuation markers from page 0 to the last page, the way the
 * system prompt directs the real model to. Returns the number of pages read. */
async function readAllTranscriptPages(client) {
  let page = 0;
  for (let read = 1; read <= MAX_PAGES; read += 1) {
    const res = await client.callTool({ name: 'get_transcript_words', arguments: { page } });
    const text = res?.content?.[0]?.text ?? '';
    const marker = /--- transcript continues: call get_transcript_words with page=(\d+) of \d+ ---$/.exec(
      text.trimEnd(),
    );
    if (!marker) return read;
    page = Number(marker[1]);
  }
  throw new Error(`fixture read ${MAX_PAGES} pages without reaching an unmarked page`);
}

async function createRealTopics(argv) {
  const cfg = JSON.parse(readFileSync(mcpConfigPath(argv), 'utf8'));
  const { url, headers } = cfg.mcpServers.autologger;
  const token = String(headers.Authorization).replace(/^Bearer /, '');
  const { client, close } = await connectMcp(url, token);
  try {
    await readAllTranscriptPages(client);
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
    tools: ['mcp__autologger__get_transcript_words', 'mcp__autologger__create_topic'],
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
