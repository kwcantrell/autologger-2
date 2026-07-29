// ai-topics-chat — POST /api/sessions/:sessionId/ai/chat route shell (tasks
// 1.1/1.2) + the real turn runner, JSONL→SSE relay (task 3.3), and spend/
// lifecycle bounds (task 3.4). Locks the guard ORDER and the "spawns nothing
// on a rejected turn" property:
//   auth (401) → session resolution/scoping (404) → config / open-network gate
//   (503) → body validation (422/400) → foreign claude_session_id (422) →
//   single-flight & concurrency (409).
//
// SPAWN OBSERVATION (discovered while writing task 3.3's tests): the
// pre-existing `vi.mock('node:child_process', …)` below does NOT actually
// intercept the spawn `spawnAiChatTurn` makes through the shared `app`
// singleton — `../test/harness` is imported by the `setupFiles` entry
// (`setup.int.ts`) BEFORE this file's hoisted `vi.mock` registers, so
// `aiChatRunner.ts`'s module-level `spawn` binding resolves to the REAL
// function by the time this file's mock factory runs (verified empirically:
// injecting a probe into `spawnAiChatTurn` shows the `spawn` it calls has no
// `.mock` property). Every `expect(spawnSpy).not.toHaveBeenCalled()` in the
// guard-rejection describes below is therefore VACUOUS through this harness
// — it always passes, whether or not a real spawn happened. Kept (harmless,
// zero-cost) alongside the REAL assertion every guard-rejection test now
// makes: `neverSpawned(sessionId)`, backed by the fixture's own on-disk
// recording (`stableSessionCwd` + `.fixture-argv.json`) — and, as of task
// 3.4, EVERY guard-rejection test below (except the two that test the
// config-gate's OWN blank/whitespace `CLAUDE_CLI_PATH` value, where a blank
// path IS the scenario) points `CLAUDE_CLI_PATH` at the REAL fixture
// (`fixtureEnv()`/`FIXTURE_CLI`), not the bogus never-resolvable `CLI` path
// task 1.1/1.2 originally used. This is deliberate and load-bearing: with a
// bogus path, `neverSpawned` would be true unconditionally (spawn against a
// nonexistent binary can never write the fixture's recording, whether or not
// the guard even ran) — a false sense of security. Pointing at a CLI that
// WOULD actually run and record its argv if invoked is what makes
// `neverSpawned` a GENUINE test of "this guard, specifically, is what
// stopped the subprocess" rather than an assertion that can't fail. The
// various CLI FAILURE MODES (exit-nonzero/garbage/not-logged-in/hang) are
// covered at the relay/runner-unit level (`aiChatRelay.test.ts`,
// `aiChatRunner.test.ts`) rather than here: `spawnAiChatTurn`'s env
// whitelist (design D4) strips `FAKE_CLAUDE_MODE` along with everything else
// non-essential, so this end-to-end HTTP path can only ever drive the
// fixture's `success` mode — which is itself proof the lockdown reaches even
// test-selection env vars. Task 3.4's guaranteed-timeout test instead uses
// an impossibly-short `AI_CHAT_TIMEOUT_SEC` against the (fast) `success`
// fixture — deterministic (a real OS process spawn cannot complete within a
// few milliseconds) without needing `hang` mode to survive the whitelist.

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiChatOpenNetworkRefused } from '../env';
import { app, env, envWith } from '../test/harness';
import {
  loginCookie,
  parseSse,
  seededSession as seedSessionChain,
  seedStudio,
  seedUser,
} from '../test/helpers';
import type { Config } from '../types';
import { __resetAiChatIssuedSessionIdsForTests, AI_CHAT_ALLOWED_TOOLS } from './ai';
import { aiChatTurns } from './aiChatRegistry';
import { stableSessionCwd } from './aiChatRunner';
import { AiMcpListener, getAiMcpListener } from './aiMcpServer';
// Namespace import (not the named `driveAiTurn` ai.ts itself uses) so the
// test below can `vi.spyOn` the module's live export — asserting what ai.ts
// passes IN, distinct from the wire string aiChatRunner.ts eventually
// produces (which is identical whether ai.ts passes the tools explicitly or
// omits and falls back to the runner's own default; see that test's comment).
import * as aiTurnModule from './aiTurn';

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

