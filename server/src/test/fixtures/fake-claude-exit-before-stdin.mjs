#!/usr/bin/env node
// ai-topics-chat (Phase 3 fix wave — task 3.4 critical-defect fix, D8) — a
// dedicated hermetic double that exits BEFORE ever reading stdin. Every mode
// in `fake-claude.mjs` drains stdin first (see that file's header), so none
// of them can reach the crash this fixture targets. Selected directly via
// `cliPath` (never `FAKE_CLAUDE_MODE`, which `buildAiChatChildEnv`'s minimal
// whitelist strips before it reaches a child spawned through the real
// `spawnAiChatTurn` — see aiChatRunner.ts), so the actual production
// spawn-then-stdin-write code path is exercised, not a bypass.
//
// Models a real/old `claude` binary that rejects the lockdown flags (or any
// broken install) and exits immediately: `spawnAiChatTurn`'s buffered
// `child.stdin.write(message)` then flushes against a pipe whose read end is
// already closed, which — without a `child.stdin` 'error' listener — throws
// an unhandled EPIPE and crashes the whole single Node process (design D8:
// a broken install must fail per-turn, never take down the process).
process.exit(1);
