// topic-generation (task 2.3) — the one-shot generate turn. Covers the three
// gate-intent properties task 2.3 calls out:
//   1. success on the CLI's terminal `result` line (real fixture, real spawn)
//   2. failure on a CLI-signaled error, and on a guaranteed timeout
//   3. the spawned argv's `--allowedTools` includes create_topic/
//      get_transcript_words but EXCLUDES list_topics — the load-bearing
//      mechanism for D3's crash-safe swap (withholding list_topics is what
//      stops the model from deduping against the topics about to be
//      replaced). A vacuous version of this check would assert against a
//      hand-built expected string; instead it reads the argv the fixture
//      itself RECORDED after a real spawn, and independently asserts both
//      "contains the two allowed tools" and "does not contain list_topics"
//      so a bug that dropped the allowedTools restriction entirely (falling
//      back to the full default set) would fail the negative assertion even
//      though the positive one would still pass.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionHubRegistry } from '../session/SessionHub';
import { AI_CHAT_SYSTEM_PROMPT_BRIEF, stableSessionCwd } from './aiChatRunner';
import { __resetAiMcpListenerForTests } from './aiMcpServer';
import {
  generateTopicsTurn,
  TOPIC_GENERATE_MESSAGE,
  TOPIC_GENERATE_SYSTEM_PROMPT,
} from './topicGenerate';

const SUCCESS_FIXTURE = fileURLToPath(new URL('../test/fixtures/fake-claude.mjs', import.meta.url));
const ERROR_FIXTURE = fileURLToPath(
  new URL('../test/fixtures/fake-claude-error.mjs', import.meta.url),
);

let dir: string;
let registry: SessionHubRegistry;
let sessionId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'topic-generate-'));
  registry = new SessionHubRegistry(join(dir, 'sessions'));
  sessionId = `sess-${Math.random().toString(36).slice(2)}`;
});

afterEach(async () => {
  await __resetAiMcpListenerForTests();
  registry.closeAll();
  rmSync(dir, { recursive: true, force: true });
  rmSync(stableSessionCwd(sessionId), { recursive: true, force: true });
});

describe('generateTopicsTurn', () => {
  it("succeeds on the real fixture's terminal result line", async () => {
    const outcome = await generateTopicsTurn({
      registry,
      cliPath: SUCCESS_FIXTURE,
      sessionId,
      maxBudgetUsd: 2.0,
      timeoutMs: 10_000,
    });
    expect(outcome).toEqual({ ok: true, claudeSessionId: 'fixture-cli-session-id' });
  });

  it('the one-shot message reaches the CLI on stdin verbatim (never argv)', async () => {
    await generateTopicsTurn({
      registry,
      cliPath: SUCCESS_FIXTURE,
      sessionId,
      maxBudgetUsd: 2.0,
      timeoutMs: 10_000,
    });
    const stdin = readFileSync(join(stableSessionCwd(sessionId), '.fixture-stdin.txt'), 'utf8');
    expect(stdin).toBe(TOPIC_GENERATE_MESSAGE);
    const argv = JSON.parse(
      readFileSync(join(stableSessionCwd(sessionId), '.fixture-argv.json'), 'utf8'),
    ) as string[];
    expect(argv.join(' ')).not.toContain(TOPIC_GENERATE_MESSAGE);
  });

  it('fails ({ok:false}) on a CLI-signaled error (non-zero exit, no result line)', async () => {
    const outcome = await generateTopicsTurn({
      registry,
      cliPath: ERROR_FIXTURE,
      sessionId,
      maxBudgetUsd: 2.0,
      timeoutMs: 10_000,
    });
    expect(outcome).toEqual({ ok: false, detail: 'upstream-failed' });
  });

  it(
    'fails ({ok:false, detail:"timeout"}) when the run does not finish within timeoutMs, ' +
      'and kills the child (guaranteed-timeout, same mechanism ai/chat uses)',
    async () => {
      // An impossibly-short timeout against the (fast but non-instant) success
      // fixture guarantees a timeout deterministically — a real OS process
      // spawn + Node startup cannot complete inside 1ms — mirroring
      // ai.int.test.ts's own guaranteed-timeout technique.
      const outcome = await generateTopicsTurn({
        registry,
        cliPath: SUCCESS_FIXTURE,
        sessionId,
        maxBudgetUsd: 2.0,
        timeoutMs: 1,
      });
      expect(outcome).toEqual({ ok: false, detail: 'timeout' });
    },
  );

  it(
    'the spawned argv withholds list_topics — allowedTools is exactly ' +
      'get_transcript_words + create_topic (the D3 crash-safe-swap mechanism)',
    async () => {
      await generateTopicsTurn({
        registry,
        cliPath: SUCCESS_FIXTURE,
        sessionId,
        maxBudgetUsd: 2.0,
        timeoutMs: 10_000,
      });
      const argv = JSON.parse(
        readFileSync(join(stableSessionCwd(sessionId), '.fixture-argv.json'), 'utf8'),
      ) as string[];
      const i = argv.indexOf('--allowedTools');
      expect(i).toBeGreaterThanOrEqual(0);
      const allowed = argv[i + 1].split(',');
      expect(allowed).toContain('mcp__autologger__get_transcript_words');
      expect(allowed).toContain('mcp__autologger__create_topic');
      // The negative assertion is the load-bearing one: a regression that
      // dropped the `allowedTools` restriction (falling back to driveAiTurn's
      // full default set) would still pass the two `toContain`s above but
      // would fail here.
      expect(allowed).not.toContain('mcp__autologger__list_topics');
      expect(allowed.join(',')).not.toMatch(/\blist_topics\b/);
    },
  );

  it(
    'the spawned argv uses the DEDICATED generate system prompt, not the ' +
      'chat brief (the reused brief tells the model to list_topics — a withheld ' +
      'tool — which made the real model create too few/zero topics)',
    async () => {
      await generateTopicsTurn({
        registry,
        cliPath: SUCCESS_FIXTURE,
        sessionId,
        maxBudgetUsd: 2.0,
        timeoutMs: 10_000,
      });
      const argv = JSON.parse(
        readFileSync(join(stableSessionCwd(sessionId), '.fixture-argv.json'), 'utf8'),
      ) as string[];
      const i = argv.indexOf('--append-system-prompt');
      expect(i).toBeGreaterThanOrEqual(0);
      const systemPrompt = argv[i + 1];
      expect(systemPrompt).toBe(TOPIC_GENERATE_SYSTEM_PROMPT);
      // Load-bearing negatives: the dedicated prompt must NOT reference the
      // withheld list_topics tool, and must NOT be the reused chat brief.
      expect(systemPrompt).not.toMatch(/list_topics/);
      expect(systemPrompt).not.toBe(AI_CHAT_SYSTEM_PROMPT_BRIEF);
    },
  );
});
