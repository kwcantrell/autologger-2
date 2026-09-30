#!/usr/bin/env node
// docker/scripts/compose-run.mjs -- run guard and compose steps for one stack with its secrets
// from Infisical (infisical-secrets design D1, hardening rules H1-H12). Node built-ins only.
//
//   node docker/scripts/compose-run.mjs dev|stage|prod STEP...
//     STEP: resolved | prod-tags | urls | reset | 'compose ARGS...'
//     e.g.  compose-run.mjs dev resolved 'compose up -d --build' urls
//
// The Makefile starts this under `env -i` (H1). One process: read the per-host credentials file
// (.env.infisical.<env>), log in to Infisical's HTTP API, fetch the environment, validate every
// secret, then run each step with a child environment built from scratch (only the validated
// allowlist keys). No secret is ever parsed by a shell, put on argv, written to disk, or printed.

import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXED_PATH = '/usr/local/bin:/usr/bin:/bin';
const ALLOWLIST = 'docker/secrets-env.yaml';
const TEMPLATE = 'docker/infisical-credentials.example';
const ENVS = ['dev', 'stage', 'prod'];
// Compose-interpolation keys an environment may hold besides the allowlist (design D3).
const COMPOSE_KEYS = {
  dev: ['DEV_PORT', 'DEV_COMPANION_PORT'],
  stage: ['STAGE_PORT'],
  prod: ['ROUTER_PORT', 'WEB_TAG', 'API_TAG', 'PUBLIC_BASE_URL'],
};
const PROJECT = { dev: 'autologger-dev', stage: 'autologger-stage', prod: 'autologger' };
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/; // no `m` flag: `$` is end of input only
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
export function parseDomain(s) {
  let u;
  try {
    u = new URL(s);
  } catch {
    refuse('INFISICAL_DOMAIN is not a URL');
  }
  if (u.protocol !== 'https:') refuse('INFISICAL_DOMAIN must start with https://');
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') {
    refuse('INFISICAL_DOMAIN must be a bare https://host[:port] with no path, query, fragment or user');
  }
  return u;
}

/** H11: a compose step is split on spaces; every word must be plain. */
export function splitStep(step) {
  const words = step.split(' ').slice(1).filter((w) => w !== '');
  if (!words.length || !words.every((w) => WORD_RE.test(w))) {
    refuse(`invalid step "${step.replace(/[^\x20-\x7e]/g, '?').slice(0, 80)}": words may use only A-Z a-z 0-9 @ % + = : , . / _ -`);
  }
  return words;
}

/** H4: an Infisical error `message`, made safe to print. */
export function sanitizeMessage(m) {
  if (typeof m === 'string') return m.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 200);
  if (Array.isArray(m)) {
    return m
      .map((i) => `${Array.isArray(i?.path) ? i.path.join('.') : ''}: ${typeof i?.code === 'string' ? i.code : ''}`)
      .join('; ')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
      .slice(0, 200);
  }
  return '';
}

/** Design D1 step 4, H5, H6: all-or-nothing validation. Returns Map<key, value>. */
export function validateSecrets(json, allowed) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.secrets)) {
    refuse('Infisical returned an unexpected response shape (no secrets array)');
  }
  if (json.secrets.length === 0) refuse('Infisical returned no secrets for this environment');
  const out = new Map();
  const names = new Set();
  const reasons = new Set();
  let others = 0;
  const bad = (k, why) => {
    reasons.add(why);
    if (typeof k === 'string' && KEY_RE.test(k)) names.add(k);
    else others += 1;
  };
  for (const s of json.secrets) {
    const k = s?.secretKey;
    if (!s || typeof s !== 'object' || typeof k !== 'string' || typeof s.secretValue !== 'string') bad(k, 'not-a-string');
    else if (!KEY_RE.test(k)) bad(k, 'invalid-name');
    else if (!allowed.has(k)) bad(k, 'not-allowed');
    else if (s.secretValueHidden !== false) bad(k, 'hidden-value');
    else if (s.secretValue.includes('\u0000')) bad(k, 'NUL');
    else if (out.has(k)) bad(k, 'duplicate');
    else out.set(k, s.secretValue);
  }
  if (names.size || others) {
    const list = [...names].sort().join(' ');
    refuse(
      `refusing the Infisical environment: ${list}${others ? `${list ? ' ' : ''}(and ${others} more that are not valid names)` : ''}` +
        ` [${[...reasons].sort().join(', ')}]. Allowed: the keys in ${ALLOWLIST} plus this environment's compose keys.`,
    );
  }
  return out;
}

