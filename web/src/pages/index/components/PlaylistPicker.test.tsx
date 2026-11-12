import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  YoutubePlaylistEntry,
  YoutubePlaylistResponse,
  YoutubePlaylistUnavailableReason,
} from '../../../api/types';
import { PlaylistPicker, type PlaylistSelection } from './PlaylistPicker';

// youtube-playlist-import task 8.3 (batch-audio-import "YouTube playlist selection", design D5).

function entry(
  index: number,
  reason: YoutubePlaylistUnavailableReason | null = null,
): YoutubePlaylistEntry {
  const video_id = `v${String(index).padStart(10, '0')}`;
  return {
    index,
    video_id,
    url: `https://www.youtube.com/watch?v=${video_id}`,
    title: reason === 'unavailable' ? null : `Video ${index}`,
    duration_s: reason === 'too_long' ? 16_606 : 125,
    importable: reason === null,
    reason,
  };
}

function listing(
  entries: YoutubePlaylistEntry[],
  opts: { title?: string; truncated?: boolean } = {},
): YoutubePlaylistResponse {
  return {
    playlist: {
      id: 'PLx',
      title: opts.title ?? 'My list',
      url: 'https://www.youtube.com/playlist?list=PLx',
    },
    entries,
    truncated: opts.truncated ?? false,
  };
}

/** 10 entries, position 4 unavailable and 7 too_long. */
const TEN = listing(
  Array.from({ length: 10 }, (_, i) =>
    entry(i + 1, i + 1 === 4 ? 'unavailable' : i + 1 === 7 ? 'too_long' : null),
  ),
);

function box(position: number): HTMLInputElement {
  return screen.getByRole('checkbox', { name: new RegExp(`^${position}\\. `) }) as HTMLInputElement;
}

function checkedPositions(): number[] {
  return screen
    .getAllByRole('checkbox')
    .filter((el) => (el as HTMLInputElement).dataset.position && (el as HTMLInputElement).checked)
    .map((el) => Number((el as HTMLInputElement).dataset.position));
}

function renderPicker(l: YoutubePlaylistResponse, disabled = false) {
  const onChange = vi.fn<(s: PlaylistSelection) => void>();
  const view = render(<PlaylistPicker listing={l} disabled={disabled} onChange={onChange} />);
  return { onChange, view };
}

describe('PlaylistPicker', () => {
  it('shows the title, the count and every entry with position, title or Unavailable video, and duration', () => {
    renderPicker(TEN);
    expect(screen.getByText('My list')).not.toBeNull();
    expect(screen.getByText('10 videos')).not.toBeNull();
    expect(box(1).closest('li')?.textContent).toContain('Video 1');
    expect(box(1).closest('li')?.textContent).toContain('2:05');
    expect(box(4).closest('li')?.textContent).toContain('Unavailable video');
    expect(box(7).closest('li')?.textContent).toContain('4:36:46');
  });

  it('checks importable entries by default; unavailable and too-long are greyed with reasons and uncheckable', () => {
    renderPicker(TEN);
    expect(checkedPositions()).toEqual([1, 2, 3, 5, 6, 8, 9, 10]);
    expect(box(4).disabled).toBe(true);
    expect(box(7).disabled).toBe(true);
    expect(box(4).closest('li')?.textContent).toContain('unavailable');
    expect(box(7).closest('li')?.textContent).toContain('over 4 hours');
    expect(box(4).closest('li')?.getAttribute('data-importable')).toBe('false');
    // A click on the disabled box changes nothing (jsdom flips a disabled box's `checked` on a
    // synthetic click, so the selection is read from the count, not from the element).
    fireEvent.click(box(4));
    expect(screen.getByTestId('playlist-selected-count').textContent).toBe('8 of 10 selected');
  });

  it('labels live and upcoming entries', () => {
    renderPicker(listing([entry(1, 'live'), entry(2, 'upcoming')]));
    expect(box(1).closest('li')?.textContent).toContain('live now');
    expect(box(2).closest('li')?.textContent).toContain('upcoming');
  });

  it('Select none and Select all act over importable entries only', () => {
    renderPicker(TEN);
    fireEvent.click(screen.getByRole('button', { name: 'Select none' }));
    expect(checkedPositions()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(checkedPositions()).toEqual([1, 2, 3, 5, 6, 8, 9, 10]);
  });

  it('From 3 To 6 checks exactly 3, 5 and 6 when 4 is unavailable', () => {
    renderPicker(TEN);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply range' }));
    expect(checkedPositions()).toEqual([3, 5, 6]);
  });

  it('counts the checked entries and reports the selection', () => {
    const { onChange } = renderPicker(TEN);
    expect(screen.getByTestId('playlist-selected-count').textContent).toBe('8 of 10 selected');
    fireEvent.click(box(2));
    expect(screen.getByTestId('playlist-selected-count').textContent).toBe('7 of 10 selected');
    expect(onChange).toHaveBeenLastCalledWith({
      indexes: [1, 3, 5, 6, 8, 9, 10],
      usePublishDate: true,
    });
  });

  it('"Use publish date" is checked by default and reported', () => {
    const { onChange } = renderPicker(TEN);
    const publish = screen.getByRole('checkbox', { name: 'Use publish date' }) as HTMLInputElement;
    expect(publish.checked).toBe(true);
    fireEvent.click(publish);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ usePublishDate: false }));
  });

  it('says only the first 5000 are shown when truncated', () => {
    renderPicker(listing([entry(1)], { truncated: true }));
    expect(screen.getByText(/only the first 5000 videos are shown/i)).not.toBeNull();
  });

  it('no truncated notice otherwise', () => {
    renderPicker(TEN);
    expect(screen.queryByText(/only the first 5000/i)).toBeNull();
  });

  it('disables every control while a run is in progress', () => {
    renderPicker(TEN, true);
    for (const el of screen.getAllByRole('checkbox'))
      expect((el as HTMLInputElement).disabled).toBe(true);
    for (const name of ['Select all', 'Select none', 'Apply range']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect((screen.getByLabelText('From') as HTMLInputElement).disabled).toBe(true);
  });

  it('a new listing replaces the rows and resets the selection to its importable entries', () => {
    const { view, onChange } = renderPicker(TEN);
    fireEvent.click(screen.getByRole('button', { name: 'Select none' }));
    fireEvent.click(box(9));
    const next = listing([entry(1), entry(2, 'unavailable'), entry(3)], { title: 'Other list' });
    view.rerender(<PlaylistPicker listing={next} disabled={false} onChange={onChange} />);
    expect(screen.getByText('Other list')).not.toBeNull();
    expect(screen.queryByText('My list')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /^9\. / })).toBeNull();
    expect(checkedPositions()).toEqual([1, 3]);
    expect(onChange).toHaveBeenLastCalledWith({ indexes: [1, 3], usePublishDate: true });
  });

  it('renders a 5000-entry listing and Select all completes', () => {
    const big = listing(
      Array.from({ length: 5000 }, (_, i) => entry(i + 1, i % 50 === 0 ? 'unavailable' : null)),
    );
    const { onChange } = renderPicker(big);
    fireEvent.click(screen.getByRole('button', { name: 'Select none' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByTestId('playlist-selected-count').textContent).toBe('4900 of 5000 selected');
    expect(onChange.mock.lastCall?.[0].indexes).toHaveLength(4900);
  }, 20_000);
});
