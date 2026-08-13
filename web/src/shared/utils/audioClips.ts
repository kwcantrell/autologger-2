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

export function sortAudioInternalByOrdinalThenTime(events: LogEvent[]): LogEvent[] {
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
  /** One entry per matched chunk group: its interval plus its member segment indices
   *  (sorted by segment `ordinal` — capture order — ascending; lowest-ordinal member first). */
  groupPairs: { memberIdx: number[]; iv: RecordingInterval }[];
  placeholders: RecordingInterval[];
  unmatchedSegIdx: number[];
}

/** Chunk group: segments sharing a `recording_ordinal` (null ordinals are singletons). */
interface ChunkGroup {
  ordinal: number | null;
  /** Segment indices, sorted by segment `ordinal` (capture order) ascending. */
  memberIdx: number[];
}

/**
 * Group segments sharing a non-null `recording_ordinal` into chunk groups (D4). When an
 * ordinal has multiple same-N interval cycles (`cycleStartMs`, sorted ascending), each
 * member is assigned to the cycle whose start event's wall time most nearly precedes the
 * member's `started_at_utc` (falls back to the earliest cycle when no cycle precedes it,
 * or the member's wall time is unparseable). Null-ordinal segments stay singleton groups
 * in their original order, unaffected by this function.
 */
function groupSegmentsByRecordingOrdinal(
  audioSegments: AudioSegment[],
  cycleStartMsByOrdinal: Map<number, number[]>,
): ChunkGroup[] {
  const groups: ChunkGroup[] = [];
  const byOrdinalAndCycle = new Map<string, ChunkGroup>();

  const indicesInCaptureOrder = audioSegments
    .map((_, index) => index)
    .sort((a, b) => audioSegments[a].ordinal - audioSegments[b].ordinal);

  for (const index of indicesInCaptureOrder) {
    const s = audioSegments[index];
    if (s.recording_ordinal == null) {
      groups.push({ ordinal: null, memberIdx: [index] });
      continue;
    }
    const ordinal = s.recording_ordinal;
    const cycles = cycleStartMsByOrdinal.get(ordinal) ?? [];
    let cycleKey = 0;
    if (cycles.length > 1) {
      const segWallMs = wallTimeMs(s.started_at_utc);
      let bestIdx = 0;
      let bestPreceding = Number.NEGATIVE_INFINITY;
      let hasPreceding = false;
      for (let c = 0; c < cycles.length; c += 1) {
        if (segWallMs != null && cycles[c] <= segWallMs && cycles[c] > bestPreceding) {
          bestPreceding = cycles[c];
          bestIdx = c;
          hasPreceding = true;
        }
      }
      cycleKey = hasPreceding ? bestIdx : 0;
    }
    const key = `${ordinal}:${cycleKey}`;
    const existing = byOrdinalAndCycle.get(key);
    if (existing) {
      existing.memberIdx.push(index);
    } else {
      const g: ChunkGroup = { ordinal, memberIdx: [index] };
      byOrdinalAndCycle.set(key, g);
      groups.push(g);
    }
  }
  return groups;
}

/**
 * Assign each chunk group to the closest unused recording interval by wall clock.
 * Non-null-ordinal groups target the interval(s) sharing their ordinal directly (D4: a
 * group never scatters across, or steals, another recording's interval); when an ordinal
 * has no paired interval at all (crash), the group falls through to the unmatched/chained
 * fallback below, same as today. Null-ordinal groups (singletons) use the pre-existing
 * wall-clock-nearest matching against whatever intervals remain. Remaining intervals
 * become placeholders (no matching file); remaining groups' members are chained at the end.
 */