export function checkProdTags(secrets) {
  for (const k of ['WEB_TAG', 'API_TAG']) {
    const v = secrets.get(k);
    if (!v) refuse(`${k} is unset or empty in Infisical prod (a git-SHA tag is required)`);
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
  if (st.isSymbolicLink() || !st.isFile()) refuse('INFISICAL_CA_FILE must name a regular file, not a symlink');
  if ((st.mode & 0o022) !== 0) refuse('INFISICAL_CA_FILE is writable by group or others');
  if (st.size > MAX_CA) refuse('INFISICAL_CA_FILE is larger than 64 KiB');
}

function readCreds(env, dir) {
  const f = join(dir, `.env.infisical.${env}`);
  try {
    lstatSync(f);
  } catch {
    refuse(`.env.infisical.${env} is missing. Create it from ${TEMPLATE} (chmod 600); see docs/infisical-secrets.md`);
  }
  checkCredFile(f);
  const kv = new Map();
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trimEnd());
    if (m) kv.set(m[1], m[2]);
  }
  const need = ['INFISICAL_UNIVERSAL_AUTH_CLIENT_ID', 'INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET', 'INFISICAL_PROJECT_ID', 'INFISICAL_DOMAIN', 'INFISICAL_CA_FILE'];
  for (const k of need) if (!kv.get(k)) refuse(`${k} is missing or empty in .env.infisical.${env} (see ${TEMPLATE})`);
  const url = parseDomain(kv.get('INFISICAL_DOMAIN'));
  const caPath = kv.get('INFISICAL_CA_FILE');
  try {
    lstatSync(caPath);
  } catch {
    refuse(`INFISICAL_CA_FILE in .env.infisical.${env} names a file that does not exist`);
  }
  checkCaFile(caPath);
  return {
    clientId: kv.get('INFISICAL_UNIVERSAL_AUTH_CLIENT_ID'),
    clientSecret: kv.get('INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET'),
    projectId: kv.get('INFISICAL_PROJECT_ID'),
    url,
    ca: readFileSync(caPath),
  };
}

// ------------------------------------------------------------------------ HTTPS (H2-H4) ----

const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ERR_TLS|HOSTNAME|ALTNAME/;

/** One JSON request. Resolves the parsed body of a 200; rejects with a printable Refusal. */
export function httpsJson({ url, ca, method, path, headers = {}, body, connectMs = 15000, totalMs = 30000 }) {
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
      headers: { accept: 'application/json', ...headers, ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) },
    });
    const done = (err, val) => {
      clearTimeout(total);
      clearTimeout(connect);
      if (err) {
        req.destroy();
        fail(err);
      } else ok(val);
    };
    const total = setTimeout(() => done(new Refusal(`Infisical request timed out after ${totalMs / 1000}s`)), totalMs);
    const connect = setTimeout(() => done(new Refusal(`could not connect to Infisical within ${connectMs / 1000}s`)), connectMs);
    req.on('socket', (s) => s.once('secureConnect', () => clearTimeout(connect)));
    req.on('error', (e) => {
      if (e instanceof Refusal) return done(e);
      const code = String(e?.code ?? '');
      if (TLS_CODES.test(code)) return done(new Refusal(`TLS check failed (${code}); trust the Infisical CA (INFISICAL_CA_FILE)`));
      return done(new Refusal(`could not reach Infisical (${code || 'network error'})`));
    });
    req.on('response', (res) => {
      if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
        res.resume();
        return done(new Refusal('Infisical sent a content-encoding this tool does not accept'));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) done(new Refusal('Infisical response too large (over 1 MiB)'));
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
        if (res.statusCode !== 200) {
          const m = sanitizeMessage(json?.message);
          return done(new Refusal(`Infisical answered HTTP ${res.statusCode}${m ? `: ${m}` : ''}`));
        }
        if (json === undefined) return done(new Refusal('Infisical response is not valid JSON'));
        return done(null, json);
      });
      res.on('error', () => done(new Refusal('Infisical response was interrupted')));
    });
    if (body) req.end(body);
    else req.end();
  });
}

