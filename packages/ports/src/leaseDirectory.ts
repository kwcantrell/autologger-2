// LeaseDirectory port (run-status-and-sweeper design D5): cross-session reads and the silent
// expiry delete over `catalog.session_leases`, as a reviewed system task. `@autologger/storage`
// implements it on `bindSystem('lease-directory')`. The transcript status reads the earliest live
// run from it, and the lease sweeper (D6) deletes expired run rows and lists the sessions whose
// recording lease expired. Times are Clock-epoch milliseconds, as `expires_at_ms` stores them.

export interface LeaseDirectory {
  /** The live lease of `kind` (`expires_at_ms > nowMs`) with the earliest `started_at_ms`, ties
   * broken by session id; rows with no `started_at_ms` are skipped. Null when there is none. */
  earliestLiveRun(
    kind: string,
    nowMs: number,
  ): Promise<{ sessionId: string; startedAtMs: number } | null>;
  /** Deletes the expired (`expires_at_ms <= nowMs`) rows of the run kinds only (`ai-turn`,
   * `transcript-generation`, `youtube-import`; an explicit allow-list), silently: no session
   * revision moves. Returns how many rows it deleted. */
  deleteExpiredRunLeases(nowMs: number): Promise<number>;
  /** The session ids of expired recording leases, the longest-expired first, at most `limit`. */
  expiredRecordingSessions(nowMs: number, limit: number): Promise<string[]>;
}
