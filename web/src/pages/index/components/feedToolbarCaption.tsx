import type { ReactNode } from 'react';

/** Icon-only on mobile by default; desktop shows the text label.
 *  Pass `alwaysLabel` when several sibling actions share the same icon. */
export function FeedToolbarCaption({
  label,
  icon,
  alwaysLabel = false,
}: {
  label: string;
  icon: ReactNode;
  alwaysLabel?: boolean;
}) {
  return (
    <>
      <span
        className={
          alwaysLabel
            ? 'inline-flex items-center justify-center'
            : 'inline-flex items-center justify-center md:hidden'
        }
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className={alwaysLabel ? undefined : 'max-md:sr-only'}>{label}</span>
    </>
  );
}

const ICON = 'block';

export function IconSparkles() {
  return (
    <svg className={ICON} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3.5L13.2 8.3L18 9.5L13.2 10.7L12 15.5L10.8 10.7L6 9.5L10.8 8.3L12 3.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M18.5 14.5L19.1 16.9L21.5 17.5L19.1 18.1L18.5 20.5L17.9 18.1L15.5 17.5L17.9 16.9L18.5 14.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M5.5 15L6 16.8L7.8 17.3L6 17.8L5.5 19.6L5 17.8L3.2 17.3L5 16.8L5.5 15Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconPlus() {
  return (
    <svg className={ICON} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5V19M5 12H19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function IconPencil() {
  return (
    <svg className={ICON} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 20H8L18.5 9.5C19.3284 8.67157 19.3284 7.32843 18.5 6.5V6.5C17.6716 5.67157 16.3284 5.67157 15.5 6.5L5 17V20Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M14 8L17 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function IconCheck() {
  return (
    <svg className={ICON} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 12.5L10 17.5L19 7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconX() {
  return (
    <svg className={ICON} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 6L18 18M18 6L6 18"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconClock() {
  return (
    <svg className={ICON} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 7.5V12.5L15 14.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconFilter() {
  return (
    <svg className={ICON} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 6H20L14 12.5V18L10 20V12.5L4 6Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconDownload() {
  return (
    <svg className={ICON} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 4V15M12 15L8 11M12 15L16 11"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M5 19H19" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function IconKeep() {
  return (
    <svg className={ICON} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 4H18V20L12 16.5L6 20V4Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconTrash() {
  return (
    <svg className={ICON} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 7H19M10 7V5H14V7M8 7V19H16V7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
