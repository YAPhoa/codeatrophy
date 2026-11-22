import { expect, test, type Page } from '@playwright/test';
import { open, reduceMotion } from './support';

// The navigation rail names each icon beside it, on hover and on keyboard
// focus, with one label that travels between them and no native tooltip. On an item page, the
// sidebar lights the view Back leads to, without calling it the current page.
// Minimising or expanding the navigation slides its edge, on a toggle only.

const rail = (page: Page) => page.locator('aside.sidebar.is-rail');
/** The rail's label, while it shows. */
const tip = (page: Page) => page.locator('.rail-tip[data-show="true"]');

/** A problem's workspace, opened from `view`, with the navigation as a rail. */
async function openProblemFrom(page: Page, view: string, title = 'Two Sum') {
  await open(page, view);
  await page.getByRole('link', { name: title, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(rail(page)).toBeVisible();
}

test('rail: each control is named beside it, on hover and on keyboard focus, with no title', async ({ page }) => {
  await openProblemFrom(page, '/');
  await expect(rail(page).locator('[title]')).toHaveCount(0);

  const newItem = rail(page).getByRole('link', { name: 'New item', exact: true });
  await newItem.hover();
  await expect(tip(page)).toHaveText('New item (C)');
  // To the right of the control, on the popover layer, and not announced twice.
  const [box, control] = await Promise.all([tip(page).boundingBox(), newItem.boundingBox()]);
  expect(box!.x).toBeGreaterThan(control!.x + control!.width);
  await expect(tip(page)).toHaveAttribute('aria-hidden', 'true');
  await expect(tip(page)).not.toHaveAttribute('tabindex');

  // Moving to the next control takes the one label there, and leaving puts it away.
  await rail(page).getByRole('button', { name: 'Search and commands' }).hover();
  await expect(page.locator('.rail-tip')).toHaveCount(1);
  await expect(tip(page)).toHaveText(/^Search and commands \((Ctrl|⌘)\+K\)$/);
  await rail(page).getByRole('link', { name: 'Favorites', exact: true }).hover();
  await expect(tip(page)).toHaveText('Favorites');
  await page.mouse.move(600, 400);
  await expect(tip(page)).toHaveCount(0);

  // Keyboard focus shows it too; Escape and leaving put it away, and focus stays put.
  const expand = rail(page).getByRole('button', { name: /^Expand navigation/ });
  await newItem.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(expand).toBeFocused();
  await expect(tip(page)).toHaveText(/^Expand navigation \((Ctrl|⌘)\+B\)$/);
  await page.keyboard.press('Escape');
  await expect(tip(page)).toHaveCount(0);
  await expect(expand).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(tip(page)).toHaveText('New item (C)');
  await page.keyboard.press('Tab');
  await expect(tip(page)).toHaveText(/^Search and commands/);

  // A control's own menu hides its label while open.
  const theme = rail(page).getByRole('button', { name: /^Theme: / });
  await theme.hover();
  await expect(tip(page)).toHaveText(/^Theme: /);
  await theme.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(tip(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);

  // The full sidebar has its words, and no labels.
  await expand.click();
  await expect(rail(page)).toHaveCount(0);
  await page.getByRole('link', { name: /^Favorites/ }).hover();
  await expect(tip(page)).toHaveCount(0);
});

test('rail: on an item page, the view Back leads to is lit, but not the current page', async ({ page }) => {
  await openProblemFrom(page, '/favorites');
  const favorites = rail(page).getByRole('link', { name: 'Favorites', exact: true });
  await expect(favorites).toHaveClass(/\bis-active\b/);
  await expect(favorites).not.toHaveAttribute('aria-current');
  await expect(rail(page).getByRole('link', { name: 'Problems', exact: true })).not.toHaveClass(/\bis-active\b/);
  await expect(rail(page).locator('.rail-nav .is-active')).toHaveCount(1);
  await expect(rail(page).locator('[aria-current]')).toHaveCount(0);
  // Back goes there, and it is the current page again.
  await page.getByRole('link', { name: 'Back to the library' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Favorites/);
  await expect(page.getByRole('complementary', { name: 'Navigation' }).locator('[aria-current="page"]')).toHaveText(/^Favorites/);
});

test('sidebar: a reading opened from a collection lights that collection', async ({ page }) => {
  await open(page, '/');
  const nav = page.getByRole('complementary', { name: 'Navigation' });
  await nav.getByRole('link', { name: /^Weekly practice/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Weekly practice/);
  await page.getByRole('link', { name: 'Write-Ahead Logging and fsync', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Write-Ahead Logging and fsync' })).toBeVisible();

  const lit = nav.locator('.nav-item.is-active');
  await expect(lit).toHaveCount(1);
  await expect(lit).toContainText('Weekly practice');
  await expect(nav.locator('[aria-current]')).toHaveCount(0);
});

/** Record the property of each transition that starts on the rail's label from now on. */
async function recordTipTransitions(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __tip: string[] }).__tip = seen;
    document.addEventListener('transitionrun', (e) => void ((e.target as Element).matches?.('.rail-tip') && seen.push(e.propertyName)), true);
  });
}

const tipTransitions = (page: Page) => page.evaluate(() => [...new Set((window as unknown as { __tip: string[] }).__tip.splice(0))].sort());
const tipStyle = (page: Page) =>
  page.locator('.rail-tip').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { property: cs.transitionProperty, duration: cs.transitionDuration, delay: cs.transitionDelay };
  });

test('rail: the first label waits, then fades and scales in; moving on, the one label travels; it goes in a short fade', async ({ page }) => {
  await recordTipTransitions(page);
  await openProblemFrom(page, '/');
  await page.mouse.move(600, 400);
  await tipTransitions(page);

  // The first waits 80ms, then fades and scales in over 150ms.
  await rail(page).getByRole('link', { name: 'New item', exact: true }).hover();
  await expect(tip(page)).toHaveText('New item (C)');
  expect(await tipStyle(page)).toEqual({
    property: 'opacity, scale, visibility, translate, width',
    duration: '0.15s, 0.15s, 0s, 0.15s, 0.15s',
    delay: '0.08s, 0.08s, 0s, 0s, 0s',
  });
  await expect(tip(page)).toHaveCSS('opacity', '1');
  await expect(tip(page)).toHaveCSS('scale', '1');
  expect(await tipTransitions(page)).toEqual(['opacity', 'scale']);
  const from = (await tip(page).boundingBox())!;

  // To the next control, the one label travels: down to it, to the width of
  // its text, with no wait, and nothing fades.
  await rail(page).getByRole('link', { name: 'Favorites', exact: true }).hover();
  await expect(tip(page)).toHaveText('Favorites');
  await expect(tip(page)).toHaveAttribute('data-travel', '');
  expect(await tipTransitions(page)).toEqual(['translate', 'width']);
  await expect(page.locator('.rail-tip')).toHaveCount(1);
  await expect.poll(async () => (await tip(page).boundingBox())!.y).toBeGreaterThan(from.y + 100);
  await expect.poll(async () => (await tip(page).boundingBox())!.width).toBeLessThan(from.width);

  // Leaving, it fades out over 50ms with no wait, then is hidden outright.
  await page.mouse.move(600, 400);
  await expect(tip(page)).toHaveCount(0);
  expect(await tipStyle(page)).toEqual({
    property: 'opacity, scale, visibility, translate, width',
    duration: '0.05s, 0.05s, 0s, 0.15s, 0.15s',
    delay: '0s, 0s, 0.05s, 0s, 0s',
  });
  await expect(page.locator('.rail-tip')).toHaveCSS('visibility', 'hidden');
  expect(await tipTransitions(page)).toEqual(['opacity', 'scale', 'visibility']);
  // It blocks nothing, even while it fades: a click where it was reaches the page.
  await expect(page.locator('.rail-tip')).toHaveCSS('pointer-events', 'none');

  // Back after a moment, nothing was showing: it is put there at once and waits again.
  await page.waitForTimeout(200);
  await rail(page).getByRole('link', { name: 'Tags', exact: true }).hover();
  await expect(tip(page)).toHaveText('Tags');
  await expect(tip(page)).not.toHaveAttribute('data-travel');
  expect((await tipStyle(page)).delay).toBe('0.08s, 0.08s, 0s, 0s, 0s');
  await expect(tip(page)).toHaveCSS('opacity', '1');
  expect(await tipTransitions(page)).toEqual(['opacity', 'scale']);
});

type SlideWindow = Window & { __slides: string[]; __holdSlides: boolean };

/**
 * Record the class of the element each transition of the shell's columns
 * starts on from now on. With `__holdSlides` set, each is paused as it starts,
 * so it can be looked at partway however slow the test runs.
 */
async function recordSlides(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as SlideWindow;
    w.__slides = [];
    w.__holdSlides = false;
    document.addEventListener(
      'transitionrun',
      (e) => {
        if (e.propertyName !== 'grid-template-columns') return;
        w.__slides.push((e.target as Element).className);
        if (w.__holdSlides) for (const a of (e.target as Element).getAnimations()) if ((a as CSSTransition).transitionProperty === e.propertyName) a.pause();
      },
      true,
    );
  });
}

