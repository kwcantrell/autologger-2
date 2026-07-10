import * as RadixSelect from '@radix-ui/react-select';
import clsx from 'clsx';
import { forwardRef } from 'react';
import styles from './Select.module.css';

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
}

export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  { value, onChange, options, id, className, ariaLabel, placeholder, disabled, name },
  ref,
) {
  return (
    <RadixSelect.Root value={value} onValueChange={onChange} disabled={disabled} name={name}>
      <RadixSelect.Trigger
        ref={ref}
        id={id}
        aria-label={ariaLabel}
        className={clsx(styles.trigger, className)}
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon className={styles.icon}>
          <svg width="10" height="6" viewBox="0 0 10 6" fill="none" role="img" aria-label="open">
            <title>Open</title>
            <path
              d="M1 1L5 5L9 1"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          className={styles.content}
          position="popper"
          sideOffset={4}
          collisionPadding={8}
        >
          <RadixSelect.ScrollUpButton className={styles.scrollBtn} aria-hidden>
            ▲
          </RadixSelect.ScrollUpButton>
          <RadixSelect.Viewport className={styles.viewport}>
            {options.map((opt) => (
              <RadixSelect.Item
                key={opt.value}
                value={opt.value}
                disabled={opt.disabled}
                className={styles.item}
              >
                <RadixSelect.ItemText>{opt.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator className={styles.itemIndicator} aria-hidden>
                  ✓
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
          <RadixSelect.ScrollDownButton className={styles.scrollBtn} aria-hidden>
            ▼
          </RadixSelect.ScrollDownButton>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
});
