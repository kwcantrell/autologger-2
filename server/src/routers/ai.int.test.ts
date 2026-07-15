// ai-topics-chat — POST /api/sessions/:sessionId/ai/chat route shell (tasks
// 1.1/1.2) + the real turn runner and JSONL→SSE relay (task 3.3). Locks the
// guard ORDER and the "spawns nothing on a rejected turn" property:
//   auth (401) → session resolution/scoping (404) → config / open-network gate
//   (503) → body validation (422/400) → foreign claude_session_id (422) →
//   single-flight & concurrency (409).
// Every guard-rejection case below still points CLAUDE_CLI_PATH at a bogus
// path (`CLI`, never invoked, since the rejection fires before the spawn) —
// only the "guards pass" describe block near the bottom points at the real
// hermetic fake-claude fixture (task 3.1), because that's the only path that
// actually spawns. The various CLI FAILURE MODES (exit-nonzero/garbage/
// not-logged-in) are covered at the relay-unit level (`aiChatRelay.test.ts`)
// rather than here: `spawnAiChatTurn`'s env whitelist (design D4) strips
// `FAKE_CLAUDE_MODE` along with everything else non-essential, so this
// end-to-end HTTP path can only ever drive the fixture's `success` mode —
// which is itself proof the lockdown reaches even test-selection env vars.
//
// SPAWN OBSERVATION (discovered while writing this task's tests): the
// pre-existing `vi.mock('node:child_process', …)` below does NOT actually
// intercept the spawn `spawnAiChatTurn` makes through the shared `app`
// singleton — `../test/harness` is imported by the `setupFiles` entry
// (`setup.int.ts`) BEFORE this file's hoisted `vi.mock` registers, so
// `aiChatRunner.ts`'s module-level `spawn` binding resolves to the REAL
// function by the time this file's mock factory runs (verified empirically:
// injecting a probe into `spawnAiChatTurn` shows the `spawn` it calls has no
// `.mock` property). Every existing `expect(spawnSpy).not.toHaveBeenCalled()`
// in the guard-rejection describes below is therefore VACUOUS through this
// harness — it always passes, whether or not a real spawn happened — a
// latent gap predating this task (Phase 1's placeholder never spawned
// either way, so the gap was invisible). Left AS-IS here (fixing it is a
// shared-test-infrastructure change beyond this task's scope), but this
// task's OWN new assertions do NOT rely on `spawnSpy` for anything — they
// use the fixture's own on-disk recording (`stableSessionCwd` +
// `.fixture-argv.json`, the same independent-observation technique task 3.2
// established) for real proof of spawn-happened/spawn-args, and file
// presence/absence for real proof of no-spawn.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiChatOpenNetworkRefused } from '../env';
import type { Config } from '../types';
import { app, envWith } from '../test/harness';
import { loginCookie, seedSession, seedShow, seedStudio, seedUser } from '../test/helpers';
import { aiChatTurns } from './aiChatRegistry';
import { stableSessionCwd } from './aiChatRunner';
import { __resetAiChatIssuedSessionIdsForTests } from './ai';

// Kept for the pre-existing guard-rejection assertions (see the SPAWN
// OBSERVATION note above) — harmless, but not load-bearing through this
// harness; do not add new assertions against it.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const spawnSpy = vi.mocked(spawn);

const J = { 'content-type': 'application/json' };
const CLI = '/fake/claude'; // never invoked in guard-rejection cases.
const FIXTURE_CLI = fileURLToPath(new URL('../test/fixtures/fake-claude.mjs', import.meta.url));

/** Real proof a turn's argv reached the CLI (independent of the non-functional
 * `spawnSpy` — see the SPAWN OBSERVATION note): the fixture always records its
 * own argv to a fixed file inside the deterministic per-session cwd. */
function recordedArgv(sessionId: string): string[] {
  return JSON.parse(readFileSync(join(stableSessionCwd(sessionId), '.fixture-argv.json'), 'utf8'));
}

/** Real proof NO turn ever spawned for `sessionId`: the fixture would have
 * written its argv recording the instant it started, before doing anything
 * else — so the recording's absence is absence of a spawn. */
