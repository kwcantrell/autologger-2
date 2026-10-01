// postgres-catalog-adapter tasks 2.1 (design D2-D7): placeholder translation, and the connection
// handling that a real server can't be made to fail on demand, through the `connect` seam.
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { CatalogTxMisuseError, CatalogTxTimeoutError } from './asyncCatalogStore';
import {
  CatalogCommitUnknownError,
  type PgClient,
  type PgClientOptions,
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
