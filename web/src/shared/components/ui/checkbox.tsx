import { CheckIcon } from 'lucide-react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from '@/shared/lib/utils';

// V5 (shadcn-port-shell D1): normalized like the change-1 primitives — local `cn`, no dark-mode
// variant classes (dark-only app), base string replaced: a glass box on the `--v5-border-strong` border
// that turns sky-tinted when checked (the shared "selected" tint).
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer size-4 shrink-0 cursor-pointer rounded-[4px] border border-v5-border-strong bg-(--si-bg) text-primary outline-none transition-[border-color,background] duration-150 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive data-[state=checked]:border-primary data-[state=checked]:bg-(--sel-bg)',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
