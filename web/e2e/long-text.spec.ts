import { expect, test, type Page } from '@playwright/test';
import { open, SEED, writeCode } from './support';

// Values at the longest the limits allow, with nothing to break a line at (a
// pasted URL, a slug): every screen that shows one keeps it inside its box,
// by wrapping it, or by cutting it with an ellipsis and a tooltip.

const TWO_SUM = SEED.twoSum;
const TWO_SUM_SORTED = SEED.twoSumSorted;
const CAP = SEED.capTheorem;
const GONE = '11111111-1111-4111-8111-000000000099';
const INTERVIEW = '22222222-2222-4222-8222-000000000001';
const ARRAYS = '22222222-2222-4222-8222-000000000002';

/** `prefix` run on to `length` characters with no break opportunity. */
const unbroken = (prefix: string, length = 200) => (prefix + 'abcdefghij'.repeat(Math.ceil(length / 10))).slice(0, length);

const LONG = {
  twoSum: unbroken('twosumlong'),
  sorted: unbroken('sortedlong'),
  cap: unbroken('caplong'),
  gone: unbroken('gonelong'),
  interview: unbroken('interviewlong'),
  arrays: unbroken('arrayslong'),
  description: unbroken('descriptionlong', 300),
  tag: unbroken('a-long-tag-', 40),
  sampleCase: unbroken('samplecaselong'),
  hiddenCase: unbroken('hiddencaselong'),
  model: unbroken('modellong'),
  summary: unbroken('summarylong'),
};

/**
 * Put the long values into the mock's seed before the app first reads it
 * (and again on every load): the mock is caught as it is installed.
 */
async function seedLongValues(page: Page) {
  await page.addInitScript(({ long, ids }) => {
    type Item = { id: string; title: string; body: string; tags: string[]; updatedAt: string };
    type Mock = {
      db: {
        items: Map<string, Item>;
        tags: Set<string>;
        collections: { id: string; name: string; description: string }[];
        testCases: { itemId: string; name: string; isSample: boolean }[];
        links: { a: string; b: string; createdAt: string; seq: number }[];
        deleted: Map<string, { title: string; type: string }>;
        ai: { providers: { model: string | null }[] };
        nextSeq: () => number;
      };
    };
    let mock: Mock | undefined;
    Object.defineProperty(window, '__codeatrophyMock', {
      configurable: true,
      get: () => mock,
      set: (m: Mock) => {
        mock = m;
        const { db } = m;
        const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        const retitle = (id: string, title: string) => {
          const item = db.items.get(id)!;
          item.title = title;
          item.tags = [long.tag, ...item.tags].sort();
          // The most recent, so they are among the palette's recent items.
          item.updatedAt = now;
        };
        retitle(ids.twoSum, long.twoSum);
        retitle(ids.sorted, long.sorted);
        retitle(ids.cap, long.cap);
        // A collapsible block at the end of the reading.
        db.items.get(ids.cap)!.body += `\n\n<details>\n<summary>${long.summary}</summary>\n\nInside.\n\n</details>\n`;
        db.tags.add(long.tag);
        for (const c of db.collections) {
          if (c.id === ids.interview) {
            c.name = long.interview;
            c.description = long.description;
          }
          if (c.id === ids.arrays) c.name = long.arrays;
        }
        const cases = db.testCases.filter((c) => c.itemId === ids.twoSum);
        cases.find((c) => c.isSample)!.name = long.sampleCase;
        cases.find((c) => !c.isSample)!.name = long.hiddenCase;
        // The reading links Two Sum, and an item since deleted.
        db.deleted.set(ids.gone, { title: long.gone, type: 'reading' });
        db.links.push(
          { a: ids.cap, b: ids.twoSum, createdAt: now, seq: db.nextSeq() },
          { a: ids.cap, b: ids.gone, createdAt: now, seq: db.nextSeq() },
        );
        db.ai.providers[0].model = long.model;
      },
    });
  }, { long: LONG, ids: { twoSum: TWO_SUM, sorted: TWO_SUM_SORTED, cap: CAP, gone: GONE, interview: INTERVIEW, arrays: ARRAYS } });
}

/** What every long value has in it, and no seeded text does. */
const MARK = 'abcdefghijabcdefghij';

