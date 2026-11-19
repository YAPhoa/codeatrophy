import { expect, test, type Locator, type Page } from '@playwright/test';
import { open } from './support';

// A library row's line shows the title, as many tags as fit and the facts in
// columns, named in the list's head; it opens, from its chevron or a click
// anywhere but on a control, to show what the line leaves out: the whole
// summary, then every tag, a problem's test cases and the day it was
// created, each beside its label. The
// details stay under the title, clear of the facts' columns. While it is open
// the line leaves the tags to the details, so each shows once, and nothing
// else on the line moves.

const LONGEST = 'Longest Substring Without Repeating Characters';
const LONGEST_SUMMARY = 'Length of the longest run of characters with no repeats, in one pass with a sliding window.';
const LONGEST_TAGS = ['hash-map', 'sliding-window', 'string'];
/** Given more tags than any line has room for (openWithTags). */
const COIN = 'Coin Change';
const MANY_TAGS = ['bottom-up', 'classic', 'coins', 'dynamic-programming', 'greedy-fails', 'interview', 'memoization', 'minimum', 'top-down', 'unbounded-knapsack'];

/** The library row of the item titled `title`. */
const row = (page: Page, title: string) => page.locator('li.item-row').filter({ has: page.getByRole('link', { name: title, exact: true }) });

/** The details a row's chevron controls. */
async function detailsOf(page: Page, title: string) {
  const id = await row(page, title).locator('.item-expand button').getAttribute('aria-controls');
  return page.locator(`[id="${id}"]`);
}

/** Where everything on a row's line sits, but its tags: left, top (in the row), width and height of each part shown. */
const lineOf = (r: Locator) =>
  r.evaluate((li) => {
    const top = li.getBoundingClientRect().top;
    const parts = ['.item-check input', '.item-status button', '.type-icon', '.item-title', '.item-variant', '.item-verdict .badge', '.item-kind .badge', '.item-updated', '.item-star button', '.item-expand button'];
    return Object.fromEntries(
      parts.map((part) => {
        const box = li.querySelector(part)?.getBoundingClientRect();
        return [part, box && box.width > 0 ? [box.left, box.top - top, box.width, box.height] : null];
      }),
    );
  });

