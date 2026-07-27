import type { LogEvent, SessionStatus } from '../../api/types';
import { eventTimelineSec } from './audioClips';
import { fmtHmsFromSec } from './timecode';

const LEGACY_AUDIO_STARTED = 'Log Audio Recording Started';
const LEGACY_AUDIO_STOPPED = 'Log Audio Recording Stopped';

export function parseRecordingOrdinalFromMessage(msg: string | null | undefined): number | null {
  const s = String(msg ?? '');
  const ma = /^Recording (\d+) Started$/.exec(s);
  if (ma) return Number(ma[1]);
  const mb = /^Recording (\d+) Stopped$/.exec(s);
  if (mb) return Number(mb[1]);
  return null;
}

export function isRecordingStartedMessage(msg: string | null | undefined): boolean {
  const s = String(msg ?? '');
  return /^Recording (\d+) Started$/.test(s) || s === LEGACY_AUDIO_STARTED;
}

export function isRecordingStoppedMessage(msg: string | null | undefined): boolean {
  const s = String(msg ?? '');
  return /^Recording (\d+) Stopped$/.test(s) || s === LEGACY_AUDIO_STOPPED;
}

function isInternalAudioEvent(
  e: LogEvent,
  predicate: (msg: string | null | undefined) => boolean,
): boolean {
  return String(e.category ?? '').toLowerCase() === 'internal' && predicate(e.message);
}

export function sortAudioInternalByOrdinalThenTime(events: LogEvent[]): LogEvent[] {
  return [...events].sort((a, b) => {
    const oa = parseRecordingOrdinalFromMessage(a.message);
    const ob = parseRecordingOrdinalFromMessage(b.message);
    if (oa != null && ob != null && oa !== ob) return oa - ob;
    return String(a.wall_time_utc ?? '').localeCompare(String(b.wall_time_utc ?? ''));
  });
}

export function computeRemoteRecordingBlocksMedia(
  status: SessionStatus | null | undefined,
  clientId: string,
): boolean {
  if (!status) return false;
  const alive = Boolean(status.audio_recording_lease_alive);
  const holder = status.audio_recording_lease_holder_id;
  if (!alive || !holder || holder === clientId) return false;
  return true;
}

export interface OrphanRecording {
  orphanOrdinal: number;
  lastEndDisplay: string;
}

export function findOrphanRecording(
  events: LogEvent[],
  status: SessionStatus | null | undefined,
): OrphanRecording | null {
  const startsAll = events.filter((e) => isInternalAudioEvent(e, isRecordingStartedMessage));
  const stopsAll = events.filter((e) => isInternalAudioEvent(e, isRecordingStoppedMessage));
  if (startsAll.length <= stopsAll.length) return null;

  const startsSecs = sortAudioInternalByOrdinalThenTime(startsAll)
    .map((e) => eventTimelineSec(e, status))
    .filter((n) => n >= 0);
  const stopsSecs = sortAudioInternalByOrdinalThenTime(stopsAll)
    .map((e) => eventTimelineSec(e, status))
    .filter((n) => n >= 0);

  const lastKnownSec = stopsSecs.length
    ? stopsSecs[stopsSecs.length - 1]
    : startsSecs.length
      ? startsSecs[startsSecs.length - 1]
      : null;

  const startEvents = sortAudioInternalByOrdinalThenTime(startsAll);
  const orphanOrdinal =
    parseRecordingOrdinalFromMessage(startEvents[stopsAll.length]?.message ?? '') ??
    stopsAll.length + 1;

  return {
    orphanOrdinal,
    lastEndDisplay: lastKnownSec != null ? fmtHmsFromSec(lastKnownSec) : '—',
  };
}
