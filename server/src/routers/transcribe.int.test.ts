import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRANSCRIPTION_FIXTURES_DIR, transcriptGenerationLock } from '@autologger/transcription';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiChatTurns } from '../ai-runtime/aiChatRegistry';
import { stableSessionCwd } from '../ai-runtime/aiChatRunner';
import { __resetAiMcpListenerForTests } from '../ai-runtime/aiMcpServer';
// Namespace import so the page-coverage suite below can `vi.spyOn` the live
// module export (see that suite's header for why a hoisted `vi.mock` cannot
// work through the shared `app` singleton).
import type { generateTopicsTurn } from '../ai-runtime/topicGenerate';
import * as topicGenerateModule from '../ai-runtime/topicGenerate';
import { app, env, envWith } from '../test/harness';
import {
  catalogFor,
  loginCookie,
  seededSession,
  seedSession,
  seedShow,
  seedStudio,
  seedUser,
} from '../test/helpers';

const J = { 'content-type': 'application/json' };

describe('unavailable endpoints (503)', () => {
  it('transcribe.csv, transcript-words/generate, topics/generate are 503', async () => {
    const s = seededSession().sessionId;
    for (const path of [
      `/api/sessions/${s}/transcribe.csv`,
      `/api/sessions/${s}/transcript-words/generate`,
      `/api/sessions/${s}/topics/generate`,
    ]) {
      const method = path.endsWith('.csv') ? 'GET' : 'POST';
      const res = await app.request(path, { method }, { ...env });
      expect(res.status).toBe(503);
    }
  });

  it('unconfigured generate is byte-identical to the pre-change frozen response', async () => {
    const s = seededSession().sessionId;
    const res = await app.request(
      `/api/sessions/${s}/transcript-words/generate`,
      { method: 'POST' },
      { ...env }, // DEEPGRAM_API_KEY unset in the base test env
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      detail: 'Transcription is unavailable on this deployment.',
    });
  });

  // ── Characterization: topics/generate (topic-generation, task 1.1) ─────────
  // Pins the CURRENT (pre-change) behavior byte-for-byte, ahead of phase 3
  // flipping the 503 stub to a gated handler. Update this test in lockstep
  // with that change, not before.

  it('topics/generate is byte-identical to the pre-change frozen 503', async () => {
    const s = seededSession().sessionId;
    const res = await app.request(
      `/api/sessions/${s}/topics/generate`,
      { method: 'POST' },
      { ...env },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      detail: 'Transcription is unavailable on this deployment.',
    });
  });

  it('topics/generate 404s an unknown session before the 503 (requireSession guard unchanged)', async () => {
    const res = await app.request(
      '/api/sessions/does-not-exist/topics/generate',
      { method: 'POST' },
      { ...env },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Session not found' });
  });
});

