// Timeline remapping of DeepGram words onto the session's SMPTE timeline
// (design D4 / spec "Timeline remapping of word timestamps"). Pure module —
// no hub/router access; server/src/routers/transcribe.ts (task 4.3) is the
// only caller, feeding its output straight into the `replaceTranscriptWords`
// hub RPC (task 4.2).
//
// A word's timeline position = anchor(segment) + (wordTime - segmentGroupOffset).
// anchor(segment) resolves via a 3-step chain:
//   1. ordinal match — the segment's `recording_ordinal` ↔ a `Recording N
//      Started` internal event parsed for the same N.
//   2. index pairing — the i-th still-unmatched segment (segment-ordinal
//      order) ↔ the i-th still-unmatched anchor event (time/ordinal order).
//   3. anchorless — no anchor; the segment's words are still stored, with
//      empty `session_time` and zeroed `start_sec`/`end_sec` (matching manual
//      inserts).
//
// Anchor seconds come from the start event's own stored
// `timecode_total_frames / frame_rate` (frame arithmetic) — never by
// re-parsing a formatted SMPTE string or recomputing from live transport
// state, which would be wrong after a restart.

import { formatSmpte, fromTotalFrames } from '../timecode';
import type { DeepgramWord } from './deepgram';
import type { SegmentOffset } from './audioMerge';

/** The subset of EventRpc fields anchor parsing needs — kept structural so
 * this module doesn't couple to the router-facing `EventRpc` type. */
export interface AnchorCandidateEvent {
  category: string;
  message: string;
  timecode_total_frames: number | null;
  frame_rate: number | null;
}

export interface RecordingStartAnchor {
  recordingOrdinal: number;
  /** Session-timeline seconds: `timecode_total_frames / frame_rate`. */
  anchorSeconds: number;
}

const RECORDING_STARTED_RE = /^Recording (\d+) Started$/;

/** Parse `internal`-category `Recording N Started` events into anchor
 * candidates. Frame arithmetic only — no SMPTE-string parsing. Events
 * missing usable frame data (no `timecode_total_frames`, or `frame_rate` <=
 * 0) are skipped: an anchor with no computable seconds can't anchor
 * anything. */
export function recordingStartAnchors(events: AnchorCandidateEvent[]): RecordingStartAnchor[] {
  const anchors: RecordingStartAnchor[] = [];
  for (const e of events) {
    if (String(e.category ?? '').toLowerCase() !== 'internal') continue;
    const m = RECORDING_STARTED_RE.exec(String(e.message ?? '').trim());
    if (!m) continue;
    const frameRate = Number(e.frame_rate);
    const totalFrames = e.timecode_total_frames;
    if (!(frameRate > 0) || totalFrames === null || totalFrames === undefined) continue;
    anchors.push({ recordingOrdinal: Number(m[1]), anchorSeconds: Number(totalFrames) / frameRate });
  }
  return anchors;
}

/** One audio segment's identity needed for anchor resolution + ordering —
 * decoupled from `AudioSegmentMeta` so this module doesn't need the session
 * layer. `path` correlates 1:1 with a `SegmentOffset.path` inside `groups`
 * (the caller resolves each segment's spooled blob path). */
export interface SegmentAnchorInfo {
  path: string;
  /** `session_audio_segments.ordinal` — orders anchorless words and breaks
   * ties in the index-pairing step. */
  ordinal: number;
  /** `session_audio_segments.recording_ordinal`; `null` for legacy segments
   * with no recorded ordinal. */
  recordingOrdinal: number | null;
}

export interface GroupWords {
  /** The merged group's per-segment offsets (`MergedGroup.segments`). */
  segments: SegmentOffset[];
  /** Words DeepGram returned for this group's file, in provider order
   * (chronological by group-file time). */
  words: DeepgramWord[];
}

export interface RemappedTranscriptWord {
  session_time: string;
  speaker: string;
  word: string;
  start_sec: number;
  end_sec: number;
}

/** Resolve each segment's timeline anchor via the 3-step chain and remap
 * every group's words onto the session timeline. Returns words in final
 * storage order: anchored words by remapped timeline position (ties by
 * cross-group processing order), then anchorless words grouped by segment
 * ordinal in within-segment time order. Ordinal assignment (contiguous from
 * 0) is the caller's job — `replaceTranscriptWords` assigns ordinals from
 * this array's order on insert. */
