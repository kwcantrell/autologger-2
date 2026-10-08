// Companion device management routes (companion-devices task 6.1, design D5; api-contract-freeze
// "Companion device management routes" and the device-token requirement's audit lines and idle
// expiry). Every request here carries an explicit cookie (or none), through `anonApp`.

import {
  companionDeviceCreatedResponseSchema,
  companionDeviceListResponseSchema,
} from '@autologger/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashCompanionDeviceToken } from '../auth/companionDeviceToken';
import { anonApp, env } from '../test/harness';
import { loginCookie, seedCompanionDevice, seedUser, testDb } from '../test/helpers';

const PATH = '/api/companion-devices';
const DAY = 86_400_000;
const LOGIN_REQUIRED = { detail: 'Login required.' };
const CAP_REACHED = { detail: 'You already have 10 Companion devices; revoke one first.' };
const NOT_FOUND = { detail: 'Companion device not found.' };
const NUL_REFUSED = { detail: 'Text must not contain NUL characters.' };

interface Caller {
  id: string;
  cookie: string;
}

async function caller(): Promise<Caller> {
  const id = await seedUser();
  return { id, cookie: await loginCookie(id) };
}

function list(headers: Record<string, string>) {
  return anonApp.request(PATH, { headers }, env);
}

function create(headers: Record<string, string>, body: unknown) {
  return anonApp.request(
    PATH,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}

function revoke(headers: Record<string, string>, id: string) {
  return anonApp.request(`${PATH}/${encodeURIComponent(id)}`, { method: 'DELETE', headers }, env);
}

function companionState(token: string) {
  return anonApp.request(
    '/api/companion/state',
    { headers: { Authorization: `Bearer ${token}` } },
    env,
  );
}

async function created(who: Caller, name = 'Booth A') {
  const res = await create({ cookie: who.cookie }, { name });
  expect(res.status).toBe(201);
  return companionDeviceCreatedResponseSchema.parse(await res.json());
}

async function devicesOf(who: Caller) {
  const res = await list({ cookie: who.cookie });
  expect(res.status).toBe(200);
  return companionDeviceListResponseSchema.parse(await res.json()).devices;
}

async function storedCount(userId: string): Promise<number> {
  const row = await testDb().first<{ n: number }>(
    'SELECT count(*)::int AS n FROM companion_devices WHERE user_id = ?',
    userId,
  );
  return Number(row?.n ?? 0);
}

describe('create, list and revoke', () => {
  it('creates (201, ald_ token), lists without the token, revokes (204), and the token then gets 401', async () => {
    const me = await caller();
    const res = await create({ cookie: me.cookie }, { name: 'Booth A' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['created_at', 'id', 'name', 'token']);
    const dev = companionDeviceCreatedResponseSchema.parse(body);
    expect(dev.name).toBe('Booth A');
    expect(dev.token.startsWith('ald_')).toBe(true);
    expect(new Date(dev.created_at).toISOString()).toBe(dev.created_at);

    const listed = await list({ cookie: me.cookie });
    expect(listed.status).toBe(200);
    const text = await listed.text();
    expect(text).not.toContain(dev.token);
    expect(text).not.toContain(hashCompanionDeviceToken(dev.token));
    expect(JSON.parse(text)).toEqual({
      devices: [
        {
          id: dev.id,
          name: 'Booth A',
          created_at: dev.created_at,
          last_used_at: null,
          expired: false,
        },
      ],
    });

    expect((await companionState(dev.token)).status).toBe(200);

    const del = await revoke({ cookie: me.cookie }, dev.id);
    expect(del.status).toBe(204);
    expect(await del.text()).toBe('');
    expect(await devicesOf(me)).toEqual([]);

    const after = await companionState(dev.token);
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual(LOGIN_REQUIRED);
  });

  it('lists newest first, and shows a use once the device has been used', async () => {
    const me = await caller();
    const older = await created(me, 'Older');
    const newer = await created(me, 'Newer');
    await testDb().run(
      'UPDATE companion_devices SET created_at_utc = ? WHERE id = ?',
      new Date(Date.now() - DAY).toISOString(),
      older.id,
    );
    expect((await devicesOf(me)).map((d) => d.name)).toEqual(['Newer', 'Older']);

    expect((await companionState(newer.token)).status).toBe(200);
    await vi.waitFor(async () => {
      const d = (await devicesOf(me)).find((x) => x.id === newer.id);
      expect(d?.last_used_at).not.toBeNull();
    });
    const [n, o] = await devicesOf(me);
    expect(Date.parse(n?.last_used_at as string)).toBeGreaterThan(Date.now() - DAY);
    expect(o?.last_used_at).toBeNull();
  });

  it('marks a device expired past the 90-day idle window, and keeps listing it', async () => {
    const me = await caller();
    const idle = await created(me, 'Idle');
    const used = await created(me, 'Used');
    const fresh = await created(me, 'Fresh');
    const eighty = new Date(Date.now() - 80 * DAY).toISOString();
    await testDb().run(
      'UPDATE companion_devices SET created_at_utc = ? WHERE id = ?',
      new Date(Date.now() - 91 * DAY).toISOString(),
      idle.id,
    );
    await testDb().run(
      'UPDATE companion_devices SET created_at_utc = ?, last_used_at_utc = ? WHERE id = ?',
      new Date(Date.now() - 120 * DAY).toISOString(),
      eighty,
      used.id,
    );
    const byName = Object.fromEntries((await devicesOf(me)).map((d) => [d.name, d]));
    expect(byName.Idle).toMatchObject({ id: idle.id, last_used_at: null, expired: true });
    expect(byName.Used).toMatchObject({ id: used.id, last_used_at: eighty, expired: false });
    expect(byName.Fresh).toMatchObject({ id: fresh.id, last_used_at: null, expired: false });
    expect((await companionState(idle.token)).status).toBe(401);
  });

  it('stores only the sha256 of the token', async () => {
    const me = await caller();
    const dev = await created(me);
    const row = await testDb().first<Record<string, unknown>>(
      'SELECT * FROM companion_devices WHERE id = ?',
      dev.id,
    );
    expect(row?.token_hash).toBe(hashCompanionDeviceToken(dev.token));
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.user_id).toBe(me.id);
    expect(JSON.stringify(row)).not.toContain(dev.token);
    expect(JSON.stringify(row)).not.toContain(dev.token.slice('ald_'.length));
  });
});

describe('the device name', () => {
  it('is trimmed, and 80 characters after trimming is accepted', async () => {
    const me = await caller();
    expect((await created(me, '  Booth A  ')).name).toBe('Booth A');
    const eighty = 'x'.repeat(80);
    expect((await created(me, `  ${eighty} `)).name).toBe(eighty);
    expect((await devicesOf(me)).map((d) => d.name).sort()).toEqual(['Booth A', eighty]);
  });

  it('over 80 characters, empty or blank gets 422; NUL gets the existing 400; nothing is created', async () => {
    const me = await caller();
    for (const name of ['x'.repeat(81), '', '   ']) {
      const res = await create({ cookie: me.cookie }, { name });
      expect(res.status, JSON.stringify(name)).toBe(422);
      expect(Array.isArray(((await res.json()) as { detail: unknown }).detail)).toBe(true);
    }
    for (const body of [{}, { name: 7 }]) {
      expect((await create({ cookie: me.cookie }, body)).status).toBe(422);
    }
    for (const name of ['a\u0000b', '\u0000']) {
      const res = await create({ cookie: me.cookie }, { name });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(NUL_REFUSED);
    }
    expect(await storedCount(me.id)).toBe(0);
  });
});

describe('the per-user cap of 10', () => {
  it('the 11th device gets 409 and creates nothing; another user is unaffected', async () => {
    const me = await caller();
    for (let i = 0; i < 10; i++) await created(me, `D${i}`);
    const res = await create({ cookie: me.cookie }, { name: 'Eleventh' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(CAP_REACHED);
    expect(await storedCount(me.id)).toBe(10);
    await created(await caller());
  });

  it('with 9 devices, two concurrent creates give one 201 and one 409, and one more gives 409', async () => {
    const me = await caller();
    for (let i = 0; i < 9; i++) await seedCompanionDevice(me.id);
    const answers = await Promise.all([
      create({ cookie: me.cookie }, { name: 'A' }),
      create({ cookie: me.cookie }, { name: 'B' }),
    ]);
    expect(answers.map((r) => r.status).sort()).toEqual([201, 409]);
    const refused = answers.find((r) => r.status === 409);
    expect(await refused?.json()).toEqual(CAP_REACHED);
    const last = await create({ cookie: me.cookie }, { name: 'C' });
    expect(last.status).toBe(409);
    expect(await last.json()).toEqual(CAP_REACHED);
    expect(await storedCount(me.id)).toBe(10);
  });

  it('14 concurrent creates from none leave exactly 10', async () => {
    const me = await caller();
    const answers = await Promise.all(
      Array.from({ length: 14 }, (_, i) => create({ cookie: me.cookie }, { name: `C${i}` })),
    );
    const statuses = answers.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(10);
    expect(statuses.filter((s) => s === 409)).toHaveLength(4);
    expect(await storedCount(me.id)).toBe(10);
    expect(await devicesOf(me)).toHaveLength(10);
  });
});

describe('isolation between users', () => {
  it("another user's id gets 404, changes nothing, and is not in their list", async () => {
    const a = await caller();
    const b = await caller();
    const devA = await created(a, 'A device');
    const devB = await created(b, 'B device');

    const res = await revoke({ cookie: b.cookie }, devA.id);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
    expect((await companionState(devA.token)).status).toBe(200);
    expect((await devicesOf(a)).map((d) => d.id)).toEqual([devA.id]);
    expect((await devicesOf(b)).map((d) => d.id)).toEqual([devB.id]);

    const unknown = await revoke({ cookie: b.cookie }, 'no-such-device');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual(NOT_FOUND);
    expect(await storedCount(a.id)).toBe(1);
    expect(await storedCount(b.id)).toBe(1);
  });

  it("each user's cap counts only their own devices", async () => {
    const a = await caller();
    for (let i = 0; i < 10; i++) await seedCompanionDevice(a.id);
    const b = await caller();
    await created(b);
    expect(await devicesOf(b)).toHaveLength(1);
  });
});

describe('only a session cookie authenticates these routes', () => {
  it('no credentials and a live device token (Bearer) both get 401 on all three routes', async () => {
    const me = await caller();
    const dev = await created(me);
    const bearer = { Authorization: `Bearer ${dev.token}` };
    for (const headers of [{}, bearer]) {
      const answers = [
        await list(headers),
        await create(headers, { name: 'Sneaky' }),
        await anonApp.request(`${PATH}/${dev.id}`, { method: 'DELETE', headers }, env),
      ];
      for (const res of answers) {
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual(LOGIN_REQUIRED);
      }
    }
    expect(await storedCount(me.id)).toBe(1);
    expect((await companionState(dev.token)).status).toBe(200);
  });

  it("a cookie with another user's device token runs as the cookie's user", async () => {
    const a = await caller();
    const b = await caller();
    const devA = await created(a, 'A device');
    const res = await list({ cookie: b.cookie, Authorization: `Bearer ${devA.token}` });
    expect(res.status).toBe(200);
    expect(companionDeviceListResponseSchema.parse(await res.json()).devices).toEqual([]);
  });
});

describe('audit lines', () => {
  afterEach(() => vi.restoreAllMocks());

  it('create and revoke each log one line with the user and device ids, never the token or hash', async () => {
    const lines: string[] = [];
    const record =
      (level: string) =>
      (...args: unknown[]) => {
        lines.push(
          `${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`,
        );
      };
    for (const level of ['info', 'warn', 'log', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation(record(level));
    }
    const me = await caller();
    const dev = await created(me);
    const mine = () => lines.filter((l) => l.includes(me.id) && l.includes(dev.id));
    expect(mine()).toHaveLength(1);
    expect(mine()[0]).toMatch(/^info /);
    expect(mine()[0]).toMatch(/created/i);

    expect((await revoke({ cookie: me.cookie }, dev.id)).status).toBe(204);
    expect(mine()).toHaveLength(2);
    expect(mine()[1]).toMatch(/^info /);
    expect(mine()[1]).toMatch(/revoked/i);

    const hash = hashCompanionDeviceToken(dev.token);
    for (const l of lines) {
      expect(l).not.toContain(dev.token);
      expect(l).not.toContain(hash);
    }
  });

  it('a refused create (cap) or revoke (not found) logs no audit line', async () => {
    const me = await caller();
    for (let i = 0; i < 10; i++) await seedCompanionDevice(me.id);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect((await create({ cookie: me.cookie }, { name: 'Eleventh' })).status).toBe(409);
    expect((await revoke({ cookie: me.cookie }, 'no-such-device')).status).toBe(404);
    expect(info.mock.calls.filter((c) => String(c[0]).includes(me.id))).toEqual([]);
  });
});
