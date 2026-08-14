// Timeline remapping of DeepGram words onto the session's SMPTE timeline
// (design D4 / spec "Timeline remapping of word timestamps"). Pure module —
// no hub/router access; server/src/routers/transcribe.ts (task 4.3) is the
// only caller, feeding its output straight into the `replaceTranscriptWords`
// hub RPC (task 4.2).
//
// A word's timeline position = anchor(segment) + (wordTime - segmentGroupOffset).
// anchor(segment) resolves via a chunk-group chain (chunked-live-recording
// design D5 / spec "Timeline remapping of word timestamps"):
//   0. grouping — segments sharing a `recording_ordinal` form a chunk group
//      (null-ordinal segments are singleton groups); when multiple
//      `Recording N Started` anchors share an ordinal (a same-N re-run), the
//      group's segments split into per-cycle groups by pairing each segment
//      with the same-N anchor whose event wall time most nearly PRECEDES the
//      segment's `started_at_utc`, FIFO per ordinal. Each (sub)group's base
//      is its lowest-ordinal member.
//   1. ordinal match — a group's base ↔ the `Recording N Started` event
//      matched by the group's `recording_ordinal` (its resolved same-N
//      cycle, if split). Only bases claim step-1 anchors; bases are visited
//      in segment-ordinal order, one anchor per base.
//   2. index pairing — the i-th still-unmatched BASE (ordinal order) ↔ the
//      i-th still-unmatched anchor event (time/ordinal order). Non-base
//      members never participate.
//   3. anchorless — no anchor for the whole group; every member's words are
//      still stored, with empty `session_time` and zeroed `start_sec`/
//      `end_sec` (matching manual inserts).
//
// Given a group's resolved anchor `A` (event `E`), every member's own anchor
// is event-wall-time derived: `A + max(0, (started_at_utc(member) -
// wall_time_utc(E)) / 1000)` when both timestamps parse — so a member's
// placement never depends on which sibling chunks survived. Fallbacks
// preserve pre-change behavior exactly: unparseable event wall time -> the
// base anchors at `A` and non-base members derive from the base's
// `started_at_utc` instead; a member with unparseable `started_at_utc`
// anchors at `A` if it is its group's only member (the legacy single-segment
// shape), anchorless otherwise.
//
// Anchor seconds come from the start event's own stored
// `timecode_total_frames / frame_rate` (frame arithmetic) — never by
// re-parsing a formatted SMPTE string or recomputing from live transport
// state, which would be wrong after a restart.

import { formatSmpte, fromTotalFrames } from '@autologger/domain';
import type { SegmentOffset } from './audioMerge';
import type { DeepgramParagraph, DeepgramSentimentSegment, DeepgramWord } from './deepgram';

/** The subset of EventRpc fields anchor parsing needs — kept structural so
 * this module doesn't couple to the router-facing `EventRpc` type. */
export interface AnchorCandidateEvent {
  category: string;
  message: string;
  timecode_total_frames: number | null;
  frame_rate: number | null;
  /** chunked-live-recording task 3.1 (design D5) — the event's own stored
   * wall time, threaded through for the group-splitting / per-member
   * event-wall-time derivation `resolveAnchors` will gain in task 3.2.
   * Unused by `recordingStartAnchors` itself today; carried onto
   * `RecordingStartAnchor.eventWallTimeUtc` below. Optional so existing
   * callers passing the narrower pre-3.1 shape keep typechecking. */
  wall_time_utc?: string;
}

