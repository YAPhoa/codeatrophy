import { expect, test, type Page } from '@playwright/test';
import { mockApi, open } from './support';

// The prompt cards on the Writing styles page, the system prompt and the
// test case prompt: each editable text is read-only until an "are you sure"
// confirm, a custom text is marked, and a reset or leaving with unsaved
// changes asks first.

interface Kind {
  card: string;
  section: string;
  path: string;
  confirm: string;
  confirmBody: string;
  builtIn: string;
  fixed: string;
  saved: string;
}

const SYSTEM: Kind = {
  card: 'System prompt',
  section: 'Authoring conventions',
  path: '/settings/ai/system-prompt',
  confirm: 'Edit the system prompt?',
  confirmBody: 'Editing the system prompt changes every draft.',
  builtIn: '# Codeatrophy authoring conventions',
  fixed: '**stdin/stdout**',
  saved: 'System prompt saved',
};

const TESTS: Kind = {
  card: 'Test case prompt',
  section: 'Test guidance',
  path: '/settings/ai/testcase-prompt',
  confirm: 'Edit the test case prompt?',
  confirmBody: 'Editing this prompt changes every generated test set. A bad edit can make tests worse.',
  builtIn: '- For a program problem, write a correct, efficient reference solution',
  fixed: 'predictedStdout',
  saved: 'Test case prompt saved',
};

const card = (page: Page, k: Kind) => page.getByRole('group', { name: k.card });

/** What the mock server holds, read past the page's cache. */
const stored = (page: Page, k: Kind) => mockApi<{ custom: string | null; isCustom: boolean }>(page, k.path);

async function startEditing(page: Page, k: Kind) {
  await card(page, k).getByRole('button', { name: 'Edit' }).click();
  const confirm = page.getByRole('dialog', { name: k.confirm });
  await expect(confirm).toContainText(k.confirmBody);
  await confirm.getByRole('button', { name: 'Edit' }).click();
  await expect(confirm).toBeHidden();
  return card(page, k).getByRole('textbox', { name: k.section });
}