function neverSpawned(sessionId: string): boolean {
  return !existsSync(join(stableSessionCwd(sessionId), '.fixture-argv.json'));
}

/** Parse Hono's `streamSSE` wire format (`event: <t>\ndata: <json>\n\n`, no
 * id/retry per spec) into structured events for assertions. */
function parseSse(text: string): Array<{ event: string; data: unknown }> {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const eventLine = lines.find((l) => l.startsWith('event: '));
      const dataLines = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice('data: '.length));
      return { event: eventLine?.slice('event: '.length) ?? '', data: JSON.parse(dataLines.join('\n')) };
    });
}

beforeEach(() => {
  aiChatTurns.reset();
  __resetAiChatIssuedSessionIdsForTests();
  spawnSpy.mockClear();
});
afterEach(() => {
  aiChatTurns.reset();
  __resetAiChatIssuedSessionIdsForTests();
});

const seededSessionIds: string[] = [];
afterEach(() => {
  for (const id of seededSessionIds.splice(0)) {
    rmSync(stableSessionCwd(id), { recursive: true, force: true });
  }
});

async function seededSession(): Promise<string> {
  const studio = await seedStudio();
  const show = await seedShow({ studioId: studio });
  const id = await seedSession({ showId: show });
  seededSessionIds.push(id);
  return id;
}

/** Configured + loopback-bound: every gate passes, so requests reach body/
 * single-flight checks (and, when valid, the real turn runner). */
function loopbackEnv(overrides: Record<string, unknown> = {}) {
  return envWith({ CLAUDE_CLI_PATH: CLI, HOST: '127.0.0.1', REQUIRE_LOGIN: '0', ...overrides });
}

/** Same as `loopbackEnv`, but CLAUDE_CLI_PATH points at the real hermetic
 * fake-claude fixture — the only env that actually completes a turn. */
function fixtureEnv(overrides: Record<string, unknown> = {}) {
  return loopbackEnv({ CLAUDE_CLI_PATH: FIXTURE_CLI, ...overrides });
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
    expect(neverSpawned(s)).toBe(true);
  });
});

describe('ai/chat — session resolution masks before 503/409', () => {
  it('404 for a nonexistent session even when configured', async () => {
    const res = await post('no-such-session', { message: 'hi' });
    expect(res.status).toBe(404);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(neverSpawned('no-such-session')).toBe(true);
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
    expect(neverSpawned(s)).toBe(true);
  });
});

