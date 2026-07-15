#!/usr/bin/env node
// ai-topics-chat (design D10, task 3.1) — hermetic test double for the `claude`
// CLI. Tests point CLAUDE_CLI_PATH (or spawnAiChatTurn's cliPath) directly at
// this file's absolute path; `node:child_process.spawn` execs it via its
// shebang, exactly like the real globally-installed `claude` binary. No real
// Anthropic credentials or network access are used anywhere in the test suite.
//
// Recording (so the characterization test — task 3.2 — can pin the lockdown
// verbatim): if set, each of these env vars gets one file written before the
// canned behavior runs:
//   FAKE_CLAUDE_ARGV_OUT  — JSON array of argv (process.argv.slice(2))
//   FAKE_CLAUDE_ENV_OUT   — JSON object of this process's full env (proves the
//                           runner's minimal-env whitelist reached the child —
//                           whatever's NOT in this dump was correctly stripped)
//   FAKE_CLAUDE_CWD_OUT   — process.cwd() (proves the stable per-session cwd)
//   FAKE_CLAUDE_STDIN_OUT — the full stdin text this process drained (proves
//                           the user message arrived via stdin, never argv)
//
// Mode select via FAKE_CLAUDE_MODE (default "success"):
//   success        — canned stream-json matching the 2026-07-14 spike taxonomy
//                    (design D6): system/init w/ session_id, interleaved
//                    stream_event thinking/text/tool_use partials (to prove
//                    the relay's dedup + thinking-filter — task 3.3), full
//                    assistant messages (text + a create_topic tool_use), and
//                    a terminal success `result`. Exit 0.
//   exit-nonzero   — drains stdin, writes nothing to stdout, exits 1.
//   garbage        — writes non-JSON lines to stdout, exits 0 (unparseable
//                    output, not a crash — spec "Failed turn" scenario).
//   not-logged-in  — writes a plain-text (non-stream-json) CLI auth message
//                    to stderr, including a device-login URL — the exact kind
//                    of string the server's `error` event MUST scrub — exits 1.
//   hang           — emits the init line only, then never exits on its own
//                    (task 3.4's guaranteed-timeout-kill path uses this).
//
// `--resume <id>` in argv is honored: the emitted session_id echoes the
// resumed id instead of the fixture's default, so multi-turn continuity tests
// (task 3.3) can assert the id stayed stable across two spawns.

import { writeFileSync } from 'node:fs';

const DEFAULT_SESSION_ID = 'fixture-cli-session-id';
const TOOL_NAME = 'mcp__autologger__create_topic';

function resumeSessionId(argv) {
  const i = argv.indexOf('--resume');
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

async function drainStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function writeIfSet(envVar, contents) {
  const path = process.env[envVar];
  if (path) writeFileSync(path, contents);
}

function line(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function emitInit(sessionId) {
  line({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: sessionId,
    tools: [TOOL_NAME],
    mcp_servers: [{ name: 'autologger', status: 'connected' }],
    model: 'fixture-model',
    permissionMode: 'default',
    apiKeySource: 'none',
    claude_code_version: 'fixture',
  });
}

function emitSuccessTurn(sessionId) {
  emitInit(sessionId);

  // ── Thinking block: partial stream_event lines (must NOT be relayed as
  // `delta` — task 3.3's filter test target) ──
  line({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    session_id: sessionId,
  });
  line({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Checking existing topics before creating a new one.' } },
    session_id: sessionId,
  });
  line({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture-signature' } },
    session_id: sessionId,
  });
  // Full assistant message re-carries the same thinking content (the
  // --include-partial-messages double-emit design D6 documents) — the relay
  // must drop `thinking` content from BOTH sources.
  line({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Checking existing topics before creating a new one.', signature: 'fixture-signature' }],
    },
    session_id: sessionId,
  });

  // ── tool_use: create_topic (short name mcp__autologger__create_topic,
  // stripped to `create_topic` for the `tool` SSE event — task 3.3) ──
  line({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_fixture01', name: TOOL_NAME, input: {} },
    },
    session_id: sessionId,
  });
  line({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_fixture01',
          name: TOOL_NAME,
          input: { session_time: '00:01:00', duration_sec: 30, topic_level: 1, summary: 'Fixture topic' },
        },
      ],
    },
    session_id: sessionId,
  });
  line({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fixture01', content: [{ type: 'text', text: '{"ok":true}' }] }] },
    session_id: sessionId,
  });

  // ── Assistant text: partial stream_event (MUST be dropped by the relay —
  // task 3.3's dedup rule, design D6) followed by the full assistant message
  // (the relay's single source of truth for `delta` events) ──
  line({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
    session_id: sessionId,
  });
  line({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Created a fixture topic.' } },
    session_id: sessionId,
  });
  line({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Created a fixture topic.' }] },
    session_id: sessionId,
  });

  // ── Terminal result (design D6: session id relayed in `done`) ──
  line({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Created a fixture topic.',
    session_id: sessionId,
    total_cost_usd: 0.0001,
  });
}

async function main() {
  const argv = process.argv.slice(2);
  writeIfSet('FAKE_CLAUDE_ARGV_OUT', JSON.stringify(argv));
  writeIfSet('FAKE_CLAUDE_ENV_OUT', JSON.stringify(process.env));
  writeIfSet('FAKE_CLAUDE_CWD_OUT', process.cwd());

  const mode = process.env.FAKE_CLAUDE_MODE || 'success';
  const sessionId = resumeSessionId(argv) || DEFAULT_SESSION_ID;

  if (mode === 'hang') {
    // Drain stdin (spec: message arrives via stdin) so the parent's
    // child.stdin.end() doesn't itself hang, then emit only the init line and
    // never exit on our own — task 3.4's guaranteed-timeout-kill test relies
    // on the parent SIGTERM/SIGKILL-ing this process, never a self-exit.
    const stdin = await drainStdin();
    writeIfSet('FAKE_CLAUDE_STDIN_OUT', stdin);
    emitInit(sessionId);
    // A bare unresolved Promise does NOT keep Node's event loop alive on its
    // own — with stdin already drained and no other handles open, the process
    // would exit 0 right here instead of hanging. Hold an active timer handle
    // so the process genuinely hangs until the parent sends SIGTERM/SIGKILL
    // (task 3.4's guaranteed-timeout-kill path).
    setInterval(() => {}, 1 << 30);
    return;
  }

  const stdin = await drainStdin();
  writeIfSet('FAKE_CLAUDE_STDIN_OUT', stdin);

  switch (mode) {
    case 'exit-nonzero': {
      process.exitCode = 1;
      return;
    }
    case 'garbage': {
      process.stdout.write('not json at all\n');
      process.stdout.write('{{ this is not valid JSON either\n');
      process.exitCode = 0;
      return;
    }
    case 'not-logged-in': {
      // Real CLI auth failures surface plain text (not stream-json) including
      // a device-login URL — exactly the class of string the server's
      // `error` event MUST scrub (spec "SSE reply stream shape").
      process.stderr.write(
        'Invalid API key · Please run `claude login` to authenticate.\n' +
          'Visit https://claude.ai/login?code=FIXTURE-DEVICE-CODE to continue.\n',
      );
      process.exitCode = 1;
      return;
    }
    case 'success':
    default: {
      emitSuccessTurn(sessionId);
      process.exitCode = 0;
      return;
    }
  }
}

main();
