import { expect, test, type Page } from '@playwright/test';
import { open } from './support';

// Motion plays on a change made on screen, never on arriving at data that
// was already so; under reduced motion every change lands at once.

/**
 * What fades in as it arrives: the app once on a reload, and each screen as
 * it mounts (styles/layout.css). These are the only things that may move on
 * arriving; `played` keeps them apart from everything else.
 */
const ENTRANCES = '#root, .shell, .page, .workspace > *, .reader';

/** Record every animation and transition that starts from now on, CSS or script. */
async function recordAnimations(page: Page): Promise<void> {
  await page.addInitScript((entrances) => {
    const seen: string[] = [];
    (window as unknown as { __animations: string[] }).__animations = seen;
    const name = (el: unknown) =>
      el instanceof Element
        ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${String(el.className && typeof el.className === 'string' ? el.className : '').trim().replace(/\s+/g, '.')}`
        : '';
    document.addEventListener('animationstart', (e) => seen.push(`${e.animationName} on ${name(e.target)}`), true);
    document.addEventListener('transitionstart', (e) => {
      const entrance = e.propertyName === 'opacity' && e.target instanceof Element && e.target.matches(entrances);
      seen.push(`${entrance ? 'entrance' : e.propertyName} on ${name(e.target)}`);
    }, true);
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args: Parameters<Element['animate']>) {
      seen.push(`script on ${name(this)}`);
      return animate.apply(this, args);
    };
  }, ENTRANCES);
}

/** Everything recorded since the last look. */
async function recorded(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __animations: string[] }).__animations.splice(0));
}

/** What else played, leaving out loading indicators, which loop while something loads. */
function others(all: string[]): string[] {
  return all.filter((a) => !/^(spin|skeleton-pulse|cm-blink|entrance) /.test(a));
}

/** The entrances among `all`. */
function entrances(all: string[]): string[] {
  return all.filter((a) => a.startsWith('entrance '));
}

async function settled(page: Page) {
  await expect(page.locator('html')).not.toHaveClass(/is-booting/);
  await expect(page.locator('.spin, .page-state')).toHaveCount(0);
}

test('motion: favourites and done items play nothing on load or on the way to them', async ({ page }) => {
  await recordAnimations(page);
  await open(page, '/');
  await settled(page);
  const row = page.locator('.item-row').filter({ has: page.getByRole('link', { name: 'Two Sum', exact: true }) });
  await expect(row.locator('.fav-btn')).toHaveAttribute('aria-pressed', 'true');
  await expect(row.locator('.status-done')).toBeVisible();
  // A quiet moment, for anything late to start.
  await page.waitForTimeout(300);
  // The app fades in once, whole; nothing in it moves on its own.
  let all = await recorded(page);
  expect(entrances(all)).toEqual(['entrance on div#root.']);
  expect(others(all)).toEqual([]);

  // Into the item and back: the same data, met again, stays still too. Only
  // each screen fades in as it opens.
  await row.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Two Sum' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Favorite', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await settled(page);
  await page.getByRole('link', { name: 'Back to the library' }).click();
  await expect(row).toBeVisible();
  await settled(page);
  await page.waitForTimeout(300);
  all = await recorded(page);
  expect(entrances(all).sort()).toEqual(['entrance on div.page.page-wide.library', 'entrance on div.workspace-body', 'entrance on header.itembar']);
  expect(others(all)).toEqual([]);
});

test('motion: a screen fades in when it opens, not when its view changes', async ({ page }) => {
  await recordAnimations(page);
  await open(page, '/');
  await settled(page);
  await page.waitForTimeout(300);
  await recorded(page);
  // Another collection, a filter, a search: the same screen, so no entrance.
  await page.locator('.nav-tree-link').first().click();
  await expect(page.locator('.item-list')).toBeVisible();
  await page.locator('.nav-tree-link').nth(1).click();
  await page.getByRole('link', { name: /^Problems/ }).first().click();
  await page.getByPlaceholder(/^Filter /).first().fill('sum');
  await expect(page.locator('.item-row')).not.toHaveCount(0);
  await page.waitForTimeout(400);
  expect(entrances(await recorded(page))).toEqual([]);

  // Between a problem's tabs only the content below its bar fades in.
  await page.getByPlaceholder(/^Filter /).first().fill('');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await expect(page.locator('.workspace-body')).toBeVisible();
  await page.waitForTimeout(300);
  await recorded(page);
  await page.locator('.itembar-tabs').getByRole('link', { name: /Test cases/ }).click();
  await expect(page.locator('.workspace-scroll')).toBeVisible();
  await page.waitForTimeout(300);
  expect(entrances(await recorded(page))).toEqual(['entrance on div.workspace-scroll']);
});

test('motion: a change made on screen does animate', async ({ page }) => {
  await open(page, '/');
  await settled(page);
  const row = page.locator('.item-row').filter({ has: page.getByRole('link', { name: 'Two Sum', exact: true }) });
  await row.locator('.fav-btn').click();
  await expect(row.locator('.fav-btn')).toHaveAttribute('aria-pressed', 'false');
  await expect(row.locator('.fav-btn .icon-swap-icon')).toHaveClass(/is-in/);
  // Controls stay usable while it plays.
  await row.locator('.fav-btn').click();
  await expect(row.locator('.fav-btn')).toHaveAttribute('aria-pressed', 'true');
});

test('motion: an invalid field shakes after a failed save, and can shake again', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Two Sum' })).toBeVisible();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit details…' }).click();
  const title = page.getByLabel('Title');
  await title.fill('');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(title).toBeFocused();
  await expect(title).toHaveClass(/is-shaking/);
  await expect(title).toHaveAttribute('aria-invalid', 'true');
  // The shake ends; the error styling stays.
  await expect(title).not.toHaveClass(/is-shaking/);
  await expect(title).toHaveAttribute('aria-invalid', 'true');
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('a toast and the copy label land at once', async ({ page }) => {
    await open(page, '/');
    await settled(page);
    await page.locator('.item-row .item-check input').first().click();
    await page.locator('.bulkbar').getByRole('button', { name: /favorite/i }).click();
    const toast = page.locator('.toast');
    await expect(toast).toBeVisible();
    expect(await toast.evaluate((el) => [getComputedStyle(el).opacity, getComputedStyle(el).transform, getComputedStyle(el).filter])).toEqual(['1', 'none', 'none']);

    await page.goto('/settings/mcp');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const copy = page.locator('.copy-btn').first();
    await copy.click();
    await expect(copy).toHaveAccessibleName('Copied');
    expect(await copy.locator('.morph-swap, .icon-swap-out').count()).toBe(0);
  });

  test('the notes panel opens and closes at once', async ({ page }) => {
    await open(page, '/?type=reading');
    await page.getByRole('link', { name: 'Untrusted Markdown: What a Renderer Must Not Do' }).click();
    const notesButton = page.getByRole('button', { name: 'Notes', exact: true });
    if ((await notesButton.getAttribute('aria-pressed')) === 'true') await notesButton.click();
    await expect(page.locator('.reader-notes')).toHaveCount(0);

    await notesButton.click();
    const panel = page.getByRole('complementary', { name: 'Private notes' });
    await expect(panel).toBeVisible();
    expect(await panel.evaluate((el) => [getComputedStyle(el).opacity, getComputedStyle(el).transform])).toEqual(['1', 'none']);
    expect(await page.locator('.reader-article').evaluate((el) => el.getAnimations().length)).toBe(0);

    await page.getByRole('button', { name: 'Close notes' }).click();
    expect(await page.locator('.reader-notes').count()).toBe(0);
  });

  test('an accepted verdict is shown at once', async ({ page }) => {
    await open(page, '/');
    await page.getByRole('link', { name: 'Longest Substring Without Repeating Characters' }).click();
    await page.getByRole('textbox', { name: /solution code/i }).click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText('import sys\n\nprint(len(sys.stdin.readline()))\n');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const head = page.locator('.result-head.is-fresh');
    await expect(head).toContainText('Accepted');
    const check = head.locator('.result-check');
    expect(await check.evaluate((el) => [getComputedStyle(el).opacity, getComputedStyle(el).filter, getComputedStyle(el.querySelector('path')!).strokeDashoffset])).toEqual([
      '1',
      'none',
      '0px',
    ]);
    expect(await head.locator('.result-verdict').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  });
});
