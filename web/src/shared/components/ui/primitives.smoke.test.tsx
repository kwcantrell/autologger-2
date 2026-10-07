import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Alert, AlertDescription, AlertTitle } from './alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from './alert-dialog';
import { Avatar, AvatarFallback } from './avatar';
import { Badge } from './badge';
import { Button, buttonVariants } from './button';
import { Card, CardContent, CardHeader, CardTitle } from './card';
import { Checkbox } from './checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from './drawer';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from './empty';
import { Field, FieldDescription, FieldGroup, FieldLabel } from './field';
import { Input } from './input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from './item';
import { Kbd, KbdGroup } from './kbd';
import { Label } from './label';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { RadioGroup, RadioGroupItem } from './radio-group';
import { ScrollArea, ScrollBar } from './scroll-area';
import {
  SELECT_TRIGGER_CLASSNAME,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select';
import { Separator } from './separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from './sheet';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from './sidebar';
import { Skeleton } from './skeleton';
import { Toaster } from './sonner';
import { Spinner } from './spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';
import { Textarea } from './textarea';
import { ToggleGroup, ToggleGroupItem } from './toggle-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

// shadcn-foundation task 3.2: every added primitive renders and exposes its role / slot.
// Behaviour of the composed wrappers is change 2's job; this guards the normalized files.
// Radix popper positions via floating-ui, which constructs a ResizeObserver jsdom lacks
// (RecentSessionsList.test.tsx idiom).
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

  // redesign-show-ignition 11.3 (owner item e): Radix focuses the trigger from its own mousedown,
  // which Chrome treats as script focus and paints `:focus-visible` after a pointer click. The
  // trigger marks pointer focus and suppresses the ring for it; keyboard focus keeps the ring.
  it.each([
    ['default', undefined],
    ['nav', 'nav'],
  ] as const)('tab triggers (%s) show the focus ring for keyboard focus only', (_name, variant) => {
    const onMouseDown = vi.fn();
    const onBlur = vi.fn();
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a" variant={variant}>
            A
          </TabsTrigger>
          <TabsTrigger value="b" variant={variant} onMouseDown={onMouseDown} onBlur={onBlur}>
            B
          </TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const b = screen.getByRole('tab', { name: 'B' });
    expect(b.className.split(/\s+/)).toContain('data-pointer-focus:focus-visible:outline-none');
    expect(b.hasAttribute('data-pointer-focus')).toBe(false);
    fireEvent.mouseDown(b, { button: 0 });
    expect(b.hasAttribute('data-pointer-focus')).toBe(true);
    expect(b.getAttribute('data-state')).toBe('active'); // Radix's activation still runs
    expect(onMouseDown).toHaveBeenCalledTimes(1);
    fireEvent.blur(b);
    expect(b.hasAttribute('data-pointer-focus')).toBe(false);
    expect(onBlur).toHaveBeenCalledTimes(1);
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

  // shadcn-port-shell D1: content primitives themed to V5 (base strings replaced).
  it('content primitives keep no shadcn input/radius/dashed/clamp leftovers; spinner honours reduced motion', () => {
    render(
      <div>
        <Input aria-label="i" />
        <Textarea aria-label="t" />
        <Alert>
          <AlertTitle>Long headline that must not clamp</AlertTitle>
          <AlertDescription>d</AlertDescription>
        </Alert>
        <Badge variant="outline">owner</Badge>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>t</EmptyTitle>
          </EmptyHeader>
        </Empty>
        <Field>
          <FieldLabel htmlFor="x">L</FieldLabel>
          <FieldDescription>hint</FieldDescription>
        </Field>
        <Spinner />
      </div>,
    );
    const LEFTOVERS = /bg-input\/30|(^|\s)rounded-md(\s|$)|border-dashed|line-clamp-1/;
    for (const s of [
      'input',
      'textarea',
      'alert',
      'alert-title',
      'badge',
      'empty',
      'field-label',
      'field-description',
    ]) {
      expect({ slot: s, cls: slot(s)?.getAttribute('class') ?? '' }).not.toEqual(
        expect.objectContaining({ cls: expect.stringMatching(LEFTOVERS) }),
      );
    }
    expect(screen.getByRole('status').getAttribute('class') ?? '').toContain(
      'motion-reduce:animate-none',
    );
  });

  it('checkbox is a labelled role=checkbox that toggles', () => {
    render(
      <div>
        <Checkbox id="cb-morning" />
        <Label htmlFor="cb-morning">Morning News</Label>
      </div>,
    );
    const cb = screen.getByRole('checkbox', { name: 'Morning News' });
    expect(cb.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(cb);
    expect(cb.getAttribute('aria-checked')).toBe('true');
    expect(cb.getAttribute('data-slot')).toBe('checkbox');
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

// shadcn-port-workspace group 1: the workspace primitives (scroll-area, table, tabs, the rest of
// dropdown-menu, glass Button variants).
describe('workspace primitives (shadcn-port-workspace D1)', () => {
  it('scroll-area publishes its viewport through viewportRef', () => {
    let vp: HTMLDivElement | null = null;
    render(
      <ScrollArea
        viewportRef={(el) => {
          vp = el;
        }}
        className="h-10"
      >
        Scrollable
      </ScrollArea>,
    );
    expect(vp).not.toBeNull();
    expect(vp).toBe(slot('scroll-area-viewport'));
  });

  it('scroll-area viewportClassName wins over the default block content wrapper', () => {
    render(
      <ScrollArea viewportClassName="[&>div]:!flex" className="h-10">
        Scrollable
      </ScrollArea>,
    );
    const cls = slot('scroll-area-viewport')?.className ?? '';
    expect(cls).toContain('[&>div]:!flex');
    expect(cls).not.toContain('[&>div]:!block');
  });

  it('scrollbar keeps focus on mousedown but still lets Radix drag on pointerdown', () => {
    render(
      <ScrollArea type="always" className="h-10">
        <input aria-label="edit" />
      </ScrollArea>,
    );
    const bar = slot('scroll-area-scrollbar') as HTMLElement;
    expect(bar).not.toBeNull();
    // (b) focus parity: the focus-moving default of mousedown is prevented.
    const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    bar.dispatchEvent(md);
    expect(md.defaultPrevented).toBe(true);
    // (c) the drag is not cancelled: Radix's pointerdown still captures the pointer.
    const capture = vi.fn();
    bar.setPointerCapture = capture;
    fireEvent.pointerDown(bar, { button: 0, pointerId: 1 });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('scroll-area renders a horizontal scrollbar only when asked (scrollbars="both")', () => {
    const { unmount } = render(
      <ScrollArea type="always" className="h-10">
        Scrollable
      </ScrollArea>,
    );
    expect(document.querySelectorAll('[data-slot=scroll-area-scrollbar]')).toHaveLength(1);
    unmount();
    render(
      <ScrollArea type="always" scrollbars="both" className="h-10">
        Scrollable
      </ScrollArea>,
    );
    const bars = [...document.querySelectorAll('[data-slot=scroll-area-scrollbar]')];
    expect(bars.map((b) => b.getAttribute('data-orientation')).sort()).toEqual([
      'horizontal',
      'vertical',
    ]);
  });

  it('ScrollBar is exported for horizontal use', () => {
    expect(typeof ScrollBar).toBe('function');
  });

  it('table container does not scroll; row/cell carry no visual base', () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Event</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow data-testid="row">
            <TableCell data-testid="cell">Scene</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(slot('table-container')?.className).not.toContain('overflow');
    expect(screen.getByRole('table').tagName).toBe('TABLE');
    expect(screen.getByRole('columnheader', { name: 'Event' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'Scene' })).toBeTruthy();
    expect(screen.getByTestId('row').className).toBe('');
    expect(screen.getByTestId('cell').className).toBe('');
  });

  it('tabs activate on mouse-down and by arrow key', async () => {
    render(
      <Tabs defaultValue="a">
        <TabsList aria-label="Feeds">
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
          <TabsTrigger value="c">C</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Panel A</TabsContent>
        <TabsContent value="b">Panel B</TabsContent>
        <TabsContent value="c">Panel C</TabsContent>
      </Tabs>,
    );
    const b = screen.getByRole('tab', { name: 'B' });
    fireEvent.mouseDown(b, { button: 0 });
    expect(b.getAttribute('data-state')).toBe('active');
    expect(b.getAttribute('aria-selected')).toBe('true');
    b.focus();
    fireEvent.keyDown(b, { key: 'ArrowRight' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const c = screen.getByRole('tab', { name: 'C' });
    expect(document.activeElement).toBe(c);
    expect(c.getAttribute('aria-selected')).toBe('true');
    // V5 lid chrome on the trigger, not shadcn's input-tinted pill.
    expect(c.className).not.toContain('bg-input/30');
  });

  // Checkbox items carry no selected tint (web-session-console "Event filter checkmarks"); a
  // checked radio item takes the one selected state (redesign-show-ignition; asserted in the
  // Show Ignition block below), which this shadcn-leftover regex does not match.
  it('dropdown checkbox and radio items: indicator, aria state, no shadcn tint leftovers', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem checked>Scene</DropdownMenuCheckboxItem>
          <DropdownMenuRadioGroup value="session">
            <DropdownMenuRadioItem value="session">Session Time</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="world">World Clock</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const cb = screen.getByRole('menuitemcheckbox', { name: 'Scene' });
    expect(cb.getAttribute('aria-checked')).toBe('true');
    expect(cb.querySelector('svg')).not.toBeNull();
    expect(cb.className).not.toMatch(/bg-accent|rounded-sm|text-sm/);
    const radio = screen.getByRole('menuitemradio', { name: 'Session Time' });
    expect(radio.getAttribute('aria-checked')).toBe('true');
    expect(
      screen.getByRole('menuitemradio', { name: 'World Clock' }).getAttribute('aria-checked'),
    ).toBe('false');
    expect(radio.className).not.toMatch(/bg-accent|rounded-sm|text-sm/);
  });

  it('existing Button variants keep their exact class lists', () => {
    const variants = ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'] as const;
    const sizes = ['default', 'xs', 'sm', 'lg', 'icon', 'icon-xs', 'icon-sm', 'icon-lg'] as const;
    const out: Record<string, string> = {};
    for (const v of variants)
      for (const sz of sizes) out[`${v}/${sz}`] = buttonVariants({ variant: v, size: sz });
    expect(out).toMatchSnapshot();
  });

  it('glass Button variants skip the shared base (disabled keeps pointer events and cursor)', () => {
    render(
      <>
        <Button variant="glass" disabled title="why">
          Edit
        </Button>
        <Button variant="glass-primary">Save</Button>
      </>,
    );
    const edit = screen.getByRole('button', { name: 'Edit' });
    expect(edit.tagName).toBe('BUTTON');
    expect(edit.getAttribute('data-variant')).toBe('glass');
    expect(edit.className).not.toContain('disabled:pointer-events-none');
    expect(edit.className).toContain('disabled:cursor-not-allowed');
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('data-variant')).toBe(
      'glass-primary',
    );
  });
});

// redesign-show-ignition D10: the primitives added for the redesign render and expose their
// role / slot after the hygiene rewrite.
describe('Show Ignition primitives (redesign-show-ignition D10)', () => {
  it('sheet opens as a labelled dialog with header and footer slots', () => {
    render(
      <Sheet open>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>Edit member</SheetTitle>
            <SheetDescription>Role and show access.</SheetDescription>
          </SheetHeader>
          <SheetFooter>Footer</SheetFooter>
        </SheetContent>
      </Sheet>,
    );
    expect(screen.getByRole('dialog', { name: 'Edit member' })).toBeTruthy();
    for (const s of ['sheet-content', 'sheet-header', 'sheet-footer'])
      expect(slot(s)).not.toBeNull();
  });

  it('toggle group (single) marks its value on', () => {
    render(
      <ToggleGroup type="single" defaultValue="admin" aria-label="Role">
        <ToggleGroupItem value="admin">Admin</ToggleGroupItem>
        <ToggleGroupItem value="member">Member</ToggleGroupItem>
      </ToggleGroup>,
    );
    expect(slot('toggle-group')).not.toBeNull();
    const items = document.querySelectorAll('[data-slot="toggle-group-item"]');
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute('data-state')).toBe('on');
    expect(items[1].getAttribute('data-state')).toBe('off');
  });

  it('item rows with avatar initials, and kbd', () => {
    render(
      <div>
        <ItemGroup>
          <Item>
            <ItemMedia>
              <Avatar>
                <AvatarFallback>KC</AvatarFallback>
              </Avatar>
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Kalen Cantrell</ItemTitle>
              <ItemDescription>Owner</ItemDescription>
            </ItemContent>
            <ItemActions>Edit</ItemActions>
          </Item>
        </ItemGroup>
        <KbdGroup>
          <Kbd>[</Kbd>
        </KbdGroup>
      </div>,
    );
    for (const s of ['item-group', 'item', 'item-media', 'item-content', 'item-actions', 'avatar'])
      expect(slot(s)).not.toBeNull();
    expect(screen.getByText('KC')).toBeTruthy();
    expect(screen.getByText('[').tagName).toBe('KBD');
  });

  it('sidebar renders header, menu, footer and an accessible trigger', () => {
    render(
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <SidebarHeader>Header</SidebarHeader>
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive>Session one</SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
          <SidebarFooter>Settings</SidebarFooter>
        </Sidebar>
        <SidebarTrigger />
      </SidebarProvider>,
    );
    expect(slot('sidebar')?.getAttribute('data-collapsible')).toBe('');
    expect(screen.getByRole('button', { name: /toggle sidebar/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Session one' }).getAttribute('data-active')).toBe(
      'true',
    );
  });

  // web-ui-system "One selected state everywhere": the pressed segmented control, the checked
  // menu radio item and the active rail row share the accent tint and 1px inset line. Checkbox
  // menu items stay checkmark-only (web-session-console "Event filter checkmarks").
  it('one selected state: toggle item, menu radio item, active sidebar row', () => {
    const SEL = ['bg-(--sel-bg)', 'shadow-[inset_0_0_0_1px_var(--sel-line)]'];
    const { unmount } = render(
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive>Active row</SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>
        <ToggleGroup type="single" defaultValue="a" aria-label="Kind">
          <ToggleGroupItem value="a">Pressed</ToggleGroupItem>
        </ToggleGroup>
      </SidebarProvider>,
    );
    const active = screen.getByRole('button', { name: 'Active row' }).className;
    const pressed = (document.querySelector('[data-slot="toggle-group-item"]') as HTMLElement)
      .className;
    for (const c of SEL) {
      expect(active).toContain(`data-[active=true]:${c}`);
      expect(pressed).toContain(`data-[state=on]:${c}`);
    }
    unmount();
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Team</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="a">
            <DropdownMenuRadioItem value="a">Team A</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuCheckboxItem checked>Internal</DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const radio = screen.getByRole('menuitemradio', { name: 'Team A' }).className;
    const checkbox = screen.getByRole('menuitemcheckbox', { name: 'Internal' }).className;
    for (const c of SEL) {
      expect(radio).toContain(`data-[state=checked]:${c}`);
      expect(checkbox).not.toContain(c);
    }
  });
});
