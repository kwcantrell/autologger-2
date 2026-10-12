import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../shared/ui/Tooltip';
import { RECORD_RECOVERING_REASON, TransportControls } from './TransportControls';

// media-worker D10: Record is held until the recovery scan of unsent audio completes (the
// recorder's `scanning` phase, whose toggle refuses). The Record control shows that: it looks
// disabled and carries the reason accessibly, instead of a click that silently does nothing.

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('../../../api/hooks/useSessionStatus', () => ({
  // Rolling: the state in which Record audio is normally enabled.
  useSessionStatus: () => ({ data: { is_rolling: true, audio_recording_lease_alive: false } }),
}));
vi.mock('../../../api/hooks/useTransport', () => ({
  useTransport: () => ({
    start: { mutateAsync: vi.fn() },
    stop: { mutateAsync: vi.fn() },
  }),
}));

function renderControls(recordRecovering: boolean, onAudioRecord = vi.fn()) {
  render(
    <TooltipProvider delayDuration={0}>
      <TransportControls
        sessionId="s1"
        onAudioRecord={onAudioRecord}
        recordRecovering={recordRecovering}
      />
    </TooltipProvider>,
  );
  return onAudioRecord;
}

afterEach(() => vi.clearAllMocks());

describe('TransportControls while the recorder recovers unsent audio', () => {
  it('disables Record audio and names the reason', () => {
    const onAudioRecord = renderControls(true);
    const btn = screen.getByRole('button', { name: 'Record audio' });
    expect(btn).toHaveProperty('disabled', true);
    expect(RECORD_RECOVERING_REASON).toBe('Recovering unsent audio…');
    const describedBy = btn.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      'Recovering unsent audio…',
    );
    fireEvent.click(btn);
    expect(onAudioRecord).not.toHaveBeenCalled();
  });

  it('leaves the other controls alone', () => {
    renderControls(true);
    expect(screen.getByRole('button', { name: 'Stop timecode' })).toHaveProperty('disabled', false);
  });

  it('enables Record audio once the scan is done', () => {
    const onAudioRecord = renderControls(false);
    const btn = screen.getByRole('button', { name: 'Record audio' });
    expect(btn).toHaveProperty('disabled', false);
    expect(btn.getAttribute('aria-describedby')).toBeNull();
    fireEvent.click(btn);
    expect(onAudioRecord).toHaveBeenCalledTimes(1);
  });
});
