// session-content-policies design D3, D5, D6, D12 (task 4.2): every hub storage call runs under
// its caller's binding. A binding recorder wraps each session's storage: every transaction and
// snapshot body first asks the database who it runs as (`current_user` and `app.user_id`) and
// records that with the caller's kind and reason. Two callers on one hub run as themselves, in one
// FIFO order with broadcasts in commit order; the hub's own open and lease alarm run as reviewed
// system tasks; an AI tool body and a log-import job run as the user who started them.

import { AiMcpListener } from '@autologger/ai-runtime/aiMcpServer';
import { LeaseStore } from '@autologger/session-core/leaseStore';
import { systemCaller, userCaller } from '@autologger/session-core/sessionCaller';
import type { SessionCaller } from '@autologger/session-core/sessionCaller';
import type { SessionStorage } from '@autologger/session-core/sessionCore';
import {
  SessionHub,
  SessionHubRegistry,
  type SessionHubRegistryFacade,
} from '@autologger/session-core/SessionHub';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app, env, envWith } from '../harness';
import {
  catalogFor,
  loginCookie,
  seedMemberStudio,
  seedSession,
  seedShow,
  seedStudio,
  seedUser,
} from '../helpers';
import { sessionDb, testRegistry, testStorage } from './sessionRows';

interface Binding {
  mode: 'tx' | 'snapshot';
  /** `current_user` inside the body. */
  role: string;
  /** `app.user_id` inside the body ('' for a system binding). */
  uid: string;
  /** The caller the storage was handed: `user` or `system:<reason>`. */
  caller: string;
}

const label = (c: SessionCaller) => (c.kind === 'user' ? 'user' : `system:${c.reason}`);

/** Wraps `inner` so every body first records the binding it runs under. */
function recording(inner: SessionStorage, log: Binding[]): SessionStorage {
  const note = async (
    t: Parameters<Parameters<SessionStorage['tx']>[1]>[0],
    mode: Binding['mode'],
    caller: SessionCaller,
  ) => {
    const [r] = await t.all<{ u: string; uid: string | null }>(
      "SELECT current_user AS u, current_setting('app.user_id', true) AS uid",
    );
    log.push({ mode, role: String(r?.u), uid: r?.uid ?? '', caller: label(caller) });
  };
  return {
    tx: (caller, fn) =>
      inner.tx(caller, async (t) => {
        await note(t, 'tx', caller);
        return fn(t);
      }),
    snapshot: (caller, fn) =>
      inner.snapshot(caller, async (t) => {
        await note(t, 'snapshot', caller);
        return fn(t);
      }),
  };
}

/** A team with owner `a` and admin `b`, a show and a session of it. */
async function teamSession(categoriesJson?: string) {
  const studio = await seedStudio();
  const a = await seedUser({ studios: [studio], role: 'owner' });
  const b = await seedUser({ studios: [studio], role: 'admin' });
  const show = await seedShow({ studioId: studio, categoriesJson });
  const session = await seedSession({ showId: show });
  return { studio, a, b, show, session };
}

const CTX = { frameRate: 24, startOffsetFrames: 0 };
const event = (message: string) => ({
  category: 'cam',
  message,
  metadataJson: '{}',
  markedAtUtc: null,
  ctx: CTX,
});

const registries: SessionHubRegistry[] = [];
afterEach(async () => {
  for (const r of registries.splice(0)) await r.closeAll();
  vi.unstubAllGlobals();
});

