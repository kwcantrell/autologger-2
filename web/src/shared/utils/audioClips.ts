import type { AudioSegment, LogEvent, SessionStatus } from '../../api/types';
import type { AudioClipLite } from './waveformMerge';

/** Non-negative timeline seconds for layout; invalid values become `fallback`. */
export function safeTimelineSec(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function wallTimeMs(iso: string | null | undefined): number | null {
  const t = new Date(iso || '').getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Parse HH:MM:SS[:|;]FF into continuous seconds using float FPS (e.g. 23.976, 29.97).
 * For timeline/sync, prefer event.timecode_total_frames / frame_rate when available.
 */
export function parseSmpteToSec(tc: string | null | undefined, fps: number): number {
  const rate = Number(fps);
  const fr = Number.isFinite(rate) && rate > 0 ? rate : 24;
  const m = /^(\d{2}):(\d{2}):(\d{2})(?:[:;](\d{2}))?$/.exec(String(tc ?? '').trim());
  if (!m) return -1;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  const sec = Number(m[3]);
  const frames = m[4] != null && m[4] !== '' ? Number(m[4]) : 0;
  if (![h, mm, sec, frames].every((x) => Number.isFinite(x))) return -1;
  if (mm > 59 || sec > 59 || frames < 0) return -1;
  return h * 3600 + mm * 60 + sec + frames / fr;
}

export function sessionFrameRate(status: SessionStatus | null | undefined): number {
  const fr = Number(status?.frame_rate);
  return Number.isFinite(fr) && fr > 0 ? fr : 24;
}

export function eventTimelineSec(e: LogEvent, status: SessionStatus | null | undefined): number {
  const tfRaw = e?.timecode_total_frames;
  const frEv = Number(e?.frame_rate);
  if (tfRaw != null && Number.isFinite(Number(tfRaw)) && Number.isFinite(frEv) && frEv > 0) {
    return Number(tfRaw) / frEv;
  }
  const fr = Number.isFinite(frEv) && frEv > 0 ? frEv : sessionFrameRate(status);
  return parseSmpteToSec(e?.timecode || '00:00:00', fr);
}

const LEGACY_AUDIO_STARTED = 'Log Audio Recording Started';
const LEGACY_AUDIO_STOPPED = 'Log Audio Recording Stopped';

export function parseRecordingOrdinalFromMessage(msg: string | null | undefined): number | null {
  const s = String(msg || '');
  const ma = /^Recording (\d+) Started$/.exec(s);
  if (ma) return Number(ma[1]);
  const mb = /^Recording (\d+) Stopped$/.exec(s);
  if (mb) return Number(mb[1]);
  return null;
}

export function isRecordingStartedMessage(msg: string | null | undefined): boolean {
  const s = String(msg || '');
  return /^Recording (\d+) Started$/.test(s) || s === LEGACY_AUDIO_STARTED;
}

export function isRecordingStoppedMessage(msg: string | null | undefined): boolean {
  const s = String(msg || '');
  return /^Recording (\d+) Stopped$/.test(s) || s === LEGACY_AUDIO_STOPPED;
}

function sortAudioInternalByOrdinalThenTime(events: LogEvent[]): LogEvent[] {
  return [...events].sort((a, b) => {
    const oa = parseRecordingOrdinalFromMessage(a.message);
    const ob = parseRecordingOrdinalFromMessage(b.message);
    if (oa != null && ob != null && oa !== ob) return oa - ob;
    return String(a.wall_time_utc || '').localeCompare(String(b.wall_time_utc || ''));
  });
}

interface RecordingInterval {
  ordinal: number | null;
  startEv: LogEvent;
  stopEv: LogEvent;
  startSec: number;
  endSec: number;
}

/**
 * Pair internal Recording N Started/Stopped in wall-clock order (FIFO per ordinal).
 * Supports multiple cycles with the same N (e.g. two "Recording 2" blocks).
 */
export function buildRecordingIntervalsFromInternalEvents(
  events: LogEvent[],
  status: SessionStatus | null | undefined,
): RecordingInterval[] {
  const internal = events.filter((e) => String(e?.category || '').toLowerCase() === 'internal');
  const starts = internal.filter((e) => isRecordingStartedMessage(e.message));
  const stops = internal.filter((e) => isRecordingStoppedMessage(e.message));
  const merged: { e: LogEvent; kind: 'start' | 'stop'; t: number }[] = [];
  for (const e of starts) {
    const t = wallTimeMs(e.wall_time_utc);
    merged.push({ e, kind: 'start', t: t ?? -1 });
  }
  for (const e of stops) {
    const t = wallTimeMs(e.wall_time_utc);
    merged.push({ e, kind: 'stop', t: t ?? -1 });
  }
  merged.sort((a, b) => {
    if (a.t !== b.t) return a.t - b.t;
    if (a.kind !== b.kind) return a.kind === 'start' ? -1 : 1;
    return String(a.e.event_id || '').localeCompare(String(b.e.event_id || ''));
  });

  const openByOrd = new Map<number, LogEvent[]>();
  const legacyOpen: LogEvent[] = [];
  const intervals: RecordingInterval[] = [];

  for (const x of merged) {
    const ord = parseRecordingOrdinalFromMessage(x.e.message);
    if (x.kind === 'start') {
      if (ord == null) {
        legacyOpen.push(x.e);
      } else {
        if (!openByOrd.has(ord)) openByOrd.set(ord, []);
        openByOrd.get(ord)?.push(x.e);
      }
      continue;
    }
    // stop
    if (ord == null) {
      const startEv = legacyOpen.shift();
      if (startEv) {
        const ss = eventTimelineSec(startEv, status);
        const es = eventTimelineSec(x.e, status);
        if (Number.isFinite(ss) && Number.isFinite(es) && ss >= 0 && es >= 0) {
          intervals.push({
            ordinal: null,
            startEv,
            stopEv: x.e,
            startSec: ss,
            endSec: Math.max(ss, es),
          });
        }
      }
    } else {
      const q = openByOrd.get(ord);
      const startEv = q?.shift();
      if (startEv) {
        const ss = eventTimelineSec(startEv, status);
        const es = eventTimelineSec(x.e, status);
        if (Number.isFinite(ss) && Number.isFinite(es) && ss >= 0 && es >= 0) {
          intervals.push({
            ordinal: ord,
            startEv,
            stopEv: x.e,
            startSec: ss,
            endSec: Math.max(ss, es),
          });
        }
      }
    }
  }
  return intervals.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
}

interface GreedyMatchResult {
  pairs: { segIdx: number; iv: RecordingInterval }[];
  placeholders: RecordingInterval[];
  unmatchedSegIdx: number[];
}

/**
 * Assign each segment file to the closest unused recording interval by wall clock
 * (chronological segments). Remaining intervals become placeholders (no matching file).
 * Unmatched segments are chained at the end.
 */
function matchAudioSegmentsToIntervalsGreedy(
  audioSegments: AudioSegment[],
  intervals: RecordingInterval[],
): GreedyMatchResult {
  const segMeta = audioSegments.map((s, index) => ({
    index,
    wallMs: wallTimeMs(s.started_at_utc),
  }));
  const segOrder = [...segMeta].sort((a, b) => {
    if (a.wallMs != null && b.wallMs != null && a.wallMs !== b.wallMs) return a.wallMs - b.wallMs;
    if (a.wallMs != null && b.wallMs == null) return -1;
    if (a.wallMs == null && b.wallMs != null) return 1;
    return a.index - b.index;
  });

  const ivMeta = intervals.map((iv, k) => ({
    iv,
    k,
    wallMs: wallTimeMs(iv.startEv.wall_time_utc),
  }));

  const usedIv = new Set<number>();
  const pairs: { segIdx: number; iv: RecordingInterval }[] = [];

  for (const sm of segOrder) {
    let bestK = -1;
    let bestD = Number.POSITIVE_INFINITY;
    for (const im of ivMeta) {
      if (usedIv.has(im.k)) continue;
      if (sm.wallMs == null || im.wallMs == null) continue;
      const d = Math.abs(sm.wallMs - im.wallMs);
      if (d < bestD) {
        bestD = d;
        bestK = im.k;
      }
    }
    if (bestK >= 0 && bestD !== Number.POSITIVE_INFINITY) {
      usedIv.add(bestK);
      const im = ivMeta.find((x) => x.k === bestK);
      if (im) pairs.push({ segIdx: sm.index, iv: im.iv });
    }
  }

  let matchedSeg = new Set(pairs.map((p) => p.segIdx));
  let unmatchedSegIdx = segMeta.map((s) => s.index).filter((idx) => !matchedSeg.has(idx));

  /*
   * Segments with no started_at_utc never get a wall match; their log interval becomes a red
   * placeholder while the real file is chained at the end of the timeline. Pair remaining segments
   * to remaining intervals in chronological order (n-th segment file ↔ n-th unused recording block).
   */
  const unusedIvSorted = ivMeta
    .filter((im) => !usedIv.has(im.k))
    .sort((a, b) => a.iv.startSec - b.iv.startSec || a.k - b.k);
  const unmatchedSorted = [...unmatchedSegIdx].sort((a, b) => a - b);
  const nLock = Math.min(unmatchedSorted.length, unusedIvSorted.length);
  for (let u = 0; u < nLock; u += 1) {
    const im = unusedIvSorted[u];
    usedIv.add(im.k);
    pairs.push({ segIdx: unmatchedSorted[u], iv: im.iv });
  }

  const placeholders = ivMeta.filter((im) => !usedIv.has(im.k)).map((im) => im.iv);
  matchedSeg = new Set(pairs.map((p) => p.segIdx));
  unmatchedSegIdx = segMeta.map((s) => s.index).filter((idx) => !matchedSeg.has(idx));

  return { pairs, placeholders, unmatchedSegIdx };
}

function rebuildAudioClipsLegacyOrdinalAndChain(
  audioSegments: AudioSegment[],
  segmentDurations: (number | null)[],
  events: LogEvent[],
  status: SessionStatus | null | undefined,
): AudioClipLite[] {
  const startEvents = sortAudioInternalByOrdinalThenTime(
    events.filter(
      (e) =>
        String(e?.category || '').toLowerCase() === 'internal' &&
        isRecordingStartedMessage(e.message),
    ),
  );
  const stopEvents = sortAudioInternalByOrdinalThenTime(
    events.filter(
      (e) =>
        String(e?.category || '').toLowerCase() === 'internal' &&
        isRecordingStoppedMessage(e.message),
    ),
  );
  const startEventByOrd = new Map<number, LogEvent>();
  for (const e of startEvents) {
    const n = parseRecordingOrdinalFromMessage(e.message);
    if (n != null) startEventByOrd.set(n, e);
  }
  const stopSecByOrd = new Map<number, number>();
  for (const e of stopEvents) {
    const n = parseRecordingOrdinalFromMessage(e.message);
    if (n == null) continue;
    const sec = eventTimelineSec(e, status);
    if (sec >= 0) stopSecByOrd.set(n, sec);
  }
  const recordingOrdinals = [...startEventByOrd.keys()].sort((a, b) => a - b);

  const nSeg = audioSegments.length;
  const assignedOrd: (number | null)[] = new Array(nSeg).fill(null);
  const usedOrd = new Set<number>();

  for (let i = 0; i < nSeg; i += 1) {
    const raw = audioSegments[i].recording_ordinal;
    if (raw == null) continue;
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 1) continue;
    if (!startEventByOrd.has(n) || usedOrd.has(n)) continue;
    assignedOrd[i] = n;
    usedOrd.add(n);
  }

  const wallMatchMaxMs = 10 * 60 * 1000;
  for (let i = 0; i < nSeg; i += 1) {
    if (assignedOrd[i] != null) continue;
    const segStart = wallTimeMs(audioSegments[i].started_at_utc);
    if (segStart == null) continue;
    let bestN: number | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const n of recordingOrdinals) {
      if (usedOrd.has(n)) continue;
      const ev = startEventByOrd.get(n);
      const wm = wallTimeMs(ev?.wall_time_utc);
      if (wm == null) continue;
      const d = Math.abs(segStart - wm);
      if (d < bestD) {
        bestD = d;
        bestN = n;
      }
    }
    if (bestN != null && bestD <= wallMatchMaxMs) {
      assignedOrd[i] = bestN;
      usedOrd.add(bestN);
    }
  }

  const stillIdx: number[] = [];
  for (let i = 0; i < nSeg; i += 1) if (assignedOrd[i] == null) stillIdx.push(i);
  const freeOrds = recordingOrdinals.filter((n) => !usedOrd.has(n));
  for (let k = 0; k < stillIdx.length && k < freeOrds.length; k += 1) {
    assignedOrd[stillIdx[k]] = freeOrds[k];
    usedOrd.add(freeOrds[k]);
  }

  const out: AudioClipLite[] = [];
  for (let i = 0; i < nSeg; i += 1) {
    const dRaw = Number(segmentDurations[i]);
    /* Probe can fail (codec, CORS, corrupt); still show a clip so the file isn't dropped. */
    const d = Number.isFinite(dRaw) && dRaw > 0 ? dRaw : 1;
    const n = assignedOrd[i];
    let startSec: number;
    let endSec: number;
    if (n != null && startEventByOrd.has(n)) {
      const ev = startEventByOrd.get(n);
      if (!ev) {
        startSec = out.length ? out[out.length - 1].endSec : 0;
        endSec = startSec + d;
      } else {
        startSec = eventTimelineSec(ev, status);
        if (!(startSec >= 0)) {
          startSec = out.length ? out[out.length - 1].endSec : 0;
        }
        const stopSec = stopSecByOrd.get(n);
        endSec = stopSec != null ? Math.max(startSec, stopSec) : startSec + d;
      }
    } else {
      /* i-th segment ↔ i-th start/stop in sorted internal lists (upload order ≈ log order). */
      const se = startEvents[i];
      const te = stopEvents[i];
      if (se) {
        const s = eventTimelineSec(se, status);
        startSec = s >= 0 ? s : out.length ? out[out.length - 1].endSec : 0;
      } else {
        startSec = out.length ? out[out.length - 1].endSec : 0;
      }
      if (te) {
        const st = eventTimelineSec(te, status);
        endSec = st >= 0 ? Math.max(startSec, st) : startSec + d;
      } else {
        endSec = startSec + d;
      }
    }
    endSec = Math.max(endSec, startSec + 0.05);
    out.push({
      segmentId: audioSegments[i].id,
      url: audioSegments[i].url,
      startSec,
      endSec,
      duration: d,
      missingAudio: false,
    });
  }
  return out;
}

