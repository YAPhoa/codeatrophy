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
  await page.getByRole('button', { name: 'Generate test cases', exact: true }).click();
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

test('deep links: the selected test case is in the address', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('navigation', { name: 'Problem sections' }).getByRole('link', { name: /^Test cases/ }).click();
  const name = page.getByLabel('Name', { exact: true });
  await expect(name).not.toHaveValue('');
  await expect(page).not.toHaveURL(/case=/);

  const second = page.getByRole('list', { name: 'Test cases' }).locator('.case-row-main').nth(1);
  await second.click();
  await expect(page).toHaveURL(/[?&]case=/);
  const selectedName = await name.inputValue();

  // Arriving by the link opens the same case. Another problem first, so the page starts afresh without a reload.
  const link = new URL(page.url());
  await page.getByRole('link', { name: 'Back to the library' }).click();
  await page.getByRole('link', { name: 'Coin Change' }).click();
  await page.evaluate((to) => {
    window.history.pushState(null, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, link.pathname + link.search);
  await expect(name).toHaveValue(selectedName);
});

test('forms: every text input, text area and select has a name', async ({ page }) => {
  const unnamed = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLInputElement>('input:not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select')]
        .filter((el) => !el.name)
        .map((el) => el.outerHTML.slice(0, 120)),
    );
  await open(page, '/');
  await expect(page.getByRole('link', { name: 'Two Sum', exact: true })).toBeVisible();
  expect(await unnamed()).toEqual([]);

  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Title')).toBeVisible();
  expect(await unnamed()).toEqual([]);
  await expect(page.getByLabel('Title')).toHaveAttribute('name', 'title');
  await expect(page.getByLabel('Title')).toHaveAttribute('autocomplete', 'off');
});

test('forms: a save that cannot go through says why and moves to the field', async ({ page }) => {
  // A new collection without a name.
  await open(page, '/');
  await page.getByRole('button', { name: 'New collection' }).click();
  const dialog = page.getByRole('dialog', { name: 'New collection' });
  const create = dialog.getByRole('button', { name: 'Create collection' });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(dialog.getByRole('alert')).toHaveText('Give the collection a name.');
  await expect(dialog.getByLabel('Name')).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // An item whose title was emptied.
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Title').fill('');
  await page.getByLabel('Source note').focus();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByLabel('Title')).toBeFocused();
  await expect(page.getByLabel('Title')).toHaveAttribute('aria-invalid', 'true');
});

test('forms: drafting from nothing asks for some text', async ({ page }) => {
  await open(page, '/new');
  const draft = page.getByRole('button', { name: 'Draft with AI' });
  await expect(draft).toBeEnabled();
  await page.getByRole('button', { name: 'Write it by hand' }).focus();
  await draft.click();
  await expect(page.getByRole('alert')).toHaveText('Type or paste something to draft from.');
  await expect(page.getByLabel('What you have')).toBeFocused();
});

test('dialogs: Escape asks before dropping what was typed, and Cancel does not', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('button', { name: 'New collection' }).click();
  const dialog = page.getByRole('dialog', { name: 'New collection' });

  // Nothing entered yet: Escape just closes.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'New collection' }).click();
  await dialog.getByLabel('Name').fill('Graphs');
  await page.keyboard.press('Escape');
  const ask = page.getByRole('dialog', { name: 'Discard what you entered?' });
  await expect(ask.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(ask).toBeHidden();
  await expect(dialog.getByLabel('Name')).toHaveValue('Graphs');
  await expect(dialog.getByLabel('Name')).toBeFocused();

  // A click on the backdrop asks as well.
  await page.mouse.click(5, 5);
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(dialog).toBeHidden();

  // Cancel is the user's own answer already.
  await page.getByRole('button', { name: 'New collection' }).click();
  await dialog.getByLabel('Name').fill('Graphs');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(ask).toBeHidden();
});

test('toasts: the container is a live region before a toast arrives', async ({ page }) => {
  await open(page, '/');
  await expect(page.getByRole('region', { name: 'Notifications' })).toHaveAttribute('aria-live', 'polite');
});

test('drawer: on a narrow screen it takes focus, keeps it, and closes on Escape', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await open(page, '/');
  const opener = page.getByRole('button', { name: 'Open navigation' });
  await opener.click();
  await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused();
  await expect(page.locator('main')).toHaveAttribute('inert', '');
  await page.keyboard.press('Escape');
  await expect(page.locator('.sidebar')).not.toHaveClass(/is-open/);
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(opener).toBeFocused();
});

test('links: menu items and palette results that go somewhere are links', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  const edit = page.getByRole('menuitem', { name: 'Edit details…' });
  await expect(edit).toHaveAttribute('href', /\/items\/[^/]+\/edit$/);
  await page.keyboard.press('Escape');

  await page.keyboard.press('ControlOrMeta+k');
  const option = page.getByRole('option', { name: 'Manage tags' });
  await expect(option.locator('a')).toHaveAttribute('href', '/tags');
  await option.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tags' })).toBeVisible();
});

test('headings: a page that only has a message to show still has an h1', async ({ page }) => {
  await open(page, '/no/such/page');
  await expect(page.getByRole('heading', { level: 1, name: 'There is nothing at this address' })).toBeVisible();
});

test('undo: a test case removed from a draft can be put back where it was', async ({ page }) => {
  await open(page, '/new');
  await page.getByLabel('What you have').fill('two sum — array of ints and a target, return the two indices that add up to it. O(n)?');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Test cases' })).toBeVisible();

  const inputs = page.locator('section[aria-labelledby="cases-heading"]').getByLabel('Input (stdin)');
  await expect(inputs).toHaveCount(2);
  const first = await inputs.first().inputValue();
  await page.getByRole('button', { name: 'Remove case 1' }).click();
  await expect(inputs).toHaveCount(1);
  await page.getByRole('region', { name: 'Notifications' }).getByRole('button', { name: 'Undo' }).click();
  await expect(inputs).toHaveCount(2);
  await expect(inputs.first()).toHaveValue(first);
});
