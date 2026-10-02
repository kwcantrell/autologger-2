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
