import { fireEvent, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShowCategory } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { EventGenerateCustomModal } from './EventGenerateCustomModal';

// --- Custom generate modal candidate hygiene (PR#4 review fix) ---
//
// The server matches a selection entry by (category_id, trimmed option label)
// and dedupes labels into a Set, so duplicate option labels within a dropdown
// are ONE wire entry — the modal must render them as one row (duplicate React
// keys shared one checkbox state across rows). And because a profile refetch
// mid-modal can remove a selected candidate, Generate is gated on the live
// candidates ∩ selected intersection — never enabled when a click would
// submit nothing.

const useProfileMock = vi.fn();
vi.mock('../../../api/hooks/useProfile', () => ({
  useProfile: (...args: unknown[]) => useProfileMock(...args),
}));

beforeAll(() => {
  if (typeof window.matchMedia === 'function') return;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

const SHOW_ID = 'show-1';

function dropdownCategory(options: Array<{ label: string; auto_instruction?: string }>) {
  return {
    id: 'cams',
    name: 'Cameras',
    color: '#4488ff',
    type: 'DROPDOWN',
    dropdown_options: options,
    on_label: '',
    off_label: '',
  } as ShowCategory;
}

function profileWith(categories: ShowCategory[]) {
  return { data: { shows: [{ id: SHOW_ID, categories }] } };
}

beforeEach(() => {
  useProfileMock.mockReset();
});

describe('EventGenerateCustomModal', () => {
  it('renders duplicate option labels as one row and submits one entry', () => {
    useProfileMock.mockReturnValue(
      profileWith([
        dropdownCategory([
          { label: 'Cam A', auto_instruction: 'first copy' },
          { label: 'Cam A', auto_instruction: 'second copy' },
          { label: 'Cam B', auto_instruction: 'other' },
        ]),
      ]),
    );
    const onSubmit = vi.fn();
    renderStrict(
      <EventGenerateCustomModal showId={SHOW_ID} onSubmit={onSubmit} onClose={() => {}} />,
    );

    // One checkbox per distinct (category, label) — not one per stored option.
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);

    fireEvent.click(screen.getByRole('checkbox', { name: /Cam A/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith([
      { category_id: 'cams', option_label: 'Cam A' },
    ]);
  });

  it('disables Generate when a refetch removes the selected candidate', () => {
    useProfileMock.mockReturnValue(
      profileWith([dropdownCategory([{ label: 'Cam A', auto_instruction: 'aim at host' }])]),
    );
    const onSubmit = vi.fn();
    const { rerender } = renderStrict(
      <EventGenerateCustomModal showId={SHOW_ID} onSubmit={onSubmit} onClose={() => {}} />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: /Cam A/ }));
    const generate = () => screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement;
    expect(generate().disabled).toBe(false);

    // Profile refetch resolves without the selected option (edited elsewhere).
    useProfileMock.mockReturnValue(profileWith([dropdownCategory([])]));
    rerender(<EventGenerateCustomModal showId={SHOW_ID} onSubmit={onSubmit} onClose={() => {}} />);

    expect(generate().disabled).toBe(true);
    fireEvent.click(generate());
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
