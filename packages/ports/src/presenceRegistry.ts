// PresenceRegistry port (spec: core-ports-architecture): in-memory Companion
// presence today (`server/src/node/presence.ts`'s `PresenceRegistry` class).
// `PresenceMeta` moves here alongside the interface since it appears in its
// method signatures.

export interface PresenceMeta {
  session_id: string;
  visible: boolean;
  is_playing: boolean;
  updated: number;
}

export interface PresenceRegistry {
  upsert(clientId: string, meta: PresenceMeta): void;
  remove(clientId: string): void;
  /** Fresh entries only — implementations may prune stale ones as a side effect. */
  list(): PresenceMeta[];
}
