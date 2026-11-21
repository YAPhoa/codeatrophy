import { expect, test, type Page } from '@playwright/test';
import { open, TWO_SUM_TEXT, writeCode } from './support';

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
  await recordAnimations(page);
  await open(page, '/');
  await settled(page);
  await recorded(page);
  const row = page.locator('.item-row').filter({ has: page.getByRole('link', { name: 'Two Sum', exact: true }) });
  await row.locator('.fav-btn').click();
  await expect(row.locator('.fav-btn')).toHaveAttribute('aria-pressed', 'false');
  // The star swaps its icon. A start can be reported a frame after the click.
  const played: string[] = [];
  await expect.poll(async () => (played.push(...(await recorded(page))), played)).toEqual(expect.arrayContaining(['fade-in on span.icon-swap-icon.is-in', 'fade-out on span.icon-swap-out']));
  // Controls stay usable while it plays.
  await row.locator('.fav-btn').click();
  await expect(row.locator('.fav-btn')).toHaveAttribute('aria-pressed', 'true');
});

test('motion: a toast rises in, makes room in the stack, and plays its exit', async ({ page }) => {
  await recordAnimations(page);
  await open(page, '/');
  await settled(page);
  await recorded(page);
  await page.locator('.item-row .item-check input').first().click();
  await page.locator('.bulkbar').getByRole('button', { name: /favorite/i }).click();
  const toast = page.locator('.toast');
  await expect(toast).toBeVisible();
  // It arrives by its entrance, and its row opens for it. A start can be reported a frame after the toast shows.
  const arriving: string[] = [];
  await expect.poll(async () => (arriving.push(...(await recorded(page))), arriving)).toEqual(expect.arrayContaining(['toast-in on div.toast.toast-success', 'toast-make-room on div.toast-slot']));

  // Dismissed, it stays for its exit and is out of reach meanwhile.
  await toast.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.locator('.toast-slot.is-leaving')).toHaveAttribute('inert', '');
  await expect(toast).toHaveCount(0);
  const leaving = await recorded(page);
  expect(leaving).toContain('toast-out on div.toast.toast-success');
  expect(leaving).toContain('toast-collapse on div.toast-slot.is-leaving');
});

/** Opens the details of Two Sum, where the "i" of the output comparison is. */
async function openDetails(page: Page) {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Two Sum' })).toBeVisible();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit details…' }).click();
  await expect(page.getByRole('button', { name: 'About output comparison' })).toBeVisible();
}

test('motion: a tooltip waits a moment, grows in from close by, and goes almost at once', async ({ page }) => {
  await openDetails(page);
  // Read within a frame of focusing the "i", well inside the wait.
  const entrance = await page.evaluate(async () => {
    document.querySelector<HTMLElement>('[aria-label="About output comparison"]')!.focus();
    await new Promise(requestAnimationFrame);
    const tip = document.querySelector<HTMLElement>('[role="tooltip"]')!;
    const animation = tip.getAnimations()[0] as CSSAnimation;
    const { delay, duration } = animation.effect!.getTiming();
    animation.pause();
    const style = getComputedStyle(tip);
    return { name: animation.animationName, delay, duration, opacity: style.opacity, transform: style.transform };
  });
  // --duration-micro of waiting, out of sight, then --duration-quick from --scale-tooltip.
  expect(entrance).toEqual({ name: 'tooltip-in', delay: 80, duration: 150, opacity: '0', transform: 'matrix(0.98, 0, 0, 0.98, 0, 0)' });
  // It describes the "i" from the start: only the showing waits.
  const tip = page.getByRole('button', { name: 'About output comparison' });
  await expect(tip).toHaveAccessibleDescription(/Values only/);

  await page.evaluate(() => document.querySelector<HTMLElement>('[role="tooltip"]')!.getAnimations()[0]!.finish());
  const exit = await page.evaluate(async () => {
    document.querySelector<HTMLElement>('[aria-label="About output comparison"]')!.blur();
    await new Promise(requestAnimationFrame);
    const ghost = document.querySelector('.info-tip-text.is-closing');
    return ghost && getComputedStyle(ghost).animationName + ' ' + getComputedStyle(ghost).animationDuration;
  });
  expect(exit).toBe('tooltip-out 0.05s');
  await expect(page.locator('.info-tip-text')).toHaveCount(0);

  // Passed over and left within the wait, it never shows, not even to fade.
  const flashed = await page.evaluate(async () => {
    const i = document.querySelector<HTMLElement>('[aria-label="About output comparison"]')!;
    i.focus();
    await new Promise(requestAnimationFrame);
    i.blur();
    await new Promise(requestAnimationFrame);
    return document.querySelectorAll('.info-tip-text').length;
  });
  expect(flashed).toBe(0);
});

