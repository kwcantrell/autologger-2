// auto-generate-event-logs (task 4.3) — POST /api/sessions/:sessionId/events/
// generate. Locks the guard ORDER and the "spawns nothing on a rejected run"
// property (the ai.int.test.ts pattern — see that file's SPAWN OBSERVATION
// note; the load-bearing no-spawn proof here is `neverSpawned`, backed by the
// fixtures' own on-disk argv recording):
//   session 404-mask → CLAUDE_CLI_PATH 503 →
//   anchored-transcript 400 → no-instructions 400 → aggregate-bound 400 →
//   shared AI slot 409
// plus the configured behaviors: 200 {created, cap_hit} against REAL
// create_event MCP calls (fake-claude-events-success.mjs), the cap path,
// the opaque-502 partial-persist path (fake-claude-events-partial-fail.mjs),
// catalog live-projection freshness on BOTH outcomes, and the no-abortSignal
// / run-snapshot pins on the driveAiTurn call.
//
// Frozen-surface self-check: this suite asserts only statuses/shapes the
// auto-event-generation delta authorizes for this NEW route — 404 (unchanged
// requireSession mask), 503 (unconfigured), 400 ×3
// (anchorless transcript / no instructions / aggregate bound), 409 ×2
// (session-busy / at-capacity, reworded shared details), 200 {created,
// cap_hit}, 502 {detail} opaque — and the reworded 409 detail on the
// pre-existing ai/chat route (authorized by the same delta). No other
// route's status or shape is asserted.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_RUNTIME_FIXTURES_DIR } from '@autologger/ai-runtime';
import { aiChatTurns } from '@autologger/ai-runtime/aiChatRegistry';
import { stableSessionCwd } from '@autologger/ai-runtime/aiChatRunner';
import { __resetAiMcpListenerForTests } from '@autologger/ai-runtime/aiMcpServer';
import * as aiTurnModule from '@autologger/ai-runtime/aiTurn';
import {
  EVENT_GENERATE_SYSTEM_PROMPT,
  INSTRUCTION_OPEN,
} from '@autologger/ai-runtime/eventGeneratePrompt';
import type { Clock } from '@autologger/ports';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../appEnv';
import { app, defaultUser, env, envWith } from '../test/harness';
import {
  catalogFor,
  seedAccessMatrix,
  seededSession as seedSessionChain,
  testDb,
} from '../test/helpers';
import {
  failNextRunLeaseClaim,
  holdAsAnotherProcess,
  observeRunLeases,
  runLeaseRows,
} from '../test/runLeases';
import { sessionGate, systemCall } from '../test/session/sessionGate';
import { harnessHub, testRegistry } from '../test/session/sessionRows';
import { slowStorage } from '../test/session/slowStorage';

const EVENTS_SUCCESS_FIXTURE = fileURLToPath(
  new URL('../test/fixtures/fake-claude-events-success.mjs', import.meta.url),
);
const EVENTS_PARTIAL_FAIL_FIXTURE = fileURLToPath(
  new URL('../test/fixtures/fake-claude-events-partial-fail.mjs', import.meta.url),
);
// event-generate-hardening task 2.3 (gate ruling E1) — a REAL CLI turn that
// exits cleanly (stream-json success) but never makes a genuine create_event
// MCP round trip: the shared generic double (also used by topicGenerate.test
// for the analogous zero-output-keeps-the-prior-set precedent), driven here
// to prove `outcome.createdEvents === 0` at the real registration counter,
// not merely mocked.
const NO_TOOL_CALLS_FIXTURE = join(AI_RUNTIME_FIXTURES_DIR, 'fake-claude.mjs');
// event-generate-hardening residual closure (2026-08-07) — the paused
// double: makes ONE real create_event call, blocks on a file signal, then
// makes the remaining two and exits like EVENTS_SUCCESS_FIXTURE. Lets the
// "mid-run interleaving" tests below issue a REAL HTTP request against the
// app while a generate run is still in flight (see the fixture's own header
// for why a file signal, not an env var).
const EVENTS_PAUSED_FIXTURE = fileURLToPath(
  new URL('../test/fixtures/fake-claude-events-paused.mjs', import.meta.url),
);

const EVENT_GENERATE_FAILURE_DETAIL = 'Event generation failed.';

/** The show the generate fixtures write against: one instruction-LESS button
 * (must NOT enter the run snapshot) and one instruction-bearing BUTTON with
 * the fixed id `slate` the fixtures' create_event calls name. */
const SLATE_INSTRUCTION = 'Log every slate: someone says "slate" or claps the sticks.';
const GEN_CATEGORIES_JSON = JSON.stringify([
  {
    id: 'cam',
    name: 'Camera',
    color: '#112233',
    type: 'BUTTON',
    dropdown_options: [],
    on_label: '',
    off_label: '',
  },
  {
    id: 'slate',
    name: 'SLATE',
    color: '#ff0000',
    type: 'BUTTON',
    dropdown_options: [],
    on_label: '',
    off_label: '',
    auto_instruction: SLATE_INSTRUCTION,
  },
]);

/** A DROPDOWN with a whole-button instruction AND an option instruction —
 * 2 instruction-bearing entries + the standalone bearing button = 3 total,
 * for the entry-count half of the aggregate bound. */
const GEN_DROPDOWN_CATEGORIES_JSON = JSON.stringify([
  {
    id: 'slate',
    name: 'SLATE',
    color: '#ff0000',
    type: 'BUTTON',
    dropdown_options: [],
    on_label: '',
    off_label: '',
    auto_instruction: SLATE_INSTRUCTION,
  },
  {
    id: 'mic',
    name: 'Mic',
    color: '#00ff00',
    type: 'DROPDOWN',
    dropdown_options: [
      { label: 'Lav', needs_context: false, auto_instruction: 'log every lav handoff' },
    ],
    on_label: '',
    off_label: '',
    auto_instruction: 'microphone incidents in general',
  },
]);

/** An option-only DROPDOWN at the legacy aggregate-entry boundary: Generate
 * All counts the bearing category plus both options (3), while a custom
 * one-option snapshot counts only that selected option (1). */
const GEN_OPTION_ONLY_DROPDOWN_CATEGORIES_JSON = JSON.stringify([
  {
    id: 'mic',
    name: 'Mic',
    color: '#00ff00',
    type: 'DROPDOWN',
    dropdown_options: [
      { label: 'Lav', needs_context: false, auto_instruction: 'log every lav handoff' },
      { label: 'Boom', needs_context: false, auto_instruction: 'log every boom adjustment' },
    ],
    on_label: '',
    off_label: '',
  },
]);

const seededIds: string[] = [];

