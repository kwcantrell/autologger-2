// BlobStore port (spec: core-ports-architecture): filesystem-backed audio blob
// storage today (`server/src/node/blobStore.ts`'s `BlobStore` class), a
// substitutable seam for tests/future backends. `BlobRange`/`BlobObject` move
// here alongside the interface since they appear in its method signatures.

export type BlobRange = { offset: number; length?: number } | { suffix: number };

export interface BlobObject {
  size: number;
  range?: { offset: number; length: number };
  body: ReadableStream;
}

export interface BlobStore {
  /** Absolute filesystem path for a stored key — existence is NOT checked. */
  resolveKeyPath(key: string): string;
  /** The store's scratch directory for spooling temporary work files a
   * caller must clean up itself. */
  scratchRoot(): string;
  put(key: string, bytes: ArrayBuffer | Uint8Array, opts?: { contentType?: string }): Promise<void>;
  get(key: string, opts?: { range?: BlobRange }): Promise<BlobObject | null>;
  delete(key: string): Promise<void>;
  list(opts: {
    prefix: string;
    cursor?: string;
  }): Promise<{ objects: Array<{ key: string }>; truncated: false; cursor?: undefined }>;
}
