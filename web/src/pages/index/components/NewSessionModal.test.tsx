import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCreateSession } from '../../../api/hooks/useSessions';
import type { ProfilePayload } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { NewSessionModal } from './NewSessionModal';

// --- NewSessionModal conditional episode field (session-title-suffix, task 2.2) ---
//
// Spec "New Session modal respects suffix": the episode input is visible only when
// the selected show's `title_suffix === 'episode'`; the old Bonus toggle is gone
// entirely; switching to a Date-suffix show clears any stale episode text rather
// than silently carrying it forward. `apiFetch` and `useCreateSession` are mocked at
// the module boundary — this pins the modal's own field-visibility/submit logic, not
// the network or react-query plumbing.

vi.mock('../../../api/client', () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../../api/hooks/useSessions', () => ({
  useCreateSession: vi.fn(),
}));

vi.mock('../utils/toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('../../../shared/ui/Dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children: React.ReactNode }) =>
    open === false ? null : <div role="dialog">{children}</div>,
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

const mockedUseCreateSession = vi.mocked(useCreateSession);

const dateShow = { id: 'show-date', name: 'Date Show', show_code: 'DS', title_suffix: 'date' };
const episodeShow = {
  id: 'show-ep',
  name: 'Episode Show',
  show_code: 'ES',
  title_suffix: 'episode',
};

const profile = {
  active_studio_id: 'studio-1',
  active_show_id: 'show-ep',
  shows: [episodeShow, dateShow],
  new_session_defaults: { default_frame_rate: 24, title_prefix: '' },
} as unknown as ProfilePayload;

let mutate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mutate = vi.fn();
  mockedUseCreateSession.mockReturnValue({
    mutate,
    isPending: false,
  } as unknown as ReturnType<typeof useCreateSession>);
});

describe('NewSessionModal — no Bonus control', () => {
  it('never renders a Bonus toggle', () => {
    renderStrict(<NewSessionModal profile={profile} onClose={vi.fn()} onCreated={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Bonus' })).toBeNull();
    expect(document.getElementById('ns-bonus-episode')).toBeNull();
  });
});

describe('NewSessionModal — conditional episode field', () => {
  it('shows the Episode field for an Episode-suffix show (the default active show)', () => {
    renderStrict(<NewSessionModal profile={profile} onClose={vi.fn()} onCreated={vi.fn()} />);

    expect(screen.getByText('Episode')).not.toBeNull();
    expect(document.getElementById('ns-episode')).not.toBeNull();
  });

  it('hides the Episode field for a Date-suffix show', () => {
    const dateActiveProfile = { ...profile, active_show_id: 'show-date' } as ProfilePayload;
    renderStrict(
      <NewSessionModal profile={dateActiveProfile} onClose={vi.fn()} onCreated={vi.fn()} />,
    );

    expect(screen.queryByText('Episode')).toBeNull();
    expect(document.getElementById('ns-episode')).toBeNull();
  });

  it('switching from an Episode-suffix show to a Date-suffix show hides the field and clears stale text', () => {
    renderStrict(<NewSessionModal profile={profile} onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.change(document.getElementById('ns-episode') as HTMLInputElement, {
      target: { value: '7' },
    });
    expect((document.getElementById('ns-episode') as HTMLInputElement).value).toBe('7');

    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'show-date' } });
    expect(document.getElementById('ns-episode')).toBeNull();

    // Switch back to the Episode-suffix show: the field reappears blank, not '7'.
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'show-ep' } });
    expect((document.getElementById('ns-episode') as HTMLInputElement).value).toBe('');
  });

  it('refuses submit while Episode is blank for an Episode-suffix show', () => {
    renderStrict(<NewSessionModal profile={profile} onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Create & open' }));

    expect(mutate).not.toHaveBeenCalled();
  });

  it('submits the trimmed episode for an Episode-suffix show', () => {
    renderStrict(<NewSessionModal profile={profile} onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.change(document.getElementById('ns-episode') as HTMLInputElement, {
      target: { value: '  7  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create & open' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    const body = mutate.mock.calls[0][0] as { episode?: string };
    expect(body.episode).toBe('7');
  });

  it('submits without requiring or fabricating an episode for a Date-suffix show', async () => {
    const dateActiveProfile = { ...profile, active_show_id: 'show-date' } as ProfilePayload;
    renderStrict(
      <NewSessionModal profile={dateActiveProfile} onClose={vi.fn()} onCreated={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create & open' }));

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    const body = mutate.mock.calls[0][0] as { episode?: string; title?: string };
    expect(body.episode).toBeUndefined();
    expect(body.title).toBeUndefined();
  });
});
