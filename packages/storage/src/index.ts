// @autologger/storage package entry (persistence-package-extraction task
// 2.2). The persistence adapters moved from server/src/node/: `blobStore`
// (filesystem audio blobs; exports InvalidRangeError, mapped to 416 by
// `instanceof` at app.ts/routers/audio.ts), `kvStore` (the catalog `kv`
// table's KvStore port implementation), `dataDirLock` (the DATA_DIR single-server lock),
// `catalogErrors` (the transaction contract's errors) and `postgresCatalogStore`
// (`PostgresCatalogDb`, the CatalogDb port on postgres.js; ADR 0021 slices 4b-4c, the server's
// only catalog adapter since the SQLite one was retired in slice 4e) and `postgresSessionSql`
// (`PostgresSessionDb`, the session storage over it; session-tables, ADR 0021 slice 7b-1).
// `frameBusEnvelope` is the session frame bus's signed message and `postgresFrameBus` the bus on
// Postgres `NOTIFY` (session-frame-bus, slice 9a).

export * from './blobStore';
export * from './catalogErrors';
export * from './dataDirLock';
export * from './frameBusEnvelope';
export * from './kvStore';
export * from './postgresCatalogStore';
export * from './postgresFrameBus';
export * from './postgresSessionSql';
