// TEMPLATE: re-runnable, idempotent team-membership bootstrap (task 7.3,
// containerize-split-images; design Migration Plan steps 3 and 4.6, gate G6).
//
//   ADMIN_TOKEN=... npx tsx server/scripts/bootstrapMemberships.example.ts memberships.json \
//       [--base-url http://127.0.0.1:8080] [--dry-run]
//
// Why: login is always required, so on anonymous-era data the first Google
// user has no teams. This grants them via the existing, frozen ADMIN_TOKEN
// endpoints (it only CALLS them; it adds no API surface):
//   GET    /api/admin/users
//   POST   /api/admin/studios                       {id, display_name}
//   POST   /api/admin/users/:userId/memberships     {studio_id, role?}
// The cutover replaces catalog.db, so this must be safely re-runnable.
//
// Input file (JSON; the operator writes it, no real data is committed here):
//   {
//     "teams":       [{ "id": "main-team", "display_name": "Main Team" }],
//     "memberships": [{ "email": "alice@example.com", "team": "main-team", "role": "admin" },
//                     { "email": "bob@example.com",   "team": "main-team" }]
//   }
// "role" is optional ("admin" | "member"). "teams" is optional: a listed team is
// created only if absent from the catalog.
//
// Idempotency: an existing team is skipped; a user already in the team with no
// "role" given is a no-op; with a "role" the POST is repeated (the endpoint is
// an upsert, so it is safe and sets the role). Users appear in the catalog only
// after their first Google sign-in, so an unknown email is reported as PENDING
// (exit 3) rather than failing; re-run after they sign in.
//
// The token comes ONLY from the ADMIN_TOKEN environment variable and is never
// printed. Base URL defaults to http://127.0.0.1:${ROUTER_PORT:-8080}.
//
// Exit codes: 0 all applied or already satisfied | 1 request/config error |
// 2 usage error | 3 some users not yet signed up (everything else applied).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BootstrapConfig {
  teams?: Array<{ id: string; display_name: string }>;
  memberships: Array<{ email: string; team: string; role?: 'admin' | 'member' }>;
}