// ------------------------------------------------------------------------ children --------

function allowedNames(env) {
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
  const r = spawnSync('sh', composeArgv(env, ['config', '--no-env-resolution', '--format', 'json']), {
    cwd: ROOT,
    env: childEnv,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.status !== 0) refuse(`compose could not resolve the ${env} config (bad port value?); check the Infisical ${env} environment`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    return refuse(`compose config for ${env} was not JSON`);
  }
}

/** The checks make-guards.sh `envfile` did, on the resolved config (never printed). */
export function checkResolved(env, cfg) {
  if (cfg?.name !== PROJECT[env]) refuse(`refusing: compose resolves the ${env} project to a name other than '${PROJECT[env]}'`);
  const ports = Object.values(cfg.services ?? {}).flatMap((s) => s.ports ?? []);
  if (ports.some((p) => p.host_ip !== '127.0.0.1')) refuse(`refusing: a published ${env} port is not bound to 127.0.0.1`);
  const pub = ports.map((p) => String(p.published));
  if (!pub.every((p) => /^[1-9][0-9]{0,4}$/.test(p) && Number(p) <= 65535)) refuse(`refusing: a published ${env} port is not a plain number 1-65535`);
  if (env !== 'prod' && pub.includes('8080')) refuse(`refusing: a published ${env} port is 8080 (production's router port); pick another in Infisical ${env}`);
  if (env === 'dev' && pub.some((p) => p === '80' || p === '443')) {
    refuse('refusing: a published dev port is 80 or 443; browsers omit the default port from Host/Origin so the dev gate would reject every request');
  }
  const want = env === 'dev' ? 2 : 1;
  if (ports.length !== want || (env === 'dev' && pub[0] === pub[1])) {
    refuse(`refusing: the resolved ${env} ports are not the expected set (dev: app and Companion on distinct ports; stage/prod: the router only)`);
  }
}

function urls(env, cfg) {
  if (env === 'dev') {
    process.stdout.write(`dev app:        http://127.0.0.1:${cfg.services.app.ports[0].published}\n`);
    process.stdout.write(`dev Companion:  http://127.0.0.1:${cfg.services.companion.ports[0].published}\n`);
    process.stdout.write('In Companion, set the AutoLogger connection base URL to:  http://app:8787\n');
  } else if (env === 'stage') {
    process.stdout.write(`stage:          http://localhost:${cfg.services.router.ports[0].published}   (use localhost, not 127.0.0.1)\n`);
  } else {
    process.stdout.write(`prod router:    http://127.0.0.1:${cfg.services.router.ports[0].published}\n`);
  }
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
  const login = await httpsJson({
    url: creds.url,
    ca: creds.ca,
    method: 'POST',
    path: '/api/v1/auth/universal-auth/login',
    body: JSON.stringify({ clientId: creds.clientId, clientSecret: creds.clientSecret }),
  });
  if (typeof login?.accessToken !== 'string' || login.accessToken === '') refuse('Infisical login returned no access token');
  const q = new URLSearchParams({
    projectId: creds.projectId,
    environment: env,
    secretPath: '/',
    expandSecretReferences: 'false',
    includeImports: 'false',
    recursive: 'false',
    viewSecretValue: 'true',
  });
  const fetched = await httpsJson({
    url: creds.url,
    ca: creds.ca,
    method: 'GET',
    path: `/api/v4/secrets?${q}`,
    headers: { authorization: `Bearer ${login.accessToken}` },
  });
  const secrets = validateSecrets(fetched, allowedNames(env));

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
    if (step.kind === 'resolved') checkResolved(env, config());
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
