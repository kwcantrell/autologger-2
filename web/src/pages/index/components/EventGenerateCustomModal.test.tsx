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
// keys shared one checkbox state across rows). And because a show refetch
// mid-modal can remove a selected candidate, Generate is gated on the live
// candidates ∩ selected intersection — never enabled when a click would
// submit nothing.
//
// profile-shows-slimming: the category source is `useShow(showId)`
// (`GET /api/shows/:showId`), not the profile — `/api/profile` carries brief
// show entries with no categories at all.

const useShowMock = vi.fn();
vi.mock('../../../api/hooks/useShows', () => ({
  useShow: (...args: unknown[]) => useShowMock(...args),
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

function showWith(categories: ShowCategory[]) {
  return { data: { show: { id: SHOW_ID, categories } }, isPending: false };
}

beforeEach(() => {
  useShowMock.mockReset();
});

describe('EventGenerateCustomModal', () => {
  it('renders duplicate option labels as one row and submits one entry', () => {
    useShowMock.mockReturnValue(
      showWith([
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

  // profile-shows-slimming: the categories now arrive over the wire, so the
  // modal has a loading window it never had while reading the profile cache.
  it('fetches the show by id and says so while the fetch is in flight', () => {
    useShowMock.mockReturnValue({ data: undefined, isPending: true });
    renderStrict(
      <EventGenerateCustomModal showId={SHOW_ID} onSubmit={vi.fn()} onClose={() => {}} />,
    );

    expect(useShowMock).toHaveBeenCalledWith(SHOW_ID);
    expect(screen.getByText('Loading instructions…')).toBeTruthy();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('claims no loading state when there is no show to fetch', () => {
    // A disabled query reports `isPending: true` forever; pairing it with the
    // id is what keeps the modal from claiming to load a show it never asked
    // for.
    useShowMock.mockReturnValue({ data: undefined, isPending: true });
    renderStrict(<EventGenerateCustomModal showId={null} onSubmit={vi.fn()} onClose={() => {}} />);

    expect(screen.queryByText('Loading instructions…')).toBeNull();
  });

  // --- Failed show fetch (PR review finding 3) ---
  //
  // An errored `useShow` settles: `isPending` goes false and `candidates` is
  // empty, so the modal used to render a blank body with a dead Generate
  // button — pixel-identical to a show that genuinely has no auto-instructions.
  it('surfaces a failed show fetch with a message and a working Retry', () => {
    const refetch = vi.fn();
    useShowMock.mockReturnValue({ data: undefined, isPending: false, isError: true, refetch });
    renderStrict(
      <EventGenerateCustomModal showId={SHOW_ID} onSubmit={vi.fn()} onClose={() => {}} />,
    );

    expect(screen.getByText('Couldn’t load instructions.')).toBeTruthy();
    // Not the settled-but-empty state, and not a false pending claim either.
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByText('Loading instructions…')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  // --- Offline-PAUSED show fetch (PR review finding 2) ---
  //
  // react-query's default `networkMode: 'online'` HOLDS a fetch while the browser is
  // offline: `isPending` stays true and `isError` stays false for as long as the network is
  // down. Read as "loading", that stranded the modal on "Loading instructions…" forever,
  // with a dead Generate button and the only Retry in the unreachable error branch.
  // `useAiV2WidgetData` draws the same paused-vs-loading distinction.
  it('names an offline hold instead of claiming an indefinite load, and keeps Retry', () => {
    const refetch = vi.fn();
    useShowMock.mockReturnValue({
      data: undefined,
      isPending: true,
      isError: false,
      fetchStatus: 'paused',
      refetch,
    });
    renderStrict(
      <EventGenerateCustomModal showId={SHOW_ID} onSubmit={vi.fn()} onClose={() => {}} />,
    );

    expect(screen.getByText('You’re offline — can’t load instructions.')).toBeTruthy();
    // Specifically NOT the loading hint: nothing is in flight to finish.
    expect(screen.queryByText('Loading instructions…')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('says nothing about a paused BACKGROUND refetch over already-rendered instructions', () => {
    useShowMock.mockReturnValue({
      ...showWith([dropdownCategory([{ label: 'Cam A', auto_instruction: 'aim at host' }])]),
      isError: false,
      fetchStatus: 'paused',
      refetch: vi.fn(),
    });
    renderStrict(
      <EventGenerateCustomModal showId={SHOW_ID} onSubmit={vi.fn()} onClose={() => {}} />,
    );

    // Data is on screen, so the pause withholds nothing and warrants no banner.
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.queryByText('You’re offline — can’t load instructions.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('claims no offline state when there is no show to fetch', () => {
    useShowMock.mockReturnValue({
      data: undefined,
      isPending: true,
      isError: false,
      fetchStatus: 'paused',
      refetch: vi.fn(),
    });
    renderStrict(<EventGenerateCustomModal showId={null} onSubmit={vi.fn()} onClose={() => {}} />);

    expect(screen.queryByText('You’re offline — can’t load instructions.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('claims no error state when there is no show to fetch', () => {
    useShowMock.mockReturnValue({ data: undefined, isPending: true, isError: false });
    renderStrict(<EventGenerateCustomModal showId={null} onSubmit={vi.fn()} onClose={() => {}} />);

    expect(screen.queryByText('Couldn’t load instructions.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('disables Generate when a refetch removes the selected candidate', () => {
    useShowMock.mockReturnValue(
      showWith([dropdownCategory([{ label: 'Cam A', auto_instruction: 'aim at host' }])]),
    );
    const onSubmit = vi.fn();
    const { rerender } = renderStrict(
      <EventGenerateCustomModal showId={SHOW_ID} onSubmit={onSubmit} onClose={() => {}} />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: /Cam A/ }));
    const generate = () => screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement;
    expect(generate().disabled).toBe(false);

    // Show refetch resolves without the selected option (edited elsewhere).
    useShowMock.mockReturnValue(showWith([dropdownCategory([])]));
    rerender(<EventGenerateCustomModal showId={SHOW_ID} onSubmit={onSubmit} onClose={() => {}} />);

    expect(generate().disabled).toBe(true);
    fireEvent.click(generate());
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
