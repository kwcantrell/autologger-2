#!/usr/bin/env node
// ai-v2-dashboards (task 0.9) — hermetic test double standing in for the
// real `claude` binary, but on the Agent SDK's OWN transport rather than
// the CLI transport `fake-claude.mjs` serves (ai-topics-chat). The two
// transports are different code paths: `fake-claude.mjs` is exec'd by a
// direct `node:child_process.spawn` call inside `aiChatRunner.ts`, which a
// test-local `vi.mock('node:child_process')` can intercept because the test
// imports that module directly. The Agent SDK bundles its OWN spawn call
// inside `@anthropic-ai/claude-agent-sdk`'s `sdk.mjs` (confirmed by reading
// the pinned copy: `import{spawn as Hbe}from"child_process"`), reached
// through whatever module eventually imports the SDK — per tasks.md's
// "Test-infra note", once that happens through the shared `app` singleton,
// the eager `app` build binds the real `spawn` before a hoisted mock can
// retarget it, making the mock vacuous. This fixture sidesteps that
// entirely: it is a real, separate file on disk, selected via the SDK's own
// `pathToClaudeCodeExecutable` option (sdk.d.ts: "Path to the Claude Code
// executable. Uses the built-in executable if not specified.") — the SDK's
// documented indirection for pointing at a non-default executable, mirroring
// the CLI transport's spirit (an on-disk double stands in for `claude`)
// without relying on any mock timing.
//
// Because `pathToClaudeCodeExecutable` here ends in `.mjs`, the SDK spawns
// `node <this file> <cli flags...>` (confirmed from source: `sdk.mjs`'s
// `Ybe()` treats `.js`/`.mjs`/`.ts`/`.tsx`/`.jsx` paths as needing a JS
// runtime, not as a native binary to exec directly) — so this file is read
// as a plain ES module, the shebang above is for manual/documentation use
// only.
//
// Appends ONE JSON line recording this invocation (argv only; this process
// never reads stdin and never speaks the stream-json protocol) to
// AI_V2_SDK_SPAWN_RECORDER_OUT — default `.spawn-recorder.jsonl` inside this
// process's own cwd, mirroring `fake-claude.mjs`'s default-in-cwd
// convention — then exits immediately with code 0.
//
// The SDK will surface a "process exited" error to its caller once it never
// receives the stream-json handshake this fixture deliberately never sends.
// That is expected and irrelevant to what this fixture exists to test: the
// assertion callers make against it is spawn/no-spawn, never turn
// completion.

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const outPath = process.env.AI_V2_SDK_SPAWN_RECORDER_OUT ?? join(process.cwd(), '.spawn-recorder.jsonl');

const record = {
  argv: process.argv.slice(2),
  pid: process.pid,
  cwd: process.cwd(),
};

appendFileSync(outPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });

process.exit(0);
