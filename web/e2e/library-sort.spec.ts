import { expect, test, type Page } from '@playwright/test';
import { mockApi, open } from './support';

// The library's sort is remembered in this browser, for 30 days from the
// last visit: one for each view of the sidebar (All items, Problems,
// Readings, Favorites, Uncollected) and one for each collection. A URL that
// names a sort still wins, and a search sorts by relevance.

const KEY = 'codeatrophy:librarySort';
const DAY = 24 * 60 * 60 * 1000;
const WEEKLY = '22222222-2222-4222-8222-000000000008';
const INTERVIEW = '22222222-2222-4222-8222-000000000001';

const nav = (page: Page) => page.getByRole('complementary', { name: 'Navigation' });
const head = (page: Page) => page.locator('.item-list-head');
const column = (page: Page, name: string) => head(page).getByRole('button', { name: new RegExp(`^Sort by ${name}`) });
const titles = (page: Page) => page.locator('.item-list .item-title');
const stored = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null') as Record<string, { sort: string; order: string | null; at: number }> | null, KEY);

/** The titles the mock lists first for these parameters. */
const firstTitles = async (page: Page, query: string) => (await mockApi<{ items: { title: string }[] }>(page, `/items?limit=3&${query}`)).items.map((i) => i.title);

/** Wait for the list to be the one asked for, then read its first titles. */
async function shownFirst(page: Page, expected: string[]) {
  await expect(page.locator('.item-list-wrap.is-stale')).toHaveCount(0);
  await expect(titles(page).nth(expected.length - 1)).toBeVisible();
  expect(await titles(page).evaluateAll((els, n) => els.slice(0, n).map((e) => e.textContent), expected.length)).toEqual(expected);
}

/**
 * Type `text` in the search box and open the sidebar's view `link` at once.
 * The search's delayed write is held, then let go once the address has
 * changed and before the page has drawn it: on a slow machine it comes due
 * just then.
 */
async function searchAsViewOpens(page: Page, text: string, link: RegExp) {
  const search = page.getByRole('search', { name: 'Filter items' }).getByRole('searchbox');
  const view = await nav(page).getByRole('link', { name: link }).elementHandle();
  const timers = await search.evaluate(
    async (box: HTMLInputElement, { view, text }) => {
      const held: { run: () => void; id: number }[] = [];
      const setTimeout = window.setTimeout;
      window.setTimeout = ((run: () => void, ms?: number) => {
        const id = setTimeout(run, ms);
        held.push({ run, id });
        return id;
      }) as typeof window.setTimeout;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      for (let i = 0; i < 100 && held.length === 0; i++) await Promise.resolve();
      window.setTimeout = setTimeout;
      if (held.length !== 1) return held.length;
      // A new history entry, even at the same address.
      const entry = (history.state as { key?: string } | null)?.key;
      (view as HTMLElement).click();
      for (let i = 0; i < 100 && (history.state as { key?: string } | null)?.key === entry; i++) await Promise.resolve();
      window.clearTimeout(held[0]!.id);
      held[0]!.run();
      return held.length;
    },
    { view, text },
  );
  // The write was the one timer the search set.
  expect(timers).toBe(1);
}

