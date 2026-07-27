import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from './types';
import {
  adminMeta,
  adminTokenConfigured,
  aiChatOpenNetworkRefused,
  aiV2OpenNetworkRefused,
  cookieSecureForRequest,
  deepgramConfigured,
  deepgramModel,
  newUserAllTeamsEnabled,
  oauthConfigured,
  publicBaseUrl,
  requireLoginEnabled,
  resolveYtDlpPath,
  sessionCookieName,
  sessionTtlDays,
  topicGenerateMaxBudgetUsd,
  topicGenerateTimeoutSec,
  youtubeImportOpenNetworkRefused,
  ytDlpConfigured,
} from './env';

const E = (o: Record<string, string | null | undefined>): Config => o as unknown as Config;

// A full, valid Config literal for exercising the shared open-network
// predicate — same base shape the ai.int.test.ts / aiV2.int.test.ts
// predicate tests use, extended with the new YTDLP_RESOLVED_PATH field.
const openNetworkBase = (): Config => ({
  PUBLIC_BASE_URL: '',
  HOST: '0.0.0.0',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
  REQUIRE_LOGIN: '0',
  SESSION_COOKIE: '',
  SESSION_DAYS: '14',
  NEW_USER_ALL_TEAMS: '0',
  COOKIE_SECURE: '',
  IP_ALLOWLIST: '',
  TRUST_PROXY: '',
  API_TOKEN: '',
  ADMIN_TOKEN: '',
  DEEPGRAM_API_KEY: '',
  DEEPGRAM_MODEL: '',
  CLAUDE_CLI_PATH: '',
  AI_CHAT_TIMEOUT_SEC: '',
  AI_CHAT_MAX_CONCURRENT: '',
  AI_CHAT_MAX_BUDGET_USD: '',
  TOPIC_GENERATE_MAX_BUDGET_USD: '',
  TOPIC_GENERATE_TIMEOUT_SEC: '',
  AI_V2_ENABLED: '',
  AI_V2_API_KEY: '',
  AI_V2_MAX_BUDGET_USD: '',
  YTDLP_RESOLVED_PATH: null,
});

