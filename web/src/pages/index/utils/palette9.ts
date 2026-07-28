// Single source for the 9-slot event-palette normalization shared by
// HomeSettingsModal and EventButtonsTable (code-health-tail task 4.5,
// finding 2.7, D12/W5). The two components previously carried slightly
// different implementations of the same function (for-loop vs
// map-over-fixed-indices) with duplicate default arrays; EventButtonsTable's
// map-over-fixed-indices shape is the one kept.

export const DEFAULT_PALETTE = [
  '#64748b',
  '#e53935',
  '#fb8c00',
  '#fdd835',
  '#43a047',
  '#00acc1',
  '#1e88e5',
  '#8e24aa',
  '#ec407a',
];

// Fixed positional slot indices — using array content (not .map index) avoids
// noArrayIndexKey lint at swatch render sites.
export const PALETTE_SLOT_INDICES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;

export function normalizePalette9(arr: string[]): string[] {
  return PALETTE_SLOT_INDICES.map((i) => {
    const h = (arr[i] ?? '').toLowerCase();
    return /^#[0-9a-f]{6}$/.test(h) ? h : DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
  });
}
