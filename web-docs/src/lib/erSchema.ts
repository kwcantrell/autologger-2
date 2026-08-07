// ER schema extraction via live schema introspection (design.md D5; spec "ER
// diagrams are produced by schema introspection"). Never parses DDL text:
// the catalog schema is built by running the real migration files through
// the server's exported `applyMigrations(db, dir)` against a bare in-memory
// better-sqlite3 handle (no WAL pragma — meaningless on `:memory:`), and the
// session schema by constructing the server's exported `SessionCore` over a
// second in-memory handle — wrapped with the exported `sqliteSessionSql`
// adapter and inert clock/sockets/alarm runtime stubs, the exact pattern
// `@autologger/session-core`'s own `test/fakeCore.ts` (package-internal test
// infrastructure) already uses for domain-store unit tests — then calling
// its `initSchema()`. Both are introspected via
// `sqlite_master` / `pragma table_info` / `pragma foreign_key_list` and
// reduced to a typed, sorted `ERSchema`; `emitErDiagram` renders that into a
// mermaid `erDiagram` source string.
//
// Package coupling (design.md Risks — "Docs build coupled to server
// internals"): this module imports `applyMigrations` from
// `@autologger/storage` (persistence-package-extraction task 2.2 — formerly
// server/src/node/migrate.ts) and `SessionCore` / `sqliteSessionSql` from
// `@autologger/session-core` (task 4.3 — formerly
// server/src/session/{sessionCore,SessionHub}.ts). A future rename or
// signature change to any of the three breaks `docs:check`, not root
// `npm test` — the coupling is narrow, read-only, and named here so a
// future whole-branch review checks these call sites when those seams move.
// Measured empirically before writing this module: importing
// `sqliteSessionSql` from SessionHub.ts transitively pulls in every domain
// store (AudioStore, DashboardStore, EventStore, LeaseStore, TopicStore,
// TranscriptStore, TransportStore) under `tsx` — all side-effect-free at
// module load (no top-level `process.env`/fs reads), so the import resolves
// and runs cleanly with no fallback to hand-rolled stubs needed.

import type { SessionRuntime } from '@autologger/session-core';
import { SessionCore, sqliteSessionSql } from '@autologger/session-core';
import { applyMigrations } from '@autologger/storage';
import Database from 'better-sqlite3';

/** SQLite-internal objects and the migrator's own bookkeeping table are
 * never part of the app schema (spec "excludes sqlite_% and _migrations"). */
function isInternalTable(name: string): boolean {
  return name.startsWith('sqlite_') || name === '_migrations';
}

export interface ERColumn {
  name: string;
  type: string;
  notNull: boolean;
  pk: boolean;
}

export interface ERForeignKey {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export interface ERTable {
  name: string;
  columns: ERColumn[];
}

export interface ERSchema {
  tables: ERTable[];
  foreignKeys: ERForeignKey[];
}

interface SqliteMasterRow {
  name: string;
}
interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}
interface ForeignKeyListRow {
  table: string;
  from: string;
  to: string;
}

/** Double-quoted SQLite identifier. Table names here always come from a
 * prior `sqlite_master` read of our own schema (never user input), but
 * pragma statements accept no bound parameters, so this keeps the
 * interpolation deliberate and documented rather than a bare template
 * literal. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Introspects the given open database's current schema — tables, columns,
 * and foreign keys — excluding sqlite-internal objects and `_migrations`.
 * Never reads or parses any `.sql` file; every fact comes from live
 * `sqlite_master` / `pragma table_info` / `pragma foreign_key_list` queries
 * against the real, already-materialized schema (spec "DDL text SHALL NOT
 * be parsed directly", "only schema (never row data) SHALL be captured" —
 * this function issues no `SELECT` against any application table, only
 * schema-catalog pragmas). Output is fully sorted (tables by name, columns
 * by name within each table, foreign keys by from-table/from-column/
 * to-table/to-column) so two introspections of an identical schema are
 * structurally identical regardless of `CREATE TABLE` column order (spec
 * "Builds are deterministic").
 */
