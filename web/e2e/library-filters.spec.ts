import { expect, test, type Page } from '@playwright/test';
import { mockApi, open } from './support';

// The Type (in a collection), Status, Difficulty and Tags menus of the filter
// bar: a header that counts what is picked and clears it, then rows with the
// value, how many items of the view have it, and a round checkbox.

const bar = (page: Page) => page.getByRole('search', { name: 'Filter items' });
const menu = (page: Page, name: string) => page.getByRole('dialog', { name });

async function openMenu(page: Page, name: string) {
  await bar(page).getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await expect(menu(page, name)).toBeVisible();
  return menu(page, name);
}

/** The total of `GET /items` with these parameters, asked of the mock past the page's cache. */
const total = async (page: Page, query: string) => (await mockApi<{ total: number }>(page, `/items?limit=1&${query}`)).total;

/** Each row's name and count, as the menu shows them. */
const counts = (page: Page, name: string) =>
  menu(page, name)
    .locator('.facet-row')
    .evaluateAll((rows) => Object.fromEntries(rows.map((r) => [r.querySelector('input')!.getAttribute('aria-label'), Number(r.querySelector('.facet-count')!.textContent)])));

test('filters: the counts are what each value shows in this view, the menu\'s own filter aside', async ({ page }) => {
  await open(page, '/?type=reading');
  await openMenu(page, 'Status');
  await expect(menu(page, 'Status').locator('.facet-count .skel')).toHaveCount(0);
  const readings = await counts(page, 'Status');
  expect(readings).toEqual({
    'To do': await total(page, 'type=reading&status=todo'),
    'In progress': await total(page, 'type=reading&status=in_progress'),
    Done: await total(page, 'type=reading&status=done'),
  });
  // Not the library's: the problems are left out.
  expect(readings['To do']).toBeLessThan(await total(page, 'status=todo'));

  // Ticking keeps the menu open and its counts: they leave the status out.
  await menu(page, 'Status').getByRole('checkbox', { name: 'Done' }).click();
  await expect(page).toHaveURL(/status=done/);
  await expect(menu(page, 'Status').getByRole('checkbox', { name: 'Done' })).toBeChecked();
  await expect(menu(page, 'Status').locator('.facet-row.is-selected')).toHaveText(/Done/);
  expect(await counts(page, 'Status')).toEqual(readings);
  await page.keyboard.press('Escape');

  // The other menus count within the picked status.
  await openMenu(page, 'Difficulty');
  await expect
    .poll(() => counts(page, 'Difficulty'))
    .toEqual({
      Easy: await total(page, 'type=reading&status=done&difficulty=easy'),
      Medium: await total(page, 'type=reading&status=done&difficulty=medium'),
      Hard: await total(page, 'type=reading&status=done&difficulty=hard'),
      'Not set': await total(page, 'type=reading&status=done&difficulty=none'),
    });
  await page.keyboard.press('Escape');

  // And within the search.
  await bar(page).getByRole('searchbox').fill('distributed');
  await expect(page).toHaveURL(/q=distributed/);
  await openMenu(page, 'Status');
  await expect
    .poll(() => counts(page, 'Status'))
    .toEqual({
      'To do': await total(page, 'type=reading&q=distributed&status=todo'),
      'In progress': await total(page, 'type=reading&q=distributed&status=in_progress'),
      Done: await total(page, 'type=reading&q=distributed&status=done'),
    });
});

test('filters: in a collection with its nested ones, tags count the items of the view that carry them', async ({ page }) => {
  // Interview prep, which has nested collections.
  const id = '22222222-2222-4222-8222-000000000001';
  await open(page, `/collections/${id}`);
  // The filters live in the URL, so a box changes once the route has: click, then wait for it.
  await page.getByRole('checkbox', { name: 'Include nested' }).click();
  await expect(page).toHaveURL(/recursive=true/);
  const scope = `collectionId=${id}&recursive=true`;

  const tags = await openMenu(page, 'Tags');
  const row = tags.locator('.facet-row').first();
  const tag = (await row.locator('input').getAttribute('aria-label'))!;
  await expect(row.locator('.facet-count')).toHaveText(String(await total(page, `${scope}&tag=${tag}`)));
  await expect(row).toContainText(`#${tag}`);
  await row.getByRole('checkbox').click();
  await expect(page).toHaveURL(new RegExp(`tag=${tag}`));
  await expect(tags.locator('.facet-head')).toContainText('1 selected');
  await expect(row.getByRole('checkbox')).toBeChecked();
});

