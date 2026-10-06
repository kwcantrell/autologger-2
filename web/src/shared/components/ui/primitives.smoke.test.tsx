import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Alert, AlertDescription, AlertTitle } from './alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from './alert-dialog';
import { Badge } from './badge';
import { Card, CardContent, CardHeader, CardTitle } from './card';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from './drawer';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from './empty';
import { Field, FieldDescription, FieldGroup, FieldLabel } from './field';
import { Input } from './input';
import { Label } from './label';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { RadioGroup, RadioGroupItem } from './radio-group';
import { ScrollArea } from './scroll-area';
import {
  SELECT_TRIGGER_CLASSNAME,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select';
import { Separator } from './separator';
import { Skeleton } from './skeleton';
import { Toaster } from './sonner';
import { Spinner } from './spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';
import { Textarea } from './textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

// shadcn-foundation task 3.2: every added primitive renders and exposes its role / slot.
// Behaviour of the composed wrappers is change 2's job; this guards the normalized files.
// Radix popper positions via floating-ui, which constructs a ResizeObserver jsdom lacks
// (AdminUsersPage.test.tsx / RecentSessionsList.test.tsx idiom).
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}

// Radix Select (open) calls pointer-capture and scrollIntoView, which jsdom lacks.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
}
Element.prototype.scrollIntoView ??= () => {};

const slot = (name: string) => document.querySelector(`[data-slot="${name}"]`);

