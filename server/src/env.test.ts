import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@autologger/ports';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adminMeta,
  adminTokenConfigured,
  bootstrapEmailMatch,
  bootstrapOwnerEmail,
  cookieSecureForRequest,
  eventGenerateMaxBudgetUsd,
  eventGenerateMaxCreatedEvents,
  eventGenerateMaxInstructionBytes,
  eventGenerateMaxInstructionEntries,
  eventGenerateTimeoutSec,
  maskBootstrapOwnerEmail,
  newUserAllTeamsEnabled,
  oauthConfigured,
  parseAiProvider,
  publicBaseUrl,
  resolveYtDlpPath,
  runFeatureAllowed,
  runFeatureEmails,
  sessionCookieName,
  sessionTtlDays,
  topicGenerateMaxBudgetUsd,
  topicGenerateTimeoutSec,
  ytDlpConfigured,
} from './env';

const E = (o: Record<string, string | null | undefined>): Config => o as unknown as Config;

describe('env flag parsing', () => {
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
    expect(cookieSecureForRequest(E({ COOKIE_SECURE: 'yes' }), new Request('http://x'))).toBe(true);
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

  // deepgramConfigured/deepgramModel cases moved out with the functions
  // themselves (feature-service-packages task 4.1, design D5): they live in
  // @autologger/transcription now. This deletion is NOT task 4.3's "move
  // into the transcription package's own suite" — it is the minimal edit
  // needed to keep this file compiling once the functions left env.ts; task
  // 4.3 landed the package's own equivalent coverage at
  // packages/transcription/src/deepgramConfig.test.ts (commit 2edd977),
  // carrying both cases over verbatim.
});

describe('topic generation config (design D6: dedicated budget/timeout, higher than the AI chat)', () => {
  // topic-generate-paged-transcript D7: the one-shot now pages the full transcript at
  // generation density, so these defaults were raised 2.0 -> 5.0 / 300 -> 600, matching
  // the event-generate defaults the repo sizes for that same read.
  it('topicGenerateMaxBudgetUsd defaults to 5.0 -- higher than aiChatMaxBudgetUsd (0.5) -- and is overridable', () => {
    expect(topicGenerateMaxBudgetUsd(E({}))).toBe(5.0);
    expect(topicGenerateMaxBudgetUsd(E({ TOPIC_GENERATE_MAX_BUDGET_USD: '' }))).toBe(5.0);
    expect(topicGenerateMaxBudgetUsd(E({ TOPIC_GENERATE_MAX_BUDGET_USD: '10' }))).toBe(10);
    // non-numeric / non-positive falls back to the default, matching aiChatMaxBudgetUsd's shape
    expect(topicGenerateMaxBudgetUsd(E({ TOPIC_GENERATE_MAX_BUDGET_USD: 'abc' }))).toBe(5.0);
    expect(topicGenerateMaxBudgetUsd(E({ TOPIC_GENERATE_MAX_BUDGET_USD: '0' }))).toBe(5.0);
    expect(topicGenerateMaxBudgetUsd(E({ TOPIC_GENERATE_MAX_BUDGET_USD: '-1' }))).toBe(5.0);
  });

  it('topicGenerateTimeoutSec defaults to 600 and is overridable via TOPIC_GENERATE_TIMEOUT_SEC', () => {
    expect(topicGenerateTimeoutSec(E({}))).toBe(600);
    expect(topicGenerateTimeoutSec(E({ TOPIC_GENERATE_TIMEOUT_SEC: '' }))).toBe(600);
    expect(topicGenerateTimeoutSec(E({ TOPIC_GENERATE_TIMEOUT_SEC: '900' }))).toBe(900);
    expect(topicGenerateTimeoutSec(E({ TOPIC_GENERATE_TIMEOUT_SEC: 'abc' }))).toBe(600);
    expect(topicGenerateTimeoutSec(E({ TOPIC_GENERATE_TIMEOUT_SEC: '0' }))).toBe(600);
  });

  it('the topic-generate defaults are no lower than the event-generate defaults (D7)', () => {
    expect(topicGenerateMaxBudgetUsd(E({}))).toBeGreaterThanOrEqual(
      eventGenerateMaxBudgetUsd(E({})),
    );
    expect(topicGenerateTimeoutSec(E({}))).toBeGreaterThanOrEqual(eventGenerateTimeoutSec(E({})));
  });
});