test('filters: Clear empties the menu\'s values, and the header keeps its height', async ({ page }) => {
  await open(page, '/');
  const status = await openMenu(page, 'Status');
  const head = status.locator('.facet-head');
  const clear = status.getByRole('button', { name: 'Clear' });
  await expect(head).toHaveText(/0 selected/);
  await expect(clear).toBeHidden();
  // Measured once the counts are in and the menu has grown in.
  await expect(status.locator('.facet-count .skel')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await status.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  const height = (await head.boundingBox())!.height;
  const firstRowTop = (await status.locator('.facet-row').first().boundingBox())!.y;

  // The round mark is the checkbox; a key toggles it as well as a click.
  await status.getByRole('checkbox', { name: 'To do' }).click();
  await expect(page).toHaveURL(/status=todo/);
  await status.getByRole('checkbox', { name: 'In progress' }).focus();
  await page.keyboard.press('Space');
  await expect(page).toHaveURL(/status=todo&status=in_progress/);
  await expect(head).toContainText('2 selected');
  await expect(clear).toBeVisible();
  expect((await head.boundingBox())!.height).toBe(height);
  expect((await status.locator('.facet-row').first().boundingBox())!.y).toBe(firstRowTop);

  await clear.click();
  await expect(page).not.toHaveURL(/status=/);
  await expect(status).toBeVisible();
  await expect(status.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await expect(head).toHaveText(/0 selected/);
  await expect(clear).toBeHidden();
  expect((await head.boundingBox())!.height).toBe(height);
  // The focus Clear had goes to the first row.
  await expect(status.getByRole('checkbox', { name: 'To do' })).toBeFocused();
});

test('filters: the counts follow a status changed from a row', async ({ page }) => {
  await open(page, '/');
  await openMenu(page, 'Status');
  await expect(menu(page, 'Status').locator('.facet-count .skel')).toHaveCount(0);
  const before = await counts(page, 'Status');
  await page.keyboard.press('Escape');

  const row = page.locator('.item-row').filter({ has: page.getByRole('button', { name: /^Status of .*: To do\. Change$/ }) }).first();
  await row.getByRole('button', { name: /^Status of / }).click();
  await page.getByRole('menuitemradio', { name: 'Done' }).click();

  await openMenu(page, 'Status');
  await expect.poll(() => counts(page, 'Status')).toEqual({ ...before, 'To do': before['To do']! - 1, Done: before.Done! + 1 });
});

test('filters: the Tags menu lists a few of the view’s tags, the most used first, and finds the rest by typing', async ({ page }) => {
  await open(page, '/');
  const tags = await openMenu(page, 'Tags');
  const names = () => tags.locator('.facet-row input').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')!));
  const shown = await names();
  expect(shown).toHaveLength(5);
  const shownCounts = (await tags.locator('.facet-count').allTextContents()).map(Number);
  expect(shownCounts).toEqual([...shownCounts].sort((a, b) => b - a));
  await expect(tags.getByRole('textbox', { name: 'Search tags' })).toHaveAttribute('placeholder', 'Type to search…');

  // A tag past the first few is found by typing.
  expect(shown).not.toContain('two-pointers');
  await tags.getByRole('textbox', { name: 'Search tags' }).fill('two');
  expect(await names()).toEqual(['two-pointers']);
  await tags.getByRole('textbox', { name: 'Search tags' }).fill('no-such-tag');
  await expect(tags.getByText('No match.')).toBeVisible();

  // Picked tags stay at the top whatever is typed, and the search stays though the pick narrows the rest.
  const search = tags.getByRole('textbox', { name: 'Search tags' });
  await search.fill('two');
  const twoPointers = tags.getByRole('checkbox', { name: 'two-pointers', exact: true });
  await twoPointers.click();
  await expect(twoPointers).toBeChecked();
  await search.fill('');
  await expect(search).toBeVisible();
  expect((await names())[0]).toBe('two-pointers');
  await search.fill('no-such-tag');
  expect(await names()).toEqual(['two-pointers']);
  await expect(tags.getByText('No match.')).toBeVisible();
});

test('filters: the Tags menu leaves out the tags no item of the view carries, but keeps a picked one', async ({ page }) => {
  // Only problems carry "array".
  await open(page, '/?type=reading');
  const tags = await openMenu(page, 'Tags');
  const names = () => tags.locator('.facet-row input').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')!));
  await expect(tags.locator('.facet-row').first()).toBeVisible();
  expect(await names()).not.toContain('array');
  for (const count of await tags.locator('.facet-count').allTextContents()) expect(Number(count)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');

  // Picked, it shows, first, with nothing to count.
  await open(page, '/?type=reading&tag=array');
  const picked = await openMenu(page, 'Tags');
  const first = picked.locator('.facet-row').first();
  await expect(first.getByRole('checkbox', { name: 'array', exact: true })).toBeChecked();
  await expect(first.locator('.facet-count')).toHaveText('0');
  await expect(picked.locator('.facet-row')).toHaveCount(1);
});

test('filters: a collection and Favorites have a Type menu that picks one type at a time; other views pick it in the sidebar', async ({ page }) => {
  await open(page, '/');
  await expect(bar(page).getByRole('button', { name: /^Status/ })).toBeVisible();
  await expect(bar(page).getByRole('button', { name: /^Type/ })).toHaveCount(0);
  await open(page, '/?type=problem');
  await expect(bar(page).getByRole('button', { name: /^Status/ })).toBeVisible();
  await expect(bar(page).getByRole('button', { name: /^Type/ })).toHaveCount(0);

  // Favorites: picking a type keeps the view, and clearing the bar removes it.
  await open(page, '/?favorite=true');
  const favType = await openMenu(page, 'Type');
  await favType.getByRole('checkbox', { name: 'Reading' }).click();
  await expect(page).toHaveURL(/[?&]type=reading/);
  await expect(page).toHaveURL(/[?&]favorite=true/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Favorites/);
  await page.keyboard.press('Escape');
  await bar(page).getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).not.toHaveURL(/type=/);
  await expect(page).toHaveURL(/[?&]favorite=true/);

  // Weekly practice: problems and a reading.
  const id = '22222222-2222-4222-8222-000000000008';
  const scope = `collectionId=${id}`;
  await open(page, `/collections/${id}`);
  const nav = page.getByRole('complementary', { name: 'Navigation' });
  const filterButtons = bar(page).locator('.filter-btn');
  await expect(filterButtons.first()).toHaveText(/^Type/);
  await expect(filterButtons.nth(1)).toHaveText(/^Status/);

  const type = await openMenu(page, 'Type');
  await expect(type.locator('.facet-head')).toHaveText(/0 selected/);
  await expect(type.locator('.facet-count .skel')).toHaveCount(0);
  const all = { Problem: await total(page, `${scope}&type=problem`), Reading: await total(page, `${scope}&type=reading`) };
  expect(all.Problem).toBeGreaterThan(0);
  expect(all.Reading).toBeGreaterThan(0);
  expect(await counts(page, 'Type')).toEqual(all);

  // Picking narrows the list, and the view stays the collection's.
  await type.getByRole('checkbox', { name: 'Problem' }).click();
  await expect(page).toHaveURL(/type=problem/);
  await expect(type.locator('.facet-head')).toContainText('1 selected');
  await expect(type.locator('.facet-row.is-selected')).toHaveText(/Problem/);
  await expect(page.locator('.item-row .item-type [aria-label="Reading"]')).toHaveCount(0);
  await expect(page.locator('.item-row')).toHaveCount(all.Problem);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Weekly practice/);
  await expect(page).toHaveTitle(/Weekly practice/);
  await expect(nav.getByRole('link', { name: /^Weekly practice/ })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: /^Problems/ })).not.toHaveAttribute('aria-current', 'page');
  // The counts leave the type out, so the other one is still there to pick.
  expect(await counts(page, 'Type')).toEqual(all);

  // Picking the other switches to it.
  await type.getByRole('checkbox', { name: 'Reading' }).click();
  await expect(page).toHaveURL(/type=reading/);
  await expect(page).not.toHaveURL(/type=problem/);
  await expect(type.getByRole('checkbox', { checked: true })).toHaveCount(1);
  await expect(type.getByRole('checkbox', { name: 'Reading' })).toBeChecked();
  await expect(page.locator('.item-row')).toHaveCount(all.Reading);
  // As in Readings, a list of readings has no Verdict column.
  await expect(page.locator('.item-list-head').getByText('Verdict', { exact: true })).toHaveCount(0);

  // Unticking it, or Clear, removes it.
  await type.getByRole('checkbox', { name: 'Reading' }).click();
  await expect(page).not.toHaveURL(/type=/);
  await expect(type.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await type.getByRole('checkbox', { name: 'Problem' }).click();
  await expect(page).toHaveURL(/type=problem/);
  await type.getByRole('button', { name: 'Clear' }).click();
  await expect(page).not.toHaveURL(/type=/);
  await expect(type.locator('.facet-head')).toHaveText(/0 selected/);

  // Here it is the bar's filter: counted on its button, and cleared with the others.
  await type.getByRole('checkbox', { name: 'Problem' }).click();
  await expect(page).toHaveURL(/type=problem/);
  await page.keyboard.press('Escape');
  await expect(bar(page).getByRole('button', { name: /^Type/ }).locator('.filter-count')).toHaveText('1');
  await bar(page).getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).not.toHaveURL(/type=/);
  await expect(page.locator('.item-row')).toHaveCount(all.Problem + all.Reading);

  // Outside a collection, clearing the bar keeps the sidebar's type.
  await open(page, '/?type=reading&status=done');
  await bar(page).getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).not.toHaveURL(/status=/);
  await expect(page).toHaveURL(/type=reading/);
});

test('filters: a collection filtered to one type with nothing in it offers to clear the filters', async ({ page }) => {
  // Arrays & hashing holds only problems.
  await open(page, '/collections/22222222-2222-4222-8222-000000000002?type=reading');
  await expect(page.getByText('No items match')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).last().click();
  await expect(page).not.toHaveURL(/type=/);
  await expect(page.locator('.item-row').first()).toBeVisible();
});
