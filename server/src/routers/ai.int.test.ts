// ai-topics-chat — POST /api/sessions/:sessionId/ai/chat route shell (tasks 1.1/1.2).
// Locks the guard ORDER and the "spawns nothing on a rejected turn" property:
//   auth (401) → session resolution/scoping (404) → config / open-network gate
//   (503) → body validation (422/400) → single-flight & concurrency (409).
// The turn runner + subprocess spawn are Phase 3; this suite only exercises the
// guards and the placeholder that fires once every guard passes.

import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiChatOpenNetworkRefused } from '../env';
import type { Config } from '../types';
import { app, envWith } from '../test/harness';
import { loginCookie, seedSession, seedShow, seedStudio, seedUser } from '../test/helpers';
import { aiChatTurns } from './aiChatRegistry';

// Mock the seam Phase 3 spawns the CLI through (design D4: argv array,
// shell:false). The shell never spawns, so an untouched spy IS the "no
// subprocess" property, and it stays valid once Phase 3 wires spawn behind these
// same guards. (ESM namespaces aren't spyable, hence a hoisted module mock.)
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const spawnSpy = vi.mocked(spawn);

const J = { 'content-type': 'application/json' };
const CLI = '/fake/claude'; // never invoked — the runner is Phase 3.

beforeEach(() => {
  aiChatTurns.reset();
  spawnSpy.mockClear();
});
afterEach(() => {
  aiChatTurns.reset();
});

async function seededSession(): Promise<string> {
  const studio = await seedStudio();
  const show = await seedShow({ studioId: studio });
  return seedSession({ showId: show });
}

/** Configured + loopback-bound: every gate passes, so requests reach body/
 * single-flight checks (and, when valid, the placeholder). */
function loopbackEnv(overrides: Record<string, unknown> = {}) {
  return envWith({ CLAUDE_CLI_PATH: CLI, HOST: '127.0.0.1', REQUIRE_LOGIN: '0', ...overrides });
}

function post(sessionId: string, body: unknown, env = loopbackEnv(), headers: Record<string, string> = J) {
  return app.request(
    `/api/sessions/${sessionId}/ai/chat`,
    { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) },
    env,
  );
}