describe('shadcn primitives render (normalized, V5-themed)', () => {
  it('form controls: input, textarea, label, field', () => {
    render(
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="n">Name</FieldLabel>
          <Input id="n" placeholder="Show name" />
          <FieldDescription>Shown in the rail.</FieldDescription>
        </Field>
        <Label htmlFor="t">Notes</Label>
        <Textarea id="t" />
      </FieldGroup>,
    );
    expect(screen.getByLabelText('Name').tagName).toBe('INPUT');
    expect(screen.getByLabelText('Notes').tagName).toBe('TEXTAREA');
    expect(slot('field-group')).not.toBeNull();
  });

  it('select trigger is a combobox', () => {
    render(
      <Select defaultValue="24">
        <SelectTrigger aria-label="Frame rate">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="24">24</SelectItem>
        </SelectContent>
      </Select>,
    );
    expect(screen.getByRole('combobox', { name: 'Frame rate' })).toBeTruthy();
  });

  it('tabs expose tablist / tab / tabpanel', () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Panel A</TabsContent>
      </Tabs>,
    );
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'A' }).getAttribute('data-state')).toBe('active');
    expect(screen.getByRole('tabpanel').textContent).toBe('Panel A');
  });

  it('table, card, badge, alert, skeleton, separator, empty, spinner, scroll-area', () => {
    render(
      <div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Scene</TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <Card>
          <CardHeader>
            <CardTitle>Widget</CardTitle>
          </CardHeader>
          <CardContent>Body</CardContent>
        </Card>
        <Badge>New</Badge>
        <Alert>
          <AlertTitle>Heads up</AlertTitle>
          <AlertDescription>Unsent chunks.</AlertDescription>
        </Alert>
        <Skeleton />
        <Separator />
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No team yet</EmptyTitle>
            <EmptyDescription>Create one.</EmptyDescription>
          </EmptyHeader>
        </Empty>
        <Spinner />
        <ScrollArea className="h-10">Scrollable</ScrollArea>
      </div>,
    );
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Event' })).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
    for (const s of ['card', 'badge', 'skeleton', 'separator', 'empty', 'scroll-area'])
      expect(slot(s)).not.toBeNull();
  });

  // One open overlay per test: an open modal (dropdown menu) aria-hides its siblings.
  it('tooltip opens as a tooltip', () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Info</TooltipTrigger>
          <TooltipContent>More detail</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    expect(screen.getByRole('tooltip').textContent).toContain('More detail');
  });

  it('popover opens as a labelled dialog', () => {
    render(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent aria-label="Options">Popover body</PopoverContent>
      </Popover>,
    );
    expect(screen.getByRole('dialog', { name: 'Options' })).toBeTruthy();
  });

  it('dropdown menu opens with menu items', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy();
  });

  it('radio group exposes radios', () => {
    render(
      <RadioGroup defaultValue="a" aria-label="Kind">
        <RadioGroupItem value="a" aria-label="A" />
        <RadioGroupItem value="b" aria-label="B" />
      </RadioGroup>,
    );
    expect(screen.getByRole('radiogroup', { name: 'Kind' })).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('dialog opens with an accessible name', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>New session</DialogTitle>
          <DialogDescription>Pick a show.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole('dialog', { name: 'New session' })).toBeTruthy();
  });

  it('drawer opens with an accessible name', () => {
    render(
      <Drawer open>
        <DrawerContent>
          <DrawerTitle>Mobile sheet</DrawerTitle>
          <DrawerDescription>Drag to dismiss.</DrawerDescription>
        </DrawerContent>
      </Drawer>,
    );
    expect(screen.getByRole('dialog', { name: 'Mobile sheet' })).toBeTruthy();
  });

  // shadcn-shared-wrappers D1: the primitives carry the V5 look by REPLACING shadcn's base
  // class strings (twMerge would otherwise keep sm:max-w-lg / bg-background / zoom-in next to
  // the V5 classes, and sm:max-w-lg caps consumer `md:!w-…` widths). Deliberate class checks.
  const SHADCN_LEFTOVERS = /(^|\s)(sm:)?max-w-|bg-background|zoom-in|translate-x-/;

  // 2.2: popover / tooltip / select content restyled to V5 (no shadcn z-50 / zoom / popover bg).
  const SHADCN_OVERLAY_LEFTOVERS = /(^|\s)z-50(\s|$)|zoom-in|bg-popover|bg-foreground/;

  it('popover content is V5 and still a labelled dialog', () => {
    render(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent aria-label="Options">Body</PopoverContent>
      </Popover>,
    );
    expect(screen.getByRole('dialog', { name: 'Options' })).toBeTruthy();
    expect(slot('popover-content')?.getAttribute('class') ?? '').not.toMatch(
      SHADCN_OVERLAY_LEFTOVERS,
    );
  });

  it('tooltip content is V5 and still a tooltip', () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Info</TooltipTrigger>
          <TooltipContent>More</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    expect(screen.getByRole('tooltip').textContent).toContain('More');
    expect(slot('tooltip-content')?.getAttribute('class') ?? '').not.toMatch(
      SHADCN_OVERLAY_LEFTOVERS,
    );
  });

  it('select opens a V5 listbox; the trigger uses the single exported trigger class source', () => {
    render(
      <Select defaultOpen defaultValue="24">
        <SelectTrigger aria-label="Frame rate">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="24">24</SelectItem>
          <SelectItem value="30">30</SelectItem>
        </SelectContent>
      </Select>,
    );
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(slot('select-content')?.getAttribute('class') ?? '').not.toMatch(
      SHADCN_OVERLAY_LEFTOVERS,
    );
    expect(slot('select-trigger')?.getAttribute('class')).toBe(SELECT_TRIGGER_CLASSNAME);
    expect(slot('select-trigger')?.querySelectorAll('svg')).toHaveLength(1);
  });

  it('dialog renders no Close button by default', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Plain</DialogTitle>
          <DialogDescription>Body.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('dialog content with a consumer width override keeps no shadcn sizing/background/zoom', () => {
    render(
      <Dialog open>
        <DialogContent className="md:!w-[min(38rem,96vw)]">
          <DialogTitle>Wide</DialogTitle>
          <DialogDescription>Body.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    const cls = slot('dialog-content')?.getAttribute('class') ?? '';
    expect(cls).toContain('md:!w-[min(38rem,96vw)]');
    expect(cls).not.toMatch(SHADCN_LEFTOVERS);
  });

  it('alert-dialog content keeps no shadcn sizing/background/zoom', () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Sure?</AlertDialogTitle>
          <AlertDialogDescription>Body.</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>,
    );
    expect(slot('alert-dialog-content')?.getAttribute('class') ?? '').not.toMatch(SHADCN_LEFTOVERS);
  });

  it('drawer exposes a vaul drag handle', () => {
    render(
      <Drawer open>
        <DrawerContent>
          <DrawerTitle>Sheet</DrawerTitle>
          <DrawerDescription>Body.</DrawerDescription>
        </DrawerContent>
      </Drawer>,
    );
    expect(document.querySelector('[data-vaul-handle]')).not.toBeNull();
  });

  it('alert-dialog opens as an alertdialog with an accessible name', () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Delete row?</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction>Delete</AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>,
    );
    expect(screen.getByRole('alertdialog', { name: 'Delete row?' })).toBeTruthy();
  });

  it('sonner Toaster is fixed to the dark theme (no next-themes)', async () => {
    const { toast } = await import('sonner');
    render(<Toaster />);
    act(() => {
      toast('Saved');
    });
    await waitFor(() => expect(document.querySelector('[data-sonner-toaster]')).not.toBeNull());
    expect(document.querySelector('[data-sonner-toaster]')?.getAttribute('data-sonner-theme')).toBe(
      'dark',
    );
  });
});
