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
import type { DeepgramParagraph, DeepgramSentimentSegment, DeepgramWord } from './deepgram';
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

/** One group's enrichment (design D1/D2) alongside the same `segments`/`words`
 * `GroupWords` already carries — sentiment `start_word`/`end_word` index into
 * `words`, and paragraphs anchor through the same `segments` chain, so both
 * need the group's own word/segment context to resolve, not just its own
 * seconds/indices in isolation. */
export interface EnrichmentGroup extends GroupWords {
  paragraphs: DeepgramParagraph[];
  sentiments: DeepgramSentimentSegment[];
}

/** A paragraph remapped onto the session timeline (spec "Enrichment timeline
 * remapping"). `start_sec`/`end_sec` are `null` when the paragraph's group
 * (or its anchoring segment) has no resolvable recording-start anchor —
 * distinct from a genuine `0` (never-zeros-as-data contract). */
export interface RemappedParagraph {
  start_sec: number | null;
  end_sec: number | null;
  speaker: string;
  text: string;
}

/** A sentiment segment remapped onto the session timeline. `start_sec`/
 * `end_sec` are `null` when anchorless OR when the index-base guard (D9)
 * degraded a mismatched segment — either way the segment is still returned,
 * never dropped (except the zero-word-group case, which drops it). */