const slides = (page: Page) => page.evaluate(() => (window as unknown as SlideWindow).__slides.splice(0));

/** Make the next toggle with `toggle`, look at its slide partway with `look`, then let it finish. */
async function partway<T>(page: Page, toggle: () => Promise<void>, look: () => Promise<T>): Promise<T> {
  await page.evaluate(() => void ((window as unknown as SlideWindow).__holdSlides = true));
  await toggle();
  await page.waitForFunction(() => document.getAnimations().some((a) => (a as CSSTransition).transitionProperty === 'grid-template-columns' && a.playState === 'paused'));
  await page.evaluate(() => {
    for (const a of document.getAnimations()) if ((a as CSSTransition).transitionProperty === 'grid-template-columns') a.currentTime = 40;
  });
  const result = await look();
  await page.evaluate(() => {
    (window as unknown as SlideWindow).__holdSlides = false;
    for (const a of document.getAnimations()) if ((a as CSSTransition).transitionProperty === 'grid-template-columns') a.finish();
  });
  return result;
}

const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Navigation' });
const sidebarWidth = async (page: Page) => (await sidebar(page).boundingBox())!.width;

test('sidebar: minimising and expanding slide its edge, with the logo and icons still', async ({ page }) => {
  await recordSlides(page);
  await open(page, '/');
  await expect(page.locator('li.item-row').first()).toBeVisible();
  await page.waitForTimeout(300);
  // Nothing slides on load.
  expect(await slides(page)).toEqual([]);

  const logo = sidebar(page).getByRole('link', { name: /^Codeatrophy/ }).first();
  const icon = sidebar(page).getByRole('link', { name: /^Problems/ }).locator('svg');
  const xs = async () => [(await logo.boundingBox())!.x, (await icon.boundingBox())!.x];
  const expanded = await xs();

  const mid = await partway(
    page,
    () => page.getByRole('button', { name: /^Minimise navigation/ }).click(),
    async () => ({ width: await sidebarWidth(page), xs: await xs(), rail: await rail(page).count() }),
  );
  // The rail is drawn at once, at the left of the shrinking column.
  expect(mid.rail).toBe(1);
  expect(mid.width).toBeGreaterThan(48);
  expect(mid.width).toBeLessThan(252);
  expect(mid.xs).toEqual(expanded);
  await expect(page.locator('.shell')).not.toHaveClass(/\bis-sliding\b/);
  expect(await sidebarWidth(page)).toBe(48);
  expect(await xs()).toEqual(expanded);
  expect(await slides(page)).toEqual(['shell is-rail is-sliding']);

  // Ctrl+B expands it the same way; the full sidebar is uncovered, not squeezed.
  const opening = await partway(
    page,
    () => page.keyboard.press('ControlOrMeta+b'),
    async () => ({
      width: await sidebarWidth(page),
      xs: await xs(),
      nav: (await sidebar(page).locator('.sidebar-scroll').boundingBox())!.width,
    }),
  );
  expect(opening.width).toBeGreaterThan(48);
  expect(opening.width).toBeLessThan(252);
  expect(opening.xs).toEqual(expanded);
  expect(opening.nav).toBeGreaterThan(opening.width);
  await expect(page.locator('.shell')).not.toHaveClass(/\bis-sliding\b/);
  expect(await sidebarWidth(page)).toBe(252);
  expect(await slides(page)).toEqual(['shell is-sliding']);
});

