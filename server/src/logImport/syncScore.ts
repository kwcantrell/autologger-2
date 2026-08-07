/** Score-based transcript ↔ log-message alignment for sheets-log-import. */

export const SOLID_SCORE = 4.5;
export const DECENT_SCORE = 2.5;
export const OFFSET_AGREE_S = 60;

export function normalizeToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, '')
    .trim();
}

export function tokenize(text: string): string[] {
  return text.split(/\s+/).map(normalizeToken).filter(Boolean);
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

function tokenScore(a: string, b: string): number {
  if (a === b) return 1;
  if (
    a.length >= 4 &&
    b.length >= 4 &&
    (a.startsWith(b.slice(0, 4)) || b.startsWith(a.slice(0, 4)))
  ) {
    return 0.7;
  }
  if (editDistance(a, b) <= 1) return 0.7;
  return 0;
}

export interface TranscriptToken {
  word: string;
  startSec: number;
}

export interface AlignCandidate {
  score: number;
  transcriptStartSec: number;
  sheetSec: number;
  offsetSec: number;
  matchedTokens: number;
  message: string;
}

export function findAlignmentCandidates(
  message: string,
  sheetSec: number,
  transcript: TranscriptToken[],
): AlignCandidate[] {
  const msgTokens = tokenize(message);
  if (msgTokens.length < 3) return [];
  const tx = transcript.map((t) => ({ ...t, norm: normalizeToken(t.word) })).filter((t) => t.norm);

  const out: AlignCandidate[] = [];
  for (let i = 0; i < tx.length; i++) {
    let score = 0;
    let matched = 0;
    let j = 0;
    let k = i;
    while (j < msgTokens.length && k < tx.length) {
      const s = tokenScore(msgTokens[j], tx[k].norm);
      if (s <= 0) break;
      score += s;
      matched += 1;
      j += 1;
      k += 1;
    }
    if (matched >= 3 && score >= DECENT_SCORE) {
      const transcriptStartSec = tx[i].startSec;
      out.push({
        score,
        transcriptStartSec,
        sheetSec,
        offsetSec: transcriptStartSec - sheetSec,
        matchedTokens: matched,
        message,
      });
    }
  }
  out.sort((a, b) => b.score - a.score || a.sheetSec - b.sheetSec);
  return out;
}

export function isSolid(c: AlignCandidate): boolean {
  return c.score >= SOLID_SCORE;
}

export function isDecent(c: AlignCandidate): boolean {
  return c.score >= DECENT_SCORE;
}

export interface LogRow {
  sheetSec: number;
  message: string;
  type: string;
}

export interface SeamPart {
  duration_s: number;
}

export interface PartSyncResult {
  partIndex: number;
  offsetSec: number;
  sheetStart: number;
  sheetEnd: number;
  ref: AlignCandidate;
  confidence: number;
}

/**
 * Compute per-part offsets and assign rows. Throws Error with message on fail rules.
 */
export function syncLogRowsToSeams(
  rows: LogRow[],
  parts: SeamPart[],
  transcript: TranscriptToken[],
): {
  parts: PartSyncResult[];
  assignments: Array<{ row: LogRow; partIndex: number; sessionSec: number }>;
} {
  if (parts.length === 0) throw new Error('No audio seam parts available.');
  if (transcript.length === 0) throw new Error('Transcript is empty.');

  const partResults: PartSyncResult[] = [];
  const assignments: Array<{ row: LogRow; partIndex: number; sessionSec: number }> = [];

  let sheetStart = 0;
  for (let i = 0; i < parts.length; i++) {
    const D = parts[i].duration_s;
    // Bootstrap: candidates whose sheet time falls in an expanded window around this part.
    // For part 0, consider rows with sheetSec in [0, D + 120] to allow positive sheet clock.
    // After O known, refine window.
    const roughEnd = sheetStart + D + 120;
    const windowRows = rows.filter((r) => r.sheetSec >= sheetStart - 1 && r.sheetSec <= roughEnd);

    const candidates: AlignCandidate[] = [];
    for (const row of windowRows) {
      // Restrict transcript search to this part's session-time span (±slack) once prior offsets known.
      const sessionLo = partResults.reduce((acc, p) => acc + parts[p.partIndex].duration_s, 0) - 30;
      const sessionHi = sessionLo + D + 60;
      const txSlice = transcript.filter(
        (t) => t.startSec >= Math.max(0, sessionLo) && t.startSec <= sessionHi + 120,
      );
      const search = txSlice.length ? txSlice : transcript;
      candidates.push(...findAlignmentCandidates(row.message, row.sheetSec, search));
    }

    let chosen: AlignCandidate | null = null;
    if (i === 0) {
      const solids = candidates.filter(isSolid).sort((a, b) => a.sheetSec - b.sheetSec);
      if (solids.length === 0) throw new Error('Part 0 sync failed: no solid transcript match.');
      chosen = solids[0];
    } else {
      const decent = candidates.filter(isDecent).sort((a, b) => a.sheetSec - b.sheetSec);
      const solids = decent.filter(isSolid);
      if (solids.length === 1 && decent.length === 1) {
        chosen = solids[0];
      } else if (decent.length >= 2) {
        const a = decent[0];
        const b = decent[1];
        if (Math.abs(a.offsetSec - b.offsetSec) >= OFFSET_AGREE_S) {
          throw new Error(
            `Part ${i} sync failed: reference offsets disagree by ≥${OFFSET_AGREE_S}s.`,
          );
        }
        chosen = a;
      } else if (solids.length >= 1) {
        chosen = solids[0];
      } else {
        throw new Error(`Part ${i} sync failed: insufficient decent transcript matches.`);
      }
    }

    const O = chosen.offsetSec;
    const sheetEnd = sheetStart + D - O;
    partResults.push({
      partIndex: i,
      offsetSec: O,
      sheetStart,
      sheetEnd,
      ref: chosen,
      confidence: chosen.score,
    });
    sheetStart = sheetEnd + 1;
  }

  for (const row of rows) {
    // Windows are CONTIGUOUS: part i owns [sheetStart, part i+1's sheetStart).
    // `sheetEnd` is generally FRACTIONAL (duration − offset) while row.sheetSec
    // is an integer, so a closed-interval test (`<= sheetEnd`) leaves a gap
    // between part i's sheetEnd (e.g. 100.4) and part i+1's sheetStart
    // (101.4): a row at 101 matched NO part and was silently mishandled by the
    // fallback below. A gap row belongs to the tail of part i — the stretch of
    // audio whose transcript-derived offset was computed for it — so part i's
    // window extends to just under part i+1's start. Rows strictly inside a
    // window are unaffected. The LAST part stays closed at its own sheetEnd;
    // rows past it take the past-end fallback below.
    const part = partResults.find((p, idx) => {
      if (row.sheetSec < p.sheetStart) return false;
      const next = partResults[idx + 1];
      return next ? row.sheetSec < next.sheetStart : row.sheetSec <= p.sheetEnd;
    });
    if (!part) {
      // Assign to last part if past end (clock rounding).
      const last = partResults[partResults.length - 1];
      if (row.sheetSec > last.sheetEnd) {
        assignments.push({
          row,
          partIndex: last.partIndex,
          sessionSec: row.sheetSec + last.offsetSec,
        });
      }
      continue;
    }
    assignments.push({
      row,
      partIndex: part.partIndex,
      sessionSec: row.sheetSec + part.offsetSec,
    });
  }

  return { parts: partResults, assignments };
}