export function remapTranscriptWords(
  groups: GroupWords[],
  segmentInfo: SegmentAnchorInfo[],
  anchors: RecordingStartAnchor[],
  sessionFrameRate: number,
): RemappedTranscriptWord[] {
  const anchorSecondsByPath = resolveAnchors(segmentInfo, anchors);
  const infoByPath = new Map(segmentInfo.map((s) => [s.path, s]));

  interface Placed {
    ordinal: number;
    order: number;
    startSec: number | null;
    endSec: number | null;
    speaker: string;
    word: string;
  }

  const placed: Placed[] = [];
  let order = 0;
  for (const group of groups) {
    const segs = [...group.segments].sort((a, b) => a.offsetSeconds - b.offsetSeconds);
    for (const w of group.words) {
      const seg = segmentForOffset(segs, w.start);
      const info = seg ? (infoByPath.get(seg.path) ?? null) : null;
      const anchorSeconds = info ? (anchorSecondsByPath.get(info.path) ?? null) : null;
      const withinSegStart = seg ? w.start - seg.offsetSeconds : 0;
      const withinSegEnd = seg ? w.end - seg.offsetSeconds : 0;
      placed.push({
        ordinal: info?.ordinal ?? Number.MAX_SAFE_INTEGER,
        order: order++,
        startSec: anchorSeconds !== null ? anchorSeconds + withinSegStart : null,
        endSec: anchorSeconds !== null ? anchorSeconds + withinSegEnd : null,
        speaker: String(w.speaker),
        word: w.word,
      });
    }
  }

  const anchored = placed
    .filter((p): p is Placed & { startSec: number } => p.startSec !== null)
    .sort((a, b) => a.startSec - b.startSec || a.order - b.order);
  // Within one segment, `order` already preserves within-segment time order
  // (a segment's words are a contiguous chronological run in the provider's
  // per-group word list), so (ordinal, order) matches the spec's "grouped by
  // segment ordinal in within-segment time order" without recomputing offsets.
  const anchorless = placed
    .filter((p) => p.startSec === null)
    .sort((a, b) => a.ordinal - b.ordinal || a.order - b.order);

  const out: RemappedTranscriptWord[] = [];
  for (const p of anchored) {
    out.push({
      session_time: renderSmpte(p.startSec, sessionFrameRate),
      speaker: p.speaker,
      word: p.word,
      start_sec: p.startSec,
      end_sec: p.endSec as number,
    });
  }
  for (const p of anchorless) {
    out.push({ session_time: '', speaker: p.speaker, word: p.word, start_sec: 0, end_sec: 0 });
  }
  return out;
}

function renderSmpte(sec: number, frameRate: number): string {
  const totalFrames = Math.max(0, Math.round(sec * frameRate));
  return formatSmpte(fromTotalFrames(totalFrames, frameRate));
}

/** The segment whose `[offset, offset+duration)` range contains `t`
 * (group-file seconds): the last segment starting at/before `t` (a small
 * epsilon absorbs floating-point fuzz at a concat seam, and a word landing
 * past the final segment's nominal end — coarse provider quantization, per
 * the task 1.1 spike notes — still resolves to that last segment). Returns
 * null only when `segs` is empty. */
function segmentForOffset(segs: SegmentOffset[], t: number): SegmentOffset | null {
  let candidate: SegmentOffset | null = null;
  for (const s of segs) {
    if (s.offsetSeconds <= t + 1e-6) candidate = s;
    else break;
  }
  return candidate ?? segs[0] ?? null;
}

/** The 3-step anchor chain, returning a `path -> anchorSeconds` map covering
 * only segments that resolved an anchor. */
function resolveAnchors(
  segmentInfo: SegmentAnchorInfo[],
  anchors: RecordingStartAnchor[],
): Map<string, number> {
  const result = new Map<string, number>();
  const anchorUsed = anchors.map(() => false);

  // Anchor indices grouped by recording ordinal, each group sorted by
  // anchorSeconds — deterministic pick order if more than one anchor shares
  // an ordinal (a rare same-N re-run).
  const indicesByOrdinal = new Map<number, number[]>();
  anchors.forEach((a, i) => {
    const list = indicesByOrdinal.get(a.recordingOrdinal) ?? [];
    list.push(i);
    indicesByOrdinal.set(a.recordingOrdinal, list);
  });
  for (const list of indicesByOrdinal.values()) {
    list.sort((i, j) => anchors[i].anchorSeconds - anchors[j].anchorSeconds);
  }

  // Step 1: ordinal match, segments visited in segment-ordinal order so that
  // ties (multiple segments sharing a recording_ordinal) claim anchors
  // deterministically and any leftovers fall through to step 2.
  const sortedSegments = [...segmentInfo].sort((a, b) => a.ordinal - b.ordinal);
  const unmatchedSegments: SegmentAnchorInfo[] = [];
  for (const seg of sortedSegments) {
    const candidates = seg.recordingOrdinal !== null ? (indicesByOrdinal.get(seg.recordingOrdinal) ?? []) : [];
    const idx = candidates.find((i) => !anchorUsed[i]);
    if (idx !== undefined) {
      anchorUsed[idx] = true;
      result.set(seg.path, anchors[idx].anchorSeconds);
    } else {
      unmatchedSegments.push(seg);
    }
  }

  // Step 2: index pairing among what's left, in ordinal/time order.
  const remainingAnchorIdx = anchors
    .map((_, i) => i)
    .filter((i) => !anchorUsed[i])
    .sort((i, j) => anchors[i].anchorSeconds - anchors[j].anchorSeconds || anchors[i].recordingOrdinal - anchors[j].recordingOrdinal);
  const pairCount = Math.min(unmatchedSegments.length, remainingAnchorIdx.length);
  for (let k = 0; k < pairCount; k += 1) {
    result.set(unmatchedSegments[k].path, anchors[remainingAnchorIdx[k]].anchorSeconds);
  }

  // Step 3: anything left is anchorless — simply absent from `result`.
  return result;
}
