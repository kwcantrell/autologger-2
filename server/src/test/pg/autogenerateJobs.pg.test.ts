// batch-autogenerate design D1, D2 (tasks 1.2-1.3): `catalog.autogenerate_jobs` and
// `catalog.autogenerate_items` of `20261025000000_autogenerate_jobs.sql`: their checks, the live
// index, the cascade from the team, and the row-level security of catalog_user (owners and admins
// of the team read; the initiator inserts its own queued job and items; a manager may only request
// a cancel, or cancel a queued job) and catalog_system (everything).
//
// Fixture (policyFixture.ts): team T with `owner`, `admin`, `granted` (member) and `ungranted`
// (member); team U owned by `outsider`. Jobs seeded here as catalog_system: `jq` queued in T by
// `admin`, `jr` running in T by `owner` (both cannot be live at once, so `jr` is in team V, owned by
// `owner`), `jf` finished in T, `ju` finished in U.

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../test/pg/testDb';
import { seedPolicyFixture, T, U, V } from './policyFixture';

let db: TestDatabase;
let sys: postgres.Sql;
let app: postgres.Sql;
let admin: postgres.Sql;

const q = (v: string | number | null) =>
  v === null ? 'null' : typeof v === 'number' ? String(v) : `'${v.replaceAll("'", "''")}'`;

interface Job {
  id: string;
  team: string;
  by: string;
  status?: string;
  stop?: string | null;
  lockedBy?: string | null;
  lockedUntil?: number | null;
  cancelAt?: number | null;
  cancelBy?: string | null;
  finishedAt?: number | null;
}
const insertJob = (j: Job) =>
  `insert into autogenerate_jobs (id, team_id, initiator_user_id, initiator_name, scope,
     show_ids_json, steps, wiki_mode, status, stop_reason, session_count, locked_by,
     locked_until_ms, cancel_requested_at_ms, cancel_requested_by_user_id,
     cancel_requested_by_name, created_at_ms, finished_at_ms, updated_at_ms)
   values (${q(j.id)}, ${q(j.team)}, ${q(j.by)}, 'Fixture Name', 'shows', '["s1"]',
     'transcript,topics', 'accept', ${q(j.status ?? 'queued')}, ${q(j.stop ?? null)}, 1,
     ${q(j.lockedBy ?? null)}, ${q(j.lockedUntil ?? null)}, ${q(j.cancelAt ?? null)},
     ${q(j.cancelBy ?? null)}, ${q(j.cancelBy ? 'Canceller' : null)}, 1, ${q(j.finishedAt ?? null)}, 1)`;
const insertItem = (
  job: string,
  step: string,
  status = 'pending',
  outcome: string | null = null,
  session = 'ss1',
) =>
  `insert into autogenerate_items (job_id, session_id, step, ordinal, step_order, status, outcome)
   values (${q(job)}, ${q(session)}, ${q(step)}, 0,
     ${['transcript', 'events', 'topics', 'wiki'].indexOf(step)}, ${q(status)}, ${q(outcome)})`;

beforeAll(async () => {
  db = await createTestDatabase();
  sys = postgres({ ...db.system, max: 1, onnotice: () => {} });
  app = postgres({ ...db.app, max: 1, onnotice: () => {} });
  admin = postgres({ ...db.admin, max: 1, onnotice: () => {} });
  await seedPolicyFixture(sys);
  for (const j of [
    { id: 'jq', team: T, by: 'admin' },
    { id: 'jr', team: V, by: 'owner', status: 'running', lockedBy: 'w1', lockedUntil: 9 },
    { id: 'jf', team: T, by: 'owner', status: 'finished', finishedAt: 5 },
    { id: 'ju', team: U, by: 'outsider', status: 'finished', finishedAt: 5 },
  ] as Job[]) {
    await sys.unsafe(insertJob(j));
  }
  for (const j of ['jq', 'jf', 'ju']) await sys.unsafe(insertItem(j, 'transcript'));
  await sys.unsafe(insertItem('jr', 'topics', 'running'));
});
afterAll(async () => {
  await sys?.end();
  await app?.end();
  await admin?.end();
});

class Rollback extends Error {}
type Outcome = { rows: Record<string, unknown>[]; count: number } | { code: string };

/** Runs `stmts` in one transaction that rolls back, as catalog_user bound to `actor`, or as
 * catalog_system when `actor` is null: the last statement's rows, or the first error's code. */
