#!/usr/bin/env node
// docker/scripts/supabase-keys.mjs -- create missing Supabase secrets in one environment's
// Infisical project (supabase-db design D5). Node built-ins only.
//
//   node docker/scripts/supabase-keys.mjs dev|stage|prod --writer FILE
//
// The project id, Infisical URL and CA come from .env.infisical.<env>; the client id and secret
// come from FILE, an identity that can write (the environment's viewer identity cannot). Create
// only: an existing key is kept, never updated or deleted. Prints key names and outcomes only.

import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Refusal, checkCredFile, checkNodeVersion, httpsJson, readCreds } from './compose-run.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const ENVS = ['dev', 'stage', 'prod'];
// The secrets this generator owns, with how each value is made (1.2b extends this table).
const KEYS = { POSTGRES_PASSWORD: () => randomBytes(16).toString('hex') };

const refuse = (msg) => {
  throw new Refusal(msg);
};

function readWriter(f) {
  try {
    lstatSync(f);
  } catch {
    refuse(`writer file ${f} does not exist`);
  }
  checkCredFile(f);
  const kv = new Map();
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trimEnd());
    if (m) kv.set(m[1], m[2]);
  }
  for (const k of ['INFISICAL_UNIVERSAL_AUTH_CLIENT_ID', 'INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET']) {
    if (!kv.get(k)) refuse(`${k} is missing or empty in the writer file`);
  }
  return { clientId: kv.get('INFISICAL_UNIVERSAL_AUTH_CLIENT_ID'), clientSecret: kv.get('INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET') };
}

async function main(argv, ownEnv) {
  checkNodeVersion(process.versions.node);
  const [env, flag, writer, ...rest] = argv;
  if (!ENVS.includes(env) || flag !== '--writer' || !writer || rest.length) {
    refuse('usage: supabase-keys.mjs dev|stage|prod --writer FILE');
  }
  let credDir = ROOT;
  if (ownEnv.AUTOLOGGER_TEST === '1' && ownEnv.AUTOLOGGER_TEST_CRED_DIR) {
    if (env === 'prod') refuse('test hooks (AUTOLOGGER_TEST_*) are refused for prod');
    if (!isAbsolute(ownEnv.AUTOLOGGER_TEST_CRED_DIR)) refuse('AUTOLOGGER_TEST_CRED_DIR must be an absolute path');
    credDir = ownEnv.AUTOLOGGER_TEST_CRED_DIR;
  }
  const target = readCreds(env, credDir, { auth: false });
  const who = readWriter(writer);

  const call = (method, path, body, token) =>
    httpsJson({
      url: target.url,
      ca: target.ca,
      method,
      path,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  const login = await call('POST', '/api/v1/auth/universal-auth/login', who);
  if (typeof login?.accessToken !== 'string' || login.accessToken === '') refuse('Infisical login returned no access token');
  const token = login.accessToken;

  // The same scope compose-run.mjs fetches with, names only.
  const q = new URLSearchParams({
    projectId: target.projectId,
    environment: env,
    secretPath: '/',
    expandSecretReferences: 'false',
    includeImports: 'false',
    recursive: 'false',
    viewSecretValue: 'false',
  });
  const listed = await call('GET', `/api/v4/secrets?${q}`, null, token);
  if (!Array.isArray(listed?.secrets)) refuse('Infisical returned an unexpected response shape (no secrets array)');
  const have = new Set(listed.secrets.map((s) => s?.secretKey));

  for (const [key, make] of Object.entries(KEYS)) {
    if (have.has(key)) {
      process.stdout.write(`kept ${key}\n`);
      continue;
    }
    try {
      await call('POST', '/api/v4/secrets/batch', { projectId: target.projectId, environment: env, secretPath: '/', secrets: [{ secretKey: key, secretValue: make() }] }, token);
    } catch (e) {
      refuse(`creating ${key} failed: ${e instanceof Refusal ? e.message : 'request error'} (not retried)`);
    }
    process.stdout.write(`created ${key}\n`);
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