describe('env flag parsing', () => {
  it('requireLoginEnabled defaults true; false only for 0/false/no', () => {
    expect(requireLoginEnabled(E({ REQUIRE_LOGIN: '1' }))).toBe(true);
    expect(requireLoginEnabled(E({ REQUIRE_LOGIN: 'TRUE' }))).toBe(true);
    expect(requireLoginEnabled(E({ REQUIRE_LOGIN: '0' }))).toBe(false);
    expect(requireLoginEnabled(E({ REQUIRE_LOGIN: 'false' }))).toBe(false);
    expect(requireLoginEnabled(E({ REQUIRE_LOGIN: 'no' }))).toBe(false);
    expect(requireLoginEnabled(E({}))).toBe(true);
    expect(requireLoginEnabled(E({ REQUIRE_LOGIN: '' }))).toBe(true);
  });

  it('newUserAllTeamsEnabled defaults off and is false for 0/false/no', () => {
    expect(newUserAllTeamsEnabled(E({}))).toBe(false);
    expect(newUserAllTeamsEnabled(E({ NEW_USER_ALL_TEAMS: 'no' }))).toBe(false);
    expect(newUserAllTeamsEnabled(E({ NEW_USER_ALL_TEAMS: '1' }))).toBe(true);
  });

  it('sessionCookieName falls back to default', () => {
    expect(sessionCookieName(E({}))).toBe('autologger_sid');
    expect(sessionCookieName(E({ SESSION_COOKIE: 'x' }))).toBe('x');
  });

  it('cookieSecureForRequest honors explicit flag, else derives from scheme', () => {
    expect(cookieSecureForRequest(E({ COOKIE_SECURE: 'yes' }), new Request('http://x'))).toBe(
      true,
    );
    expect(cookieSecureForRequest(E({ COOKIE_SECURE: 'no' }), new Request('https://x'))).toBe(
      false,
    );
    expect(cookieSecureForRequest(E({}), new Request('https://x'))).toBe(true);
    expect(cookieSecureForRequest(E({}), new Request('http://x'))).toBe(false);
  });

  it('cookieSecureForRequest trusts X-Forwarded-Proto only under TRUST_PROXY', () => {
    const req = new Request('http://x', { headers: { 'x-forwarded-proto': 'https' } });
    expect(cookieSecureForRequest(E({ TRUST_PROXY: '1' }), req)).toBe(true);
    expect(cookieSecureForRequest(E({}), req)).toBe(false);
  });

  it('sessionTtlDays — positive finite passes through; non-positive/non-numeric falls back', () => {
    expect(sessionTtlDays(E({}))).toBe(14);
    expect(sessionTtlDays(E({ SESSION_DAYS: '30' }))).toBe(30);
    // 0 would make KvStore.put store expires_at = NULL (immortal login
    // session); it falls back to the default like the sibling getters.
    expect(sessionTtlDays(E({ SESSION_DAYS: '0' }))).toBe(14);
    expect(sessionTtlDays(E({ SESSION_DAYS: '-1' }))).toBe(14);
    expect(sessionTtlDays(E({ SESSION_DAYS: 'abc' }))).toBe(14);
  });

  it('oauthConfigured requires id + secret + base url', () => {
    expect(oauthConfigured(E({}))).toBe(false);
    expect(
      oauthConfigured(
        E({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', PUBLIC_BASE_URL: 'http://x' }),
      ),
    ).toBe(true);
  });

  it('publicBaseUrl strips trailing slashes; adminMeta reflects token presence', () => {
    expect(publicBaseUrl(E({ PUBLIC_BASE_URL: 'http://x/' }))).toBe('http://x');
    expect(adminTokenConfigured(E({ ADMIN_TOKEN: 't' }))).toBe(true);
    expect(adminMeta(E({ ADMIN_TOKEN: 't' }))).toEqual({
      restart_supported: false,
      restart_needs_token: true,
    });
  });

  it('deepgramConfigured is true only when DEEPGRAM_API_KEY is set to a non-blank value', () => {
    expect(deepgramConfigured(E({}))).toBe(false);
    expect(deepgramConfigured(E({ DEEPGRAM_API_KEY: '' }))).toBe(false);
    expect(deepgramConfigured(E({ DEEPGRAM_API_KEY: '   ' }))).toBe(false);
    expect(deepgramConfigured(E({ DEEPGRAM_API_KEY: 'dg-key' }))).toBe(true);
  });

  it('deepgramModel defaults to nova-3 and is overridable via DEEPGRAM_MODEL', () => {
    expect(deepgramModel(E({}))).toBe('nova-3');
    expect(deepgramModel(E({ DEEPGRAM_MODEL: '' }))).toBe('nova-3');
    expect(deepgramModel(E({ DEEPGRAM_MODEL: 'nova-2' }))).toBe('nova-2');
  });
});

describe('topic generation config (design D6: dedicated budget/timeout, higher than the AI chat)', () => {
  it('topicGenerateMaxBudgetUsd defaults to 2.0 -- higher than aiChatMaxBudgetUsd (0.5) -- and is overridable', () => {
    expect(topicGenerateMaxBudgetUsd(E({}))).toBe(2.0);
    expect(topicGenerateMaxBudgetUsd(E({ TOPIC_GENERATE_MAX_BUDGET_USD: '' }))).toBe(2.0);
    expect(topicGenerateMaxBudgetUsd(E({ TOPIC_GENERATE_MAX_BUDGET_USD: '5' }))).toBe(5);
    // non-numeric / non-positive falls back to the default, matching aiChatMaxBudgetUsd's shape
    expect(topicGenerateMaxBudgetUsd(E({ TOPIC_GENERATE_MAX_BUDGET_USD: 'abc' }))).toBe(2.0);
    expect(topicGenerateMaxBudgetUsd(E({ TOPIC_GENERATE_MAX_BUDGET_USD: '0' }))).toBe(2.0);
    expect(topicGenerateMaxBudgetUsd(E({ TOPIC_GENERATE_MAX_BUDGET_USD: '-1' }))).toBe(2.0);
  });

  it('topicGenerateTimeoutSec defaults to 300 and is overridable via TOPIC_GENERATE_TIMEOUT_SEC', () => {
    expect(topicGenerateTimeoutSec(E({}))).toBe(300);
    expect(topicGenerateTimeoutSec(E({ TOPIC_GENERATE_TIMEOUT_SEC: '' }))).toBe(300);
    expect(topicGenerateTimeoutSec(E({ TOPIC_GENERATE_TIMEOUT_SEC: '600' }))).toBe(600);
    expect(topicGenerateTimeoutSec(E({ TOPIC_GENERATE_TIMEOUT_SEC: 'abc' }))).toBe(300);
    expect(topicGenerateTimeoutSec(E({ TOPIC_GENERATE_TIMEOUT_SEC: '0' }))).toBe(300);
  });
});

describe('yt-dlp binary resolution (design D2, youtube-audio-import)', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length) {
      rmSync(tempDirs.pop() as string, { recursive: true, force: true });
    }
  });

  it('explicit YTDLP_PATH set → resolved verbatim and reads as configured', () => {
    const resolved = resolveYtDlpPath({ YTDLP_PATH: '/opt/tools/yt-dlp', PATH: '' });
    expect(resolved).toBe('/opt/tools/yt-dlp');
    expect(ytDlpConfigured(E({ YTDLP_RESOLVED_PATH: resolved }))).toBe(true);
  });

  it('explicit YTDLP_PATH wins even when a different binary is also on PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ytdlp-path-'));
    tempDirs.push(dir);
    const onPath = join(dir, 'yt-dlp');
    writeFileSync(onPath, '#!/bin/sh\nexit 0\n');
    chmodSync(onPath, 0o755);
    const resolved = resolveYtDlpPath({ YTDLP_PATH: '/opt/tools/yt-dlp', PATH: dir });
    expect(resolved).toBe('/opt/tools/yt-dlp');
  });

  it('no explicit path but yt-dlp resolvable on PATH → resolved and reads as configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ytdlp-path-'));
    tempDirs.push(dir);
    const bin = join(dir, 'yt-dlp');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);
    const resolved = resolveYtDlpPath({ PATH: dir });
    expect(resolved).toBe(bin);
    expect(ytDlpConfigured(E({ YTDLP_RESOLVED_PATH: resolved }))).toBe(true);
  });

  it('a same-named file on PATH that is not executable is skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ytdlp-path-'));
    tempDirs.push(dir);
    const bin = join(dir, 'yt-dlp');
    writeFileSync(bin, 'not a real binary');
    chmodSync(bin, 0o644); // no execute bit
    expect(resolveYtDlpPath({ PATH: dir })).toBeNull();
  });

  it('neither an explicit path nor a PATH-resolvable binary → not configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ytdlp-empty-'));
    tempDirs.push(dir);
    expect(resolveYtDlpPath({ PATH: dir })).toBeNull();
    expect(resolveYtDlpPath({})).toBeNull();
    expect(ytDlpConfigured(E({ YTDLP_RESOLVED_PATH: null }))).toBe(false);
    expect(ytDlpConfigured(E({}))).toBe(false);
  });
});

