/**
 * In-memory origin-private file system for tests (media-worker A.1). Implements the subset of
 * `FileSystemDirectoryHandle` / `FileSystemFileHandle` / `FileSystemSyncAccessHandle` that
 * `chunkStore/opfsWorker.ts` uses, with the exclusivity rule of the real sync access handle
 * (a second `createSyncAccessHandle` on an open file throws `NoModificationAllowedError`).
 */

class FakeDomException extends Error {
  constructor(
    message: string,
    public override readonly name: string,
  ) {
    super(message);
  }
}

export class FakeSyncAccessHandle {
  private closed = false;
  constructor(private readonly file: FakeFileHandle) {}

  private check(): void {
    if (this.closed) throw new FakeDomException('handle closed', 'InvalidStateError');
  }

  getSize(): number {
    this.check();
    return this.file.data.length;
  }

  read(buffer: Uint8Array, opts: { at?: number } = {}): number {
    this.check();
    const at = opts.at ?? 0;
    const slice = this.file.data.subarray(at, at + buffer.length);
    buffer.set(slice);
    return slice.length;
  }

  write(buffer: ArrayBufferView | ArrayBuffer, opts: { at?: number } = {}): number {
    this.check();
    if (this.file.owner.failWrites) {
      throw new FakeDomException('quota exceeded', 'QuotaExceededError');
    }
    const bytes =
      buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer)
        : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const at = opts.at ?? 0;
    const end = at + bytes.length;
    if (end > this.file.data.length) {
      const grown = new Uint8Array(end);
      grown.set(this.file.data);
      this.file.data = grown;
    }
    this.file.data.set(bytes, at);
    return bytes.length;
  }

  truncate(size: number): void {
    this.check();
    this.file.data = this.file.data.slice(0, size);
  }

  flush(): void {
    this.check();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.file.open = false;
  }
}

export class FakeFileHandle {
  readonly kind = 'file';
  data = new Uint8Array(0);
  open = false;
  constructor(
    readonly name: string,
    readonly owner: FakeOpfs,
  ) {}

  async createSyncAccessHandle(): Promise<FakeSyncAccessHandle> {
    if (this.owner.noSyncHandle) throw new FakeDomException('unsupported', 'NotSupportedError');
    if (this.open) {
      throw new FakeDomException('already open', 'NoModificationAllowedError');
    }
    this.open = true;
    return new FakeSyncAccessHandle(this);
  }

  async getFile(): Promise<Blob> {
    return new Blob([this.data.slice()]);
  }
}

export class FakeDirectoryHandle {
  readonly kind = 'directory';
  readonly entriesMap = new Map<string, FakeDirectoryHandle | FakeFileHandle>();
  constructor(
    readonly name: string,
    readonly owner: FakeOpfs,
  ) {}

  async getDirectoryHandle(
    name: string,
    opts: { create?: boolean } = {},
  ): Promise<FakeDirectoryHandle> {
    const existing = this.entriesMap.get(name);
    if (existing instanceof FakeDirectoryHandle) return existing;
    if (existing) throw new FakeDomException('not a directory', 'TypeMismatchError');
    if (!opts.create) throw new FakeDomException(`no ${name}`, 'NotFoundError');
    const dir = new FakeDirectoryHandle(name, this.owner);
    this.entriesMap.set(name, dir);
    return dir;
  }

  async getFileHandle(name: string, opts: { create?: boolean } = {}): Promise<FakeFileHandle> {
    const existing = this.entriesMap.get(name);
    if (existing instanceof FakeFileHandle) return existing;
    if (existing) throw new FakeDomException('not a file', 'TypeMismatchError');
    if (!opts.create) throw new FakeDomException(`no ${name}`, 'NotFoundError');
    const file = new FakeFileHandle(name, this.owner);
    this.entriesMap.set(name, file);
    return file;
  }

  async removeEntry(name: string, _opts: { recursive?: boolean } = {}): Promise<void> {
    if (!this.entriesMap.has(name)) throw new FakeDomException(`no ${name}`, 'NotFoundError');
    this.entriesMap.delete(name);
  }

  async *entries(): AsyncIterableIterator<[string, FakeDirectoryHandle | FakeFileHandle]> {
    for (const entry of Array.from(this.entriesMap.entries())) yield entry;
  }
}

/** A fake OPFS root plus switches for the failure modes spike 0.3 observed. */
export class FakeOpfs {
  /** `getDirectory()` rejects (ephemeral WebKit: `UnknownError`). */
  failGetDirectory = false;
  /** `createSyncAccessHandle` is missing (a browser without the sync API). */
  noSyncHandle = false;
  /** Writes throw `QuotaExceededError`. */
  failWrites = false;
  readonly root = new FakeDirectoryHandle('', this);

  getDirectory = async (): Promise<FakeDirectoryHandle> => {
    if (this.failGetDirectory) throw new FakeDomException('The operation failed', 'UnknownError');
    return this.root;
  };

  /** Test helper: the file at `a/b/c`, or undefined. */
  fileAt(path: string): FakeFileHandle | undefined {
    const parts = path.split('/');
    let dir: FakeDirectoryHandle = this.root;
    for (const [i, part] of parts.entries()) {
      const entry = dir.entriesMap.get(part);
      if (!entry) return undefined;
      if (i === parts.length - 1) return entry instanceof FakeFileHandle ? entry : undefined;
      if (!(entry instanceof FakeDirectoryHandle)) return undefined;
      dir = entry;
    }
    return undefined;
  }

  /** Test helper: names directly under `a/b`. */
  namesAt(path: string): string[] {
    let dir: FakeDirectoryHandle = this.root;
    for (const part of path.split('/').filter(Boolean)) {
      const entry = dir.entriesMap.get(part);
      if (!(entry instanceof FakeDirectoryHandle)) return [];
      dir = entry;
    }
    return Array.from(dir.entriesMap.keys()).sort();
  }
}
