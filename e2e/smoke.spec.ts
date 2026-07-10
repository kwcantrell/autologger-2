import { expect, test } from '@playwright/test';

test('workspace shell renders with no page errors', async ({ page }) => {
  const errors: Error[] = [];
  page.on('pageerror', (e) => errors.push(e));
  await page.goto('/');
  await expect(
    page.getByText('Select a session, or create a new one from the left rail.'),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('/admin/users renders', async ({ page }) => {
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Admin Users' })).toBeVisible();
});
