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

test('library bulk: favoriting the selection shows at once, without dimming the list or the bar', async ({ page }) => {
  await atRest(page);
  const nav = page.getByRole('complementary', { name: 'Navigation' });
  const favorites = nav.getByRole('link', { name: /^Favorites/ }).locator('.nav-count');
  await expect(favorites).toHaveText('5');
  const rows = [row(page, PLAIN), row(page, 'LRU Cache')];
  for (const r of rows) {
    await r.hover();
    await checkbox(r).check();
  }
  const bar = page.getByRole('toolbar', { name: 'Actions for selected items' });
  // Every frame from the click until the counts have caught up.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __seen: string[] }).__seen = seen;
    const frame = () => {
      const bar = document.querySelector('.bulkbar');
      if (document.querySelector('.item-list-wrap.is-stale')) seen.push('stale list');
      if (bar?.querySelector('button:disabled')) seen.push('disabled button');
      seen.push(`label ${[...(bar?.querySelectorAll('button') ?? [])].find((b) => /favorite/i.test(b.textContent ?? ''))?.textContent}`);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await bar.getByRole('button', { name: 'Favorite', exact: true }).click();
  for (const r of rows) await expect(star(r)).toHaveAttribute('aria-pressed', 'true');
  await expect(favorites).toHaveText('7');
  await page.waitForTimeout(300);
  const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
  expect(seen.filter((s) => !s.startsWith('label '))).toEqual([]);
  // The label turns once: Favorite, then Unfavorite to the end.
  const labels = seen.map((s) => s.slice('label '.length)).filter((l, i, all) => l !== all[i - 1]);
  expect(labels).toEqual(['Favorite', 'Unfavorite']);
});

test('library head: the select-all box waits like a row’s, and shows on the head’s hover and once a row is selected', async ({ page }) => {
  await atRest(page);
  const all = page.locator('.item-list-head .item-check input');
  await expect(all).toHaveCSS('opacity', '0');
  await page.locator('.item-list-head').hover();
  await expect(all).toHaveCSS('opacity', '1');
  await page.mouse.move(0, 0);
  await expect(all).toHaveCSS('opacity', '0');

  const r = row(page, PLAIN);
  await r.hover();
  await checkbox(r).check();
  await page.mouse.move(0, 0);
  await expect(all).toHaveCSS('opacity', '1');
});

test('selection bar: as wide as its actions, Delete before the more-actions menu, and on one line at 600px', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await atRest(page);
  const r = row(page, PLAIN);
  await r.hover();
  await checkbox(r).check();
  const bar = page.getByRole('toolbar', { name: 'Actions for selected items' });
  const names = await bar.getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent?.trim()));
  expect(names.indexOf('Delete')).toBe(names.indexOf('More actions') - 1);

  const box = (await bar.boundingBox())!;
  const list = (await page.locator('.item-list-wrap').boundingBox())!;
  expect(box.width).toBeLessThan(list.width);
  const first = (await bar.getByRole('button', { name: 'Clear selection' }).boundingBox())!;
  const last = (await bar.getByRole('button', { name: 'More actions' }).boundingBox())!;
  expect(Math.abs(last.y - first.y)).toBeLessThan(2);
});

test('library row at 390px: a long verdict is cut short rather than run into the date', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await atRest(page);
  const r = row(page, 'Network Delay Time');
  // Where the badge's text visibly ends: past its box only if it spills out.
  const textEnd = await r.locator('.item-verdict .badge').evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const text = range.getBoundingClientRect().right;
    return getComputedStyle(el).overflow === 'hidden' ? Math.min(text, el.getBoundingClientRect().right) : text;
  });
  const date = (await r.locator('.item-updated').boundingBox())!;
  expect(textEnd).toBeLessThanOrEqual(date.x);
  const wrap = (await page.locator('.item-list-wrap').boundingBox())!;
  const chevron = (await r.locator('.item-expand').boundingBox())!;
  expect(chevron.x + chevron.width).toBeLessThanOrEqual(wrap.x + wrap.width);
});
