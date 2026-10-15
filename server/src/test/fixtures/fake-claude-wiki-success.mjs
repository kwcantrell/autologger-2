#!/usr/bin/env node
// show-wiki-ai (task 5.1) — a hermetic CLI double for `wiki/generate` that, like
// fake-claude-topics-success.mjs, makes REAL MCP round trips against the in-process AiMcpListener
// the test process runs: it reads the `--mcp-config` file's url and bearer token, as the real
// `claude` CLI would, and calls the wiki turn's tools.
//
// Behavior: drains stdin (the fixed wiki message, which names the session id the citations must
// quote), reads the transcript to its LAST page through `get_transcript_words` (following each
// page's continuation marker), calls `list_wiki_pages`, then proposes ONE new person page "Alice"
// whose body quotes the words the integration test seeds at 00:01:00 ("Alice joined the band"),
// then emits a stream-json `system/init` and a terminal `result` (success) and exits 0. The tool
// results it got are written to `.fixture-tool-results.json` in the run's cwd (the
// `.fixture-argv.json` convention), so a test can see what the tools answered.

import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MAX_PAGES = 100;

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

function writeIn(name, contents) {
  writeFileSync(`${process.cwd()}/${name}`, contents);
}

function line(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const textOf = (res) => res?.content?.[0]?.text ?? '';

async function run(argv, sessionId) {
  const cfg = JSON.parse(readFileSync(mcpConfigPath(argv), 'utf8'));
  const { url, headers } = cfg.mcpServers.autologger;
  const token = String(headers.Authorization).replace(/^Bearer /, '');
  const client = new Client({ name: 'fake-claude-wiki-success', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  const results = [];
  try {
    let page = 0;
    for (let read = 1; read <= MAX_PAGES; read += 1) {
      const res = await client.callTool({ name: 'get_transcript_words', arguments: { page } });
      const marker =
        /--- transcript continues: call get_transcript_words with page=(\d+) of \d+ ---$/.exec(
          textOf(res).trimEnd(),
        );
      if (!marker) break;
      page = Number(marker[1]);
    }
    results.push(textOf(await client.callTool({ name: 'list_wiki_pages', arguments: {} })));
    const proposed = await client.callTool({
      name: 'propose_page',
      arguments: {
        kind: 'person',
        title: 'Alice',
        aliases: [],
        body_md: `Alice plays bass. [Alice joined the band](cite:${sessionId}@60)\n`,
        rationale: 'Alice is introduced in this session.',
      },
    });
    results.push(textOf(proposed));
  } finally {
    await transport.close();
  }
  writeIn('.fixture-tool-results.json', JSON.stringify(results));
}

async function main() {
  const argv = process.argv.slice(2);
  writeIn('.fixture-argv.json', JSON.stringify(argv));
  const stdin = await drainStdin();
  const sessionId = /cite:([^@\s]+)@/.exec(stdin)?.[1] ?? 'unknown-session';
  await run(argv, sessionId);
  line({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: 'fixture-cli-session-id',
    tools: [
      'mcp__autologger__get_transcript_words',
      'mcp__autologger__list_wiki_pages',
      'mcp__autologger__read_wiki_page',
      'mcp__autologger__propose_page',
    ],
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
    result: 'Proposed 1 page.',
    session_id: 'fixture-cli-session-id',
    total_cost_usd: 0.0002,
  });
  process.exitCode = 0;
}

main();
