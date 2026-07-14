// Seeded-session harness fixture (teams-self-serve, task 7.1; design/panel S2:
// "TEST-SIDE ONLY, no server surface, no auth backdoor").
//
// Opens the hermetic chromium project's catalog.db DIRECTLY with a second
// better-sqlite3 connection (same file the running server holds open at
// DATA_DIR/catalog.db — server/src/node/config.ts) and writes a user row +
// hashed login-session KV row, mirroring the real shapes byte-for-byte:
//   - user row shape:        authCreateUserGoogle (server/src/db/authStore.ts)
//   - prefs row shape:       authSeedPrefsFromGlobals (same file)
//   - membership row shape:  authAddMembershipWithRole (same file)
//   - KV session row shape:  createLoginSession (server/src/auth/identity.ts)
//     — session:<sha256hex(rawToken)> -> userId, expires_at in epoch ms
//     (server/src/node/kvStore.ts KvStore.put)
// A Playwright BrowserContext then gets the raw token injected as the login
// cookie (name/flags mirrored from the OAuth callback's setCookie() call in
// server/src/routers/auth.ts) via `injectSessionCookie`.
//
// WAL concurrency (empirically verified): the server opens catalog.db with
// `journal_mode = WAL` + `busy_timeout = 5000` (server/src/node/migrate.ts
// openCatalogDb) and keeps ONE connection open for its whole lifetime. A
// second short-lived connection from the test process, opened with the same
// two pragmas, writes + commits + closes well inside that 5s budget; WAL
// readers (the server's connection) see the commit on their very next query.
// This is the ordinary multi-connection SQLite story, not a race, at the
// trivial write volume a handful of e2e specs produce — direct writes WHILE
// the server is running proved reliable, so no globalSetup pre-boot seeding
// was needed.
//
// This module deliberately duplicates small primitives (randomToken,
// sha256Hex, the cookie name/session-KV-prefix constants) from
// server/src/auth/identity.ts + server/src/env.ts rather than importing them:
// e2e/ is a separate, non-workspace test root (see tsconfig.json), and the
// point of a TEST-SIDE fixture is that it has no reach into server internals
// beyond direct SQLite access to the same on-disk file the server itself
// writes to.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext } from '@playwright/test';
import Database from 'better-sqlite3';

const SESSION_KV_PREFIX = 'session:'; // mirrors server/src/auth/identity.ts SESSION_PREFIX
const COOKIE_NAME = 'autologger_sid'; // mirrors env.ts sessionCookieName() default (unset SESSION_COOKIE)
const SESSION_TTL_DAYS = 14; // mirrors env.ts sessionTtlDays() default (unset SESSION_DAYS)

/** The chromium project's webServer DATA_DIR (playwright.config.ts:
 * `join(here, 'e2e', '.data')` where `here` is the repo root — this file
 * lives IN e2e/, so its own dirname already lands on the same directory). */
export const CHROMIUM_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '.data');

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Mirrors auth/identity.ts randomToken() exactly (base64url, no padding). */
function randomToken(nbytes: number): string {
  const buf = new Uint8Array(nbytes);
  crypto.getRandomValues(buf);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface SeededMembership {
  studioId: string;
  role?: 'admin' | 'member';
}

export interface SeedSessionOptions {
  /** Absolute path to the hermetic server's DATA_DIR (playwright.config.ts's
   * chromium webServer entry's `env.DATA_DIR`). */
  dataDir: string;
  /** Folded into the seeded email/google_sub so parallel spec files/workers
   * never collide on the users.google_sub UNIQUE constraint. */
  label: string;
  /** Zero or more studio memberships to grant atomically with the user row —
   * omit entirely to seed a zero-membership (onboarding) user. */
  memberships?: SeededMembership[];
}

export interface SeededSession {
  /** Raw bearer token — pass to injectSessionCookie. Never persisted as-is
   * (only its SHA-256 hash lands in the kv table, matching createLoginSession). */
  token: string;
  userId: string;
  email: string;
}

/** Seed a user (+ optional memberships/prefs) and a hashed login-session KV
 * row directly into the hermetic server's catalog.db. Test-side only. */
export async function seedSession(opts: SeedSessionOptions): Promise<SeededSession> {
  const db = new Database(join(opts.dataDir, 'catalog.db'));
  try {
    // Same pragmas the server itself sets (migrate.ts openCatalogDb) — WAL is
    // a persistent on-disk setting so it's already active from the server's
    // own connection, but busy_timeout is per-connection and matters here.
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');

    const userId = crypto.randomUUID();
    const googleSub = `e2e-${opts.label}-${userId}`;
    const email = `e2e-${opts.label}-${userId}@example.invalid`;
    const nowIso = new Date().toISOString();

    const memberships = opts.memberships ?? [];

    db.transaction(() => {
      db.prepare(
        `INSERT INTO users (id, google_sub, email, given_name, family_name, picture_url, created_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(userId, googleSub, email, 'E2E', 'User', '', nowIso);

      for (const m of memberships) {
        db.prepare(
          'INSERT OR IGNORE INTO user_studio_memberships (user_id, studio_id, role) VALUES (?, ?, ?)',
        ).run(userId, m.studioId, m.role ?? 'member');
      }

      // authSeedPrefsFromGlobals equivalent. A zero-membership user gets an
      // empty prefs row (profileStudioForUser short-circuits on an empty
      // allowed-set before ever reading it); a user with a granted membership
      // gets it as the active studio, mirroring a fresh sign-in's seeded
      // default.
      const activeStudioId = memberships[0]?.studioId ?? '';
      db.prepare(
        'INSERT INTO user_prefs (user_id, active_studio_id, active_show_id) VALUES (?, ?, ?)',
      ).run(userId, activeStudioId, '');
    })();

    const rawToken = randomToken(48);
    const hash = await sha256Hex(rawToken);
    const ttlMs = Math.max(60, Math.floor(SESSION_TTL_DAYS * 86400)) * 1000;
    db.prepare(
      `INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
    ).run(`${SESSION_KV_PREFIX}${hash}`, userId, Date.now() + ttlMs);

    return { token: rawToken, userId, email };
  } finally {
    db.close();
  }
}

/** Inject the seeded session as the login cookie into a fresh browser
 * context, before any navigation. Flags mirror the OAuth callback's
 * setCookie() call (server/src/routers/auth.ts): httpOnly, sameSite=Lax,
 * path=/. `secure` is always false here — the hermetic servers are plain
 * http://127.0.0.1 with no COOKIE_SECURE/TRUST_PROXY set, and
 * cookieSecureForRequest() (server/src/env.ts) computes false for that
 * origin too, so a Secure cookie would simply never be sent back. */
export async function injectSessionCookie(
  context: BrowserContext,
  baseURL: string,
  token: string,
): Promise<void> {
  const url = new URL(baseURL);
  await context.addCookies([
    {
      name: COOKIE_NAME,
      value: token,
      domain: url.hostname,
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
}
