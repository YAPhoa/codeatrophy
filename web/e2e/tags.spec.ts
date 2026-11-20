import { expect, test, type Page } from '@playwright/test';
import { choose, mockApi, mockItem, open } from './support';

// The Tags page lists every tag with its item count, sorted from the column
// heads (the sort in the URL). A tag outlives its last item, as an empty tag;
// empty tags are hidden unless "Hide empty tags" is unticked, which is kept
// per browser. Deleting a tag removes it for good. The seed library has two
// empty tags, backtracking and trie.

const names = (page: Page) => page.locator('.tags-table tbody tr td:first-child');
const counts = (page: Page) => page.locator('.tags-table tbody tr td.num');
const hideEmpty = (page: Page) => page.getByRole('checkbox', { name: 'Hide empty tags' });

/** Run `change`, which may change the mock library through its API, before the Tags page first loads its tags. */
async function beforeTagsLoad(page: Page, change: () => Promise<void>) {
  await open(page, '/settings');
  await change();
  await page.getByRole('complementary', { name: 'Navigation' }).getByRole('link', { name: /^Tags/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tags' })).toBeVisible();
}

test('tags: the caption, and sorting from the heads in a cycle kept in the URL', async ({ page }) => {
  await open(page, '/tags');
  await expect(page.locator('.page-sub')).toHaveText('Flexible labels for grouping items across collections.');
  const tag = page.getByRole('button', { name: /^Sort by tag/ });
  const items = page.getByRole('button', { name: /^Sort by items/ });

  // By name from A to Z, the default.
  await expect(tag).toHaveAccessibleName('Sort by tag, A to Z');
  await expect(tag).toHaveAttribute('aria-pressed', 'true');
  await expect(tag.locator('.sort-arrow')).toHaveCSS('opacity', '1');
  await expect(items).toHaveAccessibleName('Sort by items, most first');
  await expect(items).toHaveAttribute('aria-pressed', 'false');
  await expect(items.locator('.sort-arrow')).toHaveCSS('opacity', '0');
  await expect(names(page).first()).toHaveText('algorithms');
  // The active head is not bold, and the heads are the size of the counts under them.
  await expect(tag).toHaveCSS('font-weight', '400');
  const rowSize = await counts(page).first().evaluate((el) => getComputedStyle(el).fontSize);
  await expect(tag).toHaveCSS('font-size', rowSize);
  await expect(items).toHaveCSS('font-size', rowSize);

  // Items: the most first, ties by name; then the fewest first; then back to the default.
  await items.click();
  await expect(page).toHaveURL(/[?&]sort=items(&|$)/);
  await expect(page).not.toHaveURL(/order=/);
  await expect(items).toHaveAttribute('aria-pressed', 'true');
  await expect(tag).toHaveAttribute('aria-pressed', 'false');
  await expect(names(page).first()).toHaveText('array');
  await expect(names(page).nth(2)).toHaveText('distributed-systems');
  await expect(names(page).nth(3)).toHaveText('dp');

  await items.click();
  await expect(page).toHaveURL(/sort=items&order=asc/);
  await expect(items).toHaveAccessibleName('Sort by items, fewest first');
  await expect(counts(page).first()).toHaveText('1');
  await expect(names(page).first()).toHaveText('bfs');

  // The sort survives a reload.
  await page.reload();
  await expect(names(page).first()).toHaveText('bfs');
  await expect(items).toHaveAttribute('aria-pressed', 'true');

  await items.click();
  await expect(page).not.toHaveURL(/sort=|order=/);
  await expect(tag).toHaveAttribute('aria-pressed', 'true');
  await expect(names(page).first()).toHaveText('algorithms');

  // Tag: Z to A, then A to Z again.
  await tag.click();
  await expect(page).toHaveURL(/[?&]order=desc/);
  await expect(page).not.toHaveURL(/sort=/);
  await expect(tag).toHaveAccessibleName('Sort by tag, Z to A');
  await expect(names(page).first()).toHaveText('two-pointers');
  await tag.click();
  await expect(page).not.toHaveURL(/sort=|order=/);
  await expect(names(page).first()).toHaveText('algorithms');
});

test('tags: empty tags are hidden until "Hide empty tags" is unticked, which is remembered', async ({ page }) => {
  await open(page, '/tags');
  await expect(hideEmpty(page)).toBeChecked();
  await expect(names(page).first()).toHaveText('algorithms');
  await expect(names(page)).not.toContainText(['backtracking']);
  await expect(page.locator('.tags-table tr.is-empty')).toHaveCount(0);

  await hideEmpty(page).uncheck();
  const empty = page.locator('.tags-table tr.is-empty');
  await expect(empty).toHaveCount(2);
  await expect(empty.locator('td:first-child')).toHaveText(['backtracking', 'trie']);
  await expect(empty.locator('td.num')).toHaveText(['0', '0']);
  // Quieter, but with every action.
  const quiet = await empty.first().locator('td.num').evaluate((el) => getComputedStyle(el).color);
  const usual = await counts(page).first().evaluate((el) => getComputedStyle(el).color);
  expect(quiet).not.toBe(usual);
  for (const action of ['Rename backtracking', 'Merge backtracking into another tag', 'Delete backtracking'])
    await expect(page.getByRole('button', { name: action })).toBeEnabled();
  // Sorted by fewest items, the empty ones come first.
  await page.getByRole('button', { name: /^Sort by items/ }).click();
  await page.getByRole('button', { name: /^Sort by items/ }).click();
  await expect(names(page).first()).toHaveText('backtracking');

  await page.reload();
  await expect(hideEmpty(page)).not.toBeChecked();
  await expect(page.locator('.tags-table tr.is-empty')).toHaveCount(2);
  await hideEmpty(page).check();
  await page.reload();
  await expect(hideEmpty(page)).toBeChecked();
  await expect(page.locator('.tags-table tr.is-empty')).toHaveCount(0);
});

test('tags: a tag stays, empty, when its last item drops it', async ({ page }) => {
  // "stack" is only on Valid Parentheses.
  await beforeTagsLoad(page, async () => {
    const it = await mockItem(page, 'Valid Parentheses');
    await mockApi(page, `/items/${it.id}`, { method: 'PATCH', body: { tags: it.tags.filter((t) => t !== 'stack'), expectedRevision: it.revision } });
  });
  await expect(names(page).first()).toHaveText('algorithms');
  await expect(names(page)).not.toContainText(['stack']);
  await hideEmpty(page).uncheck();
  const stack = page.locator('.tags-table tr', { has: page.locator('td:first-child', { hasText: /^stack$/ }) });
  await expect(stack).toHaveClass(/is-empty/);
  await expect(stack.locator('td.num')).toHaveText('0');
});

test('tags: when every tag is empty and hidden, the table says so', async ({ page }) => {
  await beforeTagsLoad(page, async () => {
    const { items } = await mockApi<{ items: { id: string; tags: string[] }[] }>(page, '/items?limit=100');
    await mockApi(page, '/items/bulk', { method: 'POST', body: { ids: items.map((i) => i.id), action: 'removeTags', tags: [...new Set(items.flatMap((i) => i.tags))] } });
  });
  await expect(page.locator('.tags-table tbody')).toHaveText('All tags are empty and hidden.');
  await hideEmpty(page).uncheck();
  await expect(page.locator('.tags-table tr.is-empty')).toHaveCount(22);
});

test('tags: deleting a tag, after the confirmation, removes it for good', async ({ page }) => {
  await open(page, '/tags');
  await hideEmpty(page).uncheck();
  await page.getByRole('button', { name: 'Delete trie' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete the tag “trie”?' });
  await expect(dialog).toContainText('This tag is currently not attached to any item.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(names(page)).toContainText(['trie']);

  await page.getByRole('button', { name: 'Delete trie' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete tag' }).click();
  await expect(page.getByText('Deleted the tag “trie”')).toBeVisible();
  await expect(names(page)).not.toContainText(['trie']);

  // A tag items carry goes from them too, and does not come back as an empty one.
  await page.getByRole('button', { name: 'Delete stack' }).click();
  await expect(page.getByRole('dialog')).toContainText('This tag would be removed from 1 item and deleted. The items themselves are not deleted.');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete tag' }).click();
  await expect(page.getByText('Deleted the tag “stack”')).toBeVisible();
  await expect(names(page)).not.toContainText(['stack']);
  const listed = (await mockApi<{ items: { name: string }[] }>(page, '/tags')).items.map((t) => t.name);
  expect(listed).not.toContain('trie');
  expect(listed).not.toContain('stack');
  expect(listed).toContain('backtracking');
});

test('tags: merging a tag into another moves its items there, and it goes', async ({ page }) => {
  // "stack" is only on Valid Parentheses, which is not tagged "dp".
  await open(page, '/tags');
  const dp = page.locator('.tags-table tr', { has: page.locator('td:first-child', { hasText: /^dp$/ }) });
  const before = Number(await dp.locator('td.num').textContent());
  await page.getByRole('button', { name: 'Merge stack into another tag' }).click();
  const dialog = page.getByRole('dialog', { name: 'Merge “stack” into…' });
  await choose(dialog.getByRole('combobox', { name: 'Target tag' }), /^dp \(/);
  await dialog.getByRole('button', { name: 'Merge' }).click();
  await expect(page.getByText('Merged “stack” into “dp” (')).toBeVisible();
  await expect(names(page)).not.toContainText(['stack']);
  await expect(dp.locator('td.num')).toHaveText(String(before + 1));
  expect((await mockItem(page, 'Valid Parentheses')).tags).toContain('dp');
});
