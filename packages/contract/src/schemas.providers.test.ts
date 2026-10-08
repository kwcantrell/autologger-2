// Provider credential routes (byo-ai-providers D4; api-contract-freeze "Provider credential
// routes"): the `PUT /api/me/providers/:kind` body, per kind and per mode, and the response shapes.
// The routes themselves are pinned by `server/src/routers/providers.int`. A NUL anywhere in the body
// is answered by the route with the existing NUL `400` before this schema runs.

import { describe, expect, it } from 'vitest';
import {
  providerCredentialSchema,
  providerKindSchema,
  providerPutBodySchema,
  providersResponseSchema,
  providerTestResponseSchema,
} from './schemas';

const PROD = { production: true };
const DEV = { production: false };
const KEY = 'sk-test-0123456789';
const llm = (over: Record<string, unknown> = {}) => ({
  provider: 'openai-compatible',
  base_url: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  api_key: KEY,
  ...over,
});
const stt = (over: Record<string, unknown> = {}) => ({
  provider: 'deepgram',
  model: 'nova-3',
  api_key: 'dg_secret_abcd',
  ...over,
});
const ok = (kind: 'llm' | 'stt', body: unknown, mode = PROD) =>
  providerPutBodySchema(kind, mode).safeParse(body).success;

describe('providerKindSchema', () => {
  it('is llm or stt only', () => {
    expect(providerKindSchema.safeParse('llm').success).toBe(true);
    expect(providerKindSchema.safeParse('stt').success).toBe(true);
    for (const k of ['tts', 'LLM', '', null])
      expect(providerKindSchema.safeParse(k).success).toBe(false);
  });
});

describe('providerPutBodySchema (byo-ai-providers D4)', () => {
  it('pins the provider per kind', () => {
    expect(ok('llm', llm())).toBe(true);
    expect(ok('stt', stt())).toBe(true);
    expect(ok('llm', llm({ provider: 'deepgram' }))).toBe(false);
    expect(ok('stt', stt({ provider: 'openai-compatible' }))).toBe(false);
  });

  it('requires a base URL for llm and forbids one for stt', () => {
    expect(ok('llm', llm({ base_url: undefined }))).toBe(false);
    expect(ok('llm', llm({ base_url: null }))).toBe(false);
    expect(ok('stt', stt({ base_url: null }))).toBe(true);
    expect(ok('stt', stt({ base_url: 'https://api.deepgram.com' }))).toBe(false);
  });

  it('trims the model and key, and keeps them within their lengths', () => {
    const r = providerPutBodySchema('llm', PROD).safeParse(
      llm({ model: '  gpt-x  ', api_key: `  ${KEY}\n` }),
    );
    expect(r.success).toBe(true);
    if (r.success) expect({ m: r.data.model, k: r.data.api_key }).toEqual({ m: 'gpt-x', k: KEY });
    expect(ok('llm', llm({ model: '' }))).toBe(false);
    expect(ok('llm', llm({ model: 'm'.repeat(200) }))).toBe(true);
    expect(ok('llm', llm({ model: 'm'.repeat(201) }))).toBe(false);
    expect(ok('llm', llm({ api_key: 'k'.repeat(7) }))).toBe(false);
    expect(ok('llm', llm({ api_key: 'k'.repeat(8) }))).toBe(true);
    expect(ok('llm', llm({ api_key: 'k'.repeat(4096) }))).toBe(true);
    expect(ok('llm', llm({ api_key: 'k'.repeat(4097) }))).toBe(false);
  });

  it('refuses a key or model with a space or a control character inside it', () => {
    for (const bad of [
      'sk-abc def',
      'sk-abc\ndef',
      'sk-abc\rdef',
      'sk-abc\tdef',
      'sk-abc\u007fdef',
      'sk-abcédef',
    ]) {
      expect(ok('stt', stt({ api_key: bad })), JSON.stringify(bad)).toBe(false);
      expect(ok('llm', llm({ model: bad })), JSON.stringify(bad)).toBe(false);
    }
  });

  it('makes the key optional (the route decides when it is required)', () => {
    expect(ok('llm', llm({ api_key: undefined }))).toBe(true);
    expect(ok('stt', stt({ api_key: undefined }))).toBe(true);
  });

  it('refuses userinfo, a query, a fragment, a non-http scheme and a URL over 2048 characters in any mode', () => {
    for (const mode of [PROD, DEV]) {
      for (const url of [
        'https://user:pw@api.example.com/v1',
        'https://api.example.com/v1?x=1',
        'https://api.example.com/v1?',
        'https://api.example.com/v1#frag',
        'ftp://api.example.com/v1',
        'api.example.com/v1',
        `https://api.example.com/${'x'.repeat(2048)}`,
      ]) {
        expect(ok('llm', llm({ base_url: url }), mode), `${url} ${mode.production}`).toBe(false);
      }
    }
  });

  it('in production mode needs https on the default port', () => {
    expect(ok('llm', llm({ base_url: 'http://api.example.com/v1' }))).toBe(false);
    expect(ok('llm', llm({ base_url: 'https://api.example.com:8443/v1' }))).toBe(false);
    expect(ok('llm', llm({ base_url: 'https://api.example.com:443/v1' }))).toBe(true);
    expect(ok('llm', llm({ base_url: 'https://API.Example.com/v1' }))).toBe(true);
  });

  it('in development mode allows http, any port and localhost', () => {
    expect(ok('llm', llm({ base_url: 'http://localhost:11434/v1' }), DEV)).toBe(true);
    expect(ok('llm', llm({ base_url: 'http://10.0.0.5:8000/v1' }), DEV)).toBe(true);
  });
});

