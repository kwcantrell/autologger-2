// ProviderCredentialStore port (byo-ai-providers design D1; provider-credentials): per-user
// provider credentials in `catalog.user_provider_credentials` and the master-key check value in
// `catalog.provider_key_check`. `@autologger/storage` implements it on
// `bindSystem('provider-credentials')` (`PostgresProviderCredentialStore`), wired as
// `Bindings.ports.providerCredentials`. The tables have no user RLS, so every credential statement
// is scoped by user id in SQL. The store holds only ciphertext parts; the server encrypts and
// decrypts (design D2), and no plaintext key ever passes through this port.
//
// ai-sdk-agent-harness design D2: the `llm` provider `claude-cli` (the operator's Claude CLI) is
// stored as a keyless row, so `key` is null on that row and every reader handles null as "no
// usable key". The catalog check keeps every other row fully keyed.

export type ProviderKind = 'llm' | 'stt';

/** The keyless `llm` provider: the operator's Claude CLI, with the fixed model of the same name. */
export const CLAUDE_CLI_PROVIDER = 'claude-cli';

/** An API key as stored: AES-256-GCM parts, the key version, and the last four characters. */
export interface StoredProviderKey {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
  version: number;
  last4: string;
}

/** A credential's fields other than its key. `base_url` and `base_origin` are null for `stt`. */
export interface ProviderCredentialFields {
  provider: string;
  base_url: string | null;
  /** The normalized origin of `base_url`; part of the key's additional authenticated data. */
  base_origin: string | null;
  model: string;
}

export interface ProviderCredentialRow extends ProviderCredentialFields {
  kind: ProviderKind;
  /** Null only on the keyless `claude-cli` row. */
  key: StoredProviderKey | null;
  created_at_utc: string;
  updated_at_utc: string;
}

/** A row that carries a key: what `put` and `updateKeepingKey` return. */
export interface KeyedProviderCredentialRow extends ProviderCredentialRow {
  key: StoredProviderKey;
}

export interface ProviderCredentialStore {
  /** The user's credential of this kind, or null. */
  get(userId: string, kind: ProviderKind): Promise<ProviderCredentialRow | null>;
  /** The user's credentials, at most one per kind. */
  list(userId: string): Promise<ProviderCredentialRow[]>;
  /** Creates or replaces the user's credential of this kind with a new key. A replace keeps the
   * creation time. */
  put(
    userId: string,
    kind: ProviderKind,
    fields: ProviderCredentialFields & { key: StoredProviderKey },
  ): Promise<KeyedProviderCredentialRow>;
  /** Creates or replaces the user's `llm` credential with the keyless `claude-cli` row (no key, no
   * base URL, model `claude-cli`). A replace keeps the creation time. The caller checks the
   * allowlist first. */
  putKeyless(
    userId: string,
    kind: 'llm',
    provider: typeof CLAUDE_CLI_PROVIDER,
  ): Promise<ProviderCredentialRow>;
  /** One statement that changes base URL and model and keeps the stored key, only when the row
   * exists with the same provider and `base_origin` (a key is bound to both; owner decision 10). Reads nothing first, so it
   * can never bring back a key deleted or replaced concurrently. Null when no row matched. A
   * keyless row never matches: there is no key to keep, so a switch from `claude-cli` needs a new
   * key through `put`. */
  updateKeepingKey(
    userId: string,
    kind: ProviderKind,
    fields: ProviderCredentialFields,
  ): Promise<KeyedProviderCredentialRow | null>;
  /** Deletes the user's credential of this kind; false when there was none. */
  delete(userId: string, kind: ProviderKind): Promise<boolean>;
  /** Counts one connection test in the user's test window, atomically across processes, and
   * returns the count in the window including this one. The window is per user (both kinds),
   * opens on the first test after the last one ended, lasts a minute by the Clock, and is kept
   * when credentials are deleted. The caller checks the credential exists first. */
  takeTestSlot(userId: string): Promise<number>;
  /** The stored master-key check value, or null before the first production boot. */
  readCheck(): Promise<string | null>;
  /** Stores `value` when no check value exists yet, and returns the stored one (the first written
   * wins, so a mismatch is visible to the caller). */
  writeCheckIfAbsent(value: string): Promise<string>;
}
