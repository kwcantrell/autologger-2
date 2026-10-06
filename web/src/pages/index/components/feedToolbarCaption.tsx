import {
  Check,
  Clock,
  Download,
  Filter,
  Pencil,
  Pin,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
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

// Toolbar icons: lucide (shadcn-port-workspace D6). The `Icon*` names are kept as thin aliases so
// call sites (EventLogSheet, GenerateToolbar, ExportFeed, AiV2Panel) are unchanged. 18px,
// `currentColor`, decorative (the caption's label carries the name).
const ICON = { className: 'block size-[18px]', 'aria-hidden': true } as const;

export const IconSparkles = () => <Sparkles {...ICON} />;
export const IconPlus = () => <Plus {...ICON} />;
export const IconPencil = () => <Pencil {...ICON} />;
export const IconCheck = () => <Check {...ICON} />;
export const IconX = () => <X {...ICON} />;
export const IconClock = () => <Clock {...ICON} />;
export const IconFilter = () => <Filter {...ICON} />;
export const IconDownload = () => <Download {...ICON} />;
export const IconKeep = () => <Pin {...ICON} />;
export const IconTrash = () => <Trash2 {...ICON} />;
