import { expect, test, type Page } from '@playwright/test';
import { mockApi, open } from './support';

// The count beside the library's title. Switching views keeps the last page
// on screen, dimmed, until the next one loads; the count is the new view's
// from the first frame of its title, not the last view's rolling to it.

interface Frame {
  title: string;
  count: string;
  rolling: boolean;
  stale: boolean;
}

/** Record, every frame from now on, the title, its count, whether that count rolls and whether the list is a kept page. */
async function sample(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { frames_: Frame[] };
    w.frames_ = [];
    // The digits shown, without the old ones a roll moves out.
    const shown = (el: Element | null) => {
      const copy = el?.cloneNode(true) as Element | undefined;
      copy?.querySelectorAll('.num-old').forEach((old) => old.remove());
      return copy?.textContent ?? '';
    };
    const tick = () => {
      const h1 = document.querySelector('h1.page-title');
      if (h1) {
        w.frames_.push({
          title: (h1.firstChild?.nodeType === Node.TEXT_NODE ? h1.firstChild.textContent : '')!.trim(),
          count: shown(h1.querySelector('.page-count > [aria-hidden="true"]')),
          rolling: !!h1.querySelector('.num-change'),
          stale: !!document.querySelector('.item-list-wrap.is-stale'),
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** The frames recorded since the last call. */
const taken = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { frames_: Frame[] };
    return w.frames_.splice(0);
  });

/** The total of `GET /items` with these parameters, asked of the mock past the page's cache. */
const total = async (page: Page, query: string) => (await mockApi<{ total: number }>(page, `/items?limit=1&${query}`)).total;

const nav = (page: Page) => page.getByRole('complementary', { name: 'Navigation' });
const count = (page: Page) => page.locator('h1.page-title .page-count > [aria-hidden="true"]');

test('library count: a view switch shows the new view\'s count with its title, and it does not roll', async ({ page }) => {
  // Real latency, so each switch has a moment with the last page kept.
  await open(page, '/', 'default');
  const stats = await mockApi<{ items: { total: number; favorites: number; byType: { problem: number; reading: number } } }>(page, '/stats');
  const { items: collections } = await mockApi<{ items: { id: string; name: string; itemCount: number }[] }>(page, '/collections');
  const weekly = collections.find((c) => c.name === 'Weekly practice')!;
  // `known` is the count already loaded for the view, which the title shows
  // ahead of the list; `kept` whether the list has to load (the last page
  // stays meanwhile) or is in the cache from an earlier visit.
  const views = [
    { link: /^Problems/, title: 'Problems', count: await total(page, 'type=problem'), known: stats.items.byType.problem, kept: true },
    { link: /^Readings/, title: 'Readings', count: await total(page, 'type=reading'), known: stats.items.byType.reading, kept: true },
    { link: /^All items/, title: 'Library', count: await total(page, ''), known: stats.items.total, kept: false },
    { link: /^Weekly practice/, title: 'Weekly practice', count: await total(page, `collectionId=${weekly.id}`), known: weekly.itemCount, kept: true },
    { link: /^Favorites/, title: 'Favorites', count: await total(page, 'favorite=true'), known: stats.items.favorites, kept: true },
    { link: /^Readings/, title: 'Readings', count: await total(page, 'type=reading'), known: stats.items.byType.reading, kept: false },
  ];
  // The mock's counts agree with its lists.
  for (const v of views) expect(v.known, v.title).toBe(v.count);

  await expect(count(page)).toHaveText(String(stats.items.total));
  await expect(page.locator('.item-list-wrap.is-stale')).toHaveCount(0);
  await sample(page);
  for (const v of views) {
    await taken(page);
    await nav(page).getByRole('link', { name: v.link }).first().click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(new RegExp(`^${v.title}`));
    await expect(count(page)).toHaveText(String(v.count));
    await expect(page.locator('.item-list-wrap.is-stale')).toHaveCount(0);
    await expect(page.locator('h1.page-title .sr-only')).toHaveText(`, ${v.count} items`);
    // Past a roll's length, to see one that would have started.
    await page.waitForTimeout(400);
    const frames = (await taken(page)).filter((f) => f.title === v.title);
    expect(frames.length, v.title).toBeGreaterThan(0);
    if (v.kept) expect(frames.some((f) => f.stale), v.title).toBe(true);
    // Under its new title, all along, the count was the new view's.
    expect(frames.map((f) => f.count).filter((c) => c !== String(v.count)), v.title).toEqual([]);
    expect(frames.filter((f) => f.rolling), v.title).toEqual([]);
  }
});

test('library count: a search in the same view keeps the count until the narrower one, and rolls to it', async ({ page }) => {
  await open(page, '/?type=reading', 'default');
  const all = await total(page, 'type=reading');
  const found = await total(page, 'type=reading&q=distributed');
  expect(found).toBeLessThan(all);
  await expect(count(page)).toHaveText(String(all));
  await expect(page.locator('.item-list-wrap.is-stale')).toHaveCount(0);
  await sample(page);
  await page.getByRole('search', { name: 'Filter items' }).getByRole('searchbox').fill('distributed');
  await expect(count(page)).toHaveText(String(found));
  await page.waitForTimeout(400);
  const frames = await taken(page);
  // Never blank in between: it is the same list, narrowed.
  expect(frames.filter((f) => f.count === '')).toEqual([]);
  expect(frames.some((f) => f.rolling)).toBe(true);
});
