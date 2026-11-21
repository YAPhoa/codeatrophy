import { expect, test, type Page } from '@playwright/test';
import { open } from './support';

// Each view of the sidebar has a path: All items `/`, `/problems`,
// `/readings`, `/favorites`. The addresses from before (`/?type=problem`,
// `/?favorite=true`) lead there with the rest of their query string, in
// place of themselves; Uncollected is no longer a view.

const nav = (page: Page) => page.getByRole('complementary', { name: 'Navigation' });
const heading = (page: Page) => page.getByRole('heading', { level: 1 });

/** The path and query string on screen, without the mock's own flag. */
function here(page: Page): { path: string; params: Record<string, string[]> } {
  const url = new URL(page.url());
  url.searchParams.delete('mock');
  const params: Record<string, string[]> = {};
  for (const [k, v] of url.searchParams) (params[k] ??= []).push(v);
  return { path: url.pathname, params };
}

test('paths: the old address of each view leads to its path, keeping the rest, and Back does not return to it', async ({ page }) => {
  await open(page, '/tags');
  await expect(heading(page)).toHaveText(/Tags/);

  const cases = [
    { from: '/?type=problem&q=sum&status=todo&sort=title&order=desc', path: '/problems', params: { q: ['sum'], status: ['todo'], sort: ['title'], order: ['desc'] }, title: 'Problems' },
    { from: '/?type=reading&tag=databases&difficulty=medium', path: '/readings', params: { tag: ['databases'], difficulty: ['medium'] }, title: 'Readings' },
    { from: '/?favorite=true&status=done', path: '/favorites', params: { status: ['done'] }, title: 'Favorites' },
    // Favorites of one type, as it was shown: the type is the filter bar's.
    { from: '/?type=reading&favorite=true', path: '/favorites', params: { type: ['reading'] }, title: 'Favorites' },
    // Uncollected is All items now.
    { from: '/?uncollected=true&q=graph', path: '/', params: { q: ['graph'] }, title: 'Library' },
  ];
  for (const c of cases) {
    await page.goto(c.from);
    await expect(heading(page)).toHaveText(new RegExp(`^${c.title}`));
    await expect.poll(() => here(page)).toEqual({ path: c.path, params: c.params });
    await page.goBack();
    await expect(heading(page)).toHaveText(/Tags/);
    expect(here(page).path).toBe('/tags');
  }
  // The search box and the bar show what was kept.
  await page.goto('/?type=reading&favorite=true&q=raft');
  await expect(page.getByRole('search', { name: 'Filter items' }).getByRole('searchbox')).toHaveValue('raft');
  await expect(page.getByRole('search', { name: 'Filter items' }).getByRole('button', { name: /^Type/ })).toContainText('1');
});

test('paths: an old Uncollected address shows All items, with no word of Uncollected', async ({ page }) => {
  await open(page, '/?uncollected=true');
  await expect(heading(page)).toHaveText(/^Library/);
  await expect.poll(() => here(page)).toEqual({ path: '/', params: {} });
  await expect(page.getByText('Items that are not in any collection yet.')).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: /^All items/ })).toHaveAttribute('aria-current', 'page');
});

test('paths: the sidebar links to each view\'s path and highlights the one on screen, in the rail too', async ({ page }) => {
  await open(page, '/');
  const views = [
    { name: 'All items', path: '/', title: 'Library' },
    { name: 'Problems', path: '/problems', title: 'Problems' },
    { name: 'Readings', path: '/readings', title: 'Readings' },
    { name: 'Favorites', path: '/favorites', title: 'Favorites' },
  ];
  const current = nav(page).locator('[aria-current="page"]');
  for (const v of views) {
    await nav(page).getByRole('link', { name: new RegExp(`^${v.name}`) }).click();
    await expect(heading(page)).toHaveText(new RegExp(`^${v.title}`));
    expect(here(page).path).toBe(v.path);
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText(new RegExp(`^${v.name}`));
  }
  // A filter in the view keeps it highlighted.
  await page.goto('/problems?status=done&sort=title');
  await expect(current).toHaveText(/^Problems/);
  // A collection is highlighted in the tree, and none of the views.
  await nav(page).getByRole('link', { name: /^Weekly practice/ }).click();
  await expect(current).toHaveCount(1);
  await expect(current).toHaveText(/^Weekly practice/);

  await page.getByRole('button', { name: /^Minimise navigation/ }).click();
  const rail = page.locator('aside.sidebar.is-rail');
  for (const v of views) {
    await rail.getByRole('link', { name: v.name, exact: true }).click();
    await expect(heading(page)).toHaveText(new RegExp(`^${v.title}`));
    expect(here(page).path).toBe(v.path);
    await expect(rail.locator('.rail-nav [aria-current="page"]')).toHaveAccessibleName(v.name);
  }
});

test('paths: Problems and Readings are what their path says, whatever the query string adds', async ({ page }) => {
  await open(page, '/problems?type=reading&favorite=true');
  await expect(heading(page)).toHaveText(/^Problems/);
  await expect(page.locator('.item-row').first()).toBeVisible();
  await expect(page.locator('.item-row .item-type [aria-label="Reading"]')).toHaveCount(0);
  await expect(nav(page).locator('[aria-current="page"]')).toHaveText(/^Problems/);
  // The filter bar has no Type there, and a change leaves the stray parameters out.
  const bar = page.getByRole('search', { name: 'Filter items' });
  await expect(bar.getByRole('button', { name: /^Type/ })).toHaveCount(0);
  await bar.getByRole('searchbox').fill('sum');
  await expect.poll(() => here(page)).toEqual({ path: '/problems', params: { q: ['sum'] } });
});