beforeEach(async () => {
  aiChatTurns.reset();
  // The process-wide MCP listener singleton binds the FIRST registry that
  // calls getAiMcpListener(); resetTestEnv gives every test a fresh registry,
  // so the singleton must be reset too (the transcribe.int.test.ts pattern) —
  // otherwise a real create_event call would write into a stale registry.
  await __resetAiMcpListenerForTests();
});

afterEach(async () => {
  aiChatTurns.reset();
  await __resetAiMcpListenerForTests();
  for (const id of seededIds.splice(0)) {
    rmSync(stableSessionCwd(id), { recursive: true, force: true });
  }
});

async function newSession(opts: { categoriesJson?: string } = {}): Promise<{
  studioId: string;
  showId: string;
  sessionId: string;
}> {
  const chain = await seedSessionChain({
    categoriesJson: opts.categoriesJson ?? GEN_CATEGORIES_JSON,
  });
  seededIds.push(chain.sessionId);
  return chain;
}

/** Loopback + configured env: every gate passes up to the seeded state. */
function configuredEnv(
  cliPath: string,
  overrides: Record<string, unknown> = {},
  portOverrides: Partial<Bindings['ports']> = {},
) {
  return envWith(
    {
      CLAUDE_CLI_PATH: cliPath,
      HOST: '127.0.0.1',
      ...overrides,
    },
    portOverrides,
  );
}

function generateReq(sessionId: string, envOverride: ReturnType<typeof envWith>, body?: unknown) {
  return app.request(
    `/api/sessions/${sessionId}/events/generate`,
    {
      method: 'POST',
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    },
    envOverride,
  );
}

/** Anchored transcript: words carrying session-time anchors around the
 * fixtures' create_event timecodes. */
async function seedAnchoredTranscript(sessionId: string): Promise<void> {
  const hub = await harnessHub(sessionId);
  await hub.replaceTranscriptWords([
    { session_time: '00:00:01:00', speaker: 'A', word: 'roll', start_sec: 1, end_sec: 2 },
    { session_time: '00:00:03:00', speaker: 'A', word: 'slate', start_sec: 3, end_sec: 4 },
    { session_time: '00:00:05:00', speaker: 'B', word: 'marker', start_sec: 5, end_sec: 6 },
  ]);
}

/** Words that exist but carry NO session-time anchors. */
async function seedAnchorlessTranscript(sessionId: string): Promise<void> {
  await (await harnessHub(sessionId)).replaceTranscriptWords([
    { session_time: '', speaker: 'A', word: 'unanchored', start_sec: 1, end_sec: 2 },
  ]);
}

/** A pre-existing manual `slate` event at 00:00:01:00 — the dedup basis the
 * prompt must embed, and the run's one timecode↔wall anchor. */
async function seedManualSlateEvent(sessionId: string): Promise<void> {
  await (await harnessHub(sessionId)).addEvent({
    category: 'slate',
    message: 'Pre-existing slate',
    metadataJson: '{}',
    markedAtUtc: null,
    ctx: { frameRate: 24, startOffsetFrames: 0 },
    explicitAnchor: { timecodeTotalFrames: 24, wallTimeUtc: '2026-01-01T00:00:01.000Z' },
  });
}

async function seedAutoSlateEvent(
  sessionId: string,
  message = 'Old generated slate',
): Promise<void> {
  await (await harnessHub(sessionId)).addEvent({
    category: 'slate',
    message,
    metadataJson: '{"auto_generated":true,"auto_generate_run_id":"old-run"}',
    markedAtUtc: null,
    ctx: { frameRate: 24, startOffsetFrames: 0 },
    explicitAnchor: { timecodeTotalFrames: 48, wallTimeUtc: '2026-01-01T00:00:02.000Z' },
  });
}

async function listEvents(sessionId: string) {
  return (await (await harnessHub(sessionId)).listEvents({ limit: 1000, offset: 0 })).events;
}

async function catalogEventCount(sessionId: string): Promise<number> {
  const row = await catalogFor().sessions.getSessionIndexRow(sessionId);
  return Number(row?.event_count ?? -1);
}

/** Real proof no `claude` subprocess ran for `sessionId` (see the header). */
function neverSpawned(sessionId: string): boolean {
  return !existsSync(join(stableSessionCwd(sessionId), '.fixture-argv.json'));
}

function recordedArgv(sessionId: string): string[] {
  return JSON.parse(
    readFileSync(join(stableSessionCwd(sessionId), '.fixture-argv.json'), 'utf8'),
  ) as string[];
}

function recordedStdin(sessionId: string): string {
  return readFileSync(join(stableSessionCwd(sessionId), '.fixture-stdin.txt'), 'utf8');
}

// event-generate-hardening residual closure — EVENTS_PAUSED_FIXTURE's two
// signal files, both inside the stable per-session cwd the test already
// knows without any env plumbing (see the fixture's header).
function pausedMarkerPath(sessionId: string): string {
  return join(stableSessionCwd(sessionId), '.fixture-paused.txt');
}

function resumeSignalPath(sessionId: string): string {
  return join(stableSessionCwd(sessionId), '.fixture-resume.txt');
}

const PAUSE_POLL_INTERVAL_MS = 20;
const PAUSE_POLL_TIMEOUT_MS = 4000;

/** Deterministic wait for the fixture's "I have paused" marker — no bare
 * sleeps. Fails loudly (rather than hanging) if the marker never appears. */
async function waitForFile(path: string, timeoutMs = PAUSE_POLL_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, PAUSE_POLL_INTERVAL_MS));
  }
}

function mockSuccessfulTurn() {
  return vi.spyOn(aiTurnModule, 'driveAiTurn').mockResolvedValueOnce({
    ok: true,
    claudeSessionId: 'body-test',
    createdEvents: 0,
    pageCoverage: { totalPages: 0, servedPages: 0 },
  });
}

async function detailOf(res: Response): Promise<string> {
  return ((await res.json()) as { detail: string }).detail;
}

// ── Guard ladder, in order (each guard exercised with every earlier one
// satisfied; the two order-inversion tests pin the order itself) ────────────

