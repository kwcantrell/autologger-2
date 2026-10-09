#!/usr/bin/env node
// docker/scripts/compose-run.mjs -- run guard and compose steps for one stack with its secrets
// from OpenBao (openbao-secrets design D1; hardening rules H1-H12 of infisical-secrets, kept).
// Node built-ins only.
//
//   node docker/scripts/compose-run.mjs dev|stage|prod STEP...
//     STEP: resolved | prod-tags | urls | reset | 'compose ARGS...'
//     e.g.  compose-run.mjs dev resolved 'compose up -d --build' urls
//
// Stage only (stage-public-https): the Makefile may also pass three non-secret operator values,
// validated here and never read from OpenBao: STAGE_IMAGE_TAG (a full 40-hex git SHA; run the
// pushed ghcr.io images instead of building :local; requires STAGE_PUBLIC_BASE_URL, and this tree
// must be that commit: git HEAD, or a REVISION file where there is no .git), STAGE_PUBLIC_BASE_URL
// (https://<host>, the public origin behind the HTTPS edge; COOKIE_SECURE becomes 1) and, with a
// tag only, DOCKER_CONFIG (a directory you own that no one else can write). From DOCKER_CONFIG only
// the inline `auths` of its config.json are read; compose gets a fresh 0700 temporary DOCKER_CONFIG
// holding just those (removed on exit) and DOCKER_CONTEXT=default, never the caller's directory.
// Without a tag DOCKER_CONFIG is ignored (as for dev and prod). A pinned tree (REVISION, no .git)
// refuses untagged up/build/run.
//
// The Makefile starts this under `env -i` (H1). One process: read the per-host credentials file
// (.env.openbao.<env>), log in to OpenBao with AppRole, read the stack's KV v2 secret, revoke the
// token, validate every secret, then run each step with a child environment built from scratch
// (only the validated allowlist keys). No secret is ever parsed by a shell, put on argv, written
// to disk, or printed.

import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXED_PATH = '/usr/local/bin:/usr/bin:/bin';
const ALLOWLIST = 'docker/secrets-env.yaml';
const TEMPLATE = 'docker/openbao-credentials.example';
const ENVS = ['dev', 'stage', 'prod'];
// Compose-interpolation keys an environment may hold besides the allowlist (design D3).
// The Supabase keys reach only the services SECRET_SCOPE allows (supabase-db D4, supabase-services D4;
// drop-unused-supabase-services D3: the four that db, migrate, auth and the app still use).
const SUPABASE_KEYS = ['POSTGRES_PASSWORD', 'SUPABASE_ROLES_PASSWORD', 'APP_DB_PASSWORD', 'JWT_SECRET'];
// drop-unused-supabase-services D3: keys of the removed Supabase services. A secret may still hold
// them (another checkout runs the old stack): accepted, never format-checked, never passed to
// compose, and named once in a warning.
const RETIRED_KEYS = ['ANON_KEY', 'SERVICE_ROLE_KEY', 'SECRET_KEY_BASE', 'REALTIME_DB_ENC_KEY', 'SUPABASE_PORT'];
const COMPOSE_KEYS = {
  dev: ['DEV_PORT', 'DEV_COMPANION_PORT', ...SUPABASE_KEYS, ...RETIRED_KEYS],
  stage: ['STAGE_PORT', ...SUPABASE_KEYS, ...RETIRED_KEYS],
  prod: ['ROUTER_PORT', 'WEB_TAG', 'API_TAG', 'PUBLIC_BASE_URL', ...SUPABASE_KEYS, ...RETIRED_KEYS],
};
// Per-key value formats: strong, URL-safe, and safe for busybox echo and psql backticks.
const KEY_FORMAT = {
  POSTGRES_PASSWORD: /^[0-9a-f]{32,}$/,
  SUPABASE_ROLES_PASSWORD: /^[0-9a-f]{32,}$/,
  APP_DB_PASSWORD: /^[0-9a-f]{32,}$/,
  JWT_SECRET: /^[A-Za-z0-9_-]{40,}$/,
};
// The services each secret value may appear in (spec invariant 16); per stack where it differs.
// drop-unused-supabase-services D3: rest, realtime, storage and supabase-gw are gone.
const SECRET_SCOPE = {
  POSTGRES_PASSWORD: ['db', 'migrate'],
  // The catalog's app role (catalog-pg-schema D4): the stack's app service and the runner.
  APP_DB_PASSWORD: { dev: ['app', 'migrate'], stage: ['api', 'migrate'], prod: ['api', 'migrate'] },
  SUPABASE_ROLES_PASSWORD: ['db', 'auth'],
  JWT_SECRET: ['auth'],
};
const PROJECT = { dev: 'autologger-dev', stage: 'autologger-stage', prod: 'autologger' };
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/; // no `m` flag: `$` is end of input only
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const WORD_RE = /^[A-Za-z0-9@%+=:,./_-]+$/;
const MAX_BODY = 1024 * 1024;
const REGISTRY = 'ghcr.io/kwcantrell';
// 40 hex only: prod-push tags the 12-char SHA (multi-arch); a stage push must never overwrite it.
const STAGE_TAG_RE = /^[0-9a-f]{40}$/;
const DNS_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export const STAGE_LOCAL_IMAGES = { web: 'autologger-stage-web:local', api: 'autologger-stage-api:local' };
const MAX_CA = 64 * 1024;
const MAX_DOCKER_CFG = 1024 * 1024;

