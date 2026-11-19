import { expect, test, type Page } from '@playwright/test';
import { open, withExtraItems } from './support';

// The library lists one page at a time. A bar under the list says how many
// items a page holds (kept per browser) and which this one shows, and has a
// link to each page; the page is in the URL, and changing the view, the
// filters, the sort or the page size starts again from the first. The names
// of the list's columns sort it; on a narrow screen a menu does.

const pager = (page: Page) => page.locator('.pager');
const pages = (page: Page) => page.getByRole('navigation', { name: 'Pages' });
const titles = (page: Page) => page.locator('.item-list .item-title');

test('paging: the bar shows the range and links to each page, and the page is in the URL', async ({ page }) => {
  await withExtraItems(page, 107);
  await open(page, '/');
  await expect(pager(page).locator('.pager-range')).toHaveText('Showing 1–50 of 132');
  await expect(pager(page).getByRole('combobox', { name: 'per page' })).toHaveValue('50');
  await expect(pages(page).getByRole('link', { name: /^Page/ })).toHaveText(['1', '2', '3']);
  await expect(pages(page).getByRole('link', { name: 'Page 1' })).toHaveAttribute('aria-current', 'page');
  await expect(pages(page).getByRole('button', { name: 'Previous page' })).toBeDisabled();
  await expect(titles(page)).toHaveCount(50);

  await pages(page).getByRole('link', { name: 'Next page' }).click();
  await expect(page).toHaveURL(/[?&]page=2/);
  await expect(pager(page).locator('.pager-range')).toHaveText('Showing 51–100 of 132');
  await expect(titles(page).first()).toHaveText('Extra reading 026');
  await expect(pages(page).getByRole('link', { name: 'Page 2' })).toHaveAttribute('aria-current', 'page');

  await pages(page).getByRole('link', { name: 'Page 3' }).click();
  await expect(pager(page).locator('.pager-range')).toHaveText('Showing 101–132 of 132');
  await expect(titles(page)).toHaveCount(32);
  await expect(pages(page).getByRole('button', { name: 'Next page' })).toBeDisabled();

  // Back and reload keep the page.
  await page.goBack();
  await expect(page).toHaveURL(/[?&]page=2/);
  await expect(titles(page).first()).toHaveText('Extra reading 026');
  await page.reload();
  await expect(titles(page).first()).toHaveText('Extra reading 026');
  await page.goBack();
  await expect(page).not.toHaveURL(/page=/);
  await expect(pager(page).locator('.pager-range')).toHaveText('Showing 1–50 of 132');
});

test('paging: a long list shows its first, last and nearby pages, with gaps between', async ({ page }) => {
  await withExtraItems(page, 400);
  await open(page, '/?page=5');
  await expect(pages(page).locator('.pager-btn, .pager-gap')).toHaveText(['', '1', '…', '4', '5', '6', '…', '9', '']);
  await expect(pager(page).locator('.pager-range')).toHaveText('Showing 201–250 of 425');
});

test('paging: the page size is kept in this browser, and changing it starts from the first page', async ({ page }) => {
  await withExtraItems(page, 107);
  await open(page, '/?page=2');
  await pager(page).getByRole('combobox', { name: 'per page' }).selectOption('25');
  await expect(page).not.toHaveURL(/page=/);
  await expect(pager(page).locator('.pager-range')).toHaveText('Showing 1–25 of 132');
  await expect(pages(page).getByRole('link', { name: /^Page/ })).toHaveText(['1', '2', '3', '4', '5', '6']);
  await expect(titles(page)).toHaveCount(25);

  await page.reload();
  await expect(pager(page).getByRole('combobox', { name: 'per page' })).toHaveValue('25');
  await expect(titles(page)).toHaveCount(25);
});

