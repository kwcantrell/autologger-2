import * as RadixRadioGroup from '@radix-ui/react-radio-group';

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

/** Accessible radio group (Radix) — roving tabindex + arrow-key nav, styled via caller classNames. */
export function RadioGroup({
  value,
  onChange,
  options,
  ariaLabel,
  className,
  itemClassName,
}: RadioGroupProps) {
  return (
    <RadixRadioGroup.Root
      value={value}
      onValueChange={onChange}
      aria-label={ariaLabel}
      className={className}
      loop
    >
      {options.map((opt) => (
        <RadixRadioGroup.Item
          key={opt.value}
          value={opt.value}
          disabled={opt.disabled}
          className={itemClassName?.(opt.value, opt.value === value)}
        >
          {opt.label}
        </RadixRadioGroup.Item>
      ))}
    </RadixRadioGroup.Root>
  );
}
