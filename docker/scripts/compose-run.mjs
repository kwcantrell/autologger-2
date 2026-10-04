#!/usr/bin/env node
// docker/scripts/compose-run.mjs -- run guard and compose steps for one stack with its secrets
// from OpenBao (openbao-secrets design D1; hardening rules H1-H12 of infisical-secrets, kept).
// Node built-ins only.
//
//   node docker/scripts/compose-run.mjs dev|stage|prod STEP...
//     STEP: resolved | prod-tags | urls | reset | 'compose ARGS...'
//     e.g.  compose-run.mjs dev resolved 'compose up -d --build' urls
//
// The Makefile starts this under `env -i` (H1). One process: read the per-host credentials file
// (.env.openbao.<env>), log in to OpenBao with AppRole, read the stack's KV v2 secret, revoke the
// token, validate every secret, then run each step with a child environment built from scratch
// (only the validated allowlist keys). No secret is ever parsed by a shell, put on argv, written
// to disk, or printed.

import { spawn, spawnSync } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXED_PATH = '/usr/local/bin:/usr/bin:/bin';
const ALLOWLIST = 'docker/secrets-env.yaml';
const TEMPLATE = 'docker/openbao-credentials.example';
const ENVS = ['dev', 'stage', 'prod'];
// Compose-interpolation keys an environment may hold besides the allowlist (design D3).
// The Supabase keys reach only the services SECRET_SCOPE allows (supabase-db D4, supabase-services D4).
const SUPABASE_KEYS = ['POSTGRES_PASSWORD', 'SUPABASE_ROLES_PASSWORD', 'APP_DB_PASSWORD', 'JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY', 'SECRET_KEY_BASE', 'REALTIME_DB_ENC_KEY', 'SUPABASE_PORT'];
const COMPOSE_KEYS = {
  dev: ['DEV_PORT', 'DEV_COMPANION_PORT', ...SUPABASE_KEYS],
  stage: ['STAGE_PORT', ...SUPABASE_KEYS],
  prod: ['ROUTER_PORT', 'WEB_TAG', 'API_TAG', 'PUBLIC_BASE_URL', ...SUPABASE_KEYS],
};
// Per-key value formats: strong, URL-safe, and safe for busybox echo and psql backticks.
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const KEY_FORMAT = {
  POSTGRES_PASSWORD: /^[0-9a-f]{32,}$/,
  SUPABASE_ROLES_PASSWORD: /^[0-9a-f]{32,}$/,
  APP_DB_PASSWORD: /^[0-9a-f]{32,}$/,
  JWT_SECRET: /^[A-Za-z0-9_-]{40,}$/,
  SECRET_KEY_BASE: /^[A-Za-z0-9_-]{64,}$/,
  REALTIME_DB_ENC_KEY: /^[A-Za-z0-9_-]{16}$/,
  ANON_KEY: JWT_RE,
  SERVICE_ROLE_KEY: JWT_RE,
  SUPABASE_PORT: { test: (v) => /^[1-9][0-9]{3,4}$/.test(v) && Number(v) >= 1024 && Number(v) <= 65535 },
};
// The services each secret value may appear in (spec invariant 16); per stack where it differs.
const SECRET_SCOPE = {
  POSTGRES_PASSWORD: ['db', 'migrate', 'realtime'],
  // The catalog's app role (catalog-pg-schema D4): the stack's app service and the runner.
  APP_DB_PASSWORD: { dev: ['app', 'migrate'], stage: ['api', 'migrate'], prod: ['api', 'migrate'] },
  SUPABASE_ROLES_PASSWORD: ['db', 'auth', 'rest', 'storage'],
  JWT_SECRET: ['auth', 'rest', 'realtime', 'storage'],
  ANON_KEY: ['supabase-gw', 'realtime', 'storage'],
  SERVICE_ROLE_KEY: ['supabase-gw', 'storage'],
  SECRET_KEY_BASE: ['realtime'],
  REALTIME_DB_ENC_KEY: ['realtime'],
};
const PROJECT = { dev: 'autologger-dev', stage: 'autologger-stage', prod: 'autologger' };
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/; // no `m` flag: `$` is end of input only
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const WORD_RE = /^[A-Za-z0-9@%+=:,./_-]+$/;
const MAX_BODY = 1024 * 1024;
const MAX_CA = 64 * 1024;

