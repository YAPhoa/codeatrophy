import { expect, test, type Page } from '@playwright/test';
import { choose, mockApi, open, SEED, writeCode } from './support';

// A past submission opens in the Submissions tab, in place of the list; the
// drawer's Result tab keeps to this visit's latest run.

const TWO_SUM = SEED.twoSum;
/** The seed's accepted Python submission of Two Sum: there after a reload too, which resets the mock. */
const TWO_SUM_ACCEPTED = '44444444-4444-4444-8444-000000000002';

const editor = (page: Page) => page.locator('.editor-host .cm-content');
const languageSelect = (page: Page) => page.getByRole('combobox', { name: 'Language' });
const history = (page: Page) => page.getByRole('tabpanel', { name: 'Submissions' });
const details = (page: Page) => page.locator('article.submission');

/** Submit `source` to Two Sum through the mock's API and wait until it is judged; its id. */
async function submitted(page: Page, source: string, language = 'python'): Promise<string> {
  const { id } = await mockApi<{ id: string }>(page, `/items/${TWO_SUM}/submissions`, { method: 'POST', body: { language, source, mode: 'submit', stdin: null } });
  await expect.poll(async () => (await mockApi<{ status: string }>(page, `/submissions/${id}`)).status).toBe('completed');
  return id;
}

/** The working copies the mock server holds for Two Sum, newest first. */
const copies = async (page: Page) =>
  (await mockApi<{ items: { language: string; source: string }[] }>(page, `/items/${TWO_SUM}/workspace`)).items.map((w) => [w.language, w.source]);

/** From the library, open Two Sum on its Submissions tab and the newest submission there. */
async function openNewest(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await openNewestHere(page);
}

/** On Two Sum's page, open the newest submission in the Submissions tab. */
async function openNewestHere(page: Page): Promise<void> {
  await page.getByRole('tab', { name: /^Submissions/ }).click();
  await history(page).locator('.history-row').first().click();
  await expect(details(page)).toBeVisible();
}

test('submissions: a past one opens in place of the list, at an address of its own, and Back returns to the list', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();

  // A run of this visit is in the drawer.
  await choose(languageSelect(page), /^Python/);
  await writeCode(page, 'print("this visit")  # MOCK:WA');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const result = page.locator('.drawer .result-head');
  await expect(result).toContainText('Wrong answer');

  await page.getByRole('tab', { name: /^Submissions/ }).click();
  await history(page).getByRole('button', { name: /^Accepted Python/ }).click();
  await expect(details(page).getByRole('heading', { name: 'Accepted', level: 2 })).toBeVisible();
  await expect(details(page).locator('.submission-facts')).toContainText('Python');
  await expect(details(page).locator('.submission-facts')).toContainText(/\d+\/\d+ passed/);
  await expect(page).toHaveURL(new RegExp(`[?&]submission=${TWO_SUM_ACCEPTED}`));
  await expect(page).toHaveURL(/[?&]tab=submissions/);
  // The editor stays beside it, and the drawer still shows this visit's run.
  await expect(editor(page)).toHaveText('print("this visit")  # MOCK:WA');
  await expect(result).toContainText('Wrong answer');
  await expect(result).not.toContainText('Accepted');

  // A reload keeps it open.
  await page.reload();
  await expect(details(page).getByRole('heading', { name: 'Accepted', level: 2 })).toBeVisible();

  // Back goes to the list; so does the link at the top.
  await page.goBack();
  await expect(history(page).locator('.history-row').first()).toBeVisible();
  await expect(page).not.toHaveURL(/submission=/);
  await history(page).locator('.history-row').first().click();
  await expect(page).toHaveURL(/submission=/);
  await details(page).getByRole('button', { name: 'All submissions' }).click();
  await expect(history(page).locator('.history-row').first()).toBeFocused();
  await expect(page).not.toHaveURL(/submission=/);
});

test('submissions: one opened before the page has caught up with the tab keeps the tab in the address', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  // Its list loaded once, the tab has its rows as soon as it opens.
  await page.getByRole('tab', { name: /^Submissions/ }).click();
  const row = `history-row-${TWO_SUM_ACCEPTED}`;
  await expect(history(page).locator(`[id="${row}"]`)).toBeVisible();
  await page.getByRole('tab', { name: 'Description', exact: true }).click();
  await expect(page).not.toHaveURL(/[?&]tab=/);

  // The router shows a new address in a transition, which a busy machine can
  // still be rendering when the next click comes. Clicked as soon as the
  // address has the tab, and before any task runs, the row is opened while
  // the page still renders the address it had.
  const search = await page.evaluate(async (row) => {
    [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.startsWith('Submissions'))!.click();
    for (let i = 0; i < 1000 && !location.search.includes('tab=submissions'); i++) await Promise.resolve();
    const search = location.search;
    document.getElementById(row)!.click();
    return search;
  }, row);
  expect(search).toContain('tab=submissions');
  await expect(details(page).getByRole('heading', { name: 'Accepted', level: 2 })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`[?&]submission=${TWO_SUM_ACCEPTED}`));
  await expect(page).toHaveURL(/[?&]tab=submissions/);
});

