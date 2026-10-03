// Errors of the catalog port's transaction contract (core-ports-architecture "The catalog
// transaction contract"), raised by the Postgres catalog adapter and checked by the contract suite.

/** The root handle used inside an open transaction, a handle used after its transaction ended, a
 * body that returned while a joined `tx` still ran, or a call from a transaction that already
 * failed. */
export class CatalogTxMisuseError extends Error {
  override name = 'CatalogTxMisuseError';
}

/** A transaction ran past the adapter's deadline; it was ended on the server. */
export class CatalogTxTimeoutError extends Error {
  override name = 'CatalogTxTimeoutError';
}

/** The adapter can serve no more calls (it was closed). */
export class CatalogAdapterBrokenError extends Error {
  override name = 'CatalogAdapterBrokenError';
}

/** The database refused a bound statement with `42501` (catalog-roles design D8). It names the
 * table and the binding's kind and reason (`'user'` or `'system:<reason>'`, never the user id). Not
 * retried; it fails a transaction it occurs in. The server answers it with its generic 500 in slice
 * 6b-1, and logs only these fields (the database's message stays in `cause`). */
export class CatalogForbiddenError extends Error {
  override name = 'CatalogForbiddenError';
  readonly code = '42501';
  readonly table_name: string | undefined;
  constructor(
    readonly binding: string,
    cause: { table_name?: unknown; message?: unknown },
  ) {
    const fromField = typeof cause.table_name === 'string' ? cause.table_name : undefined;
    const fromMessage =
      typeof cause.message === 'string'
        ? /permission denied for (?:table|relation) "?([A-Za-z0-9_.]+)"?/.exec(cause.message)?.[1]
        : undefined;
    const table = fromField ?? fromMessage;
    super(`catalog statement refused (${binding}${table ? `, table ${table}` : ''})`, { cause });
    this.table_name = table;
  }
}