/** A refusal whose message is safe to print (never holds a secret value). */
export class Refusal extends Error {}
const refuse = (msg) => {
  throw new Refusal(msg);
};

// ------------------------------------------------------------------------ pure checks -----

export function checkNodeVersion(version) {
  const [maj, min] = version.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 12)) {
    refuse(`Node ${version} is too old; the stack tooling needs Node 22.12 or newer on PATH`);
  }
}

/** H1: variables that would change this process's own TLS, logging or module loading. */
export function checkOwnEnv(env) {
  const bad = Object.keys(env).filter((k) => /^NODE_/.test(k) || /^(https?|all)_proxy$/i.test(k));
  if (bad.length) {
    refuse(`refusing to run with ${bad.sort().join(', ')} set (run through make, which clears the environment)`);
  }
}

/** H2: a bare https origin. */
export function parseAddr(s) {
  let u;
  try {
    u = new URL(s);
  } catch {
    refuse('BAO_ADDR is not a URL');
  }
  if (u.protocol !== 'https:') refuse('BAO_ADDR must start with https://');
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') {
    refuse('BAO_ADDR must be a bare https://host[:port] with no path, query, fragment or user');
  }
  return u;
}

/** D1: BAO_KV_PATH is MOUNT/PATH...; plain segments only, and the last one names the stack. */
export function parseKvPath(s, env) {
  const parts = String(s).split('/');
  if (parts.length < 2 || !parts.every((p) => SEGMENT_RE.test(p))) {
    refuse('BAO_KV_PATH must be MOUNT/PATH (for example kv/autologger/dev): segments of A-Z a-z 0-9 _ - only');
  }
  if (parts.at(-1) !== env) refuse(`BAO_KV_PATH must end in /${env} (the credentials of one stack read only that stack's secrets)`);
  return { mount: parts[0], path: parts.slice(1).join('/') };
}

/** H11: a compose step is split on spaces; every word must be plain. */
export function splitStep(step) {
  const words = step.split(' ').slice(1).filter((w) => w !== '');
  if (!words.length || !words.every((w) => WORD_RE.test(w))) {
    refuse(`invalid step "${step.replace(/[^\x20-\x7e]/g, '?').slice(0, 80)}": words may use only A-Z a-z 0-9 @ % + = : , . / _ -`);
  }
  return words;
}

/** H4: an OpenBao `errors` array (strings), made safe to print. */
export function sanitizeMessage(m) {
  const clean = (x) => x.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 200);
  if (typeof m === 'string') return clean(m);
  if (Array.isArray(m)) return clean(m.filter((x) => typeof x === 'string').join('; '));
  return '';
}

/** Whether a KV v2 read's current version is gone: 'destroyed', 'deleted', or null (live).
 * - `destroyed: true` is destroyed;
 * - a `404` that still carries metadata is a deleted version of an existing path;
 * - `deletion_time` counts only once it has passed: with `delete_version_after` set, a LIVE
 *   version carries a future `deletion_time`. A non-empty value that does not parse fails closed. */
export function deletedState(md, status = 200, now = Date.now()) {
  if (!md || typeof md !== 'object') return null;
  if (md.destroyed === true) return 'destroyed';
  const dt = md.deletion_time;
  if (dt !== undefined && dt !== null && dt !== '') {
    const t = typeof dt === 'string' ? Date.parse(dt) : Number.NaN;
    if (Number.isNaN(t) || t <= now) return 'deleted';
  }
  return status === 404 ? 'deleted' : null;
}
/** The refusal text for a gone version: undelete cannot restore a destroyed one. */
export function deletedMessage(state, where = 'the OpenBao secret') {
  return state === 'destroyed'
    ? `the current version of ${where} is destroyed; restore an older version with \`bao kv rollback\``
    : `the current version of ${where} is deleted; restore it with \`bao kv undelete\` or \`bao kv rollback\``;
}

/** Design D1 step 4, H5, H6: all-or-nothing validation of a KV v2 read
 * (`{ data: { data: {KEY: value}, metadata } }`). Returns Map<key, value>. */
