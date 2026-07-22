// REAL end-to-end topic-generation test — spawns the ACTUAL `claude` CLI
// against the real in-process autologger MCP server and asserts topics are
// genuinely created from a real transcript.
//
// WHY: the hermetic `topicGenerate.test.ts` / integration tests drive a FAKE
// claude (fixtures), so they cannot catch *model-behavior* failures — e.g. the
// real model, told by the reused system prompt to `list_topics` (a tool the
// one-shot withholds), creating ZERO topics. This test exercises the true path.
//
// GATED — costs real Anthropic spend, so it NEVER runs in `npm test`. It runs
// ONLY when the operator explicitly opts in with `RUN_REAL_AI_TESTS=1` AND a
// `claude` CLI is resolvable (via `CLAUDE_CLI_PATH` or on `PATH`). Run it with:
//
//   RUN_REAL_AI_TESTS=1 npm run test:real -w server
//
// Deterministic skip otherwise (no spawn, no spend).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionHubRegistry } from '../session/SessionHub';
import { AiMcpListener } from './aiMcpServer';
import { generateTopicsTurn } from './topicGenerate';

function resolveClaude(): string | null {
  const candidate = (process.env.CLAUDE_CLI_PATH || '').trim() || 'claude';
  const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
  return probe.status === 0 ? candidate : null;
}

// Gate the CLI probe itself behind the opt-in: in a normal `npm test` run this
// module is imported (vitest's unit glob includes it), so an unconditional
// probe would spawn `claude --version` on every test run. Only resolve when the
// operator has opted in — otherwise no subprocess is spawned at all.
const OPTED_IN = process.env.RUN_REAL_AI_TESTS === '1';
const cliPath = OPTED_IN ? resolveClaude() : null;
const RUN = OPTED_IN && cliPath !== null;

// A transcript with genuine multi-segment CONTENT (not an intro that merely
// *previews* segments — that is ambiguous and a smart model may collapse it to
// one "intro" topic). Three subjects are actually discussed here, so a working
// per-subject generate reliably produces multiple topics.
const TRANSCRIPT_WORDS = (
  'The Falcon Heavy launched Tuesday morning carrying a large communications satellite into ' +
  'orbit. Both side boosters flew back and landed upright on the concrete pads. The center ' +
  'core landed on the droneship out at sea. Reusing the boosters like this cuts the cost per ' +
  'kilogram dramatically, and commercial customers are already lining up for the next slots. ' +
  'Alright, moving on to coffee. Ethiopian Yirgacheffe has these bright floral and citrus ' +
  'notes that really come through in a light roast. Push the roast darker and you trade that ' +
  'origin character for chocolate and nutty flavors. We brewed a pour over of it this morning ' +
  'and the acidity was fantastic. Now for our final segment, the history of jazz. New Orleans ' +
  'in the early nineteen hundreds is where the genre was really born. Brass bands and street ' +
  'parades and a spirit of improvisation all fed into it. Louis Armstrong then carried that ' +
  'sound around the world, and you can still hear its DNA in the samples on modern hip hop records.'
).split(/\s+/);

describe.skipIf(!RUN)('REAL claude topic generation (opt-in: RUN_REAL_AI_TESTS=1)', () => {
  let dataDir: string;
  let registry: SessionHubRegistry;
  let listener: AiMcpListener;
  const sessionId = 'real-topic-gen';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'real-topics-'));
    registry = new SessionHubRegistry(join(dataDir, 'sessions'));
    const hub = registry.get(sessionId);
    for (const w of TRANSCRIPT_WORDS) {
      hub.insertTranscriptWord({ session_time: '00:00:01', speaker: '0', word: w });
    }
    listener = new AiMcpListener(registry);
    await listener.start();
  });

  afterAll(async () => {
    await listener?.close();
    registry?.closeAll();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it(
    'creates real topics from a real transcript',
    async () => {
      const hub = registry.get(sessionId);
      expect(hub.listTranscriptWords().length).toBeGreaterThan(0);

      const outcome = await generateTopicsTurn({
        registry,
        cliPath: cliPath as string,
        sessionId,
        maxBudgetUsd: 5,
        timeoutMs: 300_000,
      });

      const topics = registry.get(sessionId).listTopics();
      // Surface what actually happened so a 0-topics run is diagnosable.
      // biome-ignore lint/suspicious/noConsole: operator-facing diagnostic for a gated real test.
      console.log(
        `[real topic gen] outcome=${JSON.stringify(outcome)} topics=${topics.length}: ` +
          topics.map((t) => t.summary).join(' | '),
      );

      expect(outcome.ok).toBe(true);
      // The core assertion the fake fixtures cannot make: the real model
      // actually created topics (this fails on the list_topics-withheld
      // prompt-contradiction bug that produced "created 0 topics").
      expect(topics.length).toBeGreaterThanOrEqual(2);
      for (const t of topics) {
        expect(t.summary.trim().length).toBeGreaterThan(0);
      }
    },
    320_000,
  );
});
