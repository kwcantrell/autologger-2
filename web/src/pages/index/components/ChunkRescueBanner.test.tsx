import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installChunkLeaveWarning,
  uninstallChunkLeaveWarningForTesting,
} from '../utils/chunkLeaveWarning';
import {
  type ChunkInput,
  getChunkUploadQueue,
  resetChunkUploadQueueForTesting,
} from '../utils/chunkUploadQueue';
import { AudioSaveOverlay } from './AudioSaveOverlay';
import { ChunkRescueBanner, chunkDownloadFilename } from './ChunkRescueBanner';

// --- ChunkRescueBanner tests (chunked-live-recording, task 5.1) ---
//
// Covers the task's required list: dismissal-is-consent (nothing leaves the
// queue without success or confirmed discard; cancel keeps chunks),
// persistence across AudioSaveOverlay show/hide (hideToast() must not touch
// it), leave-warning coverage (beforeunload preventDefault when queue
// non-empty), download filename shape + revocation, Retry pumps, banner
// lists failed chunks with server detail, and per-chunk discard.
//
// The AudioSaveOverlay/hideToast interaction test deliberately uses the REAL
// `shared/components/Toast` module (no mock) — the point of that test is
// that `AudioSaveOverlay`'s genuine `hideToast()` call (not a mocked
// no-op stand-in) must not touch the banner.

// jsdom has no real media pipeline — AudioSaveOverlay's video element calls
// play()/pause() (AudioPlayer.test.tsx's established stub pattern).
HTMLMediaElement.prototype.load = () => {};
HTMLMediaElement.prototype.play = () => Promise.resolve();
HTMLMediaElement.prototype.pause = () => {};

function blob(bytes = 10, type = 'audio/webm'): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
}

function chunkInput(overrides: Partial<ChunkInput> = {}): ChunkInput {
  return {
    sessionId: 'sess-1',
    recordingOrdinal: 1,
    chunkIndex: 0,
    blob: blob(),
    startedAtUtc: '2026-08-12T10:00:00.000Z',
    endedAtUtc: '2026-08-12T10:10:00.000Z',
    mimeType: 'audio/webm',
    ...overrides,
  };
}

let uploadImpl: (chunk: ChunkInput) => Promise<{ ok: false; status?: number; message: string }> =
  async () => ({ ok: false, status: 502, message: 'still failing' });

function seedQueue() {
  return getChunkUploadQueue({
    upload: (c) => uploadImpl(c),
    listSegments: async () => [],
    clock: { now: () => Date.now() },
  });
}