export function validateSecrets(json, allowed) {
  const kv = json?.data?.data;
  if (!json || typeof json !== 'object' || !json.data || typeof json.data !== 'object') {
    refuse('OpenBao returned an unexpected response shape (no data object)');
  }
  const gone = deletedState(json.data.metadata);
  if (gone) refuse(deletedMessage(gone));
  if (!kv || typeof kv !== 'object' || Array.isArray(kv)) refuse('OpenBao returned an unexpected response shape (no data.data object)');
  const entries = Object.entries(kv);
  if (entries.length === 0) refuse('OpenBao returned no secrets for this stack');
  const out = new Map();
  const names = new Set();
  const reasons = new Set();
  let others = 0;
  const bad = (k, why) => {
    reasons.add(why);
    if (KEY_RE.test(k)) names.add(k);
    else others += 1;
  };
  for (const [k, v] of entries) {
    if (!KEY_RE.test(k)) bad(k, 'invalid-name');
    else if (!allowed.has(k)) bad(k, 'not-allowed');
    else if (typeof v !== 'string') bad(k, 'not-a-string');
    else if (v.includes('\u0000')) bad(k, 'NUL');
    else if (Object.hasOwn(KEY_FORMAT, k) && !KEY_FORMAT[k].test(v)) bad(k, 'bad-format');
    else out.set(k, v);
  }
  if (names.size || others) {
    const list = [...names].sort().join(' ');
    refuse(
      `refusing the OpenBao secret: ${list}${others ? `${list ? ' ' : ''}(and ${others} more that are not valid names)` : ''}` +
        ` [${[...reasons].sort().join(', ')}]. Allowed: the keys in ${ALLOWLIST} plus this environment's compose keys.`,
    );
  }
  return out;
}

/** supabase-services D4: the anon and service-role keys are unexpired HS256 JWTs signed with
 * JWT_SECRET, with their own roles. Returns warnings (names only); refuses on any mismatch. */
export function checkSupabaseKeys(secrets, nowSec = Math.floor(Date.now() / 1000)) {
  const trio = ['JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY'];
  const have = trio.filter((k) => secrets.get(k));
  if (have.length === 0) return [];
  if (have.length !== 3) refuse(`${trio.filter((k) => !secrets.get(k)).join(', ')} missing: JWT_SECRET, ANON_KEY and SERVICE_ROLE_KEY are set together (docker/scripts/supabase-keys.mjs)`);
  if (secrets.get('ANON_KEY') === secrets.get('SERVICE_ROLE_KEY')) refuse('ANON_KEY and SERVICE_ROLE_KEY are the same value');
  const warnings = [];
  for (const [k, role] of [['ANON_KEY', 'anon'], ['SERVICE_ROLE_KEY', 'service_role']]) {
    const [h, p, sig] = secrets.get(k).split('.');
    const want = createHmac('sha256', secrets.get('JWT_SECRET')).update(`${h}.${p}`).digest();
    const got = Buffer.from(sig, 'base64url');
    let header;
    let payload;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    } catch {
      refuse(`${k} is not a readable JWT`);
    }
    if (header?.alg !== 'HS256' || got.length !== want.length || !timingSafeEqual(got, want)) refuse(`${k} is not an HS256 JWT signed with this environment's JWT_SECRET`);
    if (payload?.role !== role) refuse(`${k} does not carry role ${role}`);
    if (typeof payload.exp !== 'number' || payload.exp <= nowSec) refuse(`${k} has expired; create new keys (see docs/supabase.md)`);
    if (payload.exp - nowSec < 90 * 86400) warnings.push(`${k} expires in under 90 days; rotate it (see docs/supabase.md)`);
  }
  return warnings;
}

// gotrue-sign-in D3, require-login D1: every stack signs in through Google (GoTrue accepts only
// tokens for this client id) and login is always required, so a stack without the client would
// boot to a server no one can use. owner-bootstrap D8: the server also refuses to boot without
// BOOTSTRAP_OWNER_EMAIL. Refuse before compose starts instead. Values are trimmed.
export function checkSignInClient(env, secrets) {
  for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'BOOTSTRAP_OWNER_EMAIL']) {
    if (!(secrets.get(k) ?? '').trim()) refuse(`${k} is unset or blank in the OpenBao ${env} secret (login is always required and the bootstrap owner must be named; see docs/openbao-secrets.md)`);
  }
}

export function checkProdTags(secrets) {
  for (const k of ['WEB_TAG', 'API_TAG']) {
    const v = secrets.get(k);
    if (!v) refuse(`${k} is unset or empty in the OpenBao prod secret (a git-SHA tag is required)`);
    if (v === 'latest') refuse(`${k}=latest is refused; pin a git-SHA tag`);
  }
}