test('motion: a row opens and closes at the same pace', async ({ page }) => {
  await open(page, '/');
  await settled(page);
  const pace = (state: string) =>
    page.evaluate(async (state) => {
      document.querySelector<HTMLElement>('li.item-row .item-expand button')!.click();
      await new Promise(requestAnimationFrame);
      const collapse = document.querySelector(`li.item-row .collapse.${state}`);
      return collapse && getComputedStyle(collapse).animationDuration;
    }, state);
  // --duration-fast both ways.
  expect(await pace('is-entering')).toBe('0.25s');
  await expect(page.locator('li.item-row .collapse')).not.toHaveClass(/is-moving/);
  expect(await pace('is-closing')).toBe('0.25s');
  await expect(page.locator('li.item-row .collapse')).toHaveCount(0);
});

test('motion: a status line swaps its icon and morphs its words rather than cutting', async ({ page }) => {
  await recordAnimations(page);
  await open(page, '/settings/preferences');
  await settled(page);
  await recorded(page);
  await page.getByRole('checkbox', { name: 'Generate large test cases by default' }).click();
  const status = page.locator('.prefs-status').getByRole('status');
  await expect(status).toHaveText('Saved');
  // From nothing to "Saving…", then to "Saved": each change swaps the icon and morphs the words.
  await expect.poll(async () => (await page.locator('.prefs-status .morph-swap, .prefs-status .icon-swap-out').count()) === 0).toBe(true);
  const played = await recorded(page);
  expect(played).toContain('icon-swap-in on span.icon-swap-icon.is-in');
  expect(played).toContain('script on span.morph-swap');
  // What is drawn is for sight; the live region holds the words alone.
  await expect(page.locator('.prefs-status .status-swap')).toHaveAttribute('aria-hidden', 'true');
});

test('motion: a closing dialog plays its exit out of reach, then goes', async ({ page }) => {
  await open(page, '/');
  const opener = page.getByRole('button', { name: 'New collection' });
  await opener.click();
  await expect(page.getByRole('dialog', { name: 'New collection' })).toBeVisible();
  await page.keyboard.press('Escape');
  // Still on screen for its exit, but inert, hidden from assistive technology, and focus is already back.
  const closing = await page.evaluate(() => {
    const backdrop = document.querySelector('.dialog-backdrop');
    return backdrop && { closing: backdrop.classList.contains('is-closing'), inert: backdrop.hasAttribute('inert'), hidden: backdrop.getAttribute('aria-hidden') };
  });
  expect(closing).toEqual({ closing: true, inert: true, hidden: 'true' });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
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

    await open(page, '/settings/mcp');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const copy = page.locator('.copy-btn').first();
    await copy.click();
    await expect(copy).toHaveAccessibleName('Copied');
    expect(await copy.locator('.morph-swap, .icon-swap-out').count()).toBe(0);
  });

  test('the notes panel opens and closes at once', async ({ page }) => {
    await open(page, '/readings');
    await page.getByRole('link', { name: 'Untrusted Markdown: What a Renderer Must Not Do' }).click();
    const notesButton = page.getByRole('button', { name: 'Notes', exact: true });
    // The seed's reading has no notes, so the panel starts closed.
    await expect(notesButton).toHaveAttribute('aria-pressed', 'false');
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
    await writeCode(page, 'import sys\n\nprint(len(sys.stdin.readline()))\n');
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

  test('the mark of a generation in progress is a still frame', async ({ page }) => {
    // Normal mock delays, so the generating panel stays up long enough to look at.
    await open(page, '/new', 'default');
    await page.getByLabel('What you have').fill(TWO_SUM_TEXT);
    await page.getByRole('button', { name: 'Draft with AI' }).click();
    const rows = page.locator('.generating-row');
    await expect(rows).toHaveCount(5);
    for (const row of await rows.all()) await expect(row).toHaveCSS('animation-name', 'none');
    await expect(rows.nth(1)).toHaveCSS('opacity', '0');
    await expect(page.locator('.generating-token').first()).toHaveCSS('animation-name', 'none');
    const caret = page.locator('.generating-caret');
    await expect(caret).toHaveCSS('animation-name', 'none');
    await expect(caret).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 28, 23)');
  });

  test('dialogs and menus close at once', async ({ page }) => {
    await open(page, '/');
    await page.getByRole('button', { name: 'New collection' }).click();
    await expect(page.getByRole('dialog', { name: 'New collection' })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await page.locator('.dialog-backdrop').count()).toBe(0);

    await page.getByRole('link', { name: 'Longest Substring Without Repeating Characters' }).click();
    await page.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await page.locator('.popover').count()).toBe(0);
  });

  test('the reader jumps to a heading instead of scrolling smoothly', async ({ page }) => {
    await open(page, '/');
    await page.getByRole('link', { name: 'Consistent Hashing' }).click();
    await expect(page.getByRole('region', { name: 'Reading', exact: true })).toHaveCSS('scroll-behavior', 'auto');
  });
});