describe('events/generate — guard ladder', () => {
  it('1. unknown session masks as 404 even when everything else would 503 (mask before config)', async () => {
    const res = await generateReq(
      'no-such-session',
      envWith({ CLAUDE_CLI_PATH: '', HOST: '0.0.0.0' }),
    );
    expect(res.status).toBe(404);
    expect(neverSpawned('no-such-session')).toBe(true);
  });

  it('2. CLAUDE_CLI_PATH unset → 503 with an actionable detail, no spawn, no MCP registration', async () => {
    const { sessionId } = await newSession();
    await seedAnchoredTranscript(sessionId);
    const res = await generateReq(sessionId, envWith({ CLAUDE_CLI_PATH: '' }));
    expect(res.status).toBe(503);
    expect(await detailOf(res)).toMatch(/CLAUDE_CLI_PATH/);
    expect(neverSpawned(sessionId)).toBe(true);
  });

  it('4a. empty transcript → 400 BEFORE the no-instructions guard (instruction-less show, still the transcript detail)', async () => {
    // Show WITHOUT instructions AND no transcript: the transcript 400 must
    // win, pinning transcript-before-instructions order.
    const { sessionId } = await newSession({
      categoriesJson: JSON.stringify([
        {
          id: 'cam',
          name: 'Camera',
          color: '#112233',
          type: 'BUTTON',
          dropdown_options: [],
          on_label: '',
          off_label: '',
        },
      ]),
    });
    const res = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE));
    expect(res.status).toBe(400);
    const detail = await detailOf(res);
    expect(detail).toMatch(/transcript/i);
    expect(detail).not.toMatch(/instruction/i);
    expect(neverSpawned(sessionId)).toBe(true);
  });

  it('4b. transcript with no session-time anchors → 400 naming the missing anchors', async () => {
    const { sessionId } = await newSession();
    await seedAnchorlessTranscript(sessionId);
    const res = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE));
    expect(res.status).toBe(400);
    expect(await detailOf(res)).toMatch(/anchor/i);
    expect(neverSpawned(sessionId)).toBe(true);
  });

  it('5. no instruction-bearing button → 400 naming the missing instructions', async () => {
    const { sessionId } = await newSession({
      categoriesJson: JSON.stringify([
        {
          id: 'cam',
          name: 'Camera',
          color: '#112233',
          type: 'BUTTON',
          dropdown_options: [],
          on_label: '',
          off_label: '',
        },
      ]),
    });
    await seedAnchoredTranscript(sessionId);
    const res = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE));
    expect(res.status).toBe(400);
    expect(await detailOf(res)).toMatch(/instruction/i);
    expect(neverSpawned(sessionId)).toBe(true);
  });

  it('6a. aggregate instruction BYTES over the bound → 400 naming the bound, no spawn', async () => {
    const { sessionId } = await newSession();
    await seedAnchoredTranscript(sessionId);
    const res = await generateReq(
      sessionId,
      configuredEnv(EVENTS_SUCCESS_FIXTURE, { EVENT_GENERATE_MAX_INSTRUCTION_BYTES: '4' }),
    );
    expect(res.status).toBe(400);
    const detail = await detailOf(res);
    expect(detail).toMatch(/bound|exceed/i);
    expect(detail).toMatch(/EVENT_GENERATE_MAX_INSTRUCTION_BYTES/);
    expect(neverSpawned(sessionId)).toBe(true);
  });

  it('6b. aggregate instruction ENTRY COUNT over the bound → 400 (bearing categories + bearing options counted)', async () => {
    // 3 entries: slate button + mic button-level + Lav option-level.
    const { sessionId } = await newSession({ categoriesJson: GEN_DROPDOWN_CATEGORIES_JSON });
    await seedAnchoredTranscript(sessionId);
    const over = await generateReq(
      sessionId,
      configuredEnv(EVENTS_SUCCESS_FIXTURE, { EVENT_GENERATE_MAX_INSTRUCTION_ENTRIES: '2' }),
    );
    expect(over.status).toBe(400);
    expect(await detailOf(over)).toMatch(/entries/i);
    expect(neverSpawned(sessionId)).toBe(true);
  });

  it('6→7 order: an aggregate-bound 400 leaves the slot FREE — the next request is not 409-busy', async () => {
    const { sessionId } = await newSession();
    await seedAnchoredTranscript(sessionId);
    const over = await generateReq(
      sessionId,
      configuredEnv(EVENTS_SUCCESS_FIXTURE, { EVENT_GENERATE_MAX_INSTRUCTION_BYTES: '4' }),
    );
    expect(over.status).toBe(400);
    // Order pin with teeth: were tryAcquire moved ABOVE the aggregate-bound
    // check, the ApiError(400) would throw before the try/finally and leak
    // the slot — wedging this session's AI surface behind 409s until restart.
    // Both assertions below turn red under that reorder.
    expect(aiChatTurns.isSessionInFlight(sessionId)).toBe(false);
    const next = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE));
    expect(next.status).toBe(200);
  });

  it('7. shared AI slot held → 409 naming the full holder set incl. event generation, no spawn', async () => {
    const { sessionId } = await newSession();
    await seedAnchoredTranscript(sessionId);
    const slot = aiChatTurns.tryAcquire(sessionId);
    expect(slot.ok).toBe(true);
    try {
      const res = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE));
      expect(res.status).toBe(409);
      const detail = await detailOf(res);
      expect(detail).toMatch(/event generation/);
      expect(detail).toMatch(/AI chat/);
      expect(neverSpawned(sessionId)).toBe(true);
    } finally {
      if (slot.ok) slot.release();
    }
  });

  it('cross-direction: ai/chat blocked while the slot is held names event generation among possible holders', async () => {
    const { sessionId } = await newSession();
    // A generate run in flight is indistinguishable from any other holder at
    // the registry — the CHAT route's reworded shared detail must name event
    // generation so a user who pressed AUTO GENERATE understands the 409.
    const slot = aiChatTurns.tryAcquire(sessionId);
    expect(slot.ok).toBe(true);
    try {
      const res = await app.request(
        `/api/sessions/${sessionId}/ai/chat`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'hi' }),
        },
        configuredEnv(EVENTS_SUCCESS_FIXTURE),
      );
      expect(res.status).toBe(409);
      expect(await detailOf(res)).toMatch(/event generation/);
    } finally {
      if (slot.ok) slot.release();
    }
  });
});

