// async-session-hub (ADR 0021 slice 7a) design D10, tasks 1.2 and 6.1 — a mixed concurrent load on
// one session, before and after the hub goes async. A real listening @hono/node-ws server (the
// companion-ws.int.test.ts setup) with one session WebSocket open; 200 concurrent HTTP requests:
// event adds, updates and deletes of distinct seeded events, transport start/stop, GET events and
// GET status, and one POST events/generate through the fake CLI events.generate.int.test.ts uses.
// Asserted: each response's status (the one any serial order gives, since no two requests touch one
// event), `event.changed` revisions strictly increasing with the last equal to the final
// `events_stream_revision`, and the final event set. Characterizes today, so it is written green.
//
// Group 5 adds the conflicting pairs of design D10: each read-then-write pair that became one hub
// method, fired together through the in-process app (`Promise.all`, so both handlers start in one
// tick), and each asserting a result some serial order gives. Whether a pair actually splits over
// HTTP depends on when its catalog replies resolve; SessionHub.concurrency.test.ts forces the split.

import { readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiChatTurns } from '@autologger/ai-runtime/aiChatRegistry';
import { stableSessionCwd } from '@autologger/ai-runtime/aiChatRunner';
import { __resetAiMcpListenerForTests } from '@autologger/ai-runtime/aiMcpServer';
import { clearLogImportJobs } from '@autologger/log-import';
import { TRANSCRIPTION_FIXTURES_DIR, transcriptGenerationLock } from '@autologger/transcription';
import { type ServerType, serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import ExcelJS from 'exceljs';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { wireApp } from '../app';
import type { AppEnv } from '../appEnv';
import { app, defaultUser, env, envWith } from '../test/harness';
import {
  COMPANION_BEARER,
  seededSession,
  seedMemberStudio,
  seedSession,
  seedShow,
  setCompanionPresence,
} from '../test/helpers';
import { harnessHub } from '../test/session/sessionRows';

const EVENTS_SUCCESS_FIXTURE = fileURLToPath(
  new URL('../test/fixtures/fake-claude-events-success.mjs', import.meta.url),
);

/** The generate suite's show: `cam` without an instruction, `slate` with one (the fixture's
 * create_event calls name `slate`). */
const CATEGORIES_JSON = JSON.stringify([
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
    auto_instruction: 'Log every slate: someone says "slate" or claps the sticks.',
  },
]);

const SEEDED = 80; // 0..39 updated, 40..79 deleted
const ADDS = 60;
const TRANSPORT = 20; // alternating start/stop
const LIST_GETS = 20;
const STATUS_GETS = 19; // + 1 generate = 200 requests

let server: ServerType;
let port: number;
const seededIds: string[] = [];

beforeAll(async () => {
  const app = new Hono<AppEnv>();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  // The generate route needs the CLI configured on a loopback host; the other routes ignore both.
  wireApp(app, upgradeWebSocket, {
    bindings: envWith({ CLAUDE_CLI_PATH: EVENTS_SUCCESS_FIXTURE, HOST: '127.0.0.1' }),
  });
  port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) =>
      resolve(info.port),
    );
    injectWebSocket(server);
  });
});

afterAll(() => server.close());

beforeEach(async () => {
  aiChatTurns.reset();
  await __resetAiMcpListenerForTests();
});

afterEach(async () => {
  aiChatTurns.reset();
  await __resetAiMcpListenerForTests();
  for (const id of seededIds.splice(0)) {
    rmSync(stableSessionCwd(id), { recursive: true, force: true });
  }
});

interface EventRow {
  event_id: string;
  category: string;
  message: string;
}

async function call(
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text === '' ? null : JSON.parse(text) };
}