export function rebuildAudioClips(
  audioSegments: AudioSegment[],
  segmentDurations: (number | null)[],
  events: LogEvent[],
  status: SessionStatus | null | undefined,
): AudioClipLite[] {
  const nSeg = audioSegments.length;
  if (!nSeg) return [];

  const intervals = buildRecordingIntervalsFromInternalEvents(events, status);
  if (intervals.length === 0) {
    return rebuildAudioClipsLegacyOrdinalAndChain(audioSegments, segmentDurations, events, status);
  }

  const { pairs, placeholders, unmatchedSegIdx } = matchAudioSegmentsToIntervalsGreedy(
    audioSegments,
    intervals,
  );

  const out: AudioClipLite[] = [];

  for (const p of pairs) {
    const i = p.segIdx;
    const iv = p.iv;
    const dRaw = Number(segmentDurations[i]);
    const d = Number.isFinite(dRaw) && dRaw > 0 ? dRaw : 1;
    const startSec = safeTimelineSec(iv.startSec, 0);
    let endSec = safeTimelineSec(iv.endSec, startSec);
    if (endSec < startSec) endSec = startSec + 0.05;
    endSec = Math.max(endSec, startSec + d, startSec + 0.05);
    out.push({
      segmentId: audioSegments[i].id,
      url: audioSegments[i].url,
      startSec,
      endSec,
      duration: d,
      missingAudio: false,
    });
  }

  for (const iv of placeholders) {
    const startSec = safeTimelineSec(iv.startSec, 0);
    const endSec = Math.max(safeTimelineSec(iv.endSec, startSec), startSec + 0.05);
    out.push({
      segmentId: null,
      url: null,
      startSec,
      endSec,
      duration: Math.max(0.05, endSec - startSec),
      missingAudio: true,
    });
  }

  let chainEnd = out.reduce((m, c) => Math.max(m, safeTimelineSec(c.endSec, 0)), 0);
  for (const i of [...unmatchedSegIdx].sort((a, b) => a - b)) {
    const dRaw = Number(segmentDurations[i]);
    const d = Number.isFinite(dRaw) && dRaw > 0 ? dRaw : 1;
    const startSec = chainEnd;
    const endSec = Math.max(startSec + d, startSec + 0.05);
    chainEnd = endSec;
    out.push({
      segmentId: audioSegments[i].id,
      url: audioSegments[i].url,
      startSec,
      endSec,
      duration: d,
      missingAudio: false,
    });
  }

  out.sort((a, b) => a.startSec - b.startSec);
  return out;
}

/** Master timeline length: max of 30, status rolling sec + 5, last event +5, last clip end +5. */
export function computeTotalSec(
  status: SessionStatus | null | undefined,
  events: LogEvent[],
  clips: AudioClipLite[],
): number {
  const rawTc = status?.session_timecode ?? status?.timecode ?? '00:00:00';
  const nowSec = Math.max(0, parseSmpteToSec(rawTc, sessionFrameRate(status)));
  let maxEventSec = 0;
  for (const e of events) {
    const s = eventTimelineSec(e, status);
    if (Number.isFinite(s) && s > maxEventSec) maxEventSec = s;
  }
  let maxClipEnd = 0;
  for (const c of clips) {
    const e = Number(c.endSec);
    if (Number.isFinite(e) && e > maxClipEnd) maxClipEnd = e;
  }
  const raw = Math.max(30, nowSec + 5, maxEventSec + 5, maxClipEnd + 5);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}
