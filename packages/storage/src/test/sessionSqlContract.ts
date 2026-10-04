// The session storage contract as one suite (session-tables design D12; core-ports-architecture
// "The Postgres session adapter"): the session seam's transactions and snapshots, run against an
// adapter over a database with the session tables and one seeded `catalog.sessions` row.
// Statements use `session_meta` and `session_transcript_words`, scoped by `session_id`.
// session-content-policies design D4, D12: every call names its caller. The 7b-1 cases run as a
// system caller (assertions unchanged); the user cases run under the content policies, against a
// fixture whose session belongs to a show with an owner, a granted and an ungranted member.
import type { CatalogDb } from '@autologger/ports';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CatalogTxMisuseError,
  CatalogTxTimeoutError,
  SessionAccessDeniedError,
  SessionNotFoundError,
} from '../catalogErrors';
import { CatalogInvalidTextError } from '../postgresCatalogStore';
import type { SessionCallerShape, SessionSqlHandle, SessionStorage } from '../postgresSessionSql';
import { gate, prompt } from './catalogDbContract';

/** A failure the fixture injects through the adapter's `connect` seam, once. */
export type SessionFault =
  /** The statement carrying this bind is replaced by one the server fails with `40P01`. */
  | { kind: 'deadlock'; bind: string }
  /** The next ROLLBACK gets no server reply: the client sees a connection error. */
  | { kind: 'rollback-unconfirmed' };

export interface SessionContractFixture {
  /** The seeded session (of a show of a team with an owner, a granted and an ungranted member). */
  sessionId: string;
  /** User callers: the team's owner, a member granted the session's show, a member without a
   * grant. */
  users: { owner: SessionCallerShape; granted: SessionCallerShape; ungranted: SessionCallerShape };
  /** The round trips `fn`'s adapter statements took: statements sent before any reply to the
   * previous ones on their connection share one (counted through the adapter's `connect` seam). */
  roundTrips(fn: () => Promise<unknown>): Promise<number>;
  storage(sessionId?: string): SessionStorage;
  /** A catalog binding on the same adapter. */
  catalog: CatalogDb;
  /** The session's `session_meta` keys, read on another connection. */
  keys(): Promise<string[]>;
  /** Commits a `session_meta` row on another connection. */
  insertElsewhere(key: string): Promise<void>;
  /** On another connection, a transaction that locks the session's row; `locked` resolves once it
   * holds the lock, `release` ends it. */
  lockElsewhere(): { locked: Promise<void>; release(): Promise<void> };
  /** How many of the adapter's clients were ended. */
  endedClients(): number;
  close(): Promise<void>;
}

export interface SessionContractTarget {
  make(opts?: { txTimeoutMs?: number; fault?: SessionFault }): Promise<SessionContractFixture>;
}

const INSERT = 'INSERT INTO session_meta (session_id, key, value) VALUES (?, ?, ?)';
const KEYS = 'SELECT key FROM session_meta WHERE session_id = ? ORDER BY key';
const keysOf = (rows: { key: string }[]) => rows.map((r) => r.key);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The 7b-1 cases' caller: a system task (session-content-policies D12). */
const SYS: SessionCallerShape = { kind: 'system', reason: 'test' };