// ── topics/generate — configured behavior (topic-generation, task 3.2) ─────
// Frozen-surface self-check: this suite asserts only the statuses/shapes
// authorized by openspec/changes/topic-generation/specs/api-contract-freeze/
// spec.md's status matrix — 503 (unconfigured, byte-identical to pre-change),
// 503 (open-network, distinct detail), 400 (no-transcript), 409 (busy/at-
// capacity), 200 {topics} (success, shape matches GET …/topics), 502
// (failure, fixed detail, prior topics byte-for-byte unchanged) — plus the
// unchanged 404 (requireSession) and transcribe.csv's unchanged 503. No
// other status/shape is asserted.
//
// Uses REAL fixtures against the REAL in-process MCP listener
// (`fake-claude-topics-success.mjs` / `fake-claude-topics-partial-fail.mjs`)
// so the success/failure swap (design D3) is proven against genuine DB rows,
// not simulated stream-json — see those fixtures' header comments. The
// existing `fake-claude.mjs` (`success` mode) and `fake-claude-error.mjs`
// fixtures never make a real MCP round trip, which this suite also exploits
// deliberately for the zero-topics-created case (see that test).
describe('topics/generate — configured behavior (topic-generation)', () => {
  const SUCCESS_STREAM_FIXTURE = fileURLToPath(
    new URL('../test/fixtures/fake-claude.mjs', import.meta.url),
  );
  const REAL_SUCCESS_FIXTURE = fileURLToPath(
    new URL('../test/fixtures/fake-claude-topics-success.mjs', import.meta.url),
  );
  const REAL_PARTIAL_FAIL_FIXTURE = fileURLToPath(
    new URL('../test/fixtures/fake-claude-topics-partial-fail.mjs', import.meta.url),
  );

  const TOPIC_GENERATE_FAILURE_DETAIL = 'Topic generation failed.';

  const seededIds: string[] = [];
  // One afterEach for the whole describe. These were two hooks; vitest's
  // default 'stack' hook order ran the later-registered reset before this
  // cwd cleanup, so the merged body keeps the reset first.
  afterEach(async () => {
    aiChatTurns.reset();
    await __resetAiMcpListenerForTests();
    for (const id of seededIds.splice(0)) {
      rmSync(stableSessionCwd(id), { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    aiChatTurns.reset();
    // The process-wide MCP listener singleton binds to whichever
    // SessionHubRegistry first calls getAiMcpListener(); resetTestEnv()
    // (this file's global beforeEach, registered earlier via setup.int.ts)
    // gives every test a FRESH registry, so the singleton must be reset too
    // — otherwise a real create_topic MCP call in this test would write into
    // a stale registry from an earlier test, invisible to this test's own
    // `env.ports.sessions` reads (mirrors topicGenerate.test.ts's afterEach).
    await __resetAiMcpListenerForTests();
  });

  function newSession(): string {
    const s = seededSession().sessionId;
    seededIds.push(s);
    return s;
  }

  // Named for its gate (CLAUDE_CLI_PATH) — this file also has a module-level
  // `deepgramConfiguredEnv` for the transcript-generation suite below; the two
  // used to share the name `configuredEnv`, the inner silently shadowing the
  // outer (code-health-tail task 5.1, finding 5.10).
  function claudeConfiguredEnv(cliPath: string, overrides: Record<string, unknown> = {}) {
    return envWith({
      CLAUDE_CLI_PATH: cliPath,
      HOST: '127.0.0.1',
      REQUIRE_LOGIN: '0',
      ...overrides,
    });
  }

  function generateReq(sessionId: string, envOverride: ReturnType<typeof envWith>) {
    return app.request(
      `/api/sessions/${sessionId}/topics/generate`,
      { method: 'POST' },
      envOverride,
    );
  }

  function seedTranscript(sessionId: string): void {
    env.ports.sessions.get(sessionId).insertTranscriptWord({
      session_time: '00:00:01',
      speaker: 'Host',
      word: 'hello',
    });
  }

  /** Seed a transcript whose generation-density rendering is big enough to
   * span MORE THAN ONE page (topic-generate-paged-transcript D4: pages are
   * packed to a 45,000-char rendered cap). 30 words of ~2,000 chars group into
   * 3 lines of `GENERATION_LINE_MAX_WORDS` (~20,000 chars each), so the packer
   * must break after the second line. Without this the success fixture's
   * continuation-marker loop would never iterate and the route's 200 would
   * prove only the single-page case. */
  function seedMultiPageTranscript(sessionId: string): void {
    const hub = env.ports.sessions.get(sessionId);
    for (let i = 0; i < 30; i += 1) {
      hub.insertTranscriptWord({
        session_time: '00:00:01',
        speaker: 'Host',
        word: `w${i}${'a'.repeat(2_000)}`,
      });
    }
  }

  /** Pages the success fixture actually fetched over real MCP (it records the
   * count into its run cwd — see fake-claude-topics-success.mjs). */
  function fixturePagesRead(sessionId: string): number {
    return Number(readFileSync(join(stableSessionCwd(sessionId), '.fixture-pages.txt'), 'utf8'));
  }

  function seedTopic(sessionId: string, summary: string) {
    return env.ports.sessions.get(sessionId).insertTopic({
      session_time: '00:00:00',
      duration_sec: 10,
      topic_level: 1,
      summary,
    });
  }

  function currentTopics(sessionId: string) {
    return env.ports.sessions.get(sessionId).listTopics();
  }

  /** Real proof no `claude` subprocess ran for `sessionId`: the fixtures all
   * write their argv recording to a fixed file inside the deterministic
   * per-session cwd the instant they start (mirrors ai.int.test.ts). */
  function neverSpawned(sessionId: string): boolean {
    return !existsSync(join(stableSessionCwd(sessionId), '.fixture-argv.json'));
  }

  function recordedArgv(sessionId: string): string[] {
    return JSON.parse(
      readFileSync(join(stableSessionCwd(sessionId), '.fixture-argv.json'), 'utf8'),
    );
  }

  it('unconfigured: 503 byte-identical to the pre-change detail, no spawn (configured-vs-unconfigured contrast)', async () => {
    const s = newSession();
    const res = await generateReq(s, envWith({ CLAUDE_CLI_PATH: '' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      detail: 'Transcription is unavailable on this deployment.',
    });
    expect(neverSpawned(s)).toBe(true);
  });

  it('open-network + configured: 503 with a distinct detail, no spawn', async () => {
    const s = newSession();
    seedTranscript(s);
    const res = await generateReq(
      s,
      envWith({
        CLAUDE_CLI_PATH: SUCCESS_STREAM_FIXTURE,
        REQUIRE_LOGIN: '0',
        HOST: '0.0.0.0',
        IP_ALLOWLIST: '',
      }),
    );
    expect(res.status).toBe(503);
    const detail = ((await res.json()) as { detail: string }).detail;
    expect(detail).toMatch(/network|allowlist|loopback|login/i);
    expect(detail).not.toBe('Transcription is unavailable on this deployment.');
    expect(neverSpawned(s)).toBe(true);
  });

  it('configured + no transcript words: 400, no spawn', async () => {
    const s = newSession();
    // Deliberately no seedTranscript(s) call.
    const res = await generateReq(s, claudeConfiguredEnv(SUCCESS_STREAM_FIXTURE));
    expect(res.status).toBe(400);
    const detail = ((await res.json()) as { detail: string }).detail;
    expect(detail).toMatch(/transcript/i);
    expect(neverSpawned(s)).toBe(true);
  });

  it('configured + concurrency: a turn already holding the session slot → 409, no spawn', async () => {
    const s = newSession();
    seedTranscript(s);
    const slot = aiChatTurns.tryAcquire(s, 2);
    expect(slot.ok).toBe(true);
    try {
      const res = await generateReq(s, claudeConfiguredEnv(SUCCESS_STREAM_FIXTURE));
      expect(res.status).toBe(409);
      const detail = ((await res.json()) as { detail: string }).detail;
      expect(detail).toMatch(/progress|busy|generat/i);
      expect(neverSpawned(s)).toBe(true);
    } finally {
      if (slot.ok) slot.release();
    }
  });

  it(
    'configured + MULTI-PAGE transcript + success: 200 {topics} — the OLD topics are gone, the ' +
      'fresh set (real create_topic calls) replaces them, and the shape matches GET …/topics',
    async () => {
      const s = newSession();
      seedMultiPageTranscript(s);
      const oldA = seedTopic(s, 'Old topic A');
      const oldB = seedTopic(s, 'Old topic B');
      expect(
        currentTopics(s)
          .map((t) => t.id)
          .sort(),
      ).toEqual([oldA.id, oldB.id].sort());

      const res = await generateReq(s, claudeConfiguredEnv(REAL_SUCCESS_FIXTURE));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { topics: Array<Record<string, unknown>> };

      // The OLD topics are gone — proves the success branch deleted preRunIds.
      const bodyIds = body.topics.map((t) => t.id);
      expect(bodyIds).not.toContain(oldA.id);
      expect(bodyIds).not.toContain(oldB.id);

      // The fresh set is exactly what the fixture's real create_topic calls
      // created (2 topics — see fake-claude-topics-success.mjs).
      expect(body.topics).toHaveLength(2);
      expect(body.topics.map((t) => t.summary).sort()).toEqual(
        ['Fresh fixture topic 0', 'Fresh fixture topic 1'].sort(),
      );

      // Shape matches GET …/topics entries exactly (same field set).
      const getRes = await app.request(`/api/sessions/${s}/topics`, { method: 'GET' }, { ...env });
      const getBody = (await getRes.json()) as { topics: Array<Record<string, unknown>> };
      expect(getBody.topics).toEqual(body.topics);
      for (const t of body.topics) {
        expect(Object.keys(t).sort()).toEqual(
          [
            'id',
            'session_time',
            'duration_sec',
            'topic_level',
            'summary',
            'ordinal',
            'created_at_utc',
          ].sort(),
        );
      }

      // Hub state matches the response exactly — no orphans, no stragglers.
      expect(currentTopics(s)).toEqual(body.topics);

      // Full page coverage is part of what this 200 proves (topic-generate-
      // paged-transcript D6): the turn registers the run's word snapshot, so a
      // fixture that created these topics WITHOUT paging the transcript to its
      // last page would have taken the 502-and-restore branch instead. And the
      // transcript really did span MULTIPLE pages, so the 200 exercises the
      // fixture's continuation-marker loop (and therefore the marker text the
      // server emits) end to end, rather than the degenerate single-page case.
      expect(fixturePagesRead(s)).toBeGreaterThan(1);

      // The spawned argv withholds list_topics (D3's crash-safe-swap mechanism).
      const argv = recordedArgv(s);
      const i = argv.indexOf('--allowedTools');
      expect(i).toBeGreaterThanOrEqual(0);
      const allowed = argv[i + 1].split(',');
      expect(allowed).toContain('mcp__autologger__get_transcript_words');
      expect(allowed).toContain('mcp__autologger__create_topic');
      expect(allowed).not.toContain('mcp__autologger__list_topics');

      // The slot is released once the turn completes.
      expect(aiChatTurns.isSessionInFlight(s)).toBe(false);
    },
  );

  it(
    'configured + transcript + CLI failure (partial-new state): 502 with a FIXED detail, and the ' +
      'prior topics are BYTE-FOR-BYTE unchanged — deleteTopics(newIds) removes only the topics THIS ' +
      'run created, proven against real create_topic calls made before the failure',
    async () => {
      const s = newSession();
      seedTranscript(s);
      const oldA = seedTopic(s, 'Old topic A');
      const oldB = seedTopic(s, 'Old topic B');
      const preRunSnapshot = currentTopics(s);
      expect(preRunSnapshot).toHaveLength(2);

      const res = await generateReq(s, claudeConfiguredEnv(REAL_PARTIAL_FAIL_FIXTURE));
      expect(res.status).toBe(502);
      const body = (await res.json()) as { detail: string };
      // Fixed, handler-owned detail — never the CLI's raw outcome token.
      expect(body.detail).toBe(TOPIC_GENERATE_FAILURE_DETAIL);
      expect(body.detail).not.toMatch(/upstream-failed|CLI|claude/i);

      // The prior topics are EXACTLY what they were before the request — same
      // ids, ordinals, summaries, created_at_utc — never modified.
      const after = currentTopics(s);
      expect(after).toEqual(preRunSnapshot);
      expect(after.map((t) => t.id).sort()).toEqual([oldA.id, oldB.id].sort());

      // The topics THIS run created for real (fake-claude-topics-partial-fail.mjs
      // creates 2 via genuine create_topic calls before exiting non-zero) are
      // GONE — deleteTopics(newIds) removed exactly the run's new topics, not
      // the prior ones.
      expect(after.map((t) => t.summary)).not.toContain('Partial fixture topic 0');
      expect(after.map((t) => t.summary)).not.toContain('Partial fixture topic 1');
      expect(after).toHaveLength(2); // no orphans left behind.

      expect(aiChatTurns.isSessionInFlight(s)).toBe(false);
    },
  );

  it(
    'configured + transcript + zero-topics-created (CLI reports success but creates nothing): ' +
      '502, prior topics intact — the simulated fake-claude.mjs success stream never makes a real ' +
      'MCP call, so newIds.length === 0 even though outcome.ok is true',
    async () => {
      const s = newSession();
      seedTranscript(s);
      const old = seedTopic(s, 'Only old topic');
      const preRunSnapshot = currentTopics(s);

      const res = await generateReq(s, claudeConfiguredEnv(SUCCESS_STREAM_FIXTURE));
      expect(res.status).toBe(502);
      const body = (await res.json()) as { detail: string };
      expect(body.detail).toBe(TOPIC_GENERATE_FAILURE_DETAIL);

      const after = currentTopics(s);
      expect(after).toEqual(preRunSnapshot);
      expect(after.map((t) => t.id)).toEqual([old.id]);
    },
  );

  it('transcribe.csv stays frozen 503 even on a fully configured deployment', async () => {
    const s = newSession();
    const res = await app.request(
      `/api/sessions/${s}/transcribe.csv`,
      { method: 'GET' },
      claudeConfiguredEnv(SUCCESS_STREAM_FIXTURE),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      detail: 'Transcription is unavailable on this deployment.',
    });
  });
});

// ── topics/generate — the page-coverage gate on the crash-safe swap ────────
// (topic-generate-paged-transcript task 2.2, design D6.)
//
// Frozen-surface self-check: this suite asserts only statuses already in the
// route's authorized matrix — 200 {topics} and 502 {detail} with the SAME
// fixed detail string every other failure cause returns. The gate is a new
// internal CAUSE for the existing failure mapping; no new status, shape, or
// header.
//
// The turn is stubbed at the `generateTopicsTurn` module export (`vi.spyOn`,
// the technique ai.int.test.ts uses for `driveAiTurn` — it intercepts through
// the shared `app` singleton, where a hoisted `vi.mock` would not): the real
// turn now always registers a word snapshot (task 3.1), but a hermetic fixture
// can only exercise the coverage values its own transcript produces, so the
// stub is what enumerates the interesting partial-coverage combinations.
// The stub creates its topics through the SAME registry the route reads, so
// the swap/restore assertions below run against genuine rows. The unstubbed
// full-coverage path is covered above by `fake-claude-topics-success.mjs`,
// which pages the transcript to its last page for real.
describe('topics/generate — page-coverage gate on the crash-safe swap', () => {
  const FAILURE_DETAIL = 'Topic generation failed.';
  const CLI = fileURLToPath(new URL('../test/fixtures/fake-claude.mjs', import.meta.url));

  let spy: ReturnType<typeof vi.spyOn> | null = null;

  afterEach(() => {
    spy?.mockRestore();
    spy = null;
    aiChatTurns.reset();
  });

  /** Replace the CLI turn with one that really inserts `count` topics and then
   * reports the given page coverage. */
  function stubTurn(pageCoverage: { totalPages: number; servedPages: number }, count = 2): void {
    spy = vi
      .spyOn(topicGenerateModule, 'generateTopicsTurn')
      .mockImplementation(async (opts: Parameters<typeof generateTopicsTurn>[0]) => {
        for (let i = 0; i < count; i += 1) {
          opts.registry.get(opts.sessionId).insertTopic({
            session_time: `00:00:0${i}`,
            duration_sec: 1,
            topic_level: 1,
            summary: `Fresh stub topic ${i}`,
          });
        }
        return { ok: true, claudeSessionId: 'stub-session', createdEvents: 0, pageCoverage };
      }) as unknown as ReturnType<typeof vi.spyOn>;
  }

  function seedForGenerate(): { sessionId: string; priorIds: string[] } {
    const sessionId = seededSession().sessionId;
    const hub = env.ports.sessions.get(sessionId);
    hub.insertTranscriptWord({ session_time: '00:00:01', speaker: 'Host', word: 'hello' });
    const priorIds = ['Old topic A', 'Old topic B'].map(
      (summary) =>
        hub.insertTopic({ session_time: '00:00:00', duration_sec: 10, topic_level: 1, summary }).id,
    );
    return { sessionId, priorIds };
  }

  const generateReq = async (sessionId: string): Promise<Response> =>
    app.request(
      `/api/sessions/${sessionId}/topics/generate`,
      { method: 'POST' },
      envWith({ CLAUDE_CLI_PATH: CLI, HOST: '127.0.0.1', REQUIRE_LOGIN: '0' }),
    );

  // Every strict subset of the snapshot's pages, including the two the gate
  // exists for: the page-0-only prefix read (the motivating hazard) and the
  // all-but-last read (the one a "did it fetch more than one page?" check
  // would wave through).
  const partials: Array<[string, { totalPages: number; servedPages: number }]> = [
    ['page 0 only, of 4', { totalPages: 4, servedPages: 1 }],
    ['all pages but the last', { totalPages: 4, servedPages: 3 }],
    ['no page at all', { totalPages: 2, servedPages: 0 }],
  ];

  for (const [label, pageCoverage] of partials) {
    it(`${label}: 502 with the existing detail, prior topics byte-for-byte intact, fresh rows removed`, async () => {
      const { sessionId, priorIds } = seedForGenerate();
      const before = env.ports.sessions.get(sessionId).listTopics();
      stubTurn(pageCoverage);

      const res = await generateReq(sessionId);
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ detail: FAILURE_DETAIL });

      // The prior set is EXACTLY what it was — same ids, ordinals, timestamps.
      const after = env.ports.sessions.get(sessionId).listTopics();
      expect(after).toEqual(before);
      expect(after.map((t) => t.id)).toEqual(priorIds);
      // …and the run's own rows are gone, not orphaned alongside them.
      expect(after.map((t) => t.summary)).not.toContain('Fresh stub topic 0');
      expect(aiChatTurns.isSessionInFlight(sessionId)).toBe(false);
    });
  }

  it('every page served: 200 {topics} — the prior set is replaced by the fresh one', async () => {
    const { sessionId, priorIds } = seedForGenerate();
    stubTurn({ totalPages: 4, servedPages: 4 });

    const res = await generateReq(sessionId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { topics: Array<{ id: string; summary: string }> };
    expect(body.topics.map((t) => t.summary)).toEqual(['Fresh stub topic 0', 'Fresh stub topic 1']);
    for (const id of priorIds) expect(body.topics.map((t) => t.id)).not.toContain(id);
    expect(env.ports.sessions.get(sessionId).listTopics()).toEqual(body.topics);
  });

  it('a turn with NO word snapshot (zero-of-zero) still replaces — chat/topic turns are unaffected', async () => {
    // The pre-task-3.1 production shape, and the permanent shape of any turn
    // whose registration carries no snapshot: no coverage claim ⇒ the gate
    // cannot fail the run. (The real-fixture success test above exercises the
    // same property end to end, through a genuine CLI turn.)
    const { sessionId } = seedForGenerate();
    stubTurn({ totalPages: 0, servedPages: 0 });

    const res = await generateReq(sessionId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { topics: Array<{ summary: string }> };
    expect(body.topics.map((t) => t.summary)).toEqual(['Fresh stub topic 0', 'Fresh stub topic 1']);
  });

  it('coverage complete but ZERO topics created: still the existing 502 + restore', async () => {
    const { sessionId } = seedForGenerate();
    const before = env.ports.sessions.get(sessionId).listTopics();
    stubTurn({ totalPages: 2, servedPages: 2 }, 0);

    const res = await generateReq(sessionId);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ detail: FAILURE_DETAIL });
    expect(env.ports.sessions.get(sessionId).listTopics()).toEqual(before);
  });
});

describe('transcript-words CRUD', () => {
  it('create → list → patch → delete', async () => {
    const s = seededSession().sessionId;
    const create = await app.request(
      `/api/sessions/${s}/transcript-words`,
      { method: 'POST', headers: J, body: JSON.stringify({ speaker: 'Host', word: 'hello' }) },
      { ...env },
    );
    expect(create.status).toBe(201);
    const wordId = ((await create.json()) as { id: string }).id;

    const list = await app.request(
      `/api/sessions/${s}/transcript-words`,
      { method: 'GET' },
      { ...env },
    );
    expect(((await list.json()) as { words: unknown[] }).words.length).toBe(1);

    const patch = await app.request(
      `/api/sessions/${s}/transcript-words/${wordId}`,
      { method: 'PATCH', headers: J, body: JSON.stringify({ word: 'world' }) },
      { ...env },
    );
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { word: string }).word).toBe('world');

    const del = await app.request(
      `/api/sessions/${s}/transcript-words/${wordId}`,
      { method: 'DELETE' },
      { ...env },
    );
    expect(del.status).toBe(204);
  });

  it('404 patching an unknown word', async () => {
    const s = seededSession().sessionId;
    const res = await app.request(
      `/api/sessions/${s}/transcript-words/nope`,
      { method: 'PATCH', headers: J, body: JSON.stringify({ word: 'x' }) },
      { ...env },
    );
    expect(res.status).toBe(404);
  });
});

