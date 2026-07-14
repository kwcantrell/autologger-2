import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Show } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { EventButtonsTable } from './EventButtonsTable';

// --- EventButtonsTable.copyFromShow (teams-settings-nav, task 1.1c) ---
//
// `profile.shows[].categories` (the `otherShows` prop's source) is served name-keyed
// (server: `showApiDict` passes stored `CategoryRecord` JSON through verbatim; see
// `server/src/db/showsStore.ts`). `copyFromShow` previously read `c.label` from that
// name-keyed shape, so copying from another show always produced blank names. This
// pins the fix: hydrate with `c.name ?? c.label ?? ''`. The fixture below is
// deliberately `name`-keyed with no `label` key, so a `label`-keyed fixture can't mask
// the bug.

vi.mock('./Select', () => ({
  Select: (props: {
    value: string;
    ariaLabel?: string;
    onChange: (value: string) => void;
    options: { value: string; label: string }[];
  }) => (
    <select
      aria-label={props.ariaLabel}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    >
      <option value="" />
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

const sourceShow = {
  id: 'show-2',
  studio_id: 'studio-1',
  name: 'Evening News',
  show_code: 'EN',
  next_episode: 3,
  categories: [
    {
      id: 'cat-9',
      name: 'Break',
      color: '#445566',
      type: 'BUTTON',
      dropdown_options: [],
      on_label: '',
      off_label: '',
    },
  ],
  event_palette: [],
  event_palette_preset: 'custom',
  event_palette_custom: [],
} as unknown as Show;

describe('EventButtonsTable.copyFromShow', () => {
  it('copies category names from a name-keyed source show', () => {
    const onChange = vi.fn();
    renderStrict(
      <EventButtonsTable
        buttons={[]}
        palette={[]}
        palettePreset="custom"
        paletteCustom={[]}
        otherShows={[sourceShow]}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('Show to copy event buttons from'), {
      target: { value: 'show-2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const [newButtons] = onChange.mock.calls[0] as [Array<{ name: string }>];
    expect(newButtons).toHaveLength(1);
    expect(newButtons[0]).toMatchObject({ name: 'Break' });
  });
});