describe('open-network refusal (shared predicate; AI chat / AI v2 / YouTube import)', () => {
  it('youtubeImportOpenNetworkRefused matches the same truth table as its siblings', () => {
    const base = openNetworkBase();
    // anonymous + non-loopback + no allowlist → refused
    expect(youtubeImportOpenNetworkRefused(base)).toBe(true);
    // unset HOST defaults to 0.0.0.0 (non-loopback) → refused
    expect(youtubeImportOpenNetworkRefused({ ...base, HOST: '' })).toBe(true);
    // login required → not refused
    expect(youtubeImportOpenNetworkRefused({ ...base, REQUIRE_LOGIN: '1' })).toBe(false);
    // allowlist present → not refused
    expect(youtubeImportOpenNetworkRefused({ ...base, IP_ALLOWLIST: '10.0.0.0/8' })).toBe(false);
    // loopback binds → not refused
    for (const h of ['127.0.0.1', '::1', 'localhost']) {
      expect(youtubeImportOpenNetworkRefused({ ...base, HOST: h })).toBe(false);
    }
  });

  it('all three open-network predicates agree on every case (shared core, not three copies)', () => {
    const base = openNetworkBase();
    const cases: Partial<Config>[] = [
      {},
      { HOST: '' },
      { REQUIRE_LOGIN: '1' },
      { REQUIRE_LOGIN: 'true' },
      { IP_ALLOWLIST: '10.0.0.0/8' },
      { HOST: '127.0.0.1' },
      { HOST: '::1' },
      { HOST: 'localhost' },
      { HOST: '192.168.1.5' },
      { REQUIRE_LOGIN: '1', HOST: '127.0.0.1' },
      { REQUIRE_LOGIN: '0', IP_ALLOWLIST: '', HOST: '0.0.0.0' },
    ];
    for (const overrides of cases) {
      const env = { ...base, ...overrides };
      const expected = aiChatOpenNetworkRefused(env);
      expect(aiV2OpenNetworkRefused(env)).toBe(expected);
      expect(youtubeImportOpenNetworkRefused(env)).toBe(expected);
    }
  });
});