describe('topics CRUD', () => {
  it('create → list → patch → delete', async () => {
    const s = seededSession().sessionId;
    const create = await app.request(
      `/api/sessions/${s}/topics`,
      { method: 'POST', headers: J, body: JSON.stringify({ summary: 'Intro', topic_level: 1 }) },
      { ...env },
    );
    expect(create.status).toBe(201);
    const topicId = ((await create.json()) as { id: string }).id;

    const list = await app.request(`/api/sessions/${s}/topics`, { method: 'GET' }, { ...env });
    expect(((await list.json()) as { topics: unknown[] }).topics.length).toBe(1);

    const patch = await app.request(
      `/api/sessions/${s}/topics/${topicId}`,
      { method: 'PATCH', headers: J, body: JSON.stringify({ summary: 'Outro' }) },
      { ...env },
    );
    expect(patch.status).toBe(200);

    const del = await app.request(
      `/api/sessions/${s}/topics/${topicId}`,
      { method: 'DELETE' },
      { ...env },
    );
    expect(del.status).toBe(204);
  });

  it('404 deleting an unknown topic', async () => {
    const s = seededSession().sessionId;
    const res = await app.request(
      `/api/sessions/${s}/topics/nope`,
      { method: 'DELETE' },
      { ...env },
    );
    expect(res.status).toBe(404);
  });
});