export function introspectSchema(db: Database.Database): ERSchema {
  const tableNames = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as SqliteMasterRow[]
  )
    .map((row) => row.name)
    .filter((name) => !isInternalTable(name));

  const tables: ERTable[] = tableNames
    .map((name) => {
      const columns = (db.pragma(`table_info(${quoteIdent(name)})`) as TableInfoRow[])
        .map((col) => ({
          name: col.name,
          type: col.type,
          notNull: col.notnull !== 0,
          pk: col.pk !== 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { name, columns };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const foreignKeys: ERForeignKey[] = tableNames
    .flatMap((fromTable) =>
      (db.pragma(`foreign_key_list(${quoteIdent(fromTable)})`) as ForeignKeyListRow[]).map(
        (fk) => ({
          fromTable,
          fromColumn: fk.from,
          toTable: fk.table,
          toColumn: fk.to,
        }),
      ),
    )
    .sort(
      (a, b) =>
        a.fromTable.localeCompare(b.fromTable) ||
        a.fromColumn.localeCompare(b.fromColumn) ||
        a.toTable.localeCompare(b.toTable) ||
        a.toColumn.localeCompare(b.toColumn),
    );

  return { tables, foreignKeys };
}

/**
 * Builds the catalog schema by running the real migration files, in
 * lexical order, through the server's exported `applyMigrations(db, dir)`
 * against a bare in-memory database, then introspecting the result.
 * `migrationsDir` is a filesystem path — repo-relative resolution is the
 * caller's job (see scripts/check.ts).
 */
export function buildCatalogSchema(migrationsDir: string): ERSchema {
  const db = new Database(':memory:');
  try {
    applyMigrations(db, migrationsDir);
    return introspectSchema(db);
  } finally {
    db.close();
  }
}

/**
 * Builds the session schema by constructing the server's exported
 * `SessionCore` over a bare in-memory database — wrapped with the exported
 * `sqliteSessionSql` adapter and inert clock/sockets/alarm stubs, the exact
 * pattern `server/src/test/fakeCore.ts` uses for domain-store unit tests —
 * calling its `initSchema()`, then introspecting the result. `initSchema()`
 * only ever calls `this.db.exec(...)` (verified by reading its body), so
 * the `clock`/`sockets`/`setAlarm` stubs are never actually invoked here —
 * they exist only to satisfy `SessionRuntime`'s shape.
 */
export function buildSessionSchema(): ERSchema {
  const db = new Database(':memory:');
  try {
    const runtime: SessionRuntime = {
      sql: sqliteSessionSql(db),
      clock: { now: () => 0 },
      sockets: () => [],
      setAlarm: () => {},
    };
    new SessionCore(runtime).initSchema();
    return introspectSchema(db);
  } finally {
    db.close();
  }
}

export interface EmitErDiagramOptions {
  /** Rendered as a mermaid comment line (`%% ...`) at the top of the diagram. */
  title?: string;
}

/** SQLite column types are occasionally empty (an untyped column
 * declaration is legal SQL) or contain spaces; mermaid's ER grammar wants a
 * single ATTRIBUTE_WORD token for the type position. */
function sanitizeType(type: string): string {
  const trimmed = type.trim();
  if (trimmed.length === 0) return 'ANY';
  return trimmed.replace(/\s+/g, '_');
}

/**
 * Renders an `ERSchema` into a mermaid `erDiagram` source string. Pure over
 * its input — no I/O — so task 6.x's atlas assembly can call it directly on
 * whatever `buildCatalogSchema`/`buildSessionSchema` produced. Column
 * attributes (PK, NOT NULL) render as a quoted mermaid attribute comment
 * (verified against mermaid 11.16.1's real parser — a bare second keyword
 * like `NOT_NULL` is not valid ER attribute-key syntax, but a quoted
 * comment string is). Each foreign key renders as
 * `TO_TABLE ||--o{ FROM_TABLE : "fromColumn"` — many `fromTable` rows
 * reference one `toTable` row via `fromColumn`.
 */
export function emitErDiagram(schema: ERSchema, options: EmitErDiagramOptions = {}): string {
  const lines: string[] = ['erDiagram'];
  if (options.title) {
    lines.push(`  %% ${options.title}`);
  }
  for (const table of schema.tables) {
    lines.push(`  ${table.name} {`);
    for (const column of table.columns) {
      const attrs: string[] = [];
      if (column.pk) attrs.push('PK');
      if (column.notNull) attrs.push('NOT NULL');
      const suffix = attrs.length > 0 ? ` "${attrs.join(', ')}"` : '';
      lines.push(`    ${sanitizeType(column.type)} ${column.name}${suffix}`);
    }
    lines.push('  }');
  }
  for (const fk of schema.foreignKeys) {
    lines.push(`  ${fk.toTable} ||--o{ ${fk.fromTable} : "${fk.fromColumn}"`);
  }
  return lines.join('\n');
}
