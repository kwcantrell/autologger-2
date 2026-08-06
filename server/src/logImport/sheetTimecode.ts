/** Parse sheet log timecodes like `8:48`, `1:07:05`, `00:08:48` → seconds (frame 0). */

export function parseSheetTimecodeToSeconds(raw: string): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const parts = s.split(':').map((p) => p.trim());
  if (parts.length < 2 || parts.length > 4) return null;
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  const nums = parts.map((p) => Number(p));
  // Drop frames if present (HH:MM:SS:FF) — treat as wall clock at ff=0 for import.
  const clock = nums.length === 4 ? nums.slice(0, 3) : nums;
  if (clock.length === 2) {
    const [mm, ss] = clock;
    if (ss > 59) return null;
    return mm * 60 + ss;
  }
  if (clock.length === 3) {
    const [hh, mm, ss] = clock;
    if (mm > 59 || ss > 59) return null;
    return hh * 3600 + mm * 60 + ss;
  }
  return null;
}

export function secondsToTotalFrames(seconds: number, frameRate: number): number {
  const fps = Math.round(frameRate);
  return Math.max(0, Math.round(seconds * fps));
}
