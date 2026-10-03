// postgres-catalog-adapter tasks 2.1 (design D2-D7): placeholder translation, and the connection
// handling that a real server can't be made to fail on demand, through the `connect` seam.
import type { CatalogDb } from '@autologger/ports';
import postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import {
  CatalogForbiddenError,
  CatalogTxMisuseError,
  CatalogTxTimeoutError,
} from './catalogErrors';
import {
  CatalogCommitUnknownError,
  CatalogInvalidTextError,
  CatalogRootTimeoutError,
  type PgClient,
  type PgClientOptions,
  type PgResult,
  PostgresCatalogDb,
  toPg,
} from './postgresCatalogStore';
import { gate, prompt } from './test/catalogDbContract';

describe('toPg', () => {
  it.each([
    ['SELECT 1', 'SELECT 1'],
    ['SELECT * FROM t WHERE a = ? AND b = ?', 'SELECT * FROM t WHERE a = $1 AND b = $2'],
    ["SELECT '?' AS q, ? AS v", "SELECT '?' AS q, $1 AS v"],
    ["SELECT 'it''s ?', ?", "SELECT 'it''s ?', $1"],
    ['SELECT "odd?col" FROM t WHERE k = ?', 'SELECT "odd?col" FROM t WHERE k = $1'],
    ['SELECT ? -- why?\n, ?', 'SELECT $1 -- why?\n, $2'],
  ])('%j -> %j', (input, output) => {
    expect(toPg(input)).toBe(output);
  });
});

type Reply = { command: string; count?: number; rows?: Record<string, unknown>[] };
/** What a fake client answers: a reply, an error to reject with, or 'hang'. */
type Answer = Reply | Error | 'hang';

interface FakeClient extends PgClient {
  id: number;
  sent: string[];
  ended: boolean;
}

function fakes(answer: (client: number, text: string) => Answer | undefined) {
  const clients: FakeClient[] = [];
  const connect = (opts: PgClientOptions): PgClient => {
    const id = clients.length;
    const hanging: ((e: Error) => void)[] = [];
    const client: FakeClient = {
      id,
      sent: [],
      ended: false,
      unsafe(text) {
        client.sent.push(text);
        const a = answer(id, text) ?? defaultReply(text);
        const p =
          a === 'hang'
            ? new Promise<never>((_, reject) => hanging.push(reject))
            : a instanceof Error
              ? Promise.reject(a)
              : Promise.resolve(Object.assign([...(a.rows ?? [])], { count: 0, ...a }));
        // postgres.js's cancel() returns null (query.js:53).
        return Object.assign(p, { cancel: () => null });
      },
      async end() {
        client.ended = true;
        for (const reject of hanging.splice(0)) reject(lost('CONNECTION_DESTROYED'));
        // postgres.js calls onclose after end() resolves (design A9).
        setTimeout(() => opts.onclose?.(id), 3);
      },
    };
    clients.push(client);
    return client;
  };
  return { clients, connect };
}

function defaultReply(text: string): Reply {
  const command = text.split(' ')[0]?.toUpperCase() ?? '';
  return { command: command === 'BEGIN' ? 'BEGIN' : command, count: 1 };
}

const lost = (code: string) => Object.assign(new Error(`write ${code}`), { code });
const serverError = (code: string) =>
  new postgres.PostgresError({ code, message: `server ${code}` } as never);

/** One transaction slot, so every transaction runs on the slot's current client. A `system:test`
 * handle (the adapter has no unbound methods, catalog-roles 6.1), closing its adapter. */
function adapter(f: ReturnType<typeof fakes>, txTimeoutMs = 2000) {
  const root = new PostgresCatalogDb({
    host: 'h',
    port: 1,
    user: 'u',
    password: 'p',
    database: 'd',
    rootMax: 1,
    txSlots: 1,
    txTimeoutMs,
    connect: f.connect,
  });
  return Object.assign(root.bindSystem('test'), { close: () => root.close() });
}

/** The transaction slot's clients: with `rootMax: 1` the first client is the root slot's. */
const slotClients = (f: ReturnType<typeof fakes>) => f.clients.slice(1);