/** A refusal whose message is safe to print (never holds a secret value). */
export class Refusal extends Error {}
const refuse = (msg) => {
  throw new Refusal(msg);
};
/** Whether a path exists (lstat: a dangling symlink counts). */
const present = (f) => {
  try {
    lstatSync(f);
    return true;
  } catch {
    return false;
  }
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

/** drop-unused-supabase-services D3: the warning line naming the retired keys a secret holds
 * (names only, sorted), or undefined when it holds none. */
export function retiredKeyWarning(secrets, env) {
  const held = RETIRED_KEYS.filter((k) => secrets.has(k)).sort();
  if (!held.length) return undefined;
  return `compose-run: warning: the OpenBao ${env} secret holds retired keys ${held.join(', ')}; nothing reads them, and they can be removed once no checkout runs the old Supabase services (docs/openbao-secrets.md)`;
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

// ------------------------------------------------------------------------ stage options ---

/** STAGE_PUBLIC_BASE_URL: https://<dns name> (no port, path, query, fragment or user). Returns the
 * origin; '' when unset (unset is the local stage, http://localhost:STAGE_PORT). */
export function parseStagePublicUrl(s) {
  if (s === undefined || s === '') return '';
  let u;
  try {
    u = new URL(s);
  } catch {
    refuse('STAGE_PUBLIC_BASE_URL is not a URL');
  }
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || (s !== u.origin && s !== `${u.origin}/`)) {
    refuse('STAGE_PUBLIC_BASE_URL must be a bare origin (https://stage.example.com): no path, query, fragment, user or unusual spelling');
  }
  if (u.protocol !== 'https:') refuse('STAGE_PUBLIC_BASE_URL must be https://<host> (leave it unset for the local http://localhost:STAGE_PORT)');
  if (u.port !== '' || !DNS_RE.test(u.hostname) || !/\.[a-z][a-z0-9-]*$/.test(u.hostname)) {
    refuse('STAGE_PUBLIC_BASE_URL must be https://<dns name> with no port (the edge serves 443)');
  }
  return u.origin;
}

/** The stage operator values (see the header), validated. `own` is this process's environment. */
export function parseStageOptions(own) {
  const tag = own.STAGE_IMAGE_TAG ?? '';
  if (tag !== '' && !STAGE_TAG_RE.test(tag)) refuse('STAGE_IMAGE_TAG must be a full 40-character lowercase hex git SHA (the tag make stage-push pushed)');
  const url = parseStagePublicUrl(own.STAGE_PUBLIC_BASE_URL);
  // A tagged run is a public run: on the host behind the edge, a run without the origin would
  // recreate api with COOKIE_SECURE=0 and a localhost redirect while the tunnel serves it.
  if (tag && !url) refuse('STAGE_IMAGE_TAG runs the public stage: also set STAGE_PUBLIC_BASE_URL=https://<host> (the origin the edge serves)');
  // DOCKER_CONFIG is read only for a tagged run (`compose pull`); otherwise it is ignored, as for
  // dev and prod, so an ambient value cannot change a local stage run.
  const dc = tag ? (own.DOCKER_CONFIG ?? '') : '';
  return {
    tag,
    images: tag ? { web: `${REGISTRY}/autologger-web:${tag}`, api: `${REGISTRY}/autologger-api:${tag}` } : { ...STAGE_LOCAL_IMAGES },
    publicBaseUrl: url,
    cookieSecure: url ? '1' : '0',
    dockerAuths: dc !== '' ? readDockerAuths(dc) : null,
  };
}

/** Owned by `uid`, not a symlink, writable by no one else (group/other write bits clear). */
function checkOwnedNoWrite(f, what, uid, dir) {
  let st;
  try {
    st = lstatSync(f);
  } catch {
    return refuse(`${what} does not exist`);
  }
  if (st.isSymbolicLink()) refuse(`${what} must not be a symlink`);
  if (dir ? !st.isDirectory() : !st.isFile()) refuse(`${what} must be a ${dir ? 'directory' : 'regular file'}`);
  if (st.uid !== uid) refuse(`${what} must be owned by you`);
  if ((st.mode & 0o022) !== 0) refuse(`${what} is writable by group or others (mode ${(st.mode & 0o777).toString(8)})`);
  return st;
}

/** The caller's DOCKER_CONFIG is only READ here (its config.json): a directory, and config.json,
 * that you own and no one else can write. compose never sees this directory (readDockerAuths). */
export function checkDockerConfig(dc, uid = process.getuid()) {
  if (!isAbsolute(dc) || !/^[A-Za-z0-9@%+=:,./_-]+$/.test(dc)) refuse('DOCKER_CONFIG must be an absolute path of plain characters');
  checkOwnedNoWrite(dc, 'DOCKER_CONFIG', uid, true);
  const cfg = join(dc, 'config.json');
  if (present(cfg)) checkOwnedNoWrite(cfg, 'DOCKER_CONFIG/config.json', uid, false);
}

/** The inline registry logins (`auths`) of DOCKER_CONFIG/config.json, and nothing else. A docker
 * config directory can run code in the child that holds every stage secret (a `cli-plugins`
 * entry, `cliPluginsExtraDirs`, `currentContext`, `proxies`), so the child gets a fresh directory
 * with only these (makeDockerConfig). A credential helper keeps the secret outside config.json,
 * so `credsStore`/`credHelpers` are refused rather than silently pulling without a login. */
export function readDockerAuths(dc, uid = process.getuid()) {
  checkDockerConfig(dc, uid);
  const f = join(dc, 'config.json');
  if (!present(f)) return {};
  if (lstatSync(f).size > MAX_DOCKER_CFG) refuse('DOCKER_CONFIG/config.json is larger than 1 MiB');
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    refuse('DOCKER_CONFIG/config.json is not valid JSON');
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) refuse('DOCKER_CONFIG/config.json is not a JSON object');
  if (cfg.credsStore || (cfg.credHelpers && Object.keys(cfg.credHelpers).length)) {
    refuse('DOCKER_CONFIG/config.json uses a credential helper (credsStore/credHelpers); only inline "auths" are passed to compose. ' +
      'Log in with no docker-credential-* helper on PATH, or write {"auths":{"ghcr.io":{"auth":"<base64 user:token>"}}} yourself');
  }
  const auths = cfg.auths ?? {};
  if (!auths || typeof auths !== 'object' || Array.isArray(auths)) refuse('DOCKER_CONFIG/config.json "auths" is not an object');
  return JSON.parse(JSON.stringify(auths));
}