// ── Transcript generation (deepgram-transcription) ──────────────────────────

const FIXTURES = join(TRANSCRIPTION_FIXTURES_DIR, 'audio');
const SEG1 = join(FIXTURES, 'seg1.webm');
const CORRUPT = join(FIXTURES, 'seg-corrupt.bin');

function deepgramResponse(words: unknown[]) {
  return { results: { channels: [{ alternatives: [{ words }] }] } };
}

function deepgramConfiguredEnv(overrides: Record<string, unknown> = {}) {
  return envWith({ DEEPGRAM_API_KEY: 'test-deepgram-key', DEEPGRAM_MODEL: 'nova-3', ...overrides });
}

async function uploadSegment(
  sessionId: string,
  filePath: string,
  opts: { mime?: string; recordingOrdinal?: number } = {},
): Promise<void> {
  const bytes = readFileSync(filePath);
  const qs = opts.recordingOrdinal ? `?recording_ordinal=${opts.recordingOrdinal}` : '';
  const res = await app.request(
    `/api/sessions/${sessionId}/audio/segments${qs}`,
    { method: 'POST', headers: { 'content-type': opts.mime ?? 'audio/webm' }, body: bytes },
    { ...env },
  );
  expect(res.status).toBe(200);
}

async function logRecordingStarted(sessionId: string, ordinal: number): Promise<void> {
  const res = await app.request(
    `/api/sessions/${sessionId}/events`,
    {
      method: 'POST',
      headers: J,
      body: JSON.stringify({
        category: 'internal',
        message: `Recording ${ordinal} Started`,
        metadata: {},
      }),
    },
    { ...env },
  );
  expect(res.status).toBe(200);
}