test('paging: a filter, a sort or another view starts from the first page, and a page past the end shows the last', async ({ page }) => {
  await withExtraItems(page, 107);
  await open(page, '/?page=2');
  await expect(pager(page).locator('.pager-range')).toHaveText('Showing 51–100 of 132');
  await page.getByRole('search', { name: 'Filter items' }).getByRole('button', { name: /^Status/ }).click();
  await page.getByRole('dialog', { name: 'Status' }).getByText('Done').click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/status=done/);
  await expect(page).not.toHaveURL(/page=/);

  await pages(page).getByRole('link', { name: 'Page 2' }).click();
  await expect(page).toHaveURL(/page=2/);
  await page.getByRole('button', { name: /^Sort by title/ }).click();
  await expect(page).toHaveURL(/sort=title/);
  await expect(page).not.toHaveURL(/page=/);

  await page.goto('/?page=9');
  await expect(page).toHaveURL(/[?&]page=3/);
  await expect(pager(page).locator('.pager-range')).toHaveText('Showing 101–132 of 132');
});

test('paging: another page starts at the top of the list, and Select all takes the page shown', async ({ page }) => {
  await withExtraItems(page, 107);
  await open(page, '/');
  await expect(page.locator('html')).not.toHaveClass(/is-booting/);
  await pages(page).getByRole('link', { name: 'Next page' }).click();
  await expect(titles(page).first()).toHaveText('Extra reading 026');
  await expect
    .poll(() => page.evaluate(() => document.querySelector('.item-list-wrap')!.getBoundingClientRect().top - document.querySelector('.main')!.getBoundingClientRect().top))
    .toBeGreaterThanOrEqual(0);

  const all = page.locator('.item-list-head').getByRole('checkbox', { name: 'Select all on this page' });
  await all.check();
  await expect(page.getByRole('toolbar', { name: 'Actions for selected items' })).toContainText('50');
});

test('paging: a list that fits on one page still says what it shows', async ({ page }) => {
  await open(page, '/');
  await expect(pager(page).locator('.pager-range')).toHaveText('Showing 1–25 of 25');
  await expect(pages(page).getByRole('link', { name: /^Page/ })).toHaveText(['1']);
  await expect(pages(page).getByRole('button', { name: 'Previous page' })).toBeDisabled();
  await expect(pages(page).getByRole('button', { name: 'Next page' })).toBeDisabled();
});

test('paging: on a narrow screen the bar takes two lines, within the list', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await withExtraItems(page, 400);
  await open(page, '/?page=5');
  const box = await page.locator('.item-list-foot').evaluate((foot) => {
    const f = foot.getBoundingClientRect();
    const parts = [...foot.querySelectorAll('.pager-info, .pager-pages')].map((el) => el.getBoundingClientRect());
    return { inside: parts.every((p) => p.left >= f.left && p.right <= f.right), lines: new Set(parts.map((p) => Math.round(p.top))).size, scroll: foot.scrollWidth <= foot.clientWidth };
  });
  expect(box).toEqual({ inside: true, lines: 2, scroll: true });
});

