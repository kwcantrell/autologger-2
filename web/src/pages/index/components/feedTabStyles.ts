import clsx from 'clsx';

// Shared glass-tab button chrome: used by SessionWorkspace's top-level Feed
// tabs tablist (Event Feed | Transcript | Topics | Assistant | Dashboards,
// design D5 — ui-refresh flattened the former nested AI subtabs into this
// same top-level list). Lives in its own module (not re-exported from
// SessionWorkspace.tsx) so other consumers importing it don't create an
// import cycle with SessionWorkspace.
export function feedTabButtonClassName(active: boolean): string {
  return clsx(
    // Base tab chrome (shared by active + inactive). The source
    // `font: inherit` also inherited line-height (resolved 17.168px);
    // `font-[inherit]` only sets font-family, so `leading-[inherit]`
    // restores the inherited line-height (else it falls to `normal`
    // and the tabs grow ~3px taller — the 5a font-shorthand pitfall).
    // whitespace-nowrap + shrink-0 (ui-refresh): with five tabs the mobile
    // tablist scrolls horizontally; without these the squeezed tabs wrapped
    // their labels onto two lines instead.
    'relative shrink-0 whitespace-nowrap px-[1.05rem] pt-[0.5rem] font-[inherit] leading-[inherit] text-[0.74rem] font-semibold tracking-[0.07em] uppercase',
    // Flush to the sheet top edge (no recessed translate) so tabs read as a lid.
    'border border-b-0 rounded-t-[0.7rem] cursor-pointer',
    'transition-[color,background,border-color,box-shadow] duration-[0.18s] ease',
    active
      ? // Active: exact sheet-top surface color; no bottom border/shadow seam.
        'z-[3] -mb-px pb-[0.72rem] text-v5-text ' +
          'border-t-v5-border border-x-v5-border border-b-0 ' +
          '[background:var(--v5-glass-feed-surface-top)] shadow-none ' +
          'before:content-[""] before:absolute before:inset-x-[0.55rem] before:inset-y-auto before:top-0 before:h-0.5 before:rounded-[2px] ' +
          'before:[background:linear-gradient(90deg,rgba(34,211,238,0)_0%,var(--v5-primary2,#22d3ee)_18%,var(--v5-primary,#38bdf8)_82%,rgba(56,189,248,0)_100%)] ' +
          'before:[box-shadow:0_0_10px_rgba(56,189,248,0.45)]'
      : // Inactive: quieter feed-glass sibling, still flush — not a floating chip.
        'z-[1] pb-[0.62rem] text-[rgba(229,238,252,0.62)] border-[rgba(255,255,255,0.06)] ' +
          '[background:color-mix(in_srgb,var(--v5-glass-feed-top)_55%,transparent)] ' +
          '[box-shadow:inset_0_1px_0_rgba(255,255,255,0.04)] ' +
          'hover-always:text-[rgba(229,238,252,0.9)] hover-always:border-v5-border ' +
          'hover-always:[background:color-mix(in_srgb,var(--v5-glass-feed-top)_78%,transparent)]',
    // Focus ring (both states).
    'focus-visible:outline-2 focus-visible:outline focus-visible:[outline-color:rgba(56,189,248,0.55)] focus-visible:outline-offset-2 focus-visible:z-[4]',
  );
}