function matchAudioSegmentsToIntervalsGreedy(
  audioSegments: AudioSegment[],
  intervals: RecordingInterval[],
): GreedyMatchResult {
  const cycleStartMsByOrdinal = new Map<number, number[]>();
  for (const iv of intervals) {
    if (iv.ordinal == null) continue;
    const wm = wallTimeMs(iv.startEv.wall_time_utc);
    const arr = cycleStartMsByOrdinal.get(iv.ordinal) ?? [];
    arr.push(wm ?? Number.NEGATIVE_INFINITY);
    cycleStartMsByOrdinal.set(iv.ordinal, arr);
  }
  for (const arr of cycleStartMsByOrdinal.values()) arr.sort((a, b) => a - b);

  const groups = groupSegmentsByRecordingOrdinal(audioSegments, cycleStartMsByOrdinal);

  const ivMeta = intervals.map((iv, k) => ({
    iv,
    k,
    wallMs: wallTimeMs(iv.startEv.wall_time_utc),
  }));
  const ivByOrdinalSorted = new Map<number, typeof ivMeta>();
  for (const im of ivMeta) {
    if (im.iv.ordinal == null) continue;
    const arr = ivByOrdinalSorted.get(im.iv.ordinal) ?? [];
    arr.push(im);
    ivByOrdinalSorted.set(im.iv.ordinal, arr);
  }
  for (const arr of ivByOrdinalSorted.values()) {
    arr.sort(
      (a, b) => (a.wallMs ?? Number.NEGATIVE_INFINITY) - (b.wallMs ?? Number.NEGATIVE_INFINITY),
    );
  }
  const ivOrdinalCursor = new Map<number, number>();

  const usedIv = new Set<number>();
  const groupPairs: { memberIdx: number[]; iv: RecordingInterval }[] = [];
  const unresolvedGroups: ChunkGroup[] = [];

  for (const g of groups) {
    if (g.ordinal == null) {
      unresolvedGroups.push(g);
      continue;
    }
    const candidates = ivByOrdinalSorted.get(g.ordinal);
    const cursor = ivOrdinalCursor.get(g.ordinal) ?? 0;
    const im = candidates?.[cursor];
    if (im) {
      ivOrdinalCursor.set(g.ordinal, cursor + 1);
      usedIv.add(im.k);
      groupPairs.push({ memberIdx: g.memberIdx, iv: im.iv });
    } else {
      unresolvedGroups.push(g);
    }
  }

  // Null-ordinal (singleton) groups: pre-existing wall-clock-nearest matching against
  // whatever intervals a non-null group didn't already claim.
  const singletonMeta = unresolvedGroups
    .filter((g) => g.ordinal == null)
    .map((g) => ({
      g,
      index: g.memberIdx[0],
      wallMs: wallTimeMs(audioSegments[g.memberIdx[0]].started_at_utc),
    }));
  const singletonOrder = [...singletonMeta].sort((a, b) => {
    if (a.wallMs != null && b.wallMs != null && a.wallMs !== b.wallMs) return a.wallMs - b.wallMs;
    if (a.wallMs != null && b.wallMs == null) return -1;
    if (a.wallMs == null && b.wallMs != null) return 1;
    return a.index - b.index;
  });

  const matchedSingletonIdx = new Set<number>();
  for (const sm of singletonOrder) {
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
      if (im) {
        groupPairs.push({ memberIdx: [sm.index], iv: im.iv });
        matchedSingletonIdx.add(sm.index);
      }
    }
  }

  const stillUnresolved = unresolvedGroups.filter(
    (g) => g.ordinal != null || !matchedSingletonIdx.has(g.memberIdx[0]),
  );
  let unmatchedSegIdx = stillUnresolved.flatMap((g) => g.memberIdx);

  /*
   * Segments with no wall match (no started_at_utc, or an ordinal whose recording never
   * paired an interval) never get placed above; their log interval becomes a red
   * placeholder while the real file is chained at the end of the timeline. Pair remaining
   * groups to remaining intervals in chronological order (n-th group ↔ n-th unused
   * recording block) — a whole group locks to one interval, never splitting across.
   */
  const unusedIvSorted = ivMeta
    .filter((im) => !usedIv.has(im.k))
    .sort((a, b) => a.iv.startSec - b.iv.startSec || a.k - b.k);
  const unmatchedGroupsSorted = [...stillUnresolved].sort(
    (a, b) => a.memberIdx[0] - b.memberIdx[0],
  );
  const nLock = Math.min(unmatchedGroupsSorted.length, unusedIvSorted.length);
  for (let u = 0; u < nLock; u += 1) {
    const im = unusedIvSorted[u];
    usedIv.add(im.k);
    groupPairs.push({ memberIdx: unmatchedGroupsSorted[u].memberIdx, iv: im.iv });
  }

  const placeholders = ivMeta.filter((im) => !usedIv.has(im.k)).map((im) => im.iv);
  const matchedSeg = new Set(groupPairs.flatMap((p) => p.memberIdx));
  unmatchedSegIdx = audioSegments.map((_, idx) => idx).filter((idx) => !matchedSeg.has(idx));

  return { groupPairs, placeholders, unmatchedSegIdx };
}

