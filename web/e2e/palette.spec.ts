import { expect, test, type Locator, type Page } from '@playwright/test';
import { open } from './support';

const HINT = 'Type to find items, collections and commands';

async function openPalette(page: Page, path = '/', mock?: string) {
  await open(page, path, mock);
  // The sidebar's Search… box, the way the palette is usually opened.
  await page.getByRole('button', { name: /^Search…/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Search and commands' });
  await expect(dialog).toBeVisible();
  return { dialog, input: dialog.getByRole('combobox', { name: 'Search items, collections and commands' }), list: dialog.getByRole('listbox', { name: 'Results' }) };
}

test('palette: an empty query shows New item and the recent items under a label, and the hint', async ({ page }) => {
  const { dialog, input, list } = await openPalette(page);
  const recent = list.getByRole('group', { name: 'Recent' });
  await expect(recent.getByRole('option')).toHaveCount(6);
  // Only New item sits outside the group; the label is not an option.
  await expect(list.getByRole('option')).toHaveCount(7);
  await expect(list.getByRole('option').first()).toHaveAccessibleName(/^New item/);
  await expect(list.getByRole('option', { name: 'Recent' })).toHaveCount(0);
  await expect(recent.getByText('Recent', { exact: true })).toBeVisible();
  for (const name of ['Go to library', 'Manage tags', 'Import a bundle', 'Export', 'Settings', /Switch to (light|dark) theme/])
    await expect(list.getByRole('option', { name })).toHaveCount(0);
  await expect(dialog.getByText(HINT)).toBeVisible();

  // The highlight runs across the group as one list.
  await expect(input).toHaveAttribute('aria-activedescendant', 'palette-new');
  await page.keyboard.press('ArrowDown');
  const first = recent.getByRole('option').first();
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(input).toHaveAttribute('aria-activedescendant', (await first.getAttribute('id'))!);
  const title = (await first.locator('.grow').innerText()).trim();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
});

test('palette: with no recent items, an empty query shows New item and the hint, with no Recent label', async ({ page }) => {
  const { dialog, list } = await openPalette(page, '/', 'fast,empty');
  await expect(dialog.getByText(HINT)).toBeVisible();
  await expect(list.getByRole('option')).toHaveCount(1);
  await expect(list.getByRole('option', { name: /New item/ })).toBeVisible();
  await expect(list.getByRole('group')).toHaveCount(0);
  await expect(dialog.getByText('Recent', { exact: true })).toHaveCount(0);
});

test('palette: typing finds each command that the empty query leaves out', async ({ page }) => {
  const { dialog, input, list } = await openPalette(page);
  const cases: [string, string | RegExp][] = [
    ['library', 'Go to library'],
    ['tags', 'Manage tags'],
    ['import', 'Import a bundle'],
    ['export', 'Export'],
    ['settings', 'Settings'],
    ['set', 'Settings'],
    ['theme', /Switch to (light|dark) theme/],
    ['light', /Switch to (light|dark) theme/],
    ['dark', /Switch to (light|dark) theme/],
    ['capture', /^New item/],
    ['new', /^New item/],
  ];
  for (const [query, name] of cases) {
    await input.fill(query);
    await expect(list.getByRole('option', { name, exact: typeof name === 'string' })).toHaveCount(1);
    await expect(list.getByRole('group')).toHaveCount(0);
    await expect(dialog.getByText(HINT)).toHaveCount(0);
  }
  await input.fill('');
  await expect(dialog.getByText(HINT)).toBeVisible();
});

/** The text-decoration-line of the row's link and everything in it. */
function decorations(option: Locator) {
  return option.evaluate((li) => [li, ...li.querySelectorAll('*')].map((el) => getComputedStyle(el).textDecorationLine));
}

test('palette: the highlighted row is not underlined, by keyboard or by pointer', async ({ page }) => {
  const { list } = await openPalette(page);
  const recent = list.getByRole('group', { name: 'Recent' }).getByRole('option');
  await expect(recent).toHaveCount(6);

  // Keyboard: the pointer is parked away from the list.
  await page.mouse.move(1, 1);
  await page.keyboard.press('ArrowDown');
  const keyed = recent.first();
  await expect(keyed).toHaveAttribute('aria-selected', 'true');
  await expect(keyed.locator('a')).toHaveCount(1);
  expect(new Set(await decorations(keyed))).toEqual(new Set(['none']));

  // Pointer: hovering the link itself, which is where a:hover would apply.
  const hovered = recent.nth(2);
  await hovered.locator('a').hover();
  await expect(hovered).toHaveAttribute('aria-selected', 'true');
  expect(await hovered.locator('a').evaluate((a) => a.matches(':hover'))).toBe(true);
  expect(new Set(await decorations(hovered))).toEqual(new Set(['none']));
});
