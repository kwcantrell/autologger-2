/// <reference types="node" />
// Like apiResponseShapes.repo.test.ts, queryKeyFactories.repo.test.ts, and
// noAgentAuthoredMarkup.repo.test.ts, this file needs Node's filesystem APIs
// (walking the whole repo tree from disk); the directive scopes the Node
// global-module types to this file alone rather than widening
// web/tsconfig.json's `types` for the whole workspace.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// --- Cursor adapter closed-world drift guard ---
// (openspec/changes/cursor-sdlc-adapters, design D5; spec requirement "A
// closed-world CI drift guard polices the entire agent surface"; tasks 3.1/3.2)
//
// WHAT THIS EXISTS FOR. The prior `.cursor/` + `AGENTS.md` set was ruled a
// forbidden parallel process rulebook and deleted twice (commits `0a13b54`,
// `ed43b29`): the stock opsx command bodies instructed exactly the behaviors
// the SDLC forbids (inline implementation, gate-skipping "run apply now"),
// and a hand-synced `AGENTS.md` copy of `CLAUDE.md` had already drifted to
// 291 lines. This change reinstates the surface as pointer-only adapters;
// this guard is the CI tripwire that keeps it that way. It is a
// CONSPICUOUSNESS tripwire, not proof of content-freedom — paraphrase,
// splitting rule text across files, and pointer-negating text ("follow the
// skill except…") all pass it. That residue is review-time (design D5,
// "What the guard is NOT").
//
// FOUR CHECKS, per the spec requirement and D5:
//   1. CLOSED WORLD (the load-bearing check): every file actually present
//      under `.cursor/**`, every `AGENTS.md` at any repo depth, and every
//      `.cursorrules` anywhere must be accounted for by an explicit
//      allowlist. An unenumerated file — the recorded evasion channel a
//      nested `AGENTS.md` or a new `.mdc`/command file offers — fails the
//      suite. `.cursor/mcp.json` is the one tolerated UNTRACKED exception
//      (D4): it is gitignored and machine-local, so its presence is
//      expected and it is excluded from the allowlist-membership test, but
//      it is not exempt from being SEEN by the walk (the walk must not
//      silently skip `.cursor/` entirely just because one entry there is
//      untracked).
//   2. Per allowlisted file: exists; <=30 lines AND <=2000 characters,
//      counted over the WHOLE file (frontmatter and blank lines included —
//      a long-line rulebook cannot hide in a short file); contains its
//      mapped path-literal pointer(s) (routing artifacts only —
//      `restart-server-yourself.mdc` is exempt from the pointer check alone
//      per D6/E1; `mcp.json.example` carries no pointer either, since it is
//      config, not routing).
//   3. Banned phrases — the exact strings the pre-drop stock bodies
//      contained verbatim (design D5, fact-check confirmed): "Make the code
//      changes", "Ready for implementation", "to start implementing".
//      Case-sensitive substring, scanned over the whole file including
//      frontmatter.
//   4. D4 assertions: `.gitignore` contains the exact-line entry
//      `.cursor/mcp.json`; `mcp.json.example` contains the exact pinned
//      package-spec literal `@colbymchenry/codegraph@1.5.0`.
//
// Root resolution is `fileURLToPath(import.meta.url)`, matching the other
// three `*.repo.test.ts` guards — no `cwd` or git-subprocess dependency
// (tracking state is asserted textually via `.gitignore` content per D5, not
// via `git ls-files`).
//
// MUTATION-CHECKED, same convention as the precedent guards: the first
// describe block exercises the per-file predicate directly against
// synthetic strings; the second builds a real tmp filesystem tree and runs
// the actual walk against it, proving both that a planted violation is
// caught (not vacuous) and that a clean tree passes (does not always-fire).

const MAX_LINES = 30;
const MAX_CHARS = 2000;

const BANNED_PHRASES = ['Make the code changes', 'Ready for implementation', 'to start implementing'];

/** The exact pinned MCP server package spec (D4: no floating install). */
const MCP_PACKAGE_LITERAL = '@colbymchenry/codegraph@1.5.0';

/** The exact-line `.gitignore` entry that keeps `.cursor/mcp.json` untracked. */
const GITIGNORE_MCP_LINE = '.cursor/mcp.json';

