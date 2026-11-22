import { expect, test, type Locator, type Page } from '@playwright/test';
import { open, recordMatches, reduceMotion, TWO_SUM_TEXT, writeCode } from './support';

// Motion plays on a change made on screen, never on arriving at data that
// was already so; with motion reduced every change lands at once.

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

  // Opening a problem fades it in; between its tabs the content swaps at once.
  await page.getByPlaceholder(/^Filter /).first().fill('');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await expect(page.locator('.workspace-body')).toBeVisible();
  await page.waitForTimeout(300);
  expect(entrances(await recorded(page))).toContain('entrance on header.itembar');
  await page.locator('.itembar-tabs').getByRole('link', { name: /Test cases/ }).click();
  await expect(page.locator('.workspace-scroll')).toBeVisible();
  await page.locator('.itembar-tabs').getByRole('link', { name: /Solutions/ }).click();
  await expect(page.locator('.itembar-tabs .tab.is-selected')).toContainText('Solutions');
  await page.waitForTimeout(300);
  expect(entrances(await recorded(page))).toEqual([]);
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

  // Dismissed, it stays for its exit and is out of reach meanwhile. The
  // exit is timed in script, so whether it is inert is read in the page as it starts.
  const leavingSlots = await recordMatches(page, '.toast-slot.is-leaving', (el) => el.getAttribute('inert'));
  await toast.getByRole('button', { name: 'Dismiss' }).click();
  await expect(toast).toHaveCount(0);
  expect(await leavingSlots()).toEqual(['']);
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
  // Still on screen for its exit, but inert, hidden from assistive technology, and focus is already back.
  // Its exit lasts --duration-quick and can be over before a look from here:
  // the backdrop is recorded from the page as it is put back for it.
  const backdrops = await recordMatches(page, '.dialog-backdrop', (el) => ({ closing: el.classList.contains('is-closing'), inert: el.hasAttribute('inert'), hidden: el.getAttribute('aria-hidden') }));
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect(await backdrops()).toEqual([{ closing: true, inert: true, hidden: 'true' }]);
});

test.describe('the Reduce motion setting', () => {
  const html = (page: Page) => page.locator('html');
  const setting = (page: Page) => page.getByRole('radiogroup', { name: 'Reduce motion' });
  const option = (page: Page, name: 'On' | 'Off') => setting(page).getByRole('radio', { name, exact: true });
  const stored = (page: Page) => page.evaluate(() => localStorage.getItem('codeatrophy:motion'));
  /** How a menu opens: it fades in either way, and scales only while motion is not reduced. */
  const menuEntrance = async (page: Page) => {
    await page.getByRole('button', { name: /^Theme: / }).click();
    const menu = page.locator('.popover[role="menu"]');
    const seen = await menu.evaluate((el) => {
      const a = el.getAnimations()[0] as CSSAnimation;
      const from = (a.effect as KeyframeEffect).getKeyframes()[0]!;
      a.pause();
      a.currentTime = 0;
      const cs = getComputedStyle(el);
      return { name: a.animationName, duration: cs.animationDuration, opacity: from.opacity, transform: cs.transform };
    });
    await page.keyboard.press('Escape');
    return seen;
  };
  const scaled = { name: 'popover-in', duration: '0.25s', opacity: '0', transform: 'matrix(0.97, 0, 0, 0.97, 0, 0)' };
  const faded = { name: 'popover-in', duration: '0.25s', opacity: '0', transform: 'matrix(1, 0, 0, 1, 0, 0)' };

  test.describe('when the OS asks for reduced motion', () => {
    test.use({ reducedMotion: 'reduce' });

    test('with nothing chosen it is on; Off overrides it, and is kept across a reload', async ({ page }) => {
      await open(page, '/settings/preferences');
      await expect(option(page, 'On')).toBeChecked();
      await expect(html(page)).toHaveAttribute('data-motion', 'reduce');
      expect(await stored(page)).toBeNull();
      expect(await menuEntrance(page)).toEqual(faded);

      await setting(page).getByText('Off', { exact: true }).click();
      await expect(option(page, 'Off')).toBeChecked();
      await expect(html(page)).not.toHaveAttribute('data-motion');
      expect(await stored(page)).toBe('full');
      expect(await menuEntrance(page)).toEqual(scaled);

      await page.reload();
      await expect(option(page, 'Off')).toBeChecked();
      await expect(html(page)).not.toHaveAttribute('data-motion');
    });
  });

  test.describe('when the OS does not', () => {
    test.use({ reducedMotion: 'no-preference' });

    test('with nothing chosen it is off; On overrides it, and is kept across a reload', async ({ page }) => {
      await open(page, '/settings/preferences');
      await expect(option(page, 'Off')).toBeChecked();
      await expect(html(page)).not.toHaveAttribute('data-motion');
      expect(await menuEntrance(page)).toEqual(scaled);

      await setting(page).getByText('On', { exact: true }).click();
      await expect(option(page, 'On')).toBeChecked();
      await expect(html(page)).toHaveAttribute('data-motion', 'reduce');
      expect(await stored(page)).toBe('reduce');
      expect(await menuEntrance(page)).toEqual(faded);

      await page.reload();
      await expect(option(page, 'On')).toBeChecked();
      await expect(html(page)).toHaveAttribute('data-motion', 'reduce');
    });

    test('with nothing chosen it follows the OS as it changes; once chosen, it does not', async ({ page }) => {
      await open(page, '/settings/preferences');
      await expect(html(page)).not.toHaveAttribute('data-motion');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(html(page)).toHaveAttribute('data-motion', 'reduce');
      await expect(option(page, 'On')).toBeChecked();
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await expect(html(page)).not.toHaveAttribute('data-motion');
      await expect(option(page, 'Off')).toBeChecked();

      // On chosen while the OS asks for nothing; the OS changing back and forth leaves it be.
      await setting(page).getByText('On', { exact: true }).click();
      await expect(html(page)).toHaveAttribute('data-motion', 'reduce');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await expect(option(page, 'On')).toBeChecked();
      await expect(html(page)).toHaveAttribute('data-motion', 'reduce');
    });
  });
});