export function describeSessionSqlContract(name: string, target: SessionContractTarget): void {
  describe(`${name}: session storage contract`, () => {
    const unhandled: unknown[] = [];
    const trap = (e: unknown) => unhandled.push(e);
    const open: SessionContractFixture[] = [];
    const make = async (opts?: { txTimeoutMs?: number; fault?: SessionFault }) => {
      const f = await target.make(opts);
      open.push(f);
      return f;
    };
    beforeAll(() => {
      process.on('unhandledRejection', trap);
    });
    afterAll(() => {
      process.off('unhandledRejection', trap);
    });
    afterEach(async () => {
      await sleep(5);
      for (const f of open.splice(0)) await f.close();
      expect(unhandled, 'unhandled rejections').toEqual([]);
      unhandled.length = 0;
    });

    it('commits: run returns the affected-row count, all returns rows, counts are numbers', async () => {
      const f = await make();
      const s = f.storage();
      const changes = await s.tx(SYS, async (t) => {
        const a = await t.run(INSERT, f.sessionId, 'a', '1');
        const b = await t.run(INSERT, f.sessionId, 'b', '2');
        const none = await t.run(
          'UPDATE session_meta SET value = ? WHERE session_id = ? AND key = ?',
          'x',
          f.sessionId,
          'missing',
        );
        return [a.changes, b.changes, none.changes];
      });
      expect(changes).toEqual([1, 1, 0]);
      expect(await f.keys()).toEqual(['a', 'b']);
      const read = await s.snapshot(SYS, async (t) => ({
        keys: keysOf(await t.all<{ key: string }>(KEYS, f.sessionId)),
        n: (
          await t.all<{ n: number }>(
            'SELECT count(*) AS n FROM session_meta WHERE session_id = ?',
            f.sessionId,
          )
        )[0]?.n,
      }));
      expect(read).toEqual({ keys: ['a', 'b'], n: 2 });
    });

    it('rolls back on a thrown error and on a statement error the body catches', async () => {
      const f = await make();
      const s = f.storage();
      await expect(
        s.tx(SYS, async (t) => {
          await t.run(INSERT, f.sessionId, 'thrown', '1');
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      await s.tx(SYS, async (t) => t.run(INSERT, f.sessionId, 'dup', '1'));
      await expect(
        s.tx(SYS, async (t) => {
          await t.run(INSERT, f.sessionId, 'before', '1');
          await t.run(INSERT, f.sessionId, 'dup', '2').catch(() => {});
          await t.run(INSERT, f.sessionId, 'after', '1').catch(() => {});
        }),
      ).rejects.toMatchObject({ code: '23505' });
      expect(await f.keys()).toEqual(['dup']);
    });

    it('a joined t.tx commits with the outer transaction, and its failure rolls all of it back', async () => {
      const f = await make();
      const s = f.storage();
      await s.tx(SYS, async (t) => {
        await t.run(INSERT, f.sessionId, 'outer', '1');
        await t.tx(async (j) => j.run(INSERT, f.sessionId, 'inner', '1'));
      });
      expect(await f.keys()).toEqual(['inner', 'outer']);
      await expect(
        s.tx(SYS, async (t) => {
          await t.run(INSERT, f.sessionId, 'outer2', '1');
          await t
            .tx(async (j) => {
              await j.run(INSERT, f.sessionId, 'inner2', '1');
              throw new Error('inner failed');
            })
            .catch(() => {});
        }),
      ).rejects.toThrow('inner failed');
      expect(await f.keys()).toEqual(['inner', 'outer']);
    });

    it('misuse rejects: a handle after its transaction, a body returning while a joined body runs, a root call inside an open transaction', async () => {
      const f = await make();
      const s = f.storage();
      let kept: SessionSqlHandle | undefined;
      await s.tx(SYS, async (t) => {
        kept = t;
      });
      await expect(kept?.run(INSERT, f.sessionId, 'late', '1')).rejects.toBeInstanceOf(
        CatalogTxMisuseError,
      );
      const g = gate();
      await expect(
        s.tx(SYS, async (t) => {
          void t.tx(async () => {
            await g.wait;
          });
        }),
      ).rejects.toBeInstanceOf(CatalogTxMisuseError);
      g.open();
      for (const nested of [
        () => s.tx(SYS, async () => 1),
        () => s.snapshot(SYS, async () => 1),
        () => f.storage('other-session').tx(SYS, async () => 1),
        () => f.catalog.all('SELECT 1 AS one'),
      ]) {
        let inner: unknown;
        await expect(
          prompt(
            s.tx(SYS, async (t) => {
              await t.run(INSERT, f.sessionId, 'nested', '1');
              inner = await nested().catch((e: unknown) => e);
            }),
            3000,
          ),
        ).rejects.toBeInstanceOf(CatalogTxMisuseError);
        expect(inner).toBeInstanceOf(CatalogTxMisuseError);
      }
      expect(await f.keys()).toEqual([]);
    });

    it("holds the session row's lock before the body runs", async () => {
      const f = await make();
      const s = f.storage();
      // Inside a body, another connection's FOR UPDATE on the row waits for the commit.
      let other: ReturnType<SessionContractFixture['lockElsewhere']> | undefined;
      let otherLocked = false;
      await s.tx(SYS, async (t) => {
        await t.run(INSERT, f.sessionId, 'held', '1');
        other = f.lockElsewhere();
        void other.locked.then(() => {
          otherLocked = true;
        });
        await sleep(300);
        expect(otherLocked).toBe(false);
      });
      await prompt(other?.locked ?? Promise.resolve(), 3000);
      await other?.release();
      // And a body does not start while another connection holds the row.
      const held = f.lockElsewhere();
      await prompt(held.locked, 3000);
      let ran = false;
      const waiting = s.tx(SYS, async (t) => {
        ran = true;
        await t.run(INSERT, f.sessionId, 'after-lock', '1');
      });
      await sleep(300);
      expect(ran).toBe(false);
      await held.release();
      await prompt(waiting, 3000);
      expect(ran).toBe(true);
      expect(await f.keys()).toEqual(['after-lock', 'held']);
    });

    it('a session with no catalog row rejects with SessionNotFoundError and never runs the body', async () => {
      const f = await make();
      let ran = false;
      await expect(
        f.storage('no-such-session').tx(SYS, async () => {
          ran = true;
        }),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
      expect(ran).toBe(false);
      // The adapter keeps working.
      await f.storage().tx(SYS, async (t) => t.run(INSERT, f.sessionId, 'ok', '1'));
      expect(await f.keys()).toEqual(['ok']);
    });

    it("a snapshot's statements see one state while another connection commits between them", async () => {
      const f = await make();
      const s = f.storage();
      await s.tx(SYS, async (t) => t.run(INSERT, f.sessionId, 'first', '1'));
      const [before, after] = await s.snapshot(SYS, async (t) => {
        const a = keysOf(await t.all<{ key: string }>(KEYS, f.sessionId));
        await f.insertElsewhere('between');
        const b = await t.tx(async (j) => keysOf(await j.all<{ key: string }>(KEYS, f.sessionId)));
        return [a, b];
      });
      expect(before).toEqual(['first']);
      expect(after).toEqual(['first']);
      expect(await f.keys()).toEqual(['between', 'first']);
    });

    it('a write inside a snapshot fails with 25006 and writes nothing', async () => {
      const f = await make();
      await expect(
        f.storage().snapshot(SYS, async (t) => t.run(INSERT, f.sessionId, 'ro', '1')),
      ).rejects.toMatchObject({ code: '25006' });
      expect(await f.keys()).toEqual([]);
    });

    it('an unconfirmed rollback retires the connection, and the next call works', async () => {
      const f = await make({ fault: { kind: 'rollback-unconfirmed' } });
      const s = f.storage();
      const ended = f.endedClients();
      await expect(
        prompt(
          s.tx(SYS, async (t) => {
            await t.run(INSERT, f.sessionId, 'doomed', '1');
            throw new Error('boom');
          }),
          5000,
        ),
      ).rejects.toThrow('boom');
      expect(f.endedClients()).toBeGreaterThan(ended);
      await prompt(
        s.tx(SYS, async (t) => t.run(INSERT, f.sessionId, 'next', '1')),
        5000,
      );
      expect(await f.keys()).toEqual(['next']);
    });

    it('a deadlock (40P01) re-runs the body once, and the caller sees one result', async () => {
      const f = await make({ fault: { kind: 'deadlock', bind: 'deadlocked' } });
      let runs = 0;
      const result = await f.storage().tx(SYS, async (t) => {
        runs++;
        await t.run(INSERT, f.sessionId, 'deadlocked', String(runs));
        return `run ${runs}`;
      });
      expect(runs).toBe(2);
      expect(result).toBe('run 2');
      expect(await f.keys()).toEqual(['deadlocked']);
    });

    it('the deadline rejects a hung body with CatalogTxTimeoutError, and the next transaction on the session runs', async () => {
      const f = await make({ txTimeoutMs: 1000 });
      const s = f.storage();
      const started = Date.now();
      await expect(
        prompt(
          s.tx(SYS, async (t) => {
            await t.run(INSERT, f.sessionId, 'hung-js', '1');
            await new Promise(() => {});
          }),
          5000,
        ),
      ).rejects.toBeInstanceOf(CatalogTxTimeoutError);
      await expect(
        prompt(
          s.tx(SYS, async (t) => {
            await t.run(INSERT, f.sessionId, 'hung-sql', '1');
            await t.all('SELECT pg_sleep(60)');
          }),
          5000,
        ),
      ).rejects.toBeInstanceOf(CatalogTxTimeoutError);
      expect(Date.now() - started).toBeLessThan(4000);
      await prompt(
        s.tx(SYS, async (t) => t.run(INSERT, f.sessionId, 'next', '1')),
        3000,
      );
      expect(await f.keys()).toEqual(['next']);
    });

    it('a NUL bind is refused with CatalogInvalidTextError, and the transaction writes nothing', async () => {
      const f = await make();
      const s = f.storage();
      await expect(
        s.tx(SYS, async (t) => {
          await t.run(INSERT, f.sessionId, 'ok', '1');
          await t.run(INSERT, f.sessionId, 'bad', 'a\u0000b');
        }),
      ).rejects.toBeInstanceOf(CatalogInvalidTextError);
      await expect(
        s.snapshot(SYS, async (t) => t.all(KEYS, 'a\u0000b')),
      ).rejects.toBeInstanceOf(CatalogInvalidTextError);
      expect(await f.keys()).toEqual([]);
    });

    it('a double precision value reads back exactly', async () => {
      const f = await make();
      const s = f.storage();
      await s.tx(SYS, async (t) =>
        t.run(
          'INSERT INTO session_transcript_words (session_id, id, start_sec, end_sec, ordinal, created_at_utc) VALUES (?, ?, ?, ?, ?, ?)',
          f.sessionId,
          'w1',
          3826.95,
          3827.1499999999996,
          0,
          '2026-10-08T00:00:00.000Z',
        ),
      );
      const rows = await s.snapshot(SYS, async (t) =>
        t.all(
          'SELECT start_sec, end_sec FROM session_transcript_words WHERE session_id = ? AND id = ?',
          f.sessionId,
          'w1',
        ),
      );
      expect(rows).toEqual([{ start_sec: 3826.95, end_sec: 3827.1499999999996 }]);
    });

    it('a JSON array travels as one ?::text::json bind', async () => {
      const f = await make();
      const s = f.storage();
      const inserted = await s.tx(SYS, async (t) =>
        t.run(
          'INSERT INTO session_meta (session_id, key, value) SELECT ?, r.key, r.value FROM json_to_recordset(?::text::json) AS r(key text, value text)',
          f.sessionId,
          JSON.stringify([
            { key: 'j1', value: '1' },
            { key: 'j2', value: '2' },
            { key: 'j3', value: '3' },
          ]),
        ),
      );
      expect(inserted).toEqual({ changes: 3 });
      const deleted = await s.tx(SYS, async (t) =>
        t.run(
          'DELETE FROM session_meta WHERE session_id = ? AND key IN (SELECT json_array_elements_text(?::text::json))',
          f.sessionId,
          JSON.stringify(['j1', 'j3', 'absent']),
        ),
      );
      expect(deleted).toEqual({ changes: 2 });
      expect(await f.keys()).toEqual(['j2']);
    });

    it('with the four session slots held by open snapshots, a catalog transaction commits at once and a fifth session call waits for a slot', async () => {
      const f = await make();
      const s = f.storage();
      const g = gate();
      let started = 0;
      const allStarted = gate();
      const held = Array.from({ length: 4 }, () =>
        s.snapshot(SYS, async (t) => {
          await t.all(KEYS, f.sessionId);
          if (++started === 4) allStarted.open();
          await g.wait;
        }),
      );
      await prompt(allStarted.wait, 3000);
      const t0 = Date.now();
      await prompt(
        f.catalog.tx(async (t) =>
          t.run('UPDATE sessions SET title = ? WHERE id = ?', 'renamed', f.sessionId),
        ),
        3000,
      );
      expect(Date.now() - t0).toBeLessThan(1000);
      let fifth = false;
      const waiting = s.tx(SYS, async (t) => {
        fifth = true;
        await t.run(INSERT, f.sessionId, 'fifth', '1');
      });
      await sleep(300);
      expect(fifth).toBe(false);
      g.open();
      await prompt(Promise.all([...held, waiting]), 3000);
      expect(fifth).toBe(true);
      expect(await f.keys()).toEqual(['fifth']);
    });

    // -- session-content-policies D4: user callers under the content policies --------------------

    it('an ungranted user tx rejects with SessionAccessDeniedError, a missing session with SessionNotFoundError, and the body never runs', async () => {
      const f = await make();
      let ran = 0;
      await expect(
        f.storage().tx(f.users.ungranted, async (t) => {
          ran++;
          await t.run(INSERT, f.sessionId, 'denied', '1');
        }),
      ).rejects.toBeInstanceOf(SessionAccessDeniedError);
      await expect(
        f.storage('no-such-session').tx(f.users.ungranted, async () => {
          ran++;
        }),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
      await expect(
        f.storage('no-such-session').tx(f.users.owner, async () => {
          ran++;
        }),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
      expect(ran).toBe(0);
      expect(await f.keys()).toEqual([]);
    });

    it('an ungranted user snapshot rejects the same way without running its body', async () => {
      const f = await make();
      await f.storage().tx(SYS, async (t) => t.run(INSERT, f.sessionId, 'seen', '1'));
      let ran = 0;
      await expect(
        f.storage().snapshot(f.users.ungranted, async (t) => {
          ran++;
          return t.all(KEYS, f.sessionId);
        }),
      ).rejects.toBeInstanceOf(SessionAccessDeniedError);
      await expect(
        f.storage('no-such-session').snapshot(f.users.ungranted, async () => {
          ran++;
        }),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
      expect(ran).toBe(0);
    });

    it("a granted user's tx commits and snapshot sees the rows; so do the owner's", async () => {
      const f = await make();
      for (const [who, caller] of [
        ['granted', f.users.granted],
        ['owner', f.users.owner],
      ] as const) {
        await f.storage().tx(caller, async (t) => t.run(INSERT, f.sessionId, who, '1'));
      }
      expect(await f.keys()).toEqual(['granted', 'owner']);
      for (const caller of [f.users.granted, f.users.owner]) {
        const keys = await f
          .storage()
          .snapshot(caller, async (t) => keysOf(await t.all<{ key: string }>(KEYS, f.sessionId)));
        expect(keys).toEqual(['granted', 'owner']);
      }
    });

    it('a user tx and snapshot that succeed take no more round trips than a system one', async () => {
      const f = await make();
      const s = f.storage();
      const write = (caller: SessionCallerShape, key: string) => () =>
        s.tx(caller, async (t) => t.run(INSERT, f.sessionId, key, '1'));
      const read = (caller: SessionCallerShape) => () =>
        s.snapshot(caller, async (t) => t.all(KEYS, f.sessionId));
      const sysWrite = await f.roundTrips(write(SYS, 'sys'));
      const userWrite = await f.roundTrips(write(f.users.granted, 'user'));
      const sysRead = await f.roundTrips(read(SYS));
      const userRead = await f.roundTrips(read(f.users.granted));
      expect({ userWrite, userRead }).toEqual({ userWrite: sysWrite, userRead: sysRead });
      // BEGIN with the preamble (and the lock or probe), the body's statement, COMMIT.
      expect(sysWrite).toBe(3);
      expect(sysRead).toBe(3);
    });

    it("SessionAccessDeniedError's message is neutral and names no id; the id is a property", async () => {
      const f = await make();
      const err = await f
        .storage()
        .tx(f.users.ungranted, async () => undefined)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SessionAccessDeniedError);
      expect((err as Error).message).toBe('access to the session was refused');
      expect((err as Error).message).not.toContain(f.sessionId);
      expect((err as SessionAccessDeniedError).sessionId).toBe(f.sessionId);
      expect(new SessionAccessDeniedError('s-x').message).toBe('access to the session was refused');
    });
  });
}
