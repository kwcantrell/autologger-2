// The ProviderCredentialStore port on `catalog.user_provider_credentials` and
// `catalog.provider_key_check` (byo-ai-providers design D1). It binds its own reviewed system
// reason, `provider-credentials` (RLS `catalog_system` allow-all; `catalog_user` has no privilege on
// either table). There is no user RLS, so the `user_id` predicates here are the only isolation
// between users. It stores only ciphertext parts. Every time it writes comes from the Clock port.

import type {
  CatalogDb,
  CatalogRoot,
  ClaudeCliProvider,
  Clock,
  KeyedProviderCredentialRow,
  ProviderCredentialFields,
  ProviderCredentialRow,
  ProviderCredentialStore,
  ProviderKind,
  StoredProviderKey,
} from '@autologger/ports';

/** At most this many connection tests per test window (provider-credentials). */
export const PROVIDER_TEST_LIMIT = 5;
/** A test window lasts this long, from the first test after the previous window ended. Kept per
 * user in `catalog.provider_test_windows`, across kinds and across deleted credentials. */
export const PROVIDER_TEST_WINDOW_MS = 60_000;

/** The keyless `claude-cli` row's fixed model (ai-sdk-agent-harness D2). */
const CLAUDE_CLI_MODEL: ClaudeCliProvider = 'claude-cli';

const iso = (ms: number) => new Date(ms).toISOString();

const COLUMNS = `kind, provider, base_url, base_origin, model, key_nonce, key_ciphertext, key_tag,
  key_version, key_last4, created_at_utc, updated_at_utc`;

/** A row as read. The catalog check makes the five key columns all null (the `claude-cli` row) or
 * all set, so `key_ciphertext` alone decides. */
function toRow(r: Record<string, unknown>): ProviderCredentialRow {
  const bytes = (v: unknown) => new Uint8Array(v as Uint8Array);
  return {
    kind: r.kind as ProviderKind,
    provider: String(r.provider),
    base_url: r.base_url === null ? null : String(r.base_url),
    base_origin: r.base_origin === null ? null : String(r.base_origin),
    model: String(r.model),
    key:
      r.key_ciphertext === null
        ? null
        : {
            nonce: bytes(r.key_nonce),
            ciphertext: bytes(r.key_ciphertext),
            tag: bytes(r.key_tag),
            version: Number(r.key_version),
            last4: String(r.key_last4),
          },
    created_at_utc: String(r.created_at_utc),
    updated_at_utc: String(r.updated_at_utc),
  };
}

function toKeyedRow(r: Record<string, unknown>): KeyedProviderCredentialRow {
  const row = toRow(r);
  if (row.key === null) throw new Error('provider credential row has no key');
  return { ...row, key: row.key };
}

const buf = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength);

export class PostgresProviderCredentialStore implements ProviderCredentialStore {
  private readonly db: CatalogDb;

  constructor(
    root: CatalogRoot,
    private readonly clock: Clock,
  ) {
    this.db = root.bindSystem('provider-credentials');
  }

