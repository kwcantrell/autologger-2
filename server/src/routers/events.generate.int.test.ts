// auto-generate-event-logs (task 4.3) — POST /api/sessions/:sessionId/events/
// generate. Locks the guard ORDER and the "spawns nothing on a rejected run"
// property (the ai.int.test.ts pattern — see that file's SPAWN OBSERVATION
// note; the load-bearing no-spawn proof here is `neverSpawned`, backed by the
// fixtures' own on-disk argv recording):
//   session 404-mask → CLAUDE_CLI_PATH 503 → open-network 503 →
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
// requireSession mask), 503 ×2 (unconfigured / open-network), 400 ×3
// (anchorless transcript / no instructions / aggregate bound), 409 ×2
// (session-busy / at-capacity, reworded shared details), 200 {created,
// cap_hit}, 502 {detail} opaque — and the reworded 409 detail on the
// pre-existing ai/chat route (authorized by the same delta). No other
// route's status or shape is asserted.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionIndexStore } from '../db/sessionIndexStore';
import { SETTING_ACTIVE_SHOW, SETTING_ACTIVE_STUDIO } from '../studio';
import { app, env, envWith } from '../test/harness';
import { catalogFor, seededSession as seedSessionChain } from '../test/helpers';
import { aiChatTurns } from './aiChatRegistry';
import { stableSessionCwd } from './aiChatRunner';
import { __resetAiMcpListenerForTests } from './aiMcpServer';
import * as aiTurnModule from './aiTurn';
import { EVENT_GENERATE_SYSTEM_PROMPT, INSTRUCTION_OPEN } from './eventGeneratePrompt';