export interface RemappedSentimentSegment {
  start_sec: number | null;
  end_sec: number | null;
  sentiment: string;
  sentiment_score: number;
  text: string;
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
      const resolved = resolveGroupInterval(w.start, w.end, segs, anchorSecondsByPath, infoByPath);
      placed.push({
        ordinal: resolved.info?.ordinal ?? Number.MAX_SAFE_INTEGER,
        order: order++,
        startSec: resolved.startSec,
        endSec: resolved.endSec,
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

/** Resolve each group's paragraph/sentiment enrichment onto the session
 * timeline (spec "Enrichment timeline remapping", design D2) — **per group,
 * using that group's own anchor context, before any global merge/sort**,
 * because sentiment `start_word`/`end_word` indices and paragraph group-file
 * seconds are only meaningful within their own group's word slice. Reuses
 * the same anchor chain (`resolveAnchors`) and per-interval resolution
 * (`resolveGroupInterval`) `remapTranscriptWords` uses for words — never
 * reconstructs positions from an already-sorted word array. Never throws;
 * never fails a word-bearing run (all failure modes degrade/clamp/drop per
 * the spec, they never propagate an exception).
 *
 * Output order matches the two-bucket order words use: anchored (non-NULL
 * `start_sec`) by `start_sec` ascending with a stable secondary key, then
 * anchorless (NULL `start_sec`) in group/segment order — so a caller can
 * assign contiguous ordinals by array position. */
export function remapTranscriptEnrichment(
  groups: EnrichmentGroup[],
  segmentInfo: SegmentAnchorInfo[],
  anchors: RecordingStartAnchor[],
): { paragraphs: RemappedParagraph[]; sentiment: RemappedSentimentSegment[] } {
  const anchorSecondsByPath = resolveAnchors(segmentInfo, anchors);
  const infoByPath = new Map(segmentInfo.map((s) => [s.path, s]));

  interface PlacedParagraph {
    ordinal: number;
    order: number;
    startSec: number | null;
    endSec: number | null;
    speaker: string;
    text: string;
  }
  interface PlacedSentiment {
    ordinal: number;
    order: number;
    startSec: number | null;
    endSec: number | null;
    sentiment: string;
    sentiment_score: number;
    text: string;
  }

  const placedParagraphs: PlacedParagraph[] = [];
  const placedSentiments: PlacedSentiment[] = [];
  let paraOrder = 0;
  let sentOrder = 0;

  for (const group of groups) {
    const segs = [...group.segments].sort((a, b) => a.offsetSeconds - b.offsetSeconds);

    // Paragraphs: anchored as a single interval — both `start` and `end`
    // resolve against the segment containing `start` (design D2), so a
    // paragraph straddling a concat seam keeps a coherent duration.
    for (const p of group.paragraphs) {
      const resolved = resolveGroupInterval(p.start, p.end, segs, anchorSecondsByPath, infoByPath);
      const startSec = resolved.startSec;
      const endSec = startSec === null ? null : Math.max(resolved.endSec ?? startSec, startSec);
      placedParagraphs.push({
        ordinal: resolved.info?.ordinal ?? Number.MAX_SAFE_INTEGER,
        order: paraOrder++,
        startSec,
        endSec,
        speaker: String(p.speaker),
        text: p.text,
      });
    }

    // Sentiment: a zero-word group can't index anything — drop, per spec.
    const wordCount = group.words.length;
    if (wordCount === 0) continue;

    // One resolution pass over the group's own words, shared with the words
    // path's per-word resolution logic via `resolveGroupInterval` — no
    // duplicated anchor/offset chain, and never derived from a merged/sorted
    // word array.
    const wordPositions = group.words.map((word) =>
      resolveGroupInterval(word.start, word.end, segs, anchorSecondsByPath, infoByPath),
    );

    for (const s of group.sentiments) {
      const startIdx = clampWordIndex(s.start_word, wordCount);
      const endIdx = Math.max(clampWordIndex(s.end_word, wordCount), startIdx);

      const indexBaseOk = wordAtIndexMatchesLeadingToken(group.words[startIdx], s.text);
      const startResolved = wordPositions[startIdx];
      const endResolved = wordPositions[endIdx];
      const bothAnchored = startResolved.startSec !== null && endResolved.endSec !== null;

      const startSec = indexBaseOk && bothAnchored ? (startResolved.startSec as number) : null;
      const endSec =
        indexBaseOk && bothAnchored
          ? Math.max(endResolved.endSec as number, startResolved.startSec as number)
          : null;

      placedSentiments.push({
        ordinal: startResolved.info?.ordinal ?? Number.MAX_SAFE_INTEGER,
        order: sentOrder++,
        startSec,
        endSec,
        sentiment: s.sentiment,
        sentiment_score: s.sentiment_score,
        text: s.text,
      });
    }
  }

  return {
    paragraphs: twoBucketOrder(placedParagraphs).map((p) => ({
      start_sec: p.startSec,
      end_sec: p.endSec,
      speaker: p.speaker,
      text: p.text,
    })),
    sentiment: twoBucketOrder(placedSentiments).map((s) => ({
      start_sec: s.startSec,
      end_sec: s.endSec,
      sentiment: s.sentiment,
      sentiment_score: s.sentiment_score,
      text: s.text,
    })),
  };
}

/** Anchored-by-`start_sec`-then-anchorless-by-group/segment-order, the same
 * two-bucket order `remapTranscriptWords` uses. */
function twoBucketOrder<T extends { ordinal: number; order: number; startSec: number | null }>(items: T[]): T[] {
  const anchored = items
    .filter((p) => p.startSec !== null)
    .sort((a, b) => (a.startSec as number) - (b.startSec as number) || a.order - b.order);
  const anchorless = items.filter((p) => p.startSec === null).sort((a, b) => a.ordinal - b.ordinal || a.order - b.order);
  return [...anchored, ...anchorless];
}

/** Out-of-range, negative, or non-integer indices clamp into the group's
 * valid word-index range `[0, length - 1]` (spec: "clamped to the group's
 * word bounds"). A non-integer index truncates toward zero before bounding —
 * e.g. `2.9` -> `2` -- rather than rounding, since a fractional provider
 * index has no natural "nearest word" semantics to round to. `length` is
 * always >= 1 here (callers only reach this after the zero-word-group
 * guard). */
function clampWordIndex(raw: number, length: number): number {
  const truncated = Number.isFinite(raw) ? Math.trunc(raw) : 0;
  return Math.min(Math.max(truncated, 0), length - 1);
}

/** Index-base guard (design D9): a sentiment segment's leading `text` token
 * must match the word at its (clamped) `start_word` index, or the segment is
 * degraded to anchorless rather than trusting a possibly-wrong span. An
 * empty/whitespace-only segment `text` can't be verified and is treated as a
 * mismatch (degrade), the conservative choice. */
function wordAtIndexMatchesLeadingToken(word: DeepgramWord | undefined, text: string): boolean {
  if (!word) return false;
  const leading = text.trim().split(/\s+/)[0];
  return leading !== undefined && leading !== '' && leading === word.word;
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

/** Shared per-group interval resolution — the seam `remapTranscriptWords`
 * and `remapTranscriptEnrichment` both consume, so the anchor/offset chain
 * for "one group-file `[startT, endT)` -> session-timeline seconds" is
 * computed exactly once. `startT`/`endT` are treated as a single-anchor
 * unit: the owning segment is resolved from `startT` alone, and `endT` is
 * offset against that *same* segment/anchor — this is what makes a
 * word or a paragraph interval that straddles a concat seam keep a
 * coherent duration instead of jumping anchors mid-span. Returns `{ startSec:
 * null, endSec: null }` (never partially-null) when the owning segment has
 * no resolvable anchor; `info` is still returned (even when anchorless) so
 * callers can order/group anchorless items by segment ordinal. */
function resolveGroupInterval(
  startT: number,
  endT: number,
  segs: SegmentOffset[],
  anchorSecondsByPath: Map<string, number>,
  infoByPath: Map<string, SegmentAnchorInfo>,
): { startSec: number | null; endSec: number | null; info: SegmentAnchorInfo | null } {
  const seg = segmentForOffset(segs, startT);
  const info = seg ? (infoByPath.get(seg.path) ?? null) : null;
  const anchorSeconds = info ? (anchorSecondsByPath.get(info.path) ?? null) : null;
  if (anchorSeconds === null || !seg) {
    return { startSec: null, endSec: null, info };
  }
  return {
    startSec: anchorSeconds + (startT - seg.offsetSeconds),
    endSec: anchorSeconds + (endT - seg.offsetSeconds),
    info,
  };
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
