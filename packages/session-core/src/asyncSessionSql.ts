// The session seam's error classes (async-session-hub design D2, D4, D6; ADR 0021 slice 7a). The
// SQLite adapter that lived here left with session-tables (design D9, ADR 0021 slice 7b-1): the
// session storage is the Postgres session adapter, which the composition root supplies.

/** A transaction handle used after its transaction, a body that returned while a joined body
 * ran, a root statement while a transaction is open, or a hub call from inside its own hub's
 * transaction (design D2, D4). */
export class SessionTxMisuseError extends Error {
  override name = 'SessionTxMisuseError';
}

/** A call on a hub that is closing or closed (design D6). */
export class SessionHubClosedError extends Error {
  override name = 'SessionHubClosedError';
}