async function addManualWord(sessionId: string, word: string): Promise<void> {
  const res = await app.request(
    `/api/sessions/${sessionId}/transcript-words`,
    { method: 'POST', headers: J, body: JSON.stringify({ speaker: 'Manual', word }) },
    { ...env },
  );
  expect(res.status).toBe(201);
}

async function listWords(sessionId: string): Promise<Array<{ word: string }>> {
  const res = await app.request(
    `/api/sessions/${sessionId}/transcript-words`,
    { method: 'GET' },
    { ...env },
  );
  return ((await res.json()) as { words: Array<{ word: string }> }).words;
}

function generate(
  sessionId: string,
  init: RequestInit = {},
  envOverride = deepgramConfiguredEnv(),
) {
  return app.request(
    `/api/sessions/${sessionId}/transcript-words/generate`,
    { method: 'POST', ...init },
    envOverride,
  );
}

describe('transcript generation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    transcriptGenerationLock.reset();
  });

  it('200 {words}: session_time/speaker strings, start_sec/end_sec, contiguous ordinals, ordinal order', async () => {
    const s = seededSession().sessionId;
    await logRecordingStarted(s, 1);
    await uploadSegment(s, SEG1, { recordingOrdinal: 1 });

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              deepgramResponse([
                { word: 'hello', punctuated_word: 'Hello,', start: 0.5, end: 0.9, speaker: 0 },
                { word: 'world', start: 1.0, end: 1.4, speaker: 1 },
              ]),
            ),
            { status: 200 },
          ),
      ),
    );

    const res = await generate(s);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      words: Array<{
        word: string;
        speaker: string;
        session_time: string;
        start_sec: number;
        end_sec: number;
        ordinal: number;
        session_id: string;
      }>;
    };
    expect(body.words).toHaveLength(2);
    expect(body.words[0].word).toBe('Hello,');
    expect(body.words[0].speaker).toBe('0');
    expect(body.words[1].word).toBe('world');
    expect(body.words[1].speaker).toBe('1');
    for (const w of body.words) {
      expect(typeof w.session_time).toBe('string');
      expect(w.session_time.length).toBeGreaterThan(0);
      expect(w.session_id).toBe(s);
    }
    expect(body.words[0].start_sec).toBeCloseTo(0.5, 1);
    expect(body.words[1].start_sec).toBeCloseTo(1.0, 1);
    // Contiguous ordinals from 0, and the array is already in ordinal order.
    expect(body.words.map((w) => w.ordinal)).toEqual([0, 1]);
  });

  it('400 no-audio: a session with zero audio segments', async () => {
    const s = seededSession().sessionId;
    const res = await generate(s);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toMatch(/no.*audio/i);
  });

  it('400 all-unreadable: segments exist but none is readable (distinct detail from no-audio)', async () => {
    const s = seededSession().sessionId;
    await uploadSegment(s, CORRUPT);

    const res = await generate(s);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: string };

    const noAudioRes = await generate(seededSession().sessionId);
    const noAudioBody = (await noAudioRes.json()) as { detail: string };
    expect(body.detail).not.toBe(noAudioBody.detail);
  });

  it('400 zero-word result does not wipe the transcript (gate decision 2)', async () => {
    const s = seededSession().sessionId;
    await uploadSegment(s, SEG1);
    await addManualWord(s, 'existing');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(deepgramResponse([])), { status: 200 })),
    );

    const res = await generate(s);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toMatch(/speech/i);

    const words = await listWords(s);
    expect(words.map((w) => w.word)).toEqual(['existing']);
  });

  it('abandons the run without provider spend when the request is already aborted', async () => {
    const s = seededSession().sessionId;
    await uploadSegment(s, SEG1);

    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(deepgramResponse([])), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    controller.abort();

    const res = await generate(s, { signal: controller.signal });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toMatch(/aborted/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('409 concurrent: a second run is rejected with no additional provider spend', async () => {
    const s = seededSession().sessionId;
    await uploadSegment(s, SEG1);

    const release: { fn: (() => void) | null } = { fn: null };
    const fetchMock = vi.fn(async () => {
      const gate = new Promise<void>((resolve) => {
        release.fn = resolve;
      });
      await gate;
      return new Response(
        JSON.stringify(deepgramResponse([{ word: 'hi', start: 0, end: 0.2, speaker: 0 }])),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const firstReq = generate(s);
    // Poll until the provider call has actually started (single-flight lock held).
    while (fetchMock.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const secondRes = await generate(s);
    expect(secondRes.status).toBe(409);
    const secondBody = (await secondRes.json()) as { detail: string };
    expect(secondBody.detail).toContain('Test Session');
    expect(fetchMock).toHaveBeenCalledTimes(1); // second made no provider request

    release.fn?.();
    const firstRes = await firstReq;
    expect(firstRes.status).toBe(200);
  });

  it('a failed run releases the process-wide lock on its own — no manual reset needed', async () => {
    // Guards the `finally` in generateTranscriptWords: every other failure-path
    // test here is followed by this suite's unconditional afterEach reset, so
    // dropping that `finally` would wedge the lock without failing any of them.
    // This test asserts release BEFORE any reset runs.
    const s = seededSession().sessionId;
    // Zero audio segments → the run fails (400 no_audio) AFTER acquiring the
    // process-wide slot.
    const res = await generate(s);
    expect(res.status).toBe(400);

    // WITHOUT any reset: the slot must already be free, and a fresh
    // acquisition must succeed.
    expect(transcriptGenerationLock.getLock()).toBeNull();
    expect(transcriptGenerationLock.tryAcquire('probe-session')).toBe(true);
    transcriptGenerationLock.release();
  });

  it('409 concurrent: the enriched detail is redacted for a logged-in non-member of the holding session’s studio', async () => {
    // Holder: a session in a studio the requester does NOT belong to.
    const holderStudio = seedStudio();
    const holderShow = seedShow({ studioId: holderStudio });
    const holderSession = seedSession({ showId: holderShow, title: 'Foreign Holder Title' });
    expect(transcriptGenerationLock.tryAcquire(holderSession, 1_700_000_000_000)).toBe(true);

    // Requester: member of their own session's studio only.
    const myStudio = seedStudio();
    const myShow = seedShow({ studioId: myStudio });
    const mySession = seedSession({ showId: myShow });
    const cookie = await loginCookie(seedUser({ studios: [myStudio] }));

    const res = await generate(
      mySession,
      { headers: { Cookie: cookie } },
      deepgramConfiguredEnv({ REQUIRE_LOGIN: '1' }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { detail: string };
    // The identifier-free generic detail — never the holder's id or title.
    expect(body.detail).toBe(
      'A transcript generation run is already in progress on this deployment; try again once it completes.',
    );
    expect(body.detail).not.toContain(holderSession);
    expect(body.detail).not.toContain('Foreign Holder Title');
  });

  it('409 concurrent: a logged-in member of the holding session’s studio keeps the enriched detail', async () => {
    const holderStudio = seedStudio();
    const holderShow = seedShow({ studioId: holderStudio });
    const holderSession = seedSession({ showId: holderShow, title: 'Visible Holder Title' });
    expect(transcriptGenerationLock.tryAcquire(holderSession, 1_700_000_000_000)).toBe(true);

    // Requester: member of BOTH studios — their own (to pass requireSession)
    // and the holder's (to see its identifiers).
    const myStudio = seedStudio();
    const myShow = seedShow({ studioId: myStudio });
    const mySession = seedSession({ showId: myShow });
    const cookie = await loginCookie(seedUser({ studios: [myStudio, holderStudio] }));

    const res = await generate(
      mySession,
      { headers: { Cookie: cookie } },
      deepgramConfiguredEnv({ REQUIRE_LOGIN: '1' }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain('Visible Holder Title');
  });

  it('502 upstream failure preserves existing words', async () => {
    const s = seededSession().sessionId;
    await uploadSegment(s, SEG1);
    await addManualWord(s, 'existing');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('server error', { status: 500 })),
    );

    const res = await generate(s);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).not.toContain('test-deepgram-key');

    const words = await listWords(s);
    expect(words.map((w) => w.word)).toEqual(['existing']);
  });

  // ── Task 4.5: cross-package `instanceof` pin (design D6, spec "Every
  // newly cross-boundary error class is pinned") ──────────────────────────
  //
  // `TranscriptGenerateError` is now defined in `@autologger/transcription`;
  // `routers/transcribe.ts:59` (`mapGenerateError`) and `:157` (the
  // in-flight cross-tenant redaction check) both still match it with
  // `instanceof`. That branch is sound only because the workspace resolves
  // `@autologger/transcription` to a single copy of the module —
  // cross-realm `instanceof` on a dual-loaded class silently fails, which is
  // exactly the failure mode a unit test that imports
  // `TranscriptGenerateError` and throws it directly cannot exercise (it
  // never crosses the package boundary the router does at runtime). Both
  // tests below drive the real app end to end — real mocked-`fetch`
  // DeepGram failure / real process-wide lock contention -> real
  // `TranscriptGenerateError` thrown inside the package -> real router
  // `catch` — so the router's own `instanceof` sites actually run, following
  // `routers/flows.int.test.ts`'s "416 for a suffix Range against a
  // zero-byte blob" shape (a real cross-package `InvalidRangeError` pinned
  // through the app, not a unit-level throw).
  describe('cross-package instanceof pin: TranscriptGenerateError -> {502,409} through the real app (task 4.5, design D6)', () => {
    it('an "upstream" TranscriptGenerateError matches :157 (false) then :59 (true) -> exact frozen 502 {detail}', async () => {
      const s = seededSession().sessionId;
      await uploadSegment(s, SEG1);

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('server error', { status: 500 })),
      );

      const res = await generate(s);
      expect(res.status).toBe(502);
      // Exact (not regex/substring) match on the package's own
      // UPSTREAM_FAILURE_DETAIL constant: proves this body came from the
      // router's `instanceof TranscriptGenerateError` branch at :59, not
      // some other 502-producing path.
      expect(await res.json()).toEqual({ detail: 'DeepGram transcription failed or timed out.' });
    });

    it('an "in_flight" TranscriptGenerateError matches :157 (true) then, for a visible holder, falls through to :59 (true) -> exact frozen 409 {detail}', async () => {
      const holderStudio = seedStudio();
      const holderShow = seedShow({ studioId: holderStudio });
      const holderSession = seedSession({ showId: holderShow, title: 'Instanceof Pin Holder' });
      expect(transcriptGenerationLock.tryAcquire(holderSession, 1_700_000_000_000)).toBe(true);

      const myStudio = seedStudio();
      const myShow = seedShow({ studioId: myStudio });
      const mySession = seedSession({ showId: myShow });
      const cookie = await loginCookie(seedUser({ studios: [myStudio, holderStudio] }));

      const res = await generate(
        mySession,
        { headers: { Cookie: cookie } },
        deepgramConfiguredEnv({ REQUIRE_LOGIN: '1' }),
      );
      expect(res.status).toBe(409);
      // Exact match on the package's `generationInFlightDetail(...)` output
      // (deterministic: fixed lock timestamp + seeded holder title) proves
      // the redacted-vs-visible branch at :157 matched the real thrown
      // instance, then `mapGenerateError`'s own `instanceof` at :59 mapped
      // `code: 'in_flight'` to 409 using the class's own `.message`.
      expect(await res.json()).toEqual({
        detail:
          'A transcript generation run is already in progress for session "Instanceof Pin Holder" ' +
          '(started 2023-11-14T22:13:20.000Z); try again once it completes.',
      });
    });
  });

  // ── Enrichment persistence (persist-deepgram-enrichment, task 4.1) ──────

  function deepgramEnrichmentFixture(): unknown {
    return JSON.parse(
      readFileSync(join(TRANSCRIPTION_FIXTURES_DIR, 'deepgram-enrichment-response.json'), 'utf8'),
    );
  }

  function stubFetchWithFixture(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(deepgramEnrichmentFixture()), { status: 200 })),
    );
  }

  it('persists real-fixture enrichment and reads it back in ordinal order (anchored)', async () => {
    const s = seededSession().sessionId;
    await logRecordingStarted(s, 1);
    await uploadSegment(s, SEG1, { recordingOrdinal: 1 });
    stubFetchWithFixture();

    const res = await generate(s);
    expect(res.status).toBe(200);

    const enrichment = env.ports.sessions.get(s).listTranscriptEnrichment();
    expect(enrichment.paragraphs).toHaveLength(3);
    expect(enrichment.sentiment).toHaveLength(3);
    // Anchored (recording-start anchor resolved) — real timeline positions,
    // never the never-zeros-as-data NULL, and non-decreasing (ordinal order
    // is anchored-by-start_sec-ascending for this single-group, all-anchored
    // case).
    for (const p of enrichment.paragraphs) {
      expect(typeof p.start_sec).toBe('number');
      expect(typeof p.end_sec).toBe('number');
      expect(p.end_sec).toBeGreaterThanOrEqual(p.start_sec as number);
      expect(p.text.length).toBeGreaterThan(0);
    }
    for (const seg of enrichment.sentiment) {
      expect(typeof seg.start_sec).toBe('number');
      expect(typeof seg.end_sec).toBe('number');
      expect(seg.sentiment.length).toBeGreaterThan(0);
    }
    const paraStarts = enrichment.paragraphs.map((p) => p.start_sec as number);
    expect(paraStarts).toEqual([...paraStarts].sort((a, b) => a - b));
    const sentStarts = enrichment.sentiment.map((seg) => seg.start_sec as number);
    expect(sentStarts).toEqual([...sentStarts].sort((a, b) => a - b));
  });

  it('anchorless-group enrichment reads back with NULL start/end, not zeros', async () => {
    const s = seededSession().sessionId;
    // No "Recording N Started" event logged — the segment's group resolves
    // no recording-start anchor (3-step chain step 3: anchorless).
    await uploadSegment(s, SEG1);
    stubFetchWithFixture();

    const res = await generate(s);
    expect(res.status).toBe(200);

    const enrichment = env.ports.sessions.get(s).listTranscriptEnrichment();
    expect(enrichment.paragraphs.length).toBeGreaterThan(0);
    expect(enrichment.sentiment.length).toBeGreaterThan(0);
    for (const p of enrichment.paragraphs) {
      expect(p.start_sec).toBeNull();
      expect(p.end_sec).toBeNull();
    }
    for (const seg of enrichment.sentiment) {
      expect(seg.start_sec).toBeNull();
      expect(seg.end_sec).toBeNull();
    }
  });

  it('a never-generated session reads listTranscriptEnrichment as empty arrays', async () => {
    const s = seededSession().sessionId;
    expect(env.ports.sessions.get(s).listTranscriptEnrichment()).toEqual({
      paragraphs: [],
      sentiment: [],
    });
  });

  it('GET transcript-words shape is unchanged after enrichment is persisted', async () => {
    const s = seededSession().sessionId;
    await logRecordingStarted(s, 1);
    await uploadSegment(s, SEG1, { recordingOrdinal: 1 });
    stubFetchWithFixture();

    const genRes = await generate(s);
    expect(genRes.status).toBe(200);

    const res = await app.request(
      `/api/sessions/${s}/transcript-words`,
      { method: 'GET' },
      { ...env },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { words: Array<Record<string, unknown>> };
    expect(body.words.length).toBeGreaterThan(0);
    for (const w of body.words) {
      expect(Object.keys(w).sort()).toEqual(
        [
          'created_at_utc',
          'end_sec',
          'id',
          'ordinal',
          'session_id',
          'session_time',
          'speaker',
          'start_sec',
          'word',
        ].sort(),
      );
    }
  });

  it('no transcript-enrichment HTTP route exists (in-process read only, design D5)', async () => {
    const s = seededSession().sessionId;
    const res = await app.request(
      `/api/sessions/${s}/transcript-enrichment`,
      { method: 'GET' },
      { ...env },
    );
    expect(res.status).toBe(404);
  });

  it('replace-on-rerun: a successful run replaces prior words atomically', async () => {
    const s = seededSession().sessionId;
    await uploadSegment(s, SEG1);
    await addManualWord(s, 'stale');

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(deepgramResponse([{ word: 'fresh', start: 0, end: 0.3, speaker: 0 }])),
            { status: 200 },
          ),
      ),
    );

    const res = await generate(s);
    expect(res.status).toBe(200);

    const words = await listWords(s);
    expect(words.map((w) => w.word)).toEqual(['fresh']);
  });
});