describe('PostgresCatalogDb: NUL text (catalog-on-postgres D5)', () => {
  it('a root statement with a NUL bind rejects with CatalogInvalidTextError and sends nothing', async () => {
    const f = fakes(() => undefined);
    const db = adapter(f);
    for (const call of [
      () => db.run('INSERT INTO t (k) VALUES (?)', 'a\u0000b'),
      () => db.first('SELECT * FROM t WHERE k = ?', 'x', '\u0000'),
      () => db.all('SELECT * FROM t WHERE k = ?', '\u0000'),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(CatalogInvalidTextError);
    }
    expect(f.clients.flatMap((c) => c.sent)).toEqual([]);
    // Text without NUL, and non-string binds, still go through (a short root transaction,
    // catalog-roles D5).
    await db.run('INSERT INTO t (k, v) VALUES (?, ?)', 'ab', 2);
    expect(f.clients[0]?.sent).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      PREAMBLE,
      'INSERT INTO t (k, v) VALUES ($1, $2)',
      'COMMIT',
    ]);
    await db.close();
  });

  it('inside a transaction, a NUL bind fails the transaction without sending the statement', async () => {
    const f = fakes(() => undefined);
    const db = adapter(f);
    await expect(
      db.tx(async (t) => {
        await t.run('INSERT INTO t (k) VALUES (?)', 'a');
        await t.run('INSERT INTO t (k) VALUES (?)', 'a\u0000b');
      }),
    ).rejects.toBeInstanceOf(CatalogInvalidTextError);
    const sent = slotClients(f).flatMap((c) => c.sent);
    expect(sent).toContain('ROLLBACK');
    expect(sent).not.toContain('COMMIT');
    expect(sent.filter((x) => x.startsWith('INSERT'))).toHaveLength(1);
    await db.close();
  });
});