/** Open the library with `title` tagged `tags`, set through the mock before the list first loads. */
async function openWithTags(page: Page, title: string, tags: string[]) {
  await open(page, '/tags');
  await page.waitForFunction(() => '__codeatrophyMock' in window);
  await page.evaluate(
    async ([title, tags]) => {
      type Mock = { db: { items: Map<string, { id: string; title: string; revision: number }> }; fetch: (path: string, init?: RequestInit) => Promise<Response> };
      const mock = (window as unknown as { __codeatrophyMock: Mock }).__codeatrophyMock;
      const item = [...mock.db.items.values()].find((i) => i.title === title)!;
      const res = await mock.fetch(`/api/v1/items/${item.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tags, expectedRevision: item.revision }),
      });
      if (!res.ok) throw new Error(await res.text());
    },
    [title, tags] as const,
  );
  await page.getByRole('complementary', { name: 'Navigation' }).getByRole('link', { name: /^All items/ }).click();
  await expect(row(page, title)).toBeVisible();
}

/** The tags on a row's line: how many show, and how much of the strip is left over (it is right-aligned, so on the left). */
const lineTags = (r: Locator) =>
  r.locator('.item-tags').evaluate((el) => {
    const box = el.getBoundingClientRect();
    const chips = [...el.querySelectorAll('.chip')].map((c) => c.getBoundingClientRect());
    return {
      shown: el.querySelectorAll('.chip-tag').length,
      more: el.querySelector('.chip-more')?.textContent ?? null,
      inside: chips.every((c) => c.left >= box.left - 0.5 && c.right <= box.right + 0.5),
      free: chips.length > 0 ? chips[0]!.left - box.left : box.width,
      gap: parseFloat(getComputedStyle(el.querySelector('.tagchips')!).columnGap),
    };
  });

test('library details: the chevron opens a row on its summary, every tag and the facts, and closes it again', async ({ page }) => {
  await open(page, '/');
  const r = row(page, LONGEST);
  const below = r.locator('+ li');
  const show = r.getByRole('button', { name: 'Show details' });
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  // The line has room for all three tags, so there is no "+N".
  await expect(r.locator('.item-tags .chip-tag')).toHaveText(LONGEST_TAGS);
  await expect(r.locator('.chip-more')).toHaveCount(0);
  const belowTop = (await below.boundingBox())!.y;

  await show.click();
  const hide = r.getByRole('button', { name: 'Hide details' });
  await expect(hide).toHaveAttribute('aria-expanded', 'true');
  const details = await detailsOf(page, LONGEST);
  await expect(details).toBeVisible();
  await expect(details.locator('.item-details-summary')).toHaveText(LONGEST_SUMMARY);
  // The chevron sits on the open row's own fill, and shades it on hover.
  await page.mouse.move(0, 0);
  await expect(hide).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await hide.hover();
  await expect(hide).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  // Each fact beside its label; created a month ago, updated three days ago: the day it was created adds something.
  const facts = details.locator('.item-details-facts');
  await expect(facts.locator('dt')).toHaveText(['Tags', 'Tests', 'Created']);
  await expect(facts.locator('dd').nth(0).locator('.chip-tag')).toHaveText(LONGEST_TAGS);
  await expect(facts.locator('dd').nth(1)).toHaveText('7 test cases');
  await expect(facts.locator('dd').nth(2)).toHaveText(/^\w{3} \d{1,2}, \d{4}$/);
  await expect(details.getByText(/Updated|verdict|Wrong answer/)).toHaveCount(0);
  await expect(details.locator('time')).toHaveAttribute('title', /\d:\d\d/);
  // Its collections are the sidebar's to show, not the row's.
  await expect(details.getByRole('link', { name: /Weekly practice|Arrays & hashing/ })).toHaveCount(0);
  // The rows below make room.
  await expect.poll(async () => (await below.boundingBox())!.y).toBeGreaterThan(belowTop + 40);

  await hide.click();
  await expect(details).toHaveCount(0);
  await expect(r.getByRole('button', { name: 'Show details' })).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => (await below.boundingBox())!.y).toBe(belowTop);
});

test('library details: the day an item was created always shows, and a problem\'s test cases, but not a reading\'s', async ({ page }) => {
  await open(page, '/');
  // Created and updated four days ago.
  const same = row(page, 'Merge k Sorted Lists');
  await same.getByRole('button', { name: 'Show details' }).click();
  const details = await detailsOf(page, 'Merge k Sorted Lists');
  await expect(details.locator('.chip-tag')).toHaveText(['heap', 'linked-list']);
  await expect(details.locator('dt')).toHaveText(['Tags', 'Tests', 'Created']);
  await expect(details.locator('dd').nth(1)).toHaveText('7 test cases');
  await expect(details.locator('dd time')).toHaveText(/^\w{3} \d{1,2}, \d{4}$/);
  await expect(details.getByText(/Updated/)).toHaveCount(0);
  // The line has no test count of its own.
  await expect(same.locator('.item-tests')).toHaveCount(0);

  // None, for a problem without any.
  const untested = row(page, 'Sliding-window rate limiter');
  await untested.getByRole('button', { name: 'Show details' }).click();
  const none = await detailsOf(page, 'Sliding-window rate limiter');
  await expect(none.locator('dt').nth(1)).toHaveText('Tests');
  await expect(none.locator('dd').nth(1)).toHaveText('None');

  // A reading has no tests.
  const reading = row(page, 'How B-Trees Work');
  await reading.getByRole('button', { name: 'Show details' }).click();
  const readingDetails = await detailsOf(page, 'How B-Trees Work');
  await expect(readingDetails.locator('dt')).toHaveText(['Tags', 'Created']);

  // The line's date gives both times exactly.
  await expect(same.locator('.item-updated')).toHaveText('4 days ago');
  await expect(same.locator('.item-updated')).toHaveAttribute('title', /^Created .*\d:\d\d.*\nUpdated .*\d:\d\d/);
});

for (const width of [1440, 600]) {
  test(`library details: nothing on the line moves as a row opens and closes (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page, '/');
    await expect(page.locator('html')).not.toHaveClass(/is-booting/);
    for (const title of [LONGEST, 'Two Sum', 'How B-Trees Work']) {
      const r = row(page, title);
      await page.mouse.move(0, 0);
      const before = await lineOf(r);
      expect(before['.item-title']).not.toBeNull();

      await r.getByRole('button', { name: 'Show details' }).click();
      // While the details grow, and once they are open.
      expect(await lineOf(r)).toEqual(before);
      await expect(await detailsOf(page, title)).toBeVisible();
      await expect(r.locator('.item-tags')).toHaveCount(0);
      await page.waitForTimeout(400);
      expect(await lineOf(r)).toEqual(before);

      await r.getByRole('button', { name: 'Hide details' }).click();
      expect(await lineOf(r)).toEqual(before);
      await expect(await detailsOf(page, title)).toHaveCount(0);
      await expect(r.locator('.item-tags')).toBeVisible();
      expect(await lineOf(r)).toEqual(before);
    }
  });
}

test('library details: an open row shows each tag once, and closing puts them back on the line', async ({ page }) => {
  await open(page, '/');
  const r = row(page, LONGEST);
  await r.getByRole('button', { name: 'Show details' }).click();
  const details = await detailsOf(page, LONGEST);
  await expect(details).toBeVisible();
  await expect(r.getByText(LONGEST_SUMMARY, { exact: true })).toHaveCount(1);
  for (const tag of LONGEST_TAGS) await expect(r.locator('.chip-tag', { hasText: new RegExp(`^${tag}$`) })).toHaveCount(1);
  await expect(r.locator('.item-tags')).toHaveCount(0);

  await r.getByRole('button', { name: 'Hide details' }).click();
  await expect(details).toHaveCount(0);
  await expect(r.locator('.item-tags .chip-tag')).toHaveText(LONGEST_TAGS);
  // The summary is only in the details: the line is the title and its tags.
  await expect(r.getByText(LONGEST_SUMMARY, { exact: true })).toHaveCount(0);
});

test('library tags: the line shows as many tags as fit, then "+N", at any width', async ({ page }) => {
  await openWithTags(page, COIN, MANY_TAGS);
  const r = row(page, COIN);
  const seen = new Set<number>();
  for (const width of [1440, 1200, 1000, 600]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(r.locator('.chip-more')).toBeVisible();
    const fit = await lineTags(r);
    seen.add(fit.shown);
    expect(fit.inside).toBe(true);
    expect(fit.more).toBe(`+${MANY_TAGS.length - fit.shown}`);
    await expect(r.locator('.item-tags .chip-tag')).toHaveText(MANY_TAGS.slice(0, fit.shown));
    // The next tag would not have fitted: what is left is narrower than it.
    const next = MANY_TAGS[fit.shown]!;
    await r.getByRole('button', { name: 'Show details' }).click();
    const nextWidth = (await (await detailsOf(page, COIN)).locator('.chip-tag', { hasText: new RegExp(`^${next}$`) }).boundingBox())!.width;
    expect(fit.free).toBeLessThan(nextWidth + fit.gap);
    await r.getByRole('button', { name: 'Hide details' }).click();
    await expect(await detailsOf(page, COIN)).toHaveCount(0);
  }
  // Fewer fit as the row narrows.
  expect(seen.size).toBeGreaterThan(2);
});

test('library details: the "+N" chip opens them too', async ({ page }) => {
  await openWithTags(page, COIN, MANY_TAGS);
  const r = row(page, COIN);
  const more = r.locator('.chip-more');
  const shown = await r.locator('.item-tags .chip-tag').count();
  const rest = MANY_TAGS.length - shown;
  await expect(more).toHaveAccessibleName(`${rest} more tags`);
  await expect(more).toHaveAttribute('title', MANY_TAGS.slice(shown).join(', '));
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  // It controls the same details as the chevron.
  const controls = await r.locator('.item-expand button').getAttribute('aria-controls');
  await expect(more).toHaveAttribute('aria-controls', controls!);
  const details = await detailsOf(page, COIN);

  await more.click();
  await expect(details.locator('.chip-tag')).toHaveText(MANY_TAGS);
  // It leaves the line with the other chips.
  await expect(more).toHaveCount(0);
  await expect(r.getByRole('button', { name: 'Hide details' })).toBeVisible();
  // Not a selection, and no navigation.
  await expect(r.getByRole('checkbox')).not.toBeChecked();
  await expect(page).toHaveURL(/\/$/);

  await r.getByRole('button', { name: 'Hide details' }).click();
  await expect(details).toHaveCount(0);
  await expect(more).toHaveText(`+${rest}`);
});

test('library details: opening from a focused "+N" moves focus to the expand button, which keeps it on closing', async ({ page }) => {
  await openWithTags(page, COIN, MANY_TAGS);
  await expect(page.locator('html')).not.toHaveClass(/is-booting/);
  const r = row(page, COIN);
  const details = await detailsOf(page, COIN);
  await r.focus();
  const more = r.locator('.chip-more');
  await more.focus();

  await page.keyboard.press('Enter');
  await expect(details).toBeVisible();
  await expect(more).toHaveCount(0);
  const hide = r.getByRole('button', { name: 'Hide details' });
  await expect(hide).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(details).toHaveCount(0);
  await expect(r.getByRole('button', { name: 'Show details' })).toBeFocused();
  await expect(more).toBeVisible();

  // D from one of the line's tags lands there too.
  await r.locator('.item-tags .chip-tag').first().focus();
  await page.keyboard.press('d');
  await expect(details).toBeVisible();
  await expect(hide).toBeFocused();
  // The list's keys still work from there.
  await page.keyboard.press('d');
  await expect(details).toHaveCount(0);
  await page.keyboard.press('j');
  await expect(r.locator('+ li')).toBeFocused();
});

test('library details: → opens, ← closes and D toggles the focused row', async ({ page }) => {
  await open(page, '/');
  await expect(page.locator('html')).not.toHaveClass(/is-booting/);
  const r = row(page, LONGEST);
  const details = await detailsOf(page, LONGEST);
  await r.focus();

  await page.keyboard.press('ArrowRight');
  await expect(details).toBeVisible();
  await expect(r).toBeFocused();
  // Again leaves it open.
  await page.keyboard.press('ArrowRight');
  await expect(details).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(details).toHaveCount(0);

  await page.keyboard.press('d');
  await expect(details).toBeVisible();
  // Its links are reached by Tab, as the row's other controls are.
  await details.locator('.chip-tag').first().focus();
  await page.keyboard.press('d');
  await expect(details).toHaveCount(0);
  // Focus that was inside goes back to the row.
  await expect(r).toBeFocused();

  // The list's other keys still work.
  await page.keyboard.press('x');
  await expect(r.getByRole('checkbox')).toBeChecked();
  await page.keyboard.press('j');
  await expect(r.locator('+ li')).toBeFocused();
});

test('library details: a click on the facts closes the row and selects nothing, a tag filters, and the summary opens the item', async ({ page }) => {
  await open(page, '/');
  const r = row(page, LONGEST);
  await r.getByRole('button', { name: 'Show details' }).click();
  const details = await detailsOf(page, LONGEST);
  await details.getByText('Created', { exact: true }).click();
  await expect(details).toHaveCount(0);
  await expect(r.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByRole('toolbar', { name: 'Actions for selected items' })).toHaveCount(0);
  await expect(page).toHaveURL(/\/\?mock=fast$/);

  await r.getByRole('button', { name: 'Show details' }).click();
  // The summary is not a tab stop of its own: the title is the row's link to the item.
  await expect(details.locator('.item-details-summary')).toHaveAttribute('tabindex', '-1');

  await details.locator('.chip-tag', { hasText: 'string' }).click();
  await expect(page).toHaveURL(/[?&]tag=string/);
  await expect(details).toBeVisible();
  await expect(r.getByRole('checkbox')).not.toBeChecked();

  await details.locator('.item-details-summary').click();
  await expect(page).toHaveURL(/\/items\//);
});

test('library details: they stay under the title, clear of the facts\' columns, and long tags wrap there', async ({ page }) => {
  await openWithTags(page, COIN, MANY_TAGS);
  for (const width of [1440, 1000]) {
    await page.setViewportSize({ width, height: 900 });
    const r = row(page, COIN);
    await r.getByRole('button', { name: 'Show details' }).click();
    const details = await detailsOf(page, COIN);
    await expect(details).toBeVisible();
    await page.waitForTimeout(400);
    const box = await r.evaluate((li) => {
      const right = (sel: string) => Math.max(...[...li.querySelectorAll(sel)].map((el) => el.getBoundingClientRect().right));
      const tops = [...li.querySelectorAll('.item-details .chip-tag')].map((el) => el.getBoundingClientRect().top);
      return {
        kind: li.querySelector('.item-kind')!.getBoundingClientRect().left,
        title: li.querySelector('.item-title')!.getBoundingClientRect().left,
        summary: li.querySelector('.item-details-summary')!.getBoundingClientRect().left,
        details: li.querySelector('.item-details')!.getBoundingClientRect(),
        content: right('.item-details *'),
        lines: new Set(tops.map(Math.round)).size,
      };
    });
    expect(Math.abs(box.summary - box.title)).toBeLessThan(1);
    expect(box.details.right).toBeLessThanOrEqual(box.kind);
    // Nothing in them reaches the difficulty column, with a gap before it.
    expect(box.content).toBeLessThan(box.kind - 4);
    expect(box.lines).toBeGreaterThan(1);
    await r.getByRole('button', { name: 'Hide details' }).click();
    await expect(details).toHaveCount(0);
  }
});

test('library details: each label is level with the first line of its value, or above it under a narrow title column', async ({ page }) => {
  await openWithTags(page, COIN, MANY_TAGS);
  const r = row(page, COIN);
  await r.getByRole('button', { name: 'Show details' }).click();
  const details = await detailsOf(page, COIN);
  await expect(details.locator('dt')).toHaveText(['Tags', 'Tests', 'Created']);
  const pairs = () =>
    details.locator('.item-details-facts').evaluate((dl) =>
      [...dl.querySelectorAll('dt')].map((dt) => {
        const dd = dt.nextElementSibling!;
        const first = (dd.querySelector('.chip, time') ?? dd).getBoundingClientRect();
        const label = dt.getBoundingClientRect();
        return { label: label.top + label.height / 2, labelBottom: label.bottom, value: first.top + first.height / 2, valueTop: dd.getBoundingClientRect().top, valueHeight: dd.getBoundingClientRect().height };
      }),
    );
  await page.setViewportSize({ width: 1440, height: 900 });
  const beside = await pairs();
  // The tags take several lines; the label stays on the first.
  expect(beside[0]!.valueHeight).toBeGreaterThan(40);
  for (const p of beside) expect(Math.abs(p.label - p.value)).toBeLessThan(3);

  await page.setViewportSize({ width: 1000, height: 900 });
  await expect.poll(async () => (await pairs()).every((p) => p.labelBottom <= p.valueTop + 0.5)).toBe(true);
  // A tag still shows whole there.
  expect(await details.locator('.chip-tag .truncate').evaluateAll((els) => els.every((el) => el.scrollWidth <= el.clientWidth))).toBe(true);
});

test('library details: a failed last verdict shows on the line, in a column of its own, and not in the details', async ({ page }) => {
  await open(page, '/');
  const r = row(page, LONGEST);
  await expect(r.locator('.item-verdict .badge')).toHaveText('Wrong answer');
  // An accepted one does not: the status icon says it is solved, and its tooltip gives the verdict.
  const solved = row(page, 'Two Sum');
  await expect(solved.locator('.item-verdict')).toHaveText('');
  await expect(solved.locator('.item-status button')).toHaveAttribute('title', 'Done · Last verdict: Accepted');
  // The verdicts line up from row to row.
  const lefts = await page.locator('.item-verdict').evaluateAll((els) => new Set(els.map((el) => Math.round(el.getBoundingClientRect().left))).size);
  expect(lefts).toBe(1);

  await r.getByRole('button', { name: 'Show details' }).click();
  const details = await detailsOf(page, LONGEST);
  await expect(details).toBeVisible();
  await expect(details.getByText('Wrong answer')).toHaveCount(0);
  await expect(r.locator('.item-verdict .badge')).toHaveText('Wrong answer');
});

test('library row: a click on its empty space opens and closes it, but not one on its title or a tag', async ({ page }) => {
  await open(page, '/');
  await expect(page.locator('html')).not.toHaveClass(/is-booting/);
  const r = row(page, LONGEST);
  const details = await detailsOf(page, LONGEST);
  // The room between the title and its tags, and the empty test column of another row.
  const title = (await r.locator('.item-title').boundingBox())!;
  const chips = (await r.locator('.item-tags .chip').first().boundingBox())!;
  const between = { x: (title.x + title.width + chips.x) / 2, y: title.y + title.height / 2 };
  await expect(r).toHaveCSS('cursor', 'pointer');

  await page.mouse.click(between.x, between.y);
  await expect(details).toBeVisible();
  await expect(r.getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true');
  await expect(r.getByRole('checkbox')).not.toBeChecked();
  // A click in the open details' empty space closes it.
  const facts = (await details.locator('.item-details-facts').boundingBox())!;
  await page.mouse.click(facts.x + facts.width - 4, facts.y + facts.height - 4);
  await expect(details).toHaveCount(0);

  // On the date, too; not with Shift held, nor at the end of a drag.
  await r.locator('.item-updated').click();
  await expect(details).toBeVisible();
  await r.locator('.item-updated').click({ modifiers: ['Shift'] });
  await expect(details).toBeVisible();
  const summary = (await details.locator('.item-details-summary').boundingBox())!;
  await page.mouse.move(summary.x + summary.width - 2, summary.y + 4);
  await page.mouse.down();
  await page.mouse.move(summary.x + summary.width + 40, summary.y + summary.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(details).toBeVisible();
  await r.getByRole('button', { name: 'Hide details' }).click();
  await expect(details).toHaveCount(0);

  // The star and the chevron keep their own clicks: the chevron toggles once.
  await r.getByRole('button', { name: 'Show details' }).click();
  await expect(details).toBeVisible();
  await r.locator('.item-star button').click();
  await expect(details).toBeVisible();
  await r.locator('.item-star button').click();
  await r.getByRole('button', { name: 'Hide details' }).click();
  await expect(details).toHaveCount(0);

  // A tag on the line filters, and leaves the row closed.
  await r.locator('.item-tags .chip-tag', { hasText: 'string' }).click();
  await expect(page).toHaveURL(/[?&]tag=string/);
  await expect(r).toBeVisible();
  await expect(details).toHaveCount(0);

  // The title opens the item.
  await r.locator('.item-title').click();
  await expect(page).toHaveURL(/\/items\//);
});

test('library head: the columns are named over them, the title\'s too, but not on a narrow screen', async ({ page }) => {
  await open(page, '/');
  const head = page.locator('.item-list-head');
  const names = head.locator('.item-sort, .item-col-head');
  await expect(names).toHaveText(['Title', 'Difficulty', 'Verdict', 'Updated']);
  const columns = ['.item-title', '.item-kind', '.item-verdict', '.item-updated'];
  for (const width of [1440, 1000]) {
    await page.setViewportSize({ width, height: 900 });
    // Where each column's name starts, and on every row, where each fact's content starts and ends, and where the next column starts.
    const layout = await page.evaluate((columns) => {
      const content = (cell: Element) => {
        const range = document.createRange();
        range.selectNodeContents(cell);
        return range.getBoundingClientRect();
      };
      const names = ['.is-title', '.is-kind', '.is-verdict', '.is-updated'].map((sel) => content(document.querySelector(`.item-list-head ${sel}`)!).left);
      const rows = [...document.querySelectorAll('.item-list .item-row')].map((li) =>
        columns.map((sel) => {
          const cell = li.querySelector(sel)!;
          const box = content(cell);
          // A cut title's text runs on under its ellipsis: only where it starts counts. The next
          // column starts where its content is seen: for the star, the star, not its button.
          const after = cell.nextElementSibling!;
          const next = sel === '.item-title' ? Infinity : (after.querySelector('svg') ?? after).getBoundingClientRect().left;
          return { filled: box.width > 0, left: box.left, right: box.right, next };
        }),
      );
      return { names, rows };
    }, columns);
    for (const row of layout.rows) {
      for (const [i, fact] of row.entries()) {
        if (!fact.filled) continue;
        // Every fact starts where its column's name does, and leaves a gap before the next column.
        expect(Math.abs(fact.left - layout.names[i]!)).toBeLessThan(1);
        expect(fact.right).toBeLessThan(fact.next - 6);
      }
    }
    // Each column is filled on some row.
    for (const i of columns.keys()) expect(layout.rows.some((r) => r[i]!.filled)).toBe(true);
  }

  await page.setViewportSize({ width: 600, height: 900 });
  await expect(names.first()).toBeHidden();
  await expect(head.getByRole('button', { name: /^Sort:/ })).toBeVisible();
});

test('library head: a list of readings has no verdict column, and its title column takes the room', async ({ page }) => {
  await open(page, '/');
  const head = page.locator('.item-list-head');
  const names = head.locator('.item-sort, .item-col-head');
  await expect(names).toHaveText(['Title', 'Difficulty', 'Verdict', 'Updated']);
  const mainWidth = async () => (await page.locator('.item-row .item-main').first().boundingBox())!.width;
  const mixed = await mainWidth();

  await page.getByRole('complementary', { name: 'Navigation' }).getByRole('link', { name: /^Readings/ }).click();
  await expect(page).toHaveURL(/type=reading/);
  await expect(names).toHaveText(['Title', 'Difficulty', 'Updated']);
  const rows = page.locator('.item-list .item-row');
  await expect(rows.first().getByLabel('Reading', { exact: true })).toBeVisible();
  // No verdict cell takes any room.
  expect(await page.locator('.item-list .item-verdict').evaluateAll((els) => els.every((el) => el.getBoundingClientRect().width === 0))).toBe(true);
  expect(await mainWidth()).toBeGreaterThan(mixed + 100);
  // The names still sit over their columns.
  const layout = await page.evaluate(() => {
    const left = (el: Element) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().left;
    };
    const [kind, updated] = ['.is-kind', '.is-updated'].map((sel) => left(document.querySelector(`.item-list-head ${sel}`)!));
    return [...document.querySelectorAll('.item-list .item-row')].map((li) => ({
      kind: li.querySelector('.item-kind .badge') ? left(li.querySelector('.item-kind')!) - kind! : 0,
      updated: left(li.querySelector('.item-updated')!) - updated!,
    }));
  });
  for (const row of layout) {
    expect(Math.abs(row.kind)).toBeLessThan(1);
    expect(Math.abs(row.updated)).toBeLessThan(1);
  }

  // On a narrow screen nothing holds a place for one either: the date follows the difficulty, or starts the line.
  await page.setViewportSize({ width: 600, height: 900 });
  const raft = row(page, 'Raft: Leader Election Cheat Sheet');
  const badge = (await raft.locator('.item-kind .badge').boundingBox())!;
  const date = await raft.locator('.item-updated').evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().left;
  });
  expect(date - (badge.x + badge.width)).toBeLessThan(20);
});

test('library details: on a narrow screen the tags and facts take a second line, and the details start under the title', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await open(page, '/');
  const r = row(page, LONGEST);
  const title = (await r.getByRole('link', { name: LONGEST, exact: true }).boundingBox())!;
  // The title has the first line to itself, in full.
  await expect(r.locator('.item-title')).not.toHaveAttribute('title', /./);
  expect(await r.locator('.item-title').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  for (const part of ['.item-kind .badge', '.item-verdict .badge', '.item-updated', '.item-tags']) {
    const box = (await r.locator(part).boundingBox())!;
    expect(box.y).toBeGreaterThan(title.y + title.height);
  }
  // After the verdict, as many tags as fit.
  const shown = await r.locator('.item-tags .chip-tag').count();
  expect(shown).toBeGreaterThan(0);
  await expect(r.locator('.item-tags .chip-tag')).toHaveText(LONGEST_TAGS.slice(0, shown));
  // The second line starts under the title.
  expect(Math.abs((await r.locator('.item-kind .badge').boundingBox())!.x - title.x)).toBeLessThan(2);

  await r.getByRole('button', { name: 'Show details' }).click();
  const details = await detailsOf(page, LONGEST);
  await expect(details.locator('.chip-tag')).toHaveText(LONGEST_TAGS);
  expect(Math.abs((await details.locator('.item-details-summary').boundingBox())!.x - title.x)).toBeLessThan(2);
});

test('library details: in a collection in manual order, the chevron comes before the grip and moving a row keeps it open', async ({ page }) => {
  await open(page, '/collections/22222222-2222-4222-8222-000000000001');
  const list = page.locator('ul.item-list.is-reorderable');
  await expect(list).toBeVisible();
  const first = list.locator('li.item-row').first();
  const title = (await first.locator('.item-title').textContent())!;
  const chevron = (await first.locator('.item-expand').boundingBox())!;
  const grip = (await first.locator('.item-grip').boundingBox())!;
  expect(chevron.x).toBeLessThan(grip.x);

  await first.getByRole('button', { name: 'Show details' }).click();
  await first.focus();
  await page.keyboard.press('Alt+ArrowDown');
  const moved = list.locator('li.item-row').nth(1);
  await expect(moved.locator('.item-title')).toHaveText(title);
  await expect(moved.getByRole('button', { name: 'Hide details' })).toBeVisible();
});

test('library details: under reduced motion they close at once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, '/');
  const r = row(page, LONGEST);
  await r.getByRole('button', { name: 'Show details' }).click();
  const details = await detailsOf(page, LONGEST);
  await expect(details).toBeVisible();
  await r.getByRole('button', { name: 'Hide details' }).click();
  expect(await details.count()).toBe(0);
});
