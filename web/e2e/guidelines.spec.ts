import { expect, test } from '@playwright/test';
import { open } from './support';

// Keyboard, focus and screen-reader behaviour the UI is held to. Like the
// smoke suite, these run against the API mock.

test('focus: the solve editor shows a ring when it has focus', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Longest Substring Without Repeating Characters' }).click();
  const host = page.locator('.editor-host');
  await host.locator('.cm-content').click();
  await expect(host).toHaveCSS('outline-style', 'solid');
});

test('confirm: a destructive dialog opens on Cancel, so Enter does not delete', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Longest Substring Without Repeating Characters' }).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();

  const dialog = page.getByRole('dialog', { name: /^Delete/ });
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Longest Substring Without Repeating Characters' })).toBeVisible();
});

test('live regions: the elapsed-time counter of a generation is not announced', async ({ page }) => {
  // Normal mock delays, so the panel stays up long enough to look at.
  await page.goto('/new');
  await page.getByLabel('What you have').fill('two sum — array of ints and a target, return the two indices that add up to it.');
  await page.getByRole('button', { name: 'Draft with AI' }).click();

  const status = page.getByRole('status').filter({ hasText: 'Drafting…' });
  await expect(status).toHaveText('Drafting…');
  await expect(page.locator('.generating-time')).toHaveText(/^\d+\u00a0s$/);
});

test('unsaved work: leaving an edited test case or an unsaved proposal asks first', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  const sections = page.getByRole('navigation', { name: 'Problem sections' });
  await sections.getByRole('link', { name: /^Test cases/ }).click();

  // An edited case: staying keeps the edit, leaving discards it.
  const name = page.getByLabel('Name', { exact: true });
  await name.fill('Renamed and not saved');
  await sections.getByRole('link', { name: 'Solve' }).click();
  const guard = page.getByRole('dialog', { name: 'Leave without saving?' });
  await expect(guard.getByRole('button', { name: 'Stay' })).toBeFocused();
  await guard.getByRole('button', { name: 'Stay' }).click();
  await expect(page).toHaveURL(/\/tests$/);
  await expect(name).toHaveValue('Renamed and not saved');

  // Saved work is not guarded.
  await page.getByRole('button', { name: 'Save case' }).click();
  await expect(page.getByText('Test case saved')).toBeVisible();

  // A proposal: "Discard" and every other way out go through the same question.
  await page.getByRole('link', { name: /Generate/ }).first().click();
  await page.getByLabel('How many').fill('2');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByText('2 of 2 selected')).toBeVisible();
  await page.getByRole('link', { name: 'Discard' }).click();
  const discard = page.getByRole('dialog', { name: 'Discard the proposed test cases?' });
  await discard.getByRole('button', { name: 'Stay' }).click();
  await expect(page.getByText('2 of 2 selected')).toBeVisible();
  await page.getByRole('link', { name: 'Discard' }).click();
  await discard.getByRole('button', { name: 'Discard' }).click();
  await expect(page).toHaveURL(/\/tests$/);
});

test('notes: text typed just before the tab goes away is still saved', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('tab', { name: /^Notes/ }).click();
  await page.getByLabel('Private notes (Markdown)').pressSequentially(' x');
  const state = page.locator('.notes-state');
  await expect(state).toHaveText('Unsaved');
  // Well inside the autosave delay, and without leaving the field.
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(state).not.toHaveText('Unsaved', { timeout: 300 });
  await expect(state).toHaveText('Saved');
});

test('reduced motion: looping animations stop', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Normal mock delays, so the generating panel stays up long enough to look at.
  await page.goto('/new');
  await page.getByLabel('What you have').fill('two sum — array of ints and a target, return the two indices that add up to it.');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.locator('.generating-pulse')).toHaveCSS('animation-iteration-count', '1');
});

test('deep links: the open tabs of the solve page are part of the address', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('tab', { name: /^Notes/ }).click();
  await expect(page).toHaveURL(/[?&]tab=notes/);
  await page.getByRole('button', { name: 'Show tests and results' }).click();
  await page.getByRole('tab', { name: 'Custom input' }).click();
  await expect(page).toHaveURL(/[?&]tab=notes&panel=custom|[?&]panel=custom&tab=notes/);
  // Back to a default leaves it out of the address again.
  await page.getByRole('tab', { name: 'Description' }).click();
  await expect(page).not.toHaveURL(/tab=/);

  // Arriving with the parameters opens the same view.
  const url = new URL(page.url());
  url.searchParams.set('tab', 'submissions');
  await page.goto(url.toString());
  await expect(page.getByRole('tab', { name: 'Submissions' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Custom input' })).toHaveAttribute('aria-selected', 'true');
});

test('deep links: the review step of a capture is in the history, so Back returns to the input', async ({ page }) => {
  await open(page, '/new');
  await page.getByLabel('What you have').fill('two sum — array of ints and a target, return the two indices that add up to it.');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByRole('heading', { name: 'Review the draft' })).toBeVisible();
  await expect(page).toHaveURL(/[?&]step=review/);

  await page.goBack();
  await expect(page.getByLabel('What you have')).toBeVisible();
  await expect(page).not.toHaveURL(/step=/);
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Review the draft' })).toBeVisible();
});

test('deep links: an export of selected items survives in the address', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Export this item…' }).click();
  await expect(page).toHaveURL(/\/export\?.*item=/);
  await expect(page.getByRole('radio', { name: /Selected items/ })).toBeChecked();
  await expect(page.locator('.export-items')).toContainText('Two Sum');

  await page.getByRole('checkbox', { name: 'Saved solutions' }).uncheck();
  await expect(page).toHaveURL(/[?&]solutions=0/);
  await page.getByRole('radio', { name: /The whole library/ }).check();
  await expect(page).toHaveURL(/[?&]scope=all/);
});