describe('event auto-generation config (design D8: dedicated budget/timeout/cap/bound, sized for the full paged-transcript read)', () => {
  it('eventGenerateMaxBudgetUsd defaults to 5.0 -- equal to topicGenerateMaxBudgetUsd -- and is overridable', () => {
    expect(eventGenerateMaxBudgetUsd(E({}))).toBe(5.0);
    expect(eventGenerateMaxBudgetUsd(E({ EVENT_GENERATE_MAX_BUDGET_USD: '' }))).toBe(5.0);
    expect(eventGenerateMaxBudgetUsd(E({ EVENT_GENERATE_MAX_BUDGET_USD: '10' }))).toBe(10);
    // non-numeric / non-positive falls back to the default, matching topicGenerateMaxBudgetUsd's shape
    expect(eventGenerateMaxBudgetUsd(E({ EVENT_GENERATE_MAX_BUDGET_USD: 'abc' }))).toBe(5.0);
    expect(eventGenerateMaxBudgetUsd(E({ EVENT_GENERATE_MAX_BUDGET_USD: '0' }))).toBe(5.0);
    expect(eventGenerateMaxBudgetUsd(E({ EVENT_GENERATE_MAX_BUDGET_USD: '-1' }))).toBe(5.0);
  });

  it('eventGenerateTimeoutSec defaults to 600 -- equal to topicGenerateTimeoutSec -- and is overridable', () => {
    expect(eventGenerateTimeoutSec(E({}))).toBe(600);
    expect(eventGenerateTimeoutSec(E({ EVENT_GENERATE_TIMEOUT_SEC: '' }))).toBe(600);
    expect(eventGenerateTimeoutSec(E({ EVENT_GENERATE_TIMEOUT_SEC: '900' }))).toBe(900);
    expect(eventGenerateTimeoutSec(E({ EVENT_GENERATE_TIMEOUT_SEC: 'abc' }))).toBe(600);
    expect(eventGenerateTimeoutSec(E({ EVENT_GENERATE_TIMEOUT_SEC: '0' }))).toBe(600);
  });

  it('eventGenerateMaxCreatedEvents defaults to 200 and is overridable via EVENT_GENERATE_MAX_CREATED_EVENTS', () => {
    expect(eventGenerateMaxCreatedEvents(E({}))).toBe(200);
    expect(eventGenerateMaxCreatedEvents(E({ EVENT_GENERATE_MAX_CREATED_EVENTS: '' }))).toBe(200);
    expect(eventGenerateMaxCreatedEvents(E({ EVENT_GENERATE_MAX_CREATED_EVENTS: '50' }))).toBe(50);
    // non-integer / non-positive falls back to the default, matching aiChatMaxConcurrent's shape
    expect(eventGenerateMaxCreatedEvents(E({ EVENT_GENERATE_MAX_CREATED_EVENTS: 'abc' }))).toBe(
      200,
    );
    expect(eventGenerateMaxCreatedEvents(E({ EVENT_GENERATE_MAX_CREATED_EVENTS: '0' }))).toBe(200);
    expect(eventGenerateMaxCreatedEvents(E({ EVENT_GENERATE_MAX_CREATED_EVENTS: '-1' }))).toBe(200);
    expect(eventGenerateMaxCreatedEvents(E({ EVENT_GENERATE_MAX_CREATED_EVENTS: '10.5' }))).toBe(
      200,
    );
  });

  it('eventGenerateMaxInstructionBytes defaults to 24576 and is overridable via EVENT_GENERATE_MAX_INSTRUCTION_BYTES', () => {
    expect(eventGenerateMaxInstructionBytes(E({}))).toBe(24576);
    expect(eventGenerateMaxInstructionBytes(E({ EVENT_GENERATE_MAX_INSTRUCTION_BYTES: '' }))).toBe(
      24576,
    );
    expect(
      eventGenerateMaxInstructionBytes(E({ EVENT_GENERATE_MAX_INSTRUCTION_BYTES: '8192' })),
    ).toBe(8192);
    expect(
      eventGenerateMaxInstructionBytes(E({ EVENT_GENERATE_MAX_INSTRUCTION_BYTES: 'abc' })),
    ).toBe(24576);
    expect(eventGenerateMaxInstructionBytes(E({ EVENT_GENERATE_MAX_INSTRUCTION_BYTES: '0' }))).toBe(
      24576,
    );
    expect(
      eventGenerateMaxInstructionBytes(E({ EVENT_GENERATE_MAX_INSTRUCTION_BYTES: '-1' })),
    ).toBe(24576);
  });

  it('eventGenerateMaxInstructionEntries defaults to 50 and is overridable via EVENT_GENERATE_MAX_INSTRUCTION_ENTRIES', () => {
    expect(eventGenerateMaxInstructionEntries(E({}))).toBe(50);
    expect(
      eventGenerateMaxInstructionEntries(E({ EVENT_GENERATE_MAX_INSTRUCTION_ENTRIES: '' })),
    ).toBe(50);
    expect(
      eventGenerateMaxInstructionEntries(E({ EVENT_GENERATE_MAX_INSTRUCTION_ENTRIES: '10' })),
    ).toBe(10);
    expect(
      eventGenerateMaxInstructionEntries(E({ EVENT_GENERATE_MAX_INSTRUCTION_ENTRIES: 'abc' })),
    ).toBe(50);
    expect(
      eventGenerateMaxInstructionEntries(E({ EVENT_GENERATE_MAX_INSTRUCTION_ENTRIES: '0' })),
    ).toBe(50);
    expect(
      eventGenerateMaxInstructionEntries(E({ EVENT_GENERATE_MAX_INSTRUCTION_ENTRIES: '-1' })),
    ).toBe(50);
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

// owner-bootstrap D8, D16: the bootstrap owner email is matched as exact ASCII, and logged masked.
describe('bootstrap owner email (owner-bootstrap D8, D16)', () => {
  it('bootstrapOwnerEmail trims and ASCII-lowercases', () => {
    expect(bootstrapOwnerEmail(E({ BOOTSTRAP_OWNER_EMAIL: '  Owner@Example.COM \t' }))).toBe(
      'owner@example.com',
    );
    expect(bootstrapOwnerEmail(E({}))).toBe('');
  });
  it('bootstrapEmailMatch refuses a non-ASCII token email and matches ASCII case-insensitively', () => {
    expect(bootstrapEmailMatch('\u212Aalen@gmail.com', 'kalen@gmail.com')).toBe('non-ascii');
    expect(bootstrapEmailMatch(' Kalen@Gmail.com', 'kalen@gmail.com')).toBe(true);
    expect(bootstrapEmailMatch('other@gmail.com', 'kalen@gmail.com')).toBe(false);
    expect(bootstrapEmailMatch('', '')).toBe(false);
  });
  it('maskBootstrapOwnerEmail keeps the domain and an 8-hex hash, never the local part', () => {
    const m = maskBootstrapOwnerEmail('Owner@Example.com');
    expect(m).toContain('example.com');
    expect(m).toMatch(/#[0-9a-f]{8}\b/);
    expect(m.toLowerCase()).not.toContain('owner');
    expect(maskBootstrapOwnerEmail(' owner@example.com ')).toBe(m);
  });
});

describe('AI_PROVIDER (run-status-and-sweeper D1)', () => {
  it('defaults to claude_cli when unset or blank', () => {
    for (const raw of [undefined, '', '   '])
      expect(parseAiProvider(raw), String(raw)).toBe('claude_cli');
  });
  it('accepts claude_cli', () => {
    expect(parseAiProvider('claude_cli')).toBe('claude_cli');
  });
  it('refuses anything else, naming the accepted list and echoing the value', () => {
    expect(() => parseAiProvider('openai')).toThrow(
      'AI_PROVIDER must be one of: claude_cli (got "openai")',
    );
    expect(() => parseAiProvider('Claude_CLI')).toThrow(
      'AI_PROVIDER must be one of: claude_cli (got "Claude_CLI")',
    );
  });
});

// run-status-and-sweeper D9: the run features are limited to the bootstrap owner plus the approved
// list, matched with the bootstrap owner's exact-ASCII rule.
describe('approved users for run features (run-status-and-sweeper D9)', () => {
  const OWNER = 'Owner@Example.com';
  it('runFeatureEmails gives the bootstrap owner alone when the list is unset, blank or all-blank', () => {
    for (const v of [undefined, '', '   ', ',', ' , ,, ']) {
      expect(
        runFeatureEmails(E({ BOOTSTRAP_OWNER_EMAIL: OWNER, RUN_FEATURE_EMAILS: v })),
        JSON.stringify(v),
      ).toEqual(['owner@example.com']);
    }
  });
  it('runFeatureEmails adds a set list after the owner, who stays approved', () => {
    expect(
      runFeatureEmails(E({ BOOTSTRAP_OWNER_EMAIL: OWNER, RUN_FEATURE_EMAILS: 'a@example.com' })),
    ).toEqual(['owner@example.com', 'a@example.com']);
  });
  it('runFeatureEmails splits on commas, trims, drops blanks and duplicates, ASCII-normalizes', () => {
    expect(
      runFeatureEmails(
        E({
          BOOTSTRAP_OWNER_EMAIL: OWNER,
          RUN_FEATURE_EMAILS: ' A@Example.com,, b@example.com ,a@example.com,OWNER@example.COM, ',
        }),
      ),
    ).toEqual(['owner@example.com', 'a@example.com', 'b@example.com']);
  });
  it('runFeatureAllowed matches any entry, folding ASCII case', () => {
    const env = E({ BOOTSTRAP_OWNER_EMAIL: OWNER, RUN_FEATURE_EMAILS: 'Member@Example.com' });
    expect(runFeatureAllowed(env, { email: 'owner@EXAMPLE.com' })).toBe(true);
    expect(runFeatureAllowed(env, { email: ' member@example.COM' })).toBe(true);
    expect(runFeatureAllowed(env, { email: 'other@example.com' })).toBe(false);
    expect(runFeatureAllowed(env, { email: '' })).toBe(false);
  });
  it('runFeatureAllowed never matches a non-ASCII token email (strict === true)', () => {
    const env = E({
      BOOTSTRAP_OWNER_EMAIL: 'kalen@gmail.com',
      RUN_FEATURE_EMAILS: 'kalen@gmail.com',
    });
    expect(runFeatureAllowed(env, { email: '\u212Aalen@gmail.com' })).toBe(false);
  });
  it('runFeatureAllowed is false for everyone when no owner and no list are set', () => {
    expect(runFeatureAllowed(E({}), { email: 'a@example.com' })).toBe(false);
  });
});
