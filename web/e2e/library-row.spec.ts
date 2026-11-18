import { expect, test, type Locator, type Page } from '@playwright/test';
import { open } from './support';

// A library row's checkbox and star wait at rest, in their places, and show
// when the row is pointed at or reached by keyboard, once anything is
// selected, and always on a device without hover. A starred star always shows.

const PLAIN = 'Merge k Sorted Lists';
const STARRED = 'Two Sum';

const row = (page: Page, title: string) => page.locator('li.item-row').filter({ has: page.getByRole('link', { name: title, exact: true }) });
const checkbox = (r: Locator) => r.locator('.item-check input');
const star = (r: Locator) => r.locator('.item-star .fav-btn');

/** Opacity of the row's checkbox and star. */
async function expectShown(r: Locator, shown: boolean) {
  const opacity = shown ? '1' : '0';
  await expect(checkbox(r)).toHaveCSS('opacity', opacity);
  await expect(star(r)).toHaveCSS('opacity', opacity);
}

async function atRest(page: Page) {
  await open(page, '/');
  await expect(page.locator('html')).not.toHaveClass(/is-booting/);
  await page.mouse.move(0, 0);
}

test('library row: the checkbox and star show on hover, in the places they keep at rest', async ({ page }) => {
  await atRest(page);
  const r = row(page, PLAIN);
  await expectShown(r, false);
  await expect(star(row(page, STARRED))).toHaveCSS('opacity', '1');
  const places = async () => Promise.all([checkbox(r), star(r), r.locator('.item-status button'), r.locator('.item-title')].map(async (l) => (await l.boundingBox())!));
  const before = await places();

  await r.hover();
  await expectShown(r, true);
  expect(await places()).toEqual(before);

  await page.mouse.move(0, 0);
  await expectShown(r, false);
});

test('library row: they show on the row the keyboard is on', async ({ page }) => {
  await atRest(page);
  const r = row(page, PLAIN);
  await r.focus();
  await expectShown(r, true);
  await page.keyboard.press('j');
  const next = r.locator('+ li');
  await expect(next).toBeFocused();
  await expectShown(next, true);
  await expectShown(r, false);
  // Tab reaches the checkbox, and it is in view.
  await page.keyboard.press('k');
  await page.keyboard.press('Tab');
  await expect(checkbox(r)).toBeFocused();
  await expectShown(r, true);
});

test('library row: once one row is selected, every row shows them', async ({ page }) => {
  await atRest(page);
  const r = row(page, PLAIN);
  const other = row(page, 'LRU Cache');
  await r.hover();
  await checkbox(r).click();
  await page.mouse.move(0, 0);
  await expect(page.getByRole('toolbar', { name: 'Actions for selected items' })).toBeVisible();
  await expectShown(other, true);

  await page.keyboard.press('Escape');
  await expect(checkbox(r)).not.toBeChecked();
  await expectShown(other, false);
});

test.describe('on a device without hover', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 600, height: 900 } });

  test('library row: they always show', async ({ page }) => {
    await atRest(page);
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
    await expectShown(row(page, PLAIN), true);
  });
});