describe('providerPutBodySchema llm providers (owner decision 10)', () => {
  it('takes openai-compatible, anthropic, openai or google', () => {
    for (const provider of ['anthropic', 'openai', 'google']) {
      expect(ok('llm', { provider, model: 'm-1', api_key: KEY }), provider).toBe(true);
      expect(ok('llm', { provider, base_url: null, model: 'm-1' }), provider).toBe(true);
    }
    expect(ok('llm', llm())).toBe(true);
    expect(ok('llm', llm({ provider: 'mistral' }))).toBe(false);
  });

  it('refuses a base URL for a fixed-host provider and requires one for openai-compatible', () => {
    for (const provider of ['anthropic', 'openai', 'google']) {
      expect(
        ok('llm', { provider, base_url: 'https://api.example.com/v1', model: 'm-1' }),
        provider,
      ).toBe(false);
    }
    expect(ok('llm', { provider: 'openai-compatible', model: 'm-1' })).toBe(false);
  });

  it('applies the key and model rules to every provider', () => {
    expect(ok('llm', { provider: 'anthropic', model: 'claude x', api_key: KEY })).toBe(false);
    expect(ok('llm', { provider: 'google', model: 'gemini', api_key: 'AIza\nX12345' })).toBe(false);
  });

  it('a credential of a fixed-host provider has a null base URL', () => {
    expect(
      providerCredentialSchema.safeParse({ ...CRED_BASE, provider: 'anthropic', base_url: null })
        .success,
    ).toBe(true);
  });
});

const CRED_BASE = {
  kind: 'llm',
  model: 'claude-sonnet-4-5',
  key_last4: 'abcd',
  updated_at: '2026-10-16T12:00:00.000Z',
};
const CRED = {
  kind: 'llm',
  provider: 'openai-compatible',
  base_url: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  key_last4: '9f2c',
  updated_at: '2026-10-16T12:00:00.000Z',
};

describe('provider response schemas', () => {
  it('a credential carries no key field', () => {
    expect(providerCredentialSchema.safeParse(CRED).success).toBe(true);
    expect(
      providerCredentialSchema.safeParse({ ...CRED, kind: 'stt', base_url: null }).success,
    ).toBe(true);
    for (const extra of ['api_key', 'key', 'key_ciphertext', 'key_nonce']) {
      expect(providerCredentialSchema.safeParse({ ...CRED, [extra]: 'x' }).success, extra).toBe(
        false,
      );
    }
    expect(providerCredentialSchema.safeParse({ ...CRED, key_last4: '12345' }).success).toBe(false);
  });

  it('the list is llm, stt and run_features_allowed, each credential nullable', () => {
    expect(
      providersResponseSchema.safeParse({ llm: CRED, stt: null, run_features_allowed: true })
        .success,
    ).toBe(true);
    expect(providersResponseSchema.safeParse({ llm: null, stt: null }).success).toBe(false);
    expect(
      providersResponseSchema.safeParse({
        llm: null,
        stt: null,
        run_features_allowed: false,
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it('a test result is {ok, detail} only', () => {
    expect(providerTestResponseSchema.safeParse({ ok: true, detail: 'Connected.' }).success).toBe(
      true,
    );
    expect(
      providerTestResponseSchema.safeParse({ ok: true, detail: 'Connected.', body: '' }).success,
    ).toBe(false);
  });
});