beforeEach(() => {
  resetChunkUploadQueueForTesting();
  // ESM modules evaluate once — importing `chunkLeaveWarning` (transitively,
  // via `ChunkRescueBanner`) does not re-run its module-scope install() on a
  // later import. Reinstall fresh per test so each test's subscription and
  // listener state is isolated (mirrors the uninstall/reinstall pair, not a
  // real prod path — production only ever installs once, at first module
  // evaluation). Ordering matters: the reset drops the singleton first, so the
  // reinstalled creation subscription is what picks up this test's `seedQueue()`.
  uninstallChunkLeaveWarningForTesting();
  installChunkLeaveWarning();
  uploadImpl = async () => ({ ok: false, status: 502, message: 'still failing' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  uninstallChunkLeaveWarningForTesting();
});

describe('ChunkRescueBanner', () => {
  it('renders nothing when the queue is empty', () => {
    seedQueue();
    render(<ChunkRescueBanner />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // Visual-gate finding (chunked-live-recording U9): a HEALTHY chunk whose
  // first upload attempt is still in flight — never failed, no lastError —
  // must not render the failure banner. Regression coverage for the
  // stalled-upload e2e:visual fixture (`stallAudioUploads` in
  // e2e/visual.spec.ts holds the request open forever, so pump() never
  // settles and the chunk stays 'queued' with lastError: null throughout).
  it('renders nothing while a healthy chunk is mid first attempt (never failed)', async () => {
    const queue = seedQueue();
    // Never resolves/rejects — models the stalled-upload fixture
    // (page.route holding the request open forever) and a genuine slow
    // first attempt alike: no failure has occurred, so nothing in the
    // queue has an error yet.
    uploadImpl = () => new Promise(() => {});

    queue.enqueue(chunkInput());
    void queue.pump(); // fire-and-forget: intentionally never awaited/settled

    render(<ChunkRescueBanner />);

    // Give the in-flight attempt a tick to (not) settle, then assert the
    // banner stayed absent throughout — classification is 'queued' and
    // lastError is null the whole time.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(queue.getSnapshot().chunks[0].lastError).toBeNull();
    expect(queue.getSnapshot().chunks[0].classification).toBe('queued');
  });

  // Once a chunk has genuinely failed, the banner must stay visible through
  // a subsequent retry attempt — it does not flicker off the moment Retry
  // is clicked, only on success/discard (task brief item 1).
  it('failed-then-retrying: banner stays visible while a retry is in flight', async () => {
    const queue = seedQueue();
    queue.enqueue(chunkInput());
    await queue.pump(); // fails with status 502 -> queued with lastError set

    render(<ChunkRescueBanner />);
    expect(await screen.findByRole('alert')).toBeTruthy();

    uploadImpl = () => new Promise(() => {}); // in-flight retry, never settles

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    // While the retry attempt is in flight, the chunk is still
    // classification 'queued' with its prior lastError intact (pump() only
    // clears it on a fresh outcome) — the banner must remain visible, not
    // flicker off mid-retry.
    await waitFor(() => expect(queue.getSnapshot().inFlight).toBe(true));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Retrying…')).toBeTruthy();
  });

  it('lists a failed chunk with the server detail from lastError', async () => {
    const queue = seedQueue();
    queue.enqueue(chunkInput());
    await queue.pump(); // fails with status 502 -> stays queued with lastError set

    render(<ChunkRescueBanner />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/still failing/)).toBeTruthy();
    expect(screen.getByText(/Recording 1/)).toBeTruthy();
  });

  it('Retry pumps the pipeline', async () => {
    const queue = seedQueue();
    queue.enqueue(chunkInput());
    await queue.pump();
    render(<ChunkRescueBanner />);
    await screen.findByRole('alert');

    let resolved = false;
    uploadImpl = async () => {
      resolved = true;
      return { ok: false, status: 502, message: 'still failing' };
    };

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(resolved).toBe(true));
  });

  it('per-chunk discard removes exactly that chunk after confirm', async () => {
    const queue = seedQueue();
    queue.enqueue(chunkInput({ chunkIndex: 0 }));
    queue.enqueue(chunkInput({ chunkIndex: 1, startedAtUtc: '2026-08-12T10:10:00.000Z' }));
    // Single-flight ordering (design D6): a transiently-failed head stays
    // 'queued' and keeps blocking chunk 1, so both chunks must each
    // genuinely fail to both render on the failure-gated banner
    // (visual-gate finding, U9). Fail chunk 0 permanently (moves it to
    // rescue-only, unblocking the head — pump()'s loop continues within the
    // same call rather than breaking) so chunk 1 is attempted too and fails
    // transiently.
    uploadImpl = async (c) =>
      c.chunkIndex === 0
        ? { ok: false, status: 400, message: 'bad request' }
        : { ok: false, status: 502, message: 'still failing' };
    await queue.pump();

    render(<ChunkRescueBanner />);
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);

    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Discard' }));
    // Confirmation dialog appears — its own "Discard" button is distinct
    // from the row's, so disambiguate by dialog role.
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));

    await waitFor(() => {
      expect(screen.getAllByRole('listitem')).toHaveLength(1);
    });
    expect(queue.getSnapshot().chunks).toHaveLength(1);
    expect(queue.getSnapshot().chunks[0].chunkIndex).toBe(1);
  });

  it('dismissal-is-consent: cancelling the discard confirm keeps the chunk', async () => {
    const queue = seedQueue();
    queue.enqueue(chunkInput());
    await queue.pump();

    render(<ChunkRescueBanner />);
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(queue.getSnapshot().chunks).toHaveLength(1); // nothing left the queue
  });

  it('discard-remainder requires confirmation naming the amount and clears the whole queue on accept', async () => {
    const queue = seedQueue();
    queue.enqueue(chunkInput({ chunkIndex: 0 }));
    queue.enqueue(chunkInput({ chunkIndex: 1, startedAtUtc: '2026-08-12T10:10:00.000Z' }));
    // Both chunks must actually FAIL to both render on the failure-gated
    // banner (visual-gate finding, U9). Single-flight ordering means a
    // transiently-failed head keeps blocking chunk 1 — fail chunk 0
    // permanently (unblocks the head; pump()'s loop continues within the
    // same call) so chunk 1 is attempted too and fails transiently.
    uploadImpl = async (c) =>
      c.chunkIndex === 0
        ? { ok: false, status: 400, message: 'bad request' }
        : { ok: false, status: 502, message: 'still failing' };
    await queue.pump();

    render(<ChunkRescueBanner />);
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Discard remaining' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/2 chunks/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard all' }));

    await waitFor(() => expect(queue.getSnapshot().chunks).toHaveLength(0));
  });

  it('persists across AudioSaveOverlay show/hide (hideToast) transitions', async () => {
    vi.useFakeTimers();
    try {
      const queue = seedQueue();
      queue.enqueue(chunkInput());
      await queue.pump();

      const { rerender } = render(
        <>
          <ChunkRescueBanner />
          <AudioSaveOverlay isUploading={true} />
        </>,
      );
      expect(screen.getByRole('alert')).toBeTruthy();

      // Overlay leaves — its real (unmocked) hideToast() fires once its own
      // MIN_PRESENTATION_MS + FADE_MS timers elapse (AudioSaveOverlay.tsx).
      rerender(
        <>
          <ChunkRescueBanner />
          <AudioSaveOverlay isUploading={false} />
        </>,
      );
      await vi.advanceTimersByTimeAsync(2_000);

      // The banner must still be present and still list the chunk — the
      // overlay's genuine hideToast() call never touches it.
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(queue.getSnapshot().chunks).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('download filename is filesystem-safe with the correct extension for webm and mp4', async () => {
    const queue = seedQueue();
    queue.enqueue(
      chunkInput({ sessionId: 'sess/weird:id', mimeType: 'audio/webm', chunkIndex: 0 }),
    );
    queue.enqueue(
      chunkInput({
        sessionId: 'sess/weird:id',
        mimeType: 'audio/mp4',
        chunkIndex: 1,
        startedAtUtc: '2026-08-12T10:10:00.000Z',
      }),
    );
    await queue.pump();
    const snap = queue.getSnapshot();

    const webmName = chunkDownloadFilename(snap.chunks[0]);
    const mp4Name = chunkDownloadFilename(snap.chunks[1]);

    expect(webmName).not.toMatch(/[:]/);
    expect(webmName.endsWith('.webm')).toBe(true);
    expect(mp4Name.endsWith('.m4a')).toBe(true);
    expect(webmName).toMatch(/^[A-Za-z0-9_.-]+$/); // filesystem-safe charset
    expect(mp4Name).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(webmName).toContain('rec1');
    expect(webmName).toContain('chunk0');
  });

  it('Download revokes the object URL after the click', async () => {
    const queue = seedQueue();
    queue.enqueue(chunkInput());
    await queue.pump();

    const createSpy = vi.fn(() => 'blob:fake-url');
    const revokeSpy = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: createSpy, revokeObjectURL: revokeSpy });

    render(<ChunkRescueBanner />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledWith('blob:fake-url');
  });
});

