// Provider key encryption at rest (byo-ai-providers design D2; provider-credentials "Provider keys
// are encrypted at rest and write-only"): AES-256-GCM under a key derived from
// PROVIDER_KEYS_SECRET, with the user id, the kind and the LLM origin as additional data. A failed
// decryption is `null`, never an exception carrying key material.
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  keyLast4,
  PROVIDER_KEY_VERSION,
  ProviderKeyCipher,
  ProviderKeysSecretError,
  parseProviderKeysSecret,
} from './providerKeyCrypto';

const secret = () => randomBytes(32).toString('base64');
const A = {
  userId: 'ua',
  kind: 'llm' as const,
  provider: 'openai-compatible',
  origin: 'https://api.example.com',
};
const KEY = 'sk-test-0123456789-9f2c';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseProviderKeysSecret', () => {
  it('accepts base64 that decodes to exactly 32 bytes', () => {
    const s = secret();
    expect(parseProviderKeysSecret(s)).toEqual(Buffer.from(s, 'base64'));
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['16 bytes', randomBytes(16).toString('base64')],
    ['33 bytes', randomBytes(33).toString('base64')],
    ['not base64', `${'!'.repeat(43)}=`],
  ])('refuses a %s secret, naming the variable and not the value', (_label, value) => {
    let err: unknown;
    try {
      parseProviderKeysSecret(value);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderKeysSecretError);
    const msg = (err as Error).message;
    expect(msg).toMatch(/PROVIDER_KEYS_SECRET/);
    if (value?.trim()) expect(msg).not.toContain(value.trim());
  });
});

describe('ProviderKeyCipher (design D2)', () => {
  it('round-trips a key and records version and last four characters', () => {
    const c = new ProviderKeyCipher(parseProviderKeysSecret(secret()));
    const stored = c.encrypt(KEY, A);
    expect(stored.version).toBe(PROVIDER_KEY_VERSION);
    expect(stored.last4).toBe('9f2c');
    expect(stored.nonce).toHaveLength(12);
    expect(stored.tag).toHaveLength(16);
    expect(Buffer.from(stored.ciphertext).toString('utf8')).not.toContain(KEY);
    expect(c.decrypt(stored, A)).toBe(KEY);
  });

  it('uses a fresh nonce, so the same key encrypts differently each time', () => {
    const c = new ProviderKeyCipher(parseProviderKeysSecret(secret()));
    const a = c.encrypt(KEY, A);
    const b = c.encrypt(KEY, A);
    expect(Buffer.from(a.nonce).equals(Buffer.from(b.nonce))).toBe(false);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  it('gives null, and logs only the user id and kind, when anything is tampered with', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = new ProviderKeyCipher(parseProviderKeysSecret(secret()));
    const s = c.encrypt(KEY, A);
    const flip = (b: Uint8Array) => {
      const x = Uint8Array.from(b);
      x[0] = (x[0] ?? 0) ^ 1;
      return x;
    };
    expect(c.decrypt({ ...s, tag: flip(s.tag) }, A)).toBeNull();
    expect(c.decrypt({ ...s, ciphertext: flip(s.ciphertext) }, A)).toBeNull();
    expect(c.decrypt({ ...s, nonce: flip(s.nonce) }, A)).toBeNull();
    expect(c.decrypt({ ...s, nonce: s.nonce.slice(0, 8) }, A)).toBeNull();
    expect(c.decrypt({ ...s, version: 2 }, A)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(5);
    for (const call of warn.mock.calls) {
      const line = call.map(String).join(' ');
      expect(line).toContain('ua');
      expect(line).toContain('llm');
      expect(line).not.toContain(KEY);
      expect(line).not.toContain(Buffer.from(s.ciphertext).toString('hex'));
    }
  });

  it('binds the user, the kind and the origin: another one gives null', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = new ProviderKeyCipher(parseProviderKeysSecret(secret()));
    const s = c.encrypt(KEY, A);
    expect(c.decrypt(s, { ...A, userId: 'ub' })).toBeNull();
    expect(c.decrypt(s, { ...A, kind: 'stt' })).toBeNull();
    expect(c.decrypt(s, { ...A, origin: 'https://evil.example' })).toBeNull();
    // stt keys carry an empty origin.
    const t = c.encrypt(KEY, { userId: 'ua', kind: 'stt', provider: 'deepgram', origin: null });
    expect(c.decrypt(t, { userId: 'ua', kind: 'stt', provider: 'deepgram', origin: null })).toBe(
      KEY,
    );
  });

  it('binds the provider: another provider with the same user, kind and origin gives null (owner decision 10)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = new ProviderKeyCipher(parseProviderKeysSecret(secret()));
    const fixed = { userId: 'ua', kind: 'llm' as const, provider: 'anthropic', origin: null };
    const s = c.encrypt(KEY, fixed);
    expect(c.decrypt(s, fixed)).toBe(KEY);
    for (const provider of ['openai', 'google', 'openai-compatible']) {
      expect(c.decrypt(s, { ...fixed, provider }), provider).toBeNull();
    }
    expect(c.decrypt(c.encrypt(KEY, A), { ...A, provider: 'openai' })).toBeNull();
  });

  it('another secret cannot decrypt', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new ProviderKeyCipher(parseProviderKeysSecret(secret())).encrypt(KEY, A);
    expect(new ProviderKeyCipher(parseProviderKeysSecret(secret())).decrypt(s, A)).toBeNull();
  });

  it('has a check value that is stable for a secret, differs between secrets, and is not the secret', () => {
    const raw = secret();
    const one = new ProviderKeyCipher(parseProviderKeysSecret(raw)).checkValue();
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(new ProviderKeyCipher(parseProviderKeysSecret(raw)).checkValue()).toBe(one);
    expect(new ProviderKeyCipher(parseProviderKeysSecret(secret())).checkValue()).not.toBe(one);
    expect(one).not.toContain(Buffer.from(raw, 'base64').toString('hex'));
  });

  it('a random cipher works for its own process', () => {
    const c = ProviderKeyCipher.random();
    expect(c.decrypt(c.encrypt(KEY, A), A)).toBe(KEY);
  });
});

describe('keyLast4', () => {
  it('is the last four characters of the trimmed key', () => {
    expect(keyLast4('  sk-abcdef  ')).toBe('cdef');
    expect(keyLast4('abc')).toBe('abc');
  });
});
