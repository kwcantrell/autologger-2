export interface CategoryLike {
  id: string;
  name: string;
  type: string;
  dropdown_options: Array<{ label: string }>;
  on_label: string;
  off_label: string;
}

export interface CategoryMatchResult {
  categoryId: string;
  message: string;
  importOption: string | null;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function overlaps(typeCell: string, candidate: string): boolean {
  const a = tokenize(typeCell);
  const b = tokenize(candidate);
  if (a.length === 0 || b.length === 0) return false;
  return a.some((t) => b.includes(t)) || b.some((t) => a.includes(t));
}

function findOther(categories: CategoryLike[]): CategoryLike | null {
  return categories.find((c) => c.name.trim().toLowerCase() === 'other') ?? null;
}

/** Map sheet column C to a show category per sheets-log-import design D5. */
export function mapLogCategory(
  typeCell: string,
  messageB: string,
  categories: CategoryLike[],
): CategoryMatchResult {
  const other = findOther(categories);
  if (!other) throw new Error('Show has no OTHER category required for log import.');

  const trimmedType = typeCell.trim();
  if (!trimmedType) {
    return { categoryId: other.id, message: messageB, importOption: null };
  }

  type Cand = { categoryId: string; label: string; importOption: string | null };
  const cands: Cand[] = [];
  for (const cat of categories) {
    const t = cat.type.toUpperCase();
    if (t === 'DROPDOWN') {
      for (const opt of cat.dropdown_options) {
        cands.push({ categoryId: cat.id, label: opt.label, importOption: opt.label });
      }
    } else if (t === 'ON_OFF') {
      for (const label of [cat.on_label, cat.off_label]) {
        if (label.trim()) cands.push({ categoryId: cat.id, label, importOption: label });
      }
    } else if (t === 'BUTTON' || t === 'TEXT') {
      cands.push({ categoryId: cat.id, label: cat.name, importOption: null });
    }
  }

  const matches = cands.filter((c) => overlaps(trimmedType, c.label));
  if (matches.length === 0) {
    return {
      categoryId: other.id,
      message: `${messageB} - ${trimmedType}`,
      importOption: null,
    };
  }
  matches.sort((a, b) => b.label.length - a.label.length);
  const best = matches[0];
  return {
    categoryId: best.categoryId,
    message: messageB,
    importOption: best.importOption,
  };
}