describe('hub calls run under their caller (session-content-policies D3, D6)', () => {
  it('hub.as(a) and hub.as(b) on one hub run as catalog_user/a and catalog_user/b, in one FIFO order, broadcasts in commit order', async () => {
    const { a, b, session } = await teamSession();
    const log: Binding[] = [];
    const registry = testRegistry({ wrap: (s) => recording(s, log) });
    registries.push(registry);
    const hub = await registry.get(session);
    const frames: { type: string; revision?: number }[] = [];
    hub.attachSocket({ send: (d: string) => void frames.push(JSON.parse(d)) }, 'browser');
    const opened = log.length;
    const va = hub.as(userCaller(a));
    const vb = hub.as(userCaller(b));
    await Promise.all([
      va.addEvent(event('a1')),
      vb.addEvent(event('b1')),
      va.listEvents({ limit: 10, offset: 0 }),
      vb.addEvent(event('b2')),
    ]);
    expect(log.slice(opened)).toEqual([
      { mode: 'tx', role: 'catalog_user', uid: a, caller: 'user' },
      { mode: 'tx', role: 'catalog_user', uid: b, caller: 'user' },
      { mode: 'snapshot', role: 'catalog_user', uid: a, caller: 'user' },
      { mode: 'tx', role: 'catalog_user', uid: b, caller: 'user' },
    ]);
    const revisions = frames.filter((f) => f.type === 'event.changed').map((f) => f.revision);
    expect(revisions).toHaveLength(3);
    expect([...revisions].sort((x, y) => Number(x) - Number(y))).toEqual(revisions);
    const listed = await va.exportEvents();
    expect(listed.map((e) => e.message).sort()).toEqual(['a1', 'b1', 'b2']);
  });

  it('the open runs as system:session-open and the lease alarm as system:session-lease-alarm', async () => {
    const { a, session } = await teamSession();
    const log: Binding[] = [];
    const storage = recording(testStorage(session), log);
    const T = 1_750_000_000_000;
    const time = { now: T };
    const clock = { now: () => time.now };
    const first = await SessionHub.open(session, storage, clock);
    expect(log).toEqual([
      { mode: 'tx', role: 'catalog_system', uid: '', caller: 'system:session-open' },
    ]);
    expect(await first.as(userCaller(a)).claimLease('client-a')).toBe(true);
    await first.close();
    // Reopened just before the lease goes stale: the alarm fires about 10 ms later.
    time.now = T + LeaseStore.LEASE_STALE_MS - 10;
    const hub = await SessionHub.open(session, storage, clock);
    time.now = T + LeaseStore.LEASE_STALE_MS + 1;
    const view = hub.as(userCaller(a));
    for (let i = 0; i < 100 && (await view.leaseStatus()).holder_client_id !== null; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await view.leaseStatus()).holder_client_id).toBeNull();
    await hub.close();
    const system = log.filter((l) => l.caller !== 'user');
    expect(system).toEqual([
      { mode: 'tx', role: 'catalog_system', uid: '', caller: 'system:session-open' },
      { mode: 'tx', role: 'catalog_system', uid: '', caller: 'system:session-open' },
      { mode: 'tx', role: 'catalog_system', uid: '', caller: 'system:session-lease-alarm' },
    ]);
    for (const l of log.filter((x) => x.caller === 'user')) {
      expect(l).toMatchObject({ role: 'catalog_user', uid: a });
    }
  });

  it("an AI tool body runs as the turn's starting user", async () => {
    const { a, session } = await teamSession();
    const log: Binding[] = [];
    const registry = testRegistry({ wrap: (s) => recording(s, log) });
    registries.push(registry);
    const listener = new AiMcpListener(registry);
    await listener.start();
    try {
      const turn = listener.registerTurn(session, userCaller(a));
      const client = new Client({ name: 'test', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(turn.url), {
        requestInit: { headers: { Authorization: `Bearer ${turn.token}` } },
      });
      await client.connect(transport);
      try {
        await client.callTool({ name: 'list_topics', arguments: {} });
      } finally {
        await transport.close();
      }
      turn.dispose();
    } finally {
      await listener.close();
    }
    const calls = log.filter((l) => l.caller !== 'system:session-open');
    expect(calls).toEqual([{ mode: 'snapshot', role: 'catalog_user', uid: a, caller: 'user' }]);
  });

  it("a log-import job's hub calls run as the job's creator", async () => {
    const studio = await seedMemberStudio();
    const show = await seedShow({ studioId: studio, categoriesJson: LOG_CATEGORIES });
    const member = await seedUser({ studios: [studio] });
    await catalogFor().auth.authGrantShow(member, show, member, new Date().toISOString());
    const cookie = await loginCookie(member);
    const session = await seedSession({ showId: show, title: 'EP 1' });
    // A take and timed words, set up through the harness's own hubs (the default user, an admin).
    const res = await app.request(
      `/api/sessions/${session}/local-audio-import?duration_s=1800`,
      {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
      },
      env,
    );
    expect(res.status).toBe(200);
    await (await env.ports.sessions.get(session))
      .as(systemCaller('test-harness'))
      .replaceTranscriptWords(LOG_WORDS);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('EP 1');
    ws.getCell('A7').value = '8:48';
    ws.getCell('B7').value = 'almost called a helicopter but just crawled';
    ws.getCell('C7').value = 'Camera';
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(xlsx), { status: 200 })),
    );

    const log: Binding[] = [];
    const registry = testRegistry({ wrap: (s) => recording(s, log) });
    registries.push(registry);
    const bindings = envWith(
      { SHEETS_LOG_IMPORT_ENABLED: '1', HOST: '127.0.0.1' },
      { sessions: registry as SessionHubRegistryFacade },
    );
    const post = await app.request(
      `/api/shows/${show}/log-import`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          spreadsheet_url: 'https://docs.google.com/spreadsheets/d/abc123xyz/edit',
        }),
      },
      bindings,
    );
    expect(post.status).toBe(200);
    const { job_id } = (await post.json()) as { job_id: string };
    let body: { status: string; lines: string[] } | null = null;
    for (let i = 0; i < 200; i++) {
      const get = await app.request(`/api/log-import/${job_id}`, { headers: { cookie } }, env);
      body = (await get.json()) as { status: string; lines: string[] };
      if (body.status === 'failed' || body.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(body?.status, body?.lines.join('\n')).toBe('completed');
    const calls = log.filter((l) => l.caller !== 'system:session-open');
    expect(calls.some((l) => l.mode === 'tx')).toBe(true);
    for (const l of calls) expect(l).toEqual({ ...l, role: 'catalog_user', uid: member, caller: 'user' });
  });

  it('registry.get(id) resolves an entry with no storage member (a type case)', async () => {
    const { session } = await teamSession();
    // A plain registry (not the harness's `TestRegistry`, whose hubs carry the test caller).
    const registry = new SessionHubRegistry({ storage: (id) => sessionDb().forSession(id) });
    registries.push(registry);
    const facade: SessionHubRegistryFacade = registry;
    const entry = await facade.get(session);
    // @ts-expect-error -- the entry has the socket members and `as`, no storage member.
    expect(entry.addEvent).toBeUndefined();
    expect(typeof entry.as).toBe('function');
    expect(typeof entry.attachSocket).toBe('function');
  });
});

const LOG_CATEGORIES = JSON.stringify([
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
]);

const LOG_WORDS = [
  { session_time: '00:08:47', speaker: '0', word: 'almost', start_sec: 527, end_sec: 527.2 },
  { session_time: '00:08:47', speaker: '0', word: 'called', start_sec: 527.3, end_sec: 527.4 },
  { session_time: '00:08:47', speaker: '0', word: 'a', start_sec: 527.5, end_sec: 527.6 },
  { session_time: '00:08:47', speaker: '0', word: 'helicopter', start_sec: 527.7, end_sec: 528.4 },
  { session_time: '00:08:48', speaker: '0', word: 'but', start_sec: 528.5, end_sec: 528.7 },
];
