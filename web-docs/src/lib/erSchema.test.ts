import { CATALOG_MIGRATIONS_DIR } from '@autologger/catalog';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  buildCatalogSchema,
  buildSessionSchema,
  emitErDiagram,
  introspectSchema,
} from './erSchema';

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

// Audit fix-now F2: these two tests used to pin the live repo's exact
// table/column/FK lists — facts about the CURRENT migrated schema, not
// properties true of any valid schema. Any future migration (adding a
// table, a column, or a foreign key) would red root `npm test` here,
// directly undercutting spec's own "New migration is reflected without
// web-docs edits" scenario. Rewritten as structural properties that hold
// for whatever the live migrations currently produce: at least one
// non-internal table, every table has at least one primary-key column
// (true of every migration on disk today — verified by reading all four
// files), every foreign key references a real table/column pair in the
// SAME schema, and the emitted diagram mentions every table and every
// declared foreign key (never silently drops one), with no internal noise.
describe('buildCatalogSchema — live migrations (@autologger/catalog CATALOG_MIGRATIONS_DIR)', () => {
  it('reflects a non-empty migrated schema, excluding sqlite_%/_migrations, with well-formed columns and internally-consistent foreign keys', () => {
    const schema = buildCatalogSchema(CATALOG_MIGRATIONS_DIR);

    expect(schema.tables.length).toBeGreaterThan(0);
    expect(schema.tables.some((t) => t.name.startsWith('sqlite_'))).toBe(false);
    expect(schema.tables.some((t) => t.name === '_migrations')).toBe(false);

    const tableNames = new Set(schema.tables.map((t) => t.name));
    for (const table of schema.tables) {
      expect(table.columns.length).toBeGreaterThan(0);
      expect(table.columns.some((c) => c.pk)).toBe(true);
    }
    for (const fk of schema.foreignKeys) {
      expect(tableNames.has(fk.fromTable)).toBe(true);
      expect(tableNames.has(fk.toTable)).toBe(true);
    }
  });

  it('emits a catalog erDiagram containing every non-internal table and every declared foreign-key relationship, with no internal noise', () => {
    const schema = buildCatalogSchema(CATALOG_MIGRATIONS_DIR);
    const source = emitErDiagram(schema, { title: 'catalog' });

    for (const table of schema.tables) {
      expect(source).toContain(`${table.name} {`);
    }
    expect(source).not.toContain('sqlite_');
    expect(source).not.toContain('_migrations');
    for (const fk of schema.foreignKeys) {
      expect(source).toContain(`${fk.toTable} ||--o{ ${fk.fromTable} : "${fk.fromColumn}"`);
    }
  });
});

describe('buildSessionSchema — live SessionCore.initSchema()', () => {
  it('reflects a non-empty schema, excluding sqlite_%/_migrations, with well-formed columns and internally-consistent foreign keys', () => {
    const schema = buildSessionSchema();

    expect(schema.tables.length).toBeGreaterThan(0);
    expect(schema.tables.some((t) => t.name.startsWith('sqlite_'))).toBe(false);
    expect(schema.tables.some((t) => t.name === '_migrations')).toBe(false);

    const tableNames = new Set(schema.tables.map((t) => t.name));
    for (const table of schema.tables) {
      expect(table.columns.length).toBeGreaterThan(0);
      expect(table.columns.some((c) => c.pk)).toBe(true);
    }
    for (const fk of schema.foreignKeys) {
      expect(tableNames.has(fk.fromTable)).toBe(true);
      expect(tableNames.has(fk.toTable)).toBe(true);
    }
  });

  it('emits a session erDiagram containing every initSchema table and every declared foreign-key relationship, with no internal noise', () => {
    const schema = buildSessionSchema();
    const source = emitErDiagram(schema, { title: 'session' });

    for (const table of schema.tables) {
      expect(source).toContain(`${table.name} {`);
    }
    for (const fk of schema.foreignKeys) {
      expect(source).toContain(`${fk.toTable} ||--o{ ${fk.fromTable} : "${fk.fromColumn}"`);
    }
    if (schema.foreignKeys.length === 0) {
      expect(source).not.toContain('||--o{');
    }
    expect(source).not.toContain('sqlite_');
    expect(source).not.toContain('_migrations');
  });

  it('two calls produce structurally identical schemas (determinism; no row data involved)', () => {
    const a = buildSessionSchema();
    const b = buildSessionSchema();
    expect(a).toEqual(b);
  });
});
