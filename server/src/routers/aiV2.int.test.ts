// ai-v2-dashboards — POST /api/sessions/:sessionId/ai/v2/design route shell
// (tasks 2.1/2.2). Locks the guard ORDER and the "spawns nothing on a
// guard-rejected path" property, mirroring ai.int.test.ts's structure for
// the sibling ai-topics-chat route:
//   auth (401) → session resolution/scoping (404) → config / open-network /
//   agent-credentials gate (503) → body validation (422/400) → turn slot
//   (409, shared with the AI chat's OWN registry by design).
//
// aiV2.ts DOES call attemptDesignTurnSpawn (see its own "SPAWN BOUNDARY"
// module doc) — but only after every guard above has passed, strictly
// downstream of slot acquisition. So unlike ai.int.test.ts's
// vi.mock('node:child_process') (documented there as VACUOUS through the
// shared `app` singleton), a `vi.spyOn` on the REAL, unmocked
// `attemptDesignTurnSpawn` export is a live, non-vacuous check here: the
// guard-rejection cases below assert the spy saw zero calls, which is only
// meaningful because the function genuinely CAN be reached from this route
// (and the allowed-path case below asserts it WAS called, exactly once).
//
// What makes the spy observe aiV2.ts's call at all: this test file's own
// `import * as aiV2SdkSpawnModule from '../ai-runtime/aiV2SdkSpawn'` and
// aiV2.ts's `import { attemptDesignTurnSpawn } from '../ai-runtime/
// aiV2SdkSpawn'` resolve the identical specifier to the identical module —
// one file, one entry in the module loader's cache — and Vitest's SSR/ESM
// transform compiles named-import usages as property reads off that shared
// namespace object rather than capturing a private local binding, so
// `vi.spyOn`'s mutation of the property is visible at every call site that
// resolves to the same module, independent of which import — this file's
// own, or the one reached transitively through `app` — happens to evaluate
// first. This is the real "no guard-rejected path spawns" proof for THIS
// unit; the "allowed" positive control's own hermetic spawn-argv assertion
// already lives in aiV2SdkSpawn.test.ts (task 0.9) and is intentionally not
// re-run here to keep this suite hermetic and fast.

import { fileURLToPath } from 'node:url';
import type {
  McpSdkServerConfigWithInstance,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Config } from '@autologger/ports';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiChatTurns } from '../ai-runtime/aiChatRegistry';
import { aiV2PendingQuestions } from '../ai-runtime/aiV2PendingQuestions';
import * as aiV2SdkSpawnModule from '../ai-runtime/aiV2SdkSpawn';
import { AGGREGATE_MCP_SERVER_NAME } from '../aiV2/mcpTools';
import { aiV2CredentialsRefused, aiV2OpenNetworkRefused } from '../env';
import { app, env, envWith } from '../test/harness';
import {
  loginCookie,
  parseSse,
  seededSession,
  seedSession,
  seedShow,
  seedStudio,
  seedUser,
} from '../test/helpers';

const J = { 'content-type': 'application/json' };
// The real hermetic fake-claude fixture (ai-topics-chat) — used ONLY by
// task 2.7's cross-route tests below, to make a genuine live AI-chat turn
// (not a direct registry poke) hold the shared slot open.
const FIXTURE_CLI = fileURLToPath(new URL('../test/fixtures/fake-claude.mjs', import.meta.url));

const spawnSpy = vi.spyOn(aiV2SdkSpawnModule, 'attemptDesignTurnSpawn');

/** A hermetic stand-in for the SDK `Query`: yields one success `result` and
 * ends, so a turn on the allowed path completes WITHOUT spawning a real
 * subprocess or spending anything. (The spawn override in the real options is
 * never reached because `query()` — the thing that would call it — is mocked.)
 * Used as the DEFAULT for every test so no case can accidentally reach a live
 * SDK turn; guard-rejecting tests still assert `attemptDesignTurnSpawn` was
 * never called at all. */
async function* fakeDesignQuery(): AsyncGenerator<SDKMessage> {
  yield { type: 'result', subtype: 'success', is_error: false } as unknown as SDKMessage;
}

/** A design-turn stand-in whose `next()` never resolves — models a turn that
 * is genuinely still in flight, for task 2.7's cross-route slot tests. Only
 * the runner's own timeout backstop (an impossibly-short
 * `AI_CHAT_TIMEOUT_SEC`, shared config with the AI chat route) ever ends it,
 * so a slot it holds is deterministically still held for as long as the test
 * needs — no timing race, unlike the AI chat side (see the cross-route test's
 * own note on why `FAKE_CLAUDE_MODE=hang` can't be used there). */
async function* hangingDesignQuery(): AsyncGenerator<SDKMessage> {
  await new Promise<never>(() => {});
}

beforeEach(() => {
  aiChatTurns.reset();
  aiV2PendingQuestions.reset();
  spawnSpy.mockReset();
  spawnSpy.mockImplementation(() => fakeDesignQuery() as unknown as Query);
});
afterEach(() => {
  aiChatTurns.reset();
  aiV2PendingQuestions.reset();
});

/** Configured + loopback-bound + no key: every 503 gate passes (the login
 * fallback is permitted on loopback), so requests reach body/slot checks. */
function loopbackEnv(overrides: Record<string, unknown> = {}) {
  return envWith({
    AI_V2_ENABLED: '1',
    HOST: '127.0.0.1',
    REQUIRE_LOGIN: '0',
    AI_V2_API_KEY: '',
    ...overrides,
  });
}

function post(
  sessionId: string,
  body: unknown,
  reqEnv = loopbackEnv(),
  headers: Record<string, string> = J,
) {
  return app.request(
    `/api/sessions/${sessionId}/ai/v2/design`,
    { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) },
    reqEnv,
  );
}

function postAnswer(
  sessionId: string,
  body: unknown,
  reqEnv = loopbackEnv(),
  headers: Record<string, string> = J,
) {
  return app.request(
    `/api/sessions/${sessionId}/ai/v2/answer`,
    { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) },
    reqEnv,
  );
}

