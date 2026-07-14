import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCreateShow, useProfile, useProfileMutation } from '../../../api/hooks/useProfile';
import type { ProfilePayload } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { HomeSettingsModal } from './HomeSettingsModal';

// --- HomeSettingsModal studio-switch tests (session-deep-links, task 3.3;
// spec: web-session-routing "Studio-switch close path still works") ---
//
// The save handler's studio-switch branch was the sole in-app caller of the
// retired `window.V3_closeSession` global; it now calls the onCloseSession
// prop (AppShell's close handler, which navigates to `/`). These tests pin
// that branch: prop called exactly once on a studio change, not called when
// the studio is unchanged. Profile hooks, react-query, and chrome-heavy
// children (Dialog, Select, FpsSelect, EventButtonsTable) are mocked at the
// module boundary — AppShell.test.tsx covers what the prop does.

vi.mock('../../../api/hooks/useProfile', () => ({
  useProfile: vi.fn(),
  useProfileMutation: vi.fn(),
  useCreateShow: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('../utils/toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('../../../shared/ui/Dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
}));

vi.mock('./Select', () => ({
  Select: (props: {
    id?: string;
    ariaLabel?: string;
    value: string;
    disabled?: boolean;
    onChange: (value: string) => void;
    options: { value: string; label: string; disabled?: boolean }[];
  }) => (
    <select
      id={props.id}
      aria-label={props.ariaLabel}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value)}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

vi.mock('./FpsSelect', () => ({ FpsSelect: () => null }));
vi.mock('./EventButtonsTable', () => ({ EventButtonsTable: () => null }));

const mockedUseProfile = vi.mocked(useProfile);
const mockedUseProfileMutation = vi.mocked(useProfileMutation);
const mockedUseCreateShow = vi.mocked(useCreateShow);

const profile = {
  active_studio_id: 'studio-1',
  active_show_id: null,
  active_studio: { id: 'studio-1', name: 'Studio One', categories: [] },
  studios: [
    { id: 'studio-1', name: 'Studio One', categories: [] },
    { id: 'studio-2', name: 'Studio Two', categories: [] },
  ],
  studio_settings: {},
  shows: [],
  new_session_defaults: { title_prefix: '', default_frame_rate: 30 },
  admin: { restart_supported: false, restart_needs_token: false },
  auth: { logged_in: false, oauth_configured: true, user: null },
} as unknown as ProfilePayload;

let mutateAsync: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mutateAsync = vi.fn().mockResolvedValue({});
  mockedUseProfile.mockReturnValue({ data: profile } as unknown as ReturnType<typeof useProfile>);
  mockedUseProfileMutation.mockReturnValue({
    mutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useProfileMutation>);
  mockedUseCreateShow.mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useCreateShow>);
});

describe('HomeSettingsModal studio-switch save branch', () => {
  it('calls onCloseSession exactly once when the save changed the active studio', async () => {
    const onCloseSession = vi.fn();
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={onCloseSession} />);

    fireEvent.change(screen.getByLabelText('Team'), { target: { value: 'studio-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ active_studio_id: 'studio-2' });
    await waitFor(() => expect(onCloseSession).toHaveBeenCalledTimes(1));
  });

  it('does not call onCloseSession when the active studio is unchanged', async () => {
    const onCloseSession = vi.fn();
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={onCloseSession} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(onCloseSession).not.toHaveBeenCalled();
  });
});