describe('ai/chat — auth gate (first)', () => {
  it('401 when REQUIRE_LOGIN=1 and no credentials, before any other check', async () => {
    const s = await seededSession();
    const res = await post(s, { message: 'hi' }, loopbackEnv({ REQUIRE_LOGIN: '1' }));
    expect(res.status).toBe(401);
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

describe('ai/chat — session resolution masks before 503/409', () => {
  it('404 for a nonexistent session even when configured', async () => {
    const res = await post('no-such-session', { message: 'hi' });
    expect(res.status).toBe(404);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('404 for an out-of-studio session — never 503/409 — even unconfigured with a turn in flight', async () => {
    const outsiderStudio = await seedStudio();
    const s = await seededSession();
    const outsider = await seedUser({ studios: [outsiderStudio] });
    // A turn is "in flight" for this session AND the feature is unconfigured: if
    // the config/single-flight gates ran before session scoping we'd see 503/409.
    aiChatTurns.tryAcquire(s, 2);
    const res = await post(
      s,
      { message: 'hi' },
      envWith({ REQUIRE_LOGIN: '1', CLAUDE_CLI_PATH: '', HOST: '0.0.0.0' }),
      { ...J, Cookie: await loginCookie(outsider) },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { detail: string }).detail).toBe('Session not found');
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

describe('ai/chat — configuration gate (503)', () => {
  it('503 not-configured when CLAUDE_CLI_PATH is unset', async () => {
    const s = await seededSession();
    const res = await post(s, { message: 'hi' }, loopbackEnv({ CLAUDE_CLI_PATH: '' }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/not configured/i);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('503 not-configured when CLAUDE_CLI_PATH is whitespace-only', async () => {
    const s = await seededSession();
    const res = await post(s, { message: 'hi' }, loopbackEnv({ CLAUDE_CLI_PATH: '   ' }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/not configured/i);
  });
});

describe('ai/chat — open-network refusal (503)', () => {
  it('503 for anonymous + non-loopback + no allowlist, with a distinct detail, spawning nothing', async () => {
    const s = await seededSession();
    const res = await post(
      s,
      { message: 'hi' },
      envWith({ CLAUDE_CLI_PATH: CLI, REQUIRE_LOGIN: '0', HOST: '0.0.0.0', IP_ALLOWLIST: '' }),
    );
    expect(res.status).toBe(503);
    const detail = ((await res.json()) as { detail: string }).detail;
    expect(detail).toMatch(/network|allowlist|loopback|login/i);
    expect(detail).not.toMatch(/not configured/i);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  // The "allowlist lifts the refusal" branch can't be exercised over HTTP: with
  // an allowlist set, ipAllowlistMiddleware 403s the socket-less test client
  // before the route runs. Exercise the pure predicate directly instead.
  it('predicate: refuses only anonymous + non-loopback + no-allowlist binds', () => {
    const base: Config = {
      PUBLIC_BASE_URL: '', HOST: '0.0.0.0', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
      REQUIRE_LOGIN: '0', SESSION_COOKIE: '', SESSION_DAYS: '14', NEW_USER_ALL_TEAMS: '0',
      COOKIE_SECURE: '', IP_ALLOWLIST: '', TRUST_PROXY: '', API_TOKEN: '', ADMIN_TOKEN: '',
      DEEPGRAM_API_KEY: '', DEEPGRAM_MODEL: '', CLAUDE_CLI_PATH: CLI, AI_CHAT_TIMEOUT_SEC: '',
      AI_CHAT_MAX_CONCURRENT: '', AI_CHAT_MAX_BUDGET_USD: '',
    };
    // anonymous + non-loopback + no allowlist → refused
    expect(aiChatOpenNetworkRefused(base)).toBe(true);
    // unset HOST defaults to 0.0.0.0 (non-loopback) → refused
    expect(aiChatOpenNetworkRefused({ ...base, HOST: '' })).toBe(true);
    // login required → not refused
    expect(aiChatOpenNetworkRefused({ ...base, REQUIRE_LOGIN: '1' })).toBe(false);
    // allowlist present → not refused
    expect(aiChatOpenNetworkRefused({ ...base, IP_ALLOWLIST: '10.0.0.0/8' })).toBe(false);
    // loopback binds → not refused
    for (const h of ['127.0.0.1', '::1', 'localhost']) {
      expect(aiChatOpenNetworkRefused({ ...base, HOST: h })).toBe(false);
    }
  });

  it('loopback-bound anonymous dev still serves (guards pass → 200 SSE placeholder)', async () => {
    const s = await seededSession();
    const res = await post(s, { message: 'hi' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    await res.text(); // drain so the placeholder stream releases its slot
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

describe('ai/chat — body validation (422 / 400), spawning nothing', () => {
  it('422 when message is missing', async () => {
    const s = await seededSession();
    const res = await post(s, {});
    expect(res.status).toBe(422);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('422 when message is whitespace-only (trimmed to empty)', async () => {
    const s = await seededSession();
    const res = await post(s, { message: '   ' });
    expect(res.status).toBe(422);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('422 when message exceeds 8000 chars', async () => {
    const s = await seededSession();
    const res = await post(s, { message: 'x'.repeat(8001) });
    expect(res.status).toBe(422);
  });

  it('422 when claude_session_id is an empty string', async () => {
    const s = await seededSession();
    const res = await post(s, { message: 'hi', claude_session_id: '' });
    expect(res.status).toBe(422);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('400 on malformed JSON, spawning nothing', async () => {
    const s = await seededSession();
    const res = await post(s, 'not json{');
    expect(res.status).toBe(400);
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

describe('ai/chat — single-flight & concurrency (409)', () => {
  it('409 when a turn is already in flight for the same session (session-busy)', async () => {
    const s = await seededSession();
    const slot = aiChatTurns.tryAcquire(s, 2);
    expect(slot.ok).toBe(true);
    try {
      const res = await post(s, { message: 'hi' });
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
    // Ceiling of 1, already consumed by a different session.
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
});
