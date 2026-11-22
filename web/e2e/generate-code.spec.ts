import { expect, test, type Page } from '@playwright/test';
import { mockApi, open, SEED } from './support';

// "Generate code" on the edit page of a problem: the AI writes the code of
// the languages the tabs list, from the form as it stands, into the form.
// Nothing is saved until "Save changes". The seed's "Coin Change" is a full
// program with the generic starter code in five languages; "Merge k Sorted
// Lists" is "solution only", with stubs and runners of its own.

const COIN_CHANGE = SEED.coinChange;
const MERGE_K_LISTS = '11111111-1111-4111-8111-000000000025';

const codeSection = (page: Page) => page.getByRole('region', { name: 'What you write' });
const starter = (page: Page) => codeSection(page).locator('.starter-frame .cm-content');

/** The problem as the mock server holds it, read past the page's cache. */
const stored = (page: Page, id: string) =>
  mockApi<{
    title: string;
    problem: { interface: string; starterCode: Record<string, string>; harness: Record<string, { prefix: string; suffix: string }> };
  }>(page, `/items/${id}`);

test('generate code: a full program\'s starters read its input, and Cancel discards them', async ({ page }) => {
  await open(page, `/items/${COIN_CHANGE}/edit`);
  const section = codeSection(page);
  await expect(section.getByRole('tab')).toHaveCount(5);
  await expect(starter(page)).toContainText('data = sys.stdin.read().split()');

  // The starters are the generic ones, so nothing is asked before they go.
  await section.getByRole('button', { name: 'Generate code' }).click();
  await expect(section.getByRole('status').filter({ hasText: 'Wrote starter code for 5 languages.' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(starter(page)).toContainText('n, amount = map(int, input().split())');
  await section.getByRole('tab', { name: 'Go' }).click();
  await expect(starter(page)).toContainText('amount, _ := strconv.Atoi(fields[1])');
  // A full program has no runner to check.
  await expect(section.getByRole('tab', { name: /runner/ })).toHaveCount(0);

  // Nothing was saved: Cancel leaves the code as it was.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('dialog', { name: 'Leave without saving?' }).getByRole('button', { name: 'Discard changes' }).click();
  await expect(page).toHaveURL(new RegExp(`/items/${COIN_CHANGE}$`));
  expect((await stored(page, COIN_CHANGE)).problem.starterCode.python).toContain('data = sys.stdin.read().split()');
});

test('generate code: "solution only" gets stubs and runners, checked, and saved with an unsaved edit', async ({ page }) => {
  await open(page, `/items/${COIN_CHANGE}/edit`);
  const section = codeSection(page);
  await page.getByLabel('Title').fill('Coin Change (solution only)');
  await page.getByRole('radiogroup', { name: 'What you write' }).getByText('Solution only').click();
  await expect(section.getByRole('tab')).toHaveCount(5);

  // The model is the default unless another is chosen for this page.
  await section.getByRole('button', { name: 'Model: Personal key · claude-opus-5-5 (default)' }).click();
  await page.getByRole('menuitemradio', { name: 'Work gateway · llama3.1:70b' }).click();
  await section.getByRole('button', { name: 'Generate code' }).click();
  await expect(section.getByRole('status').filter({ hasText: 'Wrote stubs and runners for 5 languages. All 5 runners ran.' })).toBeVisible();
  await expect(section.locator('.usage-line')).toContainText('llama3.1:70b');
  // Each tab says its runner ran, as after a check of a draft.
  for (const name of ['Python', 'C++', 'Java', 'JavaScript', 'Go']) {
    await expect(section.getByRole('tab', { name: new RegExp(`^${name.replace('+', '\\+')}\\s*runner ran$`) })).toBeVisible();
  }
  await expect(starter(page)).toContainText('def coinChange(self');
  await expect(section.getByRole('button', { name: /^Runner/ })).toContainText('ran ·');

  // Editing a stub takes its mark away, and only its.
  await starter(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('pass');
  await expect(section.getByRole('tab', { name: /^Python/ })).not.toContainText('runner ran');
  await expect(section.getByRole('tab', { name: /^Go\s*runner ran$/ })).toBeVisible();

  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(new RegExp(`/items/${COIN_CHANGE}$`));
  const saved = await stored(page, COIN_CHANGE);
  expect(saved.title).toBe('Coin Change (solution only)');
  expect(saved.problem.interface).toBe('function');
  expect(Object.keys(saved.problem.harness).sort()).toEqual(['cpp', 'go', 'java', 'javascript', 'python']);
  expect(saved.problem.harness.python!.prefix).toContain('from __future__ import annotations');
});

test('generate code: code of the problem\'s own is replaced only after a confirm, and a language is needed', async ({ page }) => {
  await open(page, `/items/${MERGE_K_LISTS}/edit`);
  const section = codeSection(page);
  const generate = section.getByRole('button', { name: 'Generate code' });
  await expect(starter(page)).toContainText('def mergeKLists(self');

  // Asked once; Cancel keeps everything.
  await generate.click();
  const ask = page.getByRole('dialog', { name: 'Replace the code?' });
  await expect(ask).toContainText('Your code for Python and Java is replaced.');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toBeHidden();
  await expect(section.getByText(/^Wrote/)).toHaveCount(0);
  await expect(starter(page)).toContainText('def mergeKLists(self');

  await generate.click();
  await ask.getByRole('button', { name: 'Replace' }).click();
  await expect(section.getByRole('status').filter({ hasText: 'Wrote stubs and runners for 2 languages.' })).toBeVisible();
  await expect(starter(page)).toContainText('def mergeKSortedLists(self');

  // Without a language there is nothing to write.
  await section.getByRole('button', { name: 'Remove Python' }).click();
  await section.getByRole('button', { name: 'Remove Java' }).click();
  await expect(section.getByText('No languages yet.')).toBeVisible();
  await expect(generate).toBeDisabled();
  await expect(generate).toHaveAttribute('title', 'Add a language first');
});

test('generate code: not offered while AI is off', async ({ page }) => {
  await open(page, `/items/${COIN_CHANGE}/edit`, 'no-ai,fast');
  await expect(codeSection(page).getByRole('button', { name: 'Add language' })).toBeVisible();
  await expect(codeSection(page).getByRole('button', { name: 'Generate code' })).toHaveCount(0);
});
