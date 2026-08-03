import { useEffect } from 'react';
import { runMicLevelMeter } from '../utils/micLevelMeter';

interface Props {
  /** Open the mic and drive the strip level bar (rolling, not recording). */
  active: boolean;
}

/**
 * Headless preview meter while the session is rolling but not mic-recording.
 * AudioRecorder owns the bar once a local recording stream is live.
 */
export function MicLevelPreview({ active }: Props) {
  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    let stopMeter: (() => void) | null = null;
    let stream: MediaStream | null = null;

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        return;
      }
      if (cancelled) {
        for (const t of stream.getTracks()) t.stop();
        stream = null;
        return;
      }
      stopMeter = runMicLevelMeter(stream, () => !cancelled);
    })();

    return () => {
      cancelled = true;
      stopMeter?.();
      stopMeter = null;
      if (stream) {
        for (const t of stream.getTracks()) t.stop();
        stream = null;
      }
    };
  }, [active]);

  return null;
}