test('sort: chosen in a view, it is there again on return and after a reload, and each view has its own', async ({ page }) => {
  await open(page, '/problems');
  const byTitle = await firstTitles(page, 'type=problem&sort=title');
  const byUpdate = await firstTitles(page, 'type=problem');
  expect(byTitle).not.toEqual(byUpdate);
  await shownFirst(page, byUpdate);

  await column(page, 'title').click();
  await expect(page).toHaveURL(/sort=title/);
  await shownFirst(page, byTitle);
  expect(await stored(page)).toEqual({ 'view:problem': expect.objectContaining({ sort: 'title', order: null }) });

  // Back from another page, by a link with no sort in it.
  await nav(page).getByRole('link', { name: /^Tags/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Tags/ })).toBeVisible();
  await nav(page).getByRole('link', { name: /^Problems/ }).click();
  await expect(page).not.toHaveURL(/sort=/);
  await expect(column(page, 'title')).toHaveAttribute('aria-pressed', 'true');
  await shownFirst(page, byTitle);

  await page.reload();
  await expect(page).not.toHaveURL(/sort=/);
  await expect(column(page, 'title')).toHaveAttribute('aria-pressed', 'true');
  await shownFirst(page, byTitle);

  // Readings is in its own order, and keeps the one chosen there.
  await nav(page).getByRole('link', { name: /^Readings/ }).click();
  await expect(column(page, 'updated')).toHaveAttribute('aria-pressed', 'true');
  await shownFirst(page, await firstTitles(page, 'type=reading'));
  await column(page, 'difficulty').click();
  await expect(column(page, 'difficulty')).toHaveAttribute('aria-pressed', 'true');
  await nav(page).getByRole('link', { name: /^Problems/ }).click();
  await expect(column(page, 'title')).toHaveAttribute('aria-pressed', 'true');
  await nav(page).getByRole('link', { name: /^Readings/ }).click();
  await expect(page).not.toHaveURL(/sort=/);
  await expect(column(page, 'difficulty')).toHaveAttribute('aria-pressed', 'true');
  await shownFirst(page, await firstTitles(page, 'type=reading&sort=difficulty'));
  // All items is in its own too.
  await nav(page).getByRole('link', { name: /^All items/ }).click();
  await expect(column(page, 'updated')).toHaveAttribute('aria-pressed', 'true');

  // A filter changed keeps it out of the URL.
  await nav(page).getByRole('link', { name: /^Problems/ }).click();
  await page.getByRole('search', { name: 'Filter items' }).getByRole('button', { name: /^Status/ }).click();
  await page.getByRole('dialog', { name: 'Status' }).getByText('Done').click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/status=done/);
  await expect(page).not.toHaveURL(/sort=/);
  await expect(column(page, 'title')).toHaveAttribute('aria-pressed', 'true');
});

test('sort: Favorites narrowed to a type in the filter bar keeps Favorites\' sort', async ({ page }) => {
  await open(page, '/favorites');
  await column(page, 'title').click();
  await expect(column(page, 'title')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('search', { name: 'Filter items' }).getByRole('button', { name: /^Type/ }).click();
  await page.getByRole('dialog', { name: 'Type' }).getByRole('checkbox', { name: 'Problem' }).click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/type=problem/);
  await expect(column(page, 'title')).toHaveAttribute('aria-pressed', 'true');
  // From a link with no sort in it, and not Problems' order.
  await page.goto('/favorites?type=problem');
  await expect(column(page, 'title')).toHaveAttribute('aria-pressed', 'true');
  await shownFirst(page, await firstTitles(page, 'favorite=true&type=problem&sort=title'));
  expect(Object.keys((await stored(page)) ?? {})).toEqual(['view:favorite']);
});

test('sort: each collection keeps its own, and its manual order is not the library\'s title sort', async ({ page }) => {
  await open(page, '/problems');
  await column(page, 'title').click();
  await expect(column(page, 'title')).toHaveAttribute('aria-pressed', 'true');

  await nav(page).getByRole('link', { name: /^Weekly practice/ }).click();
  await expect(page.locator('ul.item-list.is-reorderable')).toBeVisible();
  await expect(head(page).locator('[aria-pressed="true"]')).toHaveCount(0);
  await column(page, 'difficulty').click();
  await expect(page.locator('ul.item-list.is-reorderable')).toHaveCount(0);
  await column(page, 'difficulty').click();
  await expect(column(page, 'difficulty')).toHaveAccessibleName(/hardest first/);

  // Another collection is still in its manual order, Problems still by title.
  await page.goto(`/collections/${INTERVIEW}`);
  await expect(page.locator('ul.item-list.is-reorderable')).toBeVisible();
  await nav(page).getByRole('link', { name: /^Problems/ }).click();
  await expect(column(page, 'title')).toHaveAttribute('aria-pressed', 'true');
  await nav(page).getByRole('link', { name: /^Weekly practice/ }).click();
  await expect(page).not.toHaveURL(/sort=/);
  await expect(column(page, 'difficulty')).toHaveAttribute('aria-pressed', 'true');
  await expect(column(page, 'difficulty')).toHaveAccessibleName(/hardest first/);
  await shownFirst(page, await firstTitles(page, `collectionId=${WEEKLY}&sort=difficulty&order=desc`));
  expect(await stored(page)).toMatchObject({ 'view:problem': { sort: 'title', order: null }, [`collection:${WEEKLY}`]: { sort: 'difficulty', order: 'desc' } });
});

