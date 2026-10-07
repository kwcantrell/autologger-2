// The session frame bus (session-frame-bus D1, ADR 0021 slice 9a): the port every session frame,
// relayed command and access-loss close goes through on its way to the sockets. The hub publishes
// a write's frames inside its transaction (`publishInTx`, on the transaction's raw handle) and
// hands them to `afterCommit` once the transaction committed; a relayed command goes through
// `publishNow`. Whatever reaches the bus's receiver is delivered to this process's sockets by the
// registry (`SessionHubRegistry.deliver`).
//
// `LocalFrameBus` is the default for the hub, the registry and every test harness: it delivers
// after COMMIT in this process only, exactly as the hub did before the bus. The Postgres bus
// (`@autologger/storage`'s `PostgresFrameBus`, chosen only by the production entry point) publishes
// with `pg_notify` inside the transaction and delivers from its listener in every process.

import { companionCommandBodySchema } from '@autologger/contract';
import type { SessionSql } from './sessionCore';

/** One bus message (session-frame-bus D1): a frame for session `s` (`f` is the frame's JSON), or a
 * close of user `u`'s sockets on sessions `s` with code `c`. */
export type BusMessage =
  | { k: 'frame'; s: string; f: string }
  | { k: 'close'; u: string; s: readonly string[] | 'all'; c: number };

export interface SessionFrameBus {
  /** Publishes `msgs` inside the open transaction `t` (before COMMIT), so they go out only if it
   * commits. A no-op on the local bus. */
  publishInTx(t: SessionSql, msgs: readonly BusMessage[]): Promise<void>;
  /** After the transaction that issued `msgs` committed: the local bus delivers them now; the
   * Postgres bus does nothing (its listener delivers). */
  afterCommit(msgs: readonly BusMessage[]): void;
  /** A message that belongs to no transaction (a relayed command), sent at once. */
  publishNow(msg: BusMessage): Promise<void>;
}

/** The five frame types a session socket receives (session-frame-bus D2); a receiver drops any
 * other. */
export const SESSION_FRAME_TYPES: readonly string[] = [
  'event.changed',
  'transport.changed',
  'audio.changed',
  'lease.changed',
  'command',
];

/** The contract's command values (`companionCommandBodySchema`), the only commands relayed
 * (session-frame-bus D4). */
export const SESSION_COMMANDS: readonly string[] = companionCommandBodySchema.shape.type.options;

export function isSessionCommand(command: unknown): command is string {
  return typeof command === 'string' && SESSION_COMMANDS.includes(command);
}

/** Delivers in this process only, after COMMIT (session-frame-bus D1): today's behaviour. */
export class LocalFrameBus implements SessionFrameBus {
  constructor(private readonly deliver: (msg: BusMessage) => void) {}

  async publishInTx(_t: SessionSql, _msgs: readonly BusMessage[]): Promise<void> {}

  afterCommit(msgs: readonly BusMessage[]): void {
    for (const msg of msgs) this.deliver(msg);
  }

  /** Delivers before it returns, so a relayed command is sent at once, as before the bus. */
  publishNow(msg: BusMessage): Promise<void> {
    try {
      this.deliver(msg);
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err);
    }
  }
}

/** At most `COMMAND_LIMIT` relayed commands per socket in any `COMMAND_WINDOW_MS`
 * (session-frame-bus D4): a bucket of 10 tokens, each returning one second after it was spent, so
 * an 11th command within one second is dropped. */
const COMMAND_LIMIT = 10;
const COMMAND_WINDOW_MS = 1000;

export class CommandBucket {
  /** When each token still out was spent, oldest first. */
  private readonly spent: number[] = [];

  /** Takes a token at `nowMs`; false when none is left (the command is dropped). */
  take(nowMs: number): boolean {
    while (this.spent.length > 0 && nowMs - (this.spent[0] ?? 0) >= COMMAND_WINDOW_MS) {
      this.spent.shift();
    }
    if (this.spent.length >= COMMAND_LIMIT) return false;
    this.spent.push(nowMs);
    return true;
  }
}