test('sort: a column\'s name sorts by it, then the other way, then back to the view\'s own order', async ({ page }) => {
  await open(page, '/');
  const head = page.locator('.item-list-head');
  const title = head.getByRole('button', { name: /^Sort by title/ });
  const updated = head.getByRole('button', { name: /^Sort by updated/ });
  await expect(title).toHaveAccessibleName('Sort by title, A to Z');
  await expect(title).toHaveAttribute('aria-pressed', 'false');
  await expect(updated).toHaveAccessibleName('Sort by updated, newest first');
  await expect(updated).toHaveAttribute('aria-pressed', 'true');
  await expect(updated.locator('.sort-arrow')).toHaveCSS('opacity', '1');
  // Verdict cannot be sorted by: a plain name.
  await expect(head.getByText('Verdict', { exact: true })).toBeVisible();
  await expect(head.getByRole('button', { name: /verdict/i })).toHaveCount(0);

  await title.click();
  await expect(page).toHaveURL(/sort=title/);
  await expect(title).toHaveAttribute('aria-pressed', 'true');
  await expect(updated).toHaveAttribute('aria-pressed', 'false');
  await expect(title.locator('.sort-arrow')).toHaveCSS('opacity', '1');
  await expect(titles(page).first()).toHaveText('Amortised Analysis, Three Ways');

  await title.click();
  await expect(page).toHaveURL(/sort=title&order=desc/);
  await expect(title).toHaveAccessibleName('Sort by title, Z to A');
  await expect(titles(page).first()).toHaveText('Write-Ahead Logging and fsync');

  await title.click();
  await expect(page).not.toHaveURL(/sort=/);
  await expect(title).toHaveAttribute('aria-pressed', 'false');
  await expect(updated).toHaveAttribute('aria-pressed', 'true');

  // The view's own column turns round first.
  await updated.click();
  await expect(page).toHaveURL(/sort=updated&order=asc/);
  await expect(updated).toHaveAccessibleName('Sort by updated, oldest first');
  await updated.click();
  await expect(page).not.toHaveURL(/sort=/);

  const difficulty = head.getByRole('button', { name: /^Sort by difficulty/ });
  await difficulty.click();
  await expect(page.locator('.item-row').first().locator('.item-kind')).toHaveText('Easy');
  await difficulty.click();
  await expect(difficulty).toHaveAccessibleName('Sort by difficulty, hardest first');
  await expect(page.locator('.item-row').first().locator('.item-kind')).toHaveText('Hard');
});

test('sort: a collection in manual order names its columns too, and says how to reorder under the list', async ({ page }) => {
  await open(page, '/collections/22222222-2222-4222-8222-000000000001');
  await expect(page.locator('ul.item-list.is-reorderable')).toBeVisible();
  const head = page.locator('.item-list-head');
  await expect(head.getByRole('button', { name: /^Sort by/ })).toHaveCount(3);
  await expect(head.locator('[aria-pressed="true"]')).toHaveCount(0);
  await expect(page.locator('.item-list-hint')).toHaveText('Drag rows or press Alt+↑ / Alt+↓ to reorder.');
  // Sorting by a column leaves manual order, and the third click comes back to it.
  const title = head.getByRole('button', { name: /^Sort by title/ });
  await title.click();
  await expect(page.locator('ul.item-list.is-reorderable')).toHaveCount(0);
  await title.click();
  await title.click();
  await expect(page.locator('ul.item-list.is-reorderable')).toBeVisible();
});

test('sort: on a narrow screen a menu sorts, in place of the columns\' names', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await open(page, '/');
  const head = page.locator('.item-list-head');
  await expect(head.getByRole('button', { name: /^Sort by/ })).toHaveCount(0);
  const sort = head.getByRole('button', { name: /^Sort:/ });
  await expect(sort).toHaveText(/Sort:\s*Last updated/);
  await sort.click();
  const menu = page.getByRole('menu', { name: 'Sort by' });
  await expect(menu.getByRole('menuitemradio')).toHaveText(['Last updated', 'Title', 'Difficulty', 'Newest first', 'Oldest first']);
  await menu.getByRole('menuitemradio', { name: 'Title' }).click();
  await expect(page).toHaveURL(/sort=title/);
  await expect(sort).toHaveText(/Sort:\s*Title/);
  await sort.click();
  await menu.getByRole('menuitemradio', { name: 'Z → A' }).click();
  await expect(page).toHaveURL(/sort=title&order=desc/);
  await expect(titles(page).first()).toHaveText('Write-Ahead Logging and fsync');

  // A collection's own order is a choice there.
  await page.goto('/collections/22222222-2222-4222-8222-000000000001');
  await sort.click();
  await expect(menu.getByRole('menuitemradio', { name: 'Manual order' })).toHaveAttribute('aria-checked', 'true');
});
