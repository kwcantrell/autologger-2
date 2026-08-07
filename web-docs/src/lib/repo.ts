// Shared repo-inspection helpers: git-tracked-file enumeration + glob
// matching. Preassigned home (phase-2 orchestrator directive) — later
// phases (edge extraction §3, overlay extraction §5) import from here rather
// than re-implementing tracked-file enumeration or path matching.
//
// Determinism (design.md D8 / spec "Builds are deterministic and offline"):
// listTrackedFiles always returns a sorted array, and resolves the repo root
// via `git rev-parse --show-toplevel` so results are identical regardless of
// the invoking process's cwd (npm workspace scripts run with cwd = the
// workspace directory, not the repo root).
import { execFileSync } from 'node:child_process';

export interface ListTrackedFilesOptions {
  /** Directory to resolve the repo root from. Defaults to process.cwd(). */
  cwd?: string;
  /**
   * When given, only files whose path ends with one of these suffixes are
   * returned (e.g. ['.ts', '.tsx']). Omit to return every tracked file.
   */
  extensions?: string[];
}

/** Resolves the absolute path to the repo root via `git rev-parse --show-toplevel`. */
export function repoRoot(cwd: string = process.cwd()): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

/**
 * Enumerates git-tracked files as repo-relative paths, sorted, optionally
 * filtered by extension. Always resolves from the repo root regardless of
 * the calling process's cwd.
 */
export function listTrackedFiles(options: ListTrackedFilesOptions = {}): string[] {
  const root = repoRoot(options.cwd);
  const output = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  const files = output.split('\n').filter((line) => line.length > 0);
  const filtered = options.extensions
    ? files.filter((file) => options.extensions?.some((ext) => file.endsWith(ext)))
    : files;
  return [...filtered].sort();
}

function escapeRegExp(segment: string): string {
  return segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches a repo-relative file path against a single glob pattern.
 *
 * Supported forms (deliberately minimal — the model only needs these):
 *  - exact path: "server/src/app.ts"
 *  - directory-recursive: "server/src/db/**" — matches every path under
 *    "server/src/db/" (not the directory string itself)
 *  - single '*' wildcards, matched non-greedily against a single path
 *    segment (no '/' crossing) — e.g. "web/src/*.repo.test.ts"
 */
export function matchesGlob(filePath: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    const dir = pattern.slice(0, -3);
    return filePath === dir || filePath.startsWith(`${dir}/`);
  }
  if (pattern.includes('*')) {
    const regexSource = pattern.split('*').map(escapeRegExp).join('[^/]*');
    return new RegExp(`^${regexSource}$`).test(filePath);
  }
  return filePath === pattern;
}

/** True when `filePath` matches at least one pattern in `patterns`. */
export function matchesAnyGlob(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesGlob(filePath, pattern));
}
