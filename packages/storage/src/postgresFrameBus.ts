// The Postgres frame bus (session-frame-bus D1-D3, D6; ADR 0021 slice 9a): every server process
// sharing the database listens on one `NOTIFY` channel, and every session frame, relayed command
// and access-loss close travels through it.
//
// - `publishInTx` sends `select pg_notify` per message on the write's own transaction handle, so
//   Postgres delivers the messages only if it commits, in commit order across connections and in
//   issue order within one transaction. `afterCommit` does nothing: every process, the writer
//   included, delivers from its listener, so each socket gets one database-ordered stream.
// - `publishNow` (a relayed command) uses the bus's own publisher connection, never a catalog or
//   session connection.
// - The listener is postgres.js's `listen`, on its own connection with `application_name`
//   `autologger-frame-bus`. postgres.js re-runs LISTEN after any connection loss and calls
//   `onlisten` again; notifications sent while it was down are lost, so on every re-listen the
//   process closes its session sockets with `1012`, once per loss, and the clients reconnect and
//   re-read (D6).
//
// Every message is signed and checked, and checked against replays from the first LISTEN on (D2,
// `frameBusEnvelope.ts`).

import type { Clock } from '@autologger/ports';
import postgres from 'postgres';
import {
  type FrameBusMessage,
  FrameBusReplayGuard,
  type FrameBusRules,
  FrameBusSealer,
  openFrameBusMessage,
} from './frameBusEnvelope';

export const FRAME_BUS_CHANNEL = 'autologger_session_frames';
export const FRAME_BUS_APPLICATION_NAME = 'autologger-frame-bus';
/** The close code after the listener re-established (session-frame-bus D6). */
export const FRAME_BUS_RELISTEN_CLOSE_CODE = 1012;

/** Where received messages go: session-core's `SessionHubRegistry` (the composition root's
 * assignment is the type check). */
export interface FrameBusReceiver {
  deliver(msg: FrameBusMessage): void;
  closeAllSockets(code: number): number;
}

/** A write transaction's raw handle, as session-core's `SessionSql` (only `all` is used; storage
 * may import only `ports`, so the shape is declared here). */
export interface FrameBusTxHandle {
  all(sql: string, ...binds: string[]): Promise<unknown[]>;
}

export interface PostgresFrameBusOptions extends FrameBusRules {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** `FRAME_BUS_SECRET`, at least 32 characters. */
  secret: string;
  /** Drop and failure lines; never a payload. */
  log?: (line: string) => void;
  /** Send times and replay checks (D2); the real clock by default, injectable for tests. */
  clock?: Clock;
}

interface ListenerState {
  pid: number | null;
}

export class PostgresFrameBus {
  private readonly sealer: FrameBusSealer;
  private readonly guard: FrameBusReplayGuard;
  private readonly secret: string;
  private readonly rules: FrameBusRules;
  private readonly log: (line: string) => void;
  /** The publisher connection (`max: 1`); postgres.js opens the listener's own connection from
   * its options, so both carry the `application_name`. */
  private readonly sql: postgres.Sql;
  private receiver: FrameBusReceiver | null = null;
  private listenState: ListenerState | null = null;
  private unlisten: (() => Promise<void>) | null = null;
  private listens = 0;
  private stopped = false;

  constructor(opts: PostgresFrameBusOptions) {
    this.sealer = new FrameBusSealer(opts.secret, opts.clock);
    this.guard = new FrameBusReplayGuard(opts.clock);
    this.secret = opts.secret;
    this.rules = { frameTypes: [...opts.frameTypes], commands: [...opts.commands] };
    this.log = opts.log ?? ((line) => console.warn(line));
    this.sql = postgres({
      host: opts.host,
      port: opts.port,
      user: opts.user,
      password: opts.password,
      database: opts.database,
      max: 1,
      idle_timeout: 0,
      max_lifetime: null,
      connect_timeout: 5,
      onnotice: () => {},
      connection: { application_name: FRAME_BUS_APPLICATION_NAME },
    });
  }

  /** Starts the listener and resolves after the first LISTEN (D3); `main.ts` awaits it before
   * `listen()`. */
  async start(receiver: FrameBusReceiver): Promise<void> {
    if (this.receiver) throw new Error('the frame bus is already started');
    this.receiver = receiver;
    const handle = await this.sql.listen(
      FRAME_BUS_CHANNEL,
      (payload) => this.onMessage(payload),
      () => this.onListen(),
    );
    this.listenState = handle.state as ListenerState;
    this.unlisten = () => handle.unlisten();
  }

  /** The listener connection's backend pid (`pg_backend_pid()`), so a test terminates only its
   * own listener (D8). Follows reconnects. */
  get listenerPid(): number | null {
    return this.listenState?.pid ?? null;
  }

  private onListen(): void {
    this.listens += 1;
    // D2: messages sent before the first LISTEN are dropped; no socket can attach before it.
    if (this.listens === 1) this.guard.listening();
    if (this.listens === 1 || this.stopped) return;
    // D6: a re-listen follows a loss; frames sent meanwhile are gone, so the clients re-read.
    this.log(
      `frame bus: listener re-established; closing session sockets with ${FRAME_BUS_RELISTEN_CLOSE_CODE}`,
    );
    try {
      this.receiver?.closeAllSockets(FRAME_BUS_RELISTEN_CLOSE_CODE);
    } catch (err) {
      this.log(`frame bus: closing sockets after a re-listen failed: ${String(err)}`);
    }
  }

  private onMessage(payload: string): void {
    const opened = openFrameBusMessage(payload, this.secret, this.rules, this.guard);
    if (!opened.ok) {
      this.log(`frame bus: dropped ${opened.reason}`);
      return;
    }
    try {
      this.receiver?.deliver(opened.msg);
    } catch (err) {
      this.log(`frame bus: delivery failed: ${String(err)}`);
    }
  }

  /** D3: inside the open transaction `t`, before COMMIT. */
  async publishInTx(t: FrameBusTxHandle, msgs: readonly FrameBusMessage[]): Promise<void> {
    for (const msg of msgs) {
      await t.all('select pg_notify(?, ?)', FRAME_BUS_CHANNEL, this.sealer.seal(msg));
    }
  }

  /** The listener delivers; nothing to do after COMMIT. */
  afterCommit(_msgs: readonly FrameBusMessage[]): void {}

  /** D4: on the bus's own publisher connection. */
  async publishNow(msg: FrameBusMessage): Promise<void> {
    await this.sql.unsafe('select pg_notify($1, $2)', [FRAME_BUS_CHANNEL, this.sealer.seal(msg)]);
  }

  /** Stops listening and ends both connections. */
  async close(): Promise<void> {
    this.stopped = true;
    try {
      await this.unlisten?.();
    } catch {
      // the listener connection is already gone
    }
    await this.sql.end({ timeout: 5 });
  }
}