describe('transcript generation lock status', () => {
  afterEach(() => {
    transcriptGenerationLock.reset();
  });

  async function status() {
    return app.request('/api/transcript-generation/status', { method: 'GET' }, { ...env });
  }

  it('idle: returns in_flight false with no busy-only fields', async () => {
    const res = await status();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ in_flight: false });
  });

  it('busy: names the holder with catalog title and started_at', async () => {
    const { sessionId } = seededSession();
    const title = String(catalogFor().sessions.getSessionIndexRow(sessionId)?.title ?? '');
    const startedAtMs = 1_700_000_000_000;
    expect(transcriptGenerationLock.tryAcquire(sessionId, startedAtMs)).toBe(true);

    const res = await status();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      in_flight: true,
      session_id: sessionId,
      session_title: title,
      started_at: new Date(startedAtMs).toISOString(),
    });
  });

  it('busy with missing catalog row: session_title is null', async () => {
    const ghostId = 'ghost-session-no-row';
    const startedAtMs = 1_700_000_000_000;
    expect(transcriptGenerationLock.tryAcquire(ghostId, startedAtMs)).toBe(true);

    const res = await status();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      in_flight: true,
      session_id: ghostId,
      session_title: null,
      started_at: new Date(startedAtMs).toISOString(),
    });
  });

  // ── Cross-tenant redaction (pr-3-review) — the lock is process-wide, so the
  // holder can belong to a studio the requester is not a member of. Sibling
  // routes close the existence/title oracle by 404ing non-members; here
  // busy-ness stays truthful but the identifiers are nulled (same key set,
  // null values). The anonymous `busy:` test above pins the dev-mode
  // (REQUIRE_LOGIN=0, user === null) full-detail behavior.

  it('busy for a logged-in NON-member of the holder’s studio: identifiers are null, busy-ness truthful', async () => {
    const holderStudio = seedStudio();
    const holderShow = seedShow({ studioId: holderStudio });
    const holderSession = seedSession({ showId: holderShow, title: 'Foreign Holder Title' });
    const startedAtMs = 1_700_000_000_000;
    expect(transcriptGenerationLock.tryAcquire(holderSession, startedAtMs)).toBe(true);

    const otherStudio = seedStudio();
    const cookie = await loginCookie(seedUser({ studios: [otherStudio] }));

    const res = await app.request(
      '/api/transcript-generation/status',
      { method: 'GET', headers: { Cookie: cookie } },
      envWith({ REQUIRE_LOGIN: '1' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      in_flight: true,
      session_id: null,
      session_title: null,
      started_at: new Date(startedAtMs).toISOString(),
    });
  });

  it('busy for a logged-in MEMBER of the holder’s studio: full identifiers', async () => {
    const holderStudio = seedStudio();
    const holderShow = seedShow({ studioId: holderStudio });
    const holderSession = seedSession({ showId: holderShow, title: 'Member-Visible Title' });
    const startedAtMs = 1_700_000_000_000;
    expect(transcriptGenerationLock.tryAcquire(holderSession, startedAtMs)).toBe(true);

    const cookie = await loginCookie(seedUser({ studios: [holderStudio] }));

    const res = await app.request(
      '/api/transcript-generation/status',
      { method: 'GET', headers: { Cookie: cookie } },
      envWith({ REQUIRE_LOGIN: '1' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      in_flight: true,
      session_id: holderSession,
      session_title: 'Member-Visible Title',
      started_at: new Date(startedAtMs).toISOString(),
    });
  });
});
