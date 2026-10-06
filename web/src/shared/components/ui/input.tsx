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
        'w-full min-w-0 rounded-[0.6rem] border border-v5-border-strong bg-[rgba(7,11,20,0.6)] px-[0.65rem] py-2 text-v5-text outline-none transition-[border-color,background] duration-150 [font:inherit] placeholder:text-[rgba(229,238,252,0.62)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-[rgba(56,189,248,0.55)] focus-visible:bg-[rgba(7,11,20,0.75)] aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
