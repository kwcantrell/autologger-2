import { app, env } from '../test/harness';
import { describe, expect, it } from 'vitest';
import { seedSession, seedShow, seedStudio, setCompanionPresence } from '../test/helpers';

const J = { 'content-type': 'application/json' };

async function seededSession(categoriesJson?: string): Promise<string> {
  const studio = await seedStudio();
  const show = await seedShow({ studioId: studio, categoriesJson });
  return seedSession({ showId: show });
}
async function state(): Promise<Record<string, unknown>> {
  const res = await app.request('/api/companion/state', { method: 'GET' }, { ...env });
  return (await res.json()) as Record<string, unknown>;
}

describe('presence + state', () => {
  it('a registered presence surfaces in state', async () => {
    const s = await seededSession();
    await setCompanionPresence('c1', s, { visible: true });
    const body = await state();
    expect(Number(body.connected_clients)).toBeGreaterThanOrEqual(1);
    expect(body.active_session_id).toBe(s);
    expect((body.session as { id: string }).id).toBe(s);
    expect(body.last_command).toBeNull();
  });

  it('POST presence with closing:true removes it', async () => {
    const s = await seededSession();
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
    const s = await seededSession();
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
    const s = await seededSession();
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
    const s = await seededSession();
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
    const s = await seededSession();
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
    const s = await seededSession();
    await setCompanionPresence('c1', s);
    const res = await app.request('/api/companion/categories', { method: 'GET' }, { ...env });
    expect(res.status).toBe(200);
    expect(Array.isArray(((await res.json()) as { categories: unknown[] }).categories)).toBe(true);
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
    const showA = await seedShow({ studioId: await seedStudio() });
    const sA = await seedSession({ showId: showA });
    const showB = await seedShow({ studioId: await seedStudio() });
    const sB = await seedSession({ showId: showB });
    await setCompanionPresence('cA', sA, { visible: false });
    await setCompanionPresence('cB', sB, { visible: true });
    expect((await state()).active_session_id).toBe(sB);
  });
});
