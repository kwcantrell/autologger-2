import { KvStore } from '@autologger/storage';
import { describe, expect, it, vi } from 'vitest';
import { GatedCatalog } from '../test/gatedCatalog';
import { app, env, envWith } from '../test/harness';
import {
  seededSession,
  seedSession,
  seedShow,
  seedStudio,
  setCompanionPresence,
} from '../test/helpers';

const J = { 'content-type': 'application/json' };
async function state(): Promise<Record<string, unknown>> {
  const res = await app.request('/api/companion/state', { method: 'GET' }, { ...env });
  return (await res.json()) as Record<string, unknown>;
}

describe('presence + state', () => {
  it('a registered presence surfaces in state', async () => {
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s, { visible: true });
    const body = await state();
    expect(Number(body.connected_clients)).toBeGreaterThanOrEqual(1);
    expect(body.active_session_id).toBe(s);
    expect((body.session as { id: string }).id).toBe(s);
    expect(body.last_command).toBeNull();
  });

  // session-title-suffix (design D5, gate ruling 2026-08-02, task 1.5/3.1):
  // deck_title equals the stored session title everywhere — Companion state
  // is the third of the three frozen emitters (list/detail/status are
  // covered in sessions.int.test.ts).
  it('deck_title equals the stored title, not CODE - episode', async () => {
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio, code: 'HD' });
    const s = await seedSession({ showId: show, episode: '7', title: 'HD_260802' });
    await setCompanionPresence('c1', s, { visible: true });
    const body = await state();
    expect((body.session as { deck_title: string }).deck_title).toBe('HD_260802');
  });

  it('deck_title falls back to "—" for a blank stored title, even with a show code present', async () => {
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio, code: 'HD' });
    const s = await seedSession({ showId: show, episode: '7', title: '' });
    await setCompanionPresence('c1', s, { visible: true });
    const body = await state();
    expect((body.session as { title: string }).title).toBe('');
    expect((body.session as { deck_title: string }).deck_title).toBe('—');
  });

  it('POST presence with closing:true removes it', async () => {
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s);
    await app.request(
      '/api/companion/presence',
      { method: 'POST', headers: J, body: JSON.stringify({ client_id: 'c1', closing: true }) },
      { ...env },
    );
    expect((await state()).active_session_id).toBeNull();
  });
});

describe('log', () => {
  it('logs an event by category_id for the active session', async () => {
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s);
    const res = await app.request(
      '/api/companion/log',
      { method: 'POST', headers: J, body: JSON.stringify({ category_id: 'cam', message: 'Cut' }) },
      { ...env },
    );
    expect(res.status).toBe(200);
  });

  it('409 when there is no active session', async () => {
    const res = await app.request(
      '/api/companion/log',
      { method: 'POST', headers: J, body: JSON.stringify({ category_id: 'cam', message: 'x' }) },
      { ...env },
    );
    expect(res.status).toBe(409);
  });

  it('400 on an unknown category', async () => {
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s);
    const res = await app.request(
      '/api/companion/log',
      { method: 'POST', headers: J, body: JSON.stringify({ category_id: 'nope', message: 'x' }) },
      { ...env },
    );
    expect(res.status).toBe(400);
  });
});

describe('transport', () => {
  it('start then stop flips is_rolling', async () => {
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s);
    const start = await app.request(
      '/api/companion/transport',
      { method: 'POST', headers: J, body: JSON.stringify({ action: 'start' }) },
      { ...env },
    );
    expect((await start.json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      is_rolling: true,
      current_take: 1,
    });
    const stop = await app.request(
      '/api/companion/transport',
      { method: 'POST', headers: J, body: JSON.stringify({ action: 'stop' }) },
      { ...env },
    );
    expect(((await stop.json()) as { is_rolling: boolean }).is_rolling).toBe(false);
  });
});

describe('command + ack', () => {
  it('records last_command and acks by id', async () => {
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s);
    const cmd = await app.request(
      '/api/companion/command',
      { method: 'POST', headers: J, body: JSON.stringify({ type: 'record-start' }) },
      { ...env },
    );
    const commandId = ((await cmd.json()) as { command_id: string }).command_id;
    expect(commandId).toBeTruthy();
    expect(((await state()).last_command as { id: string }).id).toBe(commandId);

    const ack = await app.request(
      `/api/companion/commands/${commandId}/ack`,
      { method: 'POST', headers: J, body: JSON.stringify({ client_id: 'c1', ok: true }) },
      { ...env },
    );
    expect((await ack.json()) as { ok: boolean }).toMatchObject({ ok: true });

    const bad = await app.request(
      '/api/companion/commands/wrong-id/ack',
      { method: 'POST', headers: J, body: JSON.stringify({ client_id: 'c1', ok: true }) },
      { ...env },
    );
    expect((await bad.json()) as { ok: boolean }).toMatchObject({ ok: false });
  });
});