/**
 * Place a chunk group's members within a matched interval (D4 / gate ruling E-A):
 * member position = `interval start + max(0, (started_at_utc(member) - wall_time_utc(
 * interval's start event)) / 1000)`. Fallbacks preserve pre-change behavior exactly:
 * unparseable event wall time -> the base (lowest-ordinal member) sits at the interval
 * start and follow-ons derive from the base's own `started_at_utc`; a member with
 * unparseable `started_at_utc` sits at the interval start if it is a singleton group,
 * otherwise it is left unplaced (falls through to the chain-at-end fallback).
 *
 * Each placed member's clip extends to the next placed member's position (the last to
 * `max(interval end, its own position + probed-or-fallback duration)`), so the interval
 * stays covered from the first surviving chunk by construction — a probe failure
 * (reflected only in `duration`, kept separate from the clip span) never uncovers the
 * interval — while a genuinely longer probed duration (paused-transport recordings, or a
 * last chunk whose own audio runs past the interval end) still gets its full width,
 * restoring pre-change over-run behavior.
 */
function placeChunkGroupWithinInterval(
  memberIdx: number[],
  iv: RecordingInterval,
  audioSegments: AudioSegment[],
  segmentDurations: (number | null)[],
): { placed: AudioClipLite[]; unplacedIdx: number[] } {
  const startSec = safeTimelineSec(iv.startSec, 0);
  const endSec = Math.max(safeTimelineSec(iv.endSec, startSec), startSec + 0.05);
  const eventWallMs = wallTimeMs(iv.startEv.wall_time_utc);
  const isSingleton = memberIdx.length === 1;
  const baseIdx = memberIdx[0];
  const baseWallMs = wallTimeMs(audioSegments[baseIdx].started_at_utc);

  const positioned: { idx: number; pos: number }[] = [];
  const unplacedIdx: number[] = [];

  for (const idx of memberIdx) {
    const memberWallMs = wallTimeMs(audioSegments[idx].started_at_utc);
    if (memberWallMs == null) {
      if (isSingleton) {
        positioned.push({ idx, pos: startSec });
      } else {
        unplacedIdx.push(idx);
      }
      continue;
    }
    if (eventWallMs != null) {
      positioned.push({ idx, pos: startSec + Math.max(0, (memberWallMs - eventWallMs) / 1000) });
    } else if (idx === baseIdx) {
      positioned.push({ idx, pos: startSec });
    } else if (baseWallMs != null) {
      positioned.push({ idx, pos: startSec + Math.max(0, (memberWallMs - baseWallMs) / 1000) });
    } else {
      positioned.push({ idx, pos: startSec });
    }
  }

  positioned.sort((a, b) => a.pos - b.pos || a.idx - b.idx);

  const placed: AudioClipLite[] = [];
  for (let i = 0; i < positioned.length; i += 1) {
    const { idx, pos } = positioned[i];
    const clipStart = Math.max(startSec, pos);
    const dRaw = Number(segmentDurations[idx]);
    const d = Number.isFinite(dRaw) && dRaw > 0 ? dRaw : 1;
    const clipEnd =
      i + 1 < positioned.length
        ? Math.max(clipStart, positioned[i + 1].pos)
        : Math.max(endSec, pos + d);
    placed.push({
      segmentId: audioSegments[idx].id,
      url: audioSegments[idx].url,
      startSec: clipStart,
      endSec: Math.max(clipEnd, clipStart + 0.05),
      duration: d,
      missingAudio: false,
    });
  }

  return { placed, unplacedIdx };
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

  // Group segments sharing a `recording_ordinal` into chunk groups (D4) so the whole
  // group competes for its ordinal's start event ONCE, instead of each member competing
  // separately (which would strand every member past the first behind the chain-at-end
  // fallback). The legacy path never sees multiple same-N cycles (parseable `Recording N`
  // events would have produced non-empty `intervals` and routed away from this path), so
  // grouping needs no cycle-adjacency split here -- one group per non-null ordinal.
  const groups = groupSegmentsByRecordingOrdinal(audioSegments, new Map());

  const assignedOrd = new Map<ChunkGroup, number>();
  const usedOrd = new Set<number>();

  for (const g of groups) {
    const raw = g.ordinal;
    if (raw == null) continue;
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 1) continue;
    if (!startEventByOrd.has(n) || usedOrd.has(n)) continue;
    assignedOrd.set(g, n);
    usedOrd.add(n);
  }

  const wallMatchMaxMs = 10 * 60 * 1000;
  for (const g of groups) {
    if (assignedOrd.has(g)) continue;
    const segStart = wallTimeMs(audioSegments[g.memberIdx[0]].started_at_utc);
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
      assignedOrd.set(g, bestN);
      usedOrd.add(bestN);
    }
  }

  const stillGroups = groups.filter((g) => !assignedOrd.has(g));
  const freeOrds = recordingOrdinals.filter((n) => !usedOrd.has(n));
  for (let k = 0; k < stillGroups.length && k < freeOrds.length; k += 1) {
    assignedOrd.set(stillGroups[k], freeOrds[k]);
    usedOrd.add(freeOrds[k]);
  }

  const out: AudioClipLite[] = [];
  for (const g of groups) {
    const n = assignedOrd.get(g);
    if (n != null && startEventByOrd.has(n)) {
      const startEv = startEventByOrd.get(n);
      if (!startEv) continue; // unreachable (guarded by has() above); satisfies TS narrowing
      const stopSec = stopSecByOrd.get(n);
      const startSec = eventTimelineSec(startEv, status);
      const iv: RecordingInterval = {
        ordinal: n,
        startEv,
        stopEv: startEv,
        startSec: startSec >= 0 ? startSec : out.length ? out[out.length - 1].endSec : 0,
        endSec: stopSec != null ? stopSec : Number.NaN,
      };
      const fallbackEnd = out.length ? out[out.length - 1].endSec : 0;
      if (!(iv.endSec >= iv.startSec)) {
        // No paired stop event: each member falls back to start + its own duration,
        // chained onto its predecessor within the group (mirrors the pre-group per-segment
        // `startSec + d` fallback).
        let cursor = iv.startSec;
        for (const idx of g.memberIdx) {
          const dRaw = Number(segmentDurations[idx]);
          const d = Number.isFinite(dRaw) && dRaw > 0 ? dRaw : 1;
          const startSecMember = out.length ? Math.max(cursor, fallbackEnd) : cursor;
          const endSecMember = Math.max(startSecMember + d, startSecMember + 0.05);
          cursor = endSecMember;
          out.push({
            segmentId: audioSegments[idx].id,
            url: audioSegments[idx].url,
            startSec: startSecMember,
            endSec: endSecMember,
            duration: d,
            missingAudio: false,
          });
        }
        continue;
      }
      const { placed, unplacedIdx } = placeChunkGroupWithinInterval(
        g.memberIdx,
        iv,
        audioSegments,
        segmentDurations,
      );
      out.push(...placed);
      for (const idx of unplacedIdx) {
        const dRaw = Number(segmentDurations[idx]);
        const d = Number.isFinite(dRaw) && dRaw > 0 ? dRaw : 1;
        const startSecMember = out.length ? out[out.length - 1].endSec : 0;
        const endSecMember = Math.max(startSecMember + d, startSecMember + 0.05);
        out.push({
          segmentId: audioSegments[idx].id,
          url: audioSegments[idx].url,
          startSec: startSecMember,
          endSec: endSecMember,
          duration: d,
          missingAudio: false,
        });
      }
      continue;
    }
    /* Unresolved group (no ordinal assignment) -- the group's base index-pairs against
     * sorted start/stop events by its ABSOLUTE segment position (upload order ≈ log
     * order), exactly as the pre-group per-segment fallback did (preserves index-pairing
     * bit-identically for the common singleton case). Any additional group members (a
     * same-ordinal group whose ordinal never appeared as a `Recording N` event at all --
     * no index-pairing slot existed for these before grouping either) chain at the end. */
    for (let m = 0; m < g.memberIdx.length; m += 1) {
      const idx = g.memberIdx[m];
      const dRaw = Number(segmentDurations[idx]);
      const d = Number.isFinite(dRaw) && dRaw > 0 ? dRaw : 1;
      let startSec: number;
      let endSec: number;
      if (m === 0) {
        const se = startEvents[idx];
        const te = stopEvents[idx];
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
      } else {
        startSec = out.length ? out[out.length - 1].endSec : 0;
        endSec = startSec + d;
      }
      endSec = Math.max(endSec, startSec + 0.05);
      out.push({
        segmentId: audioSegments[idx].id,
        url: audioSegments[idx].url,
        startSec,
        endSec,
        duration: d,
        missingAudio: false,
      });
    }
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

  const { groupPairs, placeholders, unmatchedSegIdx } = matchAudioSegmentsToIntervalsGreedy(
    audioSegments,
    intervals,
  );

  const out: AudioClipLite[] = [];
  const chainIdx = [...unmatchedSegIdx];

  for (const p of groupPairs) {
    const { placed, unplacedIdx } = placeChunkGroupWithinInterval(
      p.memberIdx,
      p.iv,
      audioSegments,
      segmentDurations,
    );
    out.push(...placed);
    chainIdx.push(...unplacedIdx);
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
  for (const i of [...chainIdx].sort((a, b) => a - b)) {
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