describe('events/generate — optional body, regenerate, and selection', () => {
  it('absent body remains Generate All and returns the legacy success shape', async () => {
    const spy = mockSuccessfulTurn();
    try {
      const { sessionId } = await newSession();
      await seedAnchoredTranscript(sessionId);

      const res = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ created: 0, cap_hit: false });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the legacy category-plus-options bound for Generate All but counts only a custom option', async () => {
    const spy = mockSuccessfulTurn();
    try {
      const { sessionId } = await newSession({
        categoriesJson: GEN_OPTION_ONLY_DROPDOWN_CATEGORIES_JSON,
      });
      await seedAnchoredTranscript(sessionId);
      const boundedEnv = configuredEnv(EVENTS_SUCCESS_FIXTURE, {
        EVENT_GENERATE_MAX_INSTRUCTION_ENTRIES: '2',
      });

      const all = await generateReq(sessionId, boundedEnv);
      expect(all.status).toBe(400);
      expect(await detailOf(all)).toMatch(/3 instruction-bearing entries vs max 2/i);
      expect(spy).not.toHaveBeenCalled();

      const custom = await generateReq(sessionId, boundedEnv, {
        selection: [{ category_id: 'mic', option_label: 'Lav' }],
      });
      expect(custom.status, await custom.clone().text()).toBe(200);
      expect(await custom.json()).toEqual({ created: 0, cap_hit: false });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].mcpContext?.generation?.categories).toEqual([
        {
          id: 'mic',
          name: 'Mic',
          type: 'DROPDOWN',
          color: '#00ff00',
          dropdown_options: [
            { label: 'Lav', needs_context: false, auto_instruction: 'log every lav handoff' },
          ],
        },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('treats an empty selection as Generate All for the legacy category-plus-options bound', async () => {
    const { sessionId } = await newSession({
      categoriesJson: GEN_OPTION_ONLY_DROPDOWN_CATEGORIES_JSON,
    });
    await seedAnchoredTranscript(sessionId);

    const res = await generateReq(
      sessionId,
      configuredEnv(EVENTS_SUCCESS_FIXTURE, {
        EVENT_GENERATE_MAX_INSTRUCTION_ENTRIES: '2',
      }),
      { selection: [] },
    );

    expect(res.status).toBe(400);
    expect(await detailOf(res)).toMatch(/3 instruction-bearing entries vs max 2/i);
    expect(neverSpawned(sessionId)).toBe(true);
  });

  it('{regenerate:false} preserves existing auto rows and omits deleted', async () => {
    const spy = mockSuccessfulTurn();
    try {
      const { sessionId } = await newSession();
      await seedAnchoredTranscript(sessionId);
      await seedAutoSlateEvent(sessionId);

      const res = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE), {
        regenerate: false,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ created: 0, cap_hit: false });
      expect(
        (await listEvents(sessionId)).some((event) => event.message === 'Old generated slate'),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  // event-generate-hardening task 2.3 (gate ruling E1, design D2/D4) —
  // delete-after-success's zero-created arm: a regenerate run whose CLI turn
  // completes cleanly but makes NO real create_event call must NOT delete —
  // destruction requires a replacement. A REAL fixture proves
  // `outcome.createdEvents === 0` at the actual registration counter, not a
  // mocked outcome (mockSuccessfulTurn is reserved above for tests unrelated
  // to the delete decision itself).
  it('regenerate + zero-created success keeps the prior set: 200 {created:0, cap_hit:false, deleted:0}', async () => {
    const { sessionId } = await newSession();
    await seedAnchoredTranscript(sessionId);
    await seedManualSlateEvent(sessionId);
    await seedAutoSlateEvent(sessionId);

    const res = await generateReq(sessionId, configuredEnv(NO_TOOL_CALLS_FIXTURE), {
      regenerate: true,
    });

    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ created: 0, cap_hit: false, deleted: 0 });
    const events = await listEvents(sessionId);
    expect(events.some((event) => event.message === 'Old generated slate')).toBe(true);
    expect(events.some((event) => event.message === 'Pre-existing slate')).toBe(true);
    expect(await catalogEventCount(sessionId)).toBe(2);
  });

  it('mixed selection filters snapshot, prompt, and aggregate bound to the button plus one option', async () => {
    const spy = mockSuccessfulTurn();
    try {
      const { sessionId } = await newSession({ categoriesJson: GEN_DROPDOWN_CATEGORIES_JSON });
      await seedAnchoredTranscript(sessionId);

      const res = await generateReq(
        sessionId,
        configuredEnv(EVENTS_SUCCESS_FIXTURE, {
          // The full snapshot has 3 entries; the mixed selection has 2.
          EVENT_GENERATE_MAX_INSTRUCTION_ENTRIES: '2',
        }),
        {
          selection: [
            { category_id: 'slate', option_label: null },
            { category_id: 'mic', option_label: 'Lav' },
          ],
        },
      );

      expect(res.status, await res.clone().text()).toBe(200);
      expect(await res.json()).toEqual({ created: 0, cap_hit: false });
      const opts = spy.mock.calls[0][0];
      expect(opts.mcpContext?.generation?.categories).toEqual([
        {
          id: 'slate',
          name: 'SLATE',
          type: 'BUTTON',
          color: '#ff0000',
          auto_instruction: SLATE_INSTRUCTION,
          dropdown_options: [],
        },
        {
          id: 'mic',
          name: 'Mic',
          type: 'DROPDOWN',
          color: '#00ff00',
          dropdown_options: [
            { label: 'Lav', needs_context: false, auto_instruction: 'log every lav handoff' },
          ],
        },
      ]);
      expect(opts.message).toContain(SLATE_INSTRUCTION);
      expect(opts.message).toContain('### Option "Lav"');
      expect(opts.message).not.toContain('microphone incidents in general');
    } finally {
      spy.mockRestore();
    }
  });

  it('unmatched selection returns 400 before slot acquisition and deletes nothing', async () => {
    const { sessionId } = await newSession();
    await seedAnchoredTranscript(sessionId);
    await seedAutoSlateEvent(sessionId);
    const slot = aiChatTurns.tryAcquire(sessionId);
    expect(slot.ok).toBe(true);
    try {
      const res = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE), {
        selection: [{ category_id: 'missing', option_label: null }],
      });

      expect(res.status).toBe(400);
      expect(await detailOf(res)).toMatch(/instruction/i);
      expect(neverSpawned(sessionId)).toBe(true);
      expect(aiChatTurns.isSessionInFlight(sessionId)).toBe(true);
      expect(
        (await listEvents(sessionId)).some((event) => event.message === 'Old generated slate'),
      ).toBe(true);
    } finally {
      if (slot.ok) slot.release();
    }
  });

  it('regenerate plus non-empty selection returns 400 before guards and deletes nothing', async () => {
    const { sessionId } = await newSession();
    await seedAutoSlateEvent(sessionId);

    const res = await generateReq(sessionId, envWith({ CLAUDE_CLI_PATH: '' }), {
      regenerate: true,
      selection: [{ category_id: 'slate', option_label: null }],
    });

    expect(res.status).toBe(400);
    expect(
      (await listEvents(sessionId)).some((event) => event.message === 'Old generated slate'),
    ).toBe(true);
    expect(neverSpawned(sessionId)).toBe(true);
  });

  it('malformed JSON returns 400', async () => {
    const { sessionId } = await newSession();
    const res = await app.request(
      `/api/sessions/${sessionId}/events/generate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      },
      configuredEnv(EVENTS_SUCCESS_FIXTURE),
    );

    expect(res.status).toBe(400);
    expect(neverSpawned(sessionId)).toBe(true);
  });

  it('over-bound selection (501 entries) returns 400 before any delete/spawn (D5)', async () => {
    const { sessionId } = await newSession();
    await seedAnchoredTranscript(sessionId);
    await seedAutoSlateEvent(sessionId);
    const selection = Array.from({ length: 501 }, (_, i) => ({ category_id: `c${i}` }));

    const res = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE), { selection });

    expect(res.status).toBe(400);
    expect(neverSpawned(sessionId)).toBe(true);
    expect(
      (await listEvents(sessionId)).some((event) => event.message === 'Old generated slate'),
    ).toBe(true);
  });
});

// ── Configured behavior: success / cap / failure ────────────────────────────

describe('events/generate — configured behavior (real create_event MCP round trips)', () => {
  it(
    'success: 200 {created, cap_hit:false}; events persisted with attribution metadata at the ' +
      'supplied timecodes; catalog projection fresh with NO manual write; slot released; ' +
      'prompt embeds the existing events as the dedup basis',
    async () => {
      const { studioId, showId, sessionId } = await newSession();
      await seedAnchoredTranscript(sessionId);
      await seedManualSlateEvent(sessionId);

      const res = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ created: 3, cap_hit: false });

      // The fixture's three REAL create_event calls landed, at the supplied
      // timecodes (24 fps ⇒ HH:MM:SS:FF), with the attribution pair + the
      // manual path's category UI-snapshot keys from the run snapshot.
      const events = await listEvents(sessionId);
      const generated = events.filter((e) => e.message === 'SLATE');
      expect(generated).toHaveLength(3);
      expect(generated.map((e) => e.timecode).sort()).toEqual([
        '00:00:02:00',
        '00:00:04:00',
        '00:00:06:00',
      ]);
      const runIds = new Set<string>();
      for (const e of generated) {
        expect(e.category).toBe('slate');
        const meta = JSON.parse(e.metadata_json) as Record<string, unknown>;
        expect(meta.auto_generated).toBe(true);
        expect(typeof meta.auto_generate_run_id).toBe('string');
        runIds.add(String(meta.auto_generate_run_id));
      }
      expect(runIds.size).toBe(1); // one run id per run
      // The pre-existing manual row is untouched (append-only).
      const manual = events.find((e) => e.message === 'Pre-existing slate');
      expect(manual).toBeDefined();
      expect(JSON.parse(manual?.metadata_json ?? '{}').auto_generated).toBeUndefined();

      // Sessions-list freshness (spec "Sessions list stays truthful"): each
      // insert committed the catalog projection with it (session-tables D8) —
      // no manual write — so GET /api/sessions serves the updated event_count.
      const cat = catalogFor();
      await cat.auth.authSetPrefs((await defaultUser()).id, studioId, showId);
      const listRes = await app.request('/api/sessions', { method: 'GET' }, { ...env });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { active: Array<Record<string, unknown>> };
      const row = listBody.active.find((s) => s.id === sessionId);
      expect(row).toBeDefined();
      expect(row?.event_count).toBe(4); // 1 manual + 3 generated

      // Slot released — the run holds it only for its own duration.
      expect(aiChatTurns.isSessionInFlight(sessionId)).toBe(false);

      // argv: allowlist is exactly the two generation tools (order-stable
      // wire string), and the dedicated generate system prompt is passed.
      const argv = recordedArgv(sessionId);
      const i = argv.indexOf('--allowedTools');
      expect(i).toBeGreaterThanOrEqual(0);
      expect(argv[i + 1]).toBe(
        'mcp__autologger__get_transcript_words,mcp__autologger__create_event',
      );
      const p = argv.indexOf('--append-system-prompt');
      expect(argv[p + 1]).toBe(EVENT_GENERATE_SYSTEM_PROMPT);

      // The one-shot message (stdin, never argv): delimited untrusted
      // instruction + the category's COMPLETE existing events (dedup basis),
      // rendered with the same server-side timecode path the feed serves.
      const stdin = recordedStdin(sessionId);
      expect(stdin).toContain(INSTRUCTION_OPEN);
      expect(stdin).toContain(SLATE_INSTRUCTION);
      expect(stdin).toContain('[00:00:01:00] Pre-existing slate');
      expect(argv.join(' ')).not.toContain(SLATE_INSTRUCTION);
    },
  );

  // event-generate-hardening task 2.3 (design D2/D3/D4, spec "Successful
  // regenerate replaces the prior set after the run") — a REAL successful
  // regenerate: the pre-run auto-row snapshot is deleted only AFTER success,
  // the manual row and the run's own new rows survive, and the prompt's
  // existing-events enumeration excluded the doomed snapshot row while still
  // embedding the manual row as the dedup basis.
  it(
    'regenerate success: deletes exactly the pre-run snapshot after success, keeps manual + new ' +
      'rows, and excludes the old auto row (but not the manual row) from the prompt',
    async () => {
      const { sessionId } = await newSession();
      await seedAnchoredTranscript(sessionId);
      await seedManualSlateEvent(sessionId);
      await seedAutoSlateEvent(sessionId);

      const res = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE), {
        regenerate: true,
      });

      expect(res.status, await res.clone().text()).toBe(200);
      expect(await res.json()).toEqual({ created: 3, cap_hit: false, deleted: 1 });

      const events = await listEvents(sessionId);
      expect(events.some((e) => e.message === 'Old generated slate')).toBe(false);
      const manual = events.find((e) => e.message === 'Pre-existing slate');
      expect(manual).toBeDefined();
      const generated = events.filter((e) => e.message === 'SLATE');
      expect(generated).toHaveLength(3);
      expect(await catalogEventCount(sessionId)).toBe(4); // 1 manual + 3 generated, old auto gone

      // Prompt exclusion (D3): the doomed old-auto row never reached the
      // model's dedup basis, but the manual row still did.
      const stdin = recordedStdin(sessionId);
      expect(stdin).not.toContain('Old generated slate');
      expect(stdin).toContain('[00:00:01:00] Pre-existing slate');
    },
  );

  // event-generate-hardening task 2.3 (design D2, spec "Failed regenerate run
  // preserves the prior set") — a REAL failed regenerate: the CLI turn makes
  // partial real create_event calls and then fails. The pre-run snapshot is
  // NEVER deleted on a 502 path, and the partial inserts persist alongside it
  // (the existing append-failure semantics, unaffected by delete-after-
  // success).
  it('failed regenerate preserves the prior auto row AND the partial inserts (502, no delete)', async () => {
    const { sessionId } = await newSession();
    await seedAnchoredTranscript(sessionId);
    await seedManualSlateEvent(sessionId);
    await seedAutoSlateEvent(sessionId);

    const res = await generateReq(sessionId, configuredEnv(EVENTS_PARTIAL_FAIL_FIXTURE), {
      regenerate: true,
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ detail: EVENT_GENERATE_FAILURE_DETAIL });

    const events = await listEvents(sessionId);
    expect(events.some((e) => e.message === 'Old generated slate')).toBe(true);
    expect(events.some((e) => e.message === 'Pre-existing slate')).toBe(true);
    const partial = events.filter((e) => e.message === 'SLATE');
    expect(partial).toHaveLength(2); // EVENTS_PARTIAL_FAIL_FIXTURE's EVENT_COUNT
    expect(await catalogEventCount(sessionId)).toBe(4); // 1 manual + 1 old-auto + 2 partial
    expect(aiChatTurns.isSessionInFlight(sessionId)).toBe(false);
  });

  it('cap: EVENT_GENERATE_MAX_CREATED_EVENTS=2 → the third call is refused at the tool; 200 {created:2, cap_hit:true}', async () => {
    const { sessionId } = await newSession();
    await seedAnchoredTranscript(sessionId);

    const res = await generateReq(
      sessionId,
      configuredEnv(EVENTS_SUCCESS_FIXTURE, { EVENT_GENERATE_MAX_CREATED_EVENTS: '2' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 2, cap_hit: true });

    // The cap ended WRITING, not the world: exactly the first two persisted.
    const generated = (await listEvents(sessionId)).filter((e) => e.message === 'SLATE');
    expect(generated.map((e) => e.timecode).sort()).toEqual(['00:00:02:00', '00:00:04:00']);
    expect(aiChatTurns.isSessionInFlight(sessionId)).toBe(false);
  });

  it(
    'failure after real inserts: 502 with the FIXED opaque detail as the ONLY body key (no ' +
      'created-count anywhere), the partial events REMAIN persisted, and the catalog ' +
      'projection is still current on the failure path',
    async () => {
      const { sessionId } = await newSession();
      await seedAnchoredTranscript(sessionId);

      const res = await generateReq(sessionId, configuredEnv(EVENTS_PARTIAL_FAIL_FIXTURE));
      expect(res.status).toBe(502);
      const body = (await res.json()) as Record<string, unknown>;
      // The whole body: one fixed scrubbed detail — no created-count, no raw
      // subprocess output, no outcome token.
      expect(body).toEqual({ detail: EVENT_GENERATE_FAILURE_DETAIL });
      expect(JSON.stringify(body)).not.toMatch(/upstream-failed|claude|created/i);

      // Partial results survive the failed run (spec scenario).
      const generated = (await listEvents(sessionId)).filter((e) => e.message === 'SLATE');
      expect(generated).toHaveLength(2);
      // ...and the catalog projection is current on the failure path too (each
      // insert committed it, session-tables D8).
      expect(await catalogEventCount(sessionId)).toBe(2);
      expect(aiChatTurns.isSessionInFlight(sessionId)).toBe(false);
    },
  );

  it(
    'driveAiTurn receives NO abortSignal (a run always completes server-side), the ' +
      "configured budget/timeout (the 4.1 accessors, not chat's), and the run snapshot: " +
      'instruction-bearing categories only, word snapshot, cap, catalog started_at_utc, ' +
      'and the runId stamped into the persisted rows',
    async () => {
      const spy = vi.spyOn(aiTurnModule, 'driveAiTurn');
      try {
        const { sessionId } = await newSession();
        await seedAnchoredTranscript(sessionId);
        // Distinctive PAST session start, distinct from any run-clock value —
        // the snapshot's startedAtUtc must be the catalog row's
        // started_at_utc, never `new Date()` at run time (design D4: on a
        // zero-anchor session the run clock would misplace every event).
        const startedAtUtc = '2019-03-07T04:05:06.789Z';
        await testDb().run(
          'UPDATE sessions SET started_at_utc = ? WHERE id = ?',
          startedAtUtc,
          sessionId,
        );
        // phase-2 finding 2: a freshly constructed clock at this driveAiTurn
        // call site would leave the whole suite green (see the ai.int.test.ts
        // sibling pin's header for the demonstrated mutation) — only pinning
        // the exact injected object closes the seam. The clock advances real
        // time rather than freezing (phase-2 fix2 re-review, finding B): this
        // same clock also reaches driveAiTurn's `finally`-block kill ladder,
        // and a never-advancing deadline there would make the SIGKILL rung
        // unreachable — the object-identity assertion below is what actually
        // pins the seam, so a frozen constant was a redundant, hazardous
        // second pin.
        const injected: Clock = { now: () => Date.now() };
        const res = await generateReq(
          sessionId,
          // NON-default budget/timeout overrides: the assertions below can
          // only pass through the task-4.1 accessors reading THIS request's
          // config — hardcoded chat-scale (or generate-default) values go red.
          configuredEnv(
            EVENTS_SUCCESS_FIXTURE,
            {
              EVENT_GENERATE_MAX_BUDGET_USD: '3.25',
              EVENT_GENERATE_TIMEOUT_SEC: '77',
            },
            { clock: injected },
          ),
        );
        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledTimes(1);
        const opts = spy.mock.calls[0][0];

        // Budget/timeout wiring pinned to the config accessors (D8 knobs):
        // eventGenerateMaxBudgetUsd and eventGenerateTimeoutSec * 1000.
        expect(opts.maxBudgetUsd).toBe(3.25);
        expect(opts.timeoutMs).toBe(77 * 1000);

        // The REQUEST's own injected clock reached driveAiTurn — the very
        // object, not a copy that happens to agree.
        expect(opts.clock).toBe(injected);

        // NO abortSignal wired — the spec's always-completes property.
        expect(opts.abortSignal).toBeUndefined();
        expect(opts.systemPrompt).toBe(EVENT_GENERATE_SYSTEM_PROMPT);
        expect(opts.allowedTools).toEqual(['get_transcript_words', 'create_event']);
        expect(opts.mcpContext?.tools).toEqual(['get_transcript_words', 'create_event']);

        const generation = opts.mcpContext?.generation;
        expect(generation).toBeDefined();
        // Instruction-bearing categories ONLY — the instruction-less 'cam'
        // button never enters the snapshot (or create_event's allowlist).
        expect(generation?.categories.map((c) => c.id)).toEqual(['slate']);
        expect(generation?.categories[0]?.auto_instruction).toBe(SLATE_INSTRUCTION);
        expect(generation?.cap).toBe(200); // D8 default
        expect(generation?.frameRate).toBe(24);
        // Snapshot start = the catalog row's started_at_utc (fixture-set to a
        // distinctive past value above) — never the run-time clock.
        expect(generation?.startedAtUtc).toBe(startedAtUtc);
        // Run-start word snapshot (Phase-3 carry): the seeded words, frozen.
        expect(generation?.words?.map((w) => w.word)).toEqual(['roll', 'slate', 'marker']);
        // The registration's runId is the one stamped into every created row.
        const generated = (await listEvents(sessionId)).filter((e) => e.message === 'SLATE');
        expect(generated.length).toBeGreaterThan(0);
        for (const e of generated) {
          expect(JSON.parse(e.metadata_json).auto_generate_run_id).toBe(generation?.runId);
        }
      } finally {
        spy.mockRestore();
      }
    },
  );

  it(
    'a projection update that fails fails each insert (session-tables D8): no event is saved, ' +
      'the catalog count is unchanged, and the AI slot is released',
    async () => {
      const { sessionId } = await newSession();
      await seedAnchoredTranscript(sessionId);
      // The route's registry, over storage whose projection statement fails; every other
      // statement runs as in production.
      const failing = testRegistry({
        wrap: (storage) =>
          slowStorage(storage, {
            delayMs: 0,
            hooks: {
              beforeStatement(sql) {
                if (/^\s*UPDATE sessions\b/i.test(sql)) {
                  throw new Error('boom — simulated projection failure');
                }
              },
            },
          }),
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const res = await generateReq(
          sessionId,
          configuredEnv(EVENTS_SUCCESS_FIXTURE, {}, { sessions: failing }),
        );
        // Each failed insert is a failed create_event (an internal-error tool result, not
        // counted in `created`); the run's own outcome is returned.
        expect(res.status).toBe(200);
        expect(((await res.json()) as { created: number }).created).toBe(0);
        expect((await listEvents(sessionId)).filter((e) => e.message === 'SLATE')).toHaveLength(0);
        expect(await catalogEventCount(sessionId)).toBe(0);
        expect(aiChatTurns.isSessionInFlight(sessionId)).toBe(false);
      } finally {
        warn.mockRestore();
        await failing.closeAll();
      }
    },
  );

  it(
    'a regenerate whose post-success delete cannot write the projection answers 500 and keeps ' +
      'every snapshotted row (session-tables auto-event-generation delta)',
    async () => {
      const { sessionId } = await newSession();
      await seedAnchoredTranscript(sessionId);
      await seedManualSlateEvent(sessionId);
      await seedAutoSlateEvent(sessionId);
      // Only the delete's projection fails: the inserts commit theirs as in production.
      let deleting = false;
      const failing = testRegistry({
        wrap: (storage) =>
          slowStorage(storage, {
            delayMs: 0,
            hooks: {
              beforeStatement(sql) {
                if (/^\s*DELETE FROM session_events\b/i.test(sql)) deleting = true;
                if (deleting && /^\s*UPDATE sessions\b/i.test(sql)) {
                  throw new Error('boom — simulated projection failure');
                }
              },
            },
          }),
      });
      try {
        const res = await generateReq(
          sessionId,
          configuredEnv(EVENTS_SUCCESS_FIXTURE, {}, { sessions: failing }),
          { regenerate: true },
        );
        expect(deleting).toBe(true);
        expect(res.status).toBe(500);
        const events = await listEvents(sessionId);
        expect(events.some((e) => e.message === 'Old generated slate')).toBe(true);
        expect(events.some((e) => e.message === 'Pre-existing slate')).toBe(true);
        expect(events.filter((e) => e.message === 'SLATE')).toHaveLength(3);
        expect(await catalogEventCount(sessionId)).toBe(5); // the delete rolled back as a whole
        expect(aiChatTurns.isSessionInFlight(sessionId)).toBe(false);
      } finally {
        await failing.closeAll();
      }
    },
  );
});

// event-generate-hardening residual closure (2026-08-07) — the two
// delete-after-success properties that the archived change's apply-time
// audit could only pin structurally/at the eventStore unit level, because
// the fake-CLI harness had no way to pause a fixture subprocess mid-turn and
// interleave a real HTTP request (events.generate.int.test.ts's original
// header note; eventStore.test.ts's "mid-run manual delete" comment).
// EVENTS_PAUSED_FIXTURE now supplies that pause; these tests exercise it
// end-to-end through the real app.
describe('events/generate — mid-run interleaving (real HTTP requests during a paused CLI turn)', () => {
  it(
    'mid-run GET …/events still returns the prior auto row (has_auto_generated true) while ' +
      'paused; after resume, success deletes exactly that row',
    async () => {
      const { sessionId } = await newSession();
      await seedAnchoredTranscript(sessionId);
      await seedManualSlateEvent(sessionId);
      await seedAutoSlateEvent(sessionId);

      const genPromise = generateReq(sessionId, configuredEnv(EVENTS_PAUSED_FIXTURE), {
        regenerate: true,
      });

      await waitForFile(pausedMarkerPath(sessionId));

      // Mid-run, via a REAL GET through the app (not the hub helper): the
      // pre-run auto row is still present, and has_auto_generated still
      // reflects it — delete-after-success means the snapshot survives until
      // the turn actually succeeds.
      const midRunRes = await app.request(
        `/api/sessions/${sessionId}/events`,
        { method: 'GET' },
        { ...env },
      );
      expect(midRunRes.status).toBe(200);
      const midRunBody = (await midRunRes.json()) as {
        events: Array<Record<string, unknown>>;
        has_auto_generated: boolean;
      };
      expect(midRunBody.has_auto_generated).toBe(true);
      expect(midRunBody.events.some((e) => e.message === 'Old generated slate')).toBe(true);

      writeFileSync(resumeSignalPath(sessionId), 'resume');

      const res = await genPromise;
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await res.json()).toEqual({ created: 3, cap_hit: false, deleted: 1 });

      const events = await listEvents(sessionId);
      expect(events.some((e) => e.message === 'Old generated slate')).toBe(false);
      expect(events.some((e) => e.message === 'Pre-existing slate')).toBe(true);
      expect(events.filter((e) => e.message === 'SLATE')).toHaveLength(3);
    },
  );

  it(
    'mid-run manual DELETE of the only snapshotted id leaves deleted:0 after resume — the run’s ' +
      'own created rows and the manual row persist',
    async () => {
      const { sessionId } = await newSession();
      await seedAnchoredTranscript(sessionId);
      await seedManualSlateEvent(sessionId);
      await seedAutoSlateEvent(sessionId);
      const priorAutoId = (await listEvents(sessionId)).find(
        (e) => e.message === 'Old generated slate',
      )?.event_id;
      expect(priorAutoId).toBeDefined();

      const genPromise = generateReq(sessionId, configuredEnv(EVENTS_PAUSED_FIXTURE), {
        regenerate: true,
      });

      await waitForFile(pausedMarkerPath(sessionId));

      // Mid-run, via a REAL DELETE through the app: an operator removes the
      // ONLY snapshotted id before the post-success bulk delete runs.
      const deleteRes = await app.request(
        `/api/sessions/${sessionId}/events/${priorAutoId}`,
        { method: 'DELETE' },
        { ...env },
      );
      expect(deleteRes.status).toBe(200);

      writeFileSync(resumeSignalPath(sessionId), 'resume');

      const res = await genPromise;
      expect(res.status, await res.clone().text()).toBe(200);
      // deleteEventsByIds receives the pre-spawn snapshot verbatim, but the
      // snapshotted row is already gone — nothing still present to remove —
      // while the run's OWN 3 new rows and the manual row are untouched.
      expect(await res.json()).toEqual({ created: 3, cap_hit: false, deleted: 0 });

      const events = await listEvents(sessionId);
      expect(events.some((e) => e.message === 'Old generated slate')).toBe(false);
      expect(events.some((e) => e.message === 'Pre-existing slate')).toBe(true);
      expect(events.filter((e) => e.message === 'SLATE')).toHaveLength(3);
    },
  );
});

// session-content-policies D7, D8 (owner decision P1; task 5.1): a regenerate whose member loses
// the grant after the turn created the replacements still deletes the snapshot it replaces: the
// delete runs as the reviewed system task `session-undo`, so no doubled set of generated events
// is left behind.
describe('regenerate after a revoke (session-content-policies P1)', () => {
  it('the snapshot delete runs as session-undo after the turn, leaving only the replacements', async () => {
    const m = await seedAccessMatrix({ categoriesJson: GEN_CATEGORIES_JSON });
    seededIds.push(m.sessionId);
    await seedAnchoredTranscript(m.sessionId);
    await seedAutoSlateEvent(m.sessionId);
    const gate = sessionGate();
    try {
      await gate.registry.get(m.sessionId);
      const held = gate.holdNext(systemCall('session-undo'));
      const pending = Promise.resolve(
        app.request(
          `/api/sessions/${m.sessionId}/events/generate`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: m.granted.cookie },
            body: JSON.stringify({ regenerate: true }),
          },
          configuredEnv(EVENTS_SUCCESS_FIXTURE, {}, { sessions: gate.registry }),
        ),
      );
      await held.reached;
      await catalogFor().auth.authRevokeShow(m.granted.id, m.showId);
      held.release();
      const res = await pending;
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as { created: number; deleted: number };
      expect(body.created).toBeGreaterThan(0);
      expect(body.deleted).toBe(1);
      const events = await listEvents(m.sessionId);
      expect(events.some((event) => event.message === 'Old generated slate')).toBe(false);
      expect(events).toHaveLength(body.created);
    } finally {
      await gate.registry.closeAll();
    }
  });
});

// ── session-run-leases D4: the run also holds the session's `ai-turn` run lease ─────────────────
// The await-free window still ends at the synchronous `aiChatTurns.tryAcquire(` (eventsGenerateWindow
// .test.ts, unchanged); the lease is claimed after it.

const EVENT_SESSION_BUSY_DETAIL =
  'A turn (AI chat, AI v2, topic generation, or event generation) is already in progress for this session; ' +
  'wait for it to finish before generating events. These features share one per-session AI slot by design.';

describe('events/generate — the ai-turn run lease (session-run-leases D4)', () => {
  it('another process holding the lease: the session-busy 409, no spawn, the slot free afterwards', async () => {
    const { sessionId } = await newSession();
    await seedAnchoredTranscript(sessionId);
    const other = await holdAsAnotherProcess(sessionId, 'ai-turn');
    const res = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE));
    expect(res.status).toBe(409);
    expect(await detailOf(res)).toBe(EVENT_SESSION_BUSY_DETAIL);
    expect(neverSpawned(sessionId)).toBe(true);
    expect(aiChatTurns.isSessionInFlight(sessionId)).toBe(false);
    expect(await runLeaseRows(sessionId)).toEqual([{ kind: 'ai-turn', holder_client_id: other }]);
  });

  it('the run holds the lease, and it is gone when the response completes after success', async () => {
    const { sessionId } = await newSession();
    await seedAnchoredTranscript(sessionId);
    const obs = observeRunLeases();
    try {
      const res = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE));
      expect(res.status).toBe(200);
      await res.json();
      expect(await runLeaseRows(sessionId)).toEqual([]);
      const [holder] = obs.claims('ai-turn');
      expect(holder).toBeDefined();
      expect(obs.releases('ai-turn')).toEqual([holder]);
      expect(aiChatTurns.isSessionInFlight(sessionId)).toBe(false);
    } finally {
      obs.restore();
    }
  });

  it('the lease is gone when the response completes after an error', async () => {
    const { sessionId } = await newSession();
    await seedAnchoredTranscript(sessionId);
    const obs = observeRunLeases();
    try {
      const res = await generateReq(sessionId, configuredEnv(EVENTS_PARTIAL_FAIL_FIXTURE));
      expect(res.status).toBe(502);
      await res.json();
      expect(await runLeaseRows(sessionId)).toEqual([]);
      expect(obs.claims('ai-turn')).toHaveLength(1);
      expect(obs.releases('ai-turn')).toEqual(obs.claims('ai-turn'));
      expect(aiChatTurns.isSessionInFlight(sessionId)).toBe(false);
    } finally {
      obs.restore();
    }
  });

  it('an immediate second run on the same session is not 409, and holds its own lease', async () => {
    const { sessionId } = await newSession();
    await seedAnchoredTranscript(sessionId);
    const obs = observeRunLeases();
    try {
      const first = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE));
      expect(first.status).toBe(200);
      await first.json();
      const second = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE));
      expect(second.status).toBe(200);
      await second.json();
      expect(new Set(obs.claims('ai-turn')).size).toBe(2);
      expect(await runLeaseRows(sessionId)).toEqual([]);
    } finally {
      obs.restore();
    }
  });

  it('a claim that throws answers 500, spawns nothing and leaves the slot free', async () => {
    const { sessionId } = await newSession();
    await seedAnchoredTranscript(sessionId);
    const fail = failNextRunLeaseClaim();
    try {
      const res = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE));
      expect(res.status).toBe(500);
      expect(fail).toHaveBeenCalledTimes(1);
    } finally {
      fail.mockRestore();
    }
    expect(neverSpawned(sessionId)).toBe(true);
    expect(aiChatTurns.isSessionInFlight(sessionId)).toBe(false);
    const next = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE));
    expect(next.status).toBe(200);
    await next.json();
  });
});