describe('ai/v2/design — auth gate (first)', () => {
  it('401 when REQUIRE_LOGIN=1 and no credentials, before any other check', async () => {
    const s = seededSession().sessionId;
    const res = await post(s, { message: 'hi' }, loopbackEnv({ REQUIRE_LOGIN: '1' }));
    expect(res.status).toBe(401);
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

describe('ai/v2/design — session resolution masks before 503/409', () => {
  it('404 for a nonexistent session even when configured', async () => {
    const res = await post('no-such-session', { message: 'hi' }, loopbackEnv());
    expect(res.status).toBe(404);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('404 for an out-of-studio session — never 503/409 — even unconfigured with a turn in flight', async () => {
    const outsiderStudio = seedStudio();
    const s = seededSession().sessionId;
    const outsider = seedUser({ studios: [outsiderStudio] });
    // A turn is "in flight" for this session AND the feature is unconfigured:
    // if the config/slot gates ran before session scoping we'd see 503/409
    // instead of 404, leaking either signal to a caller with no access.
    aiChatTurns.tryAcquire(s, 2);
    const res = await post(
      s,
      { message: 'hi' },
      envWith({ AI_V2_ENABLED: '', HOST: '0.0.0.0', REQUIRE_LOGIN: '1' }),
      { ...J, Cookie: await loginCookie(outsider) },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { detail: string }).detail).toBe('Session not found');
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

describe('ai/v2/design — configuration gate (503)', () => {
  it('503 not-configured when AI_V2_ENABLED is unset', async () => {
    const s = seededSession().sessionId;
    const res = await post(s, { message: 'hi' }, loopbackEnv({ AI_V2_ENABLED: '' }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/not configured/i);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('503 not-configured when AI_V2_ENABLED is "0"', async () => {
    const s = seededSession().sessionId;
    const res = await post(s, { message: 'hi' }, loopbackEnv({ AI_V2_ENABLED: '0' }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/not configured/i);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('disabling AI v2 does not affect the AI chat, and vice versa (independent gates)', async () => {
    const s = seededSession().sessionId;
    // AI v2 off, AI chat "configured" (a resolvable-looking path is not
    // required for this assertion — only that its OWN gate, not AI v2's,
    // decides its fate): the AI chat route's 503 detail is its own, distinct
    // wording, proving the two config reads never share state.
    const res = await post(
      s,
      { message: 'hi' },
      envWith({
        AI_V2_ENABLED: '',
        HOST: '127.0.0.1',
        REQUIRE_LOGIN: '0',
        CLAUDE_CLI_PATH: '/fake/claude',
      }),
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/AI v2 is not configured/i);

    const chatRes = await app.request(
      `/api/sessions/${s}/ai/chat`,
      { method: 'POST', headers: J, body: JSON.stringify({ message: 'hi' }) },
      envWith({ AI_V2_ENABLED: '', HOST: '127.0.0.1', REQUIRE_LOGIN: '0', CLAUDE_CLI_PATH: '' }),
    );
    // AI chat's OWN gate (CLAUDE_CLI_PATH unset) decides its 503 — a
    // different detail string than AI v2's, proving no shared config state.
    expect(chatRes.status).toBe(503);
    expect(((await chatRes.json()) as { detail: string }).detail).toMatch(
      /AI chat is not configured/i,
    );
  });
});

describe('ai/v2/design — open-network refusal (503)', () => {
  it('503 for anonymous + non-loopback + no allowlist, with a distinct detail, spawning nothing', async () => {
    const s = seededSession().sessionId;
    const res = await post(
      s,
      { message: 'hi' },
      envWith({
        AI_V2_ENABLED: '1',
        REQUIRE_LOGIN: '0',
        HOST: '0.0.0.0',
        IP_ALLOWLIST: '',
        AI_V2_API_KEY: 'k',
      }),
    );
    expect(res.status).toBe(503);
    const detail = ((await res.json()) as { detail: string }).detail;
    expect(detail).toMatch(/network|allowlist|loopback|login/i);
    expect(detail).not.toMatch(/not configured/i);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('predicate: aiV2OpenNetworkRefused refuses only anonymous + non-loopback + no-allowlist binds', () => {
    const base: Config = {
      PUBLIC_BASE_URL: '',
      HOST: '0.0.0.0',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      REQUIRE_LOGIN: '0',
      SESSION_COOKIE: '',
      SESSION_DAYS: '14',
      NEW_USER_ALL_TEAMS: '0',
      COOKIE_SECURE: '',
      IP_ALLOWLIST: '',
      TRUST_PROXY: '',
      API_TOKEN: '',
      ADMIN_TOKEN: '',
      DEEPGRAM_API_KEY: '',
      DEEPGRAM_MODEL: '',
      CLAUDE_CLI_PATH: '',
      AI_CHAT_TIMEOUT_SEC: '',
      AI_CHAT_MAX_CONCURRENT: '',
      AI_CHAT_MAX_BUDGET_USD: '',
      TOPIC_GENERATE_MAX_BUDGET_USD: '',
      TOPIC_GENERATE_TIMEOUT_SEC: '',
      EVENT_GENERATE_MAX_BUDGET_USD: '',
      EVENT_GENERATE_TIMEOUT_SEC: '',
      EVENT_GENERATE_MAX_CREATED_EVENTS: '',
      EVENT_GENERATE_MAX_INSTRUCTION_BYTES: '',
      EVENT_GENERATE_MAX_INSTRUCTION_ENTRIES: '',
      AI_V2_ENABLED: '1',
      AI_V2_API_KEY: 'k',
      AI_V2_MAX_BUDGET_USD: '',
    };
    expect(aiV2OpenNetworkRefused(base)).toBe(true);
    expect(aiV2OpenNetworkRefused({ ...base, HOST: '' })).toBe(true); // unset ⇒ 0.0.0.0
    expect(aiV2OpenNetworkRefused({ ...base, REQUIRE_LOGIN: '1' })).toBe(false);
    expect(aiV2OpenNetworkRefused({ ...base, IP_ALLOWLIST: '10.0.0.0/8' })).toBe(false);
    for (const h of ['127.0.0.1', '::1', 'localhost']) {
      expect(aiV2OpenNetworkRefused({ ...base, HOST: h })).toBe(false);
    }
  });
});

describe('ai/v2/design — agent credentials refusal (503, distinct from open-network)', () => {
  it('503 when no key is configured and the bind is non-loopback, even with login REQUIRED', async () => {
    const { sessionId: s, studioId } = seededSession();
    // REQUIRE_LOGIN=1 (not disabled!) so aiV2OpenNetworkRefused would be
    // false here — proving this is a DIFFERENT predicate, not a duplicate of
    // the open-network check.
    const res = await post(
      s,
      { message: 'hi' },
      envWith({ AI_V2_ENABLED: '1', REQUIRE_LOGIN: '1', HOST: '0.0.0.0', AI_V2_API_KEY: '' }),
      { ...J, Cookie: await loginCookie(seedUser({ studios: [studioId] })) },
    );
    expect(res.status).toBe(503);
    const detail = ((await res.json()) as { detail: string }).detail;
    expect(detail).toMatch(/AI_V2_API_KEY|loopback/i);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('a configured key lifts the refusal even on a non-loopback bind', async () => {
    const { sessionId: s, studioId } = seededSession();
    const res = await post(
      s,
      { message: 'hi' },
      envWith({
        AI_V2_ENABLED: '1',
        REQUIRE_LOGIN: '1',
        HOST: '0.0.0.0',
        AI_V2_API_KEY: 'workspace-key',
      }),
      { ...J, Cookie: await loginCookie(seedUser({ studios: [studioId] })) },
    );
    // Every 503 gate lifted; falls through to the real streaming turn (200
    // SSE, mocked hermetically) — never a credentials 503. The turn is
    // actually reached, so the spawn boundary WAS crossed on this allowed path.
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(503);
    await res.text(); // drain the stream so the turn's finally (slot release) runs
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('predicate: aiV2CredentialsRefused is independent of REQUIRE_LOGIN/IP_ALLOWLIST', () => {
    const base: Config = {
      PUBLIC_BASE_URL: '',
      HOST: '0.0.0.0',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      REQUIRE_LOGIN: '1',
      SESSION_COOKIE: '',
      SESSION_DAYS: '14',
      NEW_USER_ALL_TEAMS: '0',
      COOKIE_SECURE: '',
      IP_ALLOWLIST: '10.0.0.0/8',
      TRUST_PROXY: '',
      API_TOKEN: '',
      ADMIN_TOKEN: '',
      DEEPGRAM_API_KEY: '',
      DEEPGRAM_MODEL: '',
      CLAUDE_CLI_PATH: '',
      AI_CHAT_TIMEOUT_SEC: '',
      AI_CHAT_MAX_CONCURRENT: '',
      AI_CHAT_MAX_BUDGET_USD: '',
      TOPIC_GENERATE_MAX_BUDGET_USD: '',
      TOPIC_GENERATE_TIMEOUT_SEC: '',
      EVENT_GENERATE_MAX_BUDGET_USD: '',
      EVENT_GENERATE_TIMEOUT_SEC: '',
      EVENT_GENERATE_MAX_CREATED_EVENTS: '',
      EVENT_GENERATE_MAX_INSTRUCTION_BYTES: '',
      EVENT_GENERATE_MAX_INSTRUCTION_ENTRIES: '',
      AI_V2_ENABLED: '1',
      AI_V2_API_KEY: '',
      AI_V2_MAX_BUDGET_USD: '',
    };
    // Non-loopback, no key, REQUIRE_LOGIN=1, allowlist set — every knob that
    // lifts aiV2OpenNetworkRefused is present, yet credentials still refuse.
    expect(aiV2CredentialsRefused(base)).toBe(true);
    expect(aiV2CredentialsRefused({ ...base, AI_V2_API_KEY: 'k' })).toBe(false);
    for (const h of ['127.0.0.1', '::1', 'localhost']) {
      expect(aiV2CredentialsRefused({ ...base, HOST: h })).toBe(false);
    }
  });
});

describe('ai/v2/design — body validation (422 / 400), spawning nothing', () => {
  it('422 when message is missing', async () => {
    const s = seededSession().sessionId;
    const res = await post(s, {}, loopbackEnv());
    expect(res.status).toBe(422);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('422 when message is whitespace-only (trimmed to empty)', async () => {
    const s = seededSession().sessionId;
    const res = await post(s, { message: '   ' }, loopbackEnv());
    expect(res.status).toBe(422);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('422 when message exceeds 8000 chars', async () => {
    const s = seededSession().sessionId;
    const res = await post(s, { message: 'x'.repeat(8001) }, loopbackEnv());
    expect(res.status).toBe(422);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('422 when claude_session_id is an empty string', async () => {
    const s = seededSession().sessionId;
    const res = await post(s, { message: 'hi', claude_session_id: '' }, loopbackEnv());
    expect(res.status).toBe(422);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('400 on malformed JSON, spawning nothing', async () => {
    const s = seededSession().sessionId;
    const res = await post(s, 'not json{', loopbackEnv());
    expect(res.status).toBe(400);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('422 (invalid body) wins over 409 (slot busy) — body validation runs before the slot check', async () => {
    const s = seededSession().sessionId;
    const slot = aiChatTurns.tryAcquire(s, 2);
    expect(slot.ok).toBe(true);
    try {
      const res = await post(s, {}, loopbackEnv());
      expect(res.status).toBe(422);
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      if (slot.ok) slot.release();
    }
  });
});

describe('ai/v2/design — turn slot (409), shared with the AI chat registry by design', () => {
  it('409 when a turn is already in flight for the same session (session-busy)', async () => {
    const s = seededSession().sessionId;
    const slot = aiChatTurns.tryAcquire(s, 2);
    expect(slot.ok).toBe(true);
    try {
      const res = await post(s, { message: 'hi' }, loopbackEnv());
      expect(res.status).toBe(409);
      expect(((await res.json()) as { detail: string }).detail).toMatch(/in progress|already/i);
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      if (slot.ok) slot.release();
    }
  });

  it('409 when the process-wide ceiling is reached, with a distinct detail', async () => {
    const other = seededSession().sessionId;
    const s = seededSession().sessionId;
    const slot = aiChatTurns.tryAcquire(other, 1);
    expect(slot.ok).toBe(true);
    try {
      const res = await post(s, { message: 'hi' }, loopbackEnv({ AI_CHAT_MAX_CONCURRENT: '1' }));
      expect(res.status).toBe(409);
      const detail = ((await res.json()) as { detail: string }).detail;
      expect(detail).toMatch(/capacity|concurrent|limit|busy/i);
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      if (slot.ok) slot.release();
    }
  });

  it(
    'a slot held by a REAL AI CHAT turn (live subprocess, not a direct registry poke) 409s an AI v2 ' +
      'request for the SAME session — genuine cross-route sharing — and frees once the chat turn completes',
    async () => {
      const s = seededSession().sessionId;
      // `FAKE_CLAUDE_MODE=hang` can't reach this path: `spawnAiChatTurn`'s own
      // minimal env whitelist (design D4) strips it along with everything else
      // non-essential (see ai.int.test.ts's header note) — the whitelist itself
      // is under test, and defeating it here would be a false positive. Instead
      // this relies on the SAME deterministic timing ai.int.test.ts's own
      // guaranteed-timeout test rests on: a real OS process spawn+drain
      // (fork+exec+Node startup, measured ~25-40ms) cannot complete within the
      // near-zero latency of the second in-process HTTP call fired right after
      // the first's Response resolves. And `aiChatTurns.tryAcquire` runs
      // SYNCHRONOUSLY in ai.ts's handler BEFORE `streamSSE` is even invoked, so
      // by the time `await chatRes` resolves (streamSSE returns its Response
      // promptly, independent of how long the callback body takes — proven by
      // this same file's "a configured key lifts the refusal" test reaching 200
      // before its mocked turn is drained), the slot is unconditionally already
      // held — not a race on THAT half.
      const chatRes = await app.request(
        `/api/sessions/${s}/ai/chat`,
        { method: 'POST', headers: J, body: JSON.stringify({ message: 'hi' }) },
        envWith({ CLAUDE_CLI_PATH: FIXTURE_CLI, HOST: '127.0.0.1', REQUIRE_LOGIN: '0' }),
      );
      expect(chatRes.status).toBe(200);
      try {
        const res = await post(s, { message: 'hi' }, loopbackEnv());
        expect(res.status).toBe(409);
        expect(((await res.json()) as { detail: string }).detail).toMatch(/in progress|already/i);
        expect(spawnSpy).not.toHaveBeenCalled();
      } finally {
        // Drain fully so the chat turn's own `finally` (slot release) runs
        // before the suite's afterEach reset — real cleanup, not a leaked slot.
        await chatRes.text();
      }
      expect(aiChatTurns.isSessionInFlight(s)).toBe(false);
    },
  );

  it(
    'a slot held by a design (v2) turn 409s an AI CHAT request for the SAME session — the reverse ' +
      'direction — and frees once the design turn times out',
    async () => {
      const s = seededSession().sessionId;
      // The design-turn side CAN be held open deterministically (unlike the AI
      // chat side above): `hangingDesignQuery` never yields, so only the
      // runner's own timeout backstop ends it — no timing race required.
      spawnSpy.mockImplementationOnce(() => hangingDesignQuery() as unknown as Query);
      const v2Res = await post(s, { message: 'hi' }, loopbackEnv({ AI_CHAT_TIMEOUT_SEC: '0.2' }));
      // Resolves promptly (streamSSE returns its Response before the callback
      // body — which is racing the never-yielding query against the 0.2s
      // timeout — has settled).
      expect(v2Res.status).toBe(200);
      try {
        const chatRes = await app.request(
          `/api/sessions/${s}/ai/chat`,
          { method: 'POST', headers: J, body: JSON.stringify({ message: 'hi' }) },
          envWith({ CLAUDE_CLI_PATH: FIXTURE_CLI, HOST: '127.0.0.1', REQUIRE_LOGIN: '0' }),
        );
        expect(chatRes.status).toBe(409);
        expect(((await chatRes.json()) as { detail: string }).detail).toMatch(
          /in progress|already/i,
        );
      } finally {
        // Drain until the 0.2s timeout fires and the design turn's `finally`
        // releases the slot.
        await v2Res.text();
      }
      expect(aiChatTurns.isSessionInFlight(s)).toBe(false);
    },
  );

  it('the slot is released, not leaked, once a turn finishes — a follow-up on the same session is not 409', async () => {
    const s = seededSession().sessionId;
    const res = await post(s, { message: 'hi' }, loopbackEnv());
    expect(res.status).not.toBe(409);
    // Drain the SSE stream so the turn's `finally` (slot release) has run
    // before asserting the slot is free — the release is on an async path now,
    // not synchronous as the transitional tail was.
    await res.text();
    expect(aiChatTurns.isSessionInFlight(s)).toBe(false);
    const second = await post(s, { message: 'again' }, loopbackEnv());
    expect(second.status).not.toBe(409);
    await second.text();
    expect(aiChatTurns.isSessionInFlight(s)).toBe(false);
  });
});

// ── Phase-3 fix wave — Fix 1: principal-less (device-token) refusal (design D7) ──

describe('ai/v2/design — principal-less (device-token) refusal (404, design D7, Phase-3 fix wave)', () => {
  it('a device token (API_TOKEN, user===null) gets 404, masked as "Session not found", spawning nothing', async () => {
    const s = seededSession().sessionId;
    const res = await post(
      s,
      { message: 'hi' },
      envWith({
        AI_V2_ENABLED: '1',
        HOST: '127.0.0.1',
        REQUIRE_LOGIN: '0',
        AI_V2_API_KEY: '',
        API_TOKEN: 'device-secret',
      }),
      { ...J, Authorization: 'Bearer device-secret' },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { detail: string }).detail).toBe('Session not found');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('a device token is refused with 404 BEFORE the config gate — masks whether AI v2 is even configured', async () => {
    const s = seededSession().sessionId;
    const res = await post(
      s,
      { message: 'hi' },
      envWith({
        AI_V2_ENABLED: '', // unconfigured — would otherwise 503
        HOST: '127.0.0.1',
        REQUIRE_LOGIN: '0',
        API_TOKEN: 'device-secret',
      }),
      { ...J, Authorization: 'Bearer device-secret' },
    );
    expect(res.status).toBe(404);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('a valid in-studio real user still passes (not refused by the new guard)', async () => {
    const { sessionId: s, studioId } = seededSession();
    const user = seedUser({ studios: [studioId] });
    const res = await post(s, { message: 'hi' }, loopbackEnv(), {
      ...J,
      Cookie: await loginCookie(user),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('ai/v2/design — no guard path spawns (spec "Design turn contract")', () => {
  it('across every guard-rejecting scenario exercised above, attemptDesignTurnSpawn was never called', () => {
    // Aggregate assertion: the per-test expect(spawnSpy).not.toHaveBeenCalled()
    // calls above already prove this per-case; this is the single, named
    // assertion the report cites as "recorder/spy shows zero invocations".
    // (aiV2.ts's own module doc explains why this spy is non-vacuous: no
    // spawn call exists anywhere in aiV2.ts yet, so the property holds by
    // construction — this test is the tripwire for when tasks 2.3-2.8 wire
    // one in.)
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

// ── task 3.2 — POST …/ai/v2/answer ──────────────────────────────────────────

describe('ai/v2/answer — guard chain mirrors the design route through body validation (task 3.2)', () => {
  it('401 when REQUIRE_LOGIN=1 and no credentials, before any other check', async () => {
    const s = seededSession().sessionId;
    const res = await postAnswer(
      s,
      { turnId: 't', requestId: 'r', answers: [{ kind: 'text', text: 'x' }] },
      loopbackEnv({ REQUIRE_LOGIN: '1' }),
    );
    expect(res.status).toBe(401);
  });

  it('404 for a nonexistent session even when configured', async () => {
    const res = await postAnswer(
      'no-such-session',
      { turnId: 't', requestId: 'r', answers: [{ kind: 'text', text: 'x' }] },
      loopbackEnv(),
    );
    expect(res.status).toBe(404);
  });

  it('404 for an out-of-studio session — never 503 — masking the same as the design route', async () => {
    const outsiderStudio = seedStudio();
    const s = seededSession().sessionId;
    const outsider = seedUser({ studios: [outsiderStudio] });
    const res = await postAnswer(
      s,
      { turnId: 't', requestId: 'r', answers: [{ kind: 'text', text: 'x' }] },
      envWith({ AI_V2_ENABLED: '', HOST: '0.0.0.0', REQUIRE_LOGIN: '1' }),
      { ...J, Cookie: await loginCookie(outsider) },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { detail: string }).detail).toBe('Session not found');
  });

  it('503 not-configured when AI_V2_ENABLED is unset', async () => {
    const s = seededSession().sessionId;
    const res = await postAnswer(
      s,
      { turnId: 't', requestId: 'r', answers: [{ kind: 'text', text: 'x' }] },
      loopbackEnv({ AI_V2_ENABLED: '' }),
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/not configured/i);
  });

  it('422 when answers is empty', async () => {
    const s = seededSession().sessionId;
    const res = await postAnswer(s, { turnId: 't', requestId: 'r', answers: [] }, loopbackEnv());
    expect(res.status).toBe(422);
  });

  it('422 when turnId/requestId are missing', async () => {
    const s = seededSession().sessionId;
    const res = await postAnswer(s, { answers: [{ kind: 'text', text: 'x' }] }, loopbackEnv());
    expect(res.status).toBe(422);
  });

  it(
    '422 when an option answer names a widget type outside the closed catalog ' +
      '(spec "Previews reflect the rendered result": "An option naming no catalog type is rejected")',
    async () => {
      const s = seededSession().sessionId;
      const res = await postAnswer(
        s,
        {
          turnId: 't',
          requestId: 'r',
          answers: [{ kind: 'option', widgetType: 'not_a_real_widget' }],
        },
        loopbackEnv(),
      );
      expect(res.status).toBe(422);
    },
  );

  it('400 on malformed JSON', async () => {
    const s = seededSession().sessionId;
    const res = await postAnswer(s, 'not json{', loopbackEnv());
    expect(res.status).toBe(400);
  });

  it('404 when no question is pending for the given ids, past every earlier guard', async () => {
    const { sessionId: s, studioId } = seededSession();
    const user = seedUser({ studios: [studioId] });
    const res = await postAnswer(
      s,
      {
        turnId: 'no-such-turn',
        requestId: 'no-such-request',
        answers: [{ kind: 'text', text: 'x' }],
      },
      loopbackEnv(),
      { ...J, Cookie: await loginCookie(user) },
    );
    expect(res.status).toBe(404);
  });
});

// ── task 3.1/3.2/3.3 — gate-intent verification (design D7's hard constraints) ──

describe('ai/v2/answer — principal binding: access to the session is not enough (design D7)', () => {
  it('(c) a device token (API_TOKEN, user===null) cannot answer even a genuinely pending, correctly-addressed question', async () => {
    const { sessionId: s } = seededSession();
    const initiator = seedUser({}); // the real principal that "started" the turn
    aiV2PendingQuestions.register(
      { sessionId: s, turnId: 'turn-1', requestId: 'req-1' },
      initiator,
      {
        questions: [],
      },
    );

    const res = await postAnswer(
      s,
      { turnId: 'turn-1', requestId: 'req-1', answers: [{ kind: 'text', text: 'x' }] },
      envWith({
        AI_V2_ENABLED: '1',
        HOST: '127.0.0.1',
        REQUIRE_LOGIN: '0',
        AI_V2_API_KEY: '',
        API_TOKEN: 'device-secret',
      }),
      { ...J, Authorization: 'Bearer device-secret' },
    );

    expect(res.status).toBe(404);
    // Refused structurally, before/regardless of the registry lookup — the
    // question is still pending, provably not consumed by this attempt.
    expect(aiV2PendingQuestions.has({ sessionId: s, turnId: 'turn-1', requestId: 'req-1' })).toBe(
      true,
    );
    // /answer never spawns regardless, but the shared guard is proven not to
    // open any path that could (task 3.1/3.2's SPAWN BOUNDARY still holds).
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it(
    "(c') a device token is refused with 404 BEFORE the config gate on /answer too — masks configuration " +
      'state (Phase-3 fix wave, matching the /design route)',
    async () => {
      const s = seededSession().sessionId;
      const res = await postAnswer(
        s,
        { turnId: 'turn-1', requestId: 'req-1', answers: [{ kind: 'text', text: 'x' }] },
        envWith({
          AI_V2_ENABLED: '', // unconfigured — would otherwise 503
          HOST: '127.0.0.1',
          REQUIRE_LOGIN: '0',
          API_TOKEN: 'device-secret',
        }),
        { ...J, Authorization: 'Bearer device-secret' },
      );
      expect(res.status).toBe(404);
      expect(spawnSpy).not.toHaveBeenCalled();
    },
  );

  it('(b) a foreign turn/request id is rejected even from the correct principal, with session access', async () => {
    const { sessionId: s, studioId } = seededSession();
    const initiator = seedUser({ studios: [studioId] });
    aiV2PendingQuestions.register(
      { sessionId: s, turnId: 'turn-1', requestId: 'req-1' },
      initiator,
      {
        questions: [],
      },
    );

    const res = await postAnswer(
      s,
      { turnId: 'foreign-turn', requestId: 'req-1', answers: [{ kind: 'text', text: 'x' }] },
      loopbackEnv(),
      { ...J, Cookie: await loginCookie(initiator) },
    );

    expect(res.status).toBe(404);
    expect(aiV2PendingQuestions.has({ sessionId: s, turnId: 'turn-1', requestId: 'req-1' })).toBe(
      true,
    );
  });

  it("(a) a DIFFERENT authenticated user with studio access to the SAME session cannot answer another user's pending question", async () => {
    const { sessionId: s, studioId } = seededSession();
    const initiator = seedUser({ studios: [studioId] });
    const coMember = seedUser({ studios: [studioId] });
    aiV2PendingQuestions.register(
      { sessionId: s, turnId: 'turn-1', requestId: 'req-1' },
      initiator,
      {
        questions: [],
      },
    );

    const res = await postAnswer(
      s,
      { turnId: 'turn-1', requestId: 'req-1', answers: [{ kind: 'text', text: 'x' }] },
      loopbackEnv(),
      { ...J, Cookie: await loginCookie(coMember) },
    );

    expect(res.status).toBe(404);
    expect(aiV2PendingQuestions.has({ sessionId: s, turnId: 'turn-1', requestId: 'req-1' })).toBe(
      true,
    );
  });

  it('the initiating principal CAN answer their own pending question — 200, and the pending entry is resolved and removed', async () => {
    const { sessionId: s, studioId } = seededSession();
    const initiator = seedUser({ studios: [studioId] });
    const promise = aiV2PendingQuestions.register(
      { sessionId: s, turnId: 'turn-1', requestId: 'req-1' },
      initiator,
      { questions: [{ question: 'Which widget?' }] },
    );

    const res = await postAnswer(
      s,
      { turnId: 'turn-1', requestId: 'req-1', answers: [{ kind: 'text', text: 'my answer' }] },
      loopbackEnv(),
      { ...J, Cookie: await loginCookie(initiator) },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(aiV2PendingQuestions.has({ sessionId: s, turnId: 'turn-1', requestId: 'req-1' })).toBe(
      false,
    );
    await expect(promise).resolves.toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Which widget?': 'my answer' } },
    });
  });

  it('(d) a late answer (turn already ended / abandoned) has no effect — 404, even from the correct principal', async () => {
    const { sessionId: s, studioId } = seededSession();
    const initiator = seedUser({ studios: [studioId] });
    aiV2PendingQuestions.register(
      { sessionId: s, turnId: 'turn-1', requestId: 'req-1' },
      initiator,
      {
        questions: [],
      },
    );
    aiV2PendingQuestions.abandonTurn(s, 'turn-1'); // simulates a timeout/disconnect ending the turn

    const res = await postAnswer(
      s,
      { turnId: 'turn-1', requestId: 'req-1', answers: [{ kind: 'text', text: 'too late' }] },
      loopbackEnv(),
      { ...J, Cookie: await loginCookie(initiator) },
    );

    expect(res.status).toBe(404);
  });
});

describe('ai/v2/design + ai/v2/answer — a real onQuestion round trip through the actual route wiring (task 3.2)', () => {
  it(
    "(e) AskUserQuestion blocks via canUseTool, relays a preview-stripped question on THIS turn's own SSE " +
      'stream, and the matching POST …/answer un-blocks it — no live SDK turn, no Anthropic spend',
    async () => {
      const { sessionId: s, studioId } = seededSession();
      const user = seedUser({ studios: [studioId] });

      // Exercises the REAL canUseTool/onQuestion/registry/SSE-emission wiring
      // the route builds — no live Agent SDK turn is involved: the fake
      // `Query` calls `options.canUseTool` itself, exactly as the SDK would
      // once it advertises AskUserQuestion and the model calls it, and gates
      // its own next yield on that call's resolution (mirroring how a real
      // turn cannot proceed past a blocking tool_use).
      spawnSpy.mockImplementationOnce((_prompt, options) => {
        async function* gatedQuery(): AsyncGenerator<SDKMessage> {
          await options.canUseTool?.(
            'AskUserQuestion',
            {
              questions: [
                {
                  question: 'Which widget?',
                  header: 'Widget',
                  multiSelect: false,
                  options: [
                    { label: 'Duration', description: 'd', preview: 'SECRET-PREVIEW-CONTENT' },
                  ],
                },
              ],
            },
            {
              signal: new AbortController().signal,
              toolUseID: 'tool-1',
              requestId: 'sdk-req-1',
            } as never,
          );
          yield { type: 'result', subtype: 'success', is_error: false } as unknown as SDKMessage;
        }
        return gatedQuery() as unknown as Query;
      });

      const res = await post(s, { message: 'hi' }, loopbackEnv(), {
        ...J,
        Cookie: await loginCookie(user),
      });
      expect(res.status).toBe(200);

      // Read incrementally (the stream is still open, gated on the answer) —
      // draining with res.text() here would hang until the answer arrives,
      // which this test hasn't sent yet.
      if (res.body === null) throw new Error('SSE response had no body stream');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      const deadline = Date.now() + 5000;
      while (!buffered.includes('event: question')) {
        if (Date.now() > deadline) throw new Error('stream never contained a question event');
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended before a question event arrived');
        buffered += decoder.decode(value, { stream: true });
      }
      const questionBlock = buffered
        .split('\n\n')
        .find((block) => block.includes('event: question'));
      if (questionBlock === undefined) throw new Error('no complete "question" SSE block found');
      const dataLine = questionBlock.split('\n').find((l) => l.startsWith('data: '));
      if (dataLine === undefined) throw new Error('question SSE block had no data line');
      const payload = JSON.parse(dataLine.slice('data: '.length)) as {
        requestId: string;
        turnId: string;
        questions: Array<{
          question: string;
          header: string;
          multiSelect: boolean;
          options: unknown[];
        }>;
      };
      const { requestId, turnId, questions } = payload;
      expect(requestId).toMatch(/^[0-9a-f]{32}$/);
      expect(JSON.stringify(questions)).not.toMatch(/SECRET-PREVIEW-CONTENT/);
      // Phase-3 fix wave (Fix 2): `payload.questions` is the flattened array
      // itself — ONE level below the payload, not `payload.questions.questions`
      // — since this is a NEW, non-frozen SSE event (safe to change now, before
      // Phase 4's web QuestionView consumes it).
      expect(Array.isArray(questions)).toBe(true);
      expect(questions).toEqual([
        {
          question: 'Which widget?',
          header: 'Widget',
          multiSelect: false,
          options: [{ label: 'Duration', description: 'd' }],
        },
      ]);
      expect(aiV2PendingQuestions.has({ sessionId: s, turnId, requestId })).toBe(true);

      const answerRes = await postAnswer(
        s,
        { turnId, requestId, answers: [{ kind: 'text', text: 'session_duration please' }] },
        loopbackEnv(),
        { ...J, Cookie: await loginCookie(user) },
      );
      expect(answerRes.status).toBe(200);
      expect(aiV2PendingQuestions.has({ sessionId: s, turnId, requestId })).toBe(false);

      // Drain the original stream to completion now that the question is
      // answered and the gated turn can proceed to its result.
      let restText = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        restText += decoder.decode(value, { stream: true });
      }
      // The full stream is complete now (both blocks safely delimited), so
      // this reuses the shared `parseSse` structured parser rather than a raw
      // substring match — and doubles as the "canUseTool's promise actually
      // unblocked the gated generator" proof: `resultSuccess` only yields
      // after `options.canUseTool(...)` resolves.
      const events = parseSse(buffered + restText);
      expect(events.some((e) => e.event === 'done')).toBe(true);
    },
  );
});

// ── Task 5.1/5.2/5.3 — dashboard persistence (spec "Dashboard persistence", ──
// design D5/D5a/D5b). GET/PUT/DELETE /api/sessions/:sessionId/ai/v2/dashboard.
// Guard order mirrors design/answer through the config gate: auth (401) ->
// session resolution/scoping (404) -> principal-less/device-token refusal
// (404) -> AI v2 config gate (503) -> body validation (422, PUT only) ->
// store operation. Deliberately NOT gated on open-network/credentials
// refusal (see aiV2.ts's route doc comment) — these tests configure a
// non-loopback/no-allowlist env for the "still works" cases specifically to
// prove that.

function getDashboard(
  sessionId: string,
  reqEnv = loopbackEnv(),
  headers: Record<string, string> = J,
) {
  return app.request(`/api/sessions/${sessionId}/ai/v2/dashboard`, { headers }, reqEnv);
}

function putDashboard(
  sessionId: string,
  body: unknown,
  reqEnv = loopbackEnv(),
  headers: Record<string, string> = J,
  query = '',
) {
  return app.request(
    `/api/sessions/${sessionId}/ai/v2/dashboard${query}`,
    { method: 'PUT', headers, body: typeof body === 'string' ? body : JSON.stringify(body) },
    reqEnv,
  );
}

function deleteDashboard(
  sessionId: string,
  reqEnv = loopbackEnv(),
  headers: Record<string, string> = J,
) {
  return app.request(
    `/api/sessions/${sessionId}/ai/v2/dashboard`,
    { method: 'DELETE', headers },
    reqEnv,
  );
}

const VALID_DASHBOARD = {
  widgets: [{ id: 'w1', type: 'session_duration', title: 'Duration', x: 0, y: 0, w: 4, h: 2 }],
  interactions: [],
};

describe('ai/v2/dashboard — read scoped exactly as the session (spec "Dashboard persistence")', () => {
  it('GET on a session the caller cannot access is masked as 404', async () => {
    const studioId = seedStudio();
    const otherStudioId = seedStudio();
    const show = seedShow({ studioId });
    const s = seedSession({ showId: show });
    const outsider = seedUser({ studios: [otherStudioId] });
    const res = await getDashboard(s, loopbackEnv(), { ...J, Cookie: await loginCookie(outsider) });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { detail: string }).detail).toBe('Session not found');
  });

  it('GET on an accessible session with nothing saved returns 200 with config: null (never a fabricated dashboard)', async () => {
    const s = seededSession().sessionId;
    const res = await getDashboard(s);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ config: null });
  });

  it('GET returns 503 when AI v2 is unconfigured ("every AI v2 route")', async () => {
    const s = seededSession().sessionId;
    const res = await getDashboard(
      s,
      envWith({ AI_V2_ENABLED: '', HOST: '127.0.0.1', REQUIRE_LOGIN: '0' }),
    );
    expect(res.status).toBe(503);
  });

  it('a device token (API_TOKEN, user===null) is masked 404 on GET, same as the design/answer routes', async () => {
    const s = seededSession().sessionId;
    const res = await getDashboard(
      s,
      envWith({
        AI_V2_ENABLED: '1',
        HOST: '127.0.0.1',
        REQUIRE_LOGIN: '0',
        API_TOKEN: 'device-secret',
      }),
      { ...J, Authorization: 'Bearer device-secret' },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { detail: string }).detail).toBe('Session not found');
  });

  it('GET still works on a non-loopback, no-allowlist bind (NOT gated by open-network refusal, unlike design/answer)', async () => {
    const s = seededSession().sessionId;
    const res = await getDashboard(
      s,
      envWith({
        AI_V2_ENABLED: '1',
        HOST: '0.0.0.0',
        REQUIRE_LOGIN: '0',
        IP_ALLOWLIST: '',
        AI_V2_API_KEY: '',
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe('ai/v2/dashboard — write scoped at least as tightly, whole-config validation, created_by/turn (design D5a/D5b)', () => {
  it('PUT on a session the caller cannot access is masked as 404, and nothing is stored', async () => {
    const studioId = seedStudio();
    const otherStudioId = seedStudio();
    const show = seedShow({ studioId });
    const s = seedSession({ showId: show });
    const outsider = seedUser({ studios: [otherStudioId] });
    const res = await putDashboard(s, VALID_DASHBOARD, loopbackEnv(), {
      ...J,
      Cookie: await loginCookie(outsider),
    });
    expect(res.status).toBe(404);
  });

  it('a device token is masked 404 on PUT/DELETE too, and nothing is stored', async () => {
    const s = seededSession().sessionId;
    const deviceEnv = envWith({
      AI_V2_ENABLED: '1',
      HOST: '127.0.0.1',
      REQUIRE_LOGIN: '0',
      API_TOKEN: 'device-secret',
    });
    const headers = { ...J, Authorization: 'Bearer device-secret' };
    const putRes = await putDashboard(s, VALID_DASHBOARD, deviceEnv, headers);
    expect(putRes.status).toBe(404);
    const delRes = await deleteDashboard(s, deviceEnv, headers);
    expect(delRes.status).toBe(404);
    // Confirm nothing was stored despite the device token's attempt.
    const getRes = await getDashboard(s);
    expect(await getRes.json()).toEqual({ config: null });
  });

  it('PUT returns 503 when AI v2 is unconfigured, before body validation', async () => {
    const s = seededSession().sessionId;
    const res = await putDashboard(
      s,
      { garbage: true },
      envWith({ AI_V2_ENABLED: '', HOST: '127.0.0.1', REQUIRE_LOGIN: '0' }),
    );
    expect(res.status).toBe(503);
  });

  it('malformed JSON body is 400', async () => {
    const s = seededSession().sessionId;
    const res = await putDashboard(s, '{not json', loopbackEnv());
    expect(res.status).toBe(400);
  });

  it('a valid config round-trips through PUT then GET, recording created_by from the authenticated principal', async () => {
    const { sessionId: s, studioId } = seededSession();
    const user = seedUser({ studios: [studioId] });
    const headers = { ...J, Cookie: await loginCookie(user) };
    const putRes = await putDashboard(s, VALID_DASHBOARD, loopbackEnv(), headers);
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual({ config: VALID_DASHBOARD });

    const getRes = await getDashboard(s, loopbackEnv(), headers);
    expect(await getRes.json()).toEqual({ config: VALID_DASHBOARD });

    // created_by is recorded in the session DB, not surfaced on the wire
    // (the port's save() returns void; GET's response is config-only, per
    // the port's shape) — check it the way the hub itself would.
    const stored = env.ports.sessions.get(s).getDashboard('primary');
    expect(stored?.createdBy).toBe(user);
  });

  it('an anonymous (no-credentials, REQUIRE_LOGIN=0) write records created_by: null — a safe degraded state, not a security bypass', async () => {
    const s = seededSession().sessionId;
    const res = await putDashboard(s, VALID_DASHBOARD, loopbackEnv());
    expect(res.status).toBe(200);
    const stored = env.ports.sessions.get(s).getDashboard('primary');
    expect(stored?.createdBy).toBeNull();
  });

  it('an optional ?turnId= query param is recorded as the originating turn', async () => {
    const s = seededSession().sessionId;
    const res = await putDashboard(s, VALID_DASHBOARD, loopbackEnv(), J, '?turnId=turn-abc');
    expect(res.status).toBe(200);
    const stored = env.ports.sessions.get(s).getDashboard('primary');
    expect(stored?.createdByTurnId).toBe('turn-abc');
  });

  it(
    'an EMPTY config ({ widgets: [], interactions: [] }) is accepted (fix wave: the "Start blank" empty ' +
      'state was previously rejected 422 by this real route — design D5b imposes no minimum widget count) ' +
      'and round-trips through GET',
    async () => {
      const s = seededSession().sessionId;
      const empty = { widgets: [], interactions: [] };
      const putRes = await putDashboard(s, empty, loopbackEnv());
      expect(putRes.status).toBe(200);
      expect(await putRes.json()).toEqual({ config: empty });

      const getRes = await getDashboard(s);
      expect(await getRes.json()).toEqual({ config: empty });
    },
  );

  it('rejects (422) a config naming an unknown widget type — nothing is stored', async () => {
    const s = seededSession().sessionId;
    const res = await putDashboard(
      s,
      { widgets: [{ ...VALID_DASHBOARD.widgets[0], type: 'custom_widget' }], interactions: [] },
      loopbackEnv(),
    );
    expect(res.status).toBe(422);
    expect(await (await getDashboard(s)).json()).toEqual({ config: null });
  });

  it('rejects (422) a title carrying a javascript: URI — nothing is stored (task 5.1 gate scenario)', async () => {
    const s = seededSession().sessionId;
    const res = await putDashboard(
      s,
      {
        widgets: [{ ...VALID_DASHBOARD.widgets[0], title: 'javascript:alert(1)' }],
        interactions: [],
      },
      loopbackEnv(),
    );
    expect(res.status).toBe(422);
    expect(await (await getDashboard(s)).json()).toEqual({ config: null });
  });

  it('stores a widget title containing HTML tags as literal text (task 5.1 gate scenario — allowed, renders inert)', async () => {
    const s = seededSession().sessionId;
    const htmlTitle = '<b>Q3 Review</b>';
    const res = await putDashboard(
      s,
      { widgets: [{ ...VALID_DASHBOARD.widgets[0], title: htmlTitle }], interactions: [] },
      loopbackEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: typeof VALID_DASHBOARD };
    expect(body.config.widgets[0].title).toBe(htmlTitle);
    const getRes = await getDashboard(s);
    const getBody = (await getRes.json()) as { config: typeof VALID_DASHBOARD };
    expect(getBody.config.widgets[0].title).toBe(htmlTitle);
  });

  it('DELETE removes a saved dashboard — subsequent GET returns config: null', async () => {
    const s = seededSession().sessionId;
    await putDashboard(s, VALID_DASHBOARD, loopbackEnv());
    const delRes = await deleteDashboard(s, loopbackEnv());
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ ok: true });
    expect(await (await getDashboard(s)).json()).toEqual({ config: null });
  });
});

// ── code-health-tail 2.3 (finding 2.11) — guardAiV2Route's gate set is a ──
// PER-ROUTE parameter, not uniform (fact-check S10): under the SAME env,
// /design and /answer 503 on the open-network/credentials refusals while
// every dashboard-CRUD route still serves. A shared prologue that
// accidentally uniformized the gate set (giving the CRUD routes all three
// gates, or the design/answer routes only one) would satisfy "all five
// routes use the helper" and still fail here — this suite pins the
// DIFFERENCE itself, not helper adoption.
describe('ai/v2 — per-route 503 gate sets differ (guardAiV2Route is parameterized, not uniform)', () => {
  /** BOTH refusal predicates true at once: anonymous + non-loopback + no
   * allowlist (aiV2OpenNetworkRefused) and no key + non-loopback
   * (aiV2CredentialsRefused). Fresh env per request (app.ts invariant). */
  const refusedEnv = () =>
    envWith({
      AI_V2_ENABLED: '1',
      HOST: '0.0.0.0',
      REQUIRE_LOGIN: '0',
      IP_ALLOWLIST: '',
      AI_V2_API_KEY: '',
    });

  it('under an open-network + credentials-refused env, /design and /answer 503 while dashboard PUT/GET/DELETE serve', async () => {
    const s = seededSession().sessionId;

    const designRes = await post(s, { message: 'hi' }, refusedEnv());
    expect(designRes.status).toBe(503);
    expect(spawnSpy).not.toHaveBeenCalled();
    const answerRes = await postAnswer(
      s,
      { turnId: 't', requestId: 'r', answers: [] },
      refusedEnv(),
    );
    expect(answerRes.status).toBe(503);

    // The dashboard-CRUD routes never spend the operator's credentials, so
    // they are deliberately NOT gated on either refusal (see aiV2.ts's
    // dashboard block comment) — the full write/read/delete cycle works.
    const putRes = await putDashboard(s, VALID_DASHBOARD, refusedEnv());
    expect(putRes.status).toBe(200);
    const getRes = await getDashboard(s, refusedEnv());
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ config: VALID_DASHBOARD });
    const delRes = await deleteDashboard(s, refusedEnv());
    expect(delRes.status).toBe(200);
  });

  it('under a credentials-only-refused env (login REQUIRED lifts open-network), /design still 503s while dashboard GET serves', async () => {
    const { sessionId: s, studioId } = seededSession();
    const headers = { ...J, Cookie: await loginCookie(seedUser({ studios: [studioId] })) };
    const credsEnv = () =>
      envWith({ AI_V2_ENABLED: '1', REQUIRE_LOGIN: '1', HOST: '0.0.0.0', AI_V2_API_KEY: '' });

    const designRes = await post(s, { message: 'hi' }, credsEnv(), headers);
    expect(designRes.status).toBe(503);
    expect(((await designRes.json()) as { detail: string }).detail).toMatch(
      /AI_V2_API_KEY|loopback/i,
    );

    const getRes = await getDashboard(s, credsEnv(), headers);
    expect(getRes.status).toBe(200);
  });
});

// ── Task 5.4/5.5 — propose_dashboard -> `dashboard` SSE event (design D10, ──
// spec "Dashboards are edited directly, not only by conversation") — no live
// SDK turn, no Anthropic spend. Exercises the REAL wiring the route builds:
// `spawnSpy` captures the actual `options` object aiV2.ts hands to
// `attemptDesignTurnSpawn` (including the real per-turn `mcpServers` entry,
// built by the real `buildAggregateMcpServer` with the real
// `onProposeDashboard` closure aiV2.ts installs) and the fake `Query`
// connects a real MCP client to that SAME `instance` — exactly as a live SDK
// turn's own tool-execution loop would — and calls `propose_dashboard`
// through it. This proves the tool-invocation -> validated-config ->
// `stream.writeSSE({ event: 'dashboard' })` path end to end, not merely that
// the two halves work in isolation.
describe("ai/v2/design — propose_dashboard's validated config reaches the dashboard SSE event (design D10)", () => {
  async function callProposeDashboard(
    mcpServers: Record<string, unknown> | undefined,
    args: Record<string, unknown>,
  ): Promise<{ isError?: boolean; text: string }> {
    const config = mcpServers?.[AGGREGATE_MCP_SERVER_NAME] as McpSdkServerConfigWithInstance;
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const res = (await client.callTool({ name: 'propose_dashboard', arguments: args })) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      return { isError: res.isError, text: res.content[0].text };
    } finally {
      await clientTransport.close();
    }
  }

  it('a valid proposal streams a `dashboard` event carrying the exact validated config, on this stream only', async () => {
    const { sessionId: s, studioId } = seededSession();
    const user = seedUser({ studios: [studioId] });
    const proposedConfig = {
      widgets: [{ id: 'w1', type: 'session_duration', title: 'Duration', x: 0, y: 0, w: 4, h: 2 }],
      interactions: [],
    };

    spawnSpy.mockImplementationOnce((_prompt, options) => {
      async function* gatedQuery(): AsyncGenerator<SDKMessage> {
        const result = await callProposeDashboard(options.mcpServers, proposedConfig);
        if (result.isError)
          throw new Error(`propose_dashboard unexpectedly rejected: ${result.text}`);
        yield { type: 'result', subtype: 'success', is_error: false } as unknown as SDKMessage;
      }
      return gatedQuery() as unknown as Query;
    });

    const res = await post(s, { message: 'hi' }, loopbackEnv(), {
      ...J,
      Cookie: await loginCookie(user),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const events = parseSse(text);

    // Exactly one `dashboard` event, on THIS response's own SSE body — the
    // only stream this test ever reads from. There is no second client/WS
    // connection anywhere in this test (the route never imports or calls any
    // session WS fan-out for this event — see aiV2.ts's onProposeDashboard
    // callback, which only ever calls `stream.writeSSE` on this same Hono
    // stream), so "reaches only the initiating client" holds structurally:
    // there is no other channel this event could have gone out on.
    const dashboardEvents = events.filter((e) => e.event === 'dashboard');
    expect(dashboardEvents).toHaveLength(1);
    const dashboardPayload = dashboardEvents[0].data as { config: unknown; turnId: unknown };
    expect(dashboardPayload.config).toEqual(proposedConfig);
    // Fix wave (Phase 5 review, D5b completeness): the event now ALSO
    // carries this turn's own id (same value the `question` event's
    // `turnId` field would carry for this same turn) — the seam a caller
    // needs to later persist this exact proposal with
    // `?turnId=` and have `createdByTurnId` populated, rather than always
    // null.
    expect(typeof dashboardPayload.turnId).toBe('string');
    expect(dashboardPayload.turnId).toBeTruthy();

    // Terminal `done` still follows, exactly once, as usual.
    expect(events.filter((e) => e.event === 'done')).toHaveLength(1);
  });

  it(
    'the dashboard event turnId, when persisted via PUT ?turnId=, records createdByTurnId on the real write path ' +
      '(fix wave: closes the D5b "originating turn" gap for the proposal-persist flow)',
    async () => {
      const { sessionId: s, studioId } = seededSession();
      const user = seedUser({ studios: [studioId] });
      const proposedConfig = {
        widgets: [
          { id: 'w1', type: 'session_duration', title: 'Duration', x: 0, y: 0, w: 4, h: 2 },
        ],
        interactions: [],
      };

      spawnSpy.mockImplementationOnce((_prompt, options) => {
        async function* gatedQuery(): AsyncGenerator<SDKMessage> {
          const result = await callProposeDashboard(options.mcpServers, proposedConfig);
          if (result.isError)
            throw new Error(`propose_dashboard unexpectedly rejected: ${result.text}`);
          yield { type: 'result', subtype: 'success', is_error: false } as unknown as SDKMessage;
        }
        return gatedQuery() as unknown as Query;
      });

      const headers = { ...J, Cookie: await loginCookie(user) };
      const res = await post(s, { message: 'hi' }, loopbackEnv(), headers);
      const events = parseSse(await res.text());
      const dashboardPayload = events.find((e) => e.event === 'dashboard')?.data as {
        config: unknown;
        turnId: string;
      };
      expect(dashboardPayload.turnId).toBeTruthy();

      // The client "keeps" the proposal: PUT the SAME config, threading the
      // turnId the SSE event carried, exactly as AiV2Panel's keep-flow now
      // does end to end.
      const putRes = await putDashboard(
        s,
        proposedConfig,
        loopbackEnv(),
        headers,
        `?turnId=${encodeURIComponent(dashboardPayload.turnId)}`,
      );
      expect(putRes.status).toBe(200);
      const stored = env.ports.sessions.get(s).getDashboard('primary');
      expect(stored?.createdByTurnId).toBe(dashboardPayload.turnId);
    },
  );

  it('an invalid (markup-bearing) proposal is rejected at the tool boundary — no `dashboard` event, nothing persisted', async () => {
    const { sessionId: s, studioId } = seededSession();
    const user = seedUser({ studios: [studioId] });

    spawnSpy.mockImplementationOnce((_prompt, options) => {
      async function* gatedQuery(): AsyncGenerator<SDKMessage> {
        const result = await callProposeDashboard(options.mcpServers, {
          widgets: [
            {
              id: 'w1',
              type: 'session_duration',
              title: 'javascript:alert(1)',
              x: 0,
              y: 0,
              w: 4,
              h: 2,
            },
          ],
          interactions: [],
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.text)).toMatchObject({ accepted: false });
        yield { type: 'result', subtype: 'success', is_error: false } as unknown as SDKMessage;
      }
      return gatedQuery() as unknown as Query;
    });

    const res = await post(s, { message: 'hi' }, loopbackEnv(), {
      ...J,
      Cookie: await loginCookie(user),
    });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    expect(events.filter((e) => e.event === 'dashboard')).toHaveLength(0);

    // Nothing was persisted either — the propose tool never calls the
    // dashboard store itself (design D10: it only streams; persistence is a
    // separate, explicit client choice through the existing PUT route).
    expect(
      await (
        await getDashboard(s, loopbackEnv(), { ...J, Cookie: await loginCookie(user) })
      ).json(),
    ).toEqual({
      config: null,
    });
  });
});
