// REAL end-to-end event-generation test — spawns the ACTUAL `claude` CLI
// against the real in-process autologger MCP server and asserts events are
// genuinely created from a real anchored transcript (auto-generate-event-logs
// task 4.4).
//
// WHY: the hermetic `events.generate.int.test.ts` suite drives a FAKE claude
// (fixtures), so it cannot catch *model-behavior* failures — the real model
// ignoring the message-vocabulary rules, inventing timecodes outside the
// anchored range, or re-logging moments the embedded existing-events list
// already covers. This test exercises the true path twice: a first run over a
// SLATE-style instruction, then a second run over the unchanged transcript
// with the first run's events embedded as the dedup basis.
//
// GATED — costs real Anthropic spend, so it NEVER runs in `npm test`. It runs
// ONLY when the operator explicitly opts in with `RUN_REAL_AI_TESTS=1` AND a
// `claude` CLI is resolvable (via `CLAUDE_CLI_PATH` or on `PATH`). Run it with:
//
//   RUN_REAL_AI_TESTS=1 npm run test:real -w server
//
// Deterministic skip otherwise (no spawn, no spend).
//
// This test drives `driveAiTurn` directly with the SAME inputs the route
// assembles (system prompt, allowlist, run snapshot on the turn registration,
// `buildEventGenerateMessage` message) — the `topicGenerate.real.test.ts`
// direct-drive pattern; the route's guard ladder is the int suite's concern.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionHubRegistry } from '../session/SessionHub';
import { parseTimecodeString, toTotalFrames } from '../timecode';
import { stableSessionCwd } from './aiChatRunner';
import {
  __resetAiMcpListenerForTests,
  type AiGenerationRunContext,
  type AiMcpToolName,
} from './aiMcpServer';
import { driveAiTurn } from './aiTurn';
import {
  buildEventGenerateMessage,
  EVENT_GENERATE_SYSTEM_PROMPT,
  type EventGenerateExistingEvent,
} from './eventGeneratePrompt';

function resolveClaude(): string | null {
  const candidate = (process.env.CLAUDE_CLI_PATH || '').trim() || 'claude';
  const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
  return probe.status === 0 ? candidate : null;
}

// Gate the CLI probe itself behind the opt-in (the topicGenerate.real.test.ts
// rationale): the unit glob imports this module on every `npm test`, so an
// unconditional probe would spawn `claude --version` each run.
const OPTED_IN = process.env.RUN_REAL_AI_TESTS === '1';
const cliPath = OPTED_IN ? resolveClaude() : null;
const RUN = OPTED_IN && cliPath !== null;

// ── Fixture ─────────────────────────────────────────────────────────────────
//
// A 24fps session with a production-floor transcript. The word "slate" is
// spoken at exactly TWO well-separated moments (~121s and ~421s — 300s
// apart); every other line is set chatter that never contains the word. Two
// anchor events in a NON-instruction-bearing category bracket the whole
// transcript (frames 0 → wall T+0s, and 00:10:00:00 → wall T+1200s — a
// deliberate wall-clock pause, so timecode→wall interpolation is nonlinear
// and the feed-order bracketing assertion is a real check, not an identity).

const FRAME_RATE = 24;
const SESSION_STARTED_AT = '2026-01-01T00:00:00.000Z';
/** End anchor: 00:10:00:00 (600s of timecode) ↔ wall +1200s (600s of dead air). */
const END_ANCHOR_FRAMES = 600 * FRAME_RATE;
const END_ANCHOR_WALL = '2026-01-01T00:20:00.000Z';

const SLATE_CATEGORY = {
  id: 'slate',
  name: 'SLATE',
  type: 'BUTTON',
  color: '#ff0000',
  auto_instruction:
    'Log every slate: each time someone says the word "slate", log it at that moment.',
  dropdown_options: [],
} as const;

/** The two moments (seconds) the word "slate" is actually spoken. */
const SLATE_MOMENTS_SEC = [121.4, 420.7];
/** A hit must land near a real slate moment (line anchors trail the word by
 * up to ~4s at the fixture's cadence; ±30s is generous but still excludes
 * every filler-only region). */