// --- chunk leave-warning coverage (task 5.1) + conditional attach (bfcache) ---
//
// The warning is no longer a listener installed for the module's lifetime: a
// registered `beforeunload` listener disqualifies the page from the
// back/forward cache on its mere presence, so `chunkLeaveWarning.ts` subscribes
// to the queue and attaches only while the queue actually holds something.
// These tests therefore assert BOTH halves — the observable warning behaviour
// (preventDefault) and the registration itself, which is the part bfcache
// eligibility turns on.
describe('chunk leave-warning coverage (task 5.1)', () => {
  function dispatchBeforeUnload(): BeforeUnloadEvent {
    const evt = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(evt);
    return evt;
  }

  function beforeUnloadCalls(spy: { mock: { calls: unknown[][] } }): number {
    return spy.mock.calls.filter((call) => call[0] === 'beforeunload').length;
  }

  function spyOnWindowListeners() {
    return {
      add: vi.spyOn(window, 'addEventListener'),
      remove: vi.spyOn(window, 'removeEventListener'),
    };
  }

  it('registers no beforeunload listener while the queue is empty', () => {
    const spies = spyOnWindowListeners();
    seedQueue();
    render(<ChunkRescueBanner />);

    expect(beforeUnloadCalls(spies.add)).toBe(0);
    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);
  });

  it('attaches the listener as soon as a chunk enqueues', () => {
    const spies = spyOnWindowListeners();
    const queue = seedQueue();

    // Queue notification is synchronous with `enqueue()`, so the listener is
    // armed in the same turn the chunk becomes at-risk — no unwarned window.
    queue.enqueue(chunkInput());

    expect(beforeUnloadCalls(spies.add)).toBe(1);
    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);
  });

  it('warns (preventDefault) when the queue is non-empty after stop', async () => {
    const queue = seedQueue();
    render(<ChunkRescueBanner />);

    queue.enqueue(chunkInput());
    await queue.pump(); // fails, stays queued

    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);
  });

  it('detaches the listener once the queue drains', () => {
    const spies = spyOnWindowListeners();
    const queue = seedQueue();
    queue.enqueue(chunkInput());
    expect(beforeUnloadCalls(spies.add)).toBe(1);

    queue.discardAll();

    expect(beforeUnloadCalls(spies.remove)).toBe(1);
    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);
  });

  it('attach/detach are idempotent across repeated same-state snapshots', () => {
    const spies = spyOnWindowListeners();
    const queue = seedQueue();
    queue.enqueue(chunkInput({ chunkIndex: 0 }));
    queue.enqueue(chunkInput({ chunkIndex: 1, startedAtUtc: '2026-08-12T10:10:00.000Z' }));
    // Still non-empty after both notifications — exactly one attach.
    expect(beforeUnloadCalls(spies.add)).toBe(1);

    queue.discard(1, 1); // one chunk left: still non-empty, still one attach
    expect(beforeUnloadCalls(spies.add)).toBe(1);
    expect(beforeUnloadCalls(spies.remove)).toBe(0);

    queue.discardAll();
    queue.discardAll(); // repeated empty snapshot must not re-remove
    expect(beforeUnloadCalls(spies.remove)).toBe(1);
  });
});
