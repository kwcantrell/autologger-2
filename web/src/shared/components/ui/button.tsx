import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type * as React from 'react';

import { cn } from '@/shared/lib/utils';

// shadcn Button restyled to the V5 vocabulary (shadcn-foundation design D6; web-ui-system
// "Single V5 component vocabulary"). The variants mirror the legacy `.btn` family in
// tailwind.css: default = `.btn.primary` (sky), outline/secondary = `.btn` (neutral glass),
// destructive = `.btn.danger` (red). Disabled = the legacy dimmed glass with muted text; with
// pointer events off there is no hover response. `hover:` is hover-media-guarded in Tailwind
// v4, matching the legacy `@media (hover: hover)` guard.
const NEUTRAL_GLASS =
  'border-border bg-[linear-gradient(165deg,rgba(255,255,255,0.08),rgba(15,23,42,0.45))] text-[rgba(248,250,252,0.92)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] hover:border-[color-mix(in_srgb,var(--v5-primary)_45%,var(--v5-border-strong))] hover:bg-[linear-gradient(165deg,rgba(255,255,255,0.1),rgba(15,23,42,0.5))] hover:text-white';

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-[0.4rem] whitespace-nowrap rounded-v5-sm border text-[0.72rem] font-semibold uppercase tracking-[0.1em] no-underline outline-none transition-[border-color,background,box-shadow,color] duration-150 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:border-[var(--v5-border)] disabled:bg-[linear-gradient(165deg,rgba(255,255,255,0.04),rgba(15,23,42,0.45))] disabled:text-muted-foreground disabled:opacity-45 disabled:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] aria-invalid:border-destructive aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'border-[rgba(56,189,248,0.4)] bg-[linear-gradient(165deg,rgba(56,189,248,0.18),rgba(15,23,42,0.5))] text-primary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_0_1px_rgba(56,189,248,0.1)] hover:border-[rgba(56,189,248,0.6)] hover:bg-[linear-gradient(165deg,rgba(56,189,248,0.26),rgba(15,23,42,0.52))] hover:text-white',
        destructive:
          'border-[color-mix(in_srgb,var(--danger)_45%,var(--v5-border-strong))] bg-[linear-gradient(165deg,rgba(251,113,133,0.12),rgba(15,23,42,0.5))] text-[#fda4af] hover:border-[color-mix(in_srgb,var(--danger)_65%,var(--v5-border-strong))] hover:bg-[linear-gradient(165deg,rgba(251,113,133,0.2),rgba(15,23,42,0.52))] hover:text-[#fecdd3] focus-visible:ring-destructive/40',
        outline: NEUTRAL_GLASS,
        secondary: NEUTRAL_GLASS,
        ghost:
          'border-transparent bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground',
        link: 'border-transparent bg-transparent normal-case tracking-normal text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-[1.1rem] py-2 has-[>svg]:px-3',
        xs: "h-6 gap-1 px-2 text-[0.65rem] has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 gap-1.5 px-3 has-[>svg]:px-2.5',
        lg: 'h-10 px-6 has-[>svg]:px-4',
        icon: 'size-9',
        'icon-xs': "size-6 [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

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

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