describe('PostgresCatalogDb: connection handling (fake clients)', () => {
  it('a failed ROLLBACK retires the client, and the next transaction runs on a new one', async () => {
    const f = fakes((_, text) => (text === 'ROLLBACK' ? serverError('XX000') : undefined));
    const db = adapter(f);
    const boom = new Error('body failed');
    await expect(
      db.tx(async (t) => {
        await t.run('INSERT INTO t (k) VALUES (?)', 'a');
        throw boom;
      }),
    ).rejects.toBe(boom);
    const [first] = slotClients(f);
    expect(first?.ended).toBe(true);
    expect(await db.tx(async (t) => t.run('INSERT INTO t (k) VALUES (?)', 'b'))).toEqual({
      changes: 1,
    });
    const second = slotClients(f)[1];
    expect(second?.sent).toEqual([
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      PREAMBLE,
      'INSERT INTO t (k) VALUES ($1)',
      'COMMIT',
    ]);
    await db.close();
  });

  it('a COMMIT whose reply is lost is outcome-unknown: no ROLLBACK, no retry, client retired', async () => {
    const f = fakes((_, text) => (text === 'COMMIT' ? lost('CONNECTION_CLOSED') : undefined));
    const db = adapter(f);
    let runs = 0;
    const err = await db
      .tx(async (t) => {
        runs++;
        await t.run('INSERT INTO t (k) VALUES (?)', 'a');
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CatalogCommitUnknownError);
    expect(err).toMatchObject({ cause: { code: 'CONNECTION_CLOSED' } });
    expect(runs).toBe(1);
    const [first] = slotClients(f);
    expect(first?.sent).not.toContain('ROLLBACK');
    expect(first?.ended).toBe(true);
    await db.close();
  });

  it('a COMMIT that hangs past its bound is outcome-unknown, and the client is retired', async () => {
    const f = fakes((_, text) => (text === 'COMMIT' ? 'hang' : undefined));
    const db = adapter(f, 100);
    await expect(
      prompt(
        db.tx(async (t) => {
          await t.run('INSERT INTO t (k) VALUES (?)', 'a');
        }),
        3000,
      ),
    ).rejects.toBeInstanceOf(CatalogCommitUnknownError);
    const [first] = slotClients(f);
    expect(first?.sent).not.toContain('ROLLBACK');
    expect(first?.ended).toBe(true);
    await db.close();
  });

  it('a COMMIT answered as a ROLLBACK fails the transaction', async () => {
    const f = fakes((_, text) => (text === 'COMMIT' ? { command: 'ROLLBACK' } : undefined));
    const db = adapter(f);
    await expect(
      db.tx(async (t) => {
        await t.run('INSERT INTO t (k) VALUES (?)', 'a');
        return 'looked committed';
      }),
    ).rejects.toBeInstanceOf(CatalogTxMisuseError);
    await db.close();
  });

  it("a retired client's late onclose does not fail the next transaction on its slot", async () => {
    const f = fakes((client, text) =>
      client === 1 && text === 'ROLLBACK' ? serverError('XX000') : undefined,
    );
    const db = adapter(f);
    await expect(
      db.tx(async () => {
        throw new Error('first fails');
      }),
    ).rejects.toThrow('first fails');
    const g = gate();
    const next = db.tx(async (t) => {
      await g.wait;
      return t.run('INSERT INTO t (k) VALUES (?)', 'b');
    });
    // The retired client's onclose fires 3 ms after its end(); let it land mid-transaction.
    await new Promise((r) => setTimeout(r, 30));
    g.open();
    expect(await prompt(next)).toEqual({ changes: 1 });
    await db.close();
  });

  it('a deadline over a hung statement cancels it (cancel returns null) and retires the client', async () => {
    const f = fakes((_, text) => (text.startsWith('SELECT pg_sleep') ? 'hang' : undefined));
    const db = adapter(f, 100);
    await expect(
      prompt(
        db.tx(async (t) => t.all('SELECT pg_sleep(60)')),
        2000,
      ),
    ).rejects.toBeInstanceOf(CatalogTxTimeoutError);
    const [first] = slotClients(f);
    expect(first?.sent).not.toContain('ROLLBACK');
    expect(first?.ended).toBe(true);
    expect(await prompt(db.tx(async (t) => t.run('INSERT INTO t (k) VALUES (?)', 'c')))).toEqual({
      changes: 1,
    });
    await db.close();
  });
});

describe('PostgresCatalogDb: retry backoff (catalog-retry-backoff D1-D3)', () => {
  /** One slot; every body statement fails with `code`; waits are recorded, and run `onSleep`. */
  function backoffDb(opts: {
    code?: string;
    txTimeoutMs?: number;
    onSleep?: (ms: number, db: PostgresCatalogDb) => void | Promise<void>;
  }) {
    const f = fakes((_c, text) =>
      text.startsWith('UPDATE') ? serverError(opts.code ?? '40001') : undefined,
    );
    const waits: number[] = [];
    let root!: PostgresCatalogDb;
    root = new PostgresCatalogDb({
      host: 'h',
      port: 1,
      user: 'u',
      password: 'p',
      database: 'd',
      rootMax: 1,
      txSlots: 1,
      txTimeoutMs: opts.txTimeoutMs ?? 2000,
      connect: f.connect,
      random: () => 0.999,
      sleep: async (ms) => {
        waits.push(ms);
        await opts.onSleep?.(ms, root);
      },
    });
    const db = Object.assign(root.bindSystem('test'), { close: () => root.close() });
    let runs = 0;
    const body = async (t: CatalogDb) => {
      runs++;
      await t.run('UPDATE t SET v = 1');
    };
    return { f, db, waits, body, runs: () => runs };
  }

  it('runs a serialization failure 5 times, waiting below 20, 40, 80 and 160 ms between runs', async () => {
    const b = backoffDb({});
    await expect(b.db.tx(b.body)).rejects.toMatchObject({ code: '40001' });
    expect(b.runs()).toBe(5);
    expect(b.waits).toHaveLength(4);
    for (const [i, cap] of [20, 40, 80, 160].entries()) {
      expect(b.waits[i]).toBeGreaterThan(cap * 0.99);
      expect(b.waits[i]).toBeLessThan(cap);
    }
    await b.db.close();
  });

  it('holds no connection while it waits: a queued transaction takes the slot', async () => {
    let other: Promise<string> | undefined;
    const b = backoffDb({
      onSleep: async (_ms, db) => {
        other ??= db.bindSystem('test').tx(async () => 'other');
        expect(await other).toBe('other');
      },
    });
    await expect(b.db.tx(b.body)).rejects.toMatchObject({ code: '40001' });
    await b.db.close();
  });

  it('does not wait after a non-retryable error, or once closed', async () => {
    const b = backoffDb({ code: '23505' });
    await expect(b.db.tx(b.body)).rejects.toMatchObject({ code: '23505' });
    expect(b.waits).toEqual([]);
    await b.db.close();

    const c = backoffDb({ onSleep: (_ms, db) => void db.close() });
    await expect(c.db.tx(c.body)).rejects.toMatchObject({ code: '40001' });
    expect(c.runs()).toBe(1); // close() during the first wait: no new run starts
    expect(c.waits).toHaveLength(1);
  });

  it('caps a wait at the deadline, then times out with no statement and no connection', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(0);
      // Run 1 fails at t=0; the 20 ms backoff is capped at the 5 ms left, and ends at the deadline.
      const b = backoffDb({
        txTimeoutMs: 5,
        onSleep: (ms) => void vi.setSystemTime(Date.now() + ms),
      });
      const sentBefore = () => b.f.clients.reduce((n, c) => n + c.sent.length, 0);
      const p = b.db.tx(b.body);
      await expect(p).rejects.toBeInstanceOf(CatalogTxTimeoutError);
      expect(b.waits).toEqual([5]);
      expect(b.runs()).toBe(1);
      const sent = sentBefore();
      const clients = b.f.clients.length;
      // Nothing more was sent and no connection was opened for a second run.
      expect(
        slotClients(b.f)
          .flatMap((c) => c.sent)
          .filter((s) => s.startsWith('BEGIN')),
      ).toHaveLength(1);
      expect(sentBefore()).toBe(sent);
      expect(b.f.clients.length).toBe(clients);
      await b.db.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

// catalog-roles tasks 3.1 (design D4, D5, D6, D8): bindings, the pipelined preamble, the short
// root transaction on adapter-owned root slots, and the forbidden error.

const PREAMBLE = "select set_config('role', $1, true), set_config('app.user_id', $2, true)";
const BODY = 'UPDATE t SET v = $1';

interface HeldCall {
  client: number;
  text: string;
  binds: unknown[] | undefined;
  answered: boolean;
  answer(a?: Answer): void;
}

/** Fake clients whose replies wait until the test answers them, so a test can see what was issued
 * before the first reply. `auto` answers a call at once unless it returns 'hold'. */
function held(auto?: (client: number, text: string) => Answer | 'hold' | undefined) {
  const calls: HeldCall[] = [];
  const opts: PgClientOptions[] = [];
  const ended: boolean[] = [];
  const connect = (o: PgClientOptions): PgClient => {
    const id = opts.length;
    opts.push(o);
    ended.push(false);
    const mine: HeldCall[] = [];
    return {
      unsafe(text, binds) {
        let settle!: (a: Answer) => void;
        const p = new Promise<PgResult>((resolve, reject) => {
          settle = (a) => {
            if (a === 'hang') return;
            if (a instanceof Error) reject(a);
            else resolve(Object.assign([...(a.rows ?? [])], { count: 0, ...a }));
          };
        });
        const call: HeldCall = {
          client: id,
          text,
          binds,
          answered: false,
          answer(a) {
            if (call.answered) return;
            call.answered = true;
            settle(a ?? defaultReply(text));
          },
        };
        calls.push(call);
        mine.push(call);
        // No `auto`: every reply waits. `auto` returning undefined: the default reply at once.
        const a = auto ? auto(id, text) : 'hold';
        if (a !== 'hold') queueMicrotask(() => call.answer(a));
        return Object.assign(p, { cancel: () => null });
      },
      async end() {
        ended[id] = true;
        for (const c of mine) if (!c.answered) c.answer(lost('CONNECTION_DESTROYED'));
        setTimeout(() => o.onclose?.(id), 3);
      },
    };
  };
  const pending = () => calls.filter((c) => !c.answered);
  /** Answers every pending call in order (default replies), until none is left. */
  const drainAll = async (answer?: (c: HeldCall) => Answer | undefined) => {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 1));
      const p = pending();
      if (p.length === 0) return;
      for (const c of p) c.answer(answer?.(c));
    }
  };
  const texts = (client: number) => calls.filter((c) => c.client === client).map((c) => c.text);
  return { calls, opts, ended, connect, pending, drainAll, texts };
}

function rolesDb(f: { connect: (o: PgClientOptions) => PgClient }, extra = {}) {
  return new PostgresCatalogDb({
    host: 'h',
    port: 1,
    user: 'u',
    password: 'p',
    database: 'd',
    rootMax: 1,
    txSlots: 1,
    connect: f.connect,
    ...extra,
  });
}

/** Lets queued microtasks and 1 ms timers run. */
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('PostgresCatalogDb: bindings (catalog-roles D4)', () => {
  it('has bindUser, bindSystem and close', () => {
    const db = rolesDb(held());
    for (const m of ['bindUser', 'bindSystem', 'close'] as const) {
      expect(typeof db[m]).toBe('function');
    }
  });

  it('a malformed binding throws TypeError and uses no connection', async () => {
    const f = held();
    const db = rolesDb(f);
    expect(() => db.bindUser('')).toThrow(TypeError);
    expect(() => db.bindUser(1 as never)).toThrow(TypeError);
    expect(() => db.bindSystem('Not A Reason')).toThrow(TypeError);
    expect(() => db.bindSystem('')).toThrow(TypeError);
    expect(() => db.bindSystem('9-lives')).toThrow(TypeError);
    expect(db.bindSystem('a-reason-2')).toBeDefined();
    await tick();
    expect(f.calls).toEqual([]);
    await db.close();
  });

  it.each([
    ['user', (db: PostgresCatalogDb) => db.bindUser('u-1'), ['catalog_user', 'u-1']],
    ['system', (db: PostgresCatalogDb) => db.bindSystem('test'), ['catalog_system', '']],
  ] as const)('a %s-bound transaction pipelines BEGIN and the preamble, and re-applies it on a retry', async (_kind, bind, binds) => {
    let bodyRuns = 0;
    const f = held((_c, text) => {
      if (text === BODY) return ++bodyRuns === 1 ? serverError('40001') : undefined;
      return 'hold';
    });
    const db = rolesDb(f, { random: () => 0, sleep: async () => {} });
    const p = bind(db).tx(async (t) => t.run('UPDATE t SET v = ?', 1));
    await tick();
    // Both issued before either reply arrived.
    expect(f.texts(1)).toEqual(['BEGIN ISOLATION LEVEL SERIALIZABLE', PREAMBLE]);
    expect(f.calls.find((c) => c.text === PREAMBLE)?.binds).toEqual(binds);
    await f.drainAll();
    expect(await prompt(p)).toEqual({ changes: 1 });
    const tx = f.calls.filter((c) => c.client !== 0);
    expect(tx.map((c) => c.text)).toEqual([
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      PREAMBLE,
      BODY,
      'ROLLBACK',
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      PREAMBLE,
      BODY,
      'COMMIT',
    ]);
    expect(tx.filter((c) => c.text === PREAMBLE).map((c) => c.binds)).toEqual([binds, binds]);
    await db.close();
  });
});

describe('PostgresCatalogDb: the short root transaction (catalog-roles D5)', () => {
  it('a bound root call pipelines BEGIN, the preamble, the statement and COMMIT on a max-1 root client, and resolves after COMMIT', async () => {
    const f = held(() => 'hold');
    const db = rolesDb(f);
    let resolved = false;
    const p = db
      .bindUser('u-1')
      .first('SELECT v FROM t WHERE k = ?', 'a')
      .then((v) => {
        resolved = true;
        return v;
      });
    await tick();
    expect(f.opts[0]?.max).toBe(1);
    expect(f.texts(0)).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      PREAMBLE,
      'SELECT v FROM t WHERE k = $1',
      'COMMIT',
    ]);
    expect(f.calls.every((c) => !c.answered)).toBe(true);
    expect(f.calls[1]?.binds).toEqual(['catalog_user', 'u-1']);
    f.calls[0]?.answer();
    f.calls[1]?.answer();
    f.calls[2]?.answer({ command: 'SELECT', rows: [{ v: 7 }] });
    await tick();
    expect(resolved).toBe(false); // the COMMIT has not answered
    f.calls[3]?.answer();
    expect(await prompt(p)).toEqual({ v: 7 });
    // The slot was released: the next call runs on the same client.
    const q = db.bindSystem('test').run('DELETE FROM t');
    await f.drainAll();
    expect(await prompt(q)).toEqual({ changes: 1 });
    expect(f.opts).toHaveLength(2); // the root slot and the transaction slot, nothing new
    await db.close();
  });

  it('a failing statement rejects with its error after the COMMIT answered ROLLBACK, with no retry, even on 40001', async () => {
    for (const code of ['23505', '40001']) {
      const f = held((_c, text) =>
        text.startsWith('UPDATE')
          ? serverError(code)
          : text === 'COMMIT'
            ? { command: 'ROLLBACK' }
            : undefined,
      );
      const db = rolesDb(f);
      await expect(prompt(db.bindUser('u-1').run('UPDATE t SET v = 1'))).rejects.toMatchObject({
        code,
      });
      expect(f.texts(0).filter((t) => t.startsWith('UPDATE'))).toHaveLength(1);
      expect(f.ended[0]).toBe(false); // confirmed end: the client is kept
      await db.close();
    }
  });

  it('a COMMIT the server rejects rejects the call and retires the client', async () => {
    const f = held((_c, text) => (text === 'COMMIT' ? serverError('23503') : undefined));
    const db = rolesDb(f);
    await expect(
      prompt(db.bindSystem('test').run('INSERT INTO c (pid) VALUES (1)')),
    ).rejects.toMatchObject({
      code: '23503',
    });
    expect(f.ended[0]).toBe(true);
    await db.close();
  });

  it('a deadline reached while waiting for a root slot withdraws the call: nothing is issued', async () => {
    const f = held(() => 'hold');
    const db = rolesDb(f, { rootTimeoutMs: 50 });
    const first = db.bindUser('u-1').run('UPDATE t SET v = 1');
    first.catch(() => {});
    await tick();
    const issued = f.calls.length;
    const err = (await db
      .bindUser('u-1')
      .run('UPDATE t SET v = 2')
      .catch((e: unknown) => e)) as CatalogRootTimeoutError;
    expect(err).toBeInstanceOf(CatalogRootTimeoutError);
    expect(err.message).toMatch(/before it was sent/);
    await expect(err.settled).resolves.toBeUndefined();
    expect(f.calls.length).toBe(issued);
    expect(f.calls.some((c) => c.text === 'UPDATE t SET v = 2')).toBe(false);
    await f.drainAll();
    await first.catch(() => {});
    await db.close();
  });

  it('a deadline reached after issuing rejects with a may-still-apply timeout that settles once the replies arrive', async () => {
    const f = held(() => 'hold');
    const db = rolesDb(f, { rootTimeoutMs: 50 });
    const err = (await db
      .bindUser('u-1')
      .run('UPDATE t SET v = 1')
      .catch((e: unknown) => e)) as CatalogRootTimeoutError;
    expect(err).toBeInstanceOf(CatalogRootTimeoutError);
    expect(err.message).toMatch(/may still apply/);
    let settled = false;
    void err.settled.then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    expect(f.calls.some((c) => c.text === 'ROLLBACK' || c.text.startsWith('CANCEL'))).toBe(false);
    await f.drainAll();
    await prompt(err.settled);
    // The slot was released on the confirmed COMMIT: the next call reuses the client.
    const next = db.bindUser('u-1').run('UPDATE t SET v = 2');
    await f.drainAll();
    expect(await prompt(next)).toEqual({ changes: 1 });
    expect(f.ended[0]).toBe(false);
    await db.close();
  });

  it('a timed-out root call whose replies never come retires the client at its bound, then settles', async () => {
    const f = held(() => 'hold');
    const db = rolesDb(f, { rootTimeoutMs: 30, rootSettleMs: 60 });
    const err = (await db
      .bindUser('u-1')
      .run('UPDATE t SET v = 1')
      .catch((e: unknown) => e)) as CatalogRootTimeoutError;
    expect(err).toBeInstanceOf(CatalogRootTimeoutError);
    await prompt(err.settled);
    expect(f.ended[0]).toBe(true);
    // A fresh client serves the next call.
    const next = db.bindUser('u-1').run('UPDATE t SET v = 2');
    await f.drainAll();
    expect(await prompt(next)).toEqual({ changes: 1 });
    expect(f.opts.length).toBe(3);
    await db.close();
  });

  it('an onclose on a root client mid-call rejects the call, sends nothing more on it, and retires it', async () => {
    const f = held(() => 'hold');
    const db = rolesDb(f);
    const p = db.bindUser('u-1').run('UPDATE t SET v = 1');
    await tick();
    const sentBefore = f.texts(0).length;
    f.opts[0]?.onclose?.(0);
    await expect(prompt(p)).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
    await tick();
    expect(f.texts(0).length).toBe(sentBefore);
    expect(f.ended[0]).toBe(true);
    const next = db.bindUser('u-1').run('UPDATE t SET v = 2');
    await f.drainAll();
    expect(await prompt(next)).toEqual({ changes: 1 });
    expect(f.texts(2)).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      PREAMBLE,
      'UPDATE t SET v = 2',
      'COMMIT',
    ]);
    await db.close();
  });

  it('the adapter has no unbound statement or transaction method (catalog-roles 6.1)', async () => {
    const db = rolesDb(held(() => undefined));
    // @ts-expect-error -- PostgresCatalogDb is a CatalogRoot only
    expect(db.all).toBeUndefined();
    for (const m of ['all', 'first', 'run', 'tx']) expect(m in db, m).toBe(false);
    await db.close();
  });
});