describe('ai/chat — configuration gate (503)', () => {
  it('503 not-configured when CLAUDE_CLI_PATH is unset', async () => {
    const s = await seededSession();
    const res = await post(s, { message: 'hi' }, loopbackEnv({ CLAUDE_CLI_PATH: '' }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/not configured/i);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(neverSpawned(s)).toBe(true);
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
    expect(neverSpawned(s)).toBe(true);
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

  it('loopback-bound anonymous dev still serves (guards pass → 200 SSE, real relay spawns)', async () => {
    const s = await seededSession();
    const res = await post(s, { message: 'hi' }, fixtureEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const events = parseSse(await res.text());
    // The real fixture's canned success turn: tool then delta then done.
    expect(events).toEqual([
      { event: 'tool', data: { name: 'create_topic' } },
      { event: 'delta', data: { text: 'Created a fixture topic.' } },
      { event: 'done', data: { claude_session_id: 'fixture-cli-session-id' } },
    ]);
    // Real proof the fixture actually ran, with no --resume on a first turn
    // (spawnSpy itself can't prove this positively through this harness — see
    // the SPAWN OBSERVATION note at the top of this file).
    const argv = recordedArgv(s);
    expect(argv).not.toContain('--resume');
    // The slot is released once the turn completes (finally).
    expect(aiChatTurns.isSessionInFlight(s)).toBe(false);
  });
});

describe('ai/chat — body validation (422 / 400), spawning nothing', () => {
  it('422 when message is missing', async () => {
    const s = await seededSession();
    const res = await post(s, {});
    expect(res.status).toBe(422);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(neverSpawned(s)).toBe(true);
  });

  it('422 when message is whitespace-only (trimmed to empty)', async () => {
    const s = await seededSession();
    const res = await post(s, { message: '   ' });
    expect(res.status).toBe(422);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(neverSpawned(s)).toBe(true);
  });

  it('422 when message exceeds 8000 chars', async () => {
    const s = await seededSession();
    const res = await post(s, { message: 'x'.repeat(8001) });
    expect(res.status).toBe(422);
    expect(neverSpawned(s)).toBe(true);
  });

  it('422 when claude_session_id is an empty string', async () => {
    const s = await seededSession();
    const res = await post(s, { message: 'hi', claude_session_id: '' });
    expect(res.status).toBe(422);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(neverSpawned(s)).toBe(true);
  });

  it('400 on malformed JSON, spawning nothing', async () => {
    const s = await seededSession();
    const res = await post(s, 'not json{');
    expect(res.status).toBe(400);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(neverSpawned(s)).toBe(true);
  });
});

describe('ai/chat — multi-turn continuity: claude_session_id ownership (422, before single-flight/spawn)', () => {
  it('422 for a claude_session_id never issued to any session — no spawn', async () => {
    const s = await seededSession();
    const res = await post(s, { message: 'hi', claude_session_id: 'never-issued-id' }, fixtureEnv());
    expect(res.status).toBe(422);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(neverSpawned(s)).toBe(true);
  });

  it('422 for a claude_session_id issued to a DIFFERENT session (foreign) — no spawn, ' +
    "session A's conversation is never resumed under session B", async () => {
    const sessionA = await seededSession();
    const sessionB = await seededSession();

    // Turn one on session A issues (and this relay records) the fixture's
    // default claude_session_id.
    const first = await post(sessionA, { message: 'start on A' }, fixtureEnv());
    expect(first.status).toBe(200);
    const firstEvents = parseSse(await first.text());
    const issuedId = (firstEvents.find((e) => e.event === 'done')?.data as { claude_session_id: string })
      .claude_session_id;
    expect(issuedId).toBe('fixture-cli-session-id');
    expect(neverSpawned(sessionB)).toBe(true); // sanity: B untouched so far

    // Session B tries to resume A's id — rejected before any subprocess.
    // Real proof of "no spawn for B": B's cwd never gets an argv recording.
    const res = await post(sessionB, { message: 'hijack', claude_session_id: issuedId }, fixtureEnv());
    expect(res.status).toBe(422);
    expect(neverSpawned(sessionB)).toBe(true);
  });

  it('same-session resume: an id issued for THIS session is accepted and passed as --resume', async () => {
    const s = await seededSession();

    const first = await post(s, { message: 'start' }, fixtureEnv());
    expect(first.status).toBe(200);
    const firstEvents = parseSse(await first.text());
    const issuedId = (firstEvents.find((e) => e.event === 'done')?.data as { claude_session_id: string })
      .claude_session_id;

    const second = await post(s, { message: 'continue', claude_session_id: issuedId }, fixtureEnv());
    expect(second.status).toBe(200);
    // Drain fully BEFORE inspecting the fixture's recording — streamSSE's
    // callback runs independently of Response construction, so the spawn
    // (and its argv write) isn't guaranteed to have happened until the body
    // is actually consumed.
    const secondEvents = parseSse(await second.text());
    // The fixture's success mode echoes back whatever --resume id it was given.
    expect(secondEvents.find((e) => e.event === 'done')?.data).toEqual({ claude_session_id: issuedId });
    // Real proof --resume was passed: the fixture's OWN recording of the argv
    // it actually received (not the non-functional spawnSpy — see SPAWN
    // OBSERVATION note at the top of this file).
    const argv = recordedArgv(s);
    expect(argv.slice(-2)).toEqual(['--resume', issuedId]);
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
      expect(neverSpawned(s)).toBe(true);
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
      expect(neverSpawned(s)).toBe(true);
    } finally {
      if (slot.ok) slot.release();
    }
  });
});
