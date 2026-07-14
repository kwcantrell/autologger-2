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
});