async function as(actor: string | null, ...stmts: string[]): Promise<Outcome> {
  let out!: Outcome;
  await app
    .begin(async (tx) => {
      await tx`select set_config('role', ${actor === null ? 'catalog_system' : 'catalog_user'}, true),
                      set_config('app.user_id', ${actor ?? ''}, true)`;
      for (const s of stmts) {
        try {
          const r = await tx.unsafe(s);
          out = { rows: [...r], count: r.count };
        } catch (e) {
          out = { code: String((e as { code?: unknown }).code) };
          break;
        }
      }
      throw new Rollback();
    })
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
  return out;
}
const codeOf = (o: Outcome) => ('code' in o ? o.code : 'ok');
const idsOf = (o: Outcome) =>
  'code' in o ? o : o.rows.map((r) => String(r.id ?? r.job_id)).sort();
/** An update/delete outcome: `ok:<rows changed>` or the error code. */
const changed = (o: Outcome) => ('code' in o ? o.code : `ok:${o.count}`);

/** The code of `stmt` run as postgres in a rolled-back transaction. */
async function adminCode(...stmts: string[]): Promise<string> {
  let out = 'ok';
  await admin
    .begin(async (tx) => {
      for (const s of stmts) {
        try {
          await tx.unsafe(s);
        } catch (e) {
          out = String((e as { code?: unknown }).code);
          break;
        }
      }
      throw new Rollback();
    })
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
  return out;
}

describe('the job and item tables (batch-autogenerate design D1)', () => {
  it('have the designed columns', async () => {
    const cols = async (t: string) =>
      (
        await admin`select column_name as c from information_schema.columns
                  where table_schema = 'catalog' and table_name = ${t} order by ordinal_position`
      ).map((r) => r.c);
    expect(await cols('autogenerate_jobs')).toEqual([
      'id',
      'team_id',
      'initiator_user_id',
      'initiator_name',
      'scope',
      'show_ids_json',
      'steps',
      'wiki_mode',
      'status',
      'stop_reason',
      'consecutive_stt_failures',
      'consecutive_llm_failures',
      'session_count',
      'locked_by',
      'locked_until_ms',
      'cancel_requested_at_ms',
      'cancel_requested_by_user_id',
      'cancel_requested_by_name',
      'created_at_ms',
      'started_at_ms',
      'finished_at_ms',
      'updated_at_ms',
    ]);
    expect(await cols('autogenerate_items')).toEqual([
      'job_id',
      'session_id',
      'step',
      'ordinal',
      'step_order',
      'effective_date',
      'status',
      'outcome',
      'attempts',
      'run_ids',
      'own_topic_ids',
      'kept_edited',
      'wiki_accepted',
      'wiki_pending',
      'started_at_ms',
      'finished_at_ms',
    ]);
  });

  it('allow one queued or running job per team, any number of ended ones', async () => {
    // jq is queued in T: a second queued or running job in T collides.
    expect(
      await adminCode(`set search_path = catalog`, insertJob({ id: 'x', team: T, by: 'owner' })),
    ).toBe('23505');
    expect(
      await adminCode(
        `set search_path = catalog`,
        insertJob({ id: 'x', team: T, by: 'owner', status: 'running' }),
      ),
    ).toBe('23505');
    expect(
      await adminCode(
        `set search_path = catalog`,
        insertJob({ id: 'x', team: T, by: 'owner', status: 'finished', finishedAt: 1 }),
      ),
    ).toBe('ok');
    expect(
      await adminCode(
        `set search_path = catalog`,
        insertJob({ id: 'x', team: T, by: 'owner', status: 'cancelled', stop: 'cancelled' }),
      ),
    ).toBe('ok');
  });

  it('check outcomes, stop reasons and their pairing with the status', async () => {
    const sp = 'set search_path = catalog';
    // An outcome outside the list.
    expect(await adminCode(sp, insertItem('jf', 'topics', 'skipped', 'whatever'))).toBe('23514');
    // A stop reason outside the list.
    expect(
      await adminCode(
        sp,
        insertJob({ id: 'x', team: U, by: 'outsider', status: 'failed', stop: 'nope' }),
      ),
    ).toBe('23514');
    // An outcome with the wrong item status.
    expect(await adminCode(sp, insertItem('jf', 'topics', 'failed', 'present'))).toBe('23514');
    expect(await adminCode(sp, insertItem('jf', 'topics', 'skipped', 'interrupted'))).toBe('23514');
    expect(await adminCode(sp, insertItem('jf', 'topics', 'done', 'present'))).toBe('23514');
    expect(await adminCode(sp, insertItem('jf', 'topics', 'skipped', null))).toBe('23514');
    expect(await adminCode(sp, insertItem('jf', 'topics', 'cancelled', 'job-stopped'))).toBe('ok');
    expect(await adminCode(sp, insertItem('jf', 'topics', 'failed', 'rate-limited'))).toBe('ok');
    expect(await adminCode(sp, insertItem('jf', 'topics', 'done', null))).toBe('ok');
    // stop_reason null with failed, a reason with finished, `cancelled` with failed.
    expect(
      await adminCode(sp, insertJob({ id: 'x', team: U, by: 'outsider', status: 'failed' })),
    ).toBe('23514');
    expect(
      await adminCode(
        sp,
        insertJob({ id: 'x', team: U, by: 'outsider', status: 'finished', stop: 'not-approved' }),
      ),
    ).toBe('23514');
    expect(
      await adminCode(
        sp,
        insertJob({ id: 'x', team: U, by: 'outsider', status: 'failed', stop: 'cancelled' }),
      ),
    ).toBe('23514');
    expect(
      await adminCode(
        sp,
        insertJob({ id: 'x', team: U, by: 'outsider', status: 'failed', stop: 'provider-failing' }),
      ),
    ).toBe('ok');
  });

  it('go with their team (cascade, as postgres standing in for adminDeleteStudio and the importer)', async () => {
    const before =
      await admin`select count(*)::int as n from catalog.autogenerate_items where job_id = 'ju'`;
    expect(before[0]?.n).toBe(1);
    let left: { jobs: number; items: number } | undefined;
    await admin
      .begin(async (tx) => {
        await tx`delete from catalog.show_grants where show_id in (select id from catalog.shows where studio_id = ${U})`;
        await tx`delete from catalog.studio_definitions where id = ${U}`;
        const [j] =
          await tx`select count(*)::int as n from catalog.autogenerate_jobs where team_id = ${U}`;
        const [i] =
          await tx`select count(*)::int as n from catalog.autogenerate_items where job_id = 'ju'`;
        left = { jobs: j?.n, items: i?.n };
        throw new Rollback();
      })
      .catch((e) => {
        if (!(e instanceof Rollback)) throw e;
      });
    expect(left).toEqual({ jobs: 0, items: 0 });
  });
});