for (const k of [SYSTEM, TESTS]) {
  test(`${k.card}: editing is behind a confirm, and cancelling it leaves the prompt read-only`, async ({ page }) => {
    await open(page, '/settings/styles');
    const prompt = card(page, k);
    await expect(prompt.getByRole('heading', { name: k.section })).toBeVisible();
    await expect(prompt.getByLabel(k.section, { exact: true })).toContainText(k.builtIn);
    await expect(prompt.getByRole('heading', { name: 'Fixed rules' })).toBeVisible();
    await expect(prompt.getByText('Read only. Required for the app to function', { exact: true })).toBeVisible();
    await expect(prompt.getByLabel('Fixed rules')).toContainText(k.fixed);
    await expect(prompt.getByText('Custom', { exact: true })).toHaveCount(0);

    await prompt.getByRole('button', { name: 'Edit' }).click();
    const confirm = page.getByRole('dialog', { name: k.confirm });
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    await expect(prompt.getByRole('textbox')).toHaveCount(0);
    await expect(prompt.getByRole('button', { name: 'Edit' })).toBeVisible();
  });

  test(`${k.card}: a saved text is marked Custom and used from then on`, async ({ page }) => {
    await open(page, '/settings/styles');
    const editor = await startEditing(page, k);
    await expect(editor).toBeFocused();
    expect(await editor.inputValue()).toMatch(new RegExp(`^${k.builtIn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    await editor.fill('# House rules\n\nKeep it tight.');
    await card(page, k).getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText(k.saved)).toBeVisible();
    await expect(card(page, k).getByText('Custom', { exact: true })).toBeVisible();
    await expect(card(page, k).getByRole('textbox')).toHaveCount(0);
    await expect(card(page, k).getByLabel(k.section, { exact: true })).toHaveText('# House rules\n\nKeep it tight.');
    // The fixed rules stay as they were.
    await expect(card(page, k).getByLabel('Fixed rules')).toContainText('# Fixed rules');
    expect(await stored(page, k)).toMatchObject({ isCustom: true, custom: '# House rules\n\nKeep it tight.' });
    // The other prompt is a setting of its own.
    expect(await stored(page, k === SYSTEM ? TESTS : SYSTEM)).toMatchObject({ isCustom: false });
    await expect(card(page, k === SYSTEM ? TESTS : SYSTEM).getByText('Custom', { exact: true })).toHaveCount(0);
  });

  test(`${k.card}: reset asks, then brings back the built-in text`, async ({ page }) => {
    await open(page, '/settings/styles');
    const editor = await startEditing(page, k);
    await editor.fill('Mine.');
    await card(page, k).getByRole('button', { name: 'Save' }).click();
    await expect(card(page, k).getByText('Custom', { exact: true })).toBeVisible();

    // Declining the confirm keeps the custom text.
    await card(page, k).getByRole('button', { name: 'Reset to built-in' }).click();
    const confirm = page.getByRole('dialog', { name: 'Reset to the built-in prompt?' });
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(card(page, k).getByLabel(k.section, { exact: true })).toHaveText('Mine.');

    await card(page, k).getByRole('button', { name: 'Reset to built-in' }).click();
    await confirm.getByRole('button', { name: 'Reset' }).click();
    await expect(card(page, k).getByText('Custom', { exact: true })).toHaveCount(0);
    await expect(card(page, k).getByLabel(k.section, { exact: true })).toContainText(k.builtIn);
    await expect(card(page, k).getByRole('button', { name: 'Reset to built-in' })).toHaveCount(0);
    expect(await stored(page, k)).toMatchObject({ isCustom: false, custom: null });
  });
}

test('system prompt: the Edit button sits in the Authoring conventions heading row', async ({ page }) => {
  await open(page, '/settings/styles');
  for (const k of [SYSTEM, TESTS]) {
    const heading = await card(page, k).getByRole('heading', { name: k.section }).boundingBox();
    const edit = await card(page, k).getByRole('button', { name: 'Edit' }).boundingBox();
    const text = await card(page, k).getByLabel(k.section, { exact: true }).boundingBox();
    expect(heading && edit && text).toBeTruthy();
    // On the heading's line, to its right, and above the text it edits.
    expect(Math.abs(edit!.y + edit!.height / 2 - (heading!.y + heading!.height / 2))).toBeLessThan(4);
    expect(edit!.x).toBeGreaterThan(heading!.x + heading!.width);
    expect(edit!.y + edit!.height).toBeLessThanOrEqual(text!.y);
  }
});

test('prompts: leaving with unsaved changes asks first, naming the cards changed', async ({ page }) => {
  await open(page, '/settings/styles');
  const editor = await startEditing(page, TESTS);
  await editor.fill('Unsaved tests.');

  const nav = page.getByRole('navigation', { name: 'Settings' });
  await nav.getByRole('link', { name: 'Preferences' }).click();
  const leave = page.getByRole('dialog', { name: 'Leave without saving?' });
  await expect(leave).toContainText('Your changes to the test case prompt have not been saved.');
  await leave.getByRole('button', { name: 'Stay' }).click();
  await expect(editor).toHaveValue('Unsaved tests.');

  // With both cards changed, the guard names both.
  const other = await startEditing(page, SYSTEM);
  await other.fill('Unsaved conventions.');
  await nav.getByRole('link', { name: 'Preferences' }).click();
  await expect(leave).toContainText('Your changes to the system prompt and the test case prompt have not been saved.');
  await leave.getByRole('button', { name: 'Stay' }).click();

  // With the test case prompt's edit given up, only the system prompt is named.
  await card(page, TESTS).getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('dialog', { name: 'Discard your changes?' }).getByRole('button', { name: 'Discard' }).click();
  await nav.getByRole('link', { name: 'Preferences' }).click();
  await expect(leave).toContainText('Your changes to the system prompt have not been saved.');
  await leave.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(page).toHaveURL(/\/settings\/preferences$/);
  expect(await stored(page, SYSTEM)).toMatchObject({ isCustom: false });
  expect(await stored(page, TESTS)).toMatchObject({ isCustom: false });
});
