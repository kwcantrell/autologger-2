import type * as React from 'react';
import { cn } from '@/shared/lib/utils';

// V5 (shadcn-port-shell D1): base strings replaced with the legacy form vocabulary
// (.profile-select / .field / .modal-hint), so ported forms match unported ones.
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'w-full min-w-0 rounded-ctl border border-input bg-(--si-bg) px-[0.65rem] py-2 text-foreground h-(--h-ctl) outline-none transition-[border-color,background] duration-150 [font:inherit] placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
