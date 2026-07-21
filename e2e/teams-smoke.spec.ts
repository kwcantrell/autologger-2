import { expect, test } from '@playwright/test';
import { CHROMIUM_DATA_DIR, injectSessionCookie, seedSession } from './seededSession';

// teams-smoke.spec.ts (teams-self-serve, task 7.2)
//
// Authenticated browser smoke over the /teams self-serve UI, using the 7.1
// seeded-session fixture. Runs on the chromium project's hermetic server
// (:8791, REQUIRE_LOGIN=0) — resolveSessionUser (server/src/auth/identity.ts)
// resolves a valid session cookie to its user regardless of REQUIRE_LOGIN
// (verified against seeded-session.spec.ts), so the anonymous-allowed
// posture of this server doesn't get in the way of an authenticated flow.
//
// Test ids below are the phase-6 UI's (web/src/pages/index/components/
// TeamsRoute.tsx + TeamCard.tsx + V6Rail.tsx + OnboardingPanel.tsx).

function uniqueSlug(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

test.describe('teams self-serve (seeded-session fixture)', () => {
  test('create team, rename, invite, revoke — full admin round trip without reload', async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(!baseURL, 'baseURL is required (set by the chromium project)');

    // A membership on the built-in default studio keeps `teams.length > 0`
    // so the profile-driven onboarding redirect (AppShell `needsOnboarding`)
    // never intercepts this user — see AppShell.tsx / OnboardingPanel.tsx.
    const seeded = await seedSession({
      dataDir: CHROMIUM_DATA_DIR,
      label: 'admin',
      memberships: [{ studioId: 'test-studios', role: 'member' }],
    });
    await injectSessionCookie(context, baseURL as string, seeded.token);

    await page.goto('/');
    await expect(page.locator('#v6-app')).toBeVisible();

    // Rail affordance -> /teams (task 6.2 shell-reachability clause).
    await page.locator('#v6-btn-teams').click();
    await expect(page).toHaveURL(/\/teams$/);
    await expect(page.getByTestId('teams-route')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Teams' })).toBeVisible();

    // Create a new (non-built-in) team — its creator becomes admin (D3).
    const slug = uniqueSlug('e2e-team');
    const displayName = `E2E Team ${slug.slice(-6)}`;
    const createForm = page.getByTestId('team-create-form');
    await createForm.locator('#team-create-slug').fill(slug);
    await createForm.locator('#team-create-name').fill(displayName);
    await createForm.getByRole('button', { name: 'Create team' }).click();

    const toggle = page.getByTestId(`team-toggle-${slug}`);
    await expect(toggle).toBeVisible();
    await expect(toggle).toContainText(displayName);

    // Expand -> admin panel (creator is admin; fetches GET /api/teams/:id on
    // demand — design D7).
    await toggle.click();
    const adminPanel = page.getByTestId(`team-admin-panel-${slug}`);
    await expect(adminPanel).toBeVisible();

    // Rename.
    const renamed = `${displayName} Renamed`;
    await adminPanel.getByLabel('Team name').fill(renamed);
    await adminPanel.getByRole('button', { name: 'Save name' }).click();
    await expect(toggle).toContainText(renamed);

    // Invite an email -> pending invite visible.
    const inviteEmail = `invitee-${slug}@example.invalid`;
    await adminPanel.getByLabel('Invite by email').fill(inviteEmail);
    await adminPanel.getByRole('button', { name: 'Invite' }).click();
    const inviteRow = page.getByTestId(`team-invite-${inviteEmail}`);
    await expect(inviteRow).toBeVisible();
    await expect(adminPanel).not.toContainText('No pending invites.');

    // Revoke it.
    await inviteRow.getByRole('button', { name: 'Revoke' }).click();
    await expect(inviteRow).toHaveCount(0);
    await expect(adminPanel).toContainText('No pending invites.');
  });

  test('a fresh zero-membership user lands on the onboarding panel', async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(!baseURL, 'baseURL is required (set by the chromium project)');

    const seeded = await seedSession({ dataDir: CHROMIUM_DATA_DIR, label: 'onboarding' });
    await injectSessionCookie(context, baseURL as string, seeded.token);

    await page.goto('/');
    await expect(page.getByTestId('onboarding-panel')).toBeVisible();
    // The onboarding condition (AppShell `needsOnboarding`) replaces the
    // whole shell — the ordinary workspace/rail never mounts.
    await expect(page.locator('#v6-app')).toHaveCount(0);

    // Its create-team form is the same CreateTeamForm as /teams (design D8) —
    // creating a team here should land the user in the ordinary shell.
    const slug = uniqueSlug('e2e-onb');
    const displayName = `Onboard Team ${slug.slice(-6)}`;
    const form = page.getByTestId('team-create-form');
    await form.locator('#team-create-slug').fill(slug);
    await form.locator('#team-create-name').fill(displayName);
    await form.getByRole('button', { name: 'Create team' }).click();

    await expect(page.getByTestId('onboarding-panel')).toHaveCount(0);
    await expect(page.locator('#v6-app')).toBeVisible();
  });

  test('reload on /teams keeps the teams page; Back restores the prior view', async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(!baseURL, 'baseURL is required (set by the chromium project)');

    const seeded = await seedSession({
      dataDir: CHROMIUM_DATA_DIR,
      label: 'nav',
      memberships: [{ studioId: 'test-studios', role: 'member' }],
    });
    await injectSessionCookie(context, baseURL as string, seeded.token);

    await page.goto('/');
    await expect(page.locator('#v6-app')).toBeVisible();

    await page.locator('#v6-btn-teams').click();
    await expect(page).toHaveURL(/\/teams$/);
    await expect(page.getByTestId('teams-route')).toBeVisible();

    // Reload on /teams (production serve path — `npm run start -w server`
    // serves the built web/dist, exercising the real GET /teams HTML route,
    // not the Vite dev-middleware matcher) keeps the teams page.
    await page.reload();
    await expect(page).toHaveURL(/\/teams$/);
    await expect(page.getByTestId('teams-route')).toBeVisible();

    // Back restores the prior view (home, `/`).
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('teams-route')).toHaveCount(0);
  });

  // teams-settings-nav, task 3.1: the rail's Settings button and the page's
  // own back affordance both work on /teams — the two shipped-defect
  // repros this change fixes (proposal "Why").
  test('settings modal opens from /teams; the back affordance lands on / with the home view', async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(!baseURL, 'baseURL is required (set by the chromium project)');

    const seeded = await seedSession({
      dataDir: CHROMIUM_DATA_DIR,
      label: 'settings-nav',
      memberships: [{ studioId: 'test-studios', role: 'member' }],
    });
    await injectSessionCookie(context, baseURL as string, seeded.token);

    await page.goto('/');
    await expect(page.locator('#v6-app')).toBeVisible();

    await page.locator('#v6-btn-teams').click();
    await expect(page).toHaveURL(/\/teams$/);
    await expect(page.getByTestId('teams-route')).toBeVisible();

    // The rail Settings button is deadened pre-fix on /teams (HomeSettingsModal
    // was mounted inside SessionRoute/WorkspaceStatic, which TeamsRoute
    // replaces — design D1). Post-fix it is lifted to AppShell and opens here.
    await page.locator('#v6-btn-settings').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('#modal-app-settings-title')).toHaveText('Settings');
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Pre-fix there was no in-app way back to the home view from /teams
    // (session rail links reach /sessions/:id only) — design D2's page-level
    // "Back to sessions" control fixes that without relying on browser Back.
    await page.getByRole('button', { name: 'Back to sessions' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('teams-route')).toHaveCount(0);
    // ui-refresh: the home placeholder is now the branded launch surface.
    await expect(page.getByRole('heading', { name: 'AutoLogger' })).toBeVisible();
  });

  // teams-settings-nav, task 3.1 (design D3): a save through the REAL server
  // proves both the read (hydrate) and write (post) directions of the
  // name-keyed category round-trip — a mocked-fixture test alone would have
  // masked the original bug, since the client's own type-derived `label`
  // fixtures pass against the broken code (design D3 "Test-fixture rule").
  //
  // This creates an ISOLATED show rather than editing the shared "Autolog
  // Test Show" fixture: shows are studio-scoped (not user-scoped), and this
  // hermetic server's catalog.db is shared by every chromium-project spec
  // file in the run, so mutating that show's categories could race other
  // specs' `hasText: 'Scene'` locators (smoke.spec.ts). The new show's name
  // is chosen to sort AFTER "Autolog Test Show" (listShowsForStudio orders
  // `ORDER BY name COLLATE NOCASE ASC`) so it can never become `shows[0]`
  // and disturb NewSessionModal's default-show preselection.
  test('settings-save round-trip persists a renamed category through the real server', async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(!baseURL, 'baseURL is required (set by the chromium project)');

    const seeded = await seedSession({
      dataDir: CHROMIUM_DATA_DIR,
      label: 'settings-save',
      memberships: [{ studioId: 'test-studios', role: 'member' }],
    });
    await injectSessionCookie(context, baseURL as string, seeded.token);

    await page.goto('/');
    await expect(page.locator('#v6-app')).toBeVisible();

    await page.locator('#v6-btn-settings').click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const showName = `zzz-e2e-settings-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
    // ui-refresh: Add-Show is now the themed Dialog (was window.prompt) —
    // #profile-show-add opens it, fill the name input, then Create show.
    await page.locator('#profile-show-add').click();
    await page.locator('#profile-show-add-name').fill(showName);
    await page.getByRole('button', { name: 'Create show' }).click();
    await expect(page.locator('#profile-show-select')).toContainText(showName);

    // The new show clones the studio's default categories (Scene / Audio
    // issue / Note — server/src/studio.ts defaultCategoriesForNewStudio) via
    // POST /api/shows, so this is real server data, not a client fixture.
    await page.locator('#v6-settings-tab-event-buttons').click();
    const firstRowNameInput = page
      .locator('table[aria-label="Event buttons"] tbody tr')
      .first()
      .locator('input')
      .first();
    // Hydration pin: the name is visible (non-blank) — the exact pre-fix
    // regression (D3's "the blessed visual snapshot shows the empty inputs").
    await expect(firstRowNameInput).toHaveValue('Scene');
    const renamed = 'Scene Renamed E2E';
    await firstRowNameInput.fill(renamed);

    await page.locator('#profile-save').click();
    await expect(page.locator('#toast-queue >> text=Saved.')).toBeVisible();
    // Not the pre-fix 400 — proves the outbound `name:` key is now accepted
    // by the update validator (server/src/studio.ts validateCategoriesList).
    await expect(page.locator('#toast-queue >> text=Each category needs a name.')).toHaveCount(0);

    await page.reload();
    await expect(page.locator('#v6-app')).toBeVisible();
    await page.locator('#v6-btn-settings').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('#profile-show-select')).toContainText(showName);
    await page.locator('#v6-settings-tab-event-buttons').click();
    await expect(
      page.locator('table[aria-label="Event buttons"] tbody tr').first().locator('input').first(),
    ).toHaveValue(renamed);
  });
});