// ------------------------------------------------------------------------ files (H7) -----

export function checkCredFile(f, uid = process.getuid()) {
  const st = lstatSync(f);
  if (st.isSymbolicLink() || !st.isFile()) refuse(`${f} must be a regular file, not a symlink`);
  if (st.uid !== uid) refuse(`${f} must be owned by you`);
  if ((st.mode & 0o077) !== 0) refuse(`${f} is accessible by group or others (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 ${f}`);
}

export function checkCaFile(f) {
  const st = lstatSync(f);
  if (st.isSymbolicLink() || !st.isFile()) refuse('BAO_CACERT must name a regular file, not a symlink');
  if ((st.mode & 0o022) !== 0) refuse('BAO_CACERT is writable by group or others');
  if (st.size > MAX_CA) refuse('BAO_CACERT is larger than 64 KiB');
}

/** Read .env.openbao.<env>; with auth=false the AppRole role id and secret id are not required. */
export function readCreds(env, dir, { auth = true } = {}) {
  const name = `.env.openbao.${env}`;
  const f = join(dir, name);
  try {
    lstatSync(f);
  } catch {
    refuse(`${name} is missing. Create it from ${TEMPLATE} (chmod 600); see docs/openbao-secrets.md`);
  }
  checkCredFile(f);
  const kv = new Map();
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trimEnd());
    if (m) kv.set(m[1], m[2]);
  }
  const need = [...(auth ? ['BAO_ROLE_ID', 'BAO_SECRET_ID'] : []), 'BAO_ADDR', 'BAO_CACERT', 'BAO_KV_PATH'];
  for (const k of need) if (!kv.get(k)) refuse(`${k} is missing or empty in ${name} (see ${TEMPLATE})`);
  const url = parseAddr(kv.get('BAO_ADDR'));
  const kvPath = parseKvPath(kv.get('BAO_KV_PATH'), env);
  const caPath = kv.get('BAO_CACERT');
  if (!isAbsolute(caPath)) refuse(`BAO_CACERT in ${name} must be an absolute path`);
  try {
    lstatSync(caPath);
  } catch {
    refuse(`BAO_CACERT in ${name} names a file that does not exist`);
  }
  checkCaFile(caPath);
  return {
    roleId: kv.get('BAO_ROLE_ID'),
    secretId: kv.get('BAO_SECRET_ID'),
    url,
    kv: kvPath,
    ca: readFileSync(caPath),
  };
}

/** The KV v2 data endpoint of a parsed BAO_KV_PATH. */
export const kvDataPath = ({ mount, path }) => `/v1/${mount}/data/${path}`;

// ------------------------------------------------------------------------ HTTPS (H2-H4) ----

const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ERR_TLS|HOSTNAME|ALTNAME/;

/** One JSON request. Resolves `{ status, json }` for any complete response (json is undefined
 * when the body is empty or not JSON); rejects with a printable Refusal on transport errors. */
export function httpsRequest({ url, ca, method, path, headers = {}, body, connectMs = 15000, totalMs = 30000 }) {
  return new Promise((ok, fail) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const req = https.request({
      host,
      port: url.port || 443,
      method,
      path,
      ca,
      rejectUnauthorized: true, // explicit: defeats NODE_TLS_REJECT_UNAUTHORIZED=0 (H2)
      agent: false,
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
        ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
      },
    });
    const done = (err, val) => {
      clearTimeout(total);
      clearTimeout(connect);
      if (err) {
        req.destroy();
        fail(err);
      } else ok(val);
    };
    const total = setTimeout(() => done(new Refusal(`OpenBao request timed out after ${totalMs / 1000}s`)), totalMs);
    const connect = setTimeout(() => done(new Refusal(`could not connect to OpenBao within ${connectMs / 1000}s`)), connectMs);
    req.on('socket', (s) => s.once('secureConnect', () => clearTimeout(connect)));
    req.on('error', (e) => {
      if (e instanceof Refusal) return done(e);
      const code = String(e?.code ?? '');
      if (TLS_CODES.test(code)) return done(new Refusal(`TLS check failed (${code}); trust the OpenBao CA (BAO_CACERT)`));
      return done(new Refusal(`could not reach OpenBao (${code || 'network error'})`));
    });
    req.on('response', (res) => {
      if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
        res.resume();
        return done(new Refusal('OpenBao sent a content-encoding this tool does not accept'));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) done(new Refusal('OpenBao response too large (over 1 MiB)'));
        else chunks.push(c);
      });
      res.on('end', () => {
        if (size > MAX_BODY) return;
        let json;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          json = undefined;
        }
        return done(null, { status: res.statusCode, json });
      });
      res.on('error', () => done(new Refusal('OpenBao response was interrupted')));
    });
    if (body) req.end(body);
    else req.end();
  });
}

