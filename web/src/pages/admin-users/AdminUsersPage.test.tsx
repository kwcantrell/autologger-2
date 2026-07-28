import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import adminUsersFixture from '../../../../fixtures/api-responses/adminUsers.json';
import { apiFetch } from '../../api/client';
import type { AdminDataResponse, AdminUser } from '../../api/types';
import { renderStrict } from '../../test/renderStrict';
import { AdminUsersPage } from './AdminUsersPage';

// --- AdminUsersPage regression coverage (web-api-shape-conformance, task 4.4) ---
//
// The client previously typed a user's team memberships as `memberships:
// string[]`, but `GET /api/admin/users` has always emitted `studios:
// [{id, name}]` (server/src/routers/admin.ts's `usersOut.push({…studios:
// mids.map(…)})`) — `u.memberships.map(...)` threw on every real response,
// white-screening the page (no error boundary exists anywhere in web/src).
//
// Phase 1 rendered these tests against a hand-authored (but wire-accurate)
// fixture, with a note that phase 4 would swap it for the captured artifact.
// This is that swap (`web-admin-users` requirement: "the admin tests and the
// conformance check validate against the same file"). `adminUsersFixture` is
// imported straight from `fixtures/api-responses/adminUsers.json` — the same
// file `server/src/routers/apiResponseFixtures.int.test.ts` captures by
// issuing a real `GET /api/admin/users` request, and the same file 5.1 will
// assign to `AdminUser`/`AdminDataResponse` for the type-level conformance
// check. Nothing here is hand-authored: every user/team object below is read
// out of that fixture by email, never constructed as a literal.
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

const FIXTURE: AdminDataResponse = adminUsersFixture;

// The fixture's captured seed (server/src/routers/apiResponseFixtures.int.test.ts):
//   ann@example.com  — one membership, `my-crew`
//   bo@example.com   — zero memberships
//   cleo@example.com — one membership, `{id: 'ghost-team', name: 'ghost-team'}`
//                       (admin.ts's `names[m] ?? m` fallback for an orphaned team)
//   dee@example.com  — a membership in every catalog studio (both built-ins
//                       plus `my-crew`/`ymhs`)
// and a `studios_catalog` of four teams: the two built-ins (`test-studios`,
// `test-studio-2`) plus `my-crew` and `ymhs`.
function userByEmail(email: string): AdminUser {
  const user = FIXTURE.users.find((u) => u.email === email);
  if (!user) {
    throw new Error(
      `captured fixture fixtures/api-responses/adminUsers.json has no user ${email} — re-check server/src/routers/apiResponseFixtures.int.test.ts's admin seed`,
    );
  }
  return user;
}

function mockUsersResponse(users: AdminUser[]) {
  mockedApiFetch.mockResolvedValue({ studios_catalog: FIXTURE.studios_catalog, users });
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
    mockUsersResponse([userByEmail('ann@example.com')]);

    const { container } = await renderAndLoad();

    const tbody = usersTbody(container);
    expect(within(tbody).getByText('ann@example.com')).not.toBeNull();
    expect(within(tbody).getAllByRole('button', { name: /^Remove from/ })).toHaveLength(1);
  });

  it('renders a user with zero memberships and still offers the add control', async () => {
    mockUsersResponse([userByEmail('bo@example.com')]);

    const { container } = await renderAndLoad();

    const tbody = usersTbody(container);
    expect(within(tbody).queryAllByRole('button', { name: /^Remove from/ })).toHaveLength(0);
    expect(
      within(tbody).getByRole('button', { name: 'Add team membership for bo@example.com' }),
    ).not.toBeNull();
  });

  it('renders a membership whose name equals its id (orphaned-team fallback)', async () => {
    mockUsersResponse([userByEmail('cleo@example.com')]);

    const { container } = await renderAndLoad();

    expect(within(usersTbody(container)).getByText('ghost-team')).not.toBeNull();
  });

  it('offers only teams the user is not already in', async () => {
    mockUsersResponse([userByEmail('ann@example.com')]);
    const { container } = await renderAndLoad();

    fireEvent.click(
      within(usersTbody(container)).getByRole('button', {
        name: 'Add team membership for ann@example.com',
      }),
    );

    // ann's only membership is `my-crew`; the catalog also holds the two
    // built-ins and `ymhs`, so all three of those (and only those) are offered.
    expect(await screen.findByRole('menuitem', { name: 'Test Studio' })).not.toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Test Studio 2' })).not.toBeNull();
    expect(screen.getByRole('menuitem', { name: 'YMHS' })).not.toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'My Crew' })).toBeNull();
  });

  it('a user in every team is offered nothing', async () => {
    mockUsersResponse([userByEmail('dee@example.com')]);
    const { container } = await renderAndLoad();

    fireEvent.click(
      within(usersTbody(container)).getByRole('button', {
        name: 'Add team membership for dee@example.com',
      }),
    );

    await waitFor(() => expect(screen.queryAllByRole('menuitem')).toHaveLength(0));
  });

  it('the remove control issues DELETE …/memberships/<id>', async () => {
    const ann = userByEmail('ann@example.com');
    mockUsersResponse([ann]);
    const { container } = await renderAndLoad();

    fireEvent.click(within(usersTbody(container)).getByRole('button', { name: /^Remove from/ }));

    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenCalledWith(
        `admin/users/${encodeURIComponent(ann.id)}/memberships/${encodeURIComponent(ann.studios[0].id)}`,
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
  });
});

// --- Membership chips are labelled with the team display name (task 1.3,
// spec: web-admin-users D8) ---
describe('AdminUsersPage — membership chip labelling (spec: web-admin-users, D8)', () => {
  it('shows the display name on the chip, not the slug id', async () => {
    mockUsersResponse([userByEmail('ann@example.com')]);

    const { container } = await renderAndLoad();

    const tbody = usersTbody(container);
    expect(within(tbody).getByText('My Crew')).not.toBeNull();
    expect(within(tbody).queryByText('my-crew')).toBeNull();
  });

  it("the remove control's accessible name is 'Remove from <name>', but the request stays keyed by id", async () => {
    const ann = userByEmail('ann@example.com');
    mockUsersResponse([ann]);
    const { container } = await renderAndLoad();

    const removeButton = within(usersTbody(container)).getByRole('button', {
      name: 'Remove from My Crew',
    });
    fireEvent.click(removeButton);

    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenCalledWith(
        `admin/users/${encodeURIComponent(ann.id)}/memberships/${encodeURIComponent(ann.studios[0].id)}`,
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
  });
});
