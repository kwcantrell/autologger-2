import { Alert, AlertDescription } from '../../../shared/components/ui/alert';

/**
 * Recorder notices (media-worker design D17, D19; spec live-recording-chunks "Recording keeps the
 * screen awake and warns when hidden", "A lost microphone is re-acquired"). Persistent in-page
 * notices, never toasts: the recorder clears them on the user's next action.
 */

export interface HiddenInterval {
  fromMs: number;
  toMs: number;
}

/** "45 s", "3 min", "1 h 5 min". */
export function formatHiddenDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function hiddenTabMessage(interval: HiddenInterval, mobileSafari: boolean): string {
  const span = `${formatHiddenDuration(interval.toMs - interval.fromMs)} (${clock(interval.fromMs)}–${clock(interval.toMs)})`;
  return mobileSafari
    ? `This tab was in the background for ${span}. On this device capture may have paused while the tab was hidden; keep this tab visible while recording.`
    : `Recording continued in the background for ${span}. Browsers may throttle a hidden tab; keep this tab visible while recording.`;
}

export interface HiddenTabWarningProps {
  interval: HiddenInterval | null;
  mobileSafari?: boolean;
  /** Persistent notice after a microphone re-acquisition (D19). */
  micChanged?: boolean;
}

export function HiddenTabWarning({
  interval,
  mobileSafari = false,
  micChanged = false,
}: HiddenTabWarningProps) {
  if (!interval && !micChanged) return null;
  return (
    <Alert
      role="status"
      data-testid="recorder-notice"
      className="fixed inset-x-0 bottom-0 z-(--z-toast) mx-auto mb-2 block w-[min(640px,94vw)] shadow-[0_8px_32px_rgba(0,0,0,0.35)]"
    >
      {micChanged && (
        <AlertDescription className="m-0 block" data-testid="mic-changed-notice">
          Microphone changed; recording continues.
        </AlertDescription>
      )}
      {interval && (
        <AlertDescription className="m-0 block" data-testid="hidden-tab-warning">
          {hiddenTabMessage(interval, mobileSafari)}
        </AlertDescription>
      )}
    </Alert>
  );
}
