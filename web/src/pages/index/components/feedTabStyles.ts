import clsx from 'clsx';

// Shared glass-tab button chrome (design D9): used by both SessionWorkspace's
// top-level Event Feed | AI tablist and AiPanel's nested Chat | Transcribe |
// Topics tablist, so the new AI subtabs read as the same tab affordance
// rather than inventing a second visual language. Lives in its own module
// (not re-exported from SessionWorkspace.tsx) so AiPanel importing it doesn't
// create a SessionWorkspace <-> AiPanel import cycle.
export function feedTabButtonClassName(active: boolean): string {
  return clsx(
    // Base tab chrome (shared by active + inactive). The source
    // `font: inherit` also inherited line-height (resolved 17.168px);
    // `font-[inherit]` only sets font-family, so `leading-[inherit]`
    // restores the inherited line-height (else it falls to `normal`
    // and the tabs grow ~3px taller — the 5a font-shorthand pitfall).
    'relative px-[1.15rem] pt-[0.55rem] font-[inherit] leading-[inherit] text-[0.74rem] font-semibold tracking-[0.07em] uppercase',
    'border border-v5-border border-b-0 rounded-t-[0.85rem] cursor-pointer',
    'transition-[transform,color,background,border-color,box-shadow] duration-[0.18s] ease',
    active
      ? // Active: lifts flush, adopts the sheet glass surface, cyan stripe via ::before.
        'z-[3] [transform:translateY(0)] text-v5-text pb-[0.85rem] border-v5-border-strong ' +
          '[background:linear-gradient(180deg,rgba(255,255,255,0.08)_0%,rgba(255,255,255,0)_70%),linear-gradient(180deg,var(--v5-glass-strong-top)_0%,var(--v5-glass-strong-top)_100%)] ' +
          '[box-shadow:inset_0_1px_0_rgba(255,255,255,0.085),-3px_0_8px_-4px_rgba(0,0,0,0.35),3px_0_8px_-4px_rgba(0,0,0,0.35),0_-6px_18px_-6px_rgba(56,189,248,0.18)] ' +
          'before:content-[""] before:absolute before:inset-x-[0.55rem] before:inset-y-auto before:top-0 before:h-0.5 before:rounded-[2px] ' +
          'before:[background:linear-gradient(90deg,rgba(34,211,238,0)_0%,var(--v5-primary2,#22d3ee)_18%,var(--v5-primary,#38bdf8)_82%,rgba(56,189,248,0)_100%)] ' +
          'before:[box-shadow:0_0_12px_rgba(56,189,248,0.55)]'
      : // Inactive: recessed 4px, hover lifts to 2px (unguarded → hover-always).
        // ui-refresh: inactive label 0.48 → 0.6 alpha (measured 4.43:1, a hair
        // under AA for this small uppercase type; 0.6 clears it).
        'pb-[0.7rem] text-[rgba(229,238,252,0.6)] [transform:translateY(4px)] ' +
          '[background:linear-gradient(180deg,rgba(20,27,46,0.82)_0%,rgba(10,15,28,0.78)_100%)] ' +
          '[box-shadow:inset_0_1px_0_rgba(255,255,255,0.035),0_-2px_4px_rgba(0,0,0,0.18)] ' +
          'hover-always:[transform:translateY(2px)] hover-always:text-[rgba(229,238,252,0.88)] hover-always:border-v5-border-strong ' +
          'hover-always:[background:linear-gradient(180deg,rgba(28,38,62,0.9)_0%,rgba(14,20,36,0.85)_100%)]',
    // Focus ring (both states).
    'focus-visible:outline-2 focus-visible:outline focus-visible:[outline-color:rgba(56,189,248,0.55)] focus-visible:outline-offset-2 focus-visible:z-[4]',
  );
}