async function connect(
  sessionId: string,
  cookie: string,
): Promise<{ ws: WebSocket; frames: unknown[] }> {
  const frames: unknown[] = [];
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${sessionId}/ws`, {
      headers: { cookie },
    } as unknown as string[]);
    w.addEventListener('open', () => resolve(w));
    w.addEventListener('error', (e) => reject(e));
  });
  ws.addEventListener('message', (e) => {
    if (typeof e.data === 'string') frames.push(JSON.parse(e.data));
  });
  return { ws, frames };
}

describe('session hub under a mixed concurrent load (design D10)', () => {
  it('200 concurrent requests on one session: serial-order statuses, ordered event.changed revisions, the final event set', async () => {
    const { sessionId } = await seededSession({ categoriesJson: CATEGORIES_JSON });
    seededIds.push(sessionId);
    const { cookie } = await defaultUser();
    const base = `/api/sessions/${sessionId}`;

    // Seed: an anchored transcript and a manual slate event (the generate run's anchor), then 80
    // `cam` events through the route, one at a time.
    const hub = await harnessHub(sessionId);
    await hub.replaceTranscriptWords([
      { session_time: '00:00:01:00', speaker: 'A', word: 'roll', start_sec: 1, end_sec: 2 },
      { session_time: '00:00:03:00', speaker: 'A', word: 'slate', start_sec: 3, end_sec: 4 },
      { session_time: '00:00:05:00', speaker: 'B', word: 'marker', start_sec: 5, end_sec: 6 },
    ]);
    await hub.addEvent({
      category: 'slate',
      message: 'Pre-existing slate',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx: { frameRate: 24, startOffsetFrames: 0 },
      explicitAnchor: { timecodeTotalFrames: 24, wallTimeUtc: '2026-01-01T00:00:01.000Z' },
    });
    const seeded: string[] = [];
    for (let i = 0; i < SEEDED; i++) {
      const r = await call(cookie, 'POST', `${base}/events`, {
        category: 'cam',
        message: `seed-${i}`,
      });
      expect(r.status).toBe(200);
      seeded.push((r.json as EventRow).event_id);
    }

    const { ws, frames } = await connect(sessionId, cookie);
    const before = await call(cookie, 'GET', `${base}/status`);
    const startRevision = (before.json as { events_stream_revision: number })
      .events_stream_revision;

    // The load: 200 requests, interleaved by kind so every kind is in flight together.
    type Req = { kind: string; run: () => Promise<{ status: number; json: unknown }> };
    const lanes: Req[][] = [
      Array.from({ length: ADDS }, (_, i) => ({
        kind: 'add',
        run: () => call(cookie, 'POST', `${base}/events`, { category: 'cam', message: `add-${i}` }),
      })),
      Array.from({ length: SEEDED / 2 }, (_, i) => ({
        kind: 'update',
        run: () =>
          call(cookie, 'PUT', `${base}/events/${seeded[i]}`, {
            category: 'cam',
            message: `upd-${i}`,
            wall_time_utc: '2026-01-01T00:00:10.000Z',
            timecode_hms: '00:00:10',
          }),
      })),
      Array.from({ length: SEEDED / 2 }, (_, i) => ({
        kind: 'delete',
        run: () => call(cookie, 'DELETE', `${base}/events/${seeded[SEEDED / 2 + i]}`),
      })),
      Array.from({ length: TRANSPORT }, (_, i) => ({
        kind: 'transport',
        run: () => call(cookie, 'POST', `${base}/transport/${i % 2 === 0 ? 'start' : 'stop'}`),
      })),
      Array.from({ length: LIST_GETS }, () => ({
        kind: 'list',
        run: () => call(cookie, 'GET', `${base}/events`),
      })),
      Array.from({ length: STATUS_GETS }, () => ({
        kind: 'status',
        run: () => call(cookie, 'GET', `${base}/status`),
      })),
    ];
    const load: Req[] = [
      { kind: 'generate', run: () => call(cookie, 'POST', `${base}/events/generate`) },
    ];
    while (lanes.some((l) => l.length > 0)) {
      for (const lane of lanes) {
        const next = lane.shift();
        if (next) load.push(next);
      }
    }
    expect(load).toHaveLength(200);

    const results = await Promise.all(
      load.map(async (r) => ({ kind: r.kind, ...(await r.run()) })),
    );

    // Every request touches its own event (or none), so every serial order answers 200.
    for (const r of results)
      expect({ kind: r.kind, status: r.status }).toEqual({ kind: r.kind, status: 200 });
    expect(results.find((r) => r.kind === 'generate')?.json).toEqual({
      created: 3,
      cap_hit: false,
    });

    const after = await call(cookie, 'GET', `${base}/status`);
    const finalRevision = (after.json as { events_stream_revision: number }).events_stream_revision;

    // Frames: wait for the last committed revision to arrive, then check the order.
    const revisions = (): number[] =>
      frames
        .filter(
          (f): f is { type: string; revision: number } =>
            (f as { type?: string }).type === 'event.changed',
        )
        .map((f) => f.revision);
    const deadline = Date.now() + 5000;
    while (revisions().at(-1) !== finalRevision && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const revs = revisions();
    for (let i = 1; i < revs.length; i++) expect(revs[i]).toBeGreaterThan(revs[i - 1]);
    expect(revs.at(-1)).toBe(finalRevision);

    // The final event set.
    const list = await call(cookie, 'GET', `${base}/events?limit=2000`);
    const events = (list.json as { events: EventRow[] }).events;
    const byId = new Map(events.map((e) => [e.event_id, e]));
    for (let i = 0; i < SEEDED / 2; i++) {
      expect(byId.get(seeded[i])).toMatchObject({ category: 'cam', message: `upd-${i}` });
    }
    for (let i = SEEDED / 2; i < SEEDED; i++) expect(byId.has(seeded[i])).toBe(false);
    const messages = events.map((e) => `${e.category}:${e.message}`).sort();
    const expected = [
      ...Array.from({ length: SEEDED / 2 }, (_, i) => `cam:upd-${i}`),
      ...Array.from({ length: ADDS }, (_, i) => `cam:add-${i}`),
      'slate:Pre-existing slate',
      'slate:SLATE',
      'slate:SLATE',
      'slate:SLATE',
    ].sort();
    expect(messages).toEqual(expected);

    // Test-only data (design D10): how many of this session's hub calls had to wait for the lock.
    const lockWaits = (hub as unknown as { lockWaitCount?: number }).lockWaitCount;
    console.log(
      `[interleave] event.changed frames ${revs.length}; revisions ${startRevision} -> ${finalRevision}; ` +
        `final events ${events.length}; lock waits ${lockWaits ?? 'n/a'}`,
    );
    ws.close();
    // Every hub call is a Postgres round trip since session-tables (7b-1): under the full parallel
    // suite the 200 requests can outlast the 5 s default timeout (about 3 s alone).
  }, 30_000);
});

// ── Conflicting pairs (design D10, owner decision 1) ─────────────────────────────────────────────

const J = { 'content-type': 'application/json' };
const FAKE_AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00]);
const SEG1 = join(TRANSCRIPTION_FIXTURES_DIR, 'audio', 'seg1.webm');

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function localImport(sessionId: string, durationS = 5): Promise<Response> {
  return app.request(
    `/api/sessions/${sessionId}/local-audio-import?duration_s=${durationS}`,
    { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: FAKE_AUDIO },
    env,
  );
}

async function listEvents(
  sessionId: string,
): Promise<Array<{ event_id: string; category: string; message: string; metadata: unknown }>> {
  const res = await app.request(`/api/sessions/${sessionId}/events?limit=2000`, {}, env);
  expect(res.status).toBe(200);
  return (
    await json<{
      events: Array<{ event_id: string; category: string; message: string; metadata: unknown }>;
    }>(res)
  ).events;
}

describe('conflicting pairs fired together equal a serial order (design D10)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    transcriptGenerationLock.reset();
    clearLogImportJobs();
  });

  it('two Companion toggles from a stopped transport: one start and one stop, the transport ends stopped', async () => {
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s);
    const toggle = () =>
      app.request(
        '/api/companion/transport',
        {
          method: 'POST',
          headers: { ...J, ...COMPANION_BEARER },
          body: JSON.stringify({ action: 'toggle' }),
        },
        { ...env },
      );
    const [a, b] = await Promise.all([toggle(), toggle()]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const rolling = [
      (await json<{ is_rolling: boolean }>(a)).is_rolling,
      (await json<{ is_rolling: boolean }>(b)).is_rolling,
    ].sort();
    expect(rolling).toEqual([false, true]);
    const status = await json<{ is_rolling: boolean; current_take: number }>(
      await app.request(`/api/sessions/${s}/status`, {}, env),
    );
    expect(status).toMatchObject({ is_rolling: false, current_take: 1 });
  });

  it('two PUTs of one event: the stored event equals one of the two serial orders', async () => {
    const s = (await seededSession({ categoriesJson: CATEGORIES_JSON })).sessionId;
    const add = async (message: string) =>
      (
        await json<{ event_id: string }>(
          await app.request(
            `/api/sessions/${s}/events`,
            {
              method: 'POST',
              headers: J,
              body: JSON.stringify({ category: 'cam', message, metadata: { note: message } }),
            },
            env,
          ),
        )
      ).event_id;
    const put = (eventId: string, category: string, message: string) =>
      app.request(
        `/api/sessions/${s}/events/${eventId}`,
        {
          method: 'PUT',
          headers: J,
          body: JSON.stringify({
            category,
            message,
            wall_time_utc: '2026-01-01T00:00:10.000Z',
            timecode_hms: '00:00:10',
          }),
        },
        env,
      );
    const [concurrent, abSerial, baSerial] = [await add('c'), await add('ab'), await add('ba')];
    expect((await put(abSerial, 'slate', 'A')).status).toBe(200);
    expect((await put(abSerial, 'cam', 'B')).status).toBe(200);
    expect((await put(baSerial, 'cam', 'B')).status).toBe(200);
    expect((await put(baSerial, 'slate', 'A')).status).toBe(200);
    const [a, b] = await Promise.all([put(concurrent, 'slate', 'A'), put(concurrent, 'cam', 'B')]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const byId = new Map((await listEvents(s)).map((e) => [e.event_id, e]));
    const shape = (id: string) => {
      const e = byId.get(id);
      return { category: e?.category, message: e?.message, metadata: e?.metadata };
    };
    const serial = [shape(abSerial), shape(baSerial)];
    // The seeded `note` differs per event, so compare the merge's own keys.
    const strip = (x: ReturnType<typeof shape>) => ({
      ...x,
      metadata: { ...(x.metadata as Record<string, unknown>), note: undefined },
    });
    expect(serial.map(strip)).toContainEqual(strip(shape(concurrent)));
  });

  it('two local imports: two different consecutive recording ordinals, on the segments and on the Recording N events', async () => {
    const s = (await seededSession()).sessionId;
    const [a, b] = await Promise.all([localImport(s), localImport(s)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const segs = await json<{ segments: Array<{ recording_ordinal: number | null }> }>(
      await app.request(`/api/sessions/${s}/audio/segments`, {}, env),
    );
    expect(segs.segments.map((x) => x.recording_ordinal).sort()).toEqual([1, 2]);
    const internal = (await listEvents(s))
      .filter((e) => e.category === 'internal')
      .map((e) => e.message)
      .sort();
    expect(internal).toEqual([
      'Recording 1 Started',
      'Recording 1 Stopped',
      'Recording 2 Started',
      'Recording 2 Stopped',
    ]);
  });

  it('a transcript generation against a local import: the stored words are remapped against the anchors either before or after the take', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              results: {
                channels: [
                  {
                    alternatives: [
                      {
                        words: [
                          { word: 'hello', start: 0.5, end: 0.9, speaker: 0 },
                          { word: 'world', start: 1.0, end: 1.4, speaker: 1 },
                        ],
                      },
                    ],
                  },
                ],
              },
            }),
            { status: 200 },
          ),
      ),
    );
    const deepgramEnv = envWith({
      DEEPGRAM_API_KEY: 'test-deepgram-key',
      DEEPGRAM_MODEL: 'nova-3',
    });
    const prepared = async () => {
      const s = (await seededSession()).sessionId;
      const started = await app.request(
        `/api/sessions/${s}/events`,
        {
          method: 'POST',
          headers: J,
          body: JSON.stringify({
            category: 'internal',
            message: 'Recording 1 Started',
            metadata: {},
          }),
        },
        env,
      );
      expect(started.status).toBe(200);
      const seg = await app.request(
        `/api/sessions/${s}/audio/segments?recording_ordinal=1`,
        { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: readFileSync(SEG1) },
        env,
      );
      expect(seg.status).toBe(200);
      return s;
    };
    const generate = (s: string) =>
      app.request(`/api/sessions/${s}/transcript-words/generate`, { method: 'POST' }, deepgramEnv);
    const words = async (s: string) =>
      (
        await json<{ words: Array<{ word: string; session_time: string; speaker: string }> }>(
          await app.request(`/api/sessions/${s}/transcript-words`, {}, env),
        )
      ).words.map((w) => `${w.speaker}|${w.word}|${w.session_time}`);

    const before = await prepared();
    expect((await generate(before)).status).toBe(200);
    expect((await localImport(before)).status).toBe(200);
    const after = await prepared();
    expect((await localImport(after)).status).toBe(200);
    expect((await generate(after)).status).toBe(200);

    const concurrent = await prepared();
    const [g, i] = await Promise.all([generate(concurrent), localImport(concurrent)]);
    expect([g.status, i.status]).toEqual([200, 200]);
    const stored = await words(concurrent);
    expect(stored).toHaveLength(2);
    expect([await words(before), await words(after)]).toContainEqual(stored);
  });

  it('two log imports of one sheet: each row is stored once, and the created counts sum to the distinct rows', async () => {
    const studio = await seedMemberStudio();
    const show = await seedShow({
      studioId: studio,
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
        {
          id: 'other',
          name: 'Other',
          color: '#445566',
          type: 'BUTTON',
          dropdown_options: [],
          on_label: '',
          off_label: '',
        },
      ]),
    });
    const session = await seedSession({ showId: show, title: 'EP 12' });
    expect((await localImport(session, 1800)).status).toBe(200);
    await (await harnessHub(session)).replaceTranscriptWords([
      { session_time: '00:08:47', speaker: '0', word: 'almost', start_sec: 527, end_sec: 527.2 },
      { session_time: '00:08:47', speaker: '0', word: 'called', start_sec: 527.3, end_sec: 527.4 },
      { session_time: '00:08:47', speaker: '0', word: 'a', start_sec: 527.5, end_sec: 527.6 },
      {
        session_time: '00:08:47',
        speaker: '0',
        word: 'helicopter',
        start_sec: 527.7,
        end_sec: 528.4,
      },
      { session_time: '00:08:48', speaker: '0', word: 'but', start_sec: 528.5, end_sec: 528.7 },
    ]);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('EP 12');
    ws.getCell('A1').value = 'Show log header (rows 1–6 are ignored)';
    ws.getCell('A7').value = '8:48';
    ws.getCell('B7').value = 'almost called a helicopter but just crawled';
    ws.getCell('C7').value = 'Camera';
    ws.getCell('A8').value = '9:00';
    ws.getCell('B8').value = 'ad break starts now maybe';
    ws.getCell('C8').value = '';
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(xlsx), { status: 200 })),
    );
    const enabled = envWith({ SHEETS_LOG_IMPORT_ENABLED: '1', HOST: '127.0.0.1' });
    const post = () =>
      app.request(
        `/api/shows/${show}/log-import`,
        {
          method: 'POST',
          headers: J,
          body: JSON.stringify({
            spreadsheet_url: 'https://docs.google.com/spreadsheets/d/abc123xyz/edit',
          }),
        },
        enabled,
      );
    const [p1, p2] = await Promise.all([post(), post()]);
    expect([p1.status, p2.status]).toEqual([200, 200]);
    const finished = async (jobId: string) => {
      for (let n = 0; n < 200; n++) {
        const body = await json<{ status: string; lines: string[] }>(
          await app.request(`/api/log-import/${jobId}`, {}, env),
        );
        if (body.status === 'completed' || body.status === 'failed') return body;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('job did not finish');
    };
    const jobs = await Promise.all(
      [p1, p2].map(async (p) => finished((await json<{ job_id: string }>(p)).job_id)),
    );
    expect(jobs.map((j) => j.status)).toEqual(['completed', 'completed']);
    const created = jobs.map((j) => {
      const line = j.lines.find((l) => /Created \d+, skipped \d+ duplicate/.test(l)) ?? '';
      return Number(/Created (\d+)/.exec(line)?.[1] ?? Number.NaN);
    });
    expect(created[0] + created[1]).toBe(2);
    const imported = (await listEvents(session))
      .filter((e) => e.category !== 'internal')
      .map((e) => e.message)
      .sort();
    expect(imported).toEqual([
      'ad break starts now maybe',
      'almost called a helicopter but just crawled',
    ]);
  });
});
