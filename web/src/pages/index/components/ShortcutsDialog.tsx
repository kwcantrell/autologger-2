import { Dialog } from '../../../shared/ui/Dialog';

/**
 * Keyboard shortcut reference (ui-refresh): every shortcut listed here exists —
 * Space (AudioPlayer), arrow scrub (Timeline slider — only while the playhead
 * slider has focus), +/− zoom (useZoomRail), 1–9 category logging
 * (CategoryButtonStrip, while the live dock is shown), and the ? key that opens
 * this dialog (SessionWorkspace). Keep this list in sync when handlers change.
 */
const SHORTCUTS: ReadonlyArray<{ keys: string[]; desc: string }> = [
  { keys: ['1–9'], desc: 'Log the 1st–9th category button (while the live log is shown)' },
  { keys: ['Space'], desc: 'Play / pause recorded audio' },
  {
    keys: ['←', '→'],
    desc: 'Scrub the timeline 1s when the playhead is focused (hold Shift for 10s)',
  },
  { keys: ['+', '−'], desc: 'Zoom the timeline in / out' },
  { keys: ['Esc'], desc: 'Close dialogs, cancel batch edit, close the drawer' },
  { keys: ['?'], desc: 'Open this shortcut reference' },
];

const KBD =
  'inline-flex min-w-[1.7rem] items-center justify-center rounded-[0.4rem] border border-v5-border-strong bg-[rgba(7,11,20,0.72)] px-[0.4rem] py-[0.18rem] text-[0.72rem] font-semibold leading-none text-v5-text shadow-[inset_0_-1px_0_rgba(255,255,255,0.06)] [font-family:var(--font-mono)]';

/** True when the event target is a text-entry surface a hotkey must not steal from. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const t = el.tagName;
  return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ShortcutsDialog({ open, onClose }: Props) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Keyboard shortcuts"
      description="Shortcuts stay out of the way while you type in any field."
    >
      <ul className="m-0 flex list-none flex-col gap-[0.55rem] p-0">
        {SHORTCUTS.map((s) => (
          <li key={s.desc} className="flex items-center justify-between gap-4">
            <span className="text-[0.85rem] leading-[1.4] text-v5-text">{s.desc}</span>
            <span className="inline-flex shrink-0 items-center gap-[0.3rem]">
              {s.keys.map((k) => (
                <kbd key={k} className={KBD}>
                  {k}
                </kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
