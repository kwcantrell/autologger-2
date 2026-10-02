// postgres-catalog-adapter tasks 2.1 (design D2-D7): placeholder translation, and the connection
// handling that a real server can't be made to fail on demand, through the `connect` seam.
import postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { CatalogTxMisuseError, CatalogTxTimeoutError } from './catalogErrors';
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

/** One transaction slot, so every transaction runs on the slot's current client. */
function adapter(f: ReturnType<typeof fakes>, txTimeoutMs = 2000) {
  return new PostgresCatalogDb({
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
}

/** The slot's clients: the first client is the root pool. */
const slotClients = (f: ReturnType<typeof fakes>) => f.clients.slice(1);

describe('PostgresCatalogDb: root deadline (catalog-concurrency-hazards D10)', () => {
  /** A root client whose statements never answer until `finish()`; `sent` marks them as sent. */
  function hangingRoot(sent: boolean) {
    const calls: Array<{ text: string; cancelled: boolean; finish: () => void }> = [];
    let rootOpts: PgClientOptions | undefined;
    const connect = (opts: PgClientOptions): PgClient => {
      rootOpts ??= opts;
      return {
        unsafe(text) {
          let finish!: () => void;
          const p = new Promise<PgResult>((r) => {
            finish = () => r(Object.assign([], { count: 0, command: 'SELECT' }));
          });
          const call = { text, cancelled: false, finish };
          calls.push(call);
          return Object.assign(p, {
            state: sent ? { pid: 1 } : null,
            cancel: () => {
              call.cancelled = true;
              return null;
            },
          });
        },
        async end() {},
      };
    };
    const db = new PostgresCatalogDb({
      host: 'h',
      port: 1,
      user: 'u',
      password: 'p',
      database: 'd',
      rootMax: 1,
      txSlots: 1,
      rootTimeoutMs: 50,
      connect,
    });
    return { db, calls, opts: () => rootOpts };
  }

  it('an unsent statement past the deadline is withdrawn, rejects, and is already settled', async () => {
    const r = hangingRoot(false);
    const err = await r.db.first('SELECT 1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CatalogRootTimeoutError);
    expect(r.calls).toHaveLength(1); // not retried
    expect(r.calls[0]?.cancelled).toBe(true);
    await expect((err as CatalogRootTimeoutError).settled).resolves.toBeUndefined();
    expect(r.opts()?.max_pipeline).toBe(1);
  });

  it('a sent statement past the deadline rejects without a cancel and settles when it finishes', async () => {
    const r = hangingRoot(true);
    const err = (await r.db
      .run('UPDATE t SET v = 1')
      .catch((e: unknown) => e)) as CatalogRootTimeoutError;
    expect(err).toBeInstanceOf(CatalogRootTimeoutError);
    expect(r.calls[0]?.cancelled).toBe(false);
    let settled = false;
    void err.settled.then(() => {
      settled = true;
    });
    await new Promise((res) => setTimeout(res, 20));
    expect(settled).toBe(false);
    r.calls[0]?.finish();
    await err.settled;
  });
});

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
    // Text without NUL, and non-string binds, still go through.
    await db.run('INSERT INTO t (k, v) VALUES (?, ?)', 'ab', 2);
    expect(f.clients[0]?.sent).toHaveLength(1);
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
    let db!: PostgresCatalogDb;
    db = new PostgresCatalogDb({
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
        await opts.onSleep?.(ms, db);
      },
    });
    let runs = 0;
    const body = async (t: Parameters<Parameters<PostgresCatalogDb['tx']>[0]>[0]) => {
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
        other ??= db.tx(async () => 'other');
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