/** A refusal for a non-success status: the status and OpenBao's sanitized `errors` only. */
export function statusRefusal({ status, json }) {
  const m = sanitizeMessage(json?.errors);
  return new Refusal(`OpenBao answered HTTP ${status}${m ? `: ${m}` : ''}`);
}

/** One JSON request that must answer 200 with a JSON body (or 204, when allowEmpty). */
export async function httpsJson({ allowEmpty = false, ...opts }) {
  const r = await httpsRequest(opts);
  if (allowEmpty && r.status === 204) return null;
  if (r.status !== 200) throw statusRefusal(r);
  if (r.json === undefined) throw new Refusal('OpenBao response is not valid JSON');
  return r.json;
}

/** D1 step 2: AppRole login. Returns the client token (never printed). */
export async function approleLogin(creds) {
  const login = await httpsJson({
    url: creds.url,
    ca: creds.ca,
    method: 'POST',
    path: '/v1/auth/approle/login',
    body: JSON.stringify({ role_id: creds.roleId, secret_id: creds.secretId }),
  });
  const token = login?.auth?.client_token;
  if (typeof token !== 'string' || token === '') refuse('OpenBao login returned no client token');
  return token;
}

/** D1 step 3: read the stack's KV v2 secret, then revoke the token whatever the outcome. */
export async function fetchSecrets(creds, warn = () => {}) {
  const token = await approleLogin(creds);
  try {
    const r = await httpsRequest({ url: creds.url, ca: creds.ca, method: 'GET', path: kvDataPath(creds.kv), headers: { 'x-vault-token': token } });
    // KV v2 answers a soft-deleted or destroyed current version with 404 plus its metadata.
    const gone = r.status === 404 ? deletedState(r.json?.data?.metadata, 404) : null;
    if (gone) refuse(deletedMessage(gone));
    if (r.status !== 200) throw statusRefusal(r);
    if (r.json === undefined) refuse('OpenBao response is not valid JSON');
    return r.json;
  } finally {
    try {
      await httpsJson({ url: creds.url, ca: creds.ca, method: 'POST', path: '/v1/auth/token/revoke-self', headers: { 'x-vault-token': token }, allowEmpty: true });
    } catch (e) {
      warn(`could not revoke the OpenBao token (${e instanceof Refusal ? e.message : 'request error'}); it expires with its TTL`);
    }
  }
}

// ------------------------------------------------------------------------ children --------

export function allowedNames(env) {
  const keys = readFileSync(join(ROOT, ALLOWLIST), 'utf8')
    .split('\n')
    .map((l) => /^ {6}([A-Z][A-Z0-9_]*):\s*$/.exec(l)?.[1])
    .filter(Boolean);
  return new Set([...keys, ...COMPOSE_KEYS[env]]);
}

// AL_EXEC=1 is a plain shell variable (not exported): compose-env.sh then execs docker (H9).
const composeArgv = (env, args, exec = false) => [
  '-c',
  `${exec ? 'AL_EXEC=1; ' : ''}. docker/scripts/compose-env.sh && "$@"`,
  'sh',
  `compose_${env}`,
  '/dev/null',
  ...args,
];

/** H9: run a child with inherited stdio; forward SIGTERM/SIGHUP, ignore SIGINT; resolve its status. */
function runChild(argv, childEnv) {
  return new Promise((ok) => {
    const child = spawn('sh', argv, { cwd: ROOT, env: childEnv, stdio: 'inherit' });
    const fwd = (sig) => () => child.kill(sig);
    const onTerm = fwd('SIGTERM');
    const onHup = fwd('SIGHUP');
    const onInt = () => {};
    process.on('SIGTERM', onTerm);
    process.on('SIGHUP', onHup);
    process.on('SIGINT', onInt);
    const finish = (code) => {
      process.off('SIGTERM', onTerm);
      process.off('SIGHUP', onHup);
      process.off('SIGINT', onInt);
      ok(code);
    };
    child.on('error', () => finish(127));
    child.on('exit', (code, signal) => {
      const n = signal ? 128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 }[signal] ?? 0) : code;
      finish(n);
    });
  });
}

