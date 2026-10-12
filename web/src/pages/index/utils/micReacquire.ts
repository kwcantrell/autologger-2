/**
 * Microphone loss is recovered, not final (media-worker design D19; spec live-recording-chunks
 * "A lost microphone is re-acquired"). An unexpected recorder stop, a track `ended`, or a
 * `devicechange` that removed the active input keeps the take open: the recorder persists the
 * chunk captured so far and calls `reacquireMicrophone` — the previous device first, then the
 * default input — retried on the chunk backoff for up to 60 s. Only then does the take end.
 */

import { backoffDelayMs } from './uploadBackoff';

export const MIC_REACQUIRE_WINDOW_MS = 60_000;

export const MIC_CHANGED_NOTICE = 'Microphone changed; recording continues.';

export interface ReacquireDeps {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** The lost track's device, asked for first. */
  previousDeviceId: string | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random?: () => number;
  windowMs?: number;
  /** True once the take was stopped by the user meanwhile. */
  isCancelled?: () => boolean;
}

export type ReacquireResult =
  | { ok: true; stream: MediaStream; attempts: number }
  | { ok: false; reason: string; attempts: number };

/** Audio tracks of a stream (`getTracks()` where `getAudioTracks` is missing). */
export function audioTracksOf(stream: MediaStream): MediaStreamTrack[] {
  return typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks() : stream.getTracks();
}

function hasLiveAudio(stream: MediaStream): boolean {
  return audioTracksOf(stream).some((t) => t.readyState === 'live');
}

function describe(err: unknown): string {
  if (err instanceof Error)
    return err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message;
  return err === undefined ? 'no microphone available' : String(err);
}

function stopAll(stream: MediaStream): void {
  for (const t of stream.getTracks()) {
    try {
      t.stop();
    } catch {
      /* already stopped */
    }
  }
}

export async function reacquireMicrophone(deps: ReacquireDeps): Promise<ReacquireResult> {
  const windowMs = deps.windowMs ?? MIC_REACQUIRE_WINDOW_MS;
  const deadline = deps.now() + windowMs;
  const cancelled = () => deps.isCancelled?.() === true;
  let attempts = 0;
  let lastError: unknown;

  const tryOnce = async (constraints: MediaStreamConstraints): Promise<MediaStream | null> => {
    try {
      const stream = await deps.getUserMedia(constraints);
      if (hasLiveAudio(stream)) return stream;
      stopAll(stream);
      lastError = new Error('The microphone returned no live audio track.');
    } catch (err) {
      lastError = err;
    }
    return null;
  };

  for (;;) {
    if (cancelled()) return { ok: false, reason: 'cancelled', attempts };
    attempts += 1;
    if (deps.previousDeviceId) {
      const s = await tryOnce({ audio: { deviceId: { exact: deps.previousDeviceId } } });
      if (s) return { ok: true, stream: s, attempts };
    }
    const s = await tryOnce({ audio: true });
    if (s) return { ok: true, stream: s, attempts };
    if (cancelled()) return { ok: false, reason: 'cancelled', attempts };
    const remaining = deadline - deps.now();
    if (remaining <= 0) return { ok: false, reason: describe(lastError), attempts };
    await deps.sleep(Math.min(backoffDelayMs(attempts, deps.random), remaining));
  }
}

export type MicLossReason = 'track-ended' | 'device-removed';

export interface WatchMicrophoneDeps {
  onLost: (reason: MicLossReason) => void;
  /** `navigator.mediaDevices` (an EventTarget firing `devicechange`), when present. */
  mediaDevices: EventTarget | null | undefined;
  log: (message: string) => void;
}

/**
 * Watch the active stream: a track `ended` or a `devicechange` that left no live track reports
 * the loss; a `devicechange` with the track still live is only logged. Returns a disposer.
 */
export function watchMicrophone(stream: MediaStream, deps: WatchMicrophoneDeps): () => void {
  const tracks = audioTracksOf(stream);
  let lost = false;
  const report = (reason: MicLossReason) => {
    if (lost) return;
    lost = true;
    deps.onLost(reason);
  };
  const onEnded = () => report('track-ended');
  const onDeviceChange = () => {
    if (tracks.some((t) => t.readyState === 'live')) {
      deps.log('Audio devices changed; the recording input is still live.');
      return;
    }
    report('device-removed');
  };
  for (const t of tracks) {
    if (typeof t.addEventListener === 'function') t.addEventListener('ended', onEnded);
  }
  deps.mediaDevices?.addEventListener('devicechange', onDeviceChange);
  return () => {
    for (const t of tracks) {
      if (typeof t.removeEventListener === 'function') t.removeEventListener('ended', onEnded);
    }
    deps.mediaDevices?.removeEventListener('devicechange', onDeviceChange);
  };
}

/**
 * What a rollover boundary does (D19): roll over on a live stream, wait while a re-acquisition
 * runs (the boundary never ends the take), start one when the stream died silently.
 */
export function rolloverAction(state: {
  streamLive: boolean;
  reacquiring: boolean;
}): 'rollover' | 'wait' | 'reacquire' {
  if (state.reacquiring) return 'wait';
  return state.streamLive ? 'rollover' : 'reacquire';
}

/** The device id of a stream's first audio track, when the browser reports one. */
export function deviceIdOf(stream: MediaStream | null): string | null {
  const track = stream ? audioTracksOf(stream)[0] : undefined;
  const id = track && typeof track.getSettings === 'function' ? track.getSettings().deviceId : null;
  return id || null;
}