  async get(userId: string, kind: ProviderKind): Promise<ProviderCredentialRow | null> {
    const r = await this.db.first<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM user_provider_credentials WHERE user_id = ? AND kind = ?`,
      userId,
      kind,
    );
    return r === null ? null : toRow(r);
  }

  async list(userId: string): Promise<ProviderCredentialRow[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM user_provider_credentials WHERE user_id = ? ORDER BY kind`,
      userId,
    );
    return rows.map(toRow);
  }

  async put(
    userId: string,
    kind: ProviderKind,
    fields: ProviderCredentialFields & { key: StoredProviderKey },
  ): Promise<KeyedProviderCredentialRow> {
    const now = iso(this.clock.now());
    const k = fields.key;
    const r = await this.db.first<Record<string, unknown>>(
      `INSERT INTO user_provider_credentials
         (user_id, kind, provider, base_url, base_origin, model, key_nonce, key_ciphertext,
          key_tag, key_version, key_last4, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, kind) DO UPDATE SET
         provider = excluded.provider, base_url = excluded.base_url,
         base_origin = excluded.base_origin, model = excluded.model,
         key_nonce = excluded.key_nonce, key_ciphertext = excluded.key_ciphertext,
         key_tag = excluded.key_tag, key_version = excluded.key_version,
         key_last4 = excluded.key_last4, updated_at_utc = excluded.updated_at_utc
       RETURNING ${COLUMNS}`,
      userId,
      kind,
      fields.provider,
      fields.base_url,
      fields.base_origin,
      fields.model,
      buf(k.nonce),
      buf(k.ciphertext),
      buf(k.tag),
      k.version,
      k.last4,
      now,
      now,
    );
    if (r === null) throw new Error('provider credential upsert returned no row');
    return toKeyedRow(r);
  }

  async putKeyless(
    userId: string,
    kind: 'llm',
    provider: ClaudeCliProvider,
  ): Promise<ProviderCredentialRow> {
    const now = iso(this.clock.now());
    const r = await this.db.first<Record<string, unknown>>(
      `INSERT INTO user_provider_credentials
         (user_id, kind, provider, base_url, base_origin, model, key_nonce, key_ciphertext,
          key_tag, key_version, key_last4, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
       ON CONFLICT (user_id, kind) DO UPDATE SET
         provider = excluded.provider, base_url = NULL, base_origin = NULL,
         model = excluded.model, key_nonce = NULL, key_ciphertext = NULL, key_tag = NULL,
         key_version = NULL, key_last4 = NULL, updated_at_utc = excluded.updated_at_utc
       RETURNING ${COLUMNS}`,
      userId,
      kind,
      provider,
      CLAUDE_CLI_MODEL,
      now,
      now,
    );
    if (r === null) throw new Error('provider credential upsert returned no row');
    return toRow(r);
  }

  async updateKeepingKey(
    userId: string,
    kind: ProviderKind,
    fields: ProviderCredentialFields,
  ): Promise<KeyedProviderCredentialRow | null> {
    // `key_ciphertext IS NOT NULL`: a keyless (`claude-cli`) row has no key to keep.
    const r = await this.db.first<Record<string, unknown>>(
      `UPDATE user_provider_credentials
          SET base_url = ?, model = ?, updated_at_utc = ?
        WHERE user_id = ? AND kind = ? AND provider = ? AND base_origin IS NOT DISTINCT FROM ?
          AND key_ciphertext IS NOT NULL
       RETURNING ${COLUMNS}`,
      fields.base_url,
      fields.model,
      iso(this.clock.now()),
      userId,
      kind,
      fields.provider,
      fields.base_origin,
    );
    return r === null ? null : toKeyedRow(r);
  }

  async delete(userId: string, kind: ProviderKind): Promise<boolean> {
    const { changes } = await this.db.run(
      'DELETE FROM user_provider_credentials WHERE user_id = ? AND kind = ?',
      userId,
      kind,
    );
    return changes > 0;
  }

  /** One upsert on the user's window row: its row lock serializes concurrent tests across
   * processes, and the row outlives the user's credentials (re-panel). */
  async takeTestSlot(userId: string): Promise<number> {
    const now = this.clock.now();
    const r = await this.db.first<{ n: number }>(
      `INSERT INTO provider_test_windows (user_id, window_start_ms, test_count) VALUES (?, ?, 1)
       ON CONFLICT (user_id) DO UPDATE SET
         test_count = CASE WHEN excluded.window_start_ms - provider_test_windows.window_start_ms >= ?
                           THEN 1 ELSE provider_test_windows.test_count + 1 END,
         window_start_ms = CASE WHEN excluded.window_start_ms - provider_test_windows.window_start_ms >= ?
                                THEN excluded.window_start_ms ELSE provider_test_windows.window_start_ms END
       RETURNING test_count::int AS n`,
      userId,
      now,
      PROVIDER_TEST_WINDOW_MS,
      PROVIDER_TEST_WINDOW_MS,
    );
    if (r === null) throw new Error('provider test window upsert returned no row');
    return Number(r.n);
  }

  async readCheck(): Promise<string | null> {
    const r = await this.db.first<{ check_value: string }>(
      'SELECT check_value FROM provider_key_check WHERE id = 1',
    );
    return r === null ? null : String(r.check_value);
  }

  async writeCheckIfAbsent(value: string): Promise<string> {
    await this.db.run(
      `INSERT INTO provider_key_check (id, check_value, created_at_utc) VALUES (1, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      value,
      iso(this.clock.now()),
    );
    const stored = await this.readCheck();
    if (stored === null) throw new Error('provider key check value was not stored');
    return stored;
  }
}
