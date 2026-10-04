#!/usr/bin/env node
// docker/scripts/supabase-keys.mjs -- create missing Supabase secrets in one environment's
// OpenBao KV v2 secret (supabase-db design D5; openbao-secrets D4). Node built-ins only.
//
//   node docker/scripts/supabase-keys.mjs dev|stage|prod [--writer FILE]
//
// The OpenBao address, CA and KV path come from .env.openbao.<env>. The token comes from FILE
// (mode 600; a `BAO_TOKEN=...` line, or the token alone, e.g. ~/.vault-token after `bao login`)
// or else from BAO_TOKEN in the environment: an admin token that can write the path (the stack's
// AppRole cannot). Create only: an existing key is kept, never updated or deleted, and the write
// is check-and-set on the version read, so a concurrent write makes it fail whole. Prints key
// names and outcomes only.

import { createHmac, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Refusal, checkCredFile, checkNodeVersion, deletedMessage, deletedState, httpsRequest, kvDataPath, readCreds, statusRefusal } from './compose-run.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const ENVS = ['dev', 'stage', 'prod'];
// The secrets this generator owns, with how each value is made (formats: compose-run.mjs KEY_FORMAT).
const hex = (n) => () => randomBytes(n).toString('hex');
const b64u = (n) => () => randomBytes(n).toString('base64url');
const KEYS = {
  POSTGRES_PASSWORD: hex(16),
  SUPABASE_ROLES_PASSWORD: hex(16),
  APP_DB_PASSWORD: hex(16),
  JWT_SECRET: b64u(32),
  SECRET_KEY_BASE: b64u(64),
  REALTIME_DB_ENC_KEY: b64u(12),
};
// ANON_KEY and SERVICE_ROLE_KEY are HS256 JWTs signed with JWT_SECRET; the three are created together.
const TRIO = ['JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY'];
function apiKey(secret, role, iat) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const hp = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ role, iss: 'supabase', iat, exp: iat + 5 * 365 * 86400 })}`;
  return `${hp}.${createHmac('sha256', secret).update(hp).digest('base64url')}`;
}

const refuse = (msg) => {
  throw new Refusal(msg);
};

const TOKEN_RE = /^[\x21-\x7e]{1,512}$/;

/** The admin token: from the writer file if given (mode-600 checked), else BAO_TOKEN. */
function readToken(f, ownEnv) {
  let token;
  if (f) {
    try {
      lstatSync(f);
    } catch {
      refuse(`writer file ${f} does not exist`);
    }
    checkCredFile(f);
    const lines = readFileSync(f, 'utf8').split('\n').map((l) => l.trimEnd()).filter(Boolean);
    const kv = lines.map((l) => /^BAO_TOKEN=(.*)$/.exec(l)).find(Boolean);
    token = kv ? kv[1] : lines.length === 1 ? lines[0] : '';
    if (!token) refuse('the writer file holds no token (a BAO_TOKEN=... line, or the token alone)');
  } else {
    token = ownEnv.BAO_TOKEN ?? '';
    if (!token) refuse('no OpenBao token: set BAO_TOKEN (an admin token, e.g. after `bao login`) or pass --writer FILE');
  }
  if (!TOKEN_RE.test(token)) refuse('the OpenBao token has an unexpected format');
  return token;
}

async function main(argv, ownEnv) {
  checkNodeVersion(process.versions.node);
  const [env, flag, writer, ...rest] = argv;
  const usage = 'usage: supabase-keys.mjs dev|stage|prod [--writer FILE]';
  if (!ENVS.includes(env)) refuse(usage);
  if (flag !== undefined && (flag !== '--writer' || !writer || rest.length)) refuse(usage);
  let credDir = ROOT;
  if (ownEnv.AUTOLOGGER_TEST === '1' && ownEnv.AUTOLOGGER_TEST_CRED_DIR) {
    if (env === 'prod') refuse('test hooks (AUTOLOGGER_TEST_*) are refused for prod');
    if (!isAbsolute(ownEnv.AUTOLOGGER_TEST_CRED_DIR)) refuse('AUTOLOGGER_TEST_CRED_DIR must be an absolute path');
    credDir = ownEnv.AUTOLOGGER_TEST_CRED_DIR;
  }
  const target = readCreds(env, credDir, { auth: false });
  const token = readToken(writer, ownEnv);
  const path = kvDataPath(target.kv);
  const call = (method, body, headers = {}) =>
    httpsRequest({ url: target.url, ca: target.ca, method, path, headers: { 'x-vault-token': token, ...headers }, body: body ? JSON.stringify(body) : undefined });

  // The same path compose-run.mjs reads. KV v2 has no names-only read, so the values are
  // dropped at once: only the key names and the current version are kept.
  const read = await call('GET');
  let have;
  let version;
  // A soft-deleted (`deletion_time` passed) or destroyed current version still has its keys in an
  // older version: writing a fresh set over it would replace every database and JWT secret. KV v2
  // answers such a read with 404 plus the metadata, so any metadata on a 404 means the path exists.
  // A future deletion_time (delete_version_after) is a live version (deletedState).
  const md = read.json?.data?.metadata;
  const gone = read.status === 200 || read.status === 404 ? deletedState(md, read.status) : null;
  if (gone) refuse(`${deletedMessage(gone, `the OpenBao secret ${target.kv.mount}/${target.kv.path}`)} first (nothing was written)`);
  if (read.status === 200) {
    const data = read.json?.data?.data;
    version = md?.version;
    if (data && typeof data === 'object' && !Array.isArray(data)) have = new Set(Object.keys(data));
    else refuse('OpenBao returned an unexpected response shape (no data.data object)');
  } else if (read.status === 404) {
    // No secret at this path yet (a 404 with no metadata).
    have = new Set();
    version = 0;
  } else throw statusRefusal(read);
  read.json = undefined;
  if (!Number.isInteger(version) || version < 0) refuse('OpenBao returned no usable secret version');

  const trioHave = TRIO.filter((k) => have.has(k));
  if (trioHave.length && trioHave.length < TRIO.length) {
    refuse(`JWT_SECRET, ANON_KEY and SERVICE_ROLE_KEY are created together; ${TRIO.filter((k) => !have.has(k)).join(', ')} missing. Delete the others in OpenBao first (see docs/supabase.md)`);
  }
  const create = {};
  for (const [key, make] of Object.entries(KEYS)) if (!have.has(key)) create[key] = make();
  if (!trioHave.length) {
    const iat = Math.floor(Date.now() / 1000);
    create.ANON_KEY = apiKey(create.JWT_SECRET, 'anon', iat);
    create.SERVICE_ROLE_KEY = apiKey(create.JWT_SECRET, 'service_role', iat);
  }
  for (const k of [...Object.keys(KEYS), 'ANON_KEY', 'SERVICE_ROLE_KEY']) if (have.has(k)) process.stdout.write(`kept ${k}\n`);
  const names = Object.keys(create);
  if (names.length) {
    // One check-and-set write: PATCH merges into the current version; a path with no live data
    // gets a create-only POST (cas 0 on a new path). Either fails whole if anyone wrote since the read.
    const body = { options: { cas: version }, data: create };
    const patch = have.size > 0;
    let r;
    try {
      r = patch ? await call('PATCH', body, { 'content-type': 'application/merge-patch+json' }) : await call('POST', body);
    } catch (e) {
      refuse(`creating ${names.join(', ')} failed: ${e instanceof Refusal ? e.message : 'request error'} (not retried; nothing was created)`);
    }
    if (r.status !== 200 && r.status !== 204) {
      refuse(`creating ${names.join(', ')} failed: ${statusRefusal(r).message} (not retried; nothing was created)`);
    }
    for (const k of names) process.stdout.write(`created ${k}\n`);
  }
  return 0;
}
const FIXED = 'supabase-keys: internal error (details suppressed so that no secret can be printed)\n';
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.on('uncaughtException', () => {
    process.stderr.write(FIXED);
    process.exit(1);
  });
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(e instanceof Refusal ? `supabase-keys: ${e.message}\n` : FIXED);
      process.exit(1);
    },
  );
}
