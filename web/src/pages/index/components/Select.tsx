import { forwardRef } from 'react';
import {
  SELECT_ICON_CLASSNAME,
  SELECT_TRIGGER_CLASSNAME,
  SelectContent,
  SelectItem,
  Select as SelectRoot,
  SelectTrigger,
  SelectTriggerIcon,
  SelectValue,
} from '@/shared/components/ui/select';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  id?: string;
  className?: string;
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  name?: string;
  /** Mounts the Radix root already open (settings-modal-mount-cost, D3). Additive and
   * optional — every existing call site omits it and keeps mounting closed, which is
   * `SelectRoot`'s own default when the prop is undefined. It exists so a
   * lazily-upgraded control (`EventButtonsTable`'s inert trigger) can open on the same
   * activation that mounted it, since the freshly-mounted trigger cannot receive the
   * gesture that triggered the swap. */
  defaultOpen?: boolean;
  /** Radix's own open/close signal, forwarded verbatim. Additive and optional —
   * every other call site omits it and `SelectRoot` behaves exactly as
   * before. `EventLogRow` needs it because its listbox is portaled outside the
   * virtualized row: while the dropdown is open, focus and DOM containment both
   * say the row is no longer being edited, and the row would be unpinned (and
   * then unmounted by an incoming event) mid-choice. */
  onOpenChange?: (open: boolean) => void;
}

// Shared trigger chrome (shadcn-shared-wrappers D5): the single source now lives in the shadcn
// Select primitive; re-exported here under the legacy names so LazySelect's inert per-row
// stand-in (settings-modal-mount-cost D3) renders the identical classes and icon markup.
export { SELECT_ICON_CLASSNAME, SELECT_TRIGGER_CLASSNAME };
export const SelectChevronIcon = SelectTriggerIcon;

export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  {
    value,
    onChange,
    options,
    id,
    className,
    ariaLabel,
    placeholder,
    disabled,
    name,
    defaultOpen,
    onOpenChange,
  },
  ref,
) {
  // shadcn-shared-wrappers D5: the V5 trigger/listbox live in the shadcn primitive (D1).
  return (
    <SelectRoot
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      name={name}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
    >
      <SelectTrigger ref={ref} id={id} aria-label={ariaLabel} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper" sideOffset={4} collisionPadding={8}>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
});