/** Resolve the compose config as JSON, in memory (it inlines passthrough values: never print). */
function resolveConfig(env, childEnv) {
  const r = spawnSync('sh', composeArgv(env, ['--profile', '*', 'config', '--no-env-resolution', '--format', 'json']), {
    cwd: ROOT,
    env: childEnv,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.status !== 0) refuse(`compose could not resolve the ${env} config (bad port value?); check the OpenBao ${env} secret`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    return refuse(`compose config for ${env} was not JSON`);
  }
}

/** Every string anywhere inside a value (keys and values of objects, array items). */
function strings(v) {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => [k, ...strings(x)]);
  return [];
}

/** The checks make-guards.sh `envfile` did, on the resolved config (never printed). */
export function checkResolved(env, cfg, secrets = new Map()) {
  if (cfg?.name !== PROJECT[env]) refuse(`refusing: compose resolves the ${env} project to a name other than '${PROJECT[env]}'`);
  for (const [k, scoped] of Object.entries(SECRET_SCOPE)) {
    const scope = Array.isArray(scoped) ? scoped : scoped[env];
    const v = secrets.get(k);
    if (!v) continue;
    const leaks = Object.entries(cfg.services ?? {}).filter(([n, s]) => !scope.includes(n) && strings(s).some((x) => x.includes(v)));
    if (leaks.length) refuse(`refusing: the ${k} value appears in ${leaks.map(([n]) => n).sort().join(', ')} (only ${scope.join(', ')} may hold it)`);
  }
  const ports = Object.values(cfg.services ?? {}).flatMap((s) => s.ports ?? []);
  if (ports.some((p) => p.host_ip !== '127.0.0.1')) refuse(`refusing: a published ${env} port is not bound to 127.0.0.1`);
  const pub = ports.map((p) => String(p.published));
  if (!pub.every((p) => /^[1-9][0-9]{0,4}$/.test(p) && Number(p) <= 65535)) refuse(`refusing: a published ${env} port is not a plain number 1-65535`);
  if (env !== 'prod' && pub.includes('8080')) refuse(`refusing: a published ${env} port is 8080 (production's router port); pick another in the OpenBao ${env} secret`);
  if (env === 'dev' && pub.some((p) => p === '80' || p === '443')) {
    refuse('refusing: a published dev port is 80 or 443; browsers omit the default port from Host/Origin so the dev gate would reject every request');
  }
  const want = env === 'dev' ? ['app', 'companion', 'supabase-gw'] : ['router', 'supabase-gw'];
  const owners = Object.entries(cfg.services ?? {}).filter(([, s]) => (s.ports ?? []).length).map(([n]) => n).sort();
  if (ports.length !== want.length || owners.join() !== want.join() || new Set(pub).size !== pub.length) {
    refuse(`refusing: the resolved ${env} ports are not the expected set (${want.join(', ')}, one each, on distinct ports)`);
  }
}

function urls(env, cfg) {
  const sb = cfg.services['supabase-gw']?.ports?.[0]?.published;
  if (env === 'dev') {
    process.stdout.write(`dev app:        http://127.0.0.1:${cfg.services.app.ports[0].published}\n`);
    process.stdout.write(`dev Companion:  http://127.0.0.1:${cfg.services.companion.ports[0].published}\n`);
    process.stdout.write('In Companion, set the AutoLogger connection base URL to:  http://app:8787\n');
  } else if (env === 'stage') {
    process.stdout.write(`stage:          http://localhost:${cfg.services.router.ports[0].published}   (use localhost, not 127.0.0.1)\n`);
  } else {
    process.stdout.write(`prod router:    http://127.0.0.1:${cfg.services.router.ports[0].published}\n`);
  }
  if (sb) process.stdout.write(`Supabase:       http://localhost:${sb}   (API gateway: /auth/v1, /rest/v1, /realtime/v1, /storage/v1)\n`);
}

// ------------------------------------------------------------------------ main ------------

