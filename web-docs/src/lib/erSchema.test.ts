import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  buildCatalogSchema,
  buildSessionSchema,
  emitErDiagram,
  introspectSchema,
} from './erSchema';
import { repoRoot } from './repo';

describe('introspectSchema — fixture databases', () => {
  it('excludes sqlite_% internal objects and the migrator bookkeeping table', () => {
    const db = new Database(':memory:');
    // AUTOINCREMENT forces sqlite to materialize sqlite_sequence — a real
    // sqlite_% internal table, not a stand-in.
    db.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)');
    db.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at_utc TEXT NOT NULL)');

    const schema = introspectSchema(db);

    expect(schema.tables.map((t) => t.name)).toEqual(['widgets']);
    expect(schema.tables.some((t) => t.name.startsWith('sqlite_'))).toBe(false);
    expect(schema.tables.some((t) => t.name === '_migrations')).toBe(false);
  });

  it('captures column name/type/notNull/pk', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE people (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        nickname TEXT
      )
    `);

    const schema = introspectSchema(db);
    const table = schema.tables.find((t) => t.name === 'people');
    expect(table).toBeDefined();
    expect(table?.columns).toEqual([
      { name: 'email', type: 'TEXT', notNull: true, pk: false },
      { name: 'id', type: 'TEXT', notNull: false, pk: true },
      { name: 'nickname', type: 'TEXT', notNull: false, pk: false },
    ]);
  });

  it('captures foreign keys, sorted, excluding self-referential noise from unrelated tables', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE parents (id TEXT PRIMARY KEY);
      CREATE TABLE children (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES parents(id),
        other_parent_id TEXT REFERENCES parents(id)
      );
      CREATE TABLE unrelated (id TEXT PRIMARY KEY);
    `);

    const schema = introspectSchema(db);
    expect(schema.foreignKeys).toEqual([
      { fromTable: 'children', fromColumn: 'other_parent_id', toTable: 'parents', toColumn: 'id' },
      { fromTable: 'children', fromColumn: 'parent_id', toTable: 'parents', toColumn: 'id' },
    ]);
  });

  it('sorts tables and columns by name regardless of CREATE TABLE order', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE zebra (z_col TEXT, a_col TEXT);
      CREATE TABLE alpha (b_col TEXT, a_col TEXT);
    `);

    const schema = introspectSchema(db);
    expect(schema.tables.map((t) => t.name)).toEqual(['alpha', 'zebra']);
    expect(schema.tables[0]?.columns.map((c) => c.name)).toEqual(['a_col', 'b_col']);
    expect(schema.tables[1]?.columns.map((c) => c.name)).toEqual(['a_col', 'z_col']);
  });
});

describe('emitErDiagram — mermaid erDiagram source generation', () => {
  it('emits a table block with PK and NOT NULL attribute comments', () => {
    const source = emitErDiagram({
      tables: [
        {
          name: 'people',
          columns: [
            { name: 'id', type: 'TEXT', notNull: false, pk: true },
            { name: 'email', type: 'TEXT', notNull: true, pk: false },
            { name: 'nickname', type: 'TEXT', notNull: false, pk: false },
          ],
        },
      ],
      foreignKeys: [],
    });

    expect(source.startsWith('erDiagram\n')).toBe(true);
    expect(source).toContain('people {');
    expect(source).toContain('TEXT id "PK"');
    expect(source).toContain('TEXT email "NOT NULL"');
    expect(source).toContain('TEXT nickname');
    expect(source).not.toContain('nickname "');
  });

  it('emits a relationship line per foreign key', () => {
    const source = emitErDiagram({
      tables: [
        { name: 'parents', columns: [{ name: 'id', type: 'TEXT', notNull: false, pk: true }] },
        {
          name: 'children',
          columns: [{ name: 'parent_id', type: 'TEXT', notNull: false, pk: false }],
        },
      ],
      foreignKeys: [
        { fromTable: 'children', fromColumn: 'parent_id', toTable: 'parents', toColumn: 'id' },
      ],
    });

    expect(source).toContain('parents ||--o{ children : "parent_id"');
  });

  it('emits a valid diagram with zero foreign keys (no relationship lines)', () => {
    const source = emitErDiagram({
      tables: [{ name: 'solo', columns: [{ name: 'id', type: 'TEXT', notNull: false, pk: true }] }],
      foreignKeys: [],
    });
    expect(source).toContain('solo {');
    expect(source).not.toContain('||--o{');
  });
});

describe('buildCatalogSchema — live migrations (server/src/db/migrations)', () => {
  it('reflects every non-internal migrated table, its columns, and the 3 declared foreign keys', () => {
    const root = repoRoot();
    const schema = buildCatalogSchema(path.join(root, 'server/src/db/migrations'));

    expect(schema.tables.some((t) => t.name.startsWith('sqlite_'))).toBe(false);
    expect(schema.tables.some((t) => t.name === '_migrations')).toBe(false);

    const tableNames = schema.tables.map((t) => t.name);
    expect(tableNames).toEqual(
      [
        'app_settings',
        'kv',
        'sessions',
        'shows',
        'studio_definitions',
        'team_invites',
        'user_prefs',
        'user_studio_memberships',
        'users',
      ].sort(),
    );

    const users = schema.tables.find((t) => t.name === 'users');
    expect(users?.columns.map((c) => c.name)).toEqual(
      [
        'created_at_utc',
        'disabled_at_utc',
        'email',
        'family_name',
        'given_name',
        'google_sub',
        'id',
        'picture_url',
      ].sort(),
    );
    expect(users?.columns.find((c) => c.name === 'id')?.pk).toBe(true);
    expect(users?.columns.find((c) => c.name === 'email')?.notNull).toBe(true);

    // design.md D5: "the current schema declares few foreign keys (3 in
    // catalog, 0 in session)" — pinned here so this test notices drift.
    expect(schema.foreignKeys).toEqual([
      {
        fromTable: 'sessions',
        fromColumn: 'show_id',
        toTable: 'shows',
        toColumn: 'id',
      },
      {
        fromTable: 'user_prefs',
        fromColumn: 'user_id',
        toTable: 'users',
        toColumn: 'id',
      },
      {
        fromTable: 'user_studio_memberships',
        fromColumn: 'user_id',
        toTable: 'users',
        toColumn: 'id',
      },
    ]);
  });

  it('emits a catalog erDiagram containing every non-internal table and the 3 FK relationships', () => {
    const root = repoRoot();
    const schema = buildCatalogSchema(path.join(root, 'server/src/db/migrations'));
    const source = emitErDiagram(schema, { title: 'catalog' });

    for (const table of schema.tables) {
      expect(source).toContain(`${table.name} {`);
    }
    expect(source).not.toContain('sqlite_');
    expect(source).not.toContain('_migrations');
    expect(source).toContain('shows ||--o{ sessions : "show_id"');
    expect(source).toContain('users ||--o{ user_prefs : "user_id"');
    expect(source).toContain('users ||--o{ user_studio_memberships : "user_id"');
  });
});

describe('buildSessionSchema — live SessionCore.initSchema()', () => {
  it('reflects every table initSchema() creates, with zero foreign keys', () => {
    const schema = buildSessionSchema();

    const tableNames = schema.tables.map((t) => t.name);
    expect(tableNames).toEqual(
      [
        'events',
        'meta',
        'session_audio_segments',
        'session_dashboards',
        'session_topics',
        'session_transcript_paragraphs',
        'session_transcript_sentiment',
        'session_transcript_words',
        'session_transport',
      ].sort(),
    );
    expect(schema.tables.some((t) => t.name.startsWith('sqlite_'))).toBe(false);
    expect(schema.tables.some((t) => t.name === '_migrations')).toBe(false);

    const events = schema.tables.find((t) => t.name === 'events');
    expect(events?.columns.map((c) => c.name)).toEqual(
      [
        'category',
        'frame_rate',
        'id',
        'message',
        'metadata_json',
        'timecode_total_frames',
        'wall_time_utc',
      ].sort(),
    );
    expect(events?.columns.find((c) => c.name === 'id')?.pk).toBe(true);

    // design.md D5: "0 [foreign keys] in session".
    expect(schema.foreignKeys).toEqual([]);
  });

  it('emits a session erDiagram containing every initSchema table and no relationship lines', () => {
    const schema = buildSessionSchema();
    const source = emitErDiagram(schema, { title: 'session' });

    for (const table of schema.tables) {
      expect(source).toContain(`${table.name} {`);
    }
    expect(source).not.toContain('||--o{');
    expect(source).not.toContain('sqlite_');
    expect(source).not.toContain('_migrations');
  });

  it('two calls produce structurally identical schemas (determinism; no row data involved)', () => {
    const a = buildSessionSchema();
    const b = buildSessionSchema();
    expect(a).toEqual(b);
  });
});