/** A fresh 0700 DOCKER_CONFIG holding only `{"auths": ...}` (0600). The caller removes it. */
export function makeDockerConfig(auths, base = tmpdir()) {
  const d = mkdtempSync(join(base, 'compose-run-docker-'));
  writeFileSync(join(d, 'config.json'), JSON.stringify({ auths }), { mode: 0o600, flag: 'wx' });
  return d;
}

/** A pinned deploy (REVISION, no .git) is the public stage: an untagged up/build/run there would
 * build and serve the local posture (COOKIE_SECURE=0, a localhost redirect) through the edge. */
export function checkPinnedUntagged(root, tag, plan) {
  if (tag || present(join(root, '.git')) || !present(join(root, 'REVISION'))) return;
  if (plan.some((p) => p.kind === 'compose' && p.args.some((w) => ['up', 'build', 'run', '--build'].includes(w)))) {
    refuse('this tree was deployed pinned (a REVISION file and no .git), so it serves the public stage: up, build and run need ' +
      'STAGE_IMAGE_TAG=<the REVISION sha> STAGE_PUBLIC_BASE_URL=https://<host> (for a local stage on this host, stop the edge and remove REVISION first)');
  }
}

/** With a tag, the tree make runs in (migrations, migrate.sh, Caddyfiles, init SQL, compose files)
 * must be the tagged commit: `git rev-parse HEAD` when `root/.git` exists, else the trimmed content
 * of a regular file `root/REVISION` (written by the pinned deploy, which ships no .git). */
