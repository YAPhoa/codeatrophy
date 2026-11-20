import { expect, test, type Page } from '@playwright/test';
import { choose, mockApi, open, row } from './support';

// Changes to many items at once from the selection bar, and to the
// collections from their menu in the sidebar.

const bulkBar = (page: Page) => page.getByRole('toolbar', { name: 'Actions for selected items' });
const nav = (page: Page) => page.getByRole('complementary', { name: 'Navigation' });

async function select(page: Page, ...titles: string[]) {
  for (const title of titles) await page.getByRole('checkbox', { name: `Select ${title}` }).check();
  await expect(bulkBar(page)).toContainText(`${titles.length} selected`);
}

test('bulk: the selection is marked, tagged, untagged and deleted', async ({ page }) => {
  await open(page, '/');
  const picked = ['Coin Change', 'Edit Distance'];
  await select(page, ...picked);

  await bulkBar(page).getByRole('button', { name: 'Mark as' }).click();
  await page.getByRole('menuitem', { name: 'Done' }).click();
  for (const title of picked) await expect(row(page, title).getByRole('button', { name: /^Status of / })).toHaveAccessibleName(/: Done\. Change$/);

  await bulkBar(page).getByRole('button', { name: 'Tags' }).click();
  await page.getByRole('menuitem', { name: 'Add tags…' }).click();
  const add = page.getByRole('dialog', { name: 'Add tags to 2 items' });
  await add.getByLabel('Tags').fill('revisit');
  await add.getByLabel('Tags').press('Enter');
  await add.getByRole('button', { name: 'Add tags' }).click();
  for (const title of picked) await expect(row(page, title).locator('.item-tags')).toContainText('revisit');

  await bulkBar(page).getByRole('button', { name: 'Tags' }).click();
  await page.getByRole('menuitem', { name: 'Remove tags…' }).click();
  const remove = page.getByRole('dialog', { name: 'Remove tags from 2 items' });
  await remove.getByRole('button', { name: /revisit$/ }).click();
  await remove.getByRole('button', { name: 'Remove tags' }).click();
  for (const title of picked) await expect(row(page, title).locator('.item-tags')).not.toContainText('revisit');

  // Deleting asks first, and the rows go.
  const total = page.locator('.pager-range');
  await expect(total).toHaveText('Showing 1–25 of 25');
  await bulkBar(page).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete 2 items?' }).getByRole('button', { name: 'Delete 2 items' }).click();
  await expect(total).toHaveText('Showing 1–23 of 23');
  for (const title of picked) await expect(row(page, title)).toHaveCount(0);
  await expect(bulkBar(page)).toHaveCount(0);
});

test('collections: one is renamed and moved from its menu, and deleted without its items', async ({ page }) => {
  await open(page, '/');
  const graphs = nav(page).getByRole('link', { name: /^Graphs/ });
  await expect(graphs).toBeVisible();

  // Graphs, nested in Interview prep, becomes a top-level collection of its own name.
  await page.getByRole('button', { name: 'Actions for Graphs' }).click();
  await page.getByRole('menuitem', { name: 'Rename or move…' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit collection' });
  await edit.getByLabel('Name').fill('Graph problems');
  await choose(edit.getByRole('combobox', { name: 'Inside' }), 'Top level');
  await edit.getByRole('button', { name: 'Save collection' }).click();
  await expect(page.getByText('Collection updated')).toBeVisible();
  const renamed = nav(page).getByRole('link', { name: /^Graph problems/ });
  await expect(renamed).toBeVisible();
  await expect(graphs).toHaveCount(0);
  const { items } = await mockApi<{ items: { name: string; parentId: string | null }[] }>(page, '/collections');
  expect(items.find((c) => c.name === 'Graph problems')?.parentId).toBeNull();

  // Deleted, it leaves its items in the library.
  await renamed.click();
  const held = await page.locator('.item-row').count();
  expect(held).toBeGreaterThan(0);
  const first = (await page.locator('.item-row .item-title').first().textContent())!;
  await page.getByRole('button', { name: 'Actions for Graph problems' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete “Graph problems”?' }).getByRole('button', { name: 'Delete collection' }).click();
  await expect(page.getByText('Deleted “Graph problems”')).toBeVisible();
  await expect(page).toHaveURL(/\/$|\/\?/);
  await expect(renamed).toHaveCount(0);
  await expect(page.getByRole('link', { name: first, exact: true })).toBeVisible();
});
