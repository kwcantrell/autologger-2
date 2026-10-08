// Provider key encryption at rest (byo-ai-providers design D2; provider-credentials "Provider keys
// are encrypted at rest and write-only"). PROVIDER_KEYS_SECRET is base64 of exactly 32 bytes; two
// keys are derived from it with HKDF-SHA256, one for AES-256-GCM and one for the check value that
// ties stored keys to the secret. The additional data binds the owning user, the kind and, for an
// LLM, the base URL's normalized origin, so a ciphertext never decrypts for another row or host.
// A failed decryption is `null` plus one log line with the user id and kind; nothing here ever
// logs or throws key material.

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { ProviderKind, StoredProviderKey } from '@autologger/ports';

export const PROVIDER_KEY_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ENCRYPT_INFO = 'autologger provider keys v1';
const CHECK_INFO = 'autologger provider keys check v1';
const CHECK_LABEL = 'provider-keys-check';

/** A missing, malformed or mismatched PROVIDER_KEYS_SECRET. Its message never holds the value. */
export class ProviderKeysSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderKeysSecretError';
  }
}

/** The 32 secret bytes, or ProviderKeysSecretError. */
export function parseProviderKeysSecret(value: string | undefined): Buffer {
  const v = (value ?? '').trim();
  if (!v) throw new ProviderKeysSecretError('PROVIDER_KEYS_SECRET is not set');
  const bytes = /^[A-Za-z0-9+/]+={0,2}$/.test(v) ? Buffer.from(v, 'base64') : null;
  if (bytes === null || bytes.length !== 32 || bytes.toString('base64') !== v) {
    throw new ProviderKeysSecretError(
      'PROVIDER_KEYS_SECRET must be base64 of exactly 32 bytes (openssl rand -base64 32)',
    );
  }
  return bytes;
}

/** The additional data a key is bound to. `origin` is null for kinds without a base URL. */
export interface ProviderKeyBinding {
  userId: string;
  kind: ProviderKind;
  origin: string | null;
}

const aad = (b: ProviderKeyBinding) => Buffer.from(`${b.userId}\0${b.kind}\0${b.origin ?? ''}`);

/** The last four characters of the trimmed key: all that is ever shown back. */
export function keyLast4(key: string): string {
  return key.trim().slice(-4);
}

export class ProviderKeyCipher {
  private readonly encKey: Buffer;
  private readonly checkKey: Buffer;

  constructor(secret: Buffer) {
    this.encKey = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), ENCRYPT_INFO, 32));
    this.checkKey = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), CHECK_INFO, 32));
  }

  /** A cipher on a per-process random secret, for entry points that don't require the variable. */
  static random(): ProviderKeyCipher {
    return new ProviderKeyCipher(randomBytes(32));
  }

  encrypt(key: string, binding: ProviderKeyBinding): StoredProviderKey {
    const plain = key.trim();
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(binding));
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return {
      nonce: new Uint8Array(nonce),
      ciphertext: new Uint8Array(ciphertext),
      tag: new Uint8Array(cipher.getAuthTag()),
      version: PROVIDER_KEY_VERSION,
      last4: keyLast4(plain),
    };
  }

  decrypt(stored: StoredProviderKey, binding: ProviderKeyBinding): string | null {
    try {
      if (stored.version !== PROVIDER_KEY_VERSION) throw new Error('version');
      if (stored.nonce.length !== NONCE_BYTES || stored.tag.length !== TAG_BYTES) {
        throw new Error('length');
      }
      const decipher = createDecipheriv('aes-256-gcm', this.encKey, stored.nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aad(binding));
      decipher.setAuthTag(stored.tag);
      return Buffer.concat([decipher.update(stored.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      // Never the error itself: only who and which kind (provider-credentials).
      console.warn(`provider key unreadable user=${binding.userId} kind=${binding.kind}`);
      return null;
    }
  }

  /** HMAC-SHA256 of a fixed label under the derived check key, hex. Never the secret. */
  checkValue(): string {
    return createHmac('sha256', this.checkKey).update(CHECK_LABEL).digest('hex');
  }
}
