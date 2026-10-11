// resolveLlmRoute (ai-sdk-agent-harness design D1; provider-credentials "Work runs on its user's
// credentials"): the caller's saved `llm` row decides the AI route. `claude-cli` gives the CLI only
// while CLAUDE_CLI_PATH is set and the caller is on CLAUDE_CLI_EMAILS; a key provider gives the SDK
// route with the decrypted key; an undecryptable row or no row gives null, in every mode (no
// fallback). The store is an in-memory stand-in; the cipher is the real one.

import type {
  Config,
  ProviderCredentialRow,
  ProviderCredentialStore,
  ProviderKind,
} from '@autologger/ports';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderKeyCipher } from './providerKeyCrypto';
import { resolveLlmRoute } from './providerResolve';

const T = '2026-10-18T00:00:00.000Z';
const USER = { id: 'u1', email: 'Dev@Example.com' };
const KEY = 'sk-test-0123456789-abcd';

afterEach(() => vi.restoreAllMocks());

function env(over: Partial<Config> = {}, rows: ProviderCredentialRow[] = []) {
  const keys = ProviderKeyCipher.random();
  const store = {
    get: async (userId: string, kind: ProviderKind) =>
      userId === USER.id ? (rows.find((r) => r.kind === kind) ?? null) : null,
  } as unknown as ProviderCredentialStore;
  const config = {
    CLAUDE_CLI_PATH: '/usr/local/bin/claude',
    CLAUDE_CLI_EMAILS: 'dev@example.com',
    BOOTSTRAP_OWNER_EMAIL: 'owner@example.com',
    DEEPGRAM_API_KEY: 'dg-operator-key',
    ...over,
  } as unknown as Config;
  return { config, ports: { providerCredentials: store, providerKeys: keys }, rows, keys };
}

function keyedRow(
  keys: ProviderKeyCipher,
  provider: string,
  model: string,
  baseUrl: string | null = null,
  userId = USER.id,
): ProviderCredentialRow {
  const origin = baseUrl === null ? null : new URL(baseUrl).origin;
  return {
    kind: 'llm',
    provider,
    base_url: baseUrl,
    base_origin: origin,
    model,
    key: keys.encrypt(KEY, { userId, kind: 'llm', provider, origin }),
    created_at_utc: T,
    updated_at_utc: T,
  };
}

const CLI_ROW: ProviderCredentialRow = {
  kind: 'llm',
  provider: 'claude-cli',
  base_url: null,
  base_origin: null,
  model: 'claude-cli',
  key: null,
  created_at_utc: T,
  updated_at_utc: T,
};

describe('resolveLlmRoute (ai-sdk-agent-harness D1)', () => {
  it('gives the CLI for a claude-cli row when the caller is listed and CLAUDE_CLI_PATH is set', async () => {
    for (const dev of [true, false]) {
      const e = env({ PROVIDER_DEV_MODE: dev }, [CLI_ROW]);
      expect(await resolveLlmRoute(e, USER)).toEqual({ kind: 'cli' });
    }
  });

  it('gives null for that row once the email is removed, or with CLAUDE_CLI_PATH blank', async () => {
    expect(await resolveLlmRoute(env({ CLAUDE_CLI_EMAILS: 'other@example.com' }, [CLI_ROW]), USER)).toBeNull();
    expect(await resolveLlmRoute(env({ CLAUDE_CLI_EMAILS: '' }, [CLI_ROW]), USER)).toBeNull();
    for (const path of ['', '   ']) {
      expect(await resolveLlmRoute(env({ CLAUDE_CLI_PATH: path }, [CLI_ROW]), USER)).toBeNull();
    }
    // The bootstrap owner is not implicitly listed.
    expect(
      await resolveLlmRoute(env({ CLAUDE_CLI_EMAILS: '' }, [CLI_ROW]), {
        id: USER.id,
        email: 'owner@example.com',
      }),
    ).toBeNull();
  });

  it('gives the SDK route with the decrypted key for each key provider', async () => {
    for (const [provider, model, baseUrl] of [
      ['anthropic', 'claude-sonnet-4-5', null],
      ['openai', 'gpt-5.5', null],
      ['google', 'gemini-2.5-pro', null],
      ['openai-compatible', 'qwen3', 'https://llm.example.com/v1'],
    ] as const) {
      const e = env();
      e.rows.push(keyedRow(e.keys, provider, model, baseUrl));
      expect(await resolveLlmRoute(e, USER), provider).toEqual({
        kind: 'sdk',
        provider,
        baseUrl,
        baseOrigin: baseUrl === null ? null : new URL(baseUrl).origin,
        model,
        apiKey: KEY,
      });
    }
  });

  it('gives null for a row that does not decrypt, and never falls back', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const e = env({ PROVIDER_DEV_MODE: true });
    // Encrypted for another user: the additional data no longer matches.
    e.rows.push(keyedRow(e.keys, 'anthropic', 'claude-x', null, 'someone-else'));
    expect(await resolveLlmRoute(e, USER)).toBeNull();
    // Encrypted under another deployment secret.
    const other = env();
    other.rows.push(keyedRow(ProviderKeyCipher.random(), 'openai', 'gpt-5.5'));
    expect(await resolveLlmRoute(other, USER)).toBeNull();
  });

  it('gives null for a caller with no row, listed or not, in development and production alike', async () => {
    for (const dev of [true, false, undefined]) {
      for (const email of ['dev@example.com', 'nobody@example.com', 'owner@example.com']) {
        expect(
          await resolveLlmRoute(env({ PROVIDER_DEV_MODE: dev }), { id: USER.id, email }),
          `${dev} ${email}`,
        ).toBeNull();
      }
    }
  });

  it('ignores an stt row', async () => {
    const e = env();
    e.rows.push({ ...keyedRow(e.keys, 'deepgram', 'nova-3'), kind: 'stt' });
    expect(await resolveLlmRoute(e, USER)).toBeNull();
  });
});
