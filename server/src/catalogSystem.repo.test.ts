import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// --- System catalog bindings are reviewed (catalog-roles design D11) ---
// (core-ports-architecture "Every catalog call is bound to a caller": "System reasons are
// reviewed".)
//
// Every `.system('<reason>')` / `.bindSystem('<reason>')` call in production sources of
// `server/src` and `packages/*/src` must name its reason as a single-quoted string literal, and
// the set of `{ file, reason }` pairs must equal ALLOWLIST below in both directions: a new call
// site, a new reason or a reason moved to another file fails as unlisted, and an entry no longer
// used fails as stale. `.forUser(` / `.bindUser(` may appear only in the auth middleware.
//
// The implementing modules (the catalog facade, the Postgres adapter and the session storage over
// it) are exempt: they define the bindings and forward the caller's reason or handle. Tests are
// exempt (`*.test.ts`, `**/test/**`).
//
// LIMITS (stated, not papered over): this is a textual scan. An alias (`const s = c.system;
// s('x')`), a computed member (`c['system']('x')`) or a dynamic import slips past it. The
// database's refusal of the bare login role is the backstop. The scan function is
// mutation-checked against synthetic trees below, so it cannot silently go vacuous.

const ALLOWLIST: readonly { file: string; reason: string; why: string }[] = [
  {
    file: 'server/src/middleware/auth.ts',
    reason: 'auth-resolve',
    why: 'resolves the caller (user read) and loads the registry before a user is known',
  },
  {
    file: 'server/src/node/config.ts',
    reason: 'kv',
    why: 'login sessions, OAuth state, the Companion last command and the expiry purges',
  },
  {
    file: 'server/src/node/config.ts',
    reason: 'session-mirror',
    why: "the mirror's session-index writes, outside any request",
  },
  {
    file: 'server/src/node/config.ts',
    reason: 'session-hub',
    why: 'every session hub statement, until slice 7b-2 binds hub calls to their caller',
  },
  { file: 'server/src/main.ts', reason: 'boot-wait', why: 'the boot-time readiness wait' },
  {
    file: 'server/src/routers/logImport.ts',
    reason: 'log-import-job',
    why: 'the detached job outlives its request; it re-checks the creator per sheet',
  },
  {
    file: 'server/src/routers/auth.ts',
    reason: 'oauth-callback',
    why: 'user lookup, creation and profile update before a session exists',
  },
  {
    file: 'server/src/routers/auth.ts',
    reason: 'bootstrap-claim',
    why: 'the bootstrap owner claims every ownerless team',
  },
  {
    file: 'server/src/routers/admin.ts',
    reason: 'support-plane',
    why: '/api/admin/*, after the ADMIN_TOKEN check',
  },
  {
    file: 'server/src/routers/companion.ts',
    reason: 'companion-token',
    why: 'token-only Companion calls (no user) until the slice 9 credential',
  },
  {
    file: 'server/src/routers/_helpers.ts',
    reason: 'access-loss-check',
    why: "reads another user's access after a committed access loss",
  },
  {
    file: 'server/src/routers/teams.ts',
    reason: 'team-invite',
    why: 'the invite transaction looks users up by email and adds their memberships',
  },
  {
    file: 'server/src/routers/teams.ts',
    reason: 'team-create',
    why: "the create transaction purges a recreated team's leftover rows",
  },
];

const IMPLEMENTING = new Set([
  'packages/catalog/src/catalog.ts',
  'packages/storage/src/postgresCatalogStore.ts',
  'packages/storage/src/postgresSessionSql.ts',
]);
const USER_BINDERS = new Set(['server/src/middleware/auth.ts']);
const REASON_LITERAL = /^'[a-z][a-z0-9-]*'$/;

interface ScanResult {
  /** `{ file, reason }` of every literal system binding. */
  system: { file: string; reason: string }[];
  /** System bindings whose reason is not a single-quoted literal. */
  nonLiteral: { file: string; arg: string }[];
  /** `.forUser(` / `.bindUser(` outside the auth middleware. */
  strayUser: string[];
}

function productionFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === 'test') continue;
        walk(full);
      } else if (
        ent.name.endsWith('.ts') &&
        !ent.name.endsWith('.test.ts') &&
        !ent.name.endsWith('.d.ts')
      ) {
        out.push(path.relative(repoRoot, full).split(path.sep).join('/'));
      }
    }
  };
  walk(path.join(repoRoot, 'server/src'));
  const pkgs = path.join(repoRoot, 'packages');
  if (fs.existsSync(pkgs)) {
    for (const p of fs.readdirSync(pkgs)) walk(path.join(pkgs, p, 'src'));
  }
  return out.sort();
}

