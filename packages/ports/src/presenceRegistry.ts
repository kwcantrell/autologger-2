// PresenceRegistry port (spec: core-ports-architecture): in-memory Companion
// presence today (`server/src/node/presence.ts`'s `PresenceRegistry` class).
// `PresenceMeta` moves here alongside the interface since it appears in its
// method signatures. Async so Realtime Presence can replace it (async-session-callers D2).

export interface PresenceMeta {
  session_id: string;
  visible: boolean;
  is_playing: boolean;
  updated: number;
}

export interface PresenceRegistry {
  upsert(clientId: string, meta: PresenceMeta): Promise<void>;
  remove(clientId: string): Promise<void>;
  /** Fresh entries only — implementations may prune stale ones as a side effect. */
  list(): Promise<PresenceMeta[]>;
}
