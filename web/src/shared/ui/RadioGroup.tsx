import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import { RadioGroup as RadioGroupRoot } from '@/shared/components/ui/radio-group';

export interface RadioGroupOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface RadioGroupProps {
  value: string;
  onChange: (value: string) => void;
  options: RadioGroupOption[];
  ariaLabel: string;
  className?: string;
  itemClassName?: (value: string, checked: boolean) => string;
}

/**
 * Accessible radio group — roving tabindex + looping arrow-key nav, styled via caller classNames.
 * shadcn-shared-wrappers D5: the shadcn RadioGroup root, with bare primitive items carrying the
 * label text (the shadcn item's indicator circle would break the caller's pill styling).
 */
export function RadioGroup({
  value,
  onChange,
  options,
  ariaLabel,
  className,
  itemClassName,
}: RadioGroupProps) {
  return (
    <RadioGroupRoot
      value={value}
      onValueChange={onChange}
      aria-label={ariaLabel}
      className={className}
      loop
    >
      {options.map((opt) => (
        <RadioGroupPrimitive.Item
          key={opt.value}
          value={opt.value}
          disabled={opt.disabled}
          className={itemClassName?.(opt.value, opt.value === value)}
        >
          {opt.label}
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupRoot>
  );
}
