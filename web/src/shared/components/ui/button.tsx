import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type * as React from 'react';

import { cn } from '@/shared/lib/utils';

// shadcn Button in the Show Ignition vocabulary (redesign-show-ignition D1/D10; web-ui-system
// "Single V5 component vocabulary"): sentence-case labels in the UI face, one control height
// (--h-ctl, --h-sm for `sm`) and radius (--r-ctl), flat surfaces. default = the primary action
// (accent tint, preview `.btn.primary`), outline/secondary = the neutral flat control,
// destructive = the red-tinted danger control. Disabled = reduced opacity with muted text and,
// with pointer events off, no hover response; every hover rule is also gated `not-disabled:`.
// `hover:` is hover-media-guarded in Tailwind v4.
const NEUTRAL =
  'border-border bg-secondary text-secondary-foreground not-disabled:hover:border-[color-mix(in_oklab,var(--si-fg)_25%,var(--si-line))] not-disabled:hover:text-foreground';

// The shared base: applied by every variant except the feed-toolbar pair (it lives in the variant
// strings, not the cva base, so those can opt out).
const BUTTON_BASE =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-[0.4rem] whitespace-nowrap rounded-ctl border font-ui text-[0.8125rem] font-semibold leading-none no-underline outline-none transition-[border-color,background-color,box-shadow,color] duration-150 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:border-border disabled:bg-secondary disabled:text-muted-foreground disabled:opacity-45 aria-invalid:border-destructive aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

// Feed toolbar buttons (shadcn-port-workspace D1): they do NOT take BUTTON_BASE (its
// disabled:pointer-events-none etc. would kill the disabled Edit button's explanatory title and
// cursor) nor a size; same flat vocabulary, at the small control height.
const TOOLBAR =
  'box-border inline-flex h-(--h-sm) items-center justify-center gap-[0.4rem] whitespace-nowrap px-3 font-ui text-[0.8125rem] font-semibold leading-none rounded-ctl border border-solid border-border bg-secondary text-secondary-foreground cursor-pointer [transition:border-color_0.15s_ease,background-color_0.15s_ease,color_0.15s_ease,opacity_0.15s_ease] not-disabled:hover-always:border-[color-mix(in_oklab,var(--si-fg)_25%,var(--si-line))] not-disabled:hover-always:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:opacity-45 disabled:cursor-not-allowed max-md:min-h-[2.55rem] max-md:min-w-[2.55rem] max-md:px-2.5';
const TOOLBAR_PRIMARY =
  'border-(--si-primary-line) bg-(--si-primary-tint) text-foreground not-disabled:hover-always:border-primary';

// Transport controls (redesign-show-ignition, task 5.2; preview `.ctl`): the neutral flat control,
// and `data-active="true"` fills it with the live colour of the shell's transport state (the
// `--tx-pill-*` variables `data-transport` sets, so a pressed Roll ignites with the rest of the
// shell). A data attribute, not `aria-pressed`: these are actions, not toggles.
const TRANSPORT = `${NEUTRAL} data-[active=true]:border-(--tx-pill-line) data-[active=true]:bg-(--tx-pill-bg) data-[active=true]:text-(--tx-pill-fg) data-[active=true]:shadow-[0_0_18px_-6px_var(--tx-glow)]`;

// Logging-strip category buttons (preview `.cat`). The category colour is user data and its own
// channel: the caller sets `--cat` inline and it drives only the hover edge, the latched/pressed
// tint and the swatch, never the label. `data-latched="on"` is an On/Off button that is on;
// `.cat-btn-press` is the momentary press CategoryButtonStrip toggles for 120ms.
const LOG = `[--cat:var(--si-accent)] h-auto justify-start border-border bg-card text-foreground text-[0.875rem] not-disabled:hover:border-[color-mix(in_oklab,var(--cat)_55%,var(--si-line))] data-[latched=on]:border-(--cat) data-[latched=on]:bg-[color-mix(in_oklab,var(--cat)_22%,var(--si-panel))] [&.cat-btn-press]:translate-y-px [&.cat-btn-press]:border-(--cat) [&.cat-btn-press]:bg-[color-mix(in_oklab,var(--cat)_22%,var(--si-panel))] not-disabled:active:translate-y-px motion-reduce:[&.cat-btn-press]:translate-y-0 motion-reduce:not-disabled:active:translate-y-0`;

const buttonVariants = cva('', {
  variants: {
    variant: {
      default: `${BUTTON_BASE} border-(--si-primary-line) bg-(--si-primary-tint) text-foreground not-disabled:hover:border-primary`,
      destructive: `${BUTTON_BASE} border-(--si-danger-line) bg-[color-mix(in_oklab,var(--si-danger)_8%,var(--si-panel-2))] text-(--si-danger) not-disabled:hover:border-[color-mix(in_oklab,var(--si-danger)_55%,var(--si-danger-line))] focus-visible:ring-destructive/40`,
      outline: `${BUTTON_BASE} ${NEUTRAL}`,
      secondary: `${BUTTON_BASE} ${NEUTRAL}`,
      ghost: `${BUTTON_BASE} border-transparent bg-transparent text-foreground not-disabled:hover:bg-accent not-disabled:hover:text-accent-foreground disabled:bg-transparent disabled:border-transparent`,
      link: `${BUTTON_BASE} border-transparent bg-transparent text-primary underline-offset-4 not-disabled:hover:underline disabled:bg-transparent disabled:border-transparent`,
      transport: `${BUTTON_BASE} ${TRANSPORT}`,
      log: `${BUTTON_BASE} ${LOG}`,
      glass: TOOLBAR,
      'glass-primary': `${TOOLBAR} ${TOOLBAR_PRIMARY}`,
    },
    size: {
      default: 'h-(--h-ctl) px-[0.9rem] has-[>svg]:px-3',
      xs: "h-6 gap-1 px-2 text-[0.75rem] has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
      sm: 'h-(--h-sm) gap-1.5 px-3 has-[>svg]:px-2.5',
      lg: 'h-10 px-5 has-[>svg]:px-4',
      icon: 'size-(--h-ctl)',
      'icon-xs': "size-6 [&_svg:not([class*='size-'])]:size-3",
      'icon-sm': 'size-(--h-sm)',
      'icon-lg': 'size-10',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'default',
  },
});

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';
  const isGlass = variant === 'glass' || variant === 'glass-primary';

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={isGlass ? undefined : size}
      className={cn(buttonVariants({ variant, size: isGlass ? null : size, className }))}
      {...props}
    />
  );
}

/**
 * Mobile touch-target floor (shadcn-port-settings D2b): the legacy `.btn` was at least 44px tall
 * below 767px. Ported controls pass this so their phone size is unchanged; it is not in the base
 * (that would change every existing Button on mobile).
 */
const TOUCH_TARGET = 'max-md:min-h-11';

export { Button, buttonVariants, TOUCH_TARGET };
