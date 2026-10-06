import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderStrict } from '../../../test/renderStrict';
import { YouTubeImportErrorModal } from './YouTubeImportErrorModal';

vi.mock('../../../api/client', () => ({ apiFetch: vi.fn().mockResolvedValue({}) }));
vi.mock('../utils/toast', () => ({ showToast: vi.fn() }));

// shadcn-port-modals D4: the failure modal's actions are shadcn Buttons; the retry link input has
// an accessible name.
describe('YouTubeImportErrorModal', () => {
  function renderModal(onRetry = vi.fn()) {
    renderStrict(
      <YouTubeImportErrorModal
        sessionId="s1"
        lastUrl="https://youtu.be/x"
        onRetry={onRetry}
        onContinue={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    return onRetry;
  }

  it('offers the three choices with their Button variants', () => {
    renderModal();
    const variant = (name: string) =>
      screen.getByRole('button', { name }).getAttribute('data-variant');
    expect(variant('Try a different link')).toBe('default');
    expect(variant('Continue without audio')).toBe('outline');
    expect(variant("Don't create session")).toBe('destructive');
    expect(screen.getByRole('button', { name: 'Continue without audio' }).className).toContain(
      'max-md:min-h-11',
    );
  });

  it('Try a different link shows a named link input whose Import retries with the trimmed URL', () => {
    const onRetry = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Try a different link' }));
    const input = screen.getByRole('textbox', { name: 'YouTube video link' });
    fireEvent.change(input, { target: { value: '  https://youtu.be/y  ' } });
    const importBtn = screen.getByRole('button', { name: 'Import' });
    expect(importBtn.getAttribute('data-variant')).toBe('default');
    fireEvent.click(importBtn);
    expect(onRetry).toHaveBeenCalledWith('https://youtu.be/y');
  });
});
