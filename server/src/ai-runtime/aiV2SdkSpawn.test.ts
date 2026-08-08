// ai-v2-dashboards (task 0.9) — no-spawn assertion seam for the Agent SDK
// transport. See design.md D7/D8 and the spec's "Design turn contract": "No
// guard path SHALL spawn a subprocess." The CLI-transport `fake-claude`
// argv-recording fixture (ai-topics-chat) does not reach the SDK's own
// transport — it is exec'd by a direct `node:child_process.spawn` call made
// FROM `aiChatRunner.ts`, which a test-local `vi.mock('node:child_process')`
// can intercept only because the test imports that module directly. The SDK
// bundles its OWN spawn call inside `sdk.mjs`; per tasks.md's "Test-infra
// note", once that module is reached through the shared `app` singleton the
// eager `app` build binds the real `spawn` before a hoisted mock can
// retarget it, so the same mock pattern is vacuous there. This test
// deliberately does NOT use `vi.mock('node:child_process')` or a spawnSpy —
// it exercises the SDK's own indirection instead: `pathToClaudeCodeExecutable`
// pointed at an on-disk recorder script
// (`server/src/test/fixtures/ai-v2-sdk-spawn-recorder.mjs`) that stands in
// for the real `claude` binary and records its own invocation to a file.
// That file is the assertion surface — real, separate from the mock
// registry, with no timing dependency on `app`'s eager build.
//
// Two controls, per task 0.9:
//   - POSITIVE: `attemptDesignTurnSpawn` (server/src/ai-runtime/aiV2SdkSpawn.ts
//     — the one call site reaching the SDK's `query()`) is invoked directly.
//     The recorder file gains exactly one line. This proves the seam can
//     DETECT a spawn, not merely that spawning never happens.
//   - NEGATIVE: a guard chain shaped like the design endpoint's real guard
//     order (spec: auth -> session 404 -> config/open-network 503 -> body
//     422/400 -> slot 409) returns early on every rejecting branch WITHOUT
//     calling `attemptDesignTurnSpawn`. Task 2.2 owns the real guard chain;
//     `simulateGuardedAttempt` below is the pattern it must follow — this
//     test is only meaningful because the positive control (above) proves
//     the recorder would catch a violation.
//
// Gate-intent check (recorded in task 0.9's report, not in this file):
// this test was verified to go RED when a guard-rejected branch was
// temporarily made to call `attemptDesignTurnSpawn` anyway, then reverted.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { attemptDesignTurnSpawn } from './aiV2SdkSpawn';

const RECORDER_SCRIPT = fileURLToPath(
  new URL('../test/fixtures/ai-v2-sdk-spawn-recorder.mjs', import.meta.url),
);

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeHermeticDirs(): { recorderFile: string; cwd: string; configDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'ai-v2-spawn-seam-'));
  tmpDirs.push(root);
  const cwd = join(root, 'cwd');
  const configDir = join(root, 'config');
  // The SDK spawns with this `cwd` directly (no auto-create) — it must
  // exist before the child is spawned, or spawn fails with ENOENT on the
  // cwd itself rather than exercising the recorder at all.
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  return {
    recorderFile: join(root, 'invocations.jsonl'),
    cwd,
    configDir,
  };
}

function readInvocations(recorderFile: string): unknown[] {
  if (!existsSync(recorderFile)) return [];
  const raw = readFileSync(recorderFile, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => JSON.parse(line));
}

/**
 * Minimal `Options` pointing the SDK at the recorder fixture in place of the
 * real `claude` binary. Never spawns a real CLI, never reaches the network,
 * never spends anything — the recorder exits immediately without speaking
 * the stream-json protocol.
 */
function buildRecorderOptions(recorderFile: string, cwd: string, configDir: string): Options {
  return {
    pathToClaudeCodeExecutable: RECORDER_SCRIPT,
    cwd,
    settingSources: [],
    strictMcpConfig: true,
    tools: [],
    forkSession: false,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      CLAUDE_CONFIG_DIR: configDir,
      AI_V2_SDK_SPAWN_RECORDER_OUT: recorderFile,
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: condition never became true');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('AI v2 SDK-path no-spawn assertion seam (task 0.9)', () => {
  it('positive control: an allowed attempt reaches the SDK, and the recorder observes exactly one spawn', async () => {
    const { recorderFile, cwd, configDir } = makeHermeticDirs();
    const options = buildRecorderOptions(recorderFile, cwd, configDir);

    const turn = attemptDesignTurnSpawn('say hi', options);
    // The recorder never speaks the stream-json protocol, so reading (or
    // even just closing) the turn surfaces a process-exit error — expected,
    // and irrelevant to this test: the assertion is spawn/no-spawn, not
    // turn completion (task 0.9's own framing).
    try {
      for await (const _message of turn) {
        break;
      }
    } catch {
      // expected: the recorder is not a real agent and never yields a
      // real message.
    }

    await waitFor(() => existsSync(recorderFile));

    const invocations = readInvocations(recorderFile);
    expect(invocations).toHaveLength(1);
  });

  it('negative control: every guard-rejected branch invokes zero spawns', async () => {
    const { recorderFile, cwd, configDir } = makeHermeticDirs();
    const options = buildRecorderOptions(recorderFile, cwd, configDir);

    type GuardOutcome =
      | 'unauthenticated'
      | 'session-not-found-or-out-of-studio'
      | 'unconfigured-or-open-network'
      | 'invalid-body'
      | 'slot-busy'
      | 'allowed';

    // Shaped like the design endpoint's real guard order (spec "Design turn
    // contract"): auth -> session 404 -> config/open-network 503 -> body
    // 422/400 -> slot 409. Task 2.2 owns the real implementation; this is
    // the pattern it must follow — every rejecting branch returns BEFORE
    // `attemptDesignTurnSpawn` is ever called.
    function simulateGuardedAttempt(outcome: GuardOutcome) {
      switch (outcome) {
        case 'unauthenticated':
        case 'session-not-found-or-out-of-studio':
        case 'unconfigured-or-open-network':
        case 'invalid-body':
        case 'slot-busy':
          return undefined; // rejected: never reaches attemptDesignTurnSpawn
        case 'allowed':
          return attemptDesignTurnSpawn('say hi', options);
        default: {
          const exhaustive: never = outcome;
          throw new Error(`unhandled guard outcome: ${exhaustive}`);
        }
      }
    }

    const rejectingOutcomes: GuardOutcome[] = [
      'unauthenticated',
      'session-not-found-or-out-of-studio',
      'unconfigured-or-open-network',
      'invalid-body',
      'slot-busy',
    ];

    for (const outcome of rejectingOutcomes) {
      const result = simulateGuardedAttempt(outcome);
      expect(result).toBeUndefined();
    }

    // Give any (unexpected) spawn a moment to land before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(existsSync(recorderFile)).toBe(false);
    expect(readInvocations(recorderFile)).toHaveLength(0);
  });
});