test('sort: the third click on a column goes back to the default, which stays after a reload', async ({ page }) => {
  await open(page, '/');
  await column(page, 'title').click();
  await column(page, 'title').click();
  await expect(column(page, 'title')).toHaveAccessibleName(/Z to A/);
  // Reloaded from a link with no sort in it.
  await page.goto('/');
  await expect(page).not.toHaveURL(/sort=/);
  await expect(column(page, 'title')).toHaveAccessibleName(/Z to A/);
  await column(page, 'title').click();
  await expect(column(page, 'updated')).toHaveAttribute('aria-pressed', 'true');
  expect(await stored(page)).toBeNull();
  await page.reload();
  await expect(column(page, 'updated')).toHaveAttribute('aria-pressed', 'true');
  await expect(column(page, 'title')).toHaveAttribute('aria-pressed', 'false');
});

test('sort: a search started on a sort just clicked sorts by relevance too, and clearing it brings the sort back', async ({ page }) => {
  await open(page, '/problems');
  await column(page, 'title').click();
  await expect(page).toHaveURL(/sort=title/);
  const search = page.getByRole('search', { name: 'Filter items' }).getByRole('searchbox');
  await search.fill('graph');
  await expect(page).toHaveURL(/q=graph/);
  await expect(page).not.toHaveURL(/sort=/);
  await expect(head(page).locator('[aria-pressed="true"]')).toHaveCount(0);
  await shownFirst(page, await firstTitles(page, 'type=problem&q=graph&sort=relevance'));

  await search.fill('');
  await expect(page).not.toHaveURL(/q=/);
  await expect(page).not.toHaveURL(/sort=/);
  await expect(column(page, 'title')).toHaveAttribute('aria-pressed', 'true');
  await shownFirst(page, await firstTitles(page, 'type=problem&sort=title'));

  // A sort the URL names that is not the remembered one, as in a shared link, stays through a search.
  await page.goto('/problems?sort=difficulty');
  await search.fill('graph');
  await expect(page).toHaveURL(/q=graph/);
  await expect(page).toHaveURL(/sort=difficulty/);
});

test('sort: a search sorts by relevance, whatever is remembered, and a sort chosen in it is not', async ({ page }) => {
  await open(page, '/');
  await column(page, 'title').click();
  await nav(page).getByRole('link', { name: /^Tags/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Tags/ })).toBeVisible();
  await nav(page).getByRole('link', { name: /^All items/ }).click();
  await expect(column(page, 'title')).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('search', { name: 'Filter items' }).getByRole('searchbox').fill('graph');
  await expect(page).toHaveURL(/q=graph/);
  await expect(page).not.toHaveURL(/sort=/);
  await expect(head(page).locator('[aria-pressed="true"]')).toHaveCount(0);
  await shownFirst(page, await firstTitles(page, 'q=graph&sort=relevance'));

  await column(page, 'difficulty').click();
  await expect(page).toHaveURL(/sort=difficulty/);
  expect(await stored(page)).toMatchObject({ 'view:all': { sort: 'title' } });

  // Cleared, the search leaves the remembered sort again.
  await page.getByRole('search', { name: 'Filter items' }).getByRole('searchbox').fill('');
  await nav(page).getByRole('link', { name: /^All items/ }).click();
  await expect(column(page, 'title')).toHaveAttribute('aria-pressed', 'true');
});

test('sort: a search cleared as the view is opened again, written before the page draws it, leaves the view as opened', async ({ page }) => {
  await open(page, '/');
  await column(page, 'title').click();
  await expect(column(page, 'title')).toHaveAttribute('aria-pressed', 'true');
  const search = page.getByRole('search', { name: 'Filter items' }).getByRole('searchbox');
  await search.fill('graph');
  await expect(page).toHaveURL(/q=graph/);
  await column(page, 'difficulty').click();
  await expect(column(page, 'difficulty')).toHaveAttribute('aria-pressed', 'true');

  // The box is cleared and All items clicked at once, the search's write coming due before the page draws it.
  await searchAsViewOpens(page, '', /^All items/);

  await expect(column(page, 'title')).toHaveAttribute('aria-pressed', 'true');
  await expect(search).toHaveValue('');
  expect(params(page)).toEqual({});
});

test('sort: a search typed as the view is opened again, written before the page draws it, is dropped with it', async ({ page }) => {
  await open(page, '/');
  await column(page, 'title').click();
  await nav(page).getByRole('link', { name: /^Tags/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Tags/ })).toBeVisible();
  await nav(page).getByRole('link', { name: /^All items/ }).click();
  await expect(column(page, 'title')).toHaveAttribute('aria-pressed', 'true');
  expect(params(page)).toEqual({});
  const search = page.getByRole('search', { name: 'Filter items' }).getByRole('searchbox');

  // At the address the link leads to: the view is opened again all the same.
  await searchAsViewOpens(page, 'graph', /^All items/);
  await expect(search).toHaveValue('');
  await expect(column(page, 'title')).toHaveAttribute('aria-pressed', 'true');
  expect(params(page)).toEqual({});
});

