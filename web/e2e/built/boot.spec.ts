import { expect, test, type Page } from '@playwright/test';
import { loadingRecord, open, recordLoading } from '../support';

// Run against a production build (the `built` project in playwright.config.ts):
// how a reload paints depends on bundling, preloading and fonts, which the
// dev server does differently.

/** What the first shown frame held, recorded in the page from its first moment. */
interface FirstFrame {
  at: number;
  shell: boolean;
  counts: number;
  collections: number;
  rows: number;
  fontsLoaded: boolean;
  /** Where things stood, to compare with once everything is in. */
  boxes: Record<string, { top: number; left: number; height: number } | null>;
}

/** Things whose place must not change when a late part of the first screen arrives. */
const STEADY = ['.page-title', '.filterbar', '.item-list-wrap', '#nav-collections', '#nav-manage', '.sidebar a[href="/settings"]', '.sidebar-foot'];

async function recordFirstFrame(page: Page): Promise<void> {
  await page.addInitScript((steady) => {
    const w = window as unknown as { __first: unknown; __fontsAfter: string[] };
    w.__fontsAfter = [];
    document.fonts.addEventListener('loadingdone', (e) => {
      if (w.__first) w.__fontsAfter.push(...e.fontfaces.map((f) => `${f.family} ${f.style}`));
    });
    const frame = () => {
      if (document.documentElement.classList.contains('is-booting')) {
        requestAnimationFrame(frame);
        return;
      }
      const box = (sel: string) => {
        const r = document.querySelector(sel)?.getBoundingClientRect();
        return r ? { top: r.top, left: r.left, height: sel === '.item-list-wrap' ? 0 : r.height } : null;
      };
      w.__first = {
        at: performance.now(),
        shell: document.querySelector('.shell') !== null,
        counts: [...document.querySelectorAll('.sidebar .nav-count')].filter((e) => e.textContent?.trim()).length,
        collections: document.querySelectorAll('.nav-tree-link').length,
        rows: document.querySelectorAll('.item-list:not(.item-skeleton) .item-row').length,
        fontsLoaded: document.fonts.status === 'loaded',
        boxes: Object.fromEntries(steady.map((s) => [s, box(s)])),
      };
    };
    requestAnimationFrame(frame);
  }, STEADY);
}

const firstFrame = (page: Page) => page.evaluate(() => (window as unknown as { __first: FirstFrame }).__first);

async function boxesNow(page: Page) {
  return page.evaluate((steady) => {
    const box = (sel: string) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r ? { top: r.top, left: r.left, height: sel === '.item-list-wrap' ? 0 : r.height } : null;
    };
    return Object.fromEntries(steady.map((s) => [s, box(s)]));
  }, STEADY);
}

test('built: a reload paints the shell, the sidebar counts and the rows in one frame, in their fonts', async ({ page }) => {
  await recordFirstFrame(page);
  await recordLoading(page);
  await open(page, '/');
  await expect(page.locator('.item-row').first()).toBeVisible();
  await page.reload();
  await expect(page.locator('.item-row').first()).toBeVisible();
  await page.waitForTimeout(500);

  const first = await firstFrame(page);
  const counts = await page.locator('.sidebar .nav-count').evaluateAll((els) => els.filter((e) => e.textContent?.trim()).length);
  const rows = await page.locator('.item-list .item-row').count();
  expect(first).toMatchObject({ shell: true, counts, rows, fontsLoaded: true });
  expect(counts).toBeGreaterThan(5);
  // No text changed font afterwards, and nothing showed as loading.
  expect(await page.evaluate(() => (window as unknown as { __fontsAfter: string[] }).__fontsAfter)).toEqual([]);
  expect((await loadingRecord(page)).indicators).toEqual([]);
});

for (const slow of ['stats', 'collections', 'items']) {
  test(`built: with ${slow} a second late, the shell shows by the deadline and nothing moves when they come`, async ({ page }) => {
    await recordFirstFrame(page);
    // A first visit, so the sidebar knows how tall its collections are.
    await open(page, '/');
    await expect(page.locator('.item-row').first()).toBeVisible();
    await page.goto(`/?mock=fast,slow-${slow}`);
    await expect(page.locator('.item-row').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.nav-tree-link').first()).toBeVisible();
    await expect(page.locator('.sidebar a[href="/"] .nav-count')).not.toBeEmpty();
    await page.waitForTimeout(500);

    const first = await firstFrame(page);
    expect(first.shell).toBe(true);
    // By the boot's 300ms deadline, counted from when the script starts.
    expect(first.at).toBeLessThan(600);
    expect(first.fontsLoaded).toBe(true);
    // The late part was indeed late.
    if (slow === 'items') expect(first.rows).toBe(0);
    if (slow === 'collections') expect(first.collections).toBe(0);
    if (slow === 'stats') expect(first.counts).toBeLessThan(await page.locator('.sidebar .nav-count').count());
    expect(await boxesNow(page)).toEqual(first.boxes);
  });
}
