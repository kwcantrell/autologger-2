import type { LogEvent, SessionStatus } from '../../api/types';
import {
  eventTimelineSec,
  isRecordingStartedMessage,
  isRecordingStoppedMessage,
  parseRecordingOrdinalFromMessage,
  sortAudioInternalByOrdinalThenTime,
} from './audioClips';
import { fmtHmsFromSec } from './timecode';

function isInternalAudioEvent(
  e: LogEvent,
  predicate: (msg: string | null | undefined) => boolean,
): boolean {
  return String(e.category ?? '').toLowerCase() === 'internal' && predicate(e.message);
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
