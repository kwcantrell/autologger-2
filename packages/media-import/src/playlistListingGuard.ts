// youtube-playlist-import (design D3, task 4.2) — the process-wide cap on concurrent playlist
// listings: at most two at once, a third gets the busy `503` before anything is spawned (as
// search allows two at once). Module singleton like `youtubeImportGuard`; the route acquires
// after its `422`/`400` checks and releases in a `finally`.

export const PLAYLIST_LISTING_MAX_CONCURRENT = 2;

/** An acquired listing slot; `release()` is idempotent. */
export interface PlaylistListingLease {
  release: () => void;
}

class PlaylistListingGuard {
  private active = 0;
  // A slot freed by reset() must not be freed again by an older lease's release().
  private generation = 0;

  /** Claim a slot, or `null` when two listings are already running. */
  tryAcquire(): PlaylistListingLease | null {
    if (this.active >= PLAYLIST_LISTING_MAX_CONCURRENT) return null;
    this.active += 1;
    const generation = this.generation;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (generation === this.generation) this.active -= 1;
      },
    };
  }

  /** Listings currently running (introspection / tests). */
  get activeCount(): number {
    return this.active;
  }

  /** Test-only: free every slot. Never called on a request path. */
  reset(): void {
    this.active = 0;
    this.generation += 1;
  }
}

/** Process-wide singleton the playlist listing route acquires against. */
export const playlistListingGuard = new PlaylistListingGuard();