async function main(argv, ownEnv) {
  checkNodeVersion(process.versions.node);
  checkOwnEnv(ownEnv);
  const [env, ...steps] = argv;
  if (!ENVS.includes(env) || steps.length === 0) refuse('usage: compose-run.mjs dev|stage|prod STEP...');

  // Validate every step before any request (H8, H11).
  const plan = steps.map((s) => {
    if (['resolved', 'prod-tags', 'urls', 'reset'].includes(s)) return { kind: s };
    if (s.startsWith('compose ')) return { kind: 'compose', args: splitStep(s) };
    return refuse(`unknown step "${s.replace(/[^\x20-\x7e]/g, '?').slice(0, 80)}"`);
  });
  // supabase-db D6: nothing may migrate prod or open a shell in it.
  if (env === 'prod' && plan.some((p) => p.kind === 'compose' && p.args.some((w) => w === 'run' || w === 'exec'))) {
    refuse('compose run and exec are refused for prod (no migration or shell against the prod database)');
  }
  if (plan.some((p) => p.kind === 'reset')) {
    if (env === 'prod') refuse('reset is refused for prod (it would delete production volumes)');
    if (ownEnv.CONFIRM !== 'yes') refuse(`refusing: 'make ${env}-reset' deletes the ${PROJECT[env]} volumes. Re-run with CONFIRM=yes.`);
  }

  // Test hooks (H10): only with AUTOLOGGER_TEST=1, absolute paths, never for prod.
  let credDir = ROOT;
  let path = FIXED_PATH;
  if (ownEnv.AUTOLOGGER_TEST === '1' && (ownEnv.AUTOLOGGER_TEST_PATH || ownEnv.AUTOLOGGER_TEST_CRED_DIR)) {
    if (env === 'prod') refuse('test hooks (AUTOLOGGER_TEST_*) are refused for prod');
    for (const k of ['AUTOLOGGER_TEST_PATH', 'AUTOLOGGER_TEST_CRED_DIR']) {
      if (ownEnv[k] && !isAbsolute(ownEnv[k])) refuse(`${k} must be an absolute path`);
    }
    if (ownEnv.AUTOLOGGER_TEST_PATH) path = `${ownEnv.AUTOLOGGER_TEST_PATH}:${FIXED_PATH}`;
    if (ownEnv.AUTOLOGGER_TEST_CRED_DIR) credDir = ownEnv.AUTOLOGGER_TEST_CRED_DIR;
    process.stderr.write('compose-run: TEST HOOKS ACTIVE (AUTOLOGGER_TEST=1)\n');
  }

  const creds = readCreds(env, credDir);
  const fetched = await fetchSecrets(creds, (w) => process.stderr.write(`compose-run: warning: ${w}\n`));
  const secrets = validateSecrets(fetched, allowedNames(env));
  for (const w of checkSupabaseKeys(secrets)) process.stderr.write(`compose-run: warning: ${w}\n`);
  checkSignInClient(env, secrets);

  // H6, H12: the child environment, built from nothing.
  const childEnv = Object.create(null);
  childEnv.PATH = path;
  if (ownEnv.HOME) childEnv.HOME = ownEnv.HOME;
  if (ownEnv.TERM) childEnv.TERM = ownEnv.TERM;
  for (const [k, v] of secrets) childEnv[k] = v;
  childEnv.AUTOLOGGER_STACK = env;

  let cfg;
  const config = () => {
    cfg ??= resolveConfig(env, childEnv);
    return cfg;
  };
  for (const step of plan) {
    if (step.kind === 'resolved') checkResolved(env, config(), secrets);
    else if (step.kind === 'urls') urls(env, config());
    else if (step.kind === 'prod-tags') checkProdTags(secrets);
    else if (step.kind === 'reset') {
      if (config().name !== PROJECT[env]) refuse(`refusing: compose resolved project name is not '${PROJECT[env]}'`);
    } else {
      const code = await runChild(composeArgv(env, step.args, true), childEnv);
      if (code !== 0) return code; // H8: stop at the first failure
    }
  }
  return 0;
}

const FIXED = 'compose-run: internal error (details suppressed so that no secret can be printed)\n';
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.on('uncaughtException', () => {
    process.stderr.write(FIXED);
    process.exit(1);
  });
  process.on('unhandledRejection', () => {
    process.stderr.write(FIXED);
    process.exit(1);
  });
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(e instanceof Refusal ? `compose-run: ${e.message}\n` : FIXED);
      process.exit(1);
    },
  );
}
