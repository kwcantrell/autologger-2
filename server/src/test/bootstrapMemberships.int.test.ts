// Task 7.3 — membership-bootstrap template, driven against the REAL in-process
// app + SQLite harness (fetch is routed into app.request), so the frozen
// /api/admin/* endpoints are exercised end to end.
import { describe, expect, it } from 'vitest';
import {
  type BootstrapConfig,
  bootstrapMemberships,
  parseConfig,
} from '../../scripts/bootstrapMemberships.example';
import { app, envWith } from './harness';
import { catalogFor, seedUser } from './helpers';

const TOKEN = 'bootstrap-admin-token-0123456789';
const ENV = envWith({ ADMIN_TOKEN: TOKEN });
const BASE = 'http://router.test';

const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(url));
  return app.request(u.pathname + u.search, init, ENV);
}) as typeof fetch;

function run(config: BootstrapConfig, extra: { dryRun?: boolean; token?: string } = {}) {
  const lines: string[] = [];
  const p = bootstrapMemberships(config, {
    baseUrl: BASE,
    token: extra.token ?? TOKEN,
    dryRun: extra.dryRun,
    fetch: fakeFetch,
    log: (l) => lines.push(l),
  });
  return p.then((s) => ({ s, lines }));
}

const membersOf = async (userId: string): Promise<string[]> =>
  await catalogFor().auth.authListStudioIdsForUser(userId);

describe('bootstrapMemberships', () => {
  it('creates teams, grants memberships, reports unknown users as pending, and is idempotent', async () => {
    const alice = await seedUser({ email: 'alice@example.com' });
    const bob = await seedUser({ email: 'Bob@Example.com' });
    const cfg: BootstrapConfig = {
      teams: [{ id: 'boot-team', display_name: 'Boot Team' }],
      memberships: [
        { email: 'alice@example.com', team: 'boot-team', role: 'admin' },
        { email: 'bob@example.com', team: 'boot-team' },
        { email: 'carol@example.com', team: 'boot-team' },
      ],
    };
    const first = await run(cfg);
    expect(first.s.exitCode).toBe(3);
    expect(first.s.teamsCreated).toEqual(['boot-team']);
    expect(first.s.granted).toHaveLength(2);
    expect(first.s.pending).toEqual(['carol@example.com']);
    expect(await membersOf(alice)).toContain('boot-team');
    expect(await membersOf(bob)).toContain('boot-team');

    // Re-run: team exists, bob already a member (no-op); alice has a role so is re-upserted.
    const second = await run(cfg);
    expect(second.s.exitCode).toBe(3);
    expect(second.s.teamsCreated).toEqual([]);
    expect(second.s.unchanged).toHaveLength(1);
    expect((await membersOf(bob)).filter((t) => t === 'boot-team')).toHaveLength(1);

    // Carol signs in; the next run completes cleanly.
    const carol = await seedUser({ email: 'carol@example.com' });
    const third = await run(cfg);
    expect(third.s.exitCode).toBe(0);
    expect(await membersOf(carol)).toContain('boot-team');
  });

  it('dry run writes nothing', async () => {
    const u = await seedUser({ email: 'dry@example.com' });
    const { s } = await run(
      {
        teams: [{ id: 'dry-team', display_name: 'Dry' }],
        memberships: [{ email: 'dry@example.com', team: 'dry-team' }],
      },
      { dryRun: true },
    );
    expect(s.exitCode).toBe(0);
    expect(catalogFor().studios.isKnownStudio('dry-team')).toBe(false);
    expect(await membersOf(u)).not.toContain('dry-team');
  });

  it('a wrong token exits 1 and the token never appears in the output', async () => {
    const { s, lines } = await run({ memberships: [] }, { token: 'wrong-secret-token-value' });
    expect(s.exitCode).toBe(1);
    expect(lines.join('\n')).not.toContain('wrong-secret-token-value');
    const ok = await run({ memberships: [] });
    expect(ok.lines.join('\n')).not.toContain(TOKEN);
  });

  it('unknown team not declared in "teams" is an error (exit 1)', async () => {
    await seedUser({ email: 'noteam@example.com' });
    const { s } = await run({
      memberships: [{ email: 'noteam@example.com', team: 'does-not-exist' }],
    });
    expect(s.exitCode).toBe(1);
  });

  it('parseConfig rejects malformed input', () => {
    expect(() => parseConfig({})).toThrow();
    expect(() =>
      parseConfig({ memberships: [{ email: 'a@b.c', team: 'x', role: 'root' }] }),
    ).toThrow();
  });
});
