import { expect, test, type Page } from '@playwright/test';
import { open } from './support';

// A library row opens to show what its line cuts short: the whole summary,
// every tag, when it was created and updated, and its collections.

const LONGEST = 'Longest Substring Without Repeating Characters';

/** The library row of the item titled `title`. */
const row = (page: Page, title: string) => page.locator('li.item-row').filter({ has: page.getByRole('link', { name: title, exact: true }) });

/** The details a row's chevron controls. */
async function detailsOf(page: Page, title: string) {
  const id = await row(page, title).locator('.item-expand button').getAttribute('aria-controls');
  return page.locator(`[id="${id}"]`);
}

test('library details: the chevron opens a row on every tag and its dates, and closes it again', async ({ page }) => {
  await open(page, '/');
  const r = row(page, LONGEST);
  const below = r.locator('+ li');
  const show = r.getByRole('button', { name: 'Show details' });
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  // The line has room for two tags and a "+1".
  await expect(r.locator('.item-tags .chip-tag')).toHaveCount(2);
  const belowTop = (await below.boundingBox())!.y;

  await show.click();
  const hide = r.getByRole('button', { name: 'Hide details' });
  await expect(hide).toHaveAttribute('aria-expanded', 'true');
  const details = await detailsOf(page, LONGEST);
  await expect(details).toBeVisible();
  await expect(details.locator('.item-details-summary')).toHaveText('Length of the longest run of characters with no repeats, in one pass with a sliding window.');
  await expect(details.locator('.chip-tag')).toHaveText(['hash-map', 'sliding-window', 'string']);
  await expect(details.getByText(/^Created /)).toBeVisible();
  await expect(details.getByText(/^Updated 3 days ago$/)).toBeVisible();
  await expect(details.locator('time')).toHaveCount(2);
  for (const time of await details.locator('time').all()) await expect(time).toHaveAttribute('title', /\d/);
  // A nested collection is named by its whole path.
  await expect(details.getByRole('link', { name: 'Interview prep / Arrays & hashing' })).toBeVisible();
  // The rows below make room.
  await expect.poll(async () => (await below.boundingBox())!.y).toBeGreaterThan(belowTop + 40);

  await hide.click();
  await expect(details).toHaveCount(0);
  await expect(r.getByRole('button', { name: 'Show details' })).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => (await below.boundingBox())!.y).toBe(belowTop);
});

test('library details: the "+1" chip opens them too', async ({ page }) => {
  await open(page, '/');
  const r = row(page, LONGEST);
  const more = r.getByRole('button', { name: '1 more tag' });
  await expect(more).toHaveText('+1');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  // It controls the same details as the chevron.
  const controls = await r.locator('.item-expand button').getAttribute('aria-controls');
  await expect(more).toHaveAttribute('aria-controls', controls!);
  const details = await detailsOf(page, LONGEST);

  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(details.locator('.chip-tag')).toHaveText(['hash-map', 'sliding-window', 'string']);
  await expect(r.getByRole('button', { name: 'Hide details' })).toBeVisible();
  // Not a selection, and no navigation.
  await expect(r.getByRole('checkbox')).not.toBeChecked();
  await expect(page).toHaveURL(/\/\?mock=fast$/);

  await more.click();
  await expect(details).toHaveCount(0);
});

test('library details: → opens, ← closes and D toggles the focused row', async ({ page }) => {
  await open(page, '/');
  await expect(page.locator('html')).not.toHaveClass(/is-booting/);
  const r = row(page, LONGEST);
  const details = await detailsOf(page, LONGEST);
  await r.focus();

  await page.keyboard.press('ArrowRight');
  await expect(details).toBeVisible();
  await expect(r).toBeFocused();
  // Again leaves it open.
  await page.keyboard.press('ArrowRight');
  await expect(details).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(details).toHaveCount(0);

  await page.keyboard.press('d');
  await expect(details).toBeVisible();
  // Its links are reached by Tab, as the row's other controls are.
  await details.locator('.chip-tag').first().focus();
  await page.keyboard.press('d');
  await expect(details).toHaveCount(0);
  // Focus that was inside goes back to the row.
  await expect(r).toBeFocused();

  // The list's other keys still work.
  await page.keyboard.press('x');
  await expect(r.getByRole('checkbox')).toBeChecked();
  await page.keyboard.press('j');
  await expect(r.locator('+ li')).toBeFocused();
});

test('library details: a click inside them selects nothing and opens nothing, but a tag filters', async ({ page }) => {
  await open(page, '/');
  const r = row(page, LONGEST);
  await r.getByRole('button', { name: 'Show details' }).click();
  const details = await detailsOf(page, LONGEST);
  await details.locator('.item-details-summary').click();
  await details.getByText(/^Created /).click();
  await expect(r.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByRole('toolbar', { name: 'Actions for selected items' })).toHaveCount(0);
  await expect(page).toHaveURL(/\/\?mock=fast$/);
  await expect(details).toBeVisible();

  await details.locator('.chip-tag', { hasText: 'string' }).click();
  await expect(page).toHaveURL(/[?&]tag=string/);
  await expect(r.getByRole('checkbox')).not.toBeChecked();
});

test('library details: on a narrow screen, where the line shows no tags, they show every tag', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await open(page, '/');
  const r = row(page, LONGEST);
  await expect(r.locator('.item-tags')).toBeHidden();
  await r.getByRole('button', { name: 'Show details' }).click();
  const details = await detailsOf(page, LONGEST);
  await expect(details.locator('.chip-tag')).toHaveText(['hash-map', 'sliding-window', 'string']);
  // They start under the title, not under the row's controls.
  const title = (await r.getByRole('link', { name: LONGEST, exact: true }).boundingBox())!;
  expect(Math.abs((await details.boundingBox())!.x - title.x)).toBeLessThan(12);
});

test('library details: in a collection in manual order, the chevron comes before the grip and moving a row keeps it open', async ({ page }) => {
  await open(page, '/collections/22222222-2222-4222-8222-000000000001');
  const list = page.locator('ul.item-list.is-reorderable');
  await expect(list).toBeVisible();
  const first = list.locator('li.item-row').first();
  const title = (await first.locator('.item-title').textContent())!;
  const chevron = (await first.locator('.item-expand').boundingBox())!;
  const grip = (await first.locator('.item-grip').boundingBox())!;
  expect(chevron.x).toBeLessThan(grip.x);

  await first.getByRole('button', { name: 'Show details' }).click();
  await first.focus();
  await page.keyboard.press('Alt+ArrowDown');
  const moved = list.locator('li.item-row').nth(1);
  await expect(moved.locator('.item-title')).toHaveText(title);
  await expect(moved.getByRole('button', { name: 'Hide details' })).toBeVisible();
});

test('library details: under reduced motion they close at once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, '/');
  const r = row(page, LONGEST);
  await r.getByRole('button', { name: 'Show details' }).click();
  const details = await detailsOf(page, LONGEST);
  await expect(details).toBeVisible();
  await r.getByRole('button', { name: 'Hide details' }).click();
  expect(await details.count()).toBe(0);
});