test('sidebar: going between the library and a problem switches it at once', async ({ page }) => {
  await recordSlides(page);
  // The library has the full sidebar and a problem the rail, as each remembers.
  await openProblemFrom(page, '/');
  await page.getByRole('link', { name: 'Back to the library' }).click();
  await expect(rail(page)).toHaveCount(0);
  await page.getByRole('link', { name: 'LRU Cache', exact: true }).click();
  await expect(rail(page)).toBeVisible();
  await page.waitForTimeout(200);
  expect(await slides(page)).toEqual([]);
  await expect(page.locator('.shell')).not.toHaveClass(/\bis-sliding\b/);
});

test('sidebar: with motion reduced its width snaps, and what it now shows fades in', async ({ page }) => {
  await reduceMotion(page);
  await recordSlides(page);
  await open(page, '/');
  await expect(page.locator('li.item-row').first()).toBeVisible();
  // Every animation that starts on something in the sidebar, as `name duration`.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __navFades: string[] }).__navFades = seen;
    document.addEventListener(
      'animationstart',
      (e) => {
        const el = e.target as Element;
        if (el.closest('aside.sidebar')) seen.push(`${e.animationName} ${getComputedStyle(el).animationDuration}`);
      },
      true,
    );
  });
  const fades = () => page.evaluate(() => [...new Set((window as unknown as { __navFades: string[] }).__navFades.splice(0))]);

  await page.getByRole('button', { name: /^Minimise navigation/ }).click();
  await expect(rail(page)).toBeVisible();
  expect(await sidebarWidth(page)).toBe(48);
  await expect(page.locator('.shell')).not.toHaveClass(/\bis-sliding\b/);
  await expect(page.locator('.shell')).toHaveClass(/\bis-nav-fading\b/);
  await expect.poll(fades).toEqual(['fade-in 0.15s']);

  await page.keyboard.press('ControlOrMeta+b');
  await expect(rail(page)).toHaveCount(0);
  expect(await sidebarWidth(page)).toBe(252);
  await expect.poll(fades).toEqual(['fade-in 0.15s']);
  await expect(page.locator('.shell')).not.toHaveClass(/\bis-nav-fading\b/);
  expect(await slides(page)).toEqual([]);
});

