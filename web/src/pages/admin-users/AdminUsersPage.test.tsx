import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../api/client';
import type { AdminStudio } from '../../api/types';
import { renderStrict } from '../../test/renderStrict';
import { AdminUsersPage } from './AdminUsersPage';

// --- AdminUsersPage regression coverage (web-api-shape-conformance, task 1.1) ---
//
// The client previously typed a user's team memberships as `memberships:
// string[]`, but `GET /api/admin/users` has always emitted `studios:
// [{id, name}]` (server/src/routers/admin.ts's `usersOut.push({…studios:
// mids.map(…)})`) — `u.memberships.map(...)` threw on every real response,
// white-screening the page (no error boundary exists anywhere in web/src).
// These fixtures are deliberately wire-accurate: a hand-authored fixture
// that restates the client's own (wrong) belief would pass while the real
// page stayed broken (design.md D2). Superseded by the captured fixture in
// phase 4 (task 4.4).
//
// `apiFetch` is the sole network seam, mocked at the module boundary (the
// TeamsRoute.test.tsx idiom); `fetchAdmin` in AdminUsersPage.tsx is a thin
// wrapper around it and is exercised for real.

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

// Radix Popover positions via floating-ui, which constructs a ResizeObserver
// jsdom doesn't provide (RecentSessionsList.test.tsx idiom).
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}

// Wire shape of a `GET /api/admin/users` user row, declared locally (not
// imported from api/types) so this fixture stays wire-accurate independent
// of whatever the client type currently declares.
interface WireAdminUser {
  id: string;
  email: string;
  given_name: string;
  family_name: string;
  picture_url: string;
  created_at_utc: string;
  disabled: boolean;
  studios: { id: string; name: string }[];
}

function studiosCatalog(): AdminStudio[] {
  return [
    { id: 'my-crew', name: 'My Crew', builtin: false },
    { id: 'ymhs', name: 'YMHS', builtin: false },
  ];
}

function wireUser(overrides: Partial<WireAdminUser> = {}): WireAdminUser {
  return {
    id: 'user-1',
    email: 'user1@example.com',
    given_name: 'Ann',
    family_name: 'Admin',
    picture_url: '',
    created_at_utc: '2026-07-14T00:00:00Z',
    disabled: false,
    studios: [{ id: 'my-crew', name: 'My Crew' }],
    ...overrides,
  };
}

function mockUsersResponse(users: WireAdminUser[], studios: AdminStudio[] = studiosCatalog()) {
  mockedApiFetch.mockResolvedValue({ studios_catalog: studios, users });
}

function usersTbody(container: HTMLElement): HTMLElement {
  const el = container.querySelector('#users-tbody');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

async function renderAndLoad() {
  const view = renderStrict(<AdminUsersPage />);
  fireEvent.change(screen.getByPlaceholderText('AUTOLOGGER_ADMIN_TOKEN'), {
    target: { value: 'secret-token' },
  });
  fireEvent.click(screen.getByRole('button', { name: /load data/i }));
  await waitFor(() => expect(view.container.querySelector('#users-tbody')).not.toBeNull());
  return view;
}

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe('AdminUsersPage — membership rendering (spec: web-admin-users)', () => {
  it('renders a user with memberships as a chip and does not crash', async () => {
    mockUsersResponse([wireUser()]);

    const { container } = await renderAndLoad();

    const tbody = usersTbody(container);
    expect(within(tbody).getByText('user1@example.com')).not.toBeNull();
    expect(within(tbody).getAllByRole('button', { name: /^Remove from/ })).toHaveLength(1);
  });

  it('renders a user with zero memberships and still offers the add control', async () => {
    mockUsersResponse([wireUser({ studios: [] })]);

    const { container } = await renderAndLoad();

    const tbody = usersTbody(container);
    expect(within(tbody).queryAllByRole('button', { name: /^Remove from/ })).toHaveLength(0);
    expect(
      within(tbody).getByRole('button', { name: 'Add team membership for user1@example.com' }),
    ).not.toBeNull();
  });

  it('renders a membership whose name equals its id (orphaned-team fallback)', async () => {
    mockUsersResponse([wireUser({ studios: [{ id: 'ghost', name: 'ghost' }] })]);

    const { container } = await renderAndLoad();

    expect(within(usersTbody(container)).getByText('ghost')).not.toBeNull();
  });

  it('offers only teams the user is not already in', async () => {
    mockUsersResponse([wireUser({ studios: [{ id: 'my-crew', name: 'My Crew' }] })]);
    const { container } = await renderAndLoad();

    fireEvent.click(
      within(usersTbody(container)).getByRole('button', {
        name: 'Add team membership for user1@example.com',
      }),
    );

    expect(await screen.findByRole('menuitem', { name: 'YMHS' })).not.toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'My Crew' })).toBeNull();
  });

  it('a user in every team is offered nothing', async () => {
    mockUsersResponse([
      wireUser({
        studios: [
          { id: 'my-crew', name: 'My Crew' },
          { id: 'ymhs', name: 'YMHS' },
        ],
      }),
    ]);
    const { container } = await renderAndLoad();

    fireEvent.click(
      within(usersTbody(container)).getByRole('button', {
        name: 'Add team membership for user1@example.com',
      }),
    );

    await waitFor(() => expect(screen.queryAllByRole('menuitem')).toHaveLength(0));
  });

  it('the remove control issues DELETE …/memberships/<id>', async () => {
    mockUsersResponse([wireUser({ studios: [{ id: 'my-crew', name: 'My Crew' }] })]);
    const { container } = await renderAndLoad();

    fireEvent.click(within(usersTbody(container)).getByRole('button', { name: /^Remove from/ }));

    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenCalledWith(
        'admin/users/user-1/memberships/my-crew',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
  });
});

// --- Membership chips are labelled with the team display name (task 1.3,
// spec: web-admin-users D8) ---
describe('AdminUsersPage — membership chip labelling (spec: web-admin-users, D8)', () => {
  it('shows the display name on the chip, not the slug id', async () => {
    mockUsersResponse([wireUser({ studios: [{ id: 'my-crew', name: 'My Crew' }] })]);

    const { container } = await renderAndLoad();

    const tbody = usersTbody(container);
    expect(within(tbody).getByText('My Crew')).not.toBeNull();
    expect(within(tbody).queryByText('my-crew')).toBeNull();
  });

  it("the remove control's accessible name is 'Remove from <name>', but the request stays keyed by id", async () => {
    mockUsersResponse([wireUser({ studios: [{ id: 'my-crew', name: 'My Crew' }] })]);
    const { container } = await renderAndLoad();

    const removeButton = within(usersTbody(container)).getByRole('button', {
      name: 'Remove from My Crew',
    });
    fireEvent.click(removeButton);

    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenCalledWith(
        'admin/users/user-1/memberships/my-crew',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
  });
});