export interface BootstrapOptions {
  baseUrl: string;
  token: string;
  dryRun?: boolean;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface BootstrapSummary {
  exitCode: number;
  teamsCreated: string[];
  granted: string[];
  unchanged: string[];
  pending: string[];
  errors: string[];
}

interface AdminUsers {
  studios_catalog: Array<{ id: string }>;
  users: Array<{ id: string; email: string; disabled: boolean; studios: Array<{ id: string }> }>;
}

export function parseConfig(raw: unknown): BootstrapConfig {
  const c = raw as Partial<BootstrapConfig> | null;
  if (!c || typeof c !== 'object' || !Array.isArray(c.memberships)) {
    throw new Error('config must be an object with a "memberships" array');
  }
  for (const m of c.memberships) {
    if (!m || typeof m.email !== 'string' || typeof m.team !== 'string') {
      throw new Error('each membership needs string "email" and "team"');
    }
    if (m.role !== undefined && m.role !== 'admin' && m.role !== 'member') {
      throw new Error(`invalid role for ${m.email}: ${String(m.role)}`);
    }
  }
  for (const t of c.teams ?? []) {
    if (typeof t?.id !== 'string' || typeof t?.display_name !== 'string') {
      throw new Error('each team needs string "id" and "display_name"');
    }
  }
  return c as BootstrapConfig;
}

export async function bootstrapMemberships(
  config: BootstrapConfig,
  opts: BootstrapOptions,
): Promise<BootstrapSummary> {
  const f = opts.fetch ?? fetch;
  const log = opts.log ?? ((l: string) => console.log(l));
  const base = opts.baseUrl.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' };
  const out: BootstrapSummary = {
    exitCode: 0,
    teamsCreated: [],
    granted: [],
    unchanged: [],
    pending: [],
    errors: [],
  };
  const call = async (method: string, path: string, body?: unknown): Promise<Response> =>
    f(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const fail = (msg: string): void => {
    out.errors.push(msg);
    log(`ERROR ${msg}`);
  };

  const listRes = await call('GET', '/api/admin/users');
  if (!listRes.ok) {
    fail(`GET /api/admin/users -> ${listRes.status} (check ADMIN_TOKEN and base URL)`);
    out.exitCode = 1;
    return out;
  }
  const dir = (await listRes.json()) as AdminUsers;
  const teams = new Set(dir.studios_catalog.map((s) => s.id));

  for (const t of config.teams ?? []) {
    if (teams.has(t.id)) {
      log(`team ${t.id}: exists`);
      continue;
    }
    if (opts.dryRun) {
      log(`team ${t.id}: would create`);
    } else {
      const r = await call('POST', '/api/admin/studios', { id: t.id, display_name: t.display_name });
      if (!r.ok) {
        fail(`create team ${t.id} -> ${r.status}`);
        continue;
      }
      log(`team ${t.id}: created`);
    }
    teams.add(t.id);
    out.teamsCreated.push(t.id);
  }

  const byEmail = new Map(dir.users.map((u) => [u.email.trim().toLowerCase(), u]));
  for (const m of config.memberships) {
    const label = `${m.email} -> ${m.team}${m.role ? ` (${m.role})` : ''}`;
    const user = byEmail.get(m.email.trim().toLowerCase());
    if (!user) {
      out.pending.push(m.email);
      log(`PENDING ${label}: no such user yet (must sign in with Google once)`);
      continue;
    }
    if (!teams.has(m.team)) {
      fail(`${label}: team not in catalog and not listed under "teams"`);
      continue;
    }
    if (!m.role && user.studios.some((s) => s.id === m.team)) {
      out.unchanged.push(label);
      log(`ok      ${label}: already a member`);
      continue;
    }
    if (opts.dryRun) {
      out.granted.push(label);
      log(`would grant ${label}`);
      continue;
    }
    const r = await call('POST', `/api/admin/users/${encodeURIComponent(user.id)}/memberships`, {
      studio_id: m.team,
      ...(m.role ? { role: m.role } : {}),
    });
    if (!r.ok) {
      fail(`grant ${label} -> ${r.status}`);
      continue;
    }
    out.granted.push(label);
    log(`granted ${label}`);
  }

  out.exitCode = out.errors.length > 0 ? 1 : out.pending.length > 0 ? 3 : 0;
  log(
    `summary: ${out.teamsCreated.length} team(s) created, ${out.granted.length} granted, ` +
      `${out.unchanged.length} unchanged, ${out.pending.length} pending, ${out.errors.length} error(s)` +
      (opts.dryRun ? ' [dry run]' : ''),
  );
  return out;
}

const USAGE =
  'usage: ADMIN_TOKEN=... npx tsx server/scripts/bootstrapMemberships.example.ts <config.json> [--base-url URL] [--dry-run]';

async function main(argv: string[]): Promise<number> {
  const pos: string[] = [];
  let baseUrl = process.env.BASE_URL ?? `http://127.0.0.1:${process.env.ROUTER_PORT ?? '8080'}`;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--base-url') baseUrl = argv[++i] ?? '';
    else if (argv[i].startsWith('--')) {
      console.error(`unknown flag ${argv[i]}\n${USAGE}`);
      return 2;
    } else pos.push(argv[i]);
  }
  const token = process.env.ADMIN_TOKEN;
  if (pos.length !== 1 || !baseUrl || !token) {
    console.error(`${USAGE}\n(ADMIN_TOKEN must be set in the environment)`);
    return 2;
  }
  let config: BootstrapConfig;
  try {
    config = parseConfig(JSON.parse(readFileSync(pos[0], 'utf8')));
  } catch (e) {
    console.error(`bad config ${pos[0]}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  return (await bootstrapMemberships(config, { baseUrl, token, dryRun })).exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
