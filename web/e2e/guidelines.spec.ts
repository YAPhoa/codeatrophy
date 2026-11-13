import { expect, test } from '@playwright/test';
import { open } from './support';

// Keyboard, focus and screen-reader behaviour the UI is held to. Like the
// smoke suite, these run against the API mock.

test('focus: the solve editor shows a ring when it has focus', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Longest Substring Without Repeating Characters' }).click();
  const host = page.locator('.editor-host');
  await host.locator('.cm-content').click();
  await expect(host).toHaveCSS('outline-style', 'solid');
});

test('confirm: a destructive dialog opens on Cancel, so Enter does not delete', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Longest Substring Without Repeating Characters' }).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();

  const dialog = page.getByRole('dialog', { name: /^Delete/ });
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Longest Substring Without Repeating Characters' })).toBeVisible();
});