test('rail: with motion reduced the label waits and fades, but does not scale or travel', async ({ page }) => {
  await reduceMotion(page);
  await recordTipTransitions(page);
  await openProblemFrom(page, '/');
  await page.mouse.move(600, 400);
  await tipTransitions(page);
  await rail(page).getByRole('link', { name: 'New item', exact: true }).hover();
  await expect(tip(page)).toHaveText('New item (C)');
  expect(await tipStyle(page)).toEqual({ property: 'opacity, visibility', duration: '0.15s, 0s', delay: '0.08s, 0s' });
  await expect(tip(page)).toHaveCSS('opacity', '1');
  await expect(tip(page)).toHaveCSS('scale', '1');
  expect(await tipTransitions(page)).toEqual(['opacity']);
  const from = (await tip(page).boundingBox())!;

  // To the next control it is put there at once, still showing.
  await rail(page).getByRole('link', { name: 'Favorites', exact: true }).hover();
  await expect(tip(page)).toHaveText('Favorites');
  expect((await tip(page).boundingBox())!.y).toBeGreaterThan(from.y + 100);
  await expect(tip(page)).toHaveCSS('opacity', '1');
  expect(await tipTransitions(page)).toEqual([]);

  // Leaving, it fades out over 50ms.
  await page.mouse.move(600, 400);
  await expect(tip(page)).toHaveCount(0);
  expect(await tipStyle(page)).toEqual({ property: 'opacity, visibility', duration: '0.05s, 0s', delay: '0s, 0.05s' });
  await expect(page.locator('.rail-tip')).toHaveCSS('visibility', 'hidden');
});
