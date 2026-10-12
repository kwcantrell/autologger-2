// Test helpers for the caller's language-model route (ai-sdk-agent-harness design D1, D9).
//
// D9 category 1: a test that enables AI by setting `CLAUDE_CLI_PATH` also lists its callers in
// `CLAUDE_CLI_EMAILS` and saves a keyless `claude-cli` choice for them, the production path (there
// is no fallback). `CLI_TEST_EMAILS` lists every email the integration suites sign in with, and
// `chooseClaudeCliForAll()` saves the choice for every user in the test database, so a suite only
// adds the variable to its CLI env and calls the helper before its requests.
//
// SDK routes run against a local fake provider through a development-mode `openai-compatible`
// credential on `http://127.0.0.1` (task 7 preamble), saved through `PUT /api/me/providers/llm`
// as the caller, so the key is encrypted by the server's own cipher.

import { type Dirent, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { connOptions } from '../../../test/pg/testDb';
import { anonApp, defaultUser, env, testDatabase, testDirs } from './harness';
import { catalogFor } from './helpers';

/** Every email the integration suites sign in with (the harness defaults and the fixed seeds). */
export const CLI_TEST_EMAILS = [
  'default-user@example.com',
  'seeded-user@example.com',
  'not-approved@example.com',
  'approved.member@example.com',
  'test-owner@example.com',
].join(',');

/** Save the keyless `claude-cli` `llm` choice for every user in the test database. */
export async function chooseClaudeCliForAll(): Promise<void> {
  for (const u of await catalogFor().auth.authListUsersAdmin()) {
    await env.ports.providerCredentials.putKeyless(String(u.id), 'llm', 'claude-cli');
  }
}

/** Save the keyless `claude-cli` `llm` choice for these users. */
export async function chooseClaudeCli(...userIds: string[]): Promise<void> {
  for (const id of userIds) await env.ports.providerCredentials.putKeyless(id, 'llm', 'claude-cli');
}

/** Save a development-mode `openai-compatible` `llm` credential on the fake provider at `baseURL`
 * for the caller behind `cookie` (the default user when omitted), through the providers route. */
export async function saveSdkCredential(
  baseURL: string,
  opts: { cookie?: string; model?: string; apiKey?: string } = {},
): Promise<void> {
  const cookie = opts.cookie ?? (await defaultUser()).cookie;
  const res = await anonApp.request(
    '/api/me/providers/llm',
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        provider: 'openai-compatible',
        base_url: baseURL,
        model: opts.model ?? 'fake-model',
        api_key: opts.apiKey ?? 'sk-fake-provider-key',
      }),
    },
    env,
  );
  if (res.status !== 200) throw new Error(`saving the llm credential answered ${res.status}`);
}

/** Where `marker` survives: every table of the `catalog` schema (read as the migrations owner,
 * which owns them, each row's text matched with `like`; an unreadable table throws) and every file under `DATA_DIR` and `BLOB_DIR`. Used by the "nothing
 * of an AI SDK turn survives it" checks (ai-topics-chat; task 7.1). */
export async function placesHolding(marker: string): Promise<string[]> {
  const found: string[] = [];
  const admin = postgres({
    ...connOptions('postgres', testDatabase().database),
    max: 1,
    onnotice: () => {},
  });
  try {
    const tables = await admin<Array<{ s: string; t: string }>>`
      select table_schema as s, table_name as t from information_schema.tables
      where table_type = 'BASE TABLE' and table_schema = 'catalog'`;
    for (const { s, t } of tables) {
      const rows = await admin.unsafe(
        `select count(*)::int as n from "${s.replace(/"/g, '""')}"."${t.replace(/"/g, '""')}" x where x::text like $1`,
        [`%${marker}%`],
      );
      if ((rows[0]?.n ?? 0) > 0) found.push(`${s}.${t}`);
    }
  } finally {
    await admin.end();
  }
  const walk = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && readFileSync(p).includes(marker)) found.push(p);
    }
  };
  const { dataDir, blobDir } = testDirs();
  walk(dataDir);
  walk(blobDir);
  return found;
}
