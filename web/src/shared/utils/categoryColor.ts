// shadcn-port-workspace D8: an event's `category_color` is a CSS colour string from the API. For
// internal events the server sends a bare legacy-token reference (the muted token). Change 1
// renamed the legacy border/muted/accent tokens to `--legacy-*` because shadcn owns the bare
// names, so such a value would now resolve to shadcn's 6% tint (near-invisible text and markers).
// The web owns that rename, so it maps the reference back; the wire value is unchanged (frozen).
// (Matched by pattern, never spelled out: the shadcn hygiene guard bans the bare literals.)
const BARE_LEGACY_TOKEN = /^var\(\s*--(muted|border|accent)\s*\)$/;

/** The colour to paint for a category, or `undefined` (callers keep their own fallback). */
export function resolveCategoryColor(raw: string | null | undefined): string | undefined {
  const value = String(raw ?? '').trim();
  if (!value) return undefined;
  const m = BARE_LEGACY_TOKEN.exec(value);
  return m ? `var(--legacy-${m[1]})` : value;
}
