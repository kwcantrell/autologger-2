// youtube-playlist-import (design D3, task 4.1) — at most two playlist listings per process.

import { afterEach, describe, expect, it } from 'vitest';
import { PLAYLIST_LISTING_MAX_CONCURRENT, playlistListingGuard } from './playlistListingGuard';

afterEach(() => playlistListingGuard.reset());

describe('playlistListingGuard', () => {
  it('admits two listings and refuses the third', () => {
    expect(PLAYLIST_LISTING_MAX_CONCURRENT).toBe(2);
    expect(playlistListingGuard.tryAcquire()).not.toBeNull();
    expect(playlistListingGuard.tryAcquire()).not.toBeNull();
    expect(playlistListingGuard.tryAcquire()).toBeNull();
    expect(playlistListingGuard.activeCount).toBe(2);
  });

  it('a release frees one slot', () => {
    const a = playlistListingGuard.tryAcquire();
    playlistListingGuard.tryAcquire();
    a?.release();
    expect(playlistListingGuard.tryAcquire()).not.toBeNull();
    expect(playlistListingGuard.tryAcquire()).toBeNull();
  });

  it('a double release frees only one slot', () => {
    const a = playlistListingGuard.tryAcquire();
    playlistListingGuard.tryAcquire();
    a?.release();
    a?.release();
    expect(playlistListingGuard.activeCount).toBe(1);
    expect(playlistListingGuard.tryAcquire()).not.toBeNull();
    expect(playlistListingGuard.tryAcquire()).toBeNull();
  });

  it('reset() clears every slot', () => {
    playlistListingGuard.tryAcquire();
    playlistListingGuard.tryAcquire();
    playlistListingGuard.reset();
    expect(playlistListingGuard.activeCount).toBe(0);
    expect(playlistListingGuard.tryAcquire()).not.toBeNull();
  });
});
