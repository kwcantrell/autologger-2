import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderStrict } from '../../../test/renderStrict';
import { TranscribeModal } from './TranscribeModal';

// shadcn-port-modals D4: the finished transcription offers its CSV as a real download link
// rendered as a Button; the dismiss action sits in the dialog actions row.
describe('TranscribeModal', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('when done, Download CSV is an <a download> Button and Close is in the actions row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob(['a,b'])) }),
    );
    URL.createObjectURL = vi.fn(() => 'blob:csv');
    URL.revokeObjectURL = vi.fn();
    renderStrict(<TranscribeModal sessionId="abcdef123456" onClose={vi.fn()} />);
    const link = await screen.findByRole('link', { name: 'Download CSV' });
    expect(link.getAttribute('download')).toBe('transcription_abcdef12.csv');
    expect(link.getAttribute('data-slot')).toBe('button');
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.closest('[data-slot="dialog-actions"]')).not.toBeNull();
  });
});