export interface RecordingStartAnchor {
  recordingOrdinal: number;
  /** Session-timeline seconds: `timecode_total_frames / frame_rate`. */
  anchorSeconds: number;
  /** chunked-live-recording task 3.1 (design D5) — the anchor event's own
   * `wall_time_utc`, carried through for task 3.2's per-member
   * event-wall-time derivation and same-N cycle-splitting. `null` when the
   * source event carried no `wall_time_utc` (structurally shouldn't happen —
   * every stored event has one — but kept nullable rather than assumed, same
   * posture as the frame fields above). */
  eventWallTimeUtc: string | null;
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
    anchors.push({
      recordingOrdinal: Number(m[1]),
      anchorSeconds: Number(totalFrames) / frameRate,
      eventWallTimeUtc: e.wall_time_utc ?? null,
    });
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
  /** chunked-live-recording task 3.1 (design D5) — the segment's own
   * `started_at_utc`, threaded through for task 3.2's per-member
   * event-wall-time derivation `A + max(0, (startedAtUtc - eventWallTimeUtc)
   * / 1000)`. `null`/absent for legacy/sync-from-disk segments with no
   * recorded wall time (the existing anchorless fallback) and for existing
   * test literals predating this field. Optional (not required) so this
   * task's typecheck-only change doesn't force an edit onto every pre-3.1
   * `SegmentAnchorInfo` object literal — `resolveAnchors` doesn't read it
   * yet (task 3.2 is the first consumer), and a missing key is
   * indistinguishable from `startedAtUtc: null` to every current caller.
   * Real callers (`generateTranscript.ts`) always set it explicitly. */
  startedAtUtc?: string | null;
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
function twoBucketOrder<T extends { ordinal: number; order: number; startSec: number | null }>(
  items: T[],
): T[] {
  const anchored = items
    .filter((p) => p.startSec !== null)
    .sort((a, b) => (a.startSec as number) - (b.startSec as number) || a.order - b.order);
  const anchorless = items
    .filter((p) => p.startSec === null)
    .sort((a, b) => a.ordinal - b.ordinal || a.order - b.order);
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

/** One chunk group after grouping + same-N cycle-splitting: `base` is the
 * lowest-ordinal member, `members` is every member (base included) in
 * segment-ordinal order. `pairedAnchorIndex` is set only when same-N
 * cycle-splitting picked a *specific* anchor (its index into the `anchors`
 * array passed to `resolveAnchors`) for this group — step 1 must claim
 * exactly that anchor rather than re-deriving one from ordinal/time order,
 * since a cycle's base ordinal and its paired anchor's time order aren't
 * guaranteed to co-vary (e.g. a discarded first chunk in one cycle). `null`
 * for ordinals with a single (or no) same-N anchor, where step 1's normal
 * "next unused anchor for this ordinal" lookup is unambiguous. */
interface ChunkGroup {
  base: SegmentAnchorInfo;
  members: SegmentAnchorInfo[];
  pairedAnchorIndex: number | null;
}

/** Group segments by `recordingOrdinal` (null -> singleton group each); when
 * more than one anchor shares an ordinal (a same-N re-run), split that
 * ordinal's segments into per-cycle groups by pairing each segment with the
 * same-N anchor whose event wall time most nearly PRECEDES the segment's
 * `started_at_utc`, FIFO per ordinal — mirroring the FIFO tie-break the rest
 * of the chain (step 1/2) already uses elsewhere. A segment with no
 * parseable `started_at_utc`, or when no candidate anchor precedes it, falls
 * back to the earliest not-yet-claimed same-N anchor (FIFO) so every segment
 * still lands in *some* same-N cycle group rather than being dropped from
 * grouping entirely — anchor resolution proper (steps 1-3) still runs on
 * whatever cycle group it landed in, so a genuinely unresolvable case surfaces
 * as anchorless there, not silently here. */
function buildChunkGroups(
  segmentInfo: SegmentAnchorInfo[],
  anchors: RecordingStartAnchor[],
): ChunkGroup[] {
  const byOrdinal = new Map<number | null, SegmentAnchorInfo[]>();
  for (const seg of segmentInfo) {
    const list = byOrdinal.get(seg.recordingOrdinal) ?? [];
    list.push(seg);
    byOrdinal.set(seg.recordingOrdinal, list);
  }

  // Anchor indices (into the original `anchors` array) grouped by ordinal,
  // each sorted by event wall time (unparseable sorts first via NaN's
  // Array.sort behavior — irrelevant here since FIFO fallback handles it).
  const anchorIndicesByOrdinal = new Map<number, number[]>();
  anchors.forEach((a, i) => {
    const list = anchorIndicesByOrdinal.get(a.recordingOrdinal) ?? [];
    list.push(i);
    anchorIndicesByOrdinal.set(a.recordingOrdinal, list);
  });
  for (const list of anchorIndicesByOrdinal.values()) {
    list.sort(
      (i, j) =>
        Date.parse(anchors[i].eventWallTimeUtc ?? '') -
        Date.parse(anchors[j].eventWallTimeUtc ?? ''),
    );
  }

  const groups: ChunkGroup[] = [];
  for (const [ordinal, members] of byOrdinal) {
    members.sort((a, b) => a.ordinal - b.ordinal);
    if (ordinal === null) {
      // Every null-ordinal segment is its own singleton group.
      for (const seg of members)
        groups.push({ base: seg, members: [seg], pairedAnchorIndex: null });
      continue;
    }
    const candidateIdx = anchorIndicesByOrdinal.get(ordinal) ?? [];
    if (candidateIdx.length <= 1) {
      // No same-N split possible/needed — one chunk group for the ordinal;
      // step 1 resolves its anchor the normal (unambiguous) way.
      groups.push({ base: members[0], members, pairedAnchorIndex: null });
      continue;
    }
    // Same-N re-run: split members across cycles keyed by nearest-preceding
    // anchor wall time, FIFO per ordinal.
    const cycles: SegmentAnchorInfo[][] = candidateIdx.map(() => []);
    for (const seg of members) {
      const segMs = seg.startedAtUtc ? Date.parse(seg.startedAtUtc) : NaN;
      let chosen = -1;
      if (Number.isFinite(segMs)) {
        // Nearest-preceding: last candidate anchor whose wall time <= seg's.
        for (let i = 0; i < candidateIdx.length; i += 1) {
          const eventMs = Date.parse(anchors[candidateIdx[i]].eventWallTimeUtc ?? '');
          if (Number.isFinite(eventMs) && eventMs <= segMs) chosen = i;
        }
      }
      if (chosen === -1) {
        // No parseable timestamp, or none precedes: FIFO to the earliest
        // cycle that hasn't claimed a member yet, else the first cycle.
        chosen = cycles.findIndex((c) => c.length === 0);
        if (chosen === -1) chosen = 0;
      }
      cycles[chosen].push(seg);
    }
    cycles.forEach((cycleMembers, i) => {
      if (cycleMembers.length === 0) return;
      cycleMembers.sort((a, b) => a.ordinal - b.ordinal);
      groups.push({
        base: cycleMembers[0],
        members: cycleMembers,
        pairedAnchorIndex: candidateIdx[i],
      });
    });
  }
  return groups;
}

/** The chunk-group anchor chain (design D5 / spec "Timeline remapping of
 * word timestamps"), returning a `path -> anchorSeconds` map covering every
 * member (base and non-base) whose group resolved an anchor and whose own
 * event-wall-time derivation succeeded. */
function resolveAnchors(
  segmentInfo: SegmentAnchorInfo[],
  anchors: RecordingStartAnchor[],
): Map<string, number> {
  const result = new Map<string, number>();
  const anchorUsed = anchors.map(() => false);

  const groups = buildChunkGroups(segmentInfo, anchors);

  // Anchor indices grouped by recording ordinal, each group sorted by
  // anchorSeconds — deterministic pick order for step 1's un-split-ordinal
  // case (an ordinal with zero or one same-N anchor; same-N-split groups use
  // `pairedAnchorIndex` above instead).
  const indicesByOrdinal = new Map<number, number[]>();
  anchors.forEach((a, i) => {
    const list = indicesByOrdinal.get(a.recordingOrdinal) ?? [];
    list.push(i);
    indicesByOrdinal.set(a.recordingOrdinal, list);
  });
  for (const list of indicesByOrdinal.values()) {
    list.sort((i, j) => anchors[i].anchorSeconds - anchors[j].anchorSeconds);
  }

  // Step 1: ordinal match, BASES visited in segment-ordinal order so that
  // ties (multiple groups sharing a recording_ordinal, i.e. same-N cycles)
  // claim anchors deterministically and any leftovers fall through to step 2.
  // Non-base members never claim a step-1 anchor. A group with a
  // `pairedAnchorIndex` (same-N cycle-split already chose its specific
  // anchor by nearest-preceding wall time) claims exactly that anchor —
  // the generic "next unused anchor for this ordinal" lookup is only used
  // for un-split ordinals, since a cycle's base ordinal and its anchor's
  // time order aren't guaranteed to co-vary (e.g. a discarded first chunk).
  const sortedGroups = [...groups].sort((a, b) => a.base.ordinal - b.base.ordinal);
  const unmatchedGroups: ChunkGroup[] = [];
  const resolved = new Map<
    ChunkGroup,
    { anchorSeconds: number; eventWallTimeUtc: string | null }
  >();
  for (const group of sortedGroups) {
    const seg = group.base;
    let idx: number | undefined;
    if (group.pairedAnchorIndex !== null) {
      idx = anchorUsed[group.pairedAnchorIndex] ? undefined : group.pairedAnchorIndex;
    } else {
      const candidates =
        seg.recordingOrdinal !== null ? (indicesByOrdinal.get(seg.recordingOrdinal) ?? []) : [];
      idx = candidates.find((i) => !anchorUsed[i]);
    }
    if (idx !== undefined) {
      anchorUsed[idx] = true;
      resolved.set(group, {
        anchorSeconds: anchors[idx].anchorSeconds,
        eventWallTimeUtc: anchors[idx].eventWallTimeUtc,
      });
    } else {
      unmatchedGroups.push(group);
    }
  }

  // Step 2: index pairing among remaining unmatched BASES and unused
  // anchors, in ordinal/time order. Non-base members never index-pair.
  const remainingAnchorIdx = anchors
    .map((_, i) => i)
    .filter((i) => !anchorUsed[i])
    .sort(
      (i, j) =>
        anchors[i].anchorSeconds - anchors[j].anchorSeconds ||
        anchors[i].recordingOrdinal - anchors[j].recordingOrdinal,
    );
  const pairCount = Math.min(unmatchedGroups.length, remainingAnchorIdx.length);
  for (let k = 0; k < pairCount; k += 1) {
    const idx = remainingAnchorIdx[k];
    resolved.set(unmatchedGroups[k], {
      anchorSeconds: anchors[idx].anchorSeconds,
      eventWallTimeUtc: anchors[idx].eventWallTimeUtc,
    });
  }

  // Step 3: any group left unresolved is anchorless — every member absent
  // from `result`.

  // Per-member event-wall-time derivation against each group's resolved
  // anchor (or nothing, for anchorless groups).
  for (const group of groups) {
    const anchor = resolved.get(group);
    if (!anchor) continue; // whole group anchorless
    const { anchorSeconds: A, eventWallTimeUtc } = anchor;
    const eventMs = eventWallTimeUtc ? Date.parse(eventWallTimeUtc) : NaN;
    const eventWallTimeParses = Number.isFinite(eventMs);
    const baseStartedMs = group.base.startedAtUtc ? Date.parse(group.base.startedAtUtc) : NaN;

    for (const member of group.members) {
      const isBase = member === group.base;
      const memberStartedMs = member.startedAtUtc ? Date.parse(member.startedAtUtc) : NaN;
      const memberStartedParses = Number.isFinite(memberStartedMs);

      if (eventWallTimeParses && memberStartedParses) {
        result.set(member.path, A + Math.max(0, (memberStartedMs - eventMs) / 1000));
        continue;
      }

      if (!eventWallTimeParses) {
        // Fallback: unparseable event wall time -> base at A, non-base
        // derives from the base's own started_at_utc.
        if (isBase) {
          result.set(member.path, A);
        } else if (memberStartedParses && Number.isFinite(baseStartedMs)) {
          result.set(member.path, A + Math.max(0, (memberStartedMs - baseStartedMs) / 1000));
        }
        // else: base's own started_at_utc unparseable too -> member stays
        // anchorless (falls through, nothing set).
        continue;
      }

      // eventWallTimeParses but this member's own started_at_utc doesn't:
      // singleton group -> A (legacy single-segment shape); otherwise
      // anchorless.
      if (group.members.length === 1) {
        result.set(member.path, A);
      }
      // else: anchorless — nothing set.
    }
  }

  return result;
}