/**
 * Every element holding a long value whose content is wider than its box
 * though it neither scrolls nor clips: something spills out of it. Code
 * editors scroll their own content and are left out.
 */
async function overflowing(page: Page): Promise<string[]> {
  return page.evaluate((mark) => {
    const found: string[] = [];
    for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
      if (!(el instanceof HTMLElement) || el.closest('.cm-editor') || !el.textContent?.includes(mark)) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.display === 'inline' || style.display === 'contents') continue;
      if (style.overflowX !== 'visible') continue;
      if (el.getClientRects().length === 0) continue;
      if (el.scrollWidth > el.clientWidth + 1) {
        const name = `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`;
        found.push(`${name} (${el.scrollWidth} > ${el.clientWidth}): ${(el.textContent ?? '').trim().slice(0, 40)}`);
      }
    }
    return found;
  }, MARK);
}

async function expectNoOverflow(page: Page, where: string) {
  expect(await overflowing(page), `content wider than its box on ${where}`).toEqual([]);
}

/** Load `path` afresh, seeded again, with the hidden test cases shown. */
async function visit(page: Page, path: string) {
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}mock=fast,show-tests`);
}

test.use({ viewport: { width: 1280, height: 860 } });

test.beforeEach(async ({ page }) => {
  await seedLongValues(page);
});

test('long text: the library, a collection, its breadcrumb and subcollections, and the palette', async ({ page }) => {
  await open(page, '/', 'fast,show-tests');
  await expect(page.getByRole('link', { name: LONG.twoSum, exact: true })).toBeVisible();
  await expectNoOverflow(page, 'the library');

  await visit(page, `/collections/${INTERVIEW}`);
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(`^${LONG.interview}`) })).toBeVisible();
  const chip = page.locator('.subcollection').filter({ hasText: LONG.arrays });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute('title', LONG.arrays);
  await expectNoOverflow(page, 'a collection with a subcollection');

  await visit(page, `/collections/${ARRAYS}`);
  const crumb = page.getByRole('navigation', { name: 'Collection path' }).getByRole('link', { name: LONG.interview });
  await expect(crumb).toBeVisible();
  await expect(crumb).toHaveAttribute('title', LONG.interview);
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(`^${LONG.arrays}`) })).toBeVisible();
  await expectNoOverflow(page, 'a subcollection under its breadcrumb');

  await page.getByRole('button', { name: /^Search…/ }).click();
  const palette = page.getByRole('dialog', { name: 'Search and commands' });
  const recent = palette.getByRole('option', { name: new RegExp(LONG.twoSum) });
  await expect(recent).toBeVisible();
  await expectNoOverflow(page, 'the palette, recent items');
  // The tags beside a result keep to one line.
  const hint = recent.locator('.palette-hint');
  await expect(hint).toContainText(LONG.tag.slice(0, 10));
  expect(await hint.evaluate((el) => el.getBoundingClientRect().height < 2 * parseFloat(getComputedStyle(el).lineHeight))).toBe(true);
  await palette.getByRole('combobox').fill('long');
  await expect(palette.getByRole('option', { name: new RegExp(LONG.interview) })).toBeVisible();
  await expectNoOverflow(page, 'the palette, results');
});

test('long text: a reading, its bar and its related items', async ({ page }) => {
  await open(page, `/items/${CAP}`, 'fast,show-tests');
  await expect(page.getByRole('heading', { level: 1, name: LONG.cap })).toBeVisible();
  const related = page.getByRole('region', { name: 'Related items' });
  const linked = related.getByRole('list', { name: 'Linked items' });
  await expect(linked.getByRole('link', { name: LONG.twoSum })).toBeVisible();
  await expect(linked.getByText(LONG.gone)).toBeVisible();
  await expect(page.locator('.md-details-summary')).toHaveText(LONG.summary);
  await expectNoOverflow(page, 'the reader');

  // A title cut short can still be read in full, in the reader's bar and in the list.
  const bar = page.locator('.reader-bar-title');
  await bar.hover();
  await expect(bar).toHaveAttribute('title', LONG.cap);
  const twoSum = linked.getByRole('link', { name: LONG.twoSum });
  await twoSum.hover();
  await expect(twoSum).toHaveAttribute('title', LONG.twoSum);
  await expect(linked.locator('.link-dead')).toHaveAttribute('title', `${LONG.gone} (no longer in your library)`);

  // The search's matches.
  await related.getByRole('combobox', { name: 'Link an item' }).fill('sortedlong');
  await expect(page.getByRole('listbox', { name: 'Items to link' }).getByRole('option', { name: LONG.sorted })).toBeVisible();
  await expectNoOverflow(page, 'the related items search');
});

test('long text: a problem to solve, its result, edit, variant, tests and solutions pages', async ({ page }) => {
  await open(page, `/items/${TWO_SUM}`, 'fast,show-tests');
  await expect(page.getByRole('heading', { level: 1, name: LONG.twoSum })).toBeVisible();
  await writeCode(page, 'print(1)\n');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /passed/ })).toContainText(/Ran \d+ sample cases?/);
  await page.getByText(LONG.sampleCase).first().click();
  await expectNoOverflow(page, 'the solve workspace with a result');

  await page.getByRole('tab', { name: /Variants/ }).click();
  await expect(page.getByRole('link', { name: LONG.sorted })).toBeVisible();
  await expectNoOverflow(page, 'the variants tab');

  await visit(page, `/items/${TWO_SUM}/edit`);
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: LONG.twoSum })).toBeVisible();
  await expect(page.locator('.chip').filter({ hasText: LONG.tag }).first()).toBeVisible();
  await expectNoOverflow(page, 'the edit page');

  for (const [path, what] of [
    [`/items/${TWO_SUM}/variant`, 'the variant page'],
    [`/items/${TWO_SUM}/tests`, 'the tests page'],
    [`/items/${TWO_SUM}/tests/generate`, 'the generate tests page'],
    [`/items/${TWO_SUM}/solutions`, 'the solutions page'],
    [`/items/${TWO_SUM}/saved`, 'the saved page'],
    [`/items/${TWO_SUM_SORTED}`, 'a variant'],
  ] as const) {
    await visit(page, path);
    await expect(page.getByText(path.endsWith(TWO_SUM_SORTED) ? LONG.sorted : LONG.twoSum).first()).toBeVisible();
    if (path.endsWith('/tests')) await expect(page.getByText(LONG.hiddenCase).first()).toBeVisible();
    await expectNoOverflow(page, what);
  }
});

test('long text: the AI provider card, a confirm dialog and a toast', async ({ page }) => {
  await open(page, '/settings/ai', 'fast,show-tests');
  const model = page.getByRole('region', { name: 'AI providers' }).locator('code').filter({ hasText: LONG.model });
  await expect(model).toBeVisible();
  await expectNoOverflow(page, 'the AI providers');
  // On one line, cut short, and readable in full.
  await expect(model).toHaveAttribute('title', LONG.model);
  expect(await model.evaluate((el) => el.getClientRects().length)).toBe(1);

  await visit(page, `/items/${CAP}`);
  await expect(page.getByRole('heading', { level: 1, name: LONG.cap })).toBeVisible();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const dialog = page.getByRole('dialog', { name: /^Delete/ });
  await expect(dialog).toBeVisible();
  await expectNoOverflow(page, 'a confirm dialog');
  // The title stops at two lines, and gives the rest on hover.
  const heading = dialog.getByRole('heading');
  const lines = await heading.evaluate((el) => Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)));
  expect(lines).toBe(2);
  await heading.hover();
  await expect(heading).toHaveAttribute('title', new RegExp(LONG.cap));
  await dialog.getByRole('button', { name: 'Delete reading' }).click();
  const toast = page.locator('.toast-message').filter({ hasText: LONG.cap });
  await expect(toast).toBeVisible();
  await expectNoOverflow(page, 'a toast');
  // The pointer travels to the toast once it is in place, as a hand moves
  // it. Moved there in one jump, from where the page changed under it, it
  // can arrive from an element Chrome sent no mouseout for, and React then
  // fires no mouseenter.
  await toast.evaluate((el) => Promise.all(el.closest('.toast-slot')!.getAnimations({ subtree: true }).map((a) => a.finished)));
  const box = (await toast.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await expect(toast).toHaveAttribute('title', `Deleted “${LONG.cap}”`);
});