function scanCatalogBindings(repoRoot: string): ScanResult {
  const result: ScanResult = { system: [], nonLiteral: [], strayUser: [] };
  for (const file of productionFiles(repoRoot)) {
    // The implementing modules forward the caller's reason (a variable) and define the user
    // binders, so only those two are exempt there; a literal system reason in them still counts.
    const implementing = IMPLEMENTING.has(file);
    const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    for (const m of text.matchAll(/\.(?:system|bindSystem)\(([^),]*)/g)) {
      const arg = (m[1] ?? '').trim();
      if (REASON_LITERAL.test(arg)) result.system.push({ file, reason: arg.slice(1, -1) });
      else if (!implementing) result.nonLiteral.push({ file, arg });
    }
    if (/\.(?:forUser|bindUser)\(/.test(text) && !USER_BINDERS.has(file) && !implementing) {
      result.strayUser.push(file);
    }
  }
  return result;
}

const key = (e: { file: string; reason: string }) => `${e.file} ${e.reason}`;

/** The allowlist comparison, both directions. */
function compareWithAllowlist(
  found: { file: string; reason: string }[],
  allow: readonly { file: string; reason: string }[],
): { unlisted: string[]; stale: string[] } {
  const f = new Set(found.map(key));
  const a = new Set(allow.map(key));
  return {
    unlisted: [...f].filter((k) => !a.has(k)).sort(),
    stale: [...a].filter((k) => !f.has(k)).sort(),
  };
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('system catalog bindings are reviewed (catalog-roles D11)', () => {
  it('every system binding in production code is on the allowlist, and every entry is used', () => {
    const r = scanCatalogBindings(REPO);
    expect(r.nonLiteral, 'system bindings whose reason is not a string literal').toEqual([]);
    expect(compareWithAllowlist(r.system, ALLOWLIST)).toEqual({ unlisted: [], stale: [] });
  });

  it('only the auth middleware binds a user', () => {
    expect(scanCatalogBindings(REPO).strayUser).toEqual([]);
  });

  it('every allowlist entry says why', () => {
    for (const e of ALLOWLIST) expect(e.why.length, key(e)).toBeGreaterThan(10);
  });
});

describe('the scan is mutation-checked against synthetic trees (catalog-roles D11)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function tree(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-system-scan-'));
    dirs.push(root);
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    return root;
  }
  const allow = [{ file: 'server/src/a.ts', reason: 'job-a' }];

  it('a compliant tree passes', () => {
    const root = tree({
      'server/src/a.ts': "const x = c.get('catalog').system('job-a');\n",
      'server/src/middleware/auth.ts': "c.set('catalog', sys.forUser(user.id));\n",
      'server/src/a.test.ts': "cat.system(someVar); cat.forUser('u');\n",
      'server/src/test/helpers.ts': "cat.system('test-seed');\n",
      'packages/catalog/src/catalog.ts': 'return root.bindSystem(reason);\n',
    });
    const r = scanCatalogBindings(root);
    expect(r).toEqual({
      system: [{ file: 'server/src/a.ts', reason: 'job-a' }],
      nonLiteral: [],
      strayUser: [],
    });
    expect(compareWithAllowlist(r.system, allow)).toEqual({ unlisted: [], stale: [] });
  });

  it('a literal system reason inside an implementing module still counts', () => {
    const root = tree({
      'packages/catalog/src/catalog.ts':
        "return root.bindSystem(reason);\nroot.bindSystem('hidden');\n",
    });
    expect(scanCatalogBindings(root)).toEqual({
      system: [{ file: 'packages/catalog/src/catalog.ts', reason: 'hidden' }],
      nonLiteral: [],
      strayUser: [],
    });
  });

  it('an unlisted reason fails, naming the file and the reason', () => {
    const root = tree({
      'server/src/a.ts': "cat.system('job-a'); root.bindSystem('sneaky');\n",
    });
    expect(compareWithAllowlist(scanCatalogBindings(root).system, allow)).toEqual({
      unlisted: ['server/src/a.ts sneaky'],
      stale: [],
    });
  });

  it('a reason moved to another file fails both ways', () => {
    const root = tree({ 'packages/x/src/b.ts': "cat.system('job-a');\n" });
    expect(compareWithAllowlist(scanCatalogBindings(root).system, allow)).toEqual({
      unlisted: ['packages/x/src/b.ts job-a'],
      stale: ['server/src/a.ts job-a'],
    });
  });

  it('a variable reason is a violation', () => {
    const root = tree({ 'server/src/a.ts': 'cat.system(reason);\ncat.system(`job-a`);\n' });
    expect(scanCatalogBindings(root).nonLiteral).toEqual([
      { file: 'server/src/a.ts', arg: 'reason' },
      { file: 'server/src/a.ts', arg: '`job-a`' },
    ]);
  });

  it('a stale entry fails', () => {
    const root = tree({ 'server/src/a.ts': 'export const nothing = 1;\n' });
    expect(compareWithAllowlist(scanCatalogBindings(root).system, allow)).toEqual({
      unlisted: [],
      stale: ['server/src/a.ts job-a'],
    });
  });

  it('a stray forUser or bindUser fails', () => {
    const root = tree({
      'server/src/routers/x.ts': "c.get('catalog').forUser(id);\n",
      'packages/y/src/z.ts': 'root.bindUser(id);\n',
    });
    expect(scanCatalogBindings(root).strayUser).toEqual([
      'packages/y/src/z.ts',
      'server/src/routers/x.ts',
    ]);
  });
});
