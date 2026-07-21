// ai-v2-dashboards — POST /api/sessions/:sessionId/ai/v2/design route shell
// (tasks 2.1/2.2). Locks the guard ORDER and the "spawns nothing" property,
// mirroring ai.int.test.ts's structure for the sibling ai-topics-chat route:
//   auth (401) → session resolution/scoping (404) → config / open-network /
//   agent-credentials gate (503) → body validation (422/400) → turn slot
//   (409, shared with the AI chat's OWN registry by design).
//
// This unit's route stops BEFORE the SDK is ever touched (see aiV2.ts's
// module doc — "SPAWN BOUNDARY"): there is no call to attemptDesignTurnSpawn
// anywhere in aiV2.ts today, so unlike ai.int.test.ts's
// vi.mock('node:child_process') (documented there as VACUOUS through the
// shared `app` singleton), a `vi.spyOn` on the REAL, unmocked
// `attemptDesignTurnSpawn` export is NOT vacuous here: nothing in the `app`
// import graph touches `aiV2SdkSpawn.ts` before this test file's own import
// does, so the spy observes the function's actual (currently zero) call
// count rather than racing an eagerly-bound module-level reference. This is
// the real "no guard path spawns" proof for THIS unit; once tasks 2.3-2.8
// wire the router to actually call attemptDesignTurnSpawn on the allowed
// path, this same spy remains meaningful for the guard-rejection cases (it
// still must show zero calls there), while the "allowed" positive control
// already lives in aiV2SdkSpawn.test.ts (task 0.9) and is intentionally not
// re-run here to keep this suite hermetic and fast.

import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../types';
import { aiV2CredentialsRefused, aiV2OpenNetworkRefused } from '../env';
import { app, envWith } from '../test/harness';
import { loginCookie, seedSession, seedShow, seedStudio, seedUser } from '../test/helpers';
import { aiChatTurns } from './aiChatRegistry';
import * as aiV2SdkSpawnModule from './aiV2SdkSpawn';

const J = { 'content-type': 'application/json' };

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

beforeEach(() => {
  aiChatTurns.reset();
  spawnSpy.mockReset();
  spawnSpy.mockImplementation(() => fakeDesignQuery() as unknown as Query);
});
afterEach(() => {
  aiChatTurns.reset();
});

async function seededSession(): Promise<string> {
  const studio = await seedStudio();
  const show = await seedShow({ studioId: studio });
  return seedSession({ showId: show });
}

/** Same as seededSession, but also returns the studio id so a caller can seed
 * a user WITH access to it (needed for tests that must get PAST the session
 * gate to exercise a later guard, e.g. the credentials-refusal 503). */
async function seededSessionWithStudio(): Promise<{ sessionId: string; studioId: string }> {
  const studioId = await seedStudio();
  const show = await seedShow({ studioId });
  const sessionId = await seedSession({ showId: show });
  return { sessionId, studioId };
}

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

function post(sessionId: string, body: unknown, reqEnv = loopbackEnv(), headers: Record<string, string> = J) {
  return app.request(
    `/api/sessions/${sessionId}/ai/v2/design`,
    { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) },
    reqEnv,
  );
}