describe('catalog_user select (design D2)', () => {
  it('owner and admin of the team see its jobs and items; a member, an outsider and another team admin see none', async () => {
    const jobs = 'select id from autogenerate_jobs';
    const items = 'select job_id from autogenerate_items';
    expect(idsOf(await as('owner', jobs))).toEqual(['jf', 'jq', 'jr']);
    expect(idsOf(await as('admin', jobs))).toEqual(['jf', 'jq']);
    expect(idsOf(await as('admin', items))).toEqual(['jf', 'jq']);
    expect(idsOf(await as('granted', jobs))).toEqual([]);
    expect(idsOf(await as('granted', items))).toEqual([]);
    expect(idsOf(await as('ungranted', jobs))).toEqual([]);
    expect(idsOf(await as('outsider', jobs))).toEqual(['ju']);
    expect(idsOf(await as('outsider', items))).toEqual(['ju']);
  });
});

describe('catalog_user insert (design D2)', () => {
  const sp = 'set search_path = catalog';
  const freeT = `update autogenerate_jobs set status = 'cancelled', stop_reason = 'cancelled' where id = 'jq'`;
  it('an admin inserts a queued job it initiates, and its items', async () => {
    // jq holds T's live slot; free it as the system first (in the same rolled-back transaction).
    let out!: string;
    await app
      .begin(async (tx) => {
        await tx`select set_config('role', 'catalog_system', true)`;
        await tx.unsafe(freeT);
        await tx`select set_config('role', 'catalog_user', true), set_config('app.user_id', 'admin', true)`;
        await tx.unsafe(insertJob({ id: 'n1', team: T, by: 'admin' }));
        await tx.unsafe(insertItem('n1', 'transcript'));
        await tx.unsafe(insertItem('n1', 'wiki'));
        const r = await tx`select count(*)::int as n from autogenerate_items where job_id = 'n1'`;
        out = `ok:${r[0]?.n}`;
        throw new Rollback();
      })
      .catch((e) => {
        if (!(e instanceof Rollback)) throw e;
      });
    expect(out).toBe('ok:2');
  });

  it('refuses a member, another initiator, another team, a running job, lease or cancel columns, and items of another user’s job', async () => {
    const asSys = async (actor: string, ...stmts: string[]) => {
      let code = 'ok';
      await app
        .begin(async (tx) => {
          await tx`select set_config('role', 'catalog_system', true)`;
          await tx.unsafe(freeT);
          await tx`select set_config('role', 'catalog_user', true), set_config('app.user_id', ${actor}, true)`;
          for (const s of stmts) {
            try {
              await tx.unsafe(s);
            } catch (e) {
              code = String((e as { code?: unknown }).code);
              break;
            }
          }
          throw new Rollback();
        })
        .catch((e) => {
          if (!(e instanceof Rollback)) throw e;
        });
      return code;
    };
    void sp;
    expect(await asSys('granted', insertJob({ id: 'n', team: T, by: 'granted' }))).toBe('42501');
    expect(await asSys('admin', insertJob({ id: 'n', team: T, by: 'owner' }))).toBe('42501');
    expect(await asSys('outsider', insertJob({ id: 'n', team: T, by: 'outsider' }))).toBe('42501');
    expect(
      await asSys(
        'admin',
        insertJob({
          id: 'n',
          team: T,
          by: 'admin',
          status: 'running',
          lockedBy: 'w',
          lockedUntil: 1,
        }),
      ),
    ).toBe('42501');
    expect(
      await asSys(
        'admin',
        insertJob({ id: 'n', team: T, by: 'admin', lockedBy: 'w', lockedUntil: 1 }),
      ),
    ).toBe('42501');
    expect(
      await asSys(
        'admin',
        insertJob({ id: 'n', team: T, by: 'admin', cancelAt: 1, cancelBy: 'admin' }),
      ),
    ).toBe('42501');
    // Items for another user's job (jq is admin's queued job; owner manages T but did not start it).
    expect(await as('owner', insertItem('jq', 'events'))).toEqual({ code: '42501' });
    // ... and for a job that isn't queued, by its own initiator.
    expect(await as('owner', insertItem('jr', 'events'))).toEqual({ code: '42501' });
    // An item inserted already ended.
    expect(await as('admin', insertItem('jq', 'events', 'done'))).toEqual({ code: '42501' });
    expect(await as('admin', insertItem('jq', 'events'))).toMatchObject({ count: 1 });
  });
});