describe('categories + commands/wait', () => {
  it('returns the active session show categories', async () => {
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s);
    const res = await app.request('/api/companion/categories', { method: 'GET' }, { ...env });
    expect(res.status).toBe(200);
    expect(Array.isArray(((await res.json()) as { categories: unknown[] }).categories)).toBe(true);
  });

  it('byte-shape is unchanged for an instruction-bearing show (auto-generate-event-logs)', async () => {
    // Frozen-contract pin (delta scenario "Feed client learns instruction
    // presence; Companion unchanged"): even when the show's categories carry
    // `auto_instruction` values, the Companion response has no
    // `auto_instructions_present` boolean and its category/option entries
    // carry no instruction fields — exact body equality, not key sampling.
    const { sessionId, showId } = await seededSession({
      categoriesJson: JSON.stringify([
        {
          id: 'mic',
          name: 'Mic',
          color: '#7cb7ff',
          type: 'DROPDOWN',
          auto_instruction: 'log every mic swap',
          dropdown_options: [
            { label: 'Lav', needs_context: false, auto_instruction: 'log every lav handoff' },
            { label: 'Boom', needs_context: true },
          ],
          on_label: '',
          off_label: '',
        },
      ]),
    });
    await setCompanionPresence('c1', sessionId);
    const res = await app.request('/api/companion/categories', { method: 'GET' }, { ...env });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      session_id: sessionId,
      show_id: showId,
      show_name: 'Test Show',
      show_code: 'TS',
      categories: [
        {
          id: 'mic',
          label: 'Mic',
          color: '#7cb7ff',
          type: 'DROPDOWN',
          dropdown_options: [
            { label: 'Lav', needs_context: false },
            { label: 'Boom', needs_context: true },
          ],
          on_label: '',
          off_label: '',
        },
      ],
    });
  });

  it('commands/wait with timeout=0 returns empty immediately', async () => {
    const res = await app.request(
      '/api/companion/commands/wait?timeout=0',
      { method: 'GET' },
      { ...env },
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { commands: unknown[] }).toMatchObject({ commands: [] });
  });
});

describe('primarySession is global / unscoped (current behavior)', () => {
  it('selects the visibly-fresher session regardless of studio', async () => {
    const sA = (await seededSession()).sessionId;
    const sB = (await seededSession()).sessionId;
    await setCompanionPresence('cA', sA, { visible: false });
    await setCompanionPresence('cB', sB, { visible: true });
    expect((await state()).active_session_id).toBe(sB);
  });
});

describe('ordering on async storage (async-session-callers D4/D5)', () => {
  it('/command stores last_command before broadcasting it', async () => {
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s);
    const hub = env.ports.sessions.get(s);
    let storedAtBroadcast: Promise<string | null> | null = null;
    const spy = vi.spyOn(hub, 'broadcastCommand').mockImplementation(() => {
      storedAtBroadcast = env.ports.kv.get('companion:last_command');
    });
    try {
      const res = await app.request(
        '/api/companion/command',
        { method: 'POST', headers: J, body: JSON.stringify({ type: 'record-start' }) },
        { ...env },
      );
      expect(res.status).toBe(200);
      const { command_id } = (await res.json()) as { command_id: string };
      expect(spy).toHaveBeenCalledOnce();
      const raw = await (storedAtBroadcast as Promise<string | null> | null);
      expect(JSON.parse(raw ?? 'null')).toMatchObject({ id: command_id, type: 'record-start' });
    } finally {
      spy.mockRestore();
    }
  });

  it('/state takes one presence snapshot', async () => {
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s);
    const spy = vi.spyOn(env.ports.presence, 'list');
    try {
      await state();
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
});

// catalog-concurrency-hazards D7: an ack marks its command only while it is still the latest.
describe('ack racing a newer command', () => {
  it('a late ack for command A after command B lands gives {ok:false}, and last_command stays B', async () => {
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s, { visible: true });
    const command = async () =>
      (await (
        await app.request(
          '/api/companion/command',
          { method: 'POST', headers: J, body: JSON.stringify({ type: 'record-toggle' }) },
          { ...env },
        )
      ).json()) as { command_id: string };
    const a = await command();
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.holdAfter(/^SELECT value, expires_at FROM kv WHERE key = \?$/);
    const ack = app.request(
      `/api/companion/commands/${a.command_id}/ack`,
      { method: 'POST', headers: J, body: JSON.stringify({ client_id: 'c1', ok: true }) },
      envWith({}, { kv: new KvStore(gated, env.ports.clock) }),
    );
    await h.reached;
    const b = await command();
    h.release();
    expect(await (await ack).json()).toEqual({ ok: false });
    expect(((await state()).last_command as { id: string }).id).toBe(b.command_id);
  });
});
