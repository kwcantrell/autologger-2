// containerHarness.ts (containerize-split-images, task 5.4) -- helpers for the `container`
// Playwright project. It targets a RUNNING compose stack (router + web + api) through the
// router's URL and needs no webServer; see e2e/container/run.sh for the wrapper that brings the
// stack and the single-process reference server up and down.
//
// Environment contract (all set by run.sh):
//   ROUTER_URL           the router's loopback URL, e.g. http://127.0.0.1:18080
//   SINGLE_PROCESS_URL   a `npm run build && npm run start` server built from the SAME commit;
//                        the differential's reference (the EXTERNAL consumer of the seam)
//   COMPOSE_FILE / COMPOSE_PROJECT_NAME / COMPOSE_ENV_FILES / E2E_ENV_FILE
//                        so a bare `docker compose ...` addresses the e2e stack
//   E2E_API_TOKEN        the API_TOKEN written into the throwaway env file
//
// Why real docker commands from the spec: state survival, --scale refusal, web-cannot-reach-api,
// the published-port map and the gzip parity through a throwaway container on `back` are
// properties of the compose topology, not of HTTP. There is no HTTP-only way to assert them.

import { execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. The container project needs a running stack and a single-process ` +
        'reference server; run it through `npm run e2e:container` (e2e/container/run.sh).',
    );
  }
  return v;
}

export const routerUrl = (): string => requireEnv('ROUTER_URL').replace(/\/$/, '');
export const singleProcessUrl = (): string => requireEnv('SINGLE_PROCESS_URL').replace(/\/$/, '');

// ---------------------------------------------------------------------------------------------
// Raw HTTP: the request-target is sent EXACTLY as written (no WHATWG URL normalization, which
// would collapse dot-segments and rewrite %-escapes before the wire).
// ---------------------------------------------------------------------------------------------

export interface RawResponse {
  status: number;
  /** lower-cased header name -> value(s); repeated headers are joined with ", " except set-cookie */
  headers: Record<string, string>;
  setCookie: string[];
  body: Buffer;
}

export function rawHttp(
  base: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<RawResponse> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: u.hostname,
        port: Number(u.port || 80),
        method,
        path, // verbatim
        headers: {
          ...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
          ...headers,
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const h: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (k === 'set-cookie') continue;
            h[k] = Array.isArray(v) ? v.join(', ') : String(v);
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: h,
            setCookie: res.headers['set-cookie'] ?? [],
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error(`timeout: ${method} ${path}`)));
    if (body) req.write(body);
    req.end();
  });
}

/** Write raw bytes to a TCP socket; resolve with everything received until the peer closes. */
export function rawSocket(
  base: string,
  payload: string,
  idleMs = 3000,
): Promise<{ received: Buffer; closedByPeer: boolean }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const s = net.connect({ host: u.hostname, port: Number(u.port || 80) });
    let settled = false;
    const done = (closedByPeer: boolean) => {
      if (settled) return;
      settled = true;
      s.destroy();
      resolve({ received: Buffer.concat(chunks), closedByPeer });
    };
    s.on('connect', () => s.write(payload));
    s.on('data', (c: Buffer) => chunks.push(c));
    s.on('close', () => done(true));
    s.on('error', (e) => {
      // A reset after the peer aborts is still "closed with nothing received".
      if ((e as NodeJS.ErrnoException).code === 'ECONNRESET') done(true);
      else if (!settled) {
        settled = true;
        reject(e);
      }
    });
    s.setTimeout(idleMs, () => done(false));
  });
}

export function upgradeRequest(
  path: string,
  extraHeaders: Record<string, string> = {},
  upgrade = 'websocket',
): string {
  const lines = [
    `GET ${path} HTTP/1.1`,
    'Host: container-e2e.invalid',
    'Connection: Upgrade',
    `Upgrade: ${upgrade}`,
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
    '',
    '',
  ];
  return lines.join('\r\n');
}

// ---------------------------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------------------------

export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a docker command (compose scoping comes from the COMPOSE_* env). Never throws on a
 * non-zero exit; callers assert on the result. */
export function docker(
  args: string[],
  opts: { input?: string; env?: Record<string, string> } = {},
): DockerResult {
  try {
    const stdout = execFileSync('docker', args, {
      encoding: 'utf8',
      input: opts.input,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 240_000,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

export function dockerOk(
  args: string[],
  opts: { input?: string; env?: Record<string, string> } = {},
): string {
  const r = docker(args, opts);
  if (r.code !== 0) {
    throw new Error(`docker ${args.join(' ')} failed (${r.code}): ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

export const composeProject = (): string => requireEnv('COMPOSE_PROJECT_NAME');

/** Name of the compose `back` network (project-prefixed). */
export const backNetwork = (): string => `${composeProject()}_back`;

// ---------------------------------------------------------------------------------------------
// Authenticated session seeding INSIDE the api container.
//
// Real Google sign-in is impossible in an automated run, and production compose must not grow
// a login backdoor. So (mirroring e2e/seededSession.ts, which does the same against the
// single-process hermetic server's DB file) this writes a user row + a hashed login-session KV
// row straight into the catalog inside the api container's own volume, via `docker compose
// exec`. The row shapes are copied from seededSession.ts (authCreateUserGoogle /
// authSeedPrefsFromGlobals / authAddMembershipWithRole / createLoginSession). The production
// compose file is untouched.
// ---------------------------------------------------------------------------------------------

const SEED_SCRIPT = `
const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const args = JSON.parse(process.env.SEED_ARGS);
const db = new Database(process.env.DATA_DIR + '/catalog.db');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
const userId = crypto.randomUUID();
const email = 'e2e-' + args.label + '-' + userId + '@example.invalid';
const nowIso = new Date().toISOString();
db.transaction(() => {
  db.prepare('INSERT INTO users (id, google_sub, email, given_name, family_name, picture_url, created_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, 'e2e-' + args.label + '-' + userId, email, 'E2E', 'User', '', nowIso);
  for (const m of args.memberships) {
    db.prepare('INSERT OR IGNORE INTO user_studio_memberships (user_id, studio_id, role) VALUES (?, ?, ?)')
      .run(userId, m.studioId, m.role || 'member');
  }
  db.prepare('INSERT INTO user_prefs (user_id, active_studio_id, active_show_id) VALUES (?, ?, ?)')
    .run(userId, (args.memberships[0] && args.memberships[0].studioId) || '', '');
})();
const token = crypto.randomBytes(48).toString('base64url');
const hash = crypto.createHash('sha256').update(token).digest('hex');
db.prepare('INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at')
  .run('session:' + hash, userId, Date.now() + 14 * 86400 * 1000);
db.close();
process.stdout.write(JSON.stringify({ token, userId, email }));
`;

export interface ContainerSeed {
  token: string;
  userId: string;
  email: string;
  cookie: string;
}

export function seedContainerSession(
  label: string,
  memberships: { studioId: string; role?: 'admin' | 'member' }[],
): ContainerSeed {
  const out = dockerOk(
    [
      'compose',
      'exec',
      '-T',
      '-e',
      `SEED_ARGS=${JSON.stringify({ label, memberships })}`,
      'api',
      'node',
      '-',
    ],
    { input: SEED_SCRIPT },
  );
  const seeded = JSON.parse(out) as { token: string; userId: string; email: string };
  return { ...seeded, cookie: `autologger_sid=${seeded.token}` };
}

// ---------------------------------------------------------------------------------------------
// Comparison helpers for the differential
// ---------------------------------------------------------------------------------------------

/** The response properties the spec's differential scenario compares. */
export const COMPARED_HEADERS = [
  'x-powered-by',
  'location',
  'content-type',
  'content-encoding',
  'vary',
  'cache-control',
] as const;

export function summarize(r: RawResponse): Record<string, string | number> {
  const out: Record<string, string | number> = {
    status: r.status,
    'set-cookie': r.setCookie.length ? r.setCookie.join(' | ') : '<absent>',
  };
  for (const h of COMPARED_HEADERS) out[h] = r.headers[h] ?? '<absent>';
  return out;
}