test('sort: one last used more than 30 days ago is forgotten, as is the old shared one', async ({ page }) => {
  await page.addInitScript(
    ({ key, day }) => {
      // Once, so that what the page writes is what a reload then reads.
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem(
        key,
        JSON.stringify({
          'view:all': { sort: 'title', order: null, at: Date.now() - 31 * day },
          // The one scope the sidebar's views once shared: no longer read.
          library: { sort: 'difficulty', order: null, at: Date.now() },
          'collection:22222222-2222-4222-8222-000000000008': { sort: 'title', order: 'desc', at: Date.now() - 29 * day },
        }),
      );
    },
    { key: KEY, day: DAY },
  );
  await open(page, '/');
  await expect(column(page, 'updated')).toHaveAttribute('aria-pressed', 'true');
  await expect(column(page, 'title')).toHaveAttribute('aria-pressed', 'false');
  await expect(column(page, 'difficulty')).toHaveAttribute('aria-pressed', 'false');
  // Dropped on the visit; the collection's, used 29 days ago, is still there.
  await expect.poll(() => stored(page).then((s) => Object.keys(s ?? {}))).toEqual([`collection:${WEEKLY}`]);

  await nav(page).getByRole('link', { name: /^Weekly practice/ }).click();
  await expect(column(page, 'title')).toHaveAccessibleName(/Z to A/);
  await expect(column(page, 'title')).toHaveAttribute('aria-pressed', 'true');
  // The visit starts its 30 days again.
  const at = (await stored(page))![`collection:${WEEKLY}`]!.at;
  expect(Date.now() - at).toBeLessThan(DAY);
});

/** The query string on screen, without the mock's own flag. */
function params(page: Page): Record<string, string> {
  const url = new URL(page.url());
  url.searchParams.delete('mock');
  return Object.fromEntries(url.searchParams);
}

test('sort: a search typed or cleared just before another view is opened stays in its own view', async ({ page }) => {
  await open(page, '/problems');
  await column(page, 'title').click();
  await nav(page).getByRole('link', { name: /^Readings/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Readings/);
  await column(page, 'difficulty').click();
  await expect(column(page, 'difficulty')).toHaveAttribute('aria-pressed', 'true');
  await nav(page).getByRole('link', { name: /^Problems/ }).click();
  await expect(column(page, 'title')).toHaveAttribute('aria-pressed', 'true');
  const search = page.getByRole('search', { name: 'Filter items' }).getByRole('searchbox');

  // Typed, and Readings opened before the search reaches the URL.
  await search.fill('graph');
  await nav(page).getByRole('link', { name: /^Readings/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Readings/);
  // Past the moment the search would have been written.
  await page.waitForTimeout(500);
  expect(new URL(page.url()).pathname).toBe('/readings');
  expect(params(page)).toEqual({});
  await expect(search).toHaveValue('');
  await expect(column(page, 'difficulty')).toHaveAttribute('aria-pressed', 'true');

  // A search in Problems, sorted there by updated and filtered, then cleared just before leaving.
  await nav(page).getByRole('link', { name: /^Problems/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Problems/);
  // Nothing typed in Problems before comes back with it.
  await expect(search).toHaveValue('');
  await search.fill('sum');
  await expect(page).toHaveURL(/q=sum/);
  await column(page, 'updated').click();
  await expect(page).toHaveURL(/sort=updated/);
  await page.getByRole('search', { name: 'Filter items' }).getByRole('button', { name: /^Status/ }).click();
  await page.getByRole('dialog', { name: 'Status' }).getByText('Done').click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/status=done/);
  await search.fill('');
  await nav(page).getByRole('link', { name: /^Readings/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Readings/);
  await page.waitForTimeout(500);
  expect(new URL(page.url()).pathname).toBe('/readings');
  expect(params(page)).toEqual({});
  await expect(column(page, 'difficulty')).toHaveAttribute('aria-pressed', 'true');
  // Problems' own sort is still title.
  await nav(page).getByRole('link', { name: /^Problems/ }).click();
  await expect(column(page, 'title')).toHaveAttribute('aria-pressed', 'true');
});