/** The one tolerated UNTRACKED file under `.cursor/`: gitignored, machine-local,
 * expected to be present or absent depending on whether the contributor has
 * localized it from the example (D4). Seen by the walk, excluded from the
 * allowlist-membership and per-file-predicate checks alike — it may contain
 * a real absolute local path, which is the whole point of keeping it untracked. */
const TOLERATED_UNTRACKED = '.cursor/mcp.json';

/** The closed world of COMMITTED files this surface may contain, as paths
 * relative to the repo root (posix separators). Exactly the task brief's
 * allowlist minus the tolerated untracked entry above. */
const COMMITTED_ALLOWLIST = new Set<string>([
  'AGENTS.md',
  '.cursor/rules/openspec-sdlc.mdc',
  '.cursor/rules/restart-server-yourself.mdc',
  '.cursor/commands/opsx/explore.md',
  '.cursor/commands/opsx/propose.md',
  '.cursor/commands/opsx/update.md',
  '.cursor/commands/opsx/sync.md',
  '.cursor/commands/opsx/archive.md',
  '.cursor/commands/opsx/apply.md',
  '.cursor/mcp.json.example',
]);

/** Path-literal pointer(s) each routing artifact must contain (D5 check 2).
 * `restart-server-yourself.mdc` and `.cursor/mcp.json.example` are
 * deliberately absent from this map — the restart rule is pointer-exempt
 * (D6/E1), and the mcp example is config, not a routing pointer. */
const POINTER_MAP: Record<string, readonly string[]> = {
  'AGENTS.md': ['CLAUDE.md'],
  '.cursor/rules/openspec-sdlc.mdc': [
    'CLAUDE.md',
    '.claude/skills/openspec-apply-change/SKILL.md',
    'openspec/config.yaml',
  ],
  '.cursor/commands/opsx/explore.md': ['.claude/skills/openspec-explore/SKILL.md'],
  '.cursor/commands/opsx/propose.md': ['.claude/skills/openspec-propose/SKILL.md'],
  '.cursor/commands/opsx/update.md': ['.claude/skills/openspec-update-change/SKILL.md'],
  '.cursor/commands/opsx/sync.md': ['.claude/skills/openspec-sync-specs/SKILL.md'],
  '.cursor/commands/opsx/archive.md': ['.claude/skills/openspec-archive-change/SKILL.md'],
  '.cursor/commands/opsx/apply.md': ['.claude/skills/openspec-apply-change/SKILL.md'],
};

/** Directory names skipped by the repo-wide `AGENTS.md`/`.cursorrules` walk —
 * generated/vendor trees that would otherwise dwarf the scan and cannot
 * plausibly carry a legitimate agent-surface file. Mirrors the exclusion set
 * `noAgentAuthoredMarkup.repo.test.ts` uses for the same reason. */
const EXCLUDED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.next',
  '.data',
  '.data-oauth',
  'test-results',
  'playwright-report',
  '.playwright-mcp',
  'graphify-out',
]);

// ---------------------------------------------------------------------------
// Filesystem walks
// ---------------------------------------------------------------------------

/** Every file under `dir`, recursively, with NO exclusions — the `.cursor/`
 * walk is over a small, guard-owned tree, so nothing there is assumed to be
 * noise; a stray `node_modules` under `.cursor/` would itself be exactly the
 * kind of unenumerated-file surprise this guard exists to catch. */
