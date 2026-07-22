// youtube-audio-import (design D8, task 5.2) — the two-axis concurrency guard
// the youtube-import route handler (task 5.3) acquires before spawning
// `yt-dlp`. Two distinct bounds, both checked before either is claimed:
//   - per-session single-flight: at most one import run per session at a
//     time (an in-process Set keyed by session id), and
//   - a global concurrency ceiling: an aggregate cap on in-flight import
//     runs across ALL sessions (mirroring the aiChatMaxConcurrent precedent
//     in `server/src/env.ts` / `aiChatRegistry.ts` — same shape, but a
//     DELIBERATELY SEPARATE registry: youtube-import concurrency is its own
//     resource axis from AI-chat/AI-v2 turn concurrency, so the two paid/
//     resource-bounded features don't share a slot pool).
//
// Ceiling default: this module defines its own constant
// (YOUTUBE_IMPORT_MAX_CONCURRENT = 2), NOT a new env var. Nothing in the
// gated spec/design calls for operator-tunable import concurrency, so a
// module constant is the YAGNI choice — an env knob can be added later if a
// real deployment needs it, mirroring how `aiChatMaxConcurrent` reads
// AI_CHAT_MAX_CONCURRENT.
//
// API shape (matches task 5.2's guidance so 5.3's call site is exactly
// `const lease = youtubeImportGuard.tryAcquire(sessionId); if (!lease) return
// 409; try { ... } finally { lease.release(); }` — the acquire is the single
// statement directly before the try, nothing throwable in between):
//   - tryAcquire(sessionId) returns a `YoutubeImportLease` (an idempotent
//     `release()`) on success, or `null` if either bound is already hit.
//   - `release()` is idempotent: a double-release is a no-op, never
//     underflows the global count or re-frees an already-free session slot.
//   - `isSessionInFlight(sessionId)` lets the caller (5.3) distinguish the
//     two 409 causes for its `{detail}` message without a second acquire
//     attempt.
//
// Module-level singleton (single Node process, no clustering — CLAUDE.md);
// a plain Set + counter is correct, no external coordination needed.

/** An acquired concurrency slot. `release()` is safe to call more than
 * once — only the first call frees anything. */
export interface YoutubeImportLease {
  release: () => void;
}

/** Aggregate cap on concurrent youtube-import runs across all sessions
 * (design D8 "global concurrency ceiling"), mirroring the small default
 * `aiChatMaxConcurrent` uses (2) — see module header for why this is a
 * constant rather than a new env var. */
export const YOUTUBE_IMPORT_MAX_CONCURRENT = 2;

class YoutubeImportGuard {
  private readonly inflightSessions = new Set<string>();
  private globalCount = 0;

  /** Atomically claim an import slot for `sessionId`. Per-session
   * single-flight is checked before the global ceiling. Returns `null`
   * (caller 409s, spawns nothing) if the session already has a run
   * in-flight OR the global ceiling is already reached; otherwise marks
   * both the session and the global count in-flight and returns a lease
   * whose `release()` clears both. */
  tryAcquire(sessionId: string, maxConcurrent: number = YOUTUBE_IMPORT_MAX_CONCURRENT): YoutubeImportLease | null {
    if (this.inflightSessions.has(sessionId)) return null;
    if (this.globalCount >= maxConcurrent) return null;
    this.inflightSessions.add(sessionId);
    this.globalCount += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.inflightSessions.delete(sessionId);
      this.globalCount -= 1;
    };
    return { release };
  }

  /** Whether `sessionId` currently has an import run in flight — lets the
   * route handler (5.3) pick the right 409 `{detail}` message without a
   * second `tryAcquire` call. */
  isSessionInFlight(sessionId: string): boolean {
    return this.inflightSessions.has(sessionId);
  }

  /** In-flight run count across all sessions (introspection / tests). */
  get activeCount(): number {
    return this.globalCount;
  }

  /** Test-only: drop all slots so the shared module singleton doesn't leak
   * state across test cases. Never called on a request path. */
  reset(): void {
    this.inflightSessions.clear();
    this.globalCount = 0;
  }
}

/** Process-wide singleton the youtube-import route handler (5.3) acquires
 * against. */
export const youtubeImportGuard = new YoutubeImportGuard();