export function checkStageTree(root, tag, home = '') {
  if (!tag) return;
  const where = 'the tree make runs in (migrations, Caddyfiles and compose files come from it)';
  if (present(join(root, '.git'))) {
    // A .git next to a REVISION file is most likely left over from an earlier git checkout.
    const stale = present(join(root, 'REVISION'))
      ? '; this tree also has a REVISION file, so its .git is probably left over from an earlier checkout: remove the .git (the pinned deploy does) and REVISION is checked instead'
      : `; run make from a checkout of ${tag}`;
    const r = spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD'], {
      env: { PATH: FIXED_PATH, ...(home ? { HOME: home } : {}) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const head = r.status === 0 ? r.stdout.trim() : '';
    if (!STAGE_TAG_RE.test(head)) refuse(`could not read git HEAD of ${where}${stale}`);
    if (head !== tag) refuse(`STAGE_IMAGE_TAG is not HEAD (${head}) of ${where}${stale}`);
    return;
  }
  const f = join(root, 'REVISION');
  let st;
  try {
    st = lstatSync(f);
  } catch {
    refuse(`${where} has no .git and no REVISION file, so it cannot be tied to STAGE_IMAGE_TAG`);
  }
  if (st.isSymbolicLink() || !st.isFile() || st.size > 128) refuse('REVISION must be a small regular file, not a symlink');
  const rev = readFileSync(f, 'utf8').trim();
  if (rev !== tag) refuse(`STAGE_IMAGE_TAG is not the REVISION of ${where} (${STAGE_TAG_RE.test(rev) ? rev : 'not a 40-hex SHA'})`);
}

/** The compose variables docker/compose.stage.yaml reads for these options (none when unset);
 * `dockerDir` is the temporary DOCKER_CONFIG from makeDockerConfig, if any. */
export function stageComposeEnv(opts, dockerDir = '') {
  const out = {};
  if (opts.tag) {
    out.STAGE_WEB_IMAGE = opts.images.web;
    out.STAGE_API_IMAGE = opts.images.api;
  }
  if (opts.publicBaseUrl) {
    out.STAGE_PUBLIC_BASE_URL = opts.publicBaseUrl;
    out.STAGE_COOKIE_SECURE = opts.cookieSecure;
  }
  if (dockerDir) {
    out.DOCKER_CONFIG = dockerDir;
    out.DOCKER_CONTEXT = 'default'; // belt and braces: the temporary config.json has no currentContext
  }
  return out;
}

/** With a registry tag, nothing may build: every `up` says --no-build and no step builds. */
export function checkStagePlan(opts, plan) {
  if (!opts.tag) return;
  for (const p of plan) {
    if (p.kind !== 'compose') continue;
    if (p.args.includes('build') || p.args.includes('--build')) refuse('STAGE_IMAGE_TAG runs the pushed registry images; building is refused (make stage-build builds :local without it)');
    if (p.args.includes('up') && !p.args.includes('--no-build')) refuse("with STAGE_IMAGE_TAG every 'compose up' must pass --no-build");
  }
}

/** The resolved stage config runs exactly the expected images, origin and cookie posture. */
export function checkStageResolved(cfg, opts) {
  const s = cfg?.services ?? {};
  if (s.web?.image !== opts.images.web || s.api?.image !== opts.images.api) {
    refuse(`refusing: the resolved stage web/api images are not ${opts.images.web} and ${opts.images.api}`);
  }
  const e = s.api?.environment ?? {};
  const port = s.router?.ports?.[0]?.published;
  const url = opts.publicBaseUrl || `http://localhost:${port}`;
  if (e.PUBLIC_BASE_URL !== url) refuse(`refusing: the resolved stage PUBLIC_BASE_URL is not ${url}`);
  if (e.COOKIE_SECURE !== opts.cookieSecure) refuse(`refusing: the resolved stage COOKIE_SECURE is not ${opts.cookieSecure}`);
  if (e.TRUST_PROXY !== '1') refuse('refusing: the resolved stage TRUST_PROXY is not 1');
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
let running = 0; // children in flight: the process-level signal handlers defer to runChild's
function runChild(argv, childEnv) {
  return new Promise((ok) => {
    const child = spawn('sh', argv, { cwd: ROOT, env: childEnv, stdio: 'inherit' });
    running += 1;
    const fwd = (sig) => () => child.kill(sig);
    const onTerm = fwd('SIGTERM');
    const onHup = fwd('SIGHUP');
    const onInt = () => {};
    process.on('SIGTERM', onTerm);
    process.on('SIGHUP', onHup);
    process.on('SIGINT', onInt);
    const finish = (code) => {
      running -= 1;
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
  // drop-unused-supabase-services D3: the gateway's port is gone.
  const want = env === 'dev' ? ['app', 'companion'] : ['router'];
  const owners = Object.entries(cfg.services ?? {}).filter(([, s]) => (s.ports ?? []).length).map(([n]) => n).sort();
  if (ports.length !== want.length || owners.join() !== want.join() || new Set(pub).size !== pub.length) {
    refuse(`refusing: the resolved ${env} ports are not the expected set (${want.join(', ')}, one each, on distinct ports)`);
  }
}

function urls(env, cfg) {
  if (env === 'dev') {
    process.stdout.write(`dev app:        http://127.0.0.1:${cfg.services.app.ports[0].published}\n`);
    process.stdout.write(`dev Companion:  http://127.0.0.1:${cfg.services.companion.ports[0].published}\n`);
    process.stdout.write('In Companion, set the AutoLogger connection base URL to:  http://app:8787\n');
  } else if (env === 'stage') {
    const pub = cfg.services.api?.environment?.PUBLIC_BASE_URL ?? '';
    if (pub.startsWith('https://')) {
      process.stdout.write(`stage:          ${pub}   (the HTTPS edge proxies to http://127.0.0.1:${cfg.services.router.ports[0].published})\n`);
    } else {
      process.stdout.write(`stage:          http://localhost:${cfg.services.router.ports[0].published}   (use localhost, not 127.0.0.1)\n`);
    }
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
  // supabase-db D6: nothing may migrate prod or open a shell in it.
  if (env === 'prod' && plan.some((p) => p.kind === 'compose' && p.args.some((w) => w === 'run' || w === 'exec'))) {
    refuse('compose run and exec are refused for prod (no migration or shell against the prod database)');
  }
  // stage-public-https: the operator values exist for stage only; validated before any request.
  if (env !== 'stage' && ['STAGE_IMAGE_TAG', 'STAGE_PUBLIC_BASE_URL'].some((k) => ownEnv[k])) {
    refuse('STAGE_IMAGE_TAG and STAGE_PUBLIC_BASE_URL apply to stage only');
  }
  const stage = env === 'stage' ? parseStageOptions(ownEnv) : null;
  if (stage) {
    checkStagePlan(stage, plan);
    checkStageTree(ROOT, stage.tag, ownEnv.HOME);
    checkPinnedUntagged(ROOT, stage.tag, plan);
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
  const retired = retiredKeyWarning(secrets, env);
  if (retired) process.stderr.write(`${retired}\n`);
  checkSignInClient(env, secrets);

  // H6, H12: the child environment, built from nothing.
  const childEnv = Object.create(null);
  childEnv.PATH = path;
  if (ownEnv.HOME) childEnv.HOME = ownEnv.HOME;
  if (ownEnv.TERM) childEnv.TERM = ownEnv.TERM;
  // drop-unused-supabase-services D3: the retired keys never reach compose or a container.
  for (const [k, v] of secrets) if (!RETIRED_KEYS.includes(k)) childEnv[k] = v;
  childEnv.AUTOLOGGER_STACK = env;
  const dockerDir = stage?.dockerAuths ? makeDockerConfig(stage.dockerAuths) : '';
  if (dockerDir) TEMP_DIRS.add(dockerDir);
  if (stage) Object.assign(childEnv, stageComposeEnv(stage, dockerDir));

  try {
    return await runSteps(env, plan, childEnv, secrets, stage);
  } finally {
    removeTempDirs();
  }
}

// Temporary directories (the stage DOCKER_CONFIG) are removed on every exit path: normal return,
// refusal, internal error (process 'exit'), and a signal while no child runs.
const TEMP_DIRS = new Set();
function removeTempDirs() {
  for (const d of TEMP_DIRS) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort; the directory holds only a registry login
    }
  }
  TEMP_DIRS.clear();
}

async function runSteps(env, plan, childEnv, secrets, stage) {
  let cfg;
  const config = () => {
    cfg ??= resolveConfig(env, childEnv);
    return cfg;
  };
  for (const step of plan) {
    if (step.kind === 'resolved') {
      checkResolved(env, config(), secrets);
      if (stage) checkStageResolved(config(), stage);
    }
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
  process.on('exit', removeTempDirs);
  // While a child runs, runChild forwards SIGTERM/SIGHUP and ignores SIGINT; otherwise exit as the
  // signal would, after removing the temporary directories.
  for (const [sig, n] of [['SIGTERM', 15], ['SIGHUP', 1], ['SIGINT', 2]]) {
    process.on(sig, () => {
      if (running === 0) {
        removeTempDirs();
        process.exit(128 + n);
      }
    });
  }
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(e instanceof Refusal ? `compose-run: ${e.message}\n` : FIXED);
      process.exit(1);
    },
  );
}
