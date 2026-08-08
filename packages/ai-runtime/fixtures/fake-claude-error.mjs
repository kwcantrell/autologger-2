#!/usr/bin/env node
// topic-generation (task 2.3) — a fixed-behavior CLI-error double: drains
// stdin (so the parent's `child.stdin.end()` doesn't itself hang, matching
// every mode in `fake-claude.mjs`) then exits non-zero with no stdout at
// all — a CLI-signaled failure (`{ok:false, detail:'upstream-failed'}` via
// `relayAiChatTurn`), exactly `fake-claude.mjs`'s `exit-nonzero` mode.
//
// A SEPARATE fixture file (not `FAKE_CLAUDE_MODE=exit-nonzero` against
// `fake-claude.mjs`) because `spawnAiChatTurn`'s minimal child-env whitelist
// (design D4) strips every env var except HOME/PATH/proxy-TLS before the
// child ever sees it — `FAKE_CLAUDE_MODE` cannot reach the child through the
// real spawn path `driveAiTurn`/`generateTopicsTurn` exercises. Selecting the
// failure mode via `cliPath` instead (mirroring
// `fake-claude-exit-before-stdin.mjs`'s established precedent) lets the test
// drive the REAL `spawnAiChatTurn` code path end-to-end rather than bypassing
// it.

async function drainStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  await drainStdin();
  process.exitCode = 1;
}

main();