/** Play every animation and transition at a tenth of its speed, so one can be caught partway. */
async function slowMotion(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.1 });
}

/**
 * The element's animations as they start: each one's name (or the property a
 * transition moves) and duration, and the element's opacity and movement at
 * their first frame. It runs in the page.
 */
function firstFrame(el: Element) {
  const all = el.getAnimations();
  for (const a of all) {
    a.pause();
    a.currentTime = 0;
  }
  const cs = getComputedStyle(el);
  const seen = {
    animations: all.map((a) => `${(a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty} ${Number(a.effect!.getTiming().duration)}`),
    opacity: cs.opacity,
    // Anything moved off its place: a transform that is not the identity.
    moved: [cs.transform, cs.translate, cs.scale, cs.rotate].filter((v) => !['none', '0deg', '0px', '0px 0px', '1', 'matrix(1, 0, 0, 1, 0, 0)'].includes(v)),
  };
  for (const a of all) a.play();
  return seen;
}

/** `firstFrame` of what `target` finds. */
const atStart = (target: Locator) => target.evaluate(firstFrame);

test.describe('with motion reduced', () => {
  // Nothing moves; fades keep their durations.
  test.beforeEach(async ({ page }) => reduceMotion(page));

  test('a toast fades in without rising, and the copy label cross-fades without its width easing', async ({ page }) => {
    await open(page, '/');
    await settled(page);
    await slowMotion(page);
    await page.locator('.item-row .item-check input').first().click();
    await page.locator('.bulkbar').getByRole('button', { name: /favorite/i }).click();
    const toast = page.locator('.toast').first();
    await expect(toast).toBeVisible();
    expect(await atStart(toast)).toEqual({ animations: ['toast-in 350'], opacity: '0', moved: [] });
    // Its row takes its height at once.
    expect(await page.locator('.toast-slot').first().evaluate((el) => el.getAnimations().length)).toBe(0);

    await open(page, '/settings/mcp');
    await slowMotion(page);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const copy = page.locator('.copy-btn').first();
    // The label's swap and the leaving icon go on timers, the first after
    // --duration-quick: what each plays is read in the page as it comes.
    const swaps = await recordMatches(page, '.copy-btn .morph-swap', (el) => ({ width: el.getAnimations().length, fades: [...el.children].map((c) => c.getAnimations().length) }));
    const iconsOut = await recordMatches(page, '.copy-btn .icon-swap-out', firstFrame);
    await copy.click();
    await expect(copy).toHaveAccessibleName('Copied');
    // The first of each is Copy turning into Copied, which turns back later.
    expect((await swaps())[0]).toEqual({ width: 0, fades: [1, 1] });
    // The icon cross-fades as well, without growing or shrinking.
    expect(await atStart(copy.locator('.icon-swap-icon.is-in'))).toMatchObject({ opacity: '0', moved: [] });
    expect((await iconsOut())[0]?.moved).toEqual([]);
  });

  test('the notes panel fades in and out, and the text column does not move aside', async ({ page }) => {
    await open(page, '/readings');
    await page.getByRole('link', { name: 'Untrusted Markdown: What a Renderer Must Not Do' }).click();
    const notesButton = page.getByRole('button', { name: 'Notes', exact: true });
    // The seed's reading has no notes, so the panel starts closed.
    await expect(notesButton).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.reader-notes')).toHaveCount(0);

    await slowMotion(page);
    await notesButton.click();
    const panel = page.getByRole('complementary', { name: 'Private notes' });
    await expect(panel).toBeVisible();
    expect(await atStart(panel)).toEqual({ animations: ['notes-in 400'], opacity: '0', moved: [] });
    expect(await page.locator('.reader-article').evaluate((el) => el.getAnimations().length)).toBe(0);

    // Closing, it stays for its fade, then goes. It goes on a timer, which
    // slowMotion does not slow, and can be gone before a poll looks: the
    // panel is recorded from the page instead as it starts closing.
    const closing = await recordMatches(page, '.reader-notes.is-closing');
    await page.getByRole('button', { name: 'Close notes' }).click();
    await expect(page.locator('.reader-notes')).toHaveCount(0);
    expect(await closing()).toEqual(['reader-notes is-closing']);
  });

  test('an accepted verdict fades in, without turning, settling or drawing', async ({ page }) => {
    await open(page, '/');
    await page.getByRole('link', { name: 'Longest Substring Without Repeating Characters' }).click();
    await writeCode(page, 'import sys\n\nprint(len(sys.stdin.readline()))\n');
    await slowMotion(page);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const head = page.locator('.result-head.is-fresh');
    await expect(head).toContainText('Accepted');
    const check = head.locator('.result-check');
    expect(await atStart(check)).toEqual({ animations: ['check-in 500', 'check-settle 500'], opacity: '0', moved: [] });
    expect(await check.locator('path').evaluate((el) => parseFloat(getComputedStyle(el).strokeDashoffset))).toBe(0);
    expect(await atStart(head.locator('.result-verdict'))).toEqual({ animations: ['result-in 350'], opacity: '0', moved: [] });
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

  test('dialogs and menus fade in and out without scaling', async ({ page }) => {
    await open(page, '/');
    await slowMotion(page);
    await page.getByRole('button', { name: 'New collection' }).click();
    const dialog = page.getByRole('dialog', { name: 'New collection' });
    await expect(dialog).toBeVisible();
    expect((await atStart(dialog)).moved).toEqual([]);
    expect(await atStart(page.locator('.dialog-backdrop'))).toMatchObject({ opacity: '0', moved: [] });
    const finishAll = () => page.evaluate(() => document.getAnimations().forEach((a) => a.finish()));
    await finishAll();
    // Still there for its exit, then gone. The exit lasts --duration-quick
    // on a timer, so the copy left for it is recorded in the page.
    const backdrops = await recordMatches(page, '.dialog-backdrop.is-closing');
    await page.keyboard.press('Escape');
    await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
    expect(await backdrops()).toHaveLength(1);

    await page.getByRole('link', { name: 'Longest Substring Without Repeating Characters' }).click();
    await page.getByRole('button', { name: 'More actions' }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    expect(await atStart(menu)).toEqual({ animations: ['popover-in 250'], opacity: '0', moved: [] });
    await finishAll();
    const popovers = await recordMatches(page, '.popover.is-closing');
    await page.keyboard.press('Escape');
    await expect(page.locator('.popover')).toHaveCount(0);
    expect(await popovers()).toHaveLength(1);
  });

  test('a sliding indicator moves at once', async ({ page }) => {
    await open(page, '/settings/preferences');
    await settled(page);
    await page.getByRole('radiogroup', { name: 'Reading text size' }).getByText('Large').click();
    await page.getByRole('radiogroup', { name: 'Reading text size' }).getByText('Default').click();
    expect(await page.evaluate(() => document.getAnimations().filter((a) => (a.effect as KeyframeEffect).pseudoElement).length)).toBe(0);
  });

  test('the reader jumps to a heading instead of scrolling smoothly', async ({ page }) => {
    await open(page, '/');
    await page.getByRole('link', { name: 'Consistent Hashing' }).click();
    await expect(page.getByRole('region', { name: 'Reading', exact: true })).toHaveCSS('scroll-behavior', 'auto');
  });
});
