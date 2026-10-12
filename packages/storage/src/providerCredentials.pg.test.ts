// The ProviderCredentialStore on `catalog.user_provider_credentials` and
// `catalog.provider_key_check` (byo-ai-providers design D1) against the catalog adapter as the
// app's least-privilege role on a cloned test database. Users are seeded on a test system handle;
// the store binds its own `provider-credentials` reason. Times come from a fake clock. The store
// deals only in ciphertext parts: these tests use fixed bytes, never a real key.
import type { CatalogDb, StoredProviderKey } from '@autologger/ports';
import { afterEach, describe, expect, it } from 'vitest';
import { PostgresCatalogDb } from './postgresCatalogStore';
import {
  PostgresProviderCredentialStore,
  PROVIDER_TEST_LIMIT,
  PROVIDER_TEST_WINDOW_MS,
} from './providerCredentials';
import { createTestDatabase } from './test/pgDb';

const open: PostgresCatalogDb[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

const key = (n: number, last4 = 'abcd'): StoredProviderKey => ({
  nonce: Uint8Array.from([n, 1, 2]),
  ciphertext: Uint8Array.from([n, 3, 4, 5]),
  tag: Uint8Array.from([n, 6]),
  version: 1,
  last4,
});
const LLM = {
  provider: 'openai-compatible',
  base_url: 'https://api.example.com/v1',
  base_origin: 'https://api.example.com',
  model: 'gpt-x',
};
const STT = { provider: 'deepgram', base_url: null, base_origin: null, model: 'nova-3' };

async function env() {
  const root = new PostgresCatalogDb((await createTestDatabase()).app);
  open.push(root);
  const db: CatalogDb = root.bindSystem('test');
  for (const id of ['ua', 'ub']) {
    await db.run(
      'INSERT INTO users (id, google_sub, email, created_at_utc) VALUES (?, ?, ?, ?)',
      id,
      `${id}-sub`,
      `${id}@example.com`,
      'now',
    );
  }
  let now = Date.parse('2026-10-16T12:00:00.000Z');
  const clock = { now: () => now };
  const tick = (ms: number) => {
    now += ms;
  };
  const store = new PostgresProviderCredentialStore(root, clock);
  return { db, root, store, clock, tick };
}

const bytes = (k: StoredProviderKey) => ({
  nonce: [...k.nonce],
  ciphertext: [...k.ciphertext],
  tag: [...k.tag],
  version: k.version,
  last4: k.last4,
});

describe('PostgresProviderCredentialStore (byo-ai-providers D1)', () => {
  it('put inserts a credential, then replaces it, keeping its creation time', async () => {
    const { store, clock, tick } = await env();
    const t0 = new Date(clock.now()).toISOString();
    const first = await store.put('ua', 'llm', { ...LLM, key: key(1, '1111') });
    expect({ ...first, key: bytes(first.key) }).toEqual({
      kind: 'llm',
      ...LLM,
      key: bytes(key(1, '1111')),
      created_at_utc: t0,
      updated_at_utc: t0,
    });
    tick(5_000);
    const second = await store.put('ua', 'llm', {
      ...LLM,
      model: 'gpt-y',
      key: key(2, '2222'),
    });
    expect(second.created_at_utc).toBe(t0);
    expect(second.updated_at_utc).toBe(new Date(clock.now()).toISOString());
    const got = await store.get('ua', 'llm');
    expect(got && { model: got.model, key: bytes(got.key!) }).toEqual({
      model: 'gpt-y',
      key: bytes(key(2, '2222')),
    });
    expect((await store.list('ua')).length).toBe(1);
  });

  it('get and list return only the caller’s own rows, by kind', async () => {
    const { store } = await env();
    await store.put('ua', 'llm', { ...LLM, key: key(1) });
    await store.put('ua', 'stt', { ...STT, key: key(2) });
    await store.put('ub', 'stt', { ...STT, key: key(3, 'bbbb') });
    expect((await store.list('ua')).map((r) => r.kind).sort()).toEqual(['llm', 'stt']);
    expect((await store.list('ub')).map((r) => [r.kind, r.key!.last4])).toEqual([['stt', 'bbbb']]);
    expect(await store.get('ub', 'llm')).toBeNull();
    expect((await store.get('ua', 'stt'))?.key!.last4).toBe('abcd');
  });

  it('updateKeepingKey changes only provider, base URL, model and time, and keeps the key', async () => {
    const { store, tick } = await env();
    await store.put('ua', 'llm', { ...LLM, key: key(1, '1111') });
    tick(1_000);
    const r = await store.updateKeepingKey('ua', 'llm', {
      ...LLM,
      base_url: 'https://api.example.com/v2',
      model: 'gpt-z',
    });
    expect(r && { url: r.base_url, model: r.model, key: bytes(r.key) }).toEqual({
      url: 'https://api.example.com/v2',
      model: 'gpt-z',
      key: bytes(key(1, '1111')),
    });
  });

  it('updateKeepingKey changes nothing and reports null when the origin differs or the row is gone', async () => {
    const { store } = await env();
    await store.put('ua', 'llm', { ...LLM, key: key(1) });
    expect(
      await store.updateKeepingKey('ua', 'llm', {
        ...LLM,
        base_url: 'https://evil.example/v1',
        base_origin: 'https://evil.example',
      }),
    ).toBeNull();
    expect((await store.get('ua', 'llm'))?.base_url).toBe(LLM.base_url);
    // No row for ub; a delete committed before the update also leaves no row to bring back.
    expect(await store.updateKeepingKey('ub', 'llm', LLM)).toBeNull();
    expect(await store.delete('ua', 'llm')).toBe(true);
    expect(await store.updateKeepingKey('ua', 'llm', LLM)).toBeNull();
    expect(await store.get('ua', 'llm')).toBeNull();
    // stt rows have a null origin, which matches a null origin.
    await store.put('ua', 'stt', { ...STT, key: key(2) });
    expect((await store.updateKeepingKey('ua', 'stt', { ...STT, model: 'nova-2' }))?.model).toBe(
      'nova-2',
    );
  });

  it('updateKeepingKey matches only the same provider; put can switch it (owner decision 10)', async () => {
    const { store } = await env();
    await store.put('ua', 'llm', { ...LLM, key: key(1, '1111') });
    const fixed = { provider: 'anthropic', base_url: null, base_origin: null, model: 'claude-x' };
    expect(await store.updateKeepingKey('ua', 'llm', fixed)).toBeNull();
    const kept = await store.get('ua', 'llm');
    expect(kept && { p: kept.provider, url: kept.base_url, last4: kept.key!.last4 }).toEqual({
      p: 'openai-compatible',
      url: LLM.base_url,
      last4: '1111',
    });
    const switched = await store.put('ua', 'llm', { ...fixed, key: key(2, '2222') });
    expect({ p: switched.provider, url: switched.base_url, o: switched.base_origin }).toEqual({
      p: 'anthropic',
      url: null,
      o: null,
    });
    expect(
      (await store.updateKeepingKey('ua', 'llm', { ...fixed, model: 'claude-y' }))?.model,
    ).toBe('claude-y');
    // Two fixed-host providers share a null origin: only the provider tells them apart.
    expect(
      await store.updateKeepingKey('ua', 'llm', { ...fixed, provider: 'openai', model: 'gpt-x' }),
    ).toBeNull();
    expect((await store.get('ua', 'llm'))?.provider).toBe('anthropic');
  });

  it('a keep-key update racing a delete never brings the key back', async () => {
    const { store } = await env();
    for (let i = 0; i < 10; i++) {
      await store.put('ua', 'stt', { ...STT, key: key(i) });
      await Promise.all([
        store.updateKeepingKey('ua', 'stt', { ...STT, model: `m${i}` }),
        store.delete('ua', 'stt'),
      ]);
      expect(await store.get('ua', 'stt')).toBeNull();
    }
  });

  it('delete removes only the caller’s row and reports whether one was removed', async () => {
    const { store } = await env();
    await store.put('ua', 'stt', { ...STT, key: key(1) });
    await store.put('ub', 'stt', { ...STT, key: key(2) });
    expect(await store.delete('ub', 'llm')).toBe(false);
    expect(await store.delete('ub', 'stt')).toBe(true);
    expect(await store.delete('ub', 'stt')).toBe(false);
    expect(await store.get('ua', 'stt')).not.toBeNull();
  });

  it(`takeTestSlot counts per user within a ${PROVIDER_TEST_WINDOW_MS} ms window and restarts after it`, async () => {
    const { store, tick } = await env();
    const counts: number[] = [];
    for (let i = 0; i <= PROVIDER_TEST_LIMIT; i++) {
      counts.push(await store.takeTestSlot('ua'));
      tick(1_000);
    }
    expect(counts).toEqual([1, 2, 3, 4, 5, 6]);
    tick(PROVIDER_TEST_WINDOW_MS);
    expect(await store.takeTestSlot('ua')).toBe(1);
    // Another user's window is separate.
    expect(await store.takeTestSlot('ub')).toBe(1);
  });

  it('the window survives deleting and re-saving a credential (byo 2.4, re-panel)', async () => {
    const { store } = await env();
    await store.put('ua', 'llm', { ...LLM, key: key(1) });
    for (let i = 0; i < 5; i++) await store.takeTestSlot('ua');
    await store.delete('ua', 'llm');
    await store.put('ua', 'llm', { ...LLM, key: key(2) });
    expect(await store.takeTestSlot('ua')).toBe(6);
  });

  it('concurrent takeTestSlot calls from different connections count each one once', async () => {
    const { store, root, clock } = await env();
    const other = new PostgresProviderCredentialStore(root, clock);
    const counts = await Promise.all(
      Array.from({ length: 8 }, (_, i) => (i % 2 ? store : other).takeTestSlot('ua')),
    );
    expect([...counts].sort((a, b) => Number(a) - Number(b))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  // ai-sdk-agent-harness design D2: the keyless `claude-cli` llm row.
  it('putKeyless stores and replaces the llm row with no key, keeping its creation time (ai-sdk 2.2)', async () => {
    const { store, clock, tick } = await env();
    const t0 = new Date(clock.now()).toISOString();
    const cli = {
      kind: 'llm',
      provider: 'claude-cli',
      base_url: null,
      base_origin: null,
      model: 'claude-cli',
      key: null,
    };
    expect(await store.putKeyless('ua', 'llm', 'claude-cli')).toEqual({
      ...cli,
      created_at_utc: t0,
      updated_at_utc: t0,
    });
    // It replaces a keyed row, and a keyed put replaces it.
    tick(1_000);
    await store.put('ua', 'llm', { ...LLM, key: key(1, '1111') });
    tick(1_000);
    const replaced = await store.putKeyless('ua', 'llm', 'claude-cli');
    expect(replaced).toEqual({
      ...cli,
      created_at_utc: t0,
      updated_at_utc: new Date(clock.now()).toISOString(),
    });
    await store.put('ub', 'stt', { ...STT, key: key(2) });
    const back = await store.put('ub', 'llm', { ...LLM, key: key(3, '3333') });
    expect(back.key && bytes(back.key)).toEqual(bytes(key(3, '3333')));
    expect((await store.list('ub')).map((r) => r.provider)).toEqual(['openai-compatible', 'deepgram']);
  });

  it('get and list return key null for the claude-cli row (ai-sdk 2.2)', async () => {
    const { store } = await env();
    await store.putKeyless('ua', 'llm', 'claude-cli');
    await store.put('ua', 'stt', { ...STT, key: key(1, 'wxyz') });
    const got = await store.get('ua', 'llm');
    expect(got && { p: got.provider, m: got.model, url: got.base_url, key: got.key }).toEqual({
      p: 'claude-cli',
      m: 'claude-cli',
      url: null,
      key: null,
    });
    expect((await store.list('ua')).map((r) => [r.kind, r.provider, r.key?.last4 ?? null])).toEqual([
      ['llm', 'claude-cli', null],
      ['stt', 'deepgram', 'wxyz'],
    ]);
  });

  it('updateKeepingKey never keeps a key across a switch from claude-cli, nor on the keyless row (ai-sdk 2.2)', async () => {
    const { store } = await env();
    await store.putKeyless('ua', 'llm', 'claude-cli');
    const fixed = { provider: 'anthropic', base_url: null, base_origin: null, model: 'claude-x' };
    for (const fields of [
      fixed,
      { ...fixed, provider: 'openai', model: 'gpt-x' },
      { ...fixed, provider: 'google', model: 'gemini-x' },
      LLM,
      // Even naming the same provider: there is no key to keep.
      { provider: 'claude-cli', base_url: null, base_origin: null, model: 'other' },
    ]) {
      expect(await store.updateKeepingKey('ua', 'llm', fields)).toBeNull();
    }
    const kept = await store.get('ua', 'llm');
    expect(kept && { p: kept.provider, m: kept.model, key: kept.key }).toEqual({
      p: 'claude-cli',
      m: 'claude-cli',
      key: null,
    });
  });

  it('writeCheckIfAbsent keeps the first value written; readCheck returns it', async () => {
    const { store } = await env();
    expect(await store.readCheck()).toBeNull();
    const [a, b] = await Promise.all([
      store.writeCheckIfAbsent('first'),
      store.writeCheckIfAbsent('second'),
    ]);
    expect(a).toBe(b);
    expect(await store.writeCheckIfAbsent('third')).toBe(a);
    expect(await store.readCheck()).toBe(a);
  });
});
