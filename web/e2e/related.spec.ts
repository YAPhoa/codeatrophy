import { expect, test, type Page } from '@playwright/test';
import { open } from './support';

// Related items: links made by hand between any two items, under a reading's
// text and a problem's statement. A link to an item that is deleted stays,
// shown red. The seed has no links.
const CAP = '/items/11111111-1111-4111-8111-000000000019';
const TWO_SUM = '/items/11111111-1111-4111-8111-000000000001';
const TWO_SUM_SORTED = '/items/11111111-1111-4111-8111-000000000002';

const section = (page: Page) => page.getByRole('region', { name: 'Related items' });

/** Find an item with the section's search box and link it. */
async function linkItem(page: Page, query: string, title: string) {
  const search = section(page).getByRole('combobox', { name: 'Link an item' });
  await search.fill(query);
  const exactly = new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  await page.getByRole('listbox', { name: 'Items to link' }).getByRole('option').filter({ hasText: exactly }).click();
  await expect(search).toHaveValue('');
  await expect(section(page).getByRole('list', { name: 'Linked items' }).getByRole('link', { name: title, exact: true })).toBeVisible();
}

/** Delete the item on screen from its ⋯ menu. */
async function deleteShownItem(page: Page) {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: /^Delete/ }).getByRole('button', { name: /^Delete (problem|reading)$/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Back in the library.
  await expect(page).not.toHaveURL(/\/items\//);
}

test('related items: a reading links an item found by title, the link shows at both ends, and is undone', async ({ page }) => {
  await open(page, CAP);
  const related = section(page);
  await expect(related.getByRole('heading', { name: 'Related items' })).toBeVisible();

  // The search leaves out the reading itself.
  const search = related.getByRole('combobox', { name: 'Link an item' });
  await search.fill('CAP theorem');
  await expect(page.getByRole('listbox', { name: 'Items to link' }).or(page.getByText('No matching items'))).toBeVisible();
  await expect(page.getByRole('option', { name: /CAP Theorem Notes/ })).toHaveCount(0);
  await search.fill('nothing is called this');
  await expect(page.getByText('No matching items')).toBeVisible();

  await linkItem(page, 'two sum', 'Two Sum');
  // Once linked it is not offered again; the other Two Sums still are.
  await search.fill('two sum');
  const options = page.getByRole('listbox', { name: 'Items to link' }).getByRole('option');
  await expect(options.filter({ hasText: 'Two Sum in a Sorted Ledger' })).toBeVisible();
  await expect(options.filter({ hasText: /^Two Sum$/ })).toHaveCount(0);
  // Keyboard: the first match is taken with Enter.
  await search.press('Enter');
  await expect(related.getByRole('list', { name: 'Linked items' }).getByRole('link')).toHaveCount(2);

  // The problem lists the reading at the bottom of its description.
  await related.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${TWO_SUM}$`));
  const back = section(page).getByRole('list', { name: 'Linked items' });
  await expect(back.getByRole('link', { name: 'CAP Theorem Notes' })).toBeVisible();

  // Unlinked from the problem's end, it is gone from the reading too.
  await back.getByRole('button', { name: 'Unlink CAP Theorem Notes' }).click();
  await expect(back.getByRole('link', { name: 'CAP Theorem Notes' })).toHaveCount(0);
  await page.goBack();
  await expect(section(page).getByRole('list', { name: 'Linked items' }).getByRole('link')).toHaveCount(1);
  await expect(section(page).getByRole('link', { name: 'Two Sum in a Sorted Ledger' })).toBeVisible();
});

test('related items: closed stays closed, on readings and problems alike, with the count in the title row', async ({ page }) => {
  await open(page, CAP);
  await linkItem(page, 'coin', 'Coin Change');
  const toggle = section(page).getByRole('button', { name: 'Related items' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(section(page).getByRole('combobox', { name: 'Link an item' })).toHaveCount(0);
  await expect(section(page).locator('.related-count')).toHaveText('1');

  // Closed on a problem too, and after a reload (the mock forgets the link, not the choice).
  await page.goto(`${TWO_SUM}?mock=fast`);
  await expect(section(page).getByRole('button', { name: 'Related items' })).toHaveAttribute('aria-expanded', 'false');
  await section(page).getByRole('button', { name: 'Related items' }).click();
  await expect(section(page).getByRole('combobox', { name: 'Link an item' })).toBeVisible();
  await page.goto(`${CAP}?mock=fast`);
  await expect(section(page).getByRole('button', { name: 'Related items' })).toHaveAttribute('aria-expanded', 'true');
});

test('related items: a link to a deleted item stays, red and going nowhere, and can be removed', async ({ page }) => {
  await open(page, CAP);
  await linkItem(page, 'coin', 'Coin Change');
  await section(page).getByRole('link', { name: 'Coin Change', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Coin Change', level: 1 })).toBeVisible();
  await deleteShownItem(page);

  await page.getByRole('link', { name: 'CAP Theorem Notes' }).click();
  const list = section(page).getByRole('list', { name: 'Linked items' });
  const dead = list.locator('.link-dead');
  await expect(dead).toHaveText(/^Coin Change/);
  await expect(dead).toHaveAttribute('title', 'No longer in your library');
  await expect(list.getByRole('link')).toHaveCount(0);
  const red = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--link-dead').trim());
  expect(red).not.toBe('');
  const colour = await dead.evaluate((el) => getComputedStyle(el).color);
  const probe = await page.evaluate((c) => {
    const el = document.createElement('span');
    el.style.color = c;
    document.body.append(el);
    const out = getComputedStyle(el).color;
    el.remove();
    return out;
  }, red);
  expect(colour).toBe(probe);

  await list.getByRole('button', { name: 'Unlink Coin Change' }).click();
  await expect(list).toHaveCount(0);
});

test('related items: a variant whose origin is deleted still names it, in red', async ({ page }) => {
  await open(page, TWO_SUM);
  await expect(page.getByRole('heading', { name: 'Two Sum', level: 1 })).toBeVisible();
  await deleteShownItem(page);
  await page.getByRole('link', { name: 'Two Sum in a Sorted Ledger' }).click();
  await expect(page).toHaveURL(new RegExp(TWO_SUM_SORTED));
  await page.getByRole('tab', { name: 'Variants' }).click();
  const origin = page.getByRole('tabpanel').locator('.related-origin');
  await expect(origin).toContainText('A variant of Two Sum');
  await expect(origin.locator('.link-dead')).toHaveAttribute('title', 'No longer in your library');
  await expect(origin.getByRole('link')).toHaveCount(0);
});

test('related items: a reading is reworked from its ⋯ menu', async ({ page }) => {
  await open(page, CAP);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Rework this reading…' }).click();
  await expect(page).toHaveURL(/\/variant$/);
  await expect(page.getByRole('heading', { name: 'Rework this reading' })).toBeVisible();
});