describe('catalog_user update (design D2, autogenerate_jobs_user_guard)', () => {
  const cancelCols = (by: string) =>
    `cancel_requested_at_ms = 7, cancel_requested_by_user_id = '${by}',
     cancel_requested_by_name = 'N', updated_at_ms = 7`;
  it('a manager requests a cancel on a running job (cancel columns only)', async () => {
    expect(
      changed(
        await as('owner', `update autogenerate_jobs set ${cancelCols('owner')} where id = 'jr'`),
      ),
    ).toBe('ok:1');
  });

  it('a manager cancels a queued job at once', async () => {
    expect(
      changed(
        await as(
          'owner',
          `update autogenerate_jobs set ${cancelCols('owner')}, status = 'cancelled',
             stop_reason = 'cancelled', finished_at_ms = 7 where id = 'jq'`,
        ),
      ),
    ).toBe('ok:1');
  });

  // Consistency read 2026-11-10, design D2/D10: cancelling a queued job ends its items in the same
  // statement (the definer trigger), with no item privilege for catalog_user.
  it('a queued cancel ends every item cancelled/cancelled in the same statement', async () => {
    let items: Record<string, unknown>[] = [];
    await app
      .begin(async (tx) => {
        await tx`select set_config('role', 'catalog_system', true)`;
        await tx.unsafe(insertItem('jq', 'events'));
        await tx`select set_config('role', 'catalog_user', true), set_config('app.user_id', 'owner', true)`;
        await tx.unsafe(`update autogenerate_jobs set ${cancelCols('owner')}, status = 'cancelled',
             stop_reason = 'cancelled', finished_at_ms = 7 where id = 'jq'`);
        items = [
          ...(await tx`select step, status, outcome, finished_at_ms::int as f, kept_edited
                       from autogenerate_items where job_id = 'jq' order by step_order`),
        ];
        throw new Rollback();
      })
      .catch((e) => {
        if (!(e instanceof Rollback)) throw e;
      });
    expect(items.map((r) => ({ ...r }))).toEqual([
      { step: 'transcript', status: 'cancelled', outcome: 'cancelled', f: 7, kept_edited: null },
      { step: 'events', status: 'cancelled', outcome: 'cancelled', f: 7, kept_edited: 0 },
    ]);
    // catalog_user still holds no item update.
    expect(
      codeOf(
        await as('owner', `update autogenerate_items set status = 'cancelled' where job_id = 'jq'`),
      ),
    ).toBe('42501');
  });

  it('refuses a member, a second cancel, other transitions and every other column', async () => {
    // A member's cancel: invisible row (0 rows) or refused; never a change.
    expect(
      changed(
        await as(
          'granted',
          `update autogenerate_jobs set ${cancelCols('granted')} where id = 'jq'`,
        ),
      ),
    ).toBe('ok:0');
    // A cancel naming another user.
    expect(
      codeOf(
        await as('owner', `update autogenerate_jobs set ${cancelCols('admin')} where id = 'jq'`),
      ),
    ).toBe('42501');
    // A second cancel overwriting the first.
    expect(
      codeOf(
        await as(
          'admin',
          `update autogenerate_jobs set ${cancelCols('owner')} where id = 'jq'`,
          `set local app.user_id = 'owner'`,
          `update autogenerate_jobs set ${cancelCols('owner')} where id = 'jq'`,
        ),
      ),
    ).toBe('42501');
    // running → finished; a running job cancelled directly; a cancel on an ended job.
    expect(
      codeOf(
        await as(
          'owner',
          `update autogenerate_jobs set status = 'finished', finished_at_ms = 7 where id = 'jr'`,
        ),
      ),
    ).toBe('42501');
    expect(
      codeOf(
        await as(
          'owner',
          `update autogenerate_jobs set ${cancelCols('owner')}, status = 'cancelled',
             stop_reason = 'cancelled', finished_at_ms = 7 where id = 'jr'`,
        ),
      ),
    ).toBe('42501');
    expect(
      codeOf(
        await as('owner', `update autogenerate_jobs set ${cancelCols('owner')} where id = 'jf'`),
      ),
    ).toBe('42501');
    // Columns outside the grant.
    for (const set of [
      `initiator_user_id = 'owner'`,
      `steps = 'wiki'`,
      'consecutive_stt_failures = 1',
      'consecutive_llm_failures = 1',
      `locked_by = 'w2'`,
      'locked_until_ms = 99',
    ]) {
      expect(
        codeOf(await as('admin', `update autogenerate_jobs set ${set} where id = 'jq'`)),
        set,
      ).toBe('42501');
    }
    // Items: no update, no delete; jobs: no delete.
    expect(
      codeOf(
        await as('admin', `update autogenerate_items set status = 'done' where job_id = 'jq'`),
      ),
    ).toBe('42501');
    expect(codeOf(await as('admin', `delete from autogenerate_items where job_id = 'jq'`))).toBe(
      '42501',
    );
    expect(codeOf(await as('admin', `delete from autogenerate_jobs where id = 'jq'`))).toBe(
      '42501',
    );
  });
});

describe('catalog_system (design D2)', () => {
  it('may do all of the above', async () => {
    expect(idsOf(await as(null, 'select id from autogenerate_jobs'))).toEqual([
      'jf',
      'jq',
      'jr',
      'ju',
    ]);
    expect(
      changed(
        await as(
          null,
          `update autogenerate_jobs set status = 'running', locked_by = 'w', locked_until_ms = 5,
             consecutive_llm_failures = 2 where id = 'jq'`,
        ),
      ),
    ).toBe('ok:1');
    expect(
      changed(
        await as(
          null,
          `update autogenerate_items set status = 'done', run_ids = 'r1', own_topic_ids = 't1'
             where job_id = 'jq'`,
        ),
      ),
    ).toBe('ok:1');
    expect(changed(await as(null, `delete from autogenerate_items where job_id = 'jf'`))).toBe(
      'ok:1',
    );
    expect(changed(await as(null, `delete from autogenerate_jobs where id = 'jf'`))).toBe('ok:1');
    expect(
      codeOf(await as(null, insertJob({ id: 'n', team: U, by: 'outsider', status: 'running' }))),
    ).toBe('ok');
  });
});
