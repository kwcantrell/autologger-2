'use client';

import type * as React from 'react';
import { cn } from '@/shared/lib/utils';

// V5 (shadcn-port-workspace D1): base strings replaced with the feed-table vocabulary.
// - The container does NOT scroll: an overflow container is a scroll container, and it would
//   become the sticky <th>'s scrollport (headers would stop sticking to the ScrollArea viewport).
// - TableHead = the sticky feed header (cool translucent navy, muted uppercase) + the sort-button
//   reset. Text alignment is left to callers (feeds pass text-left / text-center per column).
// - TableRow / TableCell carry NO visual base: the app has two cell vocabularies (FEED_ROW /
//   FEED_CELL for transcript + topics, EventLogRow's CELL_* with a per-cell hover tint that edit
//   cells must not take), so each caller passes its own and nothing leaks between them.

function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div data-slot="table-container" className="relative w-full">
      <table
        data-slot="table"
        className={cn('w-full border-collapse text-[0.84rem]', className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={className} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={className} {...props} />;
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn('[border-top:1px_solid_var(--v5-line)] font-medium', className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return <tr data-slot="table-row" className={className} {...props} />;
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'sticky top-0 z-[1] px-[0.55rem] py-[0.38rem] text-[0.84rem] font-semibold tracking-[0.05em] uppercase whitespace-nowrap bg-[rgba(19,27,48,0.72)] [border-bottom:1px_solid_var(--v5-line)] text-v5-muted [&_button]:appearance-none [&_button]:bg-transparent [&_button]:border-none [&_button]:text-inherit [&_button]:[font:inherit] [&_button]:[letter-spacing:inherit] [&_button]:cursor-pointer [&_button]:p-0 [&_button]:text-left [&_button]:w-full [&_button]:hover-always:text-v5-primary',
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return <td data-slot="table-cell" className={className} {...props} />;
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return (
    <caption
      data-slot="table-caption"
      className={cn('mt-4 text-[0.8rem] text-v5-muted', className)}
      {...props}
    />
  );
}

export { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow };
