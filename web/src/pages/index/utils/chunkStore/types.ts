/**
 * Shared shapes of the browser chunk store (media-worker design D10; spec live-recording-chunks
 * "Finished chunks are persisted locally until the server confirms them").
 *
 * A stored entry is one manifest plus (for chunks) its bytes. Two kinds share the record shape:
 * `chunk` (a recorded chunk, complete or partial) and `finalize` (a stopped recording whose
 * `POST …/finalize` has not been confirmed yet, design D6/D11: it outlives its last chunk).
 */

/** One appended timeslice: when it was written (epoch ms) and how many bytes it carried. */
export interface SliceLogEntry {
  at: number;
  bytes: number;
}

export type StoredEntryKind = 'chunk' | 'finalize';

export interface ChunkManifest {
  kind: StoredEntryKind;
  id: string;
  userId: string;
  sessionId: string;
  recordingOrdinal: number;
  /** 0-based capture index within the recording (`-1` on a finalize record). */
  chunkIndex: number;
  startedAtUtc: string;
  /** Set when the chunk is finalized (complete); `null` while it is still being captured. */
  endedAtUtc: string | null;
  mimeType: string;
  /** Bytes recorded in the slice log (the trustworthy prefix of the stored bytes). */
  bytes: number;
  sliceLog: SliceLogEntry[];
  /** True once the recorder stopped this chunk (rollover, stop or a lost microphone). */
  finalized: boolean;
  /**
   * The recording's chunk windows (`started_at_utc` of every chunk with bytes) known when this
   * entry was last written; on a finalize record, the list `POST …/finalize` sends. A crash
   * recovery finalizes the recording with the newest chunk's list.
   */
  pendingFinalize: string[] | null;
  createdAt: number;
  updatedAt: number;
  /** Refreshed by the owner; the 30 s lease where Web Locks are unavailable (design D10). */
  heartbeatAt: number;
  /** Written by Safari, which evicts a site's storage after 7 days without use (ITP). */
  safari: boolean;
}

export type BackendKind = 'opfs' | 'idb' | 'memory';

/**
 * One storage backend, per user. Every method takes the user id: the layout is
 * `autologger-chunks/<userId>/…` and nothing reads across users.
 */
export interface ChunkBackend {
  readonly kind: BackendKind;
  /** A real write, read back and delete; throws when this backend cannot store a chunk here. */
  probe(): Promise<void>;
  /** Create (or overwrite) an entry's manifest with no bytes. */
  create(userId: string, manifest: ChunkManifest): Promise<void>;
  /** Append bytes to an entry, then write its manifest (bytes first, so the log never lies). */
  append(userId: string, manifest: ChunkManifest, bytes: Blob): Promise<void>;
  writeManifest(userId: string, manifest: ChunkManifest): Promise<void>;
  /** The entry's bytes, cut at `maxBytes` when given. */
  read(userId: string, id: string, mimeType: string, maxBytes?: number): Promise<Blob>;
  list(userId: string): Promise<ChunkManifest[]>;
  remove(userId: string, id: string): Promise<void>;
  wipe(userId: string): Promise<void>;
}