const HIT_WINDOW_SEC = 30;
/** Run-2 dedup tolerance (documented, task 4.4): a second-run event within
 * ±2s of a first-run event is a re-log of the same moment — the line-prefix
 * granularity is ~3.5s, so an honest dedup reproduces the SAME prefix
 * (exact match) and ±2s also catches an adjacent-prefix echo. */
const DEDUP_TOLERANCE_SEC = 2;

function smpte(sec: number): string {
  const total = Math.round(sec * FRAME_RATE);
  const f = total % FRAME_RATE;
  let t = Math.floor(total / FRAME_RATE);
  const s = t % 60;
  t = Math.floor(t / 60);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(Math.floor(t / 60))}:${p2(t % 60)}:${p2(s)}:${p2(f)}`;
}

function tcSeconds(timecode: string | null): number {
  const tc = parseTimecodeString(String(timecode ?? ''), FRAME_RATE);
  if (tc === null) return Number.NaN;
  return toTotalFrames(tc) / FRAME_RATE;
}

/** One spoken line: words at a fixed cadence from `atSec`, each carrying its
 * own session-time anchor (the shape a DeepGram-derived transcript has). */
function speak(atSec: number, speaker: string, text: string) {
  return text.split(/\s+/).map((word, i) => ({
    word,
    speaker,
    session_time: smpte(atSec + i * 0.35),
  }));
}

const TRANSCRIPT = [
  ...speak(
    10,
    'A',
    'Alright everyone quiet on set please we are about ready to roll on scene four take one',
  ),
  ...speak(
    30,
    'B',
    'Sound is up and the mixer looks happy levels are sitting right where we want them',
  ),
  ...speak(
    60,
    'A',
    'Camera is set focus marks are checked and the dolly is parked at its first position',
  ),
  ...speak(120, 'B', 'Roll camera rolling and slate scene four take one marker'),
  ...speak(
    150,
    'A',
    'Action the courier steps through the doorway shakes off the rain and drops the parcel on the counter',
  ),
  ...speak(
    200,
    'B',
    'Cut that felt strong performance wise but the boom dipped into frame near the end',
  ),
  ...speak(
    240,
    'A',
    'Bring the key light down a touch and flag that window the glare is washing out the counter',
  ),
  ...speak(
    300,
    'B',
    'Props can we reset the parcel and mop the floor where the rain jacket dripped',
  ),
  ...speak(
    360,
    'A',
    'Okay resetting back to one we will go again in just a moment stand by please',
  ),
  ...speak(420, 'B', 'Rolling again slate scene four take two marker'),
  ...speak(
    450,
    'A',
    'Action and this time hold the look at the window a beat longer before the exit',
  ),
  ...speak(495, 'B', 'Cut wonderful that is the one check the gate and we move on to close ups'),
];

const TRANSCRIPT_MIN_SEC = 9; // first anchored word at 10s, 1s slack
const TRANSCRIPT_MAX_SEC = 501; // last line starts 495s, ends < 500s, 1s slack

const EVENT_GENERATE_ALLOWED_TOOLS = [
  'get_transcript_words',
  'create_event',
] as const satisfies readonly AiMcpToolName[];

describe.skipIf(!RUN)('REAL claude event generation (opt-in: RUN_REAL_AI_TESTS=1)', () => {
  let dataDir: string;
  let registry: SessionHubRegistry;
  const sessionId = 'real-event-gen';

  /** Mirror the route's run-snapshot assembly (events.ts, task 4.3) with a
   * fresh runId per run — categories, cap, frame math, word snapshot. */
  function buildGeneration(): AiGenerationRunContext {
    return {
      runId: crypto.randomUUID(),
      frameRate: FRAME_RATE,
      startOffsetFrames: 0,
      startedAtUtc: SESSION_STARTED_AT,
      cap: 200, // D8 default
      categories: [SLATE_CATEGORY],
      words: registry
        .get(sessionId)
        .listTranscriptWords()
        .map((w) => ({
          word: String(w.word ?? ''),
          session_time: String(w.session_time ?? ''),
          speaker: String(w.speaker ?? ''),
        })),
    };
  }

  /** Mirror the route's dedup-basis projection: the category's COMPLETE
   * existing events in feed order (`wall_time_utc ASC, id ASC`). */
  function existingSlateEvents(): EventGenerateExistingEvent[] {
    return listFeed()
      .filter((e) => e.category === SLATE_CATEGORY.id)
      .map((e) => ({
        timecode: e.timecode ?? '',
        message: e.message,
        isAuto: parseMeta(e.metadata_json).auto_generated === true,
      }));
  }

  function listFeed() {
    return registry.get(sessionId).listEvents({ limit: 1000, offset: 0 }).events;
  }

  function parseMeta(metadataJson: string): Record<string, unknown> {
    return JSON.parse(metadataJson || '{}') as Record<string, unknown>;
  }

  function generatedByRun(runId: string) {
    return listFeed().filter((e) => parseMeta(e.metadata_json).auto_generate_run_id === runId);
  }

  async function runGenerate(generation: AiGenerationRunContext) {
    return driveAiTurn({
      registry,
      cliPath: cliPath as string,
      sessionId,
      message: buildEventGenerateMessage({
        categories: generation.categories,
        existingEventsByCategoryId: { [SLATE_CATEGORY.id]: existingSlateEvents() },
      }),
      systemPrompt: EVENT_GENERATE_SYSTEM_PROMPT,
      allowedTools: EVENT_GENERATE_ALLOWED_TOOLS,
      mcpContext: { tools: EVENT_GENERATE_ALLOWED_TOOLS, generation },
      maxBudgetUsd: 5, // the topics real test's per-turn scale
      timeoutMs: 300_000,
      emit: () => {},
    });
  }

  // State the second run's assertions compare against, captured by run 1.
  let run1RunId = '';
  let run1Seconds: number[] = [];
  let run1Snapshot: Array<{ id: string; timecode: string | null; message: string }> = [];

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'real-events-'));
    registry = new SessionHubRegistry(join(dataDir, 'sessions'));
    const hub = registry.get(sessionId);
    for (const w of TRANSCRIPT) hub.insertTranscriptWord(w);
    // The two timecode↔wall anchor rows interpolation brackets against —
    // a non-instruction-bearing category, so they never enter the prompt.
    const ctx = { frameRate: FRAME_RATE, startOffsetFrames: 0 };
    hub.addEvent({
      category: 'cam',
      message: 'Recording start anchor',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx,
      explicitAnchor: { timecodeTotalFrames: 0, wallTimeUtc: SESSION_STARTED_AT },
    });
    hub.addEvent({
      category: 'cam',
      message: 'Recording end anchor',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx,
      explicitAnchor: { timecodeTotalFrames: END_ANCHOR_FRAMES, wallTimeUtc: END_ANCHOR_WALL },
    });
  });

  afterAll(async () => {
    await __resetAiMcpListenerForTests(); // driveAiTurn started the singleton
    registry?.closeAll();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    rmSync(stableSessionCwd(sessionId), { recursive: true, force: true });
  });

  it('run 1: creates SLATE events at bracketing-correct transcript timecodes with manual vocabulary + attribution', async () => {
    const generation = buildGeneration();
    run1RunId = generation.runId;
    const outcome = await runGenerate(generation);

    const created = generatedByRun(run1RunId);
    // Operator-facing diagnostics — deliberate in this gated real test.
    console.log(
      `[real event gen run 1] outcome=${JSON.stringify(outcome)} created=${created.length}: ` +
        created.map((e) => `[${e.timecode}] ${e.message}`).join(' | '),
    );

    expect(outcome.ok).toBe(true);
    // The core model-behavior assertion the fake fixtures cannot make: the
    // real model, over the real prompt + rendering, actually detected slates.
    expect(outcome.createdEvents).toBeGreaterThanOrEqual(1);
    expect(created.length).toBe(outcome.createdEvents);
    // cap_hit=false analogue: the route derives cap_hit as created >= cap.
    expect(outcome.createdEvents).toBeLessThan(generation.cap);

    for (const e of created) {
      // Snapshot category + the spec's manual-vocabulary message rule: a
      // BUTTON hit's message is EXACTLY the button's name.
      expect(e.category).toBe(SLATE_CATEGORY.id);
      expect(e.message).toBe('SLATE');
      // Attribution + the manual path's category UI-snapshot keys.
      const meta = parseMeta(e.metadata_json);
      expect(meta.auto_generated).toBe(true);
      expect(meta.auto_generate_run_id).toBe(run1RunId);
      expect(meta.al_category_label_snapshot).toBe(SLATE_CATEGORY.name);
      expect(meta.al_category_color_snapshot).toBe(SLATE_CATEGORY.color);
      // Never an invented timecode: inside the anchored transcript span, and
      // near a moment "slate" is actually spoken (behavior class, not count).
      const sec = tcSeconds(e.timecode);
      expect(sec).toBeGreaterThanOrEqual(TRANSCRIPT_MIN_SEC);
      expect(sec).toBeLessThanOrEqual(TRANSCRIPT_MAX_SEC);
      expect(
        SLATE_MOMENTS_SEC.some((m) => Math.abs(sec - m) <= HIT_WINDOW_SEC),
        `event at ${e.timecode} (${sec}s) is not near any spoken slate moment`,
      ).toBe(true);
    }

    // Bracketing invariant (spec "Events are anchored at transcript
    // timecodes"), asserted in FEED ORDER via listEvents: every generated
    // event sorts between the two anchor rows whose timecodes bracket it,
    // and generated events sort among themselves in timecode order.
    const feed = listFeed();
    const startIdx = feed.findIndex((e) => e.message === 'Recording start anchor');
    const endIdx = feed.findIndex((e) => e.message === 'Recording end anchor');
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
    const generatedIdx = feed.flatMap((e, i) =>
      parseMeta(e.metadata_json).auto_generate_run_id === run1RunId ? [i] : [],
    );
    for (const i of generatedIdx) {
      expect(i).toBeGreaterThan(startIdx);
      expect(i).toBeLessThan(endIdx);
    }
    const secondsInFeedOrder = generatedIdx.map((i) => tcSeconds(feed[i].timecode));
    expect([...secondsInFeedOrder].sort((a, b) => a - b)).toEqual(secondsInFeedOrder);

    run1Seconds = secondsInFeedOrder;
    run1Snapshot = created.map((e) => ({
      id: e.event_id,
      timecode: e.timecode,
      message: e.message,
    }));
  }, 320_000);

  it('run 2: unchanged transcript with embedded prior events — no duplicate within the dedup tolerance', async () => {
    expect(run1Snapshot.length).toBeGreaterThan(0); // run 1 must have produced the dedup basis

    // The dedup basis run 2's message embeds — run 1's rows, marked (auto).
    const basis = existingSlateEvents();
    expect(basis.length).toBe(run1Snapshot.length);
    expect(basis.every((r) => r.isAuto)).toBe(true);

    const generation = buildGeneration();
    const outcome = await runGenerate(generation);
    const created = generatedByRun(generation.runId);
    const distances = created.map((e) =>
      Math.min(...run1Seconds.map((s) => Math.abs(tcSeconds(e.timecode) - s))),
    );
    console.log(
      `[real event gen run 2] outcome=${JSON.stringify(outcome)} created=${created.length}: ` +
        created
          .map((e, i) => `[${e.timecode}] ${e.message} (min dist ${distances[i]}s)`)
          .join(' | '),
    );

    expect(outcome.ok).toBe(true);
    // The model-behavior dedup check: created:0 is SUCCESS (everything was
    // already logged); any created event must be a genuinely new moment —
    // never within ±DEDUP_TOLERANCE_SEC of a run-1 event.
    for (const [i, e] of created.entries()) {
      expect(e.message).toBe('SLATE'); // vocabulary still holds on re-runs
      expect(
        distances[i],
        `run-2 event at ${e.timecode} re-logs a run-1 moment (min distance ${distances[i]}s)`,
      ).toBeGreaterThan(DEDUP_TOLERANCE_SEC);
    }

    // Append-only: run 1's rows are byte-untouched by the second run.
    const after = listFeed();
    for (const prev of run1Snapshot) {
      const row = after.find((e) => e.event_id === prev.id);
      expect(row).toBeDefined();
      expect(row?.timecode).toBe(prev.timecode);
      expect(row?.message).toBe(prev.message);
    }
  }, 320_000);
});
