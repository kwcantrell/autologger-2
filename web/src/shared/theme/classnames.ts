/**
 * Sky-tint override for chrome `.btn.primary` inside V5 dialogs/modals.
 *
 * The chrome `.btn.primary` rule lives in `@layer components`; this utility
 * string sits in the higher `utilities` layer, so it wins by layer order and
 * recolors the button's gradient/border to the sky tint (padding/font stay from
 * chrome). Folded here to dedup the three former per-file copies (NewSessionModal
 * submit, EventButtonsTable, HomeSettingsModal). Unguarded hover → hover-always.
 */
export const BTN_PRIMARY_SKY =
  'rounded-v5-sm border-[rgba(56,189,248,0.35)] bg-[rgba(56,189,248,0.14)] text-v5-primary hover-always:bg-[rgba(56,189,248,0.22)]';
