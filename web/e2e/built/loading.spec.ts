import { expect, test } from '@playwright/test';
import { loadingRecord, open, recordLoading } from '../support';

// At the mock's normal speed nothing shows as loading. Judged on the
// production build: the dev server's unbundled modules make the app itself
// slow to start, which says nothing about how loading looks.

test('built: at normal speed, opening the library and an item shows no loading state', async ({ page }) => {
  await recordLoading(page);
  await open(page, '/', 'default');
  const twoSum = page.getByRole('link', { name: 'Two Sum', exact: true });
  await expect(twoSum).toBeVisible();
  await twoSum.click();
  await expect(page.locator('.workspace-body')).toBeVisible();
  await expect(page.getByRole('textbox', { name: /solution code/i })).toBeVisible();
  await page.waitForTimeout(500);
  expect((await loadingRecord(page)).indicators).toEqual([]);
});