// ── Task 3.4 — lifecycle: no-orphan / cleanup-on-every-path helpers ────────

/** The generated `--mcp-config` file's path (mirrors `spawnAiChatTurn`'s own
 * `join(cwd, 'mcp-config.json')`) — real proof the config is removed. */
function fixtureConfigPath(sessionId: string): string {
  return join(stableSessionCwd(sessionId), 'mcp-config.json');
}

/**
 * Real, TIMING-INDEPENDENT proof no process spawned for `sessionId` survives:
 * scans `/proc/*\/cwd` for any live process whose cwd is this session's
 * stable per-session directory. Deliberately NOT based on the fixture's own
 * self-reported pid file — an artificially tiny `AI_CHAT_TIMEOUT_SEC` (this
 * suite's guaranteed-timeout test) can legitimately kill the child SO early
 * that it never reaches the line that writes that file (measured on this
 * machine: the fixture takes ~25-35ms to even start writing recordings,
 * and its whole `success` run completes in ~30-40ms — too narrow a window to
 * straddle reliably). Scanning `/proc` sidesteps that race entirely: it's
 * true or false regardless of how far the killed child's own JS got.
 */
function anyProcessInCwd(cwd: string): boolean {
  let pidDirs: string[];
  try {
    pidDirs = readdirSync('/proc').filter((p) => /^\d+$/.test(p));
  } catch {
    return false; // non-Linux — best effort, nothing to scan.
  }
  for (const pid of pidDirs) {
    try {
      if (readlinkSync(`/proc/${pid}/cwd`) === cwd) return true;
    } catch {
      // process exited between readdir and readlink, or no permission — not a match.
    }
  }
  return false;
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

/** Shared seed chain + this file's cwd-cleanup registration. */
function seededSession(): string {
  const { sessionId } = seedSessionChain();
  seededSessionIds.push(sessionId);
  return sessionId;
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

function post(
  sessionId: string,
  body: unknown,
  reqEnv = loopbackEnv(),
  headers: Record<string, string> = J,
  signal?: AbortSignal,
) {
  return app.request(
    `/api/sessions/${sessionId}/ai/chat`,
    {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal,
    },
    reqEnv,
  );
}

describe('ai/chat — auth gate (first)', () => {
  it('401 when REQUIRE_LOGIN=1 and no credentials, before any other check', async () => {
    const s = seededSession();
    // fixtureEnv (not loopbackEnv's bogus CLI): a real, resolvable CLI, so
    // `neverSpawned` genuinely proves the auth guard — not a misconfigured
    // path — is what stopped the subprocess (see SPAWN OBSERVATION note).
    const res = await post(s, { message: 'hi' }, fixtureEnv({ REQUIRE_LOGIN: '1' }));
    expect(res.status).toBe(401);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(neverSpawned(s)).toBe(true);
  });
});

describe('ai/chat — session resolution masks before 503/409', () => {
  it('404 for a nonexistent session even when configured', async () => {
    const res = await post('no-such-session', { message: 'hi' }, fixtureEnv());
    expect(res.status).toBe(404);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(neverSpawned('no-such-session')).toBe(true);
  });

  it('404 for an out-of-studio session — never 503/409 — even unconfigured with a turn in flight', async () => {
    const outsiderStudio = seedStudio();
    const s = seededSession();
    const outsider = seedUser({ studios: [outsiderStudio] });
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
    const s = seededSession();
    const res = await post(s, { message: 'hi' }, loopbackEnv({ CLAUDE_CLI_PATH: '' }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/not configured/i);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(neverSpawned(s)).toBe(true);
  });

  it('503 not-configured when CLAUDE_CLI_PATH is whitespace-only', async () => {
    const s = seededSession();
    const res = await post(s, { message: 'hi' }, loopbackEnv({ CLAUDE_CLI_PATH: '   ' }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/not configured/i);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(neverSpawned(s)).toBe(true);
  });
});

describe('ai/chat — open-network refusal (503)', () => {
  it('503 for anonymous + non-loopback + no allowlist, with a distinct detail, spawning nothing', async () => {
    const s = seededSession();
    // fixture-backed (not CLI's bogus path) — see the header note: a real,
    // resolvable CLI path is what makes `neverSpawned` prove THIS guard
    // stopped the subprocess, not just that a bogus path never resolves.
    const res = await post(
      s,
      { message: 'hi' },
      envWith({
        CLAUDE_CLI_PATH: FIXTURE_CLI,
        REQUIRE_LOGIN: '0',
        HOST: '0.0.0.0',
        IP_ALLOWLIST: '',
      }),
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
      CLAUDE_CLI_PATH: CLI,
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
      AI_V2_ENABLED: '',
      AI_V2_API_KEY: '',
      AI_V2_MAX_BUDGET_USD: '',
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
    const s = seededSession();
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

describe('ai/chat — tool surface pinned explicitly (auto-generate-event-logs D7, task 3.4)', () => {
  it(
    'the spawned argv --allowedTools names exactly the three chat tools, byte-identical ' +
      'and order-stable — the WIRE STRING that reaches the CLI (see the next test for the ' +
      'ai.ts-level pin: this argv is identical whether ai.ts passes the tools explicitly or ' +
      'omits and falls back to the runner default, so it alone cannot distinguish the two)',
    async () => {
      const s = seededSession();
      const res = await post(s, { message: 'hi' }, fixtureEnv());
      expect(res.status).toBe(200);
      await res.text(); // drain the SSE stream so the turn completes
      const argv = recordedArgv(s);
      const i = argv.indexOf('--allowedTools');
      expect(i).toBeGreaterThanOrEqual(0);
      // Byte-pinned literal (D7): the registry now also carries `create_event`,
      // and growing it must never widen a chat turn's argv. This is the exact
      // string the pre-3.4 omit-path default produced — explicitness changed
      // nothing observable. (The runner's own omit-path default stays pinned to
      // the same three by aiChatRunner.test.ts "the allowedTools value names
      // exactly the three mcp__autologger__* tools" — 3.2's pin.)
      expect(argv[i + 1]).toBe(
        'mcp__autologger__get_transcript_words,mcp__autologger__list_topics,mcp__autologger__create_topic',
      );
      // ...and the literal above stays in lockstep with the exported constant
      // `ai.ts` actually passes, so the two can never drift apart silently.
      expect(argv[i + 1]).toBe(AI_CHAT_ALLOWED_TOOLS.map((n) => `mcp__autologger__${n}`).join(','));
    },
  );

  it(
    "driveAiTurn receives ai.ts's explicit allowedTools option, pinned AT THE ai.ts CALL " +
      'LEVEL — not just the runner default: deleting the `allowedTools: AI_CHAT_ALLOWED_TOOLS` ' +
      'pass in ai.ts would leave the argv test above green (the runner omit-path default emits ' +
      'the identical wire string), so that test alone cannot pin explicitness. This one can, by ' +
      "asserting the option ai.ts hands to driveAiTurn's spawn-options layer directly.",
    async () => {
      const spy = vi.spyOn(aiTurnModule, 'driveAiTurn');
      try {
        const s = seededSession();
        const res = await post(s, { message: 'hi' }, fixtureEnv());
        expect(res.status).toBe(200);
        await res.text(); // drain the SSE stream so the turn completes
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0].allowedTools).toEqual(AI_CHAT_ALLOWED_TOOLS);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it(
    "registerTurn receives chat's explicit turn context ({tools: AI_CHAT_ALLOWED_TOOLS}) — " +
      'server-side registration no longer relies on the context-less default',
    async () => {
      // Prototype spy — unlike the file-top `vi.mock` (see SPAWN OBSERVATION),
      // this intercepts reliably: method dispatch goes through the prototype at
      // call time, regardless of when the app-singleton listener was built.
      const spy = vi.spyOn(AiMcpListener.prototype, 'registerTurn');
      try {
        const s = seededSession();
        const res = await post(s, { message: 'hi' }, fixtureEnv());
        expect(res.status).toBe(200);
        await res.text();
        const call = spy.mock.calls.find(([sessionId]) => sessionId === s);
        expect(call).toBeDefined();
        expect(call?.[1]).toEqual({ tools: AI_CHAT_ALLOWED_TOOLS });
      } finally {
        spy.mockRestore();
      }
    },
  );
});

describe('ai/chat — body validation (422 / 400), spawning nothing', () => {
  it('422 when message is missing', async () => {
    const s = seededSession();
    const res = await post(s, {}, fixtureEnv());
    expect(res.status).toBe(422);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(neverSpawned(s)).toBe(true);
  });

  it('422 when message is whitespace-only (trimmed to empty)', async () => {
    const s = seededSession();
    const res = await post(s, { message: '   ' }, fixtureEnv());
    expect(res.status).toBe(422);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(neverSpawned(s)).toBe(true);
  });

  it('422 when message exceeds 8000 chars', async () => {
    const s = seededSession();
    const res = await post(s, { message: 'x'.repeat(8001) }, fixtureEnv());
    expect(res.status).toBe(422);
    expect(neverSpawned(s)).toBe(true);
  });

  it('422 when claude_session_id is an empty string', async () => {
    const s = seededSession();
    const res = await post(s, { message: 'hi', claude_session_id: '' }, fixtureEnv());
    expect(res.status).toBe(422);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(neverSpawned(s)).toBe(true);
  });

  it('400 on malformed JSON, spawning nothing', async () => {
    const s = seededSession();
    const res = await post(s, 'not json{', fixtureEnv());
    expect(res.status).toBe(400);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(neverSpawned(s)).toBe(true);
  });
});

describe('ai/chat — multi-turn continuity: claude_session_id ownership (422, before single-flight/spawn)', () => {
  it('422 for a claude_session_id never issued to any session — no spawn', async () => {
    const s = seededSession();
    const res = await post(
      s,
      { message: 'hi', claude_session_id: 'never-issued-id' },
      fixtureEnv(),
    );
    expect(res.status).toBe(422);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(neverSpawned(s)).toBe(true);
  });

  it(
    '422 for a claude_session_id issued to a DIFFERENT session (foreign) — no spawn, ' +
      "session A's conversation is never resumed under session B",
    async () => {
      const sessionA = seededSession();
      const sessionB = seededSession();

      // Turn one on session A issues (and this relay records) the fixture's
      // default claude_session_id.
      const first = await post(sessionA, { message: 'start on A' }, fixtureEnv());
      expect(first.status).toBe(200);
      const firstEvents = parseSse(await first.text());
      const firstDone = firstEvents.find((e) => e.event === 'done');
      if (!firstDone) throw new Error('turn one emitted no `done` event');
      const issuedId = (firstDone.data as { claude_session_id: string }).claude_session_id;
      expect(issuedId).toBe('fixture-cli-session-id');
      expect(neverSpawned(sessionB)).toBe(true); // sanity: B untouched so far

      // Session B tries to resume A's id — rejected before any subprocess.
      // Real proof of "no spawn for B": B's cwd never gets an argv recording.
      const res = await post(
        sessionB,
        { message: 'hijack', claude_session_id: issuedId },
        fixtureEnv(),
      );
      expect(res.status).toBe(422);
      expect(neverSpawned(sessionB)).toBe(true);
    },
  );

  it('same-session resume: an id issued for THIS session is accepted and passed as --resume', async () => {
    const s = seededSession();

    const first = await post(s, { message: 'start' }, fixtureEnv());
    expect(first.status).toBe(200);
    const firstEvents = parseSse(await first.text());
    const firstDone = firstEvents.find((e) => e.event === 'done');
    if (!firstDone) throw new Error('turn one emitted no `done` event');
    const issuedId = (firstDone.data as { claude_session_id: string }).claude_session_id;

    const second = await post(
      s,
      { message: 'continue', claude_session_id: issuedId },
      fixtureEnv(),
    );
    expect(second.status).toBe(200);
    // Drain fully BEFORE inspecting the fixture's recording — streamSSE's
    // callback runs independently of Response construction, so the spawn
    // (and its argv write) isn't guaranteed to have happened until the body
    // is actually consumed.
    const secondEvents = parseSse(await second.text());
    // The fixture's success mode echoes back whatever --resume id it was given.
    expect(secondEvents.find((e) => e.event === 'done')?.data).toEqual({
      claude_session_id: issuedId,
    });
    // Real proof --resume was passed: the fixture's OWN recording of the argv
    // it actually received (not the non-functional spawnSpy — see SPAWN
    // OBSERVATION note at the top of this file).
    const argv = recordedArgv(s);
    expect(argv.slice(-2)).toEqual(['--resume', issuedId]);
  });
});

describe('ai/chat — single-flight & concurrency (409)', () => {
  it('409 when a turn is already in flight for the same session (session-busy)', async () => {
    const s = seededSession();
    const slot = aiChatTurns.tryAcquire(s, 2);
    expect(slot.ok).toBe(true);
    try {
      const res = await post(s, { message: 'hi' }, fixtureEnv());
      expect(res.status).toBe(409);
      expect(((await res.json()) as { detail: string }).detail).toMatch(/in progress|already/i);
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(neverSpawned(s)).toBe(true);
    } finally {
      if (slot.ok) slot.release();
    }
  });

  it('409 when the process-wide ceiling is reached, with a distinct detail', async () => {
    const other = seededSession();
    const s = seededSession();
    // Ceiling of 1, already consumed by a different session.
    const slot = aiChatTurns.tryAcquire(other, 1);
    expect(slot.ok).toBe(true);
    try {
      const res = await post(s, { message: 'hi' }, fixtureEnv({ AI_CHAT_MAX_CONCURRENT: '1' }));
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

describe('ai/chat — guaranteed turn timeout kills the subprocess (task 3.4, spec "Subprocess lifecycle")', () => {
  it(
    'an impossibly-short AI_CHAT_TIMEOUT_SEC forces termination even though the CLI would otherwise ' +
      'succeed, ending the stream with EXACTLY ONE error{timeout} event and cleaning up every resource',
    async () => {
      const s = seededSession();
      // A real OS process spawn (fork+exec+Node startup) cannot complete within
      // 10ms — measured on this machine at ~25-40ms even for the trivial fixture
      // — so this timeout deterministically wins the race against the (fast)
      // `success` fixture, without needing `hang` mode (unreachable through the
      // real HTTP path — see the header note).
      const res = await post(s, { message: 'hi' }, fixtureEnv({ AI_CHAT_TIMEOUT_SEC: '0.01' }));
      expect(res.status).toBe(200); // accepted — the guard order already passed; the failure is mid-stream.
      // Draining fully waits for the route's ENTIRE `finally` (kill, dispose,
      // cleanup, release) to complete — see the resume test's note above on why
      // this ordering is safe, not a race.
      const events = parseSse(await res.text());
      expect(events).toEqual([{ event: 'error', data: { detail: 'timeout' } }]);

      // No orphan (timing-independent — see anyProcessInCwd's doc comment).
      expect(anyProcessInCwd(stableSessionCwd(s))).toBe(false);
      // Generated MCP config removed.
      expect(existsSync(fixtureConfigPath(s))).toBe(false);
      // MCP registration count back to 0 — the process-wide singleton, so this
      // is real proof `mcpTurn.dispose()` ran (not just "the route returned").
      const listener = await getAiMcpListener(env.ports.sessions);
      expect(listener.registrationCount).toBe(0);
      // The slot is released — a follow-up turn on the SAME session succeeds
      // normally (proves release-on-timeout, not just release-on-success).
      expect(aiChatTurns.isSessionInFlight(s)).toBe(false);
      const second = await post(s, { message: 'again' }, fixtureEnv());
      expect(second.status).toBe(200);
      const secondEvents = parseSse(await second.text());
      expect(secondEvents.some((e) => e.event === 'done')).toBe(true);
    },
  );
});

describe('ai/chat — best-effort client disconnect kills the subprocess (task 3.4, spec "Subprocess lifecycle")', () => {
  it(
    'an already-aborted request signal kills the spawned CLI process group and cleans up every ' +
      'resource, ending the stream with NO terminal event (nobody is listening)',
    async () => {
      const s = seededSession();
      const controller = new AbortController();
      controller.abort(); // simulates the client having already disconnected
      const res = await post(s, { message: 'hi' }, fixtureEnv(), J, controller.signal);
      // Guard order already accepted the turn (auth/404/503/422/409 all passed)
      // before the abort race inside the stream callback ever runs.
      expect(res.status).toBe(200);
      const events = parseSse(await res.text());
      // Best-effort disconnect: spec permits (and this design chooses) NO
      // terminal event at all — the client that would receive it is gone.
      expect(events).toEqual([]);

      expect(anyProcessInCwd(stableSessionCwd(s))).toBe(false);
      expect(existsSync(fixtureConfigPath(s))).toBe(false);
      const listener = await getAiMcpListener(env.ports.sessions);
      expect(listener.registrationCount).toBe(0);
      expect(aiChatTurns.isSessionInFlight(s)).toBe(false);
      const second = await post(s, { message: 'again' }, fixtureEnv());
      expect(second.status).toBe(200);
      const secondEvents = parseSse(await second.text());
      expect(secondEvents.some((e) => e.event === 'done')).toBe(true);
    },
  );
});

describe('ai/chat — setup failures never leak the raw exception (task 3.4 concern B)', () => {
  it(
    'when spawnAiChatTurn itself throws (a real, hermetic failure — not a mock), the client ' +
      "sees the SCRUBBED internal-error detail, never the raw exception's text or paths",
    async () => {
      const s = seededSession();
      // A REAL, hermetic way to force spawnAiChatTurn's mkdirSync to throw
      // (EEXIST) — no mocking of shared infra: pre-occupy the exact path
      // `stableSessionCwd(s)` with a FILE instead of a directory, so
      // `mkdirSync(cwd, {recursive:true})` cannot create it.
      const cwd = stableSessionCwd(s);
      mkdirSync(dirname(cwd), { recursive: true });
      writeFileSync(cwd, 'not-a-directory — forces spawnAiChatTurn to throw EEXIST');

      const res = await post(s, { message: 'hi' }, fixtureEnv());
      expect(res.status).toBe(200); // guards already passed; the failure is inside the stream callback.
      const events = parseSse(await res.text());
      expect(events).toEqual([{ event: 'error', data: { detail: 'internal-error' } }]);

      // The raw exception (EEXIST, the tmp path, the sessionId-derived cwd) never
      // reaches the client — only the fixed, scrubbed detail string.
      const wire = JSON.stringify(events);
      expect(wire).not.toMatch(/EEXIST|ENOENT|mkdir|not-a-directory/i);
      expect(wire).not.toContain(cwd);
      expect(wire).not.toContain(s);

      // Cleanup still ran on this path: the MCP turn WAS registered (before the
      // throw) and its dispose() still fired in `finally` — registration count
      // returns to 0 even when spawnAiChatTurn itself fails.
      const listener = await getAiMcpListener(env.ports.sessions);
      expect(listener.registrationCount).toBe(0);
      expect(aiChatTurns.isSessionInFlight(s)).toBe(false);
    },
  );
});