test('submissions: a link to one opens the Submissions tab on it, and one that does not exist says so', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page, '/');
  const id = await submitted(page, 'print("linked")');
  await openNewest(page);
  await details(page).getByRole('button', { name: 'Copy link' }).click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(new URL(link).pathname).toBe(`/items/${TWO_SUM}`);
  expect(new URL(link).searchParams.get('submission')).toBe(id);

  await page.goto(`/items/${TWO_SUM}?submission=${TWO_SUM_ACCEPTED}`);
  await expect(page.getByRole('tab', { name: /^Submissions/ })).toHaveAttribute('aria-selected', 'true');
  await expect(details(page).getByRole('heading', { name: 'Accepted', level: 2 })).toBeVisible();

  await page.goto(`/items/${TWO_SUM}?tab=submissions&submission=00000000-0000-4000-8000-000000000000`);
  await expect(page.getByRole('heading', { name: 'This submission does not exist' })).toBeVisible();
  await page.getByRole('button', { name: 'All submissions' }).click();
  await expect(history(page).locator('.history-row').first()).toBeVisible();
});

test('submissions: Open in editor puts the code in, in its language, without asking when there is nothing to lose', async ({ page }) => {
  await open(page, '/');
  await submitted(page, '// past C++ code', 'cpp');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await choose(languageSelect(page), /^Python/);
  await openNewestHere(page);

  await details(page).getByRole('button', { name: 'Open in editor' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(languageSelect(page)).toContainText('C++');
  await expect(editor(page)).toHaveText('// past C++ code');
  await expect(editor(page)).toBeFocused();
  // Saved as an edit is.
  await expect.poll(() => copies(page)).toEqual([['cpp', '// past C++ code']]);
});

test('submissions: Open in editor asks before replacing work, and not for the same code', async ({ page }) => {
  await open(page, '/');
  await submitted(page, 'print("from the submission")');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await choose(languageSelect(page), /^Python/);
  await writeCode(page, 'print("my work")');
  await expect.poll(() => copies(page)).toEqual([['python', 'print("my work")']]);
  await page.getByRole('tab', { name: /^Submissions/ }).click();
  await history(page).locator('.history-row').first().click();
  const openIt = details(page).getByRole('button', { name: 'Open in editor' });

  await openIt.click();
  const dialog = page.getByRole('dialog', { name: 'Replace your Python code?' });
  await expect(dialog).toContainText('You have work in Python on this problem.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor(page)).toHaveText('print("my work")');

  await openIt.click();
  await dialog.getByRole('button', { name: 'Replace' }).click();
  await expect(editor(page)).toHaveText('print("from the submission")');
  await expect(editor(page)).toBeFocused();
  await expect.poll(() => copies(page)).toEqual([['python', 'print("from the submission")']]);

  // The editor holds that very code now: nothing to ask.
  await openIt.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(editor(page)).toHaveText('print("from the submission")');
});

test('submissions: long code is shown in part, with Show more', async ({ page }) => {
  await open(page, '/');
  const lines = Array.from({ length: 40 }, (_, i) => `print(${i + 1})`).join('\n');
  await submitted(page, lines);
  await openNewest(page);
  const code = details(page).locator('.submission-code');
  const toggle = code.getByRole('button', { name: 'Show more' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const before = (await code.locator('.cm-scroller').boundingBox())!.height;
  await toggle.click();
  await expect(code.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(async () => (await code.locator('.cm-scroller').boundingBox())!.height).toBeGreaterThan(before * 2);
});

test('submissions: in a narrow window the details stay on the problem pane, and Open in editor goes to the code', async ({ page }) => {
  await page.setViewportSize({ width: 860, height: 800 });
  await open(page, '/');
  await submitted(page, 'print("narrow")');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('tab', { name: /^Submissions/ }).click();
  await history(page).locator('.history-row').first().click();
  await expect(details(page)).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Problem', exact: true })).toHaveAttribute('aria-selected', 'true');
  await details(page).getByRole('button', { name: 'Open in editor' }).click();
  await expect(page.getByRole('tab', { name: 'Code', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(editor(page)).toHaveText('print("narrow")');
});