function walkAll(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAll(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

/** Every file under `dir`, recursively, skipping `EXCLUDED_DIR_NAMES` — used
 * for the repo-wide `AGENTS.md`/`.cursorrules` search, where generated/vendor
 * trees must not be scanned (and, incidentally, must not be able to shelter a
 * planted violation from the guard). */
function walkSkippingNoise(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      walkSkippingNoise(path.join(dir, entry.name), out);
    } else {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function relOf(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

interface AgentSurface {
  /** `.cursor/**` files, as root-relative posix paths, INCLUDING the tolerated
   * untracked `mcp.json` when present. */
  cursorFiles: string[];
  /** Every `AGENTS.md` found at any repo depth, as root-relative posix paths. */
  agentsFiles: string[];
  /** Every `.cursorrules` found at any repo depth, as root-relative posix paths. */
  cursorrulesFiles: string[];
}

/** The whole scan, parameterized over `root` so it can run against both a
 * synthetic tmp tree (mutation checks below) and the real repo (the actual
 * guard) — the same tree-walking code exercises both, so a mutation-check
 * pass is evidence about the guard, not about a parallel implementation of it. */
function scanAgentSurface(root: string): AgentSurface {
  const cursorDir = path.join(root, '.cursor');
  const cursorFiles = walkAll(cursorDir).map((f) => relOf(root, f));
  const agentsFiles: string[] = [];
  const cursorrulesFiles: string[] = [];
  for (const f of walkSkippingNoise(root)) {
    const base = path.basename(f);
    if (base === 'AGENTS.md') agentsFiles.push(relOf(root, f));
    else if (base === '.cursorrules') cursorrulesFiles.push(relOf(root, f));
  }
  return { cursorFiles, agentsFiles, cursorrulesFiles };
}

// ---------------------------------------------------------------------------
// Predicates (D5 checks 1-3)
// ---------------------------------------------------------------------------

/** Closed-world violations over an already-scanned surface: any `.cursor/**`
 * file not on `COMMITTED_ALLOWLIST` (except the tolerated untracked mcp.json),
 * any missing allowlisted file, any `AGENTS.md` found outside the repo root,
 * and any `.cursorrules` found anywhere. */
function closedWorldViolations(surface: AgentSurface): string[] {
  const out: string[] = [];
  for (const rel of surface.cursorFiles) {
    if (rel === TOLERATED_UNTRACKED) continue;
    if (!COMMITTED_ALLOWLIST.has(rel)) out.push(`unenumerated file under .cursor/: ${rel}`);
  }
  for (const rel of COMMITTED_ALLOWLIST) {
    if (rel.startsWith('.cursor/') && !surface.cursorFiles.includes(rel)) {
      out.push(`missing allowlisted file: ${rel}`);
    }
  }
  const rootAgentsOnly = surface.agentsFiles.filter((f) => f !== 'AGENTS.md');
  for (const f of rootAgentsOnly) out.push(`AGENTS.md found outside repo root: ${f}`);
  if (!surface.agentsFiles.includes('AGENTS.md')) out.push('missing root AGENTS.md');
  for (const f of surface.cursorrulesFiles) out.push(`.cursorrules found (must not exist): ${f}`);
  return out;
}

/** Line count over the WHOLE file (D5 check 2: "counting includes frontmatter
 * and blank lines"). A file ending in a single trailing newline is counted as
 * its visible line count (an editor's convention), not one more. */
function countLines(content: string): number {
  const normalized = content.endsWith('\n') ? content.slice(0, -1) : content;
  return normalized.length === 0 ? 0 : normalized.split('\n').length;
}

/** The per-file predicate (D5 checks 2-3 + the D4 package-literal assertion
 * for `mcp.json.example`): budgets, banned phrases, and mapped pointer(s).
 * Factored out so both the mutation checks below AND the RED-evidence check
 * against the pre-drop stock bodies (task 3.2, run out-of-band — see the
 * `.apply/` ledger, never committed as fixtures here) can call it against an
 * arbitrary string. Returns an empty array when the file is clean. */
function checkAllowlistedFile(relPath: string, content: string): string[] {
  const violations: string[] = [];
  const lines = countLines(content);
  if (lines > MAX_LINES) violations.push(`exceeds line budget: ${lines} > ${MAX_LINES}`);
  if (content.length > MAX_CHARS) violations.push(`exceeds char budget: ${content.length} > ${MAX_CHARS}`);
  for (const phrase of BANNED_PHRASES) {
    if (content.includes(phrase)) violations.push(`contains banned phrase: "${phrase}"`);
  }
  const pointers = POINTER_MAP[relPath];
  if (pointers) {
    for (const p of pointers) {
      if (!content.includes(p)) violations.push(`missing pointer literal: "${p}"`);
    }
  }
  if (relPath === '.cursor/mcp.json.example' && !content.includes(MCP_PACKAGE_LITERAL)) {
    violations.push(`missing package-spec literal: "${MCP_PACKAGE_LITERAL}"`);
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Real repo root
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
// this file: web/src/cursorAdapters.repo.test.ts -> repo root is two levels up.
const REPO_ROOT = path.resolve(here, '..', '..');

// ---------------------------------------------------------------------------
// Mutation checks — prove the predicates actually fire, and don't always-fire
// ---------------------------------------------------------------------------

describe('checkAllowlistedFile predicate (mutation check)', () => {
  it('flags a file over the line budget', () => {
    const content = `${'x\n'.repeat(MAX_LINES + 1)}`;
    expect(checkAllowlistedFile('AGENTS.md', content).some((v) => v.includes('line budget'))).toBe(
      true,
    );
  });

  it('flags a file over the char budget even with few lines', () => {
    const content = `x`.repeat(MAX_CHARS + 1);
    expect(checkAllowlistedFile('AGENTS.md', content).some((v) => v.includes('char budget'))).toBe(
      true,
    );
  });

  it('flags each banned phrase, including inside frontmatter', () => {
    for (const phrase of BANNED_PHRASES) {
      const inBody = checkAllowlistedFile('AGENTS.md', `Some text. ${phrase} more text.`);
      expect(inBody.some((v) => v.includes(phrase))).toBe(true);
      const inFrontmatter = checkAllowlistedFile(
        '.cursor/commands/opsx/explore.md',
        `---\ndescription: ${phrase}\n---\nRead the skill.\n`,
      );
      expect(inFrontmatter.some((v) => v.includes(phrase))).toBe(true);
    }
  });

  it('flags a routing file missing its mapped pointer literal', () => {
    const violations = checkAllowlistedFile('.cursor/commands/opsx/explore.md', 'Read the skill.');
    expect(violations.some((v) => v.includes('openspec-explore/SKILL.md'))).toBe(true);
  });

  it('requires ALL three pointer literals for openspec-sdlc.mdc, not just one', () => {
    const violations = checkAllowlistedFile(
      '.cursor/rules/openspec-sdlc.mdc',
      'See CLAUDE.md for the rules.',
    );
    expect(violations.some((v) => v.includes('openspec-apply-change/SKILL.md'))).toBe(true);
    expect(violations.some((v) => v.includes('openspec/config.yaml'))).toBe(true);
  });

  it('does NOT require a pointer literal for the pointer-exempt restart rule (D6/E1)', () => {
    const violations = checkAllowlistedFile(
      '.cursor/rules/restart-server-yourself.mdc',
      'Ask first before restarting anything.',
    );
    expect(violations).toEqual([]);
  });

  it('flags mcp.json.example missing the pinned package-spec literal', () => {
    const violations = checkAllowlistedFile('.cursor/mcp.json.example', '{"mcpServers": {}}');
    expect(violations.some((v) => v.includes(MCP_PACKAGE_LITERAL))).toBe(true);
  });

  it('passes a clean, in-budget, pointer-bearing, phrase-free file', () => {
    const violations = checkAllowlistedFile(
      '.cursor/commands/opsx/explore.md',
      'Read the full file `.claude/skills/openspec-explore/SKILL.md` and follow it.\n',
    );
    expect(violations).toEqual([]);
  });
});

describe('scanAgentSurface + closedWorldViolations (mutation check on a real filesystem tree)', () => {
  let tmpRoot: string;

  const CLEAN_FILES: Record<string, string> = {
    'AGENTS.md': 'CLAUDE.md is normative.\n',
    '.cursor/rules/openspec-sdlc.mdc': 'CLAUDE.md .claude/skills/openspec-apply-change/SKILL.md openspec/config.yaml\n',
    '.cursor/rules/restart-server-yourself.mdc': 'Ask first.\n',
    '.cursor/commands/opsx/explore.md': '.claude/skills/openspec-explore/SKILL.md\n',
    '.cursor/commands/opsx/propose.md': '.claude/skills/openspec-propose/SKILL.md\n',
    '.cursor/commands/opsx/update.md': '.claude/skills/openspec-update-change/SKILL.md\n',
    '.cursor/commands/opsx/sync.md': '.claude/skills/openspec-sync-specs/SKILL.md\n',
    '.cursor/commands/opsx/archive.md': '.claude/skills/openspec-archive-change/SKILL.md\n',
    '.cursor/commands/opsx/apply.md': '.claude/skills/openspec-apply-change/SKILL.md\n',
    '.cursor/mcp.json.example': `{"pkg":"${MCP_PACKAGE_LITERAL}"}\n`,
  };

  function writeTree(root: string, files: Record<string, string>) {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }

  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('a clean tree matching the allowlist exactly produces zero closed-world violations', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-guard-clean-'));
    writeTree(tmpRoot, CLEAN_FILES);
    const surface = scanAgentSurface(tmpRoot);
    expect(closedWorldViolations(surface)).toEqual([]);
  });

  it('DOES flag an unenumerated file under .cursor/ (proves the closed-world check is not vacuous)', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-guard-evil-'));
    writeTree(tmpRoot, { ...CLEAN_FILES, '.cursor/rules/evil.mdc': 'do whatever\n' });
    const violations = closedWorldViolations(scanAgentSurface(tmpRoot));
    expect(violations.some((v) => v.includes('evil.mdc'))).toBe(true);
  });

  it('DOES flag a nested AGENTS.md outside the repo root', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-guard-nested-agents-'));
    writeTree(tmpRoot, { ...CLEAN_FILES, 'server/src/AGENTS.md': 'a stray copy\n' });
    const violations = closedWorldViolations(scanAgentSurface(tmpRoot));
    expect(violations.some((v) => v.includes('AGENTS.md found outside repo root'))).toBe(true);
  });

  it('DOES flag any .cursorrules file, anywhere', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-guard-cursorrules-'));
    writeTree(tmpRoot, { ...CLEAN_FILES, '.cursorrules': 'legacy rules\n' });
    const violations = closedWorldViolations(scanAgentSurface(tmpRoot));
    expect(violations.some((v) => v.includes('.cursorrules found'))).toBe(true);
  });

  it('DOES flag a missing allowlisted file', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-guard-missing-'));
    const { 'AGENTS.md': _omit, ...rest } = CLEAN_FILES;
    void _omit;
    writeTree(tmpRoot, rest);
    const violations = closedWorldViolations(scanAgentSurface(tmpRoot));
    expect(violations.some((v) => v.includes('missing root AGENTS.md'))).toBe(true);
  });

  it('tolerates the untracked .cursor/mcp.json without flagging it (D4)', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-guard-mcp-json-'));
    writeTree(tmpRoot, {
      ...CLEAN_FILES,
      '.cursor/mcp.json': '{"mcpServers":{"codegraph":{"args":["--path","/home/someone/checkout"]}}}\n',
    });
    const surface = scanAgentSurface(tmpRoot);
    expect(surface.cursorFiles).toContain('.cursor/mcp.json');
    expect(closedWorldViolations(surface)).toEqual([]);
  });

  it('skips generated/vendor directories when hunting for AGENTS.md/.cursorrules', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-guard-noise-'));
    writeTree(tmpRoot, {
      ...CLEAN_FILES,
      'web/node_modules/some-pkg/AGENTS.md': 'vendored, not ours\n',
      'server/dist/AGENTS.md': 'build output, not ours\n',
    });
    const surface = scanAgentSurface(tmpRoot);
    expect(surface.agentsFiles).toEqual(['AGENTS.md']);
  });
});

// ---------------------------------------------------------------------------
// The real guard
// ---------------------------------------------------------------------------

describe('cursor adapter surface — closed world (spec: "A closed-world CI drift guard polices the entire agent surface")', () => {
  it('contains exactly the allowlisted files, no more, no less (tolerating untracked mcp.json)', () => {
    const surface = scanAgentSurface(REPO_ROOT);
    expect(closedWorldViolations(surface)).toEqual([]);
  });
});

describe('cursor adapter surface — per-file budgets, pointers, and banned phrases', () => {
  for (const relPath of COMMITTED_ALLOWLIST) {
    it(`${relPath}: within budget, pointer(s) present, no banned phrase`, () => {
      const full = path.join(REPO_ROOT, ...relPath.split('/'));
      expect(fs.existsSync(full)).toBe(true);
      const content = fs.readFileSync(full, 'utf8');
      expect(checkAllowlistedFile(relPath, content)).toEqual([]);
    });
  }
});

describe('cursor adapter surface — MCP config portability (D4)', () => {
  it('.gitignore contains the exact-line entry ".cursor/mcp.json"', () => {
    const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    const lines = gitignore.split('\n').map((l) => l.trim());
    expect(lines).toContain(GITIGNORE_MCP_LINE);
  });
});