const EVENTS_SUCCESS_FIXTURE = fileURLToPath(
  new URL('../test/fixtures/fake-claude-events-success.mjs', import.meta.url),
);
const EVENTS_PARTIAL_FAIL_FIXTURE = fileURLToPath(
  new URL('../test/fixtures/fake-claude-events-partial-fail.mjs', import.meta.url),
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

function newSession(opts: { categoriesJson?: string } = {}): {
  studioId: string;
  showId: string;
  sessionId: string;
} {
  const chain = seedSessionChain({ categoriesJson: opts.categoriesJson ?? GEN_CATEGORIES_JSON });
  seededIds.push(chain.sessionId);
  return chain;
}

/** Loopback + configured env: every gate passes up to the seeded state. */
function configuredEnv(cliPath: string, overrides: Record<string, unknown> = {}) {
  return envWith({
    CLAUDE_CLI_PATH: cliPath,
    HOST: '127.0.0.1',
    REQUIRE_LOGIN: '0',
    ...overrides,
  });
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
function seedAnchoredTranscript(sessionId: string): void {
  const hub = env.ports.sessions.get(sessionId);
  hub.replaceTranscriptWords([
    { session_time: '00:00:01:00', speaker: 'A', word: 'roll', start_sec: 1, end_sec: 2 },
    { session_time: '00:00:03:00', speaker: 'A', word: 'slate', start_sec: 3, end_sec: 4 },
    { session_time: '00:00:05:00', speaker: 'B', word: 'marker', start_sec: 5, end_sec: 6 },
  ]);
}

/** Words that exist but carry NO session-time anchors. */
function seedAnchorlessTranscript(sessionId: string): void {
  env.ports.sessions
    .get(sessionId)
    .replaceTranscriptWords([
      { session_time: '', speaker: 'A', word: 'unanchored', start_sec: 1, end_sec: 2 },
    ]);
}

/** A pre-existing manual `slate` event at 00:00:01:00 — the dedup basis the
 * prompt must embed, and the run's one timecode↔wall anchor. */
function seedManualSlateEvent(sessionId: string): void {
  env.ports.sessions.get(sessionId).addEvent({
    category: 'slate',
    message: 'Pre-existing slate',
    metadataJson: '{}',
    markedAtUtc: null,
    ctx: { frameRate: 24, startOffsetFrames: 0 },
    explicitAnchor: { timecodeTotalFrames: 24, wallTimeUtc: '2026-01-01T00:00:01.000Z' },
  });
}

function seedAutoSlateEvent(sessionId: string, message = 'Old generated slate'): void {
  env.ports.sessions.get(sessionId).addEvent({
    category: 'slate',
    message,
    metadataJson: '{"auto_generated":true,"auto_generate_run_id":"old-run"}',
    markedAtUtc: null,
    ctx: { frameRate: 24, startOffsetFrames: 0 },
    explicitAnchor: { timecodeTotalFrames: 48, wallTimeUtc: '2026-01-01T00:00:02.000Z' },
  });
}

function listEvents(sessionId: string) {
  return env.ports.sessions.get(sessionId).listEvents({ limit: 1000, offset: 0 }).events;
}

function catalogEventCount(sessionId: string): number {
  const row = catalogFor().sessions.getSessionIndexRow(sessionId);
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
      envWith({ CLAUDE_CLI_PATH: '', HOST: '0.0.0.0', REQUIRE_LOGIN: '0' }),
    );
    expect(res.status).toBe(404);
    expect(neverSpawned('no-such-session')).toBe(true);
  });

  it('2. CLAUDE_CLI_PATH unset → 503 with an actionable detail, no spawn, no MCP registration', async () => {
    const { sessionId } = newSession();
    seedAnchoredTranscript(sessionId);
    const res = await generateReq(sessionId, envWith({ CLAUDE_CLI_PATH: '' }));
    expect(res.status).toBe(503);
    expect(await detailOf(res)).toMatch(/CLAUDE_CLI_PATH/);
    expect(neverSpawned(sessionId)).toBe(true);
  });

  it('3. open-network refusal → 503 BEFORE the transcript guard (no transcript seeded, still 503)', async () => {
    const { sessionId } = newSession();
    // Deliberately NO transcript: if the anchored-transcript 400 ran first
    // we would see 400 here instead of the open-network 503.
    const res = await generateReq(
      sessionId,
      envWith({
        CLAUDE_CLI_PATH: EVENTS_SUCCESS_FIXTURE,
        REQUIRE_LOGIN: '0',
        HOST: '0.0.0.0',
        IP_ALLOWLIST: '',
      }),
    );
    expect(res.status).toBe(503);
    const detail = await detailOf(res);
    expect(detail).toMatch(/network|allowlist|loopback|login/i);
    expect(detail).not.toMatch(/CLAUDE_CLI_PATH/);
    expect(neverSpawned(sessionId)).toBe(true);
  });

  it('4a. empty transcript → 400 BEFORE the no-instructions guard (instruction-less show, still the transcript detail)', async () => {
    // Show WITHOUT instructions AND no transcript: the transcript 400 must
    // win, pinning transcript-before-instructions order.
    const { sessionId } = newSession({
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
    const { sessionId } = newSession();
    seedAnchorlessTranscript(sessionId);
    const res = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE));
    expect(res.status).toBe(400);
    expect(await detailOf(res)).toMatch(/anchor/i);
    expect(neverSpawned(sessionId)).toBe(true);
  });

  it('5. no instruction-bearing button → 400 naming the missing instructions', async () => {
    const { sessionId } = newSession({
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
    seedAnchoredTranscript(sessionId);
    const res = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE));
    expect(res.status).toBe(400);
    expect(await detailOf(res)).toMatch(/instruction/i);
    expect(neverSpawned(sessionId)).toBe(true);
  });

  it('6a. aggregate instruction BYTES over the bound → 400 naming the bound, no spawn', async () => {
    const { sessionId } = newSession();
    seedAnchoredTranscript(sessionId);
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
    const { sessionId } = newSession({ categoriesJson: GEN_DROPDOWN_CATEGORIES_JSON });
    seedAnchoredTranscript(sessionId);
    const over = await generateReq(
      sessionId,
      configuredEnv(EVENTS_SUCCESS_FIXTURE, { EVENT_GENERATE_MAX_INSTRUCTION_ENTRIES: '2' }),
    );
    expect(over.status).toBe(400);
    expect(await detailOf(over)).toMatch(/entries/i);
    expect(neverSpawned(sessionId)).toBe(true);
  });

  it('6→7 order: an aggregate-bound 400 leaves the slot FREE — the next request is not 409-busy', async () => {
    const { sessionId } = newSession();
    seedAnchoredTranscript(sessionId);
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
    const { sessionId } = newSession();
    seedAnchoredTranscript(sessionId);
    const slot = aiChatTurns.tryAcquire(sessionId, 2);
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

  it('7b. process-wide ceiling reached → 409 with the distinct at-capacity detail naming event generation', async () => {
    const other = newSession().sessionId;
    const { sessionId } = newSession();
    seedAnchoredTranscript(sessionId);
    const slot = aiChatTurns.tryAcquire(other, 1);
    expect(slot.ok).toBe(true);
    try {
      const res = await generateReq(
        sessionId,
        configuredEnv(EVENTS_SUCCESS_FIXTURE, { AI_CHAT_MAX_CONCURRENT: '1' }),
      );
      expect(res.status).toBe(409);
      const detail = await detailOf(res);
      expect(detail).toMatch(/concurrency limit/i);
      expect(detail).toMatch(/event generation/);
      expect(neverSpawned(sessionId)).toBe(true);
    } finally {
      if (slot.ok) slot.release();
    }
  });

  it('cross-direction: ai/chat blocked while the slot is held names event generation among possible holders', async () => {
    const { sessionId } = newSession();
    // A generate run in flight is indistinguishable from any other holder at
    // the registry — the CHAT route's reworded shared detail must name event
    // generation so a user who pressed AUTO GENERATE understands the 409.
    const slot = aiChatTurns.tryAcquire(sessionId, 2);
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
      const { sessionId } = newSession();
      seedAnchoredTranscript(sessionId);

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
      const { sessionId } = newSession({
        categoriesJson: GEN_OPTION_ONLY_DROPDOWN_CATEGORIES_JSON,
      });
      seedAnchoredTranscript(sessionId);
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
    const { sessionId } = newSession({
      categoriesJson: GEN_OPTION_ONLY_DROPDOWN_CATEGORIES_JSON,
    });
    seedAnchoredTranscript(sessionId);

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
      const { sessionId } = newSession();
      seedAnchoredTranscript(sessionId);
      seedAutoSlateEvent(sessionId);

      const res = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE), {
        regenerate: false,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ created: 0, cap_hit: false });
      expect(listEvents(sessionId).some((event) => event.message === 'Old generated slate')).toBe(
        true,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('regenerate deletes only prior auto rows, preserves manual rows, and returns deleted', async () => {
    const spy = mockSuccessfulTurn();
    try {
      const { sessionId } = newSession();
      seedAnchoredTranscript(sessionId);
      seedManualSlateEvent(sessionId);
      seedAutoSlateEvent(sessionId);

      const res = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE), {
        regenerate: true,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ created: 0, cap_hit: false, deleted: 1 });
      const events = listEvents(sessionId);
      expect(events.some((event) => event.message === 'Old generated slate')).toBe(false);
      expect(events.some((event) => event.message === 'Pre-existing slate')).toBe(true);
      expect(catalogEventCount(sessionId)).toBe(1);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('mixed selection filters snapshot, prompt, and aggregate bound to the button plus one option', async () => {
    const spy = mockSuccessfulTurn();
    try {
      const { sessionId } = newSession({ categoriesJson: GEN_DROPDOWN_CATEGORIES_JSON });
      seedAnchoredTranscript(sessionId);

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
    const { sessionId } = newSession();
    seedAnchoredTranscript(sessionId);
    seedAutoSlateEvent(sessionId);
    const slot = aiChatTurns.tryAcquire(sessionId, 2);
    expect(slot.ok).toBe(true);
    try {
      const res = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE), {
        selection: [{ category_id: 'missing', option_label: null }],
      });

      expect(res.status).toBe(400);
      expect(await detailOf(res)).toMatch(/instruction/i);
      expect(neverSpawned(sessionId)).toBe(true);
      expect(aiChatTurns.isSessionInFlight(sessionId)).toBe(true);
      expect(listEvents(sessionId).some((event) => event.message === 'Old generated slate')).toBe(
        true,
      );
    } finally {
      if (slot.ok) slot.release();
    }
  });

  it('regenerate plus non-empty selection returns 400 before guards and deletes nothing', async () => {
    const { sessionId } = newSession();
    seedAutoSlateEvent(sessionId);

    const res = await generateReq(sessionId, envWith({ CLAUDE_CLI_PATH: '' }), {
      regenerate: true,
      selection: [{ category_id: 'slate', option_label: null }],
    });

    expect(res.status).toBe(400);
    expect(listEvents(sessionId).some((event) => event.message === 'Old generated slate')).toBe(
      true,
    );
    expect(neverSpawned(sessionId)).toBe(true);
  });

  it('malformed JSON returns 400', async () => {
    const { sessionId } = newSession();
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
});

// ── Configured behavior: success / cap / failure ────────────────────────────

describe('events/generate — configured behavior (real create_event MCP round trips)', () => {
  it(
    'success: 200 {created, cap_hit:false}; events persisted with attribution metadata at the ' +
      'supplied timecodes; catalog projection fresh with NO manual write; slot released; ' +
      'prompt embeds the existing events as the dedup basis',
    async () => {
      const { studioId, showId, sessionId } = newSession();
      seedAnchoredTranscript(sessionId);
      seedManualSlateEvent(sessionId);

      const res = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ created: 3, cap_hit: false });

      // The fixture's three REAL create_event calls landed, at the supplied
      // timecodes (24 fps ⇒ HH:MM:SS:FF), with the attribution pair + the
      // manual path's category UI-snapshot keys from the run snapshot.
      const events = listEvents(sessionId);
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

      // Sessions-list freshness (spec "Sessions list stays truthful"): the
      // catalog projection was mirrored by the ROUTE — no manual write — so
      // GET /api/sessions serves the updated event_count.
      const cat = catalogFor();
      cat.studios.setSetting(SETTING_ACTIVE_STUDIO, studioId);
      cat.studios.setSetting(SETTING_ACTIVE_SHOW, showId);
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

  it('cap: EVENT_GENERATE_MAX_CREATED_EVENTS=2 → the third call is refused at the tool; 200 {created:2, cap_hit:true}', async () => {
    const { sessionId } = newSession();
    seedAnchoredTranscript(sessionId);

    const res = await generateReq(
      sessionId,
      configuredEnv(EVENTS_SUCCESS_FIXTURE, { EVENT_GENERATE_MAX_CREATED_EVENTS: '2' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 2, cap_hit: true });

    // The cap ended WRITING, not the world: exactly the first two persisted.
    const generated = listEvents(sessionId).filter((e) => e.message === 'SLATE');
    expect(generated.map((e) => e.timecode).sort()).toEqual(['00:00:02:00', '00:00:04:00']);
    expect(aiChatTurns.isSessionInFlight(sessionId)).toBe(false);
  });

  it(
    'failure after real inserts: 502 with the FIXED opaque detail as the ONLY body key (no ' +
      'created-count anywhere), the partial events REMAIN persisted, and the catalog ' +
      'projection is still current on the failure path',
    async () => {
      const { sessionId } = newSession();
      seedAnchoredTranscript(sessionId);

      const res = await generateReq(sessionId, configuredEnv(EVENTS_PARTIAL_FAIL_FIXTURE));
      expect(res.status).toBe(502);
      const body = (await res.json()) as Record<string, unknown>;
      // The whole body: one fixed scrubbed detail — no created-count, no raw
      // subprocess output, no outcome token.
      expect(body).toEqual({ detail: EVENT_GENERATE_FAILURE_DETAIL });
      expect(JSON.stringify(body)).not.toMatch(/upstream-failed|claude|created/i);

      // Partial results survive the failed run (spec scenario).
      const generated = listEvents(sessionId).filter((e) => e.message === 'SLATE');
      expect(generated).toHaveLength(2);
      // ...and the catalog mirror ran on the failure path too.
      expect(catalogEventCount(sessionId)).toBe(2);
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
        const { sessionId } = newSession();
        seedAnchoredTranscript(sessionId);
        // Distinctive PAST session start, distinct from any run-clock value —
        // the snapshot's startedAtUtc must be the catalog row's
        // started_at_utc, never `new Date()` at run time (design D4: on a
        // zero-anchor session the run clock would misplace every event).
        const startedAtUtc = '2019-03-07T04:05:06.789Z';
        env.ports.catalog.run(
          'UPDATE sessions SET started_at_utc = ? WHERE id = ?',
          startedAtUtc,
          sessionId,
        );
        const res = await generateReq(
          sessionId,
          // NON-default budget/timeout overrides: the assertions below can
          // only pass through the task-4.1 accessors reading THIS request's
          // config — hardcoded chat-scale (or generate-default) values go red.
          configuredEnv(EVENTS_SUCCESS_FIXTURE, {
            EVENT_GENERATE_MAX_BUDGET_USD: '3.25',
            EVENT_GENERATE_TIMEOUT_SEC: '77',
          }),
        );
        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledTimes(1);
        const opts = spy.mock.calls[0][0];

        // Budget/timeout wiring pinned to the config accessors (D8 knobs):
        // eventGenerateMaxBudgetUsd and eventGenerateTimeoutSec * 1000.
        expect(opts.maxBudgetUsd).toBe(3.25);
        expect(opts.timeoutMs).toBe(77 * 1000);

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
        const generated = listEvents(sessionId).filter((e) => e.message === 'SLATE');
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
    'finally-block ordering pin: slot release happens BEFORE the post-run catalog ' +
      'projection, so a throw from the projection does not leave the AI slot stuck in flight',
    async () => {
      const { sessionId } = newSession();
      seedAnchoredTranscript(sessionId);
      const spy = vi
        .spyOn(SessionIndexStore.prototype, 'projectSessionLive')
        .mockImplementationOnce(() => {
          throw new Error('boom — simulated projection failure');
        });
      try {
        const res = await generateReq(sessionId, configuredEnv(EVENTS_SUCCESS_FIXTURE));
        // The projection throw surfaces as the app's generic 500 (app.ts
        // onError) — the load-bearing assertion is the slot state below, not
        // this status.
        expect(res.status).toBe(500);
        expect(aiChatTurns.isSessionInFlight(sessionId)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    },
  );
});