describe('PostgresCatalogDb: forbidden error and misuse (catalog-roles D8)', () => {
  const denied = () =>
    new postgres.PostgresError({
      code: '42501',
      message: 'permission denied for table users',
    } as never);

  it('a 42501 at the root is a CatalogForbiddenError naming the table and the binding, not the user id', async () => {
    for (const [bind, binding] of [
      [(db: PostgresCatalogDb) => db.bindUser('u-1'), 'user'],
      [(db: PostgresCatalogDb) => db.bindSystem('test'), 'system:test'],
    ] as const) {
      const f = held((_c, text) =>
        text.startsWith('SELECT')
          ? denied()
          : text === 'COMMIT'
            ? { command: 'ROLLBACK' }
            : undefined,
      );
      const db = rolesDb(f);
      const err = await prompt(bind(db).first('SELECT * FROM users')).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CatalogForbiddenError);
      expect(err).toMatchObject({ code: '42501', table_name: 'users', binding });
      expect(JSON.stringify({ ...(err as object), message: (err as Error).message })).not.toContain(
        'u-1',
      );
      expect(f.texts(0).filter((t) => t.startsWith('SELECT'))).toHaveLength(1);
      await db.close();
    }
  });

  it('a 42501 in a transaction is a CatalogForbiddenError, fails the transaction and is not retried', async () => {
    const f = held((_c, text) => (text.startsWith('UPDATE') ? denied() : undefined));
    const db = rolesDb(f, { random: () => 0, sleep: async () => {} });
    let runs = 0;
    const err = await prompt(
      db.bindUser('u-1').tx(async (t) => {
        runs++;
        await t.run('UPDATE users SET email = ?', 'x');
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CatalogForbiddenError);
    expect(err).toMatchObject({ code: '42501', table_name: 'users', binding: 'user' });
    expect(runs).toBe(1);
    expect(f.texts(1)).toContain('ROLLBACK');
    expect(f.texts(1)).not.toContain('COMMIT');
    await db.close();
  });

  it('a system-bound statement inside an open user-bound transaction is refused and the transaction rolls back', async () => {
    const f = held(() => undefined);
    const db = rolesDb(f);
    const sys = db.bindSystem('test');
    await expect(
      prompt(
        db.bindUser('u-1').tx(async (t) => {
          await t.run('UPDATE t SET v = ?', 1);
          await sys.run('UPDATE t SET v = ?', 2);
        }),
      ),
    ).rejects.toBeInstanceOf(CatalogTxMisuseError);
    expect(f.texts(1)).toContain('ROLLBACK');
    expect(f.texts(1)).not.toContain('COMMIT');
    expect(f.texts(0)).toEqual([]); // nothing reached a root slot
    await db.close();
  });

  it("the adapter's own messages never set a role or setting beyond the transaction", async () => {
    const f = held((_c, text) =>
      text === 'UPDATE t SET v = 99' ? serverError('40001') : undefined,
    );
    const db = rolesDb(f, { random: () => 0, sleep: async () => {} });
    const body = new Set<string>();
    const q = (sql: string) => {
      body.add(sql);
      return sql;
    };
    await db.bindUser('u-1').run(q("UPDATE users SET role = 'x' WHERE id = 'set me'"));
    await db.bindSystem('test').first(q('SELECT 1'));
    await db.bindUser('u-1').tx(async (t) => t.all(q('SELECT 2')));
    await db
      .bindSystem('test')
      .tx(async () => {
        throw new Error('rollback');
      })
      .catch(() => {});
    await db
      .bindUser('u-1')
      .tx(async (t) => t.run(q('UPDATE t SET v = 99')))
      .catch(() => {});
    await db.bindSystem('test').run(q('UPDATE t SET v = 3'));
    const own = f.calls.map((c) => c.text).filter((t) => !body.has(t));
    expect(own.length).toBeGreaterThan(0);
    for (const t of own) {
      expect(t).not.toMatch(/\bset\s+(?!local)/i);
      expect(t).not.toMatch(/set_config\([^)]*false\)/);
    }
    await db.close();
  });
});
