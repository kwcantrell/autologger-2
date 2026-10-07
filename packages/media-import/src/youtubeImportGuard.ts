// youtube-audio-import (design D8, task 5.2) — the concurrency guard the
// youtube-import route handler acquires before spawning `yt-dlp`: per-session
// single-flight, at most one import run per session at a time (an in-process
// Set keyed by session id). It is a DELIBERATELY SEPARATE registry from the
// AI turn registry: youtube-import concurrency is its own resource axis.
// There is no global ceiling: run-status-and-sweeper D2 removed
// YOUTUBE_IMPORT_MAX_CONCURRENT (owner decision 2).
//
// API shape (the route's call site is exactly
// `const lease = youtubeImportGuard.tryAcquire(sessionId); if (!lease) return
// 409; try { ... } finally { lease.release(); }` — the acquire is the single
// statement directly before the try, nothing throwable in between):
//   - tryAcquire(sessionId) returns a `YoutubeImportLease` (an idempotent
//     `release()`) on success, or `null` if the session already has a run.
//   - `release()` is idempotent: a double-release is a no-op, never re-frees
//     an already-free session slot.
//   - `isSessionInFlight(sessionId)` lets the caller inspect the session slot
//     without a second acquire attempt.
//
// Module-level singleton (one per Node process); cross-process exclusion is
// the session lease the route claims after this check.

/** An acquired concurrency slot. `release()` is safe to call more than
 * once — only the first call frees anything. */
export interface YoutubeImportLease {
  release: () => void;
}

class YoutubeImportGuard {
  private readonly inflightSessions = new Set<string>();

  /** Atomically claim an import slot for `sessionId`. Returns `null` (caller
   * 409s, spawns nothing) if the session already has a run in flight;
   * otherwise marks the session in flight and returns a lease whose
   * `release()` clears it. */
  tryAcquire(sessionId: string): YoutubeImportLease | null {
    if (this.inflightSessions.has(sessionId)) return null;
    this.inflightSessions.add(sessionId);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.inflightSessions.delete(sessionId);
    };
    return { release };
  }

  /** Whether `sessionId` currently has an import run in flight. */
  isSessionInFlight(sessionId: string): boolean {
    return this.inflightSessions.has(sessionId);
  }

  /** In-flight run count across all sessions (introspection / tests). */
  get activeCount(): number {
    return this.inflightSessions.size;
  }

  /** Test-only: drop all slots so the shared module singleton doesn't leak
   * state across test cases. Never called on a request path. */
  reset(): void {
    this.inflightSessions.clear();
  }
}

/** Process-wide singleton the youtube-import route handler acquires against. */
export const youtubeImportGuard = new YoutubeImportGuard();