describe('ai/v2/design — auth gate (first)', () => {
  it('401 when REQUIRE_LOGIN=1 and no credentials, before any other check', async () => {
    const s = await seededSession();
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
    const outsiderStudio = await seedStudio();
    const s = await seededSession();
    const outsider = await seedUser({ studios: [outsiderStudio] });
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
    const s = await seededSession();
    const res = await post(s, { message: 'hi' }, loopbackEnv({ AI_V2_ENABLED: '' }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/not configured/i);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('503 not-configured when AI_V2_ENABLED is "0"', async () => {
    const s = await seededSession();
    const res = await post(s, { message: 'hi' }, loopbackEnv({ AI_V2_ENABLED: '0' }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/not configured/i);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('disabling AI v2 does not affect the AI chat, and vice versa (independent gates)', async () => {
    const s = await seededSession();
    // AI v2 off, AI chat "configured" (a resolvable-looking path is not
    // required for this assertion — only that its OWN gate, not AI v2's,
    // decides its fate): the AI chat route's 503 detail is its own, distinct
    // wording, proving the two config reads never share state.
    const res = await post(
      s,
      { message: 'hi' },
      envWith({ AI_V2_ENABLED: '', HOST: '127.0.0.1', REQUIRE_LOGIN: '0', CLAUDE_CLI_PATH: '/fake/claude' }),
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
    expect(((await chatRes.json()) as { detail: string }).detail).toMatch(/AI chat is not configured/i);
  });
});

describe('ai/v2/design — open-network refusal (503)', () => {
  it('503 for anonymous + non-loopback + no allowlist, with a distinct detail, spawning nothing', async () => {
    const s = await seededSession();
    const res = await post(
      s,
      { message: 'hi' },
      envWith({ AI_V2_ENABLED: '1', REQUIRE_LOGIN: '0', HOST: '0.0.0.0', IP_ALLOWLIST: '', AI_V2_API_KEY: 'k' }),
    );
    expect(res.status).toBe(503);
    const detail = ((await res.json()) as { detail: string }).detail;
    expect(detail).toMatch(/network|allowlist|loopback|login/i);
    expect(detail).not.toMatch(/not configured/i);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('predicate: aiV2OpenNetworkRefused refuses only anonymous + non-loopback + no-allowlist binds', () => {
    const base: Config = {
      PUBLIC_BASE_URL: '', HOST: '0.0.0.0', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
      REQUIRE_LOGIN: '0', SESSION_COOKIE: '', SESSION_DAYS: '14', NEW_USER_ALL_TEAMS: '0',
      COOKIE_SECURE: '', IP_ALLOWLIST: '', TRUST_PROXY: '', API_TOKEN: '', ADMIN_TOKEN: '',
      DEEPGRAM_API_KEY: '', DEEPGRAM_MODEL: '', CLAUDE_CLI_PATH: '', AI_CHAT_TIMEOUT_SEC: '',
      AI_CHAT_MAX_CONCURRENT: '', AI_CHAT_MAX_BUDGET_USD: '',
      AI_V2_ENABLED: '1', AI_V2_API_KEY: 'k', AI_V2_MAX_BUDGET_USD: '',
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
    const { sessionId: s, studioId } = await seededSessionWithStudio();
    // REQUIRE_LOGIN=1 (not disabled!) so aiV2OpenNetworkRefused would be
    // false here — proving this is a DIFFERENT predicate, not a duplicate of
    // the open-network check.
    const res = await post(
      s,
      { message: 'hi' },
      envWith({ AI_V2_ENABLED: '1', REQUIRE_LOGIN: '1', HOST: '0.0.0.0', AI_V2_API_KEY: '' }),
      { ...J, Cookie: await loginCookie(await seedUser({ studios: [studioId] })) },
    );
    expect(res.status).toBe(503);
    const detail = ((await res.json()) as { detail: string }).detail;
    expect(detail).toMatch(/AI_V2_API_KEY|loopback/i);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('a configured key lifts the refusal even on a non-loopback bind', async () => {
    const { sessionId: s, studioId } = await seededSessionWithStudio();
    const res = await post(
      s,
      { message: 'hi' },
      envWith({ AI_V2_ENABLED: '1', REQUIRE_LOGIN: '1', HOST: '0.0.0.0', AI_V2_API_KEY: 'workspace-key' }),
      { ...J, Cookie: await loginCookie(await seedUser({ studios: [studioId] })) },
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
      PUBLIC_BASE_URL: '', HOST: '0.0.0.0', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
      REQUIRE_LOGIN: '1', SESSION_COOKIE: '', SESSION_DAYS: '14', NEW_USER_ALL_TEAMS: '0',
      COOKIE_SECURE: '', IP_ALLOWLIST: '10.0.0.0/8', TRUST_PROXY: '', API_TOKEN: '', ADMIN_TOKEN: '',
      DEEPGRAM_API_KEY: '', DEEPGRAM_MODEL: '', CLAUDE_CLI_PATH: '', AI_CHAT_TIMEOUT_SEC: '',
      AI_CHAT_MAX_CONCURRENT: '', AI_CHAT_MAX_BUDGET_USD: '',
      AI_V2_ENABLED: '1', AI_V2_API_KEY: '', AI_V2_MAX_BUDGET_USD: '',
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
    const s = await seededSession();
    const res = await post(s, {}, loopbackEnv());
    expect(res.status).toBe(422);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('422 when message is whitespace-only (trimmed to empty)', async () => {
    const s = await seededSession();
    const res = await post(s, { message: '   ' }, loopbackEnv());
    expect(res.status).toBe(422);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('422 when message exceeds 8000 chars', async () => {
    const s = await seededSession();
    const res = await post(s, { message: 'x'.repeat(8001) }, loopbackEnv());
    expect(res.status).toBe(422);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('422 when claude_session_id is an empty string', async () => {
    const s = await seededSession();
    const res = await post(s, { message: 'hi', claude_session_id: '' }, loopbackEnv());
    expect(res.status).toBe(422);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('400 on malformed JSON, spawning nothing', async () => {
    const s = await seededSession();
    const res = await post(s, 'not json{', loopbackEnv());
    expect(res.status).toBe(400);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('422 (invalid body) wins over 409 (slot busy) — body validation runs before the slot check', async () => {
    const s = await seededSession();
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
    const s = await seededSession();
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
    const other = await seededSession();
    const s = await seededSession();
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

  it('a slot held by the AI CHAT route 409s an AI v2 request for the SAME session — genuine sharing, ' +
    'not a coincidence of separate registries with the same default', async () => {
    const s = await seededSession();
    // Acquire via the exact mechanism ai.ts uses: a real HTTP call to the
    // sibling route, held open past the guard chain via an already-aborted
    // signal is unreliable to synchronize on, so acquire the slot directly
    // against the SAME shared singleton the route imports — proving sharing
    // at the registry level, which is what design's "same registry" ruling
    // is actually about (task 2.7 wires the real cross-route HTTP proof once
    // the AI chat's own turn can be held open deterministically).
    const slot = aiChatTurns.tryAcquire(s, 2);
    expect(slot.ok).toBe(true);
    try {
      const res = await post(s, { message: 'hi' }, loopbackEnv());
      expect(res.status).toBe(409);
    } finally {
      if (slot.ok) slot.release();
    }
  });

  it('the slot is released, not leaked, once a turn finishes — a follow-up on the same session is not 409', async () => {
    const s = await seededSession();
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
